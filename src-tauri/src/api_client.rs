use chrono::{Local, TimeZone};
use log::{debug, info, warn};
use reqwest::header::{ACCEPT_LANGUAGE, AUTHORIZATION, CONTENT_TYPE};
use std::time::Instant;
use std::sync::atomic::{AtomicU64, Ordering};
use serde_json::json;

use crate::file_logger;
use crate::models::{KeySlotConfig, QuotaApiResponse, QuotaApiResponseFull, QuotaSnapshot,
    ModelUsageApiResponse, ToolUsageApiResponse, SlotStats, LimitInfo, UsageDetailInfo};

static FLOW_SEQUENCE: AtomicU64 = AtomicU64::new(1);

/// Check if debug mode is enabled from config
fn is_debug_mode(config_debug: Option<bool>) -> bool {
    config_debug.unwrap_or(false)
}

/// Get the mock server base URL from config
fn mock_base_url(config_mock_url: Option<&str>) -> String {
    if let Some(url) = config_mock_url {
        if !url.is_empty() {
            return url.to_string();
        }
    }
    "http://localhost:3456".to_string()
}

/// Override URL to mock server if debug mode is enabled
fn debug_url(url: &str, config_debug: Option<bool>, config_mock_url: Option<&str>) -> String {
    if !is_debug_mode(config_debug) {
        return url.to_string();
    }

    // Replace the base URL with mock server
    let base = mock_base_url(config_mock_url);

    // Extract the path from the original URL
    if let Ok(parsed) = reqwest::Url::parse(url) {
        let path = parsed.path();
        format!("{}{}", base, path)
    } else {
        warn!("debug mode: failed to parse URL '{}', using as-is", url);
        url.to_string()
    }
}

#[derive(Clone)]
pub struct ApiClient {
    client: reqwest::Client,
    app: Option<tauri::AppHandle>,
    debug: bool,
    mock_url: Option<String>,
}

impl ApiClient {
    pub fn new(app: Option<tauri::AppHandle>, debug: bool, mock_url: Option<String>) -> Result<Self, String> {
        let mut builder = reqwest::Client::builder()
            .connect_timeout(std::time::Duration::from_secs(5))
            .timeout(std::time::Duration::from_secs(15));

        // In debug mode (or if mock_url is localhost), accept invalid certs for localhost testing
        let is_debug = debug || mock_url.as_ref().map_or(false, |u| u.contains("localhost") || u.starts_with("http://"));
        if is_debug {
            warn!("debug mode enabled - accepting invalid certificates");
            builder = builder.danger_accept_invalid_certs(true);
        }

        let client = builder
            .build()
            .map_err(|err| format!("failed to create HTTP client: {err}"))?;

        if is_debug {
            info!("API client initialized in debug mode");
        }

        Ok(Self { client, app, debug, mock_url })
    }

    fn auth_header(api_key: &str) -> String {
        if api_key.trim_start().starts_with("Bearer ") {
            api_key.trim().to_string()
        } else {
            format!("Bearer {}", api_key.trim())
        }
    }

    /// Log to JSONL file if logging is enabled and an app handle is available.
    async fn log(&self, cfg: &KeySlotConfig, entry: file_logger::LogEntry) {
        if !cfg.logging {
            return;
        }
        if let Some(app) = &self.app {
            let _ = file_logger::append(app, entry).await;
        }
    }

    fn next_flow_id(&self, cfg: &KeySlotConfig, action: &str) -> String {
        let seq = FLOW_SEQUENCE.fetch_add(1, Ordering::SeqCst);
        let ts = Local::now().timestamp_millis();
        format!("{ts}_{action}_slot{}_{}", cfg.slot, seq)
    }

    pub async fn warmup_key(&self, cfg: &KeySlotConfig) -> Result<(), String> {
        let Some(original_url) = cfg.request_url.clone() else {
            return Err("no request URL configured".to_string());
        };

        // Apply debug URL transformation if enabled
        let url = debug_url(&original_url, Some(self.debug), self.mock_url.as_deref());

        let body = json!({
            "model": "glm-5",
            "messages": [
                { "role": "system", "content": "You are a helpful assistant." },
                { "role": "user", "content": "ping" }
            ]
        });

        info!("slot {}: sending warmup request to {}", cfg.slot, url);
        let flow_id = self.next_flow_id(cfg, "manual-warmup");
        self.log(
            cfg,
            file_logger::request_entry_with_id(
                cfg.slot,
                "manual-warmup",
                "POST",
                &url,
                Some(body.clone()),
                flow_id.clone(),
            ),
        )
        .await;
        let start = Instant::now();

        let response = match self
            .client
            .post(&url)
            .header(AUTHORIZATION, Self::auth_header(&cfg.api_key))
            .header(ACCEPT_LANGUAGE, "en-US")
            .header(CONTENT_TYPE, "application/json")
            .json(&body)
            .send()
            .await
        {
            Ok(response) => response,
            Err(err) => {
                let msg = format!("warmup request failed: {err}");
                self.log(
                    cfg,
                    file_logger::error_entry_with_id(
                        cfg.slot,
                        "manual-warmup",
                        "POST",
                        &url,
                        &msg,
                        flow_id,
                    ),
                )
                .await;
                return Err(msg);
            }
        };

        let status = response.status();
        let elapsed = start.elapsed().as_millis() as u64;
        self.log(
            cfg,
            file_logger::response_entry_with_timing_and_id(
                cfg.slot,
                "manual-warmup",
                "POST",
                &url,
                status.as_u16(),
                None,
                elapsed,
                flow_id.clone(),
            ),
        )
        .await;

        if !status.is_success() {
            let msg = format!("warmup HTTP error: {}", status);
            self.log(
                cfg,
                file_logger::error_entry_with_id(
                    cfg.slot,
                    "manual-warmup",
                    "POST",
                    &url,
                    &msg,
                    flow_id,
                ),
            )
            .await;
            return Err(msg);
        }

        info!("slot {}: warmup request succeeded", cfg.slot);
        Ok(())
    }

    pub async fn send_wake_request(&self, cfg: &KeySlotConfig) -> Result<(), String> {
        let Some(original_url) = cfg.request_url.clone() else {
            return Ok(());
        };

        // Apply debug URL transformation if enabled
        let url = debug_url(&original_url, Some(self.debug), self.mock_url.as_deref());

        let body = json!({
            "model": "glm-5",
            "messages": [
                { "role": "system", "content": "You are a helpful assistant." },
                { "role": "user", "content": "ping" }
            ]
        });

        info!("slot {}: sending scheduled wake request to {}", cfg.slot, url);
        let flow_id = self.next_flow_id(cfg, "scheduled-wake");
        self.log(
            cfg,
            file_logger::request_entry_with_id(
                cfg.slot,
                "scheduled-wake",
                "POST",
                &url,
                Some(body.clone()),
                flow_id.clone(),
            ),
        )
        .await;
        let start = Instant::now();

        let response = match self
            .client
            .post(&url)
            .header(AUTHORIZATION, Self::auth_header(&cfg.api_key))
            .header(ACCEPT_LANGUAGE, "en-US")
            .header(CONTENT_TYPE, "application/json")
            .json(&body)
            .send()
            .await
        {
            Ok(response) => response,
            Err(err) => {
                let msg = format!("wake request failed: {err}");
                let elapsed = start.elapsed().as_millis() as u64;
                let _ = elapsed;
                self.log(
                    cfg,
                    file_logger::error_entry_with_id(
                        cfg.slot,
                        "scheduled-wake",
                        "POST",
                        &url,
                        &msg,
                        flow_id,
                    ),
                )
                .await;
                return Err(msg);
            }
        };

        let status = response.status();
        let elapsed = start.elapsed().as_millis() as u64;
        self.log(
            cfg,
            file_logger::response_entry_with_timing_and_id(
                cfg.slot,
                "scheduled-wake",
                "POST",
                &url,
                status.as_u16(),
                None,
                elapsed,
                flow_id.clone(),
            ),
        )
        .await;

        if !status.is_success() {
            let msg = format!("wake HTTP error: {}", status);
            self.log(
                cfg,
                file_logger::error_entry_with_id(
                    cfg.slot,
                    "scheduled-wake",
                    "POST",
                    &url,
                    &msg,
                    flow_id,
                ),
            )
            .await;
            return Err(msg);
        }

        info!("slot {}: wake request succeeded", cfg.slot);
        Ok(())
    }

    pub async fn fetch_quota(&self, cfg: &KeySlotConfig) -> Result<QuotaSnapshot, String> {
        // Apply debug URL transformation if enabled
        let url = debug_url(&cfg.quota_url, Some(self.debug), self.mock_url.as_deref());

        debug!("slot {}: fetching quota from {}", cfg.slot, url);
        let flow_id = self.next_flow_id(cfg, "background-quota-poll");
        self.log(
            cfg,
            file_logger::request_entry_with_id(
                cfg.slot,
                "background-quota-poll",
                "GET",
                &url,
                None,
                flow_id.clone(),
            ),
        )
        .await;
        let start = Instant::now();

        let req = self
            .client
            .get(&url)
            .header(AUTHORIZATION, Self::auth_header(&cfg.api_key))
            .header(ACCEPT_LANGUAGE, "en-US")
            .header(CONTENT_TYPE, "application/json");

        let response = match req.send().await {
            Ok(response) => response,
            Err(err) => {
                let msg = format!("quota request failed: {err}");
                self.log(
                    cfg,
                    file_logger::error_entry_with_id(
                        cfg.slot,
                        "background-quota-poll",
                        "GET",
                        &url,
                        &msg,
                        flow_id,
                    ),
                )
                .await;
                return Err(msg);
            }
        };

        let status = response.status();

        if !status.is_success() {
            let msg = format!("quota HTTP error: {}", status);
            self.log(
                cfg,
                file_logger::error_entry_with_id(
                    cfg.slot,
                    "background-quota-poll",
                    "GET",
                    &url,
                    &msg,
                    flow_id,
                ),
            )
            .await;
            return Err(msg);
        }

        let raw_text = response
            .text()
            .await
            .map_err(|err| format!("failed to read quota response: {err}"))?;

        let resp_json: Option<serde_json::Value> = serde_json::from_str(&raw_text).ok();
        let elapsed = start.elapsed().as_millis() as u64;
        self.log(
            cfg,
            file_logger::response_entry_with_timing_and_id(
                cfg.slot,
                "background-quota-poll",
                "GET",
                &url,
                status.as_u16(),
                resp_json,
                elapsed,
                flow_id.clone(),
            ),
        )
        .await;

        let payload: QuotaApiResponse = match serde_json::from_str(&raw_text) {
            Ok(payload) => payload,
            Err(err) => {
                let msg = format!("invalid quota JSON response: {err}");
                self.log(
                    cfg,
                    file_logger::error_entry_with_id(
                        cfg.slot,
                        "background-quota-poll",
                        "GET",
                        &url,
                        &msg,
                        flow_id,
                    ),
                )
                .await;
                return Err(msg);
            }
        };

        if payload.code != 200 {
            let msg = format!("quota API code {}", payload.code);
            self.log(
                cfg,
                file_logger::error_entry_with_id(
                    cfg.slot,
                    "background-quota-poll",
                    "GET",
                    &url,
                    &msg,
                    flow_id.clone(),
                ),
            )
            .await;
            return Err(msg);
        }

        let limits = match payload.data {
            Some(value) => value.limits,
            None => {
                let msg = "quota response missing data".to_string();
                self.log(
                    cfg,
                    file_logger::error_entry_with_id(
                        cfg.slot,
                        "background-quota-poll",
                        "GET",
                        &url,
                        &msg,
                        flow_id.clone(),
                    ),
                )
                .await;
                return Err(msg);
            }
        };

        if limits.is_empty() {
            let msg = "quota limits missing".to_string();
            self.log(
                cfg,
                file_logger::error_entry_with_id(
                    cfg.slot,
                    "background-quota-poll",
                    "GET",
                    &url,
                    &msg,
                    flow_id.clone(),
                ),
            )
            .await;
            return Err(msg);
        }

        let selected = limits
            .iter()
            .find(|limit| limit.r#type == "TOKENS_LIMIT")
            .or_else(|| limits.first())
            .ok_or_else(|| "quota limits missing".to_string())?;

        let timer_active = selected.next_reset_time.is_some();

        let (hms, epoch) = match selected.next_reset_time {
            Some(ts) if ts > 0 => {
                let h = Local
                    .timestamp_millis_opt(ts)
                    .single()
                    .map(|dt| dt.format("%H:%M:%S").to_string());
                (h, Some(ts))
            }
            _ => (None, None),
        };

        debug!(
            "slot {}: quota={}%, timer_active={}, reset={}",
            cfg.slot,
            selected.percentage,
            timer_active,
            hms.as_deref().unwrap_or("none")
        );

        Ok(QuotaSnapshot {
            percentage: selected.percentage,
            timer_active,
            next_reset_hms: hms,
            next_reset_epoch_ms: epoch,
        })
    }

    pub async fn fetch_slot_stats(&self, cfg: &KeySlotConfig) -> Result<SlotStats, String> {
        let auth = Self::auth_header(&cfg.api_key);

        // Apply debug URL transformation if enabled
        let quota_url = debug_url(&cfg.quota_url, Some(self.debug), self.mock_url.as_deref());

        // 1. Fetch full quota/limit
        self.log(cfg, file_logger::request_entry(cfg.slot, "manual-stats-request", "GET", &quota_url, None)).await;
        let quota_resp = self
            .client
            .get(&quota_url)
            .header(AUTHORIZATION, auth.clone())
            .header(ACCEPT_LANGUAGE, "en-US")
            .header(CONTENT_TYPE, "application/json")
            .send()
            .await
            .map_err(|e| format!("quota request failed: {e}"))?;

        if !quota_resp.status().is_success() {
            let msg = format!("quota HTTP error: {}", quota_resp.status());
            self.log(cfg, file_logger::error_entry(cfg.slot, "manual-stats-request", "GET", &quota_url, &msg)).await;
            return Err(msg);
        }

        let quota_text = quota_resp.text().await.map_err(|e| format!("read quota: {e}"))?;
        let resp_json: Option<serde_json::Value> = serde_json::from_str(&quota_text).ok();
        self.log(cfg, file_logger::response_entry(cfg.slot, "manual-stats-request", "GET", &quota_url, 200, resp_json)).await;
        let quota_parsed: QuotaApiResponseFull =
            serde_json::from_str(&quota_text).map_err(|e| format!("parse quota: {e}"))?;

        let quota_data = quota_parsed.data.ok_or("quota missing data")?;
        let level = quota_data.level.unwrap_or_else(|| "unknown".into());

        let limits: Vec<LimitInfo> = quota_data
            .limits
            .iter()
            .map(|l| {
                // Format reset time based on unit:
                // 1=seconds, 2=minutes, 3=hours → HH:MM:SS
                // 4=days, 5=months, 6=years → "Jan 31" date format
                let reset_display = l.next_reset_time.and_then(|ts| {
                    if ts > 0 {
                        Local.timestamp_millis_opt(ts).single().map(|dt| {
                            let unit = l.unit.unwrap_or(3);
                            if unit <= 3 {
                                // Hours or less → show time
                                dt.format("%H:%M:%S").to_string()
                            } else {
                                // Days/months/years → show date
                                dt.format("%b %d").to_string()
                            }
                        })
                    } else {
                        None
                    }
                });
                LimitInfo {
                    type_name: l.r#type.clone(),
                    percentage: l.percentage,
                    unit: l.unit,
                    usage: l.usage,
                    current_value: l.current_value,
                    remaining: l.remaining,
                    next_reset_time: l.next_reset_time,
                    next_reset_hms: reset_display,
                    usage_details: l.usage_details.iter().map(|d| UsageDetailInfo {
                        model_code: d.model_code.clone(),
                        usage: d.usage,
                    }).collect(),
                }
            })
            .collect();

        // 2. Derive base URL for model-usage / tool-usage and calculate time ranges
        let base = quota_url.trim_end_matches("/quota/limit");
        let now = Local::now();
        let start_24h = (now - chrono::Duration::hours(24)).format("%Y-%m-%d %H:%M:%S").to_string();
        let end = now.format("%Y-%m-%d %H:%M:%S").to_string();

        // For 5h window, use the TOKENS_LIMIT reset time if available
        // The 5h window is the 5 hours leading up to the next reset
        let tokens_limit = quota_data.limits.iter().find(|l| l.r#type == "TOKENS_LIMIT");
        let reset_time = tokens_limit.and_then(|l| l.next_reset_time);
        let (start_5h, end_5h) = if let Some(reset_ts) = reset_time {
            if reset_ts > 0 {
                let reset_dt = Local.timestamp_millis_opt(reset_ts).single().unwrap_or(now);
                let start = (reset_dt - chrono::Duration::hours(5)).format("%Y-%m-%d %H:%M:%S").to_string();
                let end = reset_dt.format("%Y-%m-%d %H:%M:%S").to_string();
                (start, end)
            } else {
                ((now - chrono::Duration::hours(5)).format("%Y-%m-%d %H:%M:%S").to_string(),
                 now.format("%Y-%m-%d %H:%M:%S").to_string())
            }
        } else {
            ((now - chrono::Duration::hours(5)).format("%Y-%m-%d %H:%M:%S").to_string(),
             now.format("%Y-%m-%d %H:%M:%S").to_string())
        };

        // 3. Fetch model-usage for 24h window (best effort)
        let (total_model_calls_24h, total_tokens_24h) = {
            let url = format!("{}/model-usage?startTime={}&endTime={}", base,
                urlencoding::encode(&start_24h), urlencoding::encode(&end));
            self.log(cfg, file_logger::request_entry(cfg.slot, "manual-model-usage-24h", "GET", &url, None)).await;
            match self.client.get(&url)
                .header(AUTHORIZATION, auth.clone())
                .header(ACCEPT_LANGUAGE, "en-US")
                .header(CONTENT_TYPE, "application/json")
                .send().await
            {
                Ok(resp) if resp.status().is_success() => {
                    let status = resp.status().as_u16();
                    let text = resp.text().await.unwrap_or_default();
                    let resp_json: Option<serde_json::Value> = serde_json::from_str(&text).ok();
                    self.log(cfg, file_logger::response_entry(cfg.slot, "manual-model-usage-24h", "GET", &url, status, resp_json)).await;
                    let parsed: Result<ModelUsageApiResponse, _> = serde_json::from_str(&text);
                    match parsed {
                        Ok(r) if r.code == 200 => {
                            let t = r.data.and_then(|d| d.total_usage);
                            (t.as_ref().map_or(0, |u| u.total_model_call_count),
                             t.as_ref().map_or(0, |u| u.total_tokens_usage))
                        }
                        _ => (0, 0),
                    }
                }
                Ok(resp) => {
                    let msg = format!("model-usage-24h HTTP error: {}", resp.status());
                    self.log(cfg, file_logger::error_entry(cfg.slot, "manual-model-usage-24h", "GET", &url, &msg)).await;
                    (0, 0)
                }
                Err(e) => {
                    self.log(cfg, file_logger::error_entry(cfg.slot, "manual-model-usage-24h", "GET", &url, &e.to_string())).await;
                    (0, 0)
                }
            }
        };

        // 3b. Fetch model-usage for 5h window (best effort)
        let (total_model_calls_5h, total_tokens_5h) = {
            let url = format!("{}/model-usage?startTime={}&endTime={}", base,
                urlencoding::encode(&start_5h), urlencoding::encode(&end_5h));
            self.log(cfg, file_logger::request_entry(cfg.slot, "manual-model-usage-5h", "GET", &url, None)).await;
            match self.client.get(&url)
                .header(AUTHORIZATION, auth.clone())
                .header(ACCEPT_LANGUAGE, "en-US")
                .header(CONTENT_TYPE, "application/json")
                .send().await
            {
                Ok(resp) if resp.status().is_success() => {
                    let status = resp.status().as_u16();
                    let text = resp.text().await.unwrap_or_default();
                    let resp_json: Option<serde_json::Value> = serde_json::from_str(&text).ok();
                    self.log(cfg, file_logger::response_entry(cfg.slot, "manual-model-usage-5h", "GET", &url, status, resp_json)).await;
                    let parsed: Result<ModelUsageApiResponse, _> = serde_json::from_str(&text);
                    match parsed {
                        Ok(r) if r.code == 200 => {
                            let t = r.data.and_then(|d| d.total_usage);
                            (t.as_ref().map_or(0, |u| u.total_model_call_count),
                             t.as_ref().map_or(0, |u| u.total_tokens_usage))
                        }
                        _ => (0, 0),
                    }
                }
                Ok(resp) => {
                    let msg = format!("model-usage-5h HTTP error: {}", resp.status());
                    self.log(cfg, file_logger::error_entry(cfg.slot, "manual-model-usage-5h", "GET", &url, &msg)).await;
                    (0, 0)
                }
                Err(e) => {
                    self.log(cfg, file_logger::error_entry(cfg.slot, "manual-model-usage-5h", "GET", &url, &e.to_string())).await;
                    (0, 0)
                }
            }
        };

        // 4. Fetch tool-usage (best effort)
        let (net_search, web_read, zread, search_mcp) = {
            let url = format!("{}/tool-usage?startTime={}&endTime={}", base,
                urlencoding::encode(&start_24h), urlencoding::encode(&end));
            self.log(cfg, file_logger::request_entry(cfg.slot, "manual-tool-usage", "GET", &url, None)).await;
            match self.client.get(&url)
                .header(AUTHORIZATION, auth.clone())
                .header(ACCEPT_LANGUAGE, "en-US")
                .header(CONTENT_TYPE, "application/json")
                .send().await
            {
                Ok(resp) if resp.status().is_success() => {
                    let status = resp.status().as_u16();
                    let text = resp.text().await.unwrap_or_default();
                    let resp_json: Option<serde_json::Value> = serde_json::from_str(&text).ok();
                    self.log(cfg, file_logger::response_entry(cfg.slot, "manual-tool-usage", "GET", &url, status, resp_json)).await;
                    let parsed: Result<ToolUsageApiResponse, _> = serde_json::from_str(&text);
                    match parsed {
                        Ok(r) if r.code == 200 => {
                            let t = r.data.and_then(|d| d.total_usage);
                            (t.as_ref().map_or(0, |u| u.total_network_search_count),
                             t.as_ref().map_or(0, |u| u.total_web_read_mcp_count),
                             t.as_ref().map_or(0, |u| u.total_zread_mcp_count),
                             t.as_ref().map_or(0, |u| u.total_search_mcp_count))
                        }
                        _ => (0, 0, 0, 0),
                    }
                }
                Ok(resp) => {
                    let msg = format!("tool-usage HTTP error: {}", resp.status());
                    self.log(cfg, file_logger::error_entry(cfg.slot, "manual-tool-usage", "GET", &url, &msg)).await;
                    (0, 0, 0, 0)
                }
                Err(e) => {
                    self.log(cfg, file_logger::error_entry(cfg.slot, "manual-tool-usage", "GET", &url, &e.to_string())).await;
                    (0, 0, 0, 0)
                }
            }
        };

        Ok(SlotStats {
            level,
            limits,
            total_model_calls_24h,
            total_tokens_24h,
            total_model_calls_5h,
            total_tokens_5h,
            total_network_search_24h: net_search,
            total_web_read_24h: web_read,
            total_zread_24h: zread,
            total_search_mcp_24h: search_mcp,
        })
    }
}
