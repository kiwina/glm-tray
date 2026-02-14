use std::path::PathBuf;

use log::{debug, info};
use tauri::{AppHandle, Manager};
use tokio::fs;

use crate::models::{AppConfig, KeySlotConfig, MAX_SLOTS};

const CONFIG_FILE_NAME: &str = "settings.json";

fn ensure_normalized(input: AppConfig) -> AppConfig {
    let mut normalized = input;

    if normalized.slots.len() > MAX_SLOTS {
        normalized.slots.truncate(MAX_SLOTS);
    }

    while normalized.slots.len() < MAX_SLOTS {
        normalized.slots.push(KeySlotConfig::default());
    }

    for (idx, slot) in normalized.slots.iter_mut().enumerate() {
        slot.slot = idx + 1;
        slot.poll_interval_minutes = slot.poll_interval_minutes.max(1);
        slot.wake_interval_minutes = slot.wake_interval_minutes.max(1);
        slot.wake_after_reset_minutes = slot.wake_after_reset_minutes.max(1);
        if slot.wake_times.len() > 5 {
            slot.wake_times.truncate(5);
        }
        slot.wake_times = slot
            .wake_times
            .iter()
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty())
            .collect();
        if slot.quota_url.trim().is_empty() {
            slot.quota_url = KeySlotConfig::default().quota_url;
        }
    }

    normalized
}

pub fn config_path(app: &AppHandle) -> Result<PathBuf, String> {
    let mut base = app
        .path()
        .app_config_dir()
        .map_err(|err| format!("failed to resolve app config dir: {err}"))?;
    base.push(CONFIG_FILE_NAME);
    Ok(base)
}

pub async fn load_config(app: &AppHandle) -> Result<AppConfig, String> {
    let path = config_path(app)?;

    if !path.exists() {
        info!("no config file at {}, using defaults", path.display());
        return Ok(AppConfig::default());
    }

    debug!("loading config from {}", path.display());

    let content = fs::read_to_string(&path)
        .await
        .map_err(|err| format!("failed to read config: {err}"))?;

    let parsed: AppConfig =
        serde_json::from_str(&content).map_err(|err| format!("invalid config JSON: {err}"))?;

    Ok(ensure_normalized(parsed))
}

pub async fn save_config(app: &AppHandle, input: AppConfig) -> Result<AppConfig, String> {
    let normalized = ensure_normalized(input);
    let path = config_path(app)?;

    info!("saving config to {}", path.display());

    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .await
            .map_err(|err| format!("failed to create config directory: {err}"))?;
    }

    let serialized = serde_json::to_string_pretty(&normalized)
        .map_err(|err| format!("failed to serialize config: {err}"))?;

    fs::write(path, serialized)
        .await
        .map_err(|err| format!("failed to write config: {err}"))?;

    Ok(normalized)
}
