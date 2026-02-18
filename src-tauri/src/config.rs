use std::path::PathBuf;

use log::{debug, info, warn};
use serde::Deserialize;
use tauri::{AppHandle, Manager};
use tokio::fs;

use crate::models::{AppConfig, KeySlotConfig, CURRENT_CONFIG_VERSION, MAX_SLOTS};

const CONFIG_FILE_NAME: &str = "settings.json";

/// Old v2 slot config format (for migration)
#[derive(Debug, Clone, Deserialize)]
#[allow(dead_code)]
struct SlotConfigV2 {
    slot: usize,
    name: String,
    enabled: bool,
    api_key: String,
    quota_url: String,
    request_url: Option<String>,
    wake_enabled: bool,
    wake_mode: String,
    wake_interval_enabled: bool,
    wake_times_enabled: bool,
    wake_after_reset_enabled: bool,
    wake_interval_minutes: u64,
    wake_times: Vec<String>,
    wake_after_reset_minutes: u64,
    poll_interval_minutes: u64,
    logging: bool,
}

/// Old v2 config format (for migration)
#[derive(Debug, Clone, Deserialize)]
struct AppConfigV2 {
    slots: Vec<SlotConfigV2>,
    theme: String,
    config_version: u32,
}

impl From<SlotConfigV2> for KeySlotConfig {
    fn from(old: SlotConfigV2) -> Self {
        Self {
            slot: old.slot,
            name: old.name,
            enabled: old.enabled,
            api_key: old.api_key,
            quota_url: old.quota_url,
            request_url: old.request_url,
            schedule_interval_enabled: old.wake_interval_enabled,
            schedule_times_enabled: old.wake_times_enabled,
            schedule_after_reset_enabled: old.wake_after_reset_enabled,
            schedule_interval_minutes: old.wake_interval_minutes,
            schedule_times: old.wake_times,
            schedule_after_reset_minutes: old.wake_after_reset_minutes,
            poll_interval_minutes: old.poll_interval_minutes,
            logging: old.logging,
        }
    }
}

impl From<AppConfigV2> for AppConfig {
    fn from(old: AppConfigV2) -> Self {
        Self {
            slots: old.slots.into_iter().map(|s| s.into()).collect(),
            theme: old.theme,
            config_version: old.config_version,
            global_quota_url: KeySlotConfig::default().quota_url,
            global_request_url: KeySlotConfig::default().request_url.unwrap_or_default(),
            log_directory: None,
            max_log_days: 7,
            wake_quota_retry_window_minutes: 15,
            max_consecutive_errors: 10,
            quota_poll_backoff_cap_minutes: 480,
            debug: false,
            mock_url: None,
        }
    }
}

/// Apply forward migrations from the persisted version to the current version.
/// Each migration step handles exactly one version bump.
fn migrate(raw_json: &str) -> Result<AppConfig, String> {
    // Try to parse as the current version first
    if let Ok(cfg) = serde_json::from_str::<AppConfig>(raw_json) {
        if cfg.config_version >= CURRENT_CONFIG_VERSION {
            return Ok(cfg);
        }
    }

    // Need to migrate - start with v2 format
    let mut cfg: AppConfig = if let Ok(v2) = serde_json::from_str::<AppConfigV2>(raw_json) {
        v2.into()
    } else {
        // Fallback: try to parse as current format (might be partially migrated)
        serde_json::from_str::<AppConfig>(raw_json)
            .map_err(|err| format!("invalid config JSON: {err}"))?
    };

    let from = cfg.config_version;

    // version 2 → 3: rename wake_* to schedule_*
    if from < 3 {
        info!("migrating config v{from} → v3 (rename wake_* to schedule_*)");
        cfg.config_version = 3;
    }

    if from != cfg.config_version && from > 0 {
        info!("config migrated from v{from} → v{}", cfg.config_version);
    }

    Ok(cfg)
}

/// Check if debug mode is enabled via environment variable
fn is_debug_mode() -> bool {
    std::env::var("GLM_TRAY_DEBUG")
        .map(|v| v == "1" || v.eq_ignore_ascii_case("true"))
        .unwrap_or(false)
}

/// Check if URL is valid (https:// always, or http:// in debug mode)
fn is_valid_url(url: &str) -> bool {
    if url.starts_with("https://") {
        return true;
    }
    if is_debug_mode() && url.starts_with("http://") {
        return true;
    }
    false
}

/// Clamp, trim, and sanitise every field so the rest of the app can trust it.
fn validate(mut cfg: AppConfig) -> AppConfig {
    let default_global_quota = cfg.global_quota_url.trim().to_string();
    let default_global_request = cfg.global_request_url.trim().to_string();

    if default_global_quota.is_empty() || !is_valid_url(&default_global_quota) {
        warn!(
            "config: invalid global_quota_url '{}', resetting to default",
            cfg.global_quota_url
        );
        cfg.global_quota_url = KeySlotConfig::default().quota_url;
    } else {
        cfg.global_quota_url = default_global_quota;
    }

    if default_global_request.is_empty() || !is_valid_url(&default_global_request) {
        warn!(
            "config: invalid global_request_url '{}', resetting to default",
            cfg.global_request_url
        );
        cfg.global_request_url = KeySlotConfig::default().request_url.unwrap_or_default();
    } else {
        cfg.global_request_url = default_global_request;
    }

    cfg.log_directory = cfg.log_directory.and_then(|path| {
        let trimmed = path.trim();
        if trimmed.is_empty() {
            None
        } else {
            Some(trimmed.to_string())
        }
    });
    cfg.max_log_days = cfg.max_log_days.clamp(1, 365);
    cfg.wake_quota_retry_window_minutes = cfg.wake_quota_retry_window_minutes.clamp(1, 1_440);
    cfg.max_consecutive_errors = cfg.max_consecutive_errors.clamp(1, 1_000);
    cfg.quota_poll_backoff_cap_minutes = cfg.quota_poll_backoff_cap_minutes.clamp(1, 1_440);

    // -- slot count --
    if cfg.slots.len() > MAX_SLOTS {
        warn!("config: truncating {} slots → {MAX_SLOTS}", cfg.slots.len());
        cfg.slots.truncate(MAX_SLOTS);
    }
    while cfg.slots.len() < MAX_SLOTS {
        cfg.slots.push(KeySlotConfig::default());
    }

    for (idx, slot) in cfg.slots.iter_mut().enumerate() {
        slot.slot = idx + 1;

        // -- name: trim, cap at 32 chars --
        slot.name = slot.name.trim().chars().take(32).collect();

        // -- api_key: trim whitespace (no length cap – keys vary by platform) --
        slot.api_key = slot.api_key.trim().to_string();

        // -- URLs: must be valid (https://, or http:// in debug mode) or fall back to defaults --
        if !is_valid_url(&slot.quota_url) {
            if !slot.quota_url.trim().is_empty() {
                warn!("slot {}: invalid quota_url '{}', resetting to default", slot.slot, slot.quota_url);
            }
            slot.quota_url = cfg.global_quota_url.clone();
        }
        if let Some(ref url) = slot.request_url {
            if !is_valid_url(url) {
                warn!("slot {}: invalid request_url '{}', resetting to default", slot.slot, url);
                slot.request_url = Some(cfg.global_request_url.clone());
            }
        } else {
            slot.request_url = Some(cfg.global_request_url.clone());
        }

        // -- interval bounds (min 1, max 1440 = 24 h) --
        slot.poll_interval_minutes = slot.poll_interval_minutes.clamp(1, 1440);
        slot.schedule_interval_minutes = slot.schedule_interval_minutes.clamp(1, 1440);
        slot.schedule_after_reset_minutes = slot.schedule_after_reset_minutes.clamp(1, 1440);

        // -- schedule_times: max 5 entries, trim, drop blanks, validate HH:MM --
        if slot.schedule_times.len() > 5 {
            slot.schedule_times.truncate(5);
        }
        slot.schedule_times = slot
            .schedule_times
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
                    warn!("slot {}: dropping invalid schedule_time '{v}'", slot.slot);
                }
                valid
            })
            .collect();

        // -- if key is blank, disable polling for safety --
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

    let migrated = migrate(&content)?;
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
