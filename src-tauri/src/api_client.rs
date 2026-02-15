use chrono::{Local, TimeZone};
use log::{debug, info};
use reqwest::header::{ACCEPT_LANGUAGE, AUTHORIZATION, CONTENT_TYPE};
use serde_json::json;

use crate::file_logger;
use crate::models::{KeySlotConfig, QuotaApiResponse, QuotaApiResponseFull, QuotaSnapshot,
    ModelUsageApiResponse, ToolUsageApiResponse, SlotStats, LimitInfo, UsageDetailInfo};

#[derive(Clone)]
pub struct ApiClient {
    client: reqwest::Client,
    app: Option<tauri::AppHandle>,
}

impl ApiClient {
    pub fn new(app: Option<tauri::AppHandle>) -> Result<Self, String> {
        let client = reqwest::Client::builder()
            .connect_timeout(std::time::Duration::from_secs(5))
            .timeout(std::time::Duration::from_secs(15))
            .build()
            .map_err(|err| format!("failed to create HTTP client: {err}"))?;

        Ok(Self { client, app })
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

    pub async fn warmup_key(&self, cfg: &KeySlotConfig) -> Result<(), String> {
        let Some(url) = cfg.request_url.clone() else {
            return Err("no request URL configured".to_string());
        };

        let body = json!({
            "model": "glm-5",
            "messages": [
                { "role": "system", "content": "You are a helpful assistant." },
                { "role": "user", "content": "ping" }
            ]
        });

        info!("slot {}: sending warmup request to {}", cfg.slot, url);
        self.log(cfg, file_logger::request_entry(cfg.slot, "manual-warmup", "POST", &url, Some(body.clone()))).await;

        let response = self
            .client
            .post(&url)
            .header(AUTHORIZATION, Self::auth_header(&cfg.api_key))
            .header(ACCEPT_LANGUAGE, "en-US")
            .header(CONTENT_TYPE, "application/json")
            .json(&body)
            .send()
            .await
            .map_err(|err| {
                let msg = format!("warmup request failed: {err}");
                msg
            })?;

        let status = response.status();
        self.log(cfg, file_logger::response_entry(cfg.slot, "manual-warmup", "POST", &url, status.as_u16(), None)).await;

        if !status.is_success() {
            let msg = format!("warmup HTTP error: {}", status);
            self.log(cfg, file_logger::error_entry(cfg.slot, "manual-warmup", "POST", &url, &msg)).await;
            return Err(msg);
        }

        info!("slot {}: warmup request succeeded", cfg.slot);
        Ok(())
    }

    pub async fn send_wake_request(&self, cfg: &KeySlotConfig) -> Result<(), String> {
        if !cfg.wake_enabled {
            return Ok(());
        }

        let Some(url) = cfg.request_url.clone() else {
            return Ok(());
        };

        let body = json!({
            "model": "glm-5",
            "messages": [
                { "role": "system", "content": "You are a helpful assistant." },
                { "role": "user", "content": "ping" }
            ]
        });

        info!("slot {}: sending scheduled wake request to {}", cfg.slot, url);
        self.log(cfg, file_logger::request_entry(cfg.slot, "scheduled-wake", "POST", &url, Some(body.clone()))).await;

        let response = self
            .client
            .post(&url)
            .header(AUTHORIZATION, Self::auth_header(&cfg.api_key))
            .header(ACCEPT_LANGUAGE, "en-US")
            .header(CONTENT_TYPE, "application/json")
            .json(&body)
            .send()
            .await
            .map_err(|err| {
                let msg = format!("wake request failed: {err}");
                msg
            })?;

        let status = response.status();
        self.log(cfg, file_logger::response_entry(cfg.slot, "scheduled-wake", "POST", &url, status.as_u16(), None)).await;

        if !status.is_success() {
            let msg = format!("wake HTTP error: {}", status);
            self.log(cfg, file_logger::error_entry(cfg.slot, "scheduled-wake", "POST", &url, &msg)).await;
            return Err(msg);
        }

        info!("slot {}: wake request succeeded", cfg.slot);
        Ok(())
    }

    pub async fn fetch_quota(&self, cfg: &KeySlotConfig) -> Result<QuotaSnapshot, String> {
        debug!("slot {}: fetching quota from {}", cfg.slot, cfg.quota_url);
        self.log(cfg, file_logger::request_entry(cfg.slot, "background-quota-poll", "GET", &cfg.quota_url, None)).await;

        let req = self
            .client
            .get(&cfg.quota_url)
            .header(AUTHORIZATION, Self::auth_header(&cfg.api_key))
            .header(ACCEPT_LANGUAGE, "en-US")
            .header(CONTENT_TYPE, "application/json");

        let response = req
            .send()
            .await
            .map_err(|err| {
                let msg = format!("quota request failed: {err}");
                msg
            })?;

        let status = response.status();

        if !status.is_success() {
            let msg = format!("quota HTTP error: {}", status);
            self.log(cfg, file_logger::error_entry(cfg.slot, "background-quota-poll", "GET", &cfg.quota_url, &msg)).await;
            return Err(msg);
        }

        let raw_text = response
            .text()
            .await
            .map_err(|err| format!("failed to read quota response: {err}"))?;

        let resp_json: Option<serde_json::Value> = serde_json::from_str(&raw_text).ok();
        self.log(cfg, file_logger::response_entry(cfg.slot, "background-quota-poll", "GET", &cfg.quota_url, status.as_u16(), resp_json)).await;

        let payload: QuotaApiResponse =
            serde_json::from_str(&raw_text).map_err(|err| format!("invalid quota JSON response: {err}"))?;

        if payload.code != 200 {
            return Err(format!("quota API code {}", payload.code));
        }

        let limits = payload
            .data
            .ok_or_else(|| "quota response missing data".to_string())?
            .limits;

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

        // 1. Fetch full quota/limit
        self.log(cfg, file_logger::request_entry(cfg.slot, "manual-stats-request", "GET", &cfg.quota_url, None)).await;
        let quota_resp = self
            .client
            .get(&cfg.quota_url)
            .header(AUTHORIZATION, auth.clone())
            .header(ACCEPT_LANGUAGE, "en-US")
            .header(CONTENT_TYPE, "application/json")
            .send()
            .await
            .map_err(|e| format!("quota request failed: {e}"))?;

        if !quota_resp.status().is_success() {
            let msg = format!("quota HTTP error: {}", quota_resp.status());
            self.log(cfg, file_logger::error_entry(cfg.slot, "manual-stats-request", "GET", &cfg.quota_url, &msg)).await;
            return Err(msg);
        }

        let quota_text = quota_resp.text().await.map_err(|e| format!("read quota: {e}"))?;
        let resp_json: Option<serde_json::Value> = serde_json::from_str(&quota_text).ok();
        self.log(cfg, file_logger::response_entry(cfg.slot, "manual-stats-request", "GET", &cfg.quota_url, 200, resp_json)).await;
        let quota_parsed: QuotaApiResponseFull =
            serde_json::from_str(&quota_text).map_err(|e| format!("parse quota: {e}"))?;

        let quota_data = quota_parsed.data.ok_or("quota missing data")?;
        let level = quota_data.level.unwrap_or_else(|| "unknown".into());

        let limits: Vec<LimitInfo> = quota_data
            .limits
            .iter()
            .map(|l| {
                let hms = l.next_reset_time.and_then(|ts| {
                    if ts > 0 {
                        Local.timestamp_millis_opt(ts).single().map(|dt| dt.format("%H:%M:%S").to_string())
                    } else {
                        None
                    }
                });
                LimitInfo {
                    type_name: l.r#type.clone(),
                    percentage: l.percentage,
                    usage: l.usage,
                    current_value: l.current_value,
                    remaining: l.remaining,
                    next_reset_time: l.next_reset_time,
                    next_reset_hms: hms,
                    usage_details: l.usage_details.iter().map(|d| UsageDetailInfo {
                        model_code: d.model_code.clone(),
                        usage: d.usage,
                    }).collect(),
                }
            })
            .collect();

        // 2. Derive base URL for model-usage / tool-usage
        let base = cfg.quota_url.trim_end_matches("/quota/limit");
        let now = Local::now();
        let start = (now - chrono::Duration::hours(24)).format("%Y-%m-%d %H:%M:%S").to_string();
        let end = now.format("%Y-%m-%d %H:%M:%S").to_string();

        // 3. Fetch model-usage (best effort)
        let (total_model_calls, total_tokens) = {
            let url = format!("{}/model-usage?startTime={}&endTime={}", base,
                urlencoding::encode(&start), urlencoding::encode(&end));
            self.log(cfg, file_logger::request_entry(cfg.slot, "manual-model-usage", "GET", &url, None)).await;
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
                    self.log(cfg, file_logger::response_entry(cfg.slot, "manual-model-usage", "GET", &url, status, resp_json)).await;
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
                    let msg = format!("model-usage HTTP error: {}", resp.status());
                    self.log(cfg, file_logger::error_entry(cfg.slot, "manual-model-usage", "GET", &url, &msg)).await;
                    (0, 0)
                }
                Err(e) => {
                    self.log(cfg, file_logger::error_entry(cfg.slot, "manual-model-usage", "GET", &url, &e.to_string())).await;
                    (0, 0)
                }
            }
        };

        // 4. Fetch tool-usage (best effort)
        let (net_search, web_read, zread, search_mcp) = {
            let url = format!("{}/tool-usage?startTime={}&endTime={}", base,
                urlencoding::encode(&start), urlencoding::encode(&end));
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
            total_model_calls_24h: total_model_calls,
            total_tokens_24h: total_tokens,
            total_network_search_24h: net_search,
            total_web_read_24h: web_read,
            total_zread_24h: zread,
            total_search_mcp_24h: search_mcp,
        })
    }
}
