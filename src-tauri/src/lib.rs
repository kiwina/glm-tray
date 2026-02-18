mod api_client;
mod config;
mod file_logger;
mod models;
mod scheduler;
mod tray;
mod update_checker;

use std::sync::Arc;

use log::{error, info, warn};
use models::{AppConfig, RuntimeStatus};
use models::SlotStats;
use tauri::{Emitter, Manager};
use tokio::sync::{Mutex, RwLock};

pub struct SharedState {
    pub config: Arc<RwLock<AppConfig>>,
    pub runtime_status: Arc<RwLock<RuntimeStatus>>,
    pub scheduler: Arc<Mutex<scheduler::SchedulerManager>>,
}

fn has_enabled_slot_with_key(config: &AppConfig) -> bool {
    config
        .slots
        .iter()
        .any(|slot| slot.enabled && !slot.api_key.trim().is_empty())
}

#[tauri::command]
async fn load_settings(app: tauri::AppHandle, state: tauri::State<'_, SharedState>) -> Result<AppConfig, String> {
    info!("loading settings from disk");
    let loaded = config::load_config(&app).await?;
    {
        let mut guard = state.config.write().await;
        *guard = loaded.clone();
    }
    let enabled = loaded.slots.iter().filter(|s| s.enabled).count();
    info!("settings loaded: {enabled} slot(s) enabled");
    Ok(loaded)
}

#[tauri::command]
async fn save_settings(
    app: tauri::AppHandle,
    state: tauri::State<'_, SharedState>,
    settings: AppConfig,
) -> Result<AppConfig, String> {
    let saved = config::save_config(&app, settings).await?;
    info!("settings saved to disk");

    {
        let mut guard = state.config.write().await;
        *guard = saved.clone();
    }

    let runtime_status = state.runtime_status.clone();
    let mut scheduler = state.scheduler.lock().await;
    scheduler
        .reload_if_running(app.clone(), saved.clone(), runtime_status)
        .await;

    Ok(saved)
}

#[tauri::command]
async fn start_monitoring(app: tauri::AppHandle) -> Result<(), String> {
    start_monitoring_internal(app).await
}

#[tauri::command]
async fn stop_monitoring(app: tauri::AppHandle) -> Result<(), String> {
    stop_monitoring_internal(app).await
}

#[tauri::command]
async fn get_runtime_status(state: tauri::State<'_, SharedState>) -> Result<RuntimeStatus, String> {
    Ok(state.runtime_status.read().await.clone())
}

#[tauri::command]
async fn warmup_all(app: tauri::AppHandle) -> Result<(), String> {
    warmup_all_internal(app).await
}

#[tauri::command]
async fn warmup_slot(app: tauri::AppHandle, state: tauri::State<'_, SharedState>, slot: usize) -> Result<(), String> {
    info!("warmup slot {} requested", slot);
    let config = state.config.read().await.clone();
    let slot_cfg = config.slots.iter().find(|s| s.slot == slot)
        .ok_or_else(|| format!("slot {slot} not found"))?;

    if !slot_cfg.enabled || slot_cfg.api_key.trim().is_empty() {
        return Err("slot is disabled or has no API key".into());
    }

    let client = api_client::ApiClient::new(Some(app), config.debug, config.mock_url.clone())?;
    if is_slot_quota_full_realtime(&client, &state.runtime_status, slot_cfg).await {
        return Err("slot reset window is still active".into());
    }
    client.warmup_key(slot_cfg).await?;
    info!("warmup slot {} succeeded", slot);
    Ok(())
}

#[tauri::command]
async fn fetch_slot_stats(app: tauri::AppHandle, state: tauri::State<'_, SharedState>, slot: usize) -> Result<SlotStats, String> {
    let config = state.config.read().await;
    let slot_cfg = config.slots.iter().find(|s| s.slot == slot)
        .ok_or_else(|| format!("slot {slot} not found"))?;
    if slot_cfg.api_key.trim().is_empty() {
        return Err("no API key configured".into());
    }
    let client = api_client::ApiClient::new(Some(app), config.debug, config.mock_url.clone())?;
    client.fetch_slot_stats(slot_cfg).await
}

#[tauri::command]
async fn check_for_updates_cmd() -> Result<update_checker::UpdateInfo, String> {
    update_checker::check_for_updates().await
}

pub async fn start_monitoring_internal(app: tauri::AppHandle) -> Result<(), String> {
    info!("starting monitoring");
    let state = app.state::<SharedState>();
    let settings = state.config.read().await.clone();
    let enabled = settings
        .slots
        .iter()
        .filter(|s| s.enabled && !s.api_key.trim().is_empty())
        .count();

    if enabled == 0 {
        info!("start monitoring skipped: no enabled slots configured");
        let _ = app.emit("monitoring-changed", false);
        return Ok(());
    }

    info!("monitoring {enabled} enabled slot(s)");
    let runtime_status = state.runtime_status.clone();
    let mut scheduler = state.scheduler.lock().await;
    scheduler.start(app.clone(), settings, runtime_status).await;
    let _ = app.emit("monitoring-changed", true);
    Ok(())
}

pub async fn stop_monitoring_internal(app: tauri::AppHandle) -> Result<(), String> {
    info!("stopping monitoring");
    let state = app.state::<SharedState>();
    let config = state.config.read().await.clone();
    let mut scheduler = state.scheduler.lock().await;
    scheduler.stop().await;
    scheduler::reset_runtime(&state.runtime_status).await;
    let snapshot = state.runtime_status.read().await.clone();
    let has_ready_slots = has_enabled_slot_with_key(&config);
    tray::refresh_tray(&app, snapshot, has_ready_slots)?;
    let _ = app.emit("monitoring-changed", false);
    Ok(())
}

pub async fn warmup_all_internal(app: tauri::AppHandle) -> Result<(), String> {
    info!("warmup all keys requested");
    let state = app.state::<SharedState>();
    let config = state.config.read().await.clone();
    let runtime_status = state.runtime_status.clone();
    let client = api_client::ApiClient::new(Some(app.clone()), config.debug, config.mock_url.clone())?;

    for slot_cfg in &config.slots {
        if !slot_cfg.enabled || slot_cfg.api_key.trim().is_empty() {
            continue;
        }
        if is_slot_quota_full_realtime(&client, &runtime_status, slot_cfg).await {
            warn!(
                "slot {} next reset window is still active, skipping warmup",
                slot_cfg.slot
            );
            continue;
        }
        info!("warming up slot {}", slot_cfg.slot);
        match client.warmup_key(slot_cfg).await {
            Ok(()) => info!("warmup slot {} succeeded", slot_cfg.slot),
            Err(err) => warn!("warmup slot {} failed: {}", slot_cfg.slot, err),
        }
    }

    info!("warmup all keys completed");
    Ok(())
}

async fn is_slot_quota_full_realtime(
    client: &api_client::ApiClient,
    runtime_status: &Arc<RwLock<RuntimeStatus>>,
    slot_cfg: &models::KeySlotConfig,
) -> bool {
    let now_ms = chrono::Local::now().timestamp_millis();

    let cached_reset = {
        let runtime = runtime_status.read().await;
        runtime
            .slots
            .get(slot_cfg.slot.saturating_sub(1))
            .and_then(|slot_status| slot_status.last_updated_epoch_ms)
    };

    if let Some(next_reset_ms) = cached_reset {
        // Trust a still-active cached timer; recheck when expired/missing.
        if next_reset_ms > now_ms {
            return false;
        }
    }

    let slot_idx = slot_cfg.slot.saturating_sub(1);
    match client.fetch_quota(slot_cfg).await {
        Ok(snapshot) => {
            if let Some(current) = runtime_status.write().await.slots.get_mut(slot_idx) {
                current.percentage = Some(snapshot.percentage);
                current.timer_active = snapshot.timer_active;
                current.next_reset_hms = snapshot.next_reset_hms;
                current.last_updated_epoch_ms = snapshot.next_reset_epoch_ms;
            }

            match snapshot.next_reset_epoch_ms {
                Some(next_reset_ms) => next_reset_ms <= now_ms,
                None => true,
            }
        }
        Err(err) => {
            warn!(
                "slot {} quota pre-check failed during warmup: {}",
                slot_cfg.slot,
                err
            );
            false
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let _ = env_logger::builder().is_test(false).try_init();

    tauri::Builder::default()
        .setup(|app| {
            // Single-instance plugin must be registered first
            #[cfg(desktop)]
            {
                let app_handle = app.handle().clone();
                app.handle().plugin(tauri_plugin_single_instance::init(move |_app, _args, _cwd| {
                    // Focus the main window when a second instance is attempted
                    if let Some(win) = app_handle.get_webview_window("main") {
                        let _ = win.set_focus();
                        let _ = win.show();
                    }
                }))?;
            }

            let app_handle = app.handle().clone();
            let (initial_config, _) = tauri::async_runtime::block_on(async {
                let initial_config = match config::load_config(&app_handle).await {
                    Ok(cfg) => cfg,
                    Err(err) => {
                        error!("failed to load persisted config, using defaults: {}", err);
                        AppConfig::default()
                    }
                };
                let has_ready_slots = has_enabled_slot_with_key(&initial_config);

                app.manage(SharedState {
                    config: Arc::new(RwLock::new(initial_config.clone())),
                    runtime_status: Arc::new(RwLock::new(RuntimeStatus::default())),
                    scheduler: Arc::new(Mutex::new(scheduler::SchedulerManager::new())),
                });

                // Clean up old log files (keep max 7 days)
                file_logger::cleanup_old_logs(&app_handle).await;
                (initial_config, has_ready_slots)
            });

            let has_ready_slots = has_enabled_slot_with_key(&initial_config);
            tray::setup_tray(&app_handle, has_ready_slots)?;

            // Auto-start monitoring on launch
            let startup_handle = app_handle.clone();
            tauri::async_runtime::spawn(async move {
                if let Err(err) = start_monitoring_internal(startup_handle).await {
                    warn!("auto-start monitoring failed: {}", err);
                } else {
                    info!("monitoring auto-started on launch");
                }
            });

            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .invoke_handler(tauri::generate_handler![
            load_settings,
            save_settings,
            start_monitoring,
            stop_monitoring,
            get_runtime_status,
            warmup_all,
            warmup_slot,
            fetch_slot_stats,
            check_for_updates_cmd
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
