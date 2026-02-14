use chrono::{Local, TimeZone};
use log::{debug, info, warn};
use reqwest::header::{ACCEPT_LANGUAGE, AUTHORIZATION, CONTENT_TYPE};
use serde_json::json;

use crate::models::{KeySlotConfig, QuotaApiResponse, QuotaApiResponseFull, QuotaSnapshot,
    ModelUsageApiResponse, ToolUsageApiResponse, SlotStats, LimitInfo, UsageDetailInfo};

#[derive(Clone)]
pub struct ApiClient {
    client: reqwest::Client,
}

impl ApiClient {
    pub fn new() -> Result<Self, String> {
        let client = reqwest::Client::builder()
            .connect_timeout(std::time::Duration::from_secs(5))
            .timeout(std::time::Duration::from_secs(15))
            .build()
            .map_err(|err| format!("failed to create HTTP client: {err}"))?;

        Ok(Self { client })
    }

    fn auth_header(api_key: &str) -> String {
        if api_key.trim_start().starts_with("Bearer ") {
            api_key.trim().to_string()
        } else {
            format!("Bearer {}", api_key.trim())
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

        if cfg.logging {
            info!("slot {} [LOG] warmup POST {}", cfg.slot, url);
            info!("slot {} [LOG] request body: {}", cfg.slot, body);
        } else {
            info!("slot {}: sending warmup request to {}", cfg.slot, url);
        }

        let response = self
            .client
            .post(url)
            .header(AUTHORIZATION, Self::auth_header(&cfg.api_key))
            .header(ACCEPT_LANGUAGE, "en-US")
            .header(CONTENT_TYPE, "application/json")
            .json(&body)
            .send()
            .await
            .map_err(|err| {
                if cfg.logging {
                    warn!("slot {} [LOG] warmup request error: {}", cfg.slot, err);
                }
                format!("warmup request failed: {err}")
            })?;

        let status = response.status();
        if cfg.logging {
            info!("slot {} [LOG] warmup response status: {}", cfg.slot, status);
            // Skip response body for LLM endpoints
        }

        if !status.is_success() {
            return Err(format!("warmup HTTP error: {}", status));
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

        if cfg.logging {
            info!("slot {} [LOG] wake POST {}", cfg.slot, url);
            info!("slot {} [LOG] request body: {}", cfg.slot, body);
        } else {
            info!("slot {}: sending scheduled wake request to {}", cfg.slot, url);
        }

        let response = self
            .client
            .post(url)
            .header(AUTHORIZATION, Self::auth_header(&cfg.api_key))
            .header(ACCEPT_LANGUAGE, "en-US")
            .header(CONTENT_TYPE, "application/json")
            .json(&body)
            .send()
            .await
            .map_err(|err| {
                if cfg.logging {
                    warn!("slot {} [LOG] wake request error: {}", cfg.slot, err);
                }
                format!("wake request failed: {err}")
            })?;

        let status = response.status();
        if cfg.logging {
            info!("slot {} [LOG] wake response status: {}", cfg.slot, status);
            // Skip response body for LLM endpoints
        }

        if !status.is_success() {
            return Err(format!("wake HTTP error: {}", status));
        }

        info!("slot {}: wake request succeeded", cfg.slot);
        Ok(())
    }

    pub async fn fetch_quota(&self, cfg: &KeySlotConfig) -> Result<QuotaSnapshot, String> {
        if cfg.logging {
            info!("slot {} [LOG] quota GET {}", cfg.slot, cfg.quota_url);
        } else {
            debug!("slot {}: fetching quota from {}", cfg.slot, cfg.quota_url);
        }

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
                if cfg.logging {
                    warn!("slot {} [LOG] quota request error: {}", cfg.slot, err);
                }
                format!("quota request failed: {err}")
            })?;

        let status = response.status();
        if cfg.logging {
            info!("slot {} [LOG] quota response status: {}", cfg.slot, status);
        }

        if !status.is_success() {
            return Err(format!("quota HTTP error: {}", status));
        }

        let raw_text = response
            .text()
            .await
            .map_err(|err| format!("failed to read quota response: {err}"))?;

        if cfg.logging {
            info!("slot {} [LOG] quota response body: {}", cfg.slot, raw_text);
        }

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
            return Err(format!("quota HTTP error: {}", quota_resp.status()));
        }

        let quota_text = quota_resp.text().await.map_err(|e| format!("read quota: {e}"))?;
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
            match self.client.get(&url)
                .header(AUTHORIZATION, auth.clone())
                .header(ACCEPT_LANGUAGE, "en-US")
                .header(CONTENT_TYPE, "application/json")
                .send().await
            {
                Ok(resp) if resp.status().is_success() => {
                    let text = resp.text().await.unwrap_or_default();
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
                _ => (0, 0),
            }
        };

        // 4. Fetch tool-usage (best effort)
        let (net_search, web_read, zread, search_mcp) = {
            let url = format!("{}/tool-usage?startTime={}&endTime={}", base,
                urlencoding::encode(&start), urlencoding::encode(&end));
            match self.client.get(&url)
                .header(AUTHORIZATION, auth.clone())
                .header(ACCEPT_LANGUAGE, "en-US")
                .header(CONTENT_TYPE, "application/json")
                .send().await
            {
                Ok(resp) if resp.status().is_success() => {
                    let text = resp.text().await.unwrap_or_default();
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
                _ => (0, 0, 0, 0),
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
