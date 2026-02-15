mod api_client;
mod config;
mod file_logger;
mod models;
mod scheduler;
mod tray;

use std::sync::Arc;

use log::{error, info, warn};
use models::{AppConfig, RuntimeStatus};
use models::SlotStats;
use tauri::Manager;
use tokio::sync::{Mutex, RwLock};

pub struct SharedState {
    pub config: Arc<RwLock<AppConfig>>,
    pub runtime_status: Arc<RwLock<RuntimeStatus>>,
    pub scheduler: Arc<Mutex<scheduler::SchedulerManager>>,
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
async fn fetch_slot_stats(app: tauri::AppHandle, state: tauri::State<'_, SharedState>, slot: usize) -> Result<SlotStats, String> {
    let config = state.config.read().await;
    let slot_cfg = config.slots.iter().find(|s| s.slot == slot)
        .ok_or_else(|| format!("slot {slot} not found"))?;
    if slot_cfg.api_key.trim().is_empty() {
        return Err("no API key configured".into());
    }
    let client = api_client::ApiClient::new(Some(app))?;
    client.fetch_slot_stats(slot_cfg).await
}

pub async fn start_monitoring_internal(app: tauri::AppHandle) -> Result<(), String> {
    info!("starting monitoring");
    let state = app.state::<SharedState>();
    let settings = state.config.read().await.clone();
    let enabled = settings.slots.iter().filter(|s| s.enabled && !s.api_key.trim().is_empty()).count();
    info!("monitoring {enabled} enabled slot(s)");
    let runtime_status = state.runtime_status.clone();
    let mut scheduler = state.scheduler.lock().await;
    scheduler.start(app.clone(), settings, runtime_status).await;
    Ok(())
}

pub async fn stop_monitoring_internal(app: tauri::AppHandle) -> Result<(), String> {
    info!("stopping monitoring");
    let state = app.state::<SharedState>();
    let mut scheduler = state.scheduler.lock().await;
    scheduler.stop().await;
    scheduler::reset_runtime(&state.runtime_status).await;
    let snapshot = state.runtime_status.read().await.clone();
    tray::refresh_tray(&app, snapshot)?;
    Ok(())
}

pub async fn warmup_all_internal(app: tauri::AppHandle) -> Result<(), String> {
    info!("warmup all keys requested");
    let state = app.state::<SharedState>();
    let config = state.config.read().await.clone();
    let client = api_client::ApiClient::new(Some(app.clone()))?;

    for slot_cfg in &config.slots {
        if !slot_cfg.enabled || slot_cfg.api_key.trim().is_empty() {
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let _ = env_logger::builder().is_test(false).try_init();

    tauri::Builder::default()
        .setup(|app| {
            let app_handle = app.handle().clone();

            tauri::async_runtime::block_on(async {
                let initial_config = match config::load_config(&app_handle).await {
                    Ok(cfg) => cfg,
                    Err(err) => {
                        error!("failed to load persisted config, using defaults: {}", err);
                        AppConfig::default()
                    }
                };

                app.manage(SharedState {
                    config: Arc::new(RwLock::new(initial_config)),
                    runtime_status: Arc::new(RwLock::new(RuntimeStatus::default())),
                    scheduler: Arc::new(Mutex::new(scheduler::SchedulerManager::new())),
                });
            });

            tray::setup_tray(&app_handle)?;

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
        .invoke_handler(tauri::generate_handler![
            load_settings,
            save_settings,
            start_monitoring,
            stop_monitoring,
            get_runtime_status,
            warmup_all,
            fetch_slot_stats
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
