use chrono::Local;
use serde::Serialize;
use std::path::PathBuf;
use tokio::fs;
use tokio::io::AsyncWriteExt;

/// A single JSONL log entry written to the daily log file.
#[derive(Serialize)]
pub struct LogEntry {
    pub ts: String,
    pub slot: usize,
    pub action: String,
    pub method: String,
    pub url: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub request_body: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status: Option<u16>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub response_body: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// Returns the log directory inside `app_config_dir()/logs/`.
fn log_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    use tauri::Manager;
    let mut base = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("failed to resolve app config dir: {e}"))?;
    base.push("logs");
    Ok(base)
}

/// Appends a `LogEntry` as one JSONL line to `logs/YYYY-MM-DD.jsonl`.
pub async fn append(app: &tauri::AppHandle, entry: LogEntry) -> Result<(), String> {
    let dir = log_dir(app)?;
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

/// Convenience: build a LogEntry for a request.
pub fn request_entry(
    slot: usize,
    action: &str,
    method: &str,
    url: &str,
    body: Option<serde_json::Value>,
) -> LogEntry {
    LogEntry {
        ts: Local::now().to_rfc3339(),
        slot,
        action: action.to_string(),
        method: method.to_string(),
        url: url.to_string(),
        request_body: body,
        status: None,
        response_body: None,
        error: None,
    }
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
    LogEntry {
        ts: Local::now().to_rfc3339(),
        slot,
        action: action.to_string(),
        method: method.to_string(),
        url: url.to_string(),
        request_body: None,
        status: Some(status),
        response_body: body,
        error: None,
    }
}

/// Convenience: build a LogEntry for an error.
pub fn error_entry(
    slot: usize,
    action: &str,
    method: &str,
    url: &str,
    error: &str,
) -> LogEntry {
    LogEntry {
        ts: Local::now().to_rfc3339(),
        slot,
        action: action.to_string(),
        method: method.to_string(),
        url: url.to_string(),
        request_body: None,
        status: None,
        response_body: None,
        error: Some(error.to_string()),
    }
}
