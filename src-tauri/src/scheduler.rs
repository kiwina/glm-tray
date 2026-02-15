use std::collections::HashMap;
use std::sync::Arc;

use chrono::{Local, Timelike};
use log::{error, info, warn};
use tauri::AppHandle;
use tokio::sync::{watch, RwLock};
use tokio::task::JoinHandle;
use tokio::time::{self, Duration, Instant};

use crate::api_client::ApiClient;
use crate::models::{AppConfig, KeySlotConfig, RuntimeStatus, SlotRuntimeStatus, WakeMode};
use crate::tray;

const MAX_CONSECUTIVE_ERRORS: u32 = 10;
const MAX_BACKOFF_MINUTES: u64 = 480;

/// Shared schedule state between wake scheduler and quota poller
#[derive(Debug, Clone)]
struct SlotSchedule {
    next_reset_epoch_ms: Option<i64>,
    last_times_marker: Option<String>,
    last_reset_marker: Option<i64>,
    last_interval_fire: Instant,
}

impl Default for SlotSchedule {
    fn default() -> Self {
        Self {
            next_reset_epoch_ms: None,
            last_times_marker: None,
            last_reset_marker: None,
            last_interval_fire: Instant::now(),
        }
    }
}

/// Controls for a single slot's tasks (wake + poll)
struct SlotTaskControl {
    stop_tx: watch::Sender<bool>,
    config_tx: watch::Sender<KeySlotConfig>,
    wake_handle: JoinHandle<()>,
    poll_handle: JoinHandle<()>,
}

pub struct SchedulerManager {
    slot_tasks: HashMap<usize, SlotTaskControl>,
    running: bool,
}

impl SchedulerManager {
    pub fn new() -> Self {
        Self {
            slot_tasks: HashMap::new(),
            running: false,
        }
    }

    pub fn is_running(&self) -> bool {
        self.running
    }

    pub async fn start(
        &mut self,
        app: AppHandle,
        config: AppConfig,
        runtime_status: Arc<RwLock<RuntimeStatus>>,
    ) {
        self.stop().await;

        info!("scheduler starting");
        self.running = true;
        {
            let mut runtime = runtime_status.write().await;
            runtime.monitoring = true;
            for slot in &mut runtime.slots {
                slot.enabled = false;
                slot.last_error = None;
            }
        }

        for (idx, slot_cfg) in config.slots.into_iter().enumerate() {
            if !slot_cfg.enabled || slot_cfg.api_key.trim().is_empty() {
                continue;
            }

            // Create communication channels
            let (stop_tx, stop_rx) = watch::channel(false);
            let (config_tx, config_rx) = watch::channel(slot_cfg.clone());
            
            // Shared schedule state
            let schedule = Arc::new(RwLock::new(SlotSchedule::default()));
            let runtime_handle = runtime_status.clone();
            let app_handle = app.clone();

            // Spawn wake scheduler task (runs every minute)
            let wake_handle = tokio::spawn(Self::wake_scheduler_task(
                idx,
                app_handle.clone(),
                config_rx.clone(),
                schedule.clone(),
                runtime_handle.clone(),
                stop_rx.clone(),
            ));

            // Spawn quota poller task
            let poll_handle = tokio::spawn(Self::quota_poller_task(
                idx,
                app_handle,
                config_rx,
                schedule,
                runtime_handle,
                stop_rx,
            ));

            self.slot_tasks.insert(idx, SlotTaskControl {
                stop_tx,
                config_tx,
                wake_handle,
                poll_handle,
            });
        }

        let snapshot = runtime_status.read().await.clone();
        let _ = tray::refresh_tray(&app, snapshot);
    }

    pub async fn stop(&mut self) {
        if self.slot_tasks.is_empty() {
            self.running = false;
            return;
        }

        info!("scheduler stopping {} slot task(s)", self.slot_tasks.len());

        // Signal all tasks to stop
        for task in self.slot_tasks.values_mut() {
            let _ = task.stop_tx.send(true);
        }

        // Wait for all tasks to complete
        let tasks = std::mem::take(&mut self.slot_tasks);
        for (_, task) in tasks {
            let _ = task.wake_handle.await;
            let _ = task.poll_handle.await;
        }

        self.running = false;
        info!("scheduler stopped");
    }

    pub async fn reload_if_running(
        &mut self,
        _app: AppHandle,
        config: AppConfig,
        _runtime_status: Arc<RwLock<RuntimeStatus>>,
    ) {
        if !self.is_running() {
            return;
        }

        info!("scheduler reloading configuration");
        
        // Send new config to each running slot
        for (idx, slot_task) in self.slot_tasks.iter() {
            if let Some(slot_cfg) = config.slots.get(*idx) {
                // If config changed, broadcast update
                let _ = slot_task.config_tx.send(slot_cfg.clone());
                info!("slot {} config updated", idx + 1);
            }
        }
    }

    /// Wake scheduler task - runs every minute to check wake conditions
    async fn wake_scheduler_task(
        idx: usize,
        app: AppHandle,
        mut config_rx: watch::Receiver<KeySlotConfig>,
        schedule: Arc<RwLock<SlotSchedule>>,
        runtime_status: Arc<RwLock<RuntimeStatus>>,
        mut stop_rx: watch::Receiver<bool>,
    ) {
        info!("slot {} wake scheduler started", idx + 1);

        let client = match ApiClient::new(Some(app.clone())) {
            Ok(client) => client,
            Err(err) => {
                warn!("slot {} client setup failed: {}", idx + 1, err);
                update_error(&runtime_status, idx, &err).await;
                let _ = tray::refresh_tray(&app, runtime_status.read().await.clone());
                return;
            }
        };

        loop {
            if *stop_rx.borrow() {
                break;
            }

            // Get current config
            let cfg = config_rx.borrow().clone();

            // Get current schedule state
            let sched = schedule.read().await.clone();

            // Check if we should fire a wake request
            if let Some(should_fire) = should_fire_wake(&cfg, &sched) {
                info!("slot {} wake condition met: {}", idx + 1, should_fire);
                
                if let Err(err) = client.send_wake_request(&cfg).await {
                    warn!("slot {} scheduled wake failed: {}", idx + 1, err);
                    update_error(&runtime_status, idx, &err).await;
                } else {
                    info!("slot {} scheduled wake fired", idx + 1);
                    
                    // Update schedule markers after successful wake
                    let mut sched_mut = schedule.write().await;
                    let old_sched = sched_mut.clone();
                    update_schedule_markers(&cfg, &old_sched, &mut sched_mut);
                }
            }

            // Sleep for 60 seconds
            tokio::select! {
                _ = stop_rx.changed() => {
                    if *stop_rx.borrow() {
                        break;
                    }
                }
                _ = config_rx.changed() => {
                    info!("slot {} wake scheduler detected config change", idx + 1);
                }
                _ = time::sleep(Duration::from_secs(60)) => {}
            }
        }

        info!("slot {} wake scheduler stopped", idx + 1);
    }

    /// Quota poller task - fetches quota at configured intervals
    async fn quota_poller_task(
        idx: usize,
        app: AppHandle,
        mut config_rx: watch::Receiver<KeySlotConfig>,
        schedule: Arc<RwLock<SlotSchedule>>,
        runtime_status: Arc<RwLock<RuntimeStatus>>,
        mut stop_rx: watch::Receiver<bool>,
    ) {
        info!("slot {} quota poller started", idx + 1);

        let client = match ApiClient::new(Some(app.clone())) {
            Ok(client) => client,
            Err(err) => {
                warn!("slot {} client setup failed: {}", idx + 1, err);
                update_error(&runtime_status, idx, &err).await;
                let _ = tray::refresh_tray(&app, runtime_status.read().await.clone());
                return;
            }
        };

        // Send initial wake request
        let cfg = config_rx.borrow().clone();
        if let Err(err) = client.send_wake_request(&cfg).await {
            warn!("slot {} initial wake failed: {}", idx + 1, err);
            update_error(&runtime_status, idx, &err).await;
        }

        let mut consecutive_errors: u32 = 0;

        loop {
            if *stop_rx.borrow() {
                break;
            }

            let cfg = config_rx.borrow().clone();

            // Fetch quota
            match client.fetch_quota(&cfg).await {
                Ok(snapshot) => {
                    if consecutive_errors > 0 {
                        info!("slot {} recovered after {} consecutive error(s)", idx + 1, consecutive_errors);
                    }
                    consecutive_errors = 0;

                    // Update shared schedule state
                    {
                        let mut sched = schedule.write().await;
                        sched.next_reset_epoch_ms = snapshot.next_reset_epoch_ms;
                    }

                    // Update runtime status for UI
                    {
                        let mut runtime = runtime_status.write().await;
                        if let Some(current) = runtime.slots.get_mut(idx) {
                            current.slot = idx + 1;
                            current.name = cfg.name.clone();
                            current.enabled = true;
                            current.timer_active = snapshot.timer_active;
                            current.percentage = Some(snapshot.percentage);
                            current.next_reset_hms = snapshot.next_reset_hms;
                            current.last_error = None;
                            current.last_updated_epoch_ms = snapshot.next_reset_epoch_ms;
                            current.consecutive_errors = 0;
                            current.auto_disabled = false;
                        }
                    }
                    info!("slot {} quota refreshed (next_reset: {:?})", idx + 1, snapshot.next_reset_epoch_ms);
                }
                Err(err) => {
                    consecutive_errors += 1;
                    warn!(
                        "slot {} poll failed ({}/{} consecutive): {}",
                        idx + 1, consecutive_errors, MAX_CONSECUTIVE_ERRORS, err
                    );

                    {
                        let mut runtime = runtime_status.write().await;
                        if let Some(current) = runtime.slots.get_mut(idx) {
                            current.slot = idx + 1;
                            current.enabled = true;
                            current.last_error = Some(err.clone());
                            current.consecutive_errors = consecutive_errors;
                        }
                    }

                    if consecutive_errors >= MAX_CONSECUTIVE_ERRORS {
                        error!(
                            "slot {} auto-disabled after {} consecutive errors",
                            idx + 1, consecutive_errors
                        );
                        let mut runtime = runtime_status.write().await;
                        if let Some(current) = runtime.slots.get_mut(idx) {
                            current.auto_disabled = true;
                        }
                        let runtime_snapshot = runtime_status.read().await.clone();
                        drop(runtime);
                        let _ = tray::refresh_tray(&app, runtime_snapshot);
                        break;
                    }
                }
            }

            // Refresh tray
            let runtime_snapshot = runtime_status.read().await.clone();
            if let Err(err) = tray::refresh_tray(&app, runtime_snapshot) {
                error!("failed to refresh tray for slot {}: {}", idx + 1, err);
            }

            // Calculate sleep duration with backoff
            let sleep_minutes = if consecutive_errors == 0 {
                cfg.poll_interval_minutes.max(1)
            } else {
                let backoff = cfg.poll_interval_minutes.max(1)
                    .saturating_mul(1u64 << consecutive_errors.min(6));
                let capped = backoff.min(MAX_BACKOFF_MINUTES);
                info!("slot {} backing off: next poll in {} min", idx + 1, capped);
                capped
            };

            // Sleep for poll interval
            tokio::select! {
                _ = stop_rx.changed() => {
                    if *stop_rx.borrow() {
                        break;
                    }
                }
                _ = config_rx.changed() => {
                    info!("slot {} quota poller detected config change", idx + 1);
                }
                _ = time::sleep(Duration::from_secs(sleep_minutes * 60)) => {}
            }
        }

        info!("slot {} quota poller stopped", idx + 1);
    }
}

/// Check if wake should fire based on current config and schedule state.
/// Returns Some(reason) if should fire, None otherwise.
fn should_fire_wake(
    slot_cfg: &KeySlotConfig,
    schedule: &SlotSchedule,
) -> Option<String> {
    if !slot_cfg.wake_enabled {
        return None;
    }

    match slot_cfg.wake_mode {
        WakeMode::Interval => {
            let interval = Duration::from_secs(slot_cfg.wake_interval_minutes.max(1) * 60);
            if schedule.last_interval_fire.elapsed() >= interval {
                Some(format!(
                    "interval mode ({} min elapsed)",
                    slot_cfg.wake_interval_minutes
                ))
            } else {
                None
            }
        }
        WakeMode::Times => {
            let now = Local::now();
            let current_hm = format!("{:02}:{:02}", now.hour(), now.minute());
            
            if !slot_cfg.wake_times.iter().any(|value| value == &current_hm) {
                return None;
            }

            let marker = format!("{}-{}", now.format("%Y-%m-%d"), current_hm);
            if schedule.last_times_marker.as_ref() == Some(&marker) {
                return None;
            }

            Some(format!("times mode (matched {})", current_hm))
        }
        WakeMode::AfterReset => {
            let Some(next_reset) = schedule.next_reset_epoch_ms else {
                // No reset time available yet
                return None;
            };
            
            let target = next_reset + (slot_cfg.wake_after_reset_minutes.max(1) as i64 * 60_000);
            let now_ms = Local::now().timestamp_millis();

            if now_ms < target {
                return None;
            }

            if schedule.last_reset_marker == Some(next_reset) {
                return None;
            }

            Some(format!(
                "after-reset mode (reset + {} min)",
                slot_cfg.wake_after_reset_minutes
            ))
        }
    }
}

/// Update schedule markers after a successful wake
fn update_schedule_markers(
    slot_cfg: &KeySlotConfig,
    old_schedule: &SlotSchedule,
    new_schedule: &mut SlotSchedule,
) {
    match slot_cfg.wake_mode {
        WakeMode::Interval => {
            new_schedule.last_interval_fire = Instant::now();
        }
        WakeMode::Times => {
            let now = Local::now();
            let current_hm = format!("{:02}:{:02}", now.hour(), now.minute());
            new_schedule.last_times_marker = Some(format!("{}-{}", now.format("%Y-%m-%d"), current_hm));
        }
        WakeMode::AfterReset => {
            if let Some(next_reset) = old_schedule.next_reset_epoch_ms {
                new_schedule.last_reset_marker = Some(next_reset);
            }
        }
    }
}

async fn update_error(runtime_status: &Arc<RwLock<RuntimeStatus>>, idx: usize, message: &str) {
    let mut runtime = runtime_status.write().await;
    if let Some(current) = runtime.slots.get_mut(idx) {
        current.slot = idx + 1;
        current.enabled = true;
        current.last_error = Some(message.to_string());
    }
}

pub async fn reset_runtime(runtime_status: &Arc<RwLock<RuntimeStatus>>) {
    let mut runtime = runtime_status.write().await;
    runtime.monitoring = false;
    for idx in 0..runtime.slots.len() {
        runtime.slots[idx] = SlotRuntimeStatus {
            slot: idx + 1,
            name: String::new(),
            enabled: false,
            timer_active: false,
            percentage: None,
            next_reset_hms: None,
            last_error: None,
            last_updated_epoch_ms: None,
            consecutive_errors: 0,
            auto_disabled: false,
        };
    }
}
