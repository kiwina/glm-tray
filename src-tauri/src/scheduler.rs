use std::collections::HashMap;
use std::sync::Arc;

use chrono::{Local, Timelike};
use log::{error, info, warn};
use tauri::AppHandle;
use tokio::sync::{watch, RwLock};
use tokio::task::JoinHandle;
use tokio::time::{self, Duration, Instant};

use crate::api_client::ApiClient;
use crate::models::{AppConfig, RuntimeStatus, SlotRuntimeStatus, WakeMode};
use crate::tray;

const MAX_CONSECUTIVE_ERRORS: u32 = 10;
const MAX_BACKOFF_MINUTES: u64 = 480;

struct TaskControl {
    stop_tx: watch::Sender<bool>,
    handle: JoinHandle<()>,
}

pub struct SchedulerManager {
    tasks: HashMap<usize, TaskControl>,
    running: bool,
}

impl SchedulerManager {
    pub fn new() -> Self {
        Self {
            tasks: HashMap::new(),
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

            let (stop_tx, mut stop_rx) = watch::channel(false);
            let runtime_handle = runtime_status.clone();
            let app_handle = app.clone();

            let handle = tokio::spawn(async move {
                info!("slot {} task started (poll every {} min)", idx + 1, slot_cfg.poll_interval_minutes);
                let mut latest_next_reset_epoch_ms: Option<i64> = None;
                let mut last_times_marker: Option<String> = None;
                let mut last_reset_marker: Option<i64> = None;
                let mut last_interval_fire = Instant::now();
                let mut consecutive_errors: u32 = 0;

                let client = match ApiClient::new() {
                    Ok(client) => client,
                    Err(err) => {
                        warn!("slot {} client setup failed: {}", idx + 1, err);
                        update_error(&runtime_handle, idx, &err).await;
                        let _ = tray::refresh_tray(&app_handle, runtime_handle.read().await.clone());
                        return;
                    }
                };

                if let Err(err) = client.send_wake_request(&slot_cfg).await {
                    warn!("slot {} initial wake failed: {}", idx + 1, err);
                    update_error(&runtime_handle, idx, &err).await;
                }

                loop {
                    if *stop_rx.borrow() {
                        break;
                    }

                    match client.fetch_quota(&slot_cfg).await {
                        Ok(snapshot) => {
                            if consecutive_errors > 0 {
                                info!("slot {} recovered after {} consecutive error(s)", idx + 1, consecutive_errors);
                            }
                            consecutive_errors = 0;
                            {
                                let mut runtime = runtime_handle.write().await;
                                if let Some(current) = runtime.slots.get_mut(idx) {
                                    current.slot = idx + 1;
                                    current.name = slot_cfg.name.clone();
                                    current.enabled = true;
                                    current.timer_active = snapshot.timer_active;
                                    current.percentage = Some(snapshot.percentage);
                                    current.next_reset_hms = snapshot.next_reset_hms;
                                    current.last_error = None;
                                    current.last_updated_epoch_ms = snapshot.next_reset_epoch_ms;
                                    current.consecutive_errors = 0;
                                    current.auto_disabled = false;
                                    latest_next_reset_epoch_ms = snapshot.next_reset_epoch_ms;
                                }
                            }
                            info!("slot {} quota refreshed", idx + 1);
                        }
                        Err(err) => {
                            consecutive_errors += 1;
                            warn!(
                                "slot {} poll failed ({}/{} consecutive): {}",
                                idx + 1, consecutive_errors, MAX_CONSECUTIVE_ERRORS, err
                            );
                            {
                                let mut runtime = runtime_handle.write().await;
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
                                let mut runtime = runtime_handle.write().await;
                                if let Some(current) = runtime.slots.get_mut(idx) {
                                    current.auto_disabled = true;
                                }
                                let runtime_snapshot = runtime.clone();
                                drop(runtime);
                                let _ = tray::refresh_tray(&app_handle, runtime_snapshot);
                                break;
                            }
                        }
                    }

                    if should_fire_wake(
                        &slot_cfg,
                        latest_next_reset_epoch_ms,
                        &mut last_times_marker,
                        &mut last_reset_marker,
                        &mut last_interval_fire,
                    ) {
                        if let Err(err) = client.send_wake_request(&slot_cfg).await {
                            warn!("slot {} scheduled wake failed: {}", idx + 1, err);
                            update_error(&runtime_handle, idx, &err).await;
                        } else {
                            info!("slot {} scheduled wake fired", idx + 1);
                        }
                    }

                    let runtime_snapshot = runtime_handle.read().await.clone();
                    if let Err(err) = tray::refresh_tray(&app_handle, runtime_snapshot) {
                        error!("failed to refresh tray for slot {}: {}", idx + 1, err);
                    }

                    let sleep_minutes = if consecutive_errors == 0 {
                        slot_cfg.poll_interval_minutes.max(1)
                    } else {
                        let backoff = slot_cfg.poll_interval_minutes.max(1)
                            .saturating_mul(1u64 << consecutive_errors.min(6));
                        let capped = backoff.min(MAX_BACKOFF_MINUTES);
                        info!("slot {} backing off: next poll in {} min", idx + 1, capped);
                        capped
                    };

                    tokio::select! {
                        _ = stop_rx.changed() => {
                            if *stop_rx.borrow() {
                                break;
                            }
                        }
                        _ = time::sleep(Duration::from_secs(sleep_minutes * 60)) => {}
                    }
                }
            });

            self.tasks.insert(idx, TaskControl { stop_tx, handle });
        }

        let snapshot = runtime_status.read().await.clone();
        let _ = tray::refresh_tray(&app, snapshot);
    }

    pub async fn stop(&mut self) {
        if self.tasks.is_empty() {
            self.running = false;
            return;
        }

        info!("scheduler stopping {} task(s)", self.tasks.len());

        for task in self.tasks.values_mut() {
            let _ = task.stop_tx.send(true);
            task.handle.abort();
        }

        let tasks = std::mem::take(&mut self.tasks);
        for (_, task) in tasks {
            let _ = task.handle.await;
        }

        self.running = false;
        info!("scheduler stopped");
    }

    pub async fn reload_if_running(
        &mut self,
        app: AppHandle,
        config: AppConfig,
        runtime_status: Arc<RwLock<RuntimeStatus>>,
    ) {
        if self.is_running() {
            self.start(app, config, runtime_status).await;
        }
    }
}

fn should_fire_wake(
    slot_cfg: &crate::models::KeySlotConfig,
    latest_next_reset_epoch_ms: Option<i64>,
    last_times_marker: &mut Option<String>,
    last_reset_marker: &mut Option<i64>,
    last_interval_fire: &mut Instant,
) -> bool {
    if !slot_cfg.wake_enabled {
        return false;
    }

    match slot_cfg.wake_mode {
        WakeMode::Interval => {
            let interval = Duration::from_secs(slot_cfg.wake_interval_minutes.max(1) * 60);
            if last_interval_fire.elapsed() >= interval {
                *last_interval_fire = Instant::now();
                true
            } else {
                false
            }
        }
        WakeMode::Times => {
            let now = Local::now();
            let current_hm = format!("{:02}:{:02}", now.hour(), now.minute());
            if !slot_cfg.wake_times.iter().any(|value| value == &current_hm) {
                return false;
            }

            let marker = format!("{}-{}", now.format("%Y-%m-%d"), current_hm);
            if last_times_marker.as_ref() == Some(&marker) {
                return false;
            }

            *last_times_marker = Some(marker);
            true
        }
        WakeMode::AfterReset => {
            let Some(next_reset) = latest_next_reset_epoch_ms else {
                return false;
            };
            let target = next_reset + (slot_cfg.wake_after_reset_minutes.max(1) as i64 * 60_000);
            let now_ms = Local::now().timestamp_millis();

            if now_ms < target {
                return false;
            }

            if *last_reset_marker == Some(next_reset) {
                return false;
            }

            *last_reset_marker = Some(next_reset);
            true
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
