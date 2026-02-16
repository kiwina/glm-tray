use std::path::PathBuf;

use log::{debug, info, warn};
use tauri::{AppHandle, Manager};
use tokio::fs;

use crate::models::{AppConfig, KeySlotConfig, WakeMode, CURRENT_CONFIG_VERSION, MAX_SLOTS};

const CONFIG_FILE_NAME: &str = "settings.json";

/// Apply forward migrations from the persisted version to the current version.
/// Each migration step handles exactly one version bump.
fn migrate(mut cfg: AppConfig) -> AppConfig {
    let from = cfg.config_version;

    // version 0 → 1: initial versioned schema (no structural changes, just stamp)
    if cfg.config_version < 1 {
        info!("migrating config v0 → v1 (adding version stamp)");
        cfg.config_version = 1;
    }

    // version 1 → 2: separate enabled flags per wake mode
    if cfg.config_version < 2 {
        info!("migrating config v1 → v2 (separate wake mode enabled flags)");
        for slot in &mut cfg.slots {
            // If wake was enabled, enable the corresponding mode's flag
            if slot.wake_enabled {
                match slot.wake_mode {
                    WakeMode::Interval => slot.wake_interval_enabled = true,
                    WakeMode::Times => slot.wake_times_enabled = true,
                    WakeMode::AfterReset => slot.wake_after_reset_enabled = true,
                }
            }
        }
        cfg.config_version = 2;
    }

    if from != cfg.config_version {
        info!("config migrated from v{from} → v{}", cfg.config_version);
    }

    cfg
}

/// Clamp, trim, and sanitise every field so the rest of the app can trust it.
fn validate(mut cfg: AppConfig) -> AppConfig {
    // -- slot count --
    if cfg.slots.len() > MAX_SLOTS {
        warn!("config: truncating {} slots → {MAX_SLOTS}", cfg.slots.len());
        cfg.slots.truncate(MAX_SLOTS);
    }
    while cfg.slots.len() < MAX_SLOTS {
        cfg.slots.push(KeySlotConfig::default());
    }

    let defaults = KeySlotConfig::default();

    for (idx, slot) in cfg.slots.iter_mut().enumerate() {
        slot.slot = idx + 1;

        // -- name: trim, cap at 32 chars --
        slot.name = slot.name.trim().chars().take(32).collect();

        // -- api_key: trim whitespace (no length cap – keys vary by platform) --
        slot.api_key = slot.api_key.trim().to_string();

        // -- URLs: must start with https:// or fall back to defaults --
        if !slot.quota_url.starts_with("https://") {
            if !slot.quota_url.trim().is_empty() {
                warn!("slot {}: invalid quota_url '{}', resetting to default", slot.slot, slot.quota_url);
            }
            slot.quota_url = defaults.quota_url.clone();
        }
        if let Some(ref url) = slot.request_url {
            if !url.starts_with("https://") {
                warn!("slot {}: invalid request_url '{}', resetting to default", slot.slot, url);
                slot.request_url = defaults.request_url.clone();
            }
        }

        // -- interval bounds (min 1, max 1440 = 24 h) --
        slot.poll_interval_minutes = slot.poll_interval_minutes.clamp(1, 1440);
        slot.wake_interval_minutes = slot.wake_interval_minutes.clamp(1, 1440);
        slot.wake_after_reset_minutes = slot.wake_after_reset_minutes.clamp(1, 1440);

        // -- wake_times: max 5 entries, trim, drop blanks, validate HH:MM --
        if slot.wake_times.len() > 5 {
            slot.wake_times.truncate(5);
        }
        slot.wake_times = slot
            .wake_times
            .iter()
            .map(|v| v.trim().to_string())
            .filter(|v| {
                if v.is_empty() {
                    return false;
                }
                // accept HH:MM (00:00 – 23:59)
                let valid = v.len() == 5
                    && v.as_bytes()[2] == b':'
                    && v[..2].parse::<u8>().map_or(false, |h| h < 24)
                    && v[3..].parse::<u8>().map_or(false, |m| m < 60);
                if !valid {
                    warn!("slot {}: dropping invalid wake_time '{v}'", slot.slot);
                }
                valid
            })
            .collect();

        // -- if key is blank, disable polling + wake for safety --
        if slot.api_key.is_empty() && slot.enabled {
            warn!("slot {}: no API key, force-disabling", slot.slot);
            slot.enabled = false;
        }
    }

    // stamp current version
    cfg.config_version = CURRENT_CONFIG_VERSION;
    cfg
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

    let migrated = migrate(parsed);
    let validated = validate(migrated);

    // Re-save if migration or validation changed anything
    if validated.config_version != 0 {
        // always persist after load so the file reflects the latest schema
        let serialized = serde_json::to_string_pretty(&validated)
            .map_err(|err| format!("failed to serialize config: {err}"))?;
        if let Some(parent) = path.parent() {
            let _ = fs::create_dir_all(parent).await;
        }
        let _ = fs::write(&path, serialized).await;
    }

    Ok(validated)
}

pub async fn save_config(app: &AppHandle, input: AppConfig) -> Result<AppConfig, String> {
    let validated = validate(input);
    let path = config_path(app)?;

    info!("saving config to {}", path.display());

    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .await
            .map_err(|err| format!("failed to create config directory: {err}"))?;
    }

    let serialized = serde_json::to_string_pretty(&validated)
        .map_err(|err| format!("failed to serialize config: {err}"))?;

    fs::write(path, serialized)
        .await
        .map_err(|err| format!("failed to write config: {err}"))?;

    Ok(validated)
}
