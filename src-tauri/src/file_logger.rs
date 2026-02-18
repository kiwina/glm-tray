use chrono::{Local, NaiveDateTime, TimeZone};
use log::info;
use serde::Serialize;
use serde_json::Value;
use std::path::PathBuf;
use tokio::fs;
use tokio::io::AsyncWriteExt;

/// Default number of days to keep log files.
const DEFAULT_MAX_LOG_DAYS: i64 = 7;

struct LoggerConfig {
    dir: PathBuf,
    max_days: i64,
}

/// A single JSONL log entry written to the daily log file.
#[derive(Serialize)]
pub struct LogEntry {
    pub ts: String,
    pub slot: usize,
    pub action: String,
    pub method: String,
    pub url: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub flow_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub phase: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub request_body: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status: Option<u16>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub response_body: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub details: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub duration_ms: Option<u64>,
}

/// Returns effective logger config using user overrides from config.
async fn logger_config(app: &tauri::AppHandle) -> Result<LoggerConfig, String> {
    use tauri::Manager;
    let mut dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("failed to resolve app config dir: {e}"))?;
    let mut max_days = DEFAULT_MAX_LOG_DAYS;

    if let Some(state) = app.try_state::<crate::SharedState>() {
        let cfg = state.config.read().await;
        if let Some(path) = cfg.log_directory.as_ref() {
            let trimmed = path.trim();
            if !trimmed.is_empty() {
                dir = PathBuf::from(trimmed);
            }
        }
        if cfg.max_log_days > 0 {
            max_days = cfg.max_log_days as i64;
        }
    }

    if max_days <= 0 {
        max_days = DEFAULT_MAX_LOG_DAYS;
    }

    dir.push("logs");
    Ok(LoggerConfig { dir, max_days })
}

/// Deletes log files older than configured retention.
pub async fn cleanup_old_logs(app: &tauri::AppHandle) {
    let config = match logger_config(app).await {
        Ok(d) => d,
        Err(_) => return,
    };
    let dir = config.dir;
    let max_days = config.max_days;
    if max_days <= 0 {
        return;
    }

    let mut entries = match fs::read_dir(&dir).await {
        Ok(e) => e,
        Err(_) => return,
    };

    let cutoff = Local::now() - chrono::Duration::days(max_days);

    while let Ok(Some(entry)) = entries.next_entry().await {
        let path = entry.path();
        if path.extension().map_or(false, |ext| ext == "jsonl") {
            if let Some(stem) = path.file_stem().and_then(|s| s.to_str()) {
                if let Ok(naive) = NaiveDateTime::parse_from_str(&format!("{stem} 00:00:00"), "%Y-%m-%d %H:%M:%S") {
                    if let Some(file_date) = Local.from_local_datetime(&naive).single() {
                        if file_date < cutoff {
                            match fs::remove_file(&path).await {
                                Ok(()) => info!("deleted old log file: {}", path.display()),
                                Err(e) => info!("failed to delete old log {}: {}", path.display(), e),
                            }
                        }
                    }
                }
            }
        }
    }
}

/// Appends a `LogEntry` as one JSONL line to `logs/YYYY-MM-DD.jsonl`.
pub async fn append(app: &tauri::AppHandle, entry: LogEntry) -> Result<(), String> {
    let config = logger_config(app).await?;
    let dir = config.dir;
    fs::create_dir_all(&dir)
        .await
        .map_err(|e| format!("create log dir: {e}"))?;

    let date = Local::now().format("%Y-%m-%d").to_string();
    let path = dir.join(format!("{date}.jsonl"));

    let mut line =
        serde_json::to_string(&entry).map_err(|e| format!("serialize log entry: {e}"))?;
    line.push('\n');

    let mut file = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .await
        .map_err(|e| format!("open log file: {e}"))?;

    file.write_all(line.as_bytes())
        .await
        .map_err(|e| format!("write log entry: {e}"))?;

    Ok(())
}

fn request_entry_internal(
    slot: usize,
    action: &str,
    method: &str,
    url: &str,
    request_body: Option<serde_json::Value>,
    response_body: Option<serde_json::Value>,
    status: Option<u16>,
    error: Option<String>,
    details: Option<Value>,
    duration_ms: Option<u64>,
    flow_id: Option<String>,
    phase: Option<String>,
) -> LogEntry {
    LogEntry {
        ts: Local::now().to_rfc3339(),
        slot,
        action: action.to_string(),
        method: method.to_string(),
        url: url.to_string(),
        flow_id,
        phase,
        request_body,
        status,
        response_body,
        error,
        details,
        duration_ms,
    }
}

/// Convenience: build a LogEntry for a request.
pub fn request_entry(
    slot: usize,
    action: &str,
    method: &str,
    url: &str,
    body: Option<serde_json::Value>,
) -> LogEntry {
    request_entry_internal(slot, action, method, url, body, None, None, None, None, None, None, Some("request".to_string()))
}

/// Convenience: build a LogEntry for a request with a flow id.
pub fn request_entry_with_id(
    slot: usize,
    action: &str,
    method: &str,
    url: &str,
    body: Option<serde_json::Value>,
    flow_id: String,
) -> LogEntry {
    request_entry_internal(
        slot,
        action,
        method,
        url,
        body,
        None,
        None,
        None,
        None,
        None,
        Some(flow_id),
        Some("request".to_string()),
    )
}

/// Convenience: build a LogEntry for a response.
pub fn response_entry(
    slot: usize,
    action: &str,
    method: &str,
    url: &str,
    status: u16,
    body: Option<serde_json::Value>,
) -> LogEntry {
    response_entry_internal(slot, action, method, url, status, body, None, None)
}

/// Convenience: build a LogEntry for a response with timing metadata and flow id.
pub fn response_entry_with_timing_and_id(
    slot: usize,
    action: &str,
    method: &str,
    url: &str,
    status: u16,
    body: Option<serde_json::Value>,
    duration_ms: u64,
    flow_id: String,
) -> LogEntry {
    response_entry_internal(
        slot,
        action,
        method,
        url,
        status,
        body,
        Some(flow_id),
        Some(duration_ms),
    )
}

/// Convenience: build a LogEntry for an error.
pub fn error_entry(
    slot: usize,
    action: &str,
    method: &str,
    url: &str,
    error: &str,
) -> LogEntry {
    request_entry_internal(
        slot,
        action,
        method,
        url,
        None,
        None,
        None,
        Some(error.to_string()),
        None,
        None,
        None,
        Some("error".to_string()),
    )
}

/// Convenience: build a LogEntry for an error with details and flow id.
pub fn error_entry_with_id(
    slot: usize,
    action: &str,
    method: &str,
    url: &str,
    error: &str,
    flow_id: String,
) -> LogEntry {
    request_entry_internal(
        slot,
        action,
        method,
        url,
        None,
        None,
        None,
        Some(error.to_string()),
        None,
        None,
        Some(flow_id),
        Some("error".to_string()),
    )
}

/// Convenience: build a LogEntry for internal scheduler/runtime events.
pub fn event_entry(
    slot: usize,
    action: &str,
    details: Option<Value>,
) -> LogEntry {
    request_entry_internal(
        slot,
        action,
        "INTERNAL",
        "internal://glm-tray",
        None,
        None,
        None,
        None,
        details,
        None,
        None,
        Some("event".to_string()),
    )
}

fn response_entry_internal(
    slot: usize,
    action: &str,
    method: &str,
    url: &str,
    status: u16,
    body: Option<serde_json::Value>,
    flow_id: Option<String>,
    duration_ms: Option<u64>,
) -> LogEntry {
    request_entry_internal(
        slot,
        action,
        method,
        url,
        None,
        body,
        Some(status),
        None,
        None,
        duration_ms,
        flow_id,
        Some("response".to_string()),
    )
}
