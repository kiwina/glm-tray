use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use chrono::{Local, Timelike};
use log::{error, info, warn};
use serde_json::json;
use tauri::{AppHandle, Emitter};
use tokio::sync::{watch, RwLock};
use tokio::task::JoinHandle;
use tokio::time::{self, Duration, Instant};

use crate::api_client::ApiClient;
use crate::file_logger;
use crate::models::{AppConfig, KeySlotConfig, RuntimeStatus, SlotRuntimeStatus};
use crate::tray;

const WAKE_RETRY_INTERVAL_SECONDS: u64 = 60;

#[derive(Clone, Copy)]
struct SchedulerPolicy {
    max_consecutive_errors: u32,
    quota_backoff_cap_minutes: u64,
    wake_quota_retry_window_minutes: u64,
}

impl From<&AppConfig> for SchedulerPolicy {
    fn from(cfg: &AppConfig) -> Self {
        Self {
            max_consecutive_errors: cfg.max_consecutive_errors.max(1),
            quota_backoff_cap_minutes: cfg.quota_poll_backoff_cap_minutes.max(1),
            wake_quota_retry_window_minutes: cfg.wake_quota_retry_window_minutes.max(1),
        }
    }
}

#[derive(Clone, Copy)]
enum WakeConfirmOutcome {
    NotPending,
    Confirmed,
    FailedMissing,
    FailedNotAdvanced,
    AutoDisabled,
}

fn has_enabled_slot(cfg: &AppConfig) -> bool {
    cfg
        .slots
        .iter()
        .any(|slot| slot.enabled && !slot.api_key.trim().is_empty())
}

/// Shared schedule state between wake scheduler and quota poller
#[derive(Debug, Clone)]
struct SlotSchedule {
    next_reset_epoch_ms: Option<i64>,
    last_times_marker: Option<String>,
    last_reset_marker: Option<i64>,
    last_interval_fire: Instant,
    wake_retry_window_deadline: Option<Instant>,
    wake_timeout_retry_fired: bool,
}

impl Default for SlotSchedule {
    fn default() -> Self {
        Self {
            next_reset_epoch_ms: None,
            last_times_marker: None,
            last_reset_marker: None,
            last_interval_fire: Instant::now(),
            wake_retry_window_deadline: None,
            wake_timeout_retry_fired: false,
        }
    }
}

/// Controls for a single slot's tasks (wake + poll)
#[allow(dead_code)] // Fields used for task control, some kept for future extensibility
struct SlotTaskControl {
    stop_tx: watch::Sender<bool>,
    config_tx: watch::Sender<KeySlotConfig>,
    app_config_tx: watch::Sender<AppConfig>,
    poll_now_tx: watch::Sender<bool>,
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
                slot.auto_disabled = false;
                slot.wake_auto_disabled = false;
                slot.enabled = false;
                slot.last_error = None;
                slot.consecutive_errors = 0;
                slot.quota_consecutive_errors = 0;
                slot.wake_consecutive_errors = 0;
                slot.wake_pending = false;
                slot.wake_reset_epoch_ms = None;
                slot.timer_active = false;
                slot.percentage = None;
                slot.next_reset_hms = None;
                slot.last_updated_epoch_ms = None;
            }
        }

        for (idx, slot_cfg) in config.slots.iter().enumerate() {
            if !slot_cfg.enabled || slot_cfg.api_key.trim().is_empty() {
                continue;
            }
            self.spawn_slot_task(idx, slot_cfg.clone(), config.clone(), &app, runtime_status.clone()).await;
        }

        let snapshot = runtime_status.read().await.clone();
        let has_ready_slots = has_enabled_slot(&config);
        let _ = tray::refresh_tray(&app, snapshot, has_ready_slots);
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
        app: AppHandle,
        config: AppConfig,
        runtime_status: Arc<RwLock<RuntimeStatus>>,
    ) {
        if !self.is_running() {
            return;
        }

        info!("scheduler reloading configuration");

        let mut desired_slots: HashMap<usize, KeySlotConfig> = HashMap::new();
        for (idx, slot_cfg) in config.slots.iter().enumerate() {
            if slot_cfg.enabled && !slot_cfg.api_key.trim().is_empty() {
                desired_slots.insert(idx, slot_cfg.clone());
            }
        }

        let running_indices: Vec<usize> = self.slot_tasks.keys().copied().collect();
        let mut changed_indices: HashSet<usize> = HashSet::new();

        // Update existing tasks and stop those that should no longer run.
        for idx in running_indices {
            if let Some(slot_cfg) = desired_slots.get(&idx) {
                if let Some(slot_task) = self.slot_tasks.get(&idx) {
                    let _ = slot_task.config_tx.send(slot_cfg.clone());
                    let _ = slot_task.app_config_tx.send(config.clone());
                    sync_slot_runtime_name(&runtime_status, idx, slot_cfg).await;
                    info!("slot {} config updated", idx + 1);
                    changed_indices.insert(idx);
                }
            } else {
                if let Some(task) = self.slot_tasks.remove(&idx) {
                    let _ = task.stop_tx.send(true);
                    let _ = task.wake_handle.await;
                    let _ = task.poll_handle.await;
                    clear_slot_runtime(&runtime_status, idx).await;
                    info!("slot {} task stopped after config change", idx + 1);
                    changed_indices.insert(idx);
                }
            }
        }

        // Start tasks for slots enabled in config that were not previously running.
        for (idx, slot_cfg) in desired_slots {
            if self.slot_tasks.contains_key(&idx) {
                continue;
            }
            self.spawn_slot_task(idx, slot_cfg, config.clone(), &app, runtime_status.clone()).await;
            changed_indices.insert(idx);
        }

        if !changed_indices.is_empty() {
            let snapshot = runtime_status.read().await.clone();
            let has_ready_slots = has_enabled_slot(&config);
            let _ = tray::refresh_tray(&app, snapshot, has_ready_slots);
        }
    }

    async fn spawn_slot_task(
        &mut self,
        idx: usize,
        slot_cfg: KeySlotConfig,
        app_config: AppConfig,
        app: &AppHandle,
        runtime_status: Arc<RwLock<RuntimeStatus>>,
    ) {
        {
            let mut runtime = runtime_status.write().await;
            if let Some(current) = runtime.slots.get_mut(idx) {
                current.name = slot_cfg.name.clone();
            }
        }

        let (stop_tx, stop_rx) = watch::channel(false);
        let (config_tx, config_rx) = watch::channel(slot_cfg);
        let (app_config_tx, app_config_rx) = watch::channel(app_config);
        let (poll_now_tx, poll_now_rx) = watch::channel(false);

        let schedule = Arc::new(RwLock::new(SlotSchedule::default()));
        let runtime_handle = runtime_status.clone();

        let wake_handle = tokio::spawn(Self::wake_scheduler_task(
            idx,
            app.clone(),
            config_rx.clone(),
            app_config_rx.clone(),
            schedule.clone(),
            runtime_handle.clone(),
            stop_rx.clone(),
            poll_now_tx.clone(),
        ));

        let poll_handle = tokio::spawn(Self::quota_poller_task(
            idx,
            app.clone(),
            config_rx,
            app_config_rx,
            schedule,
            runtime_handle,
            stop_rx,
            poll_now_tx.clone(),
            poll_now_rx,
        ));

        self.slot_tasks.insert(idx, SlotTaskControl {
            stop_tx,
            config_tx,
            app_config_tx,
            poll_now_tx,
            wake_handle,
            poll_handle,
        });
    }

    /// Wake scheduler task - runs every minute to check wake conditions
    async fn wake_scheduler_task(
        idx: usize,
        app: AppHandle,
        mut config_rx: watch::Receiver<KeySlotConfig>,
        mut app_config_rx: watch::Receiver<AppConfig>,
        schedule: Arc<RwLock<SlotSchedule>>,
        runtime_status: Arc<RwLock<RuntimeStatus>>,
        mut stop_rx: watch::Receiver<bool>,
        poll_now_tx: watch::Sender<bool>,
    ) {
        info!("slot {} wake scheduler started", idx + 1);
        let initial_cfg = config_rx.borrow().clone();
        let _ = log_scheduler_event(
            &app,
            &initial_cfg,
            "wake.scheduler.task-started",
            json!({"slot": idx + 1}),
        )
        .await;

        let client = match ApiClient::new(Some(app.clone())) {
            Ok(client) => client,
            Err(err) => {
                warn!("slot {} client setup failed: {}", idx + 1, err);
                let initial_policy = SchedulerPolicy::from(&*app_config_rx.borrow());
                let _ = record_wake_error(
                    &runtime_status,
                    idx,
                    &err,
                    initial_policy.max_consecutive_errors,
                )
                .await;
                let has_ready_slots = has_enabled_slot(&app_config_rx.borrow());
                let _ = tray::refresh_tray(
                    &app,
                    runtime_status.read().await.clone(),
                    has_ready_slots,
                );
                return;
            }
        };

        let mut poll_now_signal = false;

        loop {
            let current_policy = SchedulerPolicy::from(&*app_config_rx.borrow());
            let cfg = config_rx.borrow().clone();

            if *stop_rx.borrow() {
                let _ = log_scheduler_event(
                    &app,
                    &cfg,
                    "wake.scheduler.task-stopped",
                    json!({"slot": idx + 1, "reason": "stop-signal"}),
                )
                .await;
                break;
            }
            if !cfg.enabled || cfg.api_key.trim().is_empty() {
                info!("slot {} disabled config, stopping wake scheduler", idx + 1);
                let _ = log_scheduler_event(
                    &app,
                    &cfg,
                    "wake.scheduler.config-disabled",
                    json!({"slot": idx + 1}),
                )
                .await;
                clear_slot_runtime(&runtime_status, idx).await;
                let runtime_snapshot = runtime_status.read().await.clone();
                let has_ready_slots = has_enabled_slot(&app_config_rx.borrow());
                let _ = tray::refresh_tray(&app, runtime_snapshot, has_ready_slots);
                break;
            }

            {
                let runtime = runtime_status.read().await;
                if runtime
                    .slots
                    .get(idx)
                    .is_some_and(|slot| slot.auto_disabled)
                {
                    info!("slot {} auto-disabled, stopping wake scheduler", idx + 1);
                    let _ = log_scheduler_event(
                        &app,
                        &cfg,
                        "wake.scheduler.auto-disabled",
                        json!({"slot": idx + 1, "source": "quota-auto-disable"}),
                    )
                    .await;
                    break;
                }
            }
            {
                let runtime = runtime_status.read().await;
                if runtime
                    .slots
                    .get(idx)
                    .is_some_and(|slot| slot.wake_auto_disabled)
                {
                    info!("slot {} wake auto-disabled, stopping wake scheduler", idx + 1);
                    let _ = log_scheduler_event(
                        &app,
                        &cfg,
                        "wake.scheduler.auto-disabled",
                        json!({"slot": idx + 1, "source": "wake-auto-disable"}),
                    )
                    .await;
                    break;
                }
            }

            // Get current schedule state
            let sched = schedule.read().await.clone();

            // Check if we should fire a wake request
            let schedule_reason = should_fire_wake(&cfg, &sched);
            let wake_error_count = {
                let runtime = runtime_status.read().await;
                runtime
                    .slots
                    .get(idx)
                    .map(|slot| slot.wake_consecutive_errors)
                    .unwrap_or(0)
            };
            let wake_pending = {
                let runtime = runtime_status.read().await;
                runtime
                    .slots
                    .get(idx)
                    .is_some_and(|slot| slot.wake_pending)
            };
            let should_retry_after_errors = {
                let runtime = runtime_status.read().await;
                runtime
                    .slots
                    .get(idx)
                    .is_some_and(|slot| slot.wake_consecutive_errors > 0 && !slot.wake_pending)
            };
            let wake_window_active = should_retry_quota_while_wake_pending(&schedule, &runtime_status, idx)
                .await;
            let wake_retry_due = wake_pending && !wake_window_active && !sched.wake_timeout_retry_fired;

            if schedule_reason.is_some() && wake_pending && !wake_retry_due {
                let _ = log_scheduler_event(
                    &app,
                    &cfg,
                    "wake.scheduler.duplicate-suppressed",
                    json!({
                        "slot": idx + 1,
                        "reason": schedule_reason.as_deref().unwrap_or("unknown"),
                    }),
                )
                .await;
                let mut sched_mut = schedule.write().await;
                let old_sched = sched_mut.clone();
                update_schedule_markers(&cfg, &old_sched, &mut sched_mut);
                info!("slot {} wake already pending; skipping duplicate wake", idx + 1);
            } else if schedule_reason.is_some() || should_retry_after_errors || wake_retry_due {
                let is_required_now =
                    is_wake_required(&client, &runtime_status, &cfg, idx).await;

                if !is_required_now {
                    let _ = log_scheduler_event(
                        &app,
                        &cfg,
                        "wake.scheduler.condition-not-ready",
                        json!({
                            "slot": idx + 1,
                            "schedule_reason": schedule_reason.clone(),
                            "should_retry_after_errors": should_retry_after_errors,
                            "wake_retry_due": wake_retry_due,
                        }),
                    )
                    .await;
                    if should_retry_after_errors || wake_retry_due {
                        clear_wake_state(&runtime_status, idx).await;
                        let _ = log_scheduler_event(
                            &app,
                            &cfg,
                            "wake.pending-cleared",
                            json!({
                                "slot": idx + 1,
                                "reason": if should_retry_after_errors { "no-longer-requires-wake" } else { "retry-window-expired" },
                            }),
                        )
                        .await;
                    }
                    if let Some(reason) = schedule_reason.as_deref() {
                        info!("slot {} wake condition not ready ({})", idx + 1, reason);
                    } else if wake_retry_due {
                        info!("slot {} wake retry window elapsed; wake no longer required", idx + 1);
                    } else {
                        info!(
                            "slot {} retrying wake after failures but reset is not yet active",
                            idx + 1
                        );
                    }

                    if schedule_reason.is_some() {
                        let mut sched_mut = schedule.write().await;
                        let old_sched = sched_mut.clone();
                        update_schedule_markers(&cfg, &old_sched, &mut sched_mut);
                    }
                } else {
                    let reason = schedule_reason
                        .clone()
                        .unwrap_or_else(|| {
                            if wake_retry_due {
                                "forced wake retry after confirmation timeout".to_string()
                            } else {
                                "retrying wake after failures".to_string()
                            }
                        });
                    info!("slot {} wake condition met: {}", idx + 1, reason);
                    let _ = log_scheduler_event(
                        &app,
                        &cfg,
                        "wake.scheduler.wake-attempt",
                        json!({
                            "slot": idx + 1,
                            "reason": reason,
                            "wake_pending": wake_pending,
                            "wake_error_count": wake_error_count,
                            "wake_retry_due": wake_retry_due,
                            "wake_window_active": wake_window_active,
                        }),
                    )
                    .await;

                    if let Err(err) = client.send_wake_request(&cfg).await {
                        warn!("slot {} scheduled wake failed: {}", idx + 1, err);
                        let _ = log_scheduler_event(
                            &app,
                            &cfg,
                            "wake.scheduler.wake-attempt-failed",
                            json!({
                                "slot": idx + 1,
                                "reason": reason,
                                "error": err,
                            }),
                        )
                        .await;
                        let consecutive_errors = record_wake_error(
                            &runtime_status,
                            idx,
                            &err,
                            current_policy.max_consecutive_errors,
                        )
                        .await;
                        if consecutive_errors >= current_policy.max_consecutive_errors {
                            let _ = log_scheduler_event(
                                &app,
                                &cfg,
                                "wake.scheduler.auto-disabled",
                                json!({
                                    "slot": idx + 1,
                                    "consecutive_errors": consecutive_errors,
                                }),
                            )
                            .await;
                            let runtime_snapshot = runtime_status.read().await.clone();
                            let has_ready_slots = has_enabled_slot(&app_config_rx.borrow());
                            let _ = tray::refresh_tray(&app, runtime_snapshot, has_ready_slots);
                            break;
                        }
                    } else {
                        info!("slot {} scheduled wake fired", idx + 1);
                        let _ = log_scheduler_event(
                            &app,
                            &cfg,
                            "wake.scheduler.wake-attempt-success",
                            json!({
                                "slot": idx + 1,
                                "reason": reason,
                                "retrying_after_errors": should_retry_after_errors,
                            }),
                        )
                        .await;

                    let pre_reset_marker = {
                        let runtime = runtime_status.read().await;
                        runtime
                            .slots
                            .get(idx)
                                .and_then(|slot| slot.last_updated_epoch_ms)
                        };

                        // Update schedule markers after successful wake
                        let mut sched_mut = schedule.write().await;
                        let old_sched = sched_mut.clone();
                        update_schedule_markers(&cfg, &old_sched, &mut sched_mut);
                        if wake_retry_due {
                            sched_mut.wake_timeout_retry_fired = true;
                            sched_mut.wake_retry_window_deadline = None;
                        } else {
                            sched_mut.wake_retry_window_deadline = Some(
                                Instant::now()
                                    + Duration::from_secs(
                                        current_policy.wake_quota_retry_window_minutes * 60,
                                    ),
                            );
                            sched_mut.wake_timeout_retry_fired = false;
                        }
                        mark_wake_attempt(&runtime_status, idx, pre_reset_marker).await;
                        let _ = log_scheduler_event(
                            &app,
                            &cfg,
                            "wake.pending-set",
                            json!({
                                "slot": idx + 1,
                                "pre_reset_marker": pre_reset_marker,
                                "forced_retry": wake_retry_due,
                            }),
                        )
                        .await;

                        // Trigger immediate quota poll to verify wake worked
                        poll_now_signal = !poll_now_signal;
                        let _ = poll_now_tx.send(poll_now_signal);
                        info!("slot {} triggered immediate quota poll", idx + 1);
                    }
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
                _ = app_config_rx.changed() => {
                    info!("slot {} wake scheduler detected policy change", idx + 1);
                }
                _ = time::sleep(Duration::from_secs(WAKE_RETRY_INTERVAL_SECONDS)) => {}
            }
        }

        info!("slot {} wake scheduler stopped", idx + 1);
    }

    /// Quota poller task - fetches quota at configured intervals
    async fn quota_poller_task(
        idx: usize,
        app: AppHandle,
        mut config_rx: watch::Receiver<KeySlotConfig>,
        mut app_config_rx: watch::Receiver<AppConfig>,
        schedule: Arc<RwLock<SlotSchedule>>,
        runtime_status: Arc<RwLock<RuntimeStatus>>,
        mut stop_rx: watch::Receiver<bool>,
        poll_now_tx: watch::Sender<bool>,
        mut poll_now_rx: watch::Receiver<bool>,
    ) {
        info!("slot {} quota poller started", idx + 1);
        let initial_cfg = config_rx.borrow().clone();
        let _ = log_scheduler_event(
            &app,
            &initial_cfg,
            "quota-poller.task-started",
            json!({"slot": idx + 1}),
        )
        .await;
        let mut poll_now_signal = false;

        let client = match ApiClient::new(Some(app.clone())) {
            Ok(client) => client,
            Err(err) => {
                warn!("slot {} client setup failed: {}", idx + 1, err);
                let current_policy = SchedulerPolicy::from(&*app_config_rx.borrow());
                let _ = record_quota_error(
                    &runtime_status,
                    idx,
                    &err,
                    current_policy.max_consecutive_errors,
                )
                .await;
                let has_ready_slots = has_enabled_slot(&app_config_rx.borrow());
                let _ = tray::refresh_tray(
                    &app,
                    runtime_status.read().await.clone(),
                    has_ready_slots,
                );
                return;
            }
        };

        // Send initial wake request
        let cfg = config_rx.borrow().clone();
        let initial_policy = SchedulerPolicy::from(&*app_config_rx.borrow());
        if is_wake_required(&client, &runtime_status, &cfg, idx).await {
                let _ = log_scheduler_event(
                    &app,
                    &cfg,
                    "quota-poller.initial-wake-trigger",
                    json!({"slot": idx + 1}),
                )
                .await;
                if let Err(err) = client.send_wake_request(&cfg).await {
                    warn!("slot {} initial wake failed: {}", idx + 1, err);
                    let _ = log_scheduler_event(
                        &app,
                        &cfg,
                        "quota-poller.initial-wake-failed",
                        json!({
                            "slot": idx + 1,
                            "error": err
                        }),
                    )
                    .await;
                    let _ = record_wake_error(
                        &runtime_status,
                        idx,
                        &err,
                        initial_policy.max_consecutive_errors,
                    )
                    .await;
                    let runtime_snapshot = runtime_status.read().await.clone();
                    let has_ready_slots = has_enabled_slot(&app_config_rx.borrow());
                    let _ = tray::refresh_tray(&app, runtime_snapshot, has_ready_slots);
                } else {
                let pre_reset_marker = {
                    let runtime = runtime_status.read().await;
                    runtime
                        .slots
                        .get(idx)
                        .and_then(|slot| slot.last_updated_epoch_ms)
                    };
                        mark_wake_attempt(&runtime_status, idx, pre_reset_marker).await;
                    {
                        let mut sched_mut = schedule.write().await;
                        sched_mut.wake_timeout_retry_fired = false;
                        sched_mut.wake_retry_window_deadline = Some(
                            Instant::now()
                                + Duration::from_secs(
                                    initial_policy.wake_quota_retry_window_minutes * 60,
                                ),
                        );
                    }
                    poll_now_signal = !poll_now_signal;
                    let _ = poll_now_tx.send(poll_now_signal);
                    let _ = log_scheduler_event(
                        &app,
                        &cfg,
                        "quota-poller.initial-wake-poll",
                        json!({"slot": idx + 1}),
                    )
                    .await;
                    info!("slot {} triggered initial wake poll", idx + 1);
                }
        } else {
            info!(
                "slot {} skipping initial wake because wake conditions are not met",
                idx + 1
            );
        }

        loop {
            let current_policy = SchedulerPolicy::from(&*app_config_rx.borrow());
            let cfg = config_rx.borrow().clone();

            if *stop_rx.borrow() {
                let _ = log_scheduler_event(
                    &app,
                    &cfg,
                    "quota-poller.task-stopped",
                    json!({"slot": idx + 1, "reason": "stop-signal"}),
                )
                .await;
                break;
            }
            if !cfg.enabled || cfg.api_key.trim().is_empty() {
                info!("slot {} disabled config, stopping quota poller", idx + 1);
                let _ = log_scheduler_event(
                    &app,
                    &cfg,
                    "quota-poller.config-disabled",
                    json!({"slot": idx + 1}),
                )
                .await;
                clear_slot_runtime(&runtime_status, idx).await;
                let runtime_snapshot = runtime_status.read().await.clone();
                let has_ready_slots = has_enabled_slot(&app_config_rx.borrow());
                let _ = tray::refresh_tray(&app, runtime_snapshot, has_ready_slots);
                break;
            }

            {
                let runtime = runtime_status.read().await;
                if let Some(slot) = runtime.slots.get(idx) {
                    if slot.auto_disabled {
                        info!("slot {} auto-disabled, stopping quota poller", idx + 1);
                        let _ = log_scheduler_event(
                            &app,
                            &cfg,
                            "quota-poller.auto-disabled",
                            json!({"slot": idx + 1}),
                        )
                        .await;
                        break;
                    }
                } else {
                    let _ = log_scheduler_event(
                        &app,
                        &cfg,
                        "quota-poller.slot-missing",
                        json!({"slot": idx + 1}),
                    )
                    .await;
                    break;
                }
            }

            // Fetch quota
            let mut retry_quota_now = false;
            let mut wake_window_active = false;
            match client.fetch_quota(&cfg).await {
                Ok(snapshot) => {
                    let was_wake_pending = {
                        let runtime = runtime_status.read().await;
                        runtime
                            .slots
                            .get(idx)
                            .and_then(|slot| slot.wake_reset_epoch_ms)
                    };
                        let wake_outcome = if runtime_status
                            .read()
                            .await
                            .slots
                            .get(idx)
                            .is_some_and(|slot| slot.wake_pending)
                        {
                            complete_wake_if_advanced(
                                &runtime_status,
                                idx,
                                snapshot.next_reset_epoch_ms,
                                current_policy.max_consecutive_errors,
                            )
                            .await
                        } else {
                            WakeConfirmOutcome::NotPending
                        };
                    match wake_outcome {
                        WakeConfirmOutcome::Confirmed => {
                            let _ = log_scheduler_event(
                                &app,
                                &cfg,
                                "quota-poller.wake-confirmed",
                                json!({
                                    "slot": idx + 1,
                                    "previous_next_reset_ms": was_wake_pending,
                                    "next_reset_ms": snapshot.next_reset_epoch_ms,
                                }),
                            )
                            .await;
                        }
                        WakeConfirmOutcome::FailedMissing => {
                            let _ = log_scheduler_event(
                                &app,
                                &cfg,
                                "quota-poller.wake-confirmation-failed",
                                json!({
                                    "slot": idx + 1,
                                    "reason": "missing_next_reset_time",
                                    "previous_next_reset_ms": was_wake_pending,
                                }),
                            )
                            .await;
                        }
                        WakeConfirmOutcome::FailedNotAdvanced => {
                            let _ = log_scheduler_event(
                                &app,
                                &cfg,
                                "quota-poller.wake-confirmation-failed",
                                json!({
                                    "slot": idx + 1,
                                    "reason": "next_reset_time_not_advanced",
                                    "previous_next_reset_ms": was_wake_pending,
                                    "next_reset_ms": snapshot.next_reset_epoch_ms,
                                }),
                            )
                            .await;
                        }
                        WakeConfirmOutcome::AutoDisabled => {
                            let _ = log_scheduler_event(
                                &app,
                                &cfg,
                                "wake.scheduler.auto-disabled",
                                json!({
                                    "slot": idx + 1,
                                    "reason": "auto-disabled_during_confirmation",
                                }),
                            )
                            .await;
                        }
                        WakeConfirmOutcome::NotPending => {}
                    };

                    wake_window_active = should_retry_quota_while_wake_pending(
                        &schedule,
                        &runtime_status,
                        idx,
                    )
                    .await;

                    let _ = log_scheduler_event(
                        &app,
                        &cfg,
                        "quota-poller.quota-success",
                        json!({
                            "slot": idx + 1,
                            "next_reset_ms": snapshot.next_reset_epoch_ms,
                            "wake_window_active": wake_window_active,
                        }),
                    )
                    .await;

                    let wake_pending = {
                        let runtime = runtime_status.read().await;
                        runtime
                            .slots
                            .get(idx)
                            .is_some_and(|slot| slot.wake_pending)
                    };
                    if !wake_pending {
                        clear_wake_quota_retry_window(&schedule).await;
                    }

                    let consecutive_errors = {
                        let runtime = runtime_status.read().await;
                        runtime
                            .slots
                            .get(idx)
                            .map(|slot| slot.quota_consecutive_errors)
                            .unwrap_or(0)
                    };
                    if consecutive_errors > 0 {
                        info!(
                            "slot {} recovered after {} consecutive quota error(s)",
                            idx + 1,
                            consecutive_errors
                        );
                    }

                    // Verify next_reset_time is in the future
                    let now_ms = Local::now().timestamp_millis();
                    if let Some(next_reset) = snapshot.next_reset_epoch_ms {
                        if next_reset <= now_ms {
                            warn!(
                                "slot {} next_reset_time {} is not in the future (now: {})",
                                idx + 1, next_reset, now_ms
                            );
                        } else {
                            info!(
                                "slot {} quota verified: next_reset in {} min",
                                idx + 1,
                                (next_reset - now_ms) / 60_000
                            );
                        }
                    }

                    // Update shared schedule state
                    {
                        let mut sched = schedule.write().await;
                        sched.next_reset_epoch_ms = snapshot.next_reset_epoch_ms;
                    }

                        // Update runtime status for UI
                    clear_quota_error(&runtime_status, idx).await;
                    {
                        let mut runtime = runtime_status.write().await;
                        if let Some(current) = runtime.slots.get_mut(idx) {
                            current.slot = idx + 1;
                            current.name = cfg.name.clone();
                            current.enabled = true;
                            current.timer_active = snapshot.timer_active;
                            current.percentage = Some(snapshot.percentage);
                            current.next_reset_hms = snapshot.next_reset_hms.clone();
                            current.last_updated_epoch_ms = snapshot.next_reset_epoch_ms;
                            current.auto_disabled = false;
                        }
                    }

                    // Emit event to frontend so it can refresh stats
                    let _ = app.emit("quota-updated", serde_json::json!({
                        "slot": idx + 1,
                        "percentage": snapshot.percentage,
                        "timer_active": snapshot.timer_active,
                        "next_reset_hms": snapshot.next_reset_hms,
                        "next_reset_epoch_ms": snapshot.next_reset_epoch_ms
                    }));

                    info!("slot {} quota refreshed (next_reset: {:?})", idx + 1, snapshot.next_reset_epoch_ms);
                }
                Err(err) => {
                    retry_quota_now = should_retry_quota_while_wake_pending(&schedule, &runtime_status, idx)
                        .await;
                    if retry_quota_now {
                        let mut runtime = runtime_status.write().await;
                        if let Some(current) = runtime.slots.get_mut(idx) {
                            current.last_error = Some(format!(
                                "quota request failed during wake verification retry: {err}"
                            ));
                        }
                        warn!(
                            "slot {} poll failed during wake verification (retrying every minute for the next {} minutes): {}",
                            idx + 1,
                            current_policy.wake_quota_retry_window_minutes,
                            err
                        );
                        let _ = log_scheduler_event(
                            &app,
                            &cfg,
                            "quota-poller.retry-in-window",
                            json!({
                                "slot": idx + 1,
                                "error": err,
                                "window_minutes": current_policy.wake_quota_retry_window_minutes,
                            }),
                        )
                        .await;
                    } else {
                        let consecutive_errors = record_quota_error(
                            &runtime_status,
                            idx,
                            &err,
                            current_policy.max_consecutive_errors,
                        )
                        .await;
                        warn!(
                            "slot {} poll failed ({}/{} consecutive): {}",
                            idx + 1,
                            consecutive_errors,
                            current_policy.max_consecutive_errors,
                            err
                        );

                        if consecutive_errors >= current_policy.max_consecutive_errors {
                            let _ = log_scheduler_event(
                                &app,
                                &cfg,
                                "quota-poller.auto-disabled",
                                json!({
                                    "slot": idx + 1,
                                    "consecutive_errors": consecutive_errors,
                                }),
                            )
                            .await;
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
                            let has_ready_slots = has_enabled_slot(&app_config_rx.borrow());
                            let _ = tray::refresh_tray(&app, runtime_snapshot, has_ready_slots);
                            break;
                        }
                    }
                }
            }

            // Refresh tray
            let runtime_snapshot = runtime_status.read().await.clone();
            let has_ready_slots = has_enabled_slot(&app_config_rx.borrow());
            if let Err(err) = tray::refresh_tray(&app, runtime_snapshot, has_ready_slots) {
                error!("failed to refresh tray for slot {}: {}", idx + 1, err);
            }

            // Calculate sleep duration with backoff
            let consecutive_errors = if retry_quota_now || wake_window_active {
                0
            } else {
                let runtime = runtime_status.read().await;
                runtime
                    .slots
                    .get(idx)
                    .map(|slot| slot.quota_consecutive_errors)
                    .unwrap_or(0)
            };

            let sleep_minutes = if consecutive_errors == 0 {
                if retry_quota_now || wake_window_active {
                    1
                } else {
                    cfg.poll_interval_minutes.max(1)
                }
            } else {
                let backoff = cfg.poll_interval_minutes.max(1)
                    .saturating_mul(1u64 << consecutive_errors.min(6));
                let capped = backoff.min(current_policy.quota_backoff_cap_minutes);
                info!("slot {} backing off: next poll in {} min", idx + 1, capped);
                capped
            };

            // Sleep for poll interval, but wake immediately if signaled
            tokio::select! {
                _ = stop_rx.changed() => {
                    if *stop_rx.borrow() {
                        break;
                    }
                }
                _ = config_rx.changed() => {
                    info!("slot {} quota poller detected config change", idx + 1);
                }
                _ = app_config_rx.changed() => {
                    info!("slot {} quota poller detected policy change", idx + 1);
                }
                _ = poll_now_rx.changed() => {
                    info!("slot {} quota poller received immediate poll signal", idx + 1);
                }
                _ = time::sleep(Duration::from_secs(sleep_minutes * 60)) => {}
            }
        }

        info!("slot {} quota poller stopped", idx + 1);
    }
}

/// Check if wake should fire based on current config and schedule state.
/// Returns Some(reason) if should fire, None otherwise.
/// Now supports multiple enabled modes - fires if ANY enabled mode triggers.
fn should_fire_wake(
    slot_cfg: &KeySlotConfig,
    schedule: &SlotSchedule,
) -> Option<String> {
    // Check if any schedule mode is enabled
    let any_enabled = slot_cfg.schedule_interval_enabled
        || slot_cfg.schedule_times_enabled
        || slot_cfg.schedule_after_reset_enabled;

    if !any_enabled {
        return None;
    }

    // Check interval mode
    if slot_cfg.schedule_interval_enabled {
        let interval = Duration::from_secs(slot_cfg.schedule_interval_minutes.max(1) * 60);
        if schedule.last_interval_fire.elapsed() >= interval {
            return Some(format!(
                "interval mode ({} min elapsed)",
                slot_cfg.schedule_interval_minutes
            ));
        }
    }

    // Check times mode
    if slot_cfg.schedule_times_enabled {
        let now = Local::now();
        let current_hm = format!("{:02}:{:02}", now.hour(), now.minute());

        if slot_cfg.schedule_times.iter().any(|value| value == &current_hm) {
            let marker = format!("{}-{}", now.format("%Y-%m-%d"), current_hm);
            if schedule.last_times_marker.as_ref() != Some(&marker) {
                return Some(format!("times mode (matched {})", current_hm));
            }
        }
    }

    // Check after-reset mode
    if slot_cfg.schedule_after_reset_enabled {
        if let Some(next_reset) = schedule.next_reset_epoch_ms {
            let target = next_reset + (slot_cfg.schedule_after_reset_minutes.max(1) as i64 * 60_000);
            let now_ms = Local::now().timestamp_millis();

            if now_ms >= target && schedule.last_reset_marker != Some(next_reset) {
                return Some(format!(
                    "after-reset mode (reset + {} min)",
                    slot_cfg.schedule_after_reset_minutes
                ));
            }
        }
    }

    None
}

/// Update schedule markers after a successful wake.
/// Now updates markers for all enabled modes since multiple can be active.
fn update_schedule_markers(
    slot_cfg: &KeySlotConfig,
    old_schedule: &SlotSchedule,
    new_schedule: &mut SlotSchedule,
) {
    // Always update interval marker if enabled
    if slot_cfg.schedule_interval_enabled {
        new_schedule.last_interval_fire = Instant::now();
    }

    // Update times marker if enabled and matched
    if slot_cfg.schedule_times_enabled {
        let now = Local::now();
        let current_hm = format!("{:02}:{:02}", now.hour(), now.minute());
        if slot_cfg.schedule_times.iter().any(|value| value == &current_hm) {
            new_schedule.last_times_marker = Some(format!("{}-{}", now.format("%Y-%m-%d"), current_hm));
        }
    }

    // Update after-reset marker if enabled
    if slot_cfg.schedule_after_reset_enabled {
        if let Some(next_reset) = old_schedule.next_reset_epoch_ms {
            let target = next_reset + (slot_cfg.schedule_after_reset_minutes.max(1) as i64 * 60_000);
            let now_ms = Local::now().timestamp_millis();
            if now_ms >= target {
                new_schedule.last_reset_marker = Some(next_reset);
            }
        }
    }
}

async fn should_retry_quota_while_wake_pending(
    schedule: &Arc<RwLock<SlotSchedule>>,
    runtime_status: &Arc<RwLock<RuntimeStatus>>,
    idx: usize,
) -> bool {
    let wake_pending = {
        let runtime = runtime_status.read().await;
        runtime
            .slots
            .get(idx)
            .is_some_and(|slot| slot.wake_pending && !slot.wake_auto_disabled)
    };
    if !wake_pending {
        return false;
    }

    let deadline = {
        let sched = schedule.read().await;
        sched.wake_retry_window_deadline
    };

    deadline.is_some_and(|deadline| Instant::now() < deadline)
}

async fn clear_wake_quota_retry_window(schedule: &Arc<RwLock<SlotSchedule>>) {
    let mut sched = schedule.write().await;
    sched.wake_retry_window_deadline = None;
    sched.wake_timeout_retry_fired = false;
}

async fn is_wake_required(
    client: &ApiClient,
    runtime_status: &Arc<RwLock<RuntimeStatus>>,
    cfg: &KeySlotConfig,
    idx: usize,
) -> bool {
    let now_ms = Local::now().timestamp_millis();

    let cached_state = {
        let runtime = runtime_status.read().await;
        runtime
            .slots
            .get(idx)
            .and_then(|slot| slot.last_updated_epoch_ms)
    };

    if let Some(next_reset_ms) = cached_state {
        // If the cached window is still active, trust local state.
        if next_reset_ms > now_ms {
            return false;
        }
        // Expired/missing window state should be revalidated with live quota
        // so the app can observe externally triggered activity correctly.
    }

    match client.fetch_quota(cfg).await {
        Ok(snapshot) => {
            let mut runtime = runtime_status.write().await;
            if let Some(current) = runtime.slots.get_mut(idx) {
                current.percentage = Some(snapshot.percentage);
                current.timer_active = snapshot.timer_active;
                current.next_reset_hms = snapshot.next_reset_hms;
                current.last_updated_epoch_ms = snapshot.next_reset_epoch_ms;
            }

            snapshot
                .next_reset_epoch_ms
                .map_or(true, |next_reset_ms| next_reset_ms <= now_ms)
        }
        Err(err) => {
            warn!(
                "slot {} wake pre-check failed (quota fetch failed), attempting wake: {}",
                idx + 1,
                err
            );
            // If the quota API is unavailable, prefer to attempt the wake attempt
            // rather than skipping. This keeps wake cadence active on transient API
            // failures and avoids missing a required retry cycle.
            true
        }
    }
}

async fn mark_wake_attempt(
    runtime_status: &Arc<RwLock<RuntimeStatus>>,
    idx: usize,
    reset_marker: Option<i64>,
) {
    let mut runtime = runtime_status.write().await;
    if let Some(current) = runtime.slots.get_mut(idx) {
        current.wake_pending = true;
        current.wake_reset_epoch_ms = reset_marker;
    }
}

async fn complete_wake_if_advanced(
    runtime_status: &Arc<RwLock<RuntimeStatus>>,
    idx: usize,
    next_reset_epoch_ms: Option<i64>,
    max_consecutive_errors: u32,
) -> WakeConfirmOutcome {
    let mut runtime = runtime_status.write().await;
    let Some(current) = runtime.slots.get_mut(idx) else {
        return WakeConfirmOutcome::NotPending;
    };

    if !current.wake_pending {
        return WakeConfirmOutcome::NotPending;
    }

    let Some(next_reset) = next_reset_epoch_ms else {
        current.wake_consecutive_errors = current.wake_consecutive_errors.saturating_add(1);
        current.last_error = Some("wake confirmation pending: quota reset timestamp is missing".to_string());
        if current.wake_consecutive_errors >= max_consecutive_errors {
            current.wake_pending = false;
            current.wake_reset_epoch_ms = None;
            current.wake_auto_disabled = true;
            current.last_error = Some(format!(
                "wake disabled after {} consecutive wake failures",
                current.wake_consecutive_errors
            ));
            return WakeConfirmOutcome::AutoDisabled;
        }
        return WakeConfirmOutcome::FailedMissing;
    };

    match current.wake_reset_epoch_ms {
        None => {
            current.wake_pending = false;
            current.wake_reset_epoch_ms = None;
            current.wake_consecutive_errors = 0;
            current.wake_auto_disabled = false;
            if current.quota_consecutive_errors == 0 {
                current.last_error = None;
            }
            WakeConfirmOutcome::Confirmed
        }
        Some(previous) => {
            if next_reset <= previous {
                current.wake_consecutive_errors = current.wake_consecutive_errors.saturating_add(1);
                current.last_error = Some(
                    "wake confirmation failed: quota reset timestamp did not advance".to_string(),
                );
                if current.wake_consecutive_errors >= max_consecutive_errors {
                    current.wake_pending = false;
                    current.wake_reset_epoch_ms = None;
                    current.wake_auto_disabled = true;
                    current.last_error = Some(format!(
                        "wake disabled after {} consecutive wake failures",
                        current.wake_consecutive_errors
                    ));
                    return WakeConfirmOutcome::AutoDisabled;
                }
                return WakeConfirmOutcome::FailedNotAdvanced;
            }
            current.wake_pending = false;
            current.wake_reset_epoch_ms = None;
            current.wake_consecutive_errors = 0;
            current.wake_auto_disabled = false;
            if current.quota_consecutive_errors == 0 {
                current.last_error = None;
            }
            WakeConfirmOutcome::Confirmed
        }
    }
}

async fn record_wake_error(
    runtime_status: &Arc<RwLock<RuntimeStatus>>,
    idx: usize,
    message: &str,
    max_consecutive_errors: u32,
) -> u32 {
    let mut runtime = runtime_status.write().await;
    if let Some(current) = runtime.slots.get_mut(idx) {
        current.slot = idx + 1;
        current.enabled = true;
        current.last_error = Some(format!("wake request failed: {message}"));
        current.wake_consecutive_errors = current.wake_consecutive_errors.saturating_add(1);
        if current.wake_consecutive_errors >= max_consecutive_errors {
            current.wake_auto_disabled = true;
            current.last_error = Some(format!(
                "wake disabled after {} consecutive wake failures",
                current.wake_consecutive_errors
            ));
        }
        return current.wake_consecutive_errors;
    }

    0
}

async fn record_quota_error(
    runtime_status: &Arc<RwLock<RuntimeStatus>>,
    idx: usize,
    message: &str,
    max_consecutive_errors: u32,
) -> u32 {
    let mut runtime = runtime_status.write().await;
    if let Some(current) = runtime.slots.get_mut(idx) {
        current.slot = idx + 1;
        current.enabled = true;
        current.last_error = Some(format!("quota request failed: {message}"));
        current.quota_consecutive_errors = current.quota_consecutive_errors.saturating_add(1);
        current.consecutive_errors = current.quota_consecutive_errors;
        if current.quota_consecutive_errors >= max_consecutive_errors {
            current.auto_disabled = true;
            current.last_error = Some(format!(
                "quota polling disabled after {} consecutive quota failures",
                current.quota_consecutive_errors
            ));
        }
        return current.quota_consecutive_errors;
    }

    0
}

async fn clear_slot_runtime(runtime_status: &Arc<RwLock<RuntimeStatus>>, idx: usize) {
    let mut runtime = runtime_status.write().await;
    if let Some(current) = runtime.slots.get_mut(idx) {
        current.slot = idx + 1;
        current.enabled = false;
        current.timer_active = false;
        current.name.clear();
        current.percentage = None;
        current.next_reset_hms = None;
        current.last_error = None;
        current.last_updated_epoch_ms = None;
        current.consecutive_errors = 0;
        current.quota_consecutive_errors = 0;
        current.wake_consecutive_errors = 0;
        current.auto_disabled = false;
        current.wake_auto_disabled = false;
        current.wake_pending = false;
        current.wake_reset_epoch_ms = None;
    }
}

async fn sync_slot_runtime_name(
    runtime_status: &Arc<RwLock<RuntimeStatus>>,
    idx: usize,
    slot_cfg: &KeySlotConfig,
) {
    let mut runtime = runtime_status.write().await;
    if let Some(current) = runtime.slots.get_mut(idx) {
        current.name = slot_cfg.name.clone();
    }
}

async fn clear_quota_error(runtime_status: &Arc<RwLock<RuntimeStatus>>, idx: usize) {
    let mut runtime = runtime_status.write().await;
    if let Some(current) = runtime.slots.get_mut(idx) {
        current.quota_consecutive_errors = 0;
        current.consecutive_errors = 0;
        current.auto_disabled = false;
        if current.wake_consecutive_errors == 0 {
            current.last_error = None;
        }
    }
}

async fn clear_wake_state(runtime_status: &Arc<RwLock<RuntimeStatus>>, idx: usize) {
    let mut runtime = runtime_status.write().await;
    if let Some(current) = runtime.slots.get_mut(idx) {
        current.wake_pending = false;
        current.wake_reset_epoch_ms = None;
        current.wake_consecutive_errors = 0;
        current.wake_auto_disabled = false;
        if current.quota_consecutive_errors == 0 {
            current.last_error = None;
        }
    }
}

async fn log_scheduler_event(app: &AppHandle, cfg: &KeySlotConfig, action: &str, details: serde_json::Value) {
    if !cfg.logging {
        return;
    }
    let _ = file_logger::append(
        app,
        file_logger::event_entry(cfg.slot, action, Some(details)),
    )
    .await;
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
            wake_consecutive_errors: 0,
            quota_consecutive_errors: 0,
            consecutive_errors: 0,
            wake_pending: false,
            wake_reset_epoch_ms: None,
            wake_auto_disabled: false,
            auto_disabled: false,
        };
    }
}
