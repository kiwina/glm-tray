use chrono::{Local, TimeZone};
use log::{debug, info};
use reqwest::header::{ACCEPT_LANGUAGE, AUTHORIZATION, CONTENT_TYPE};
use serde_json::json;

use crate::models::{KeySlotConfig, QuotaApiResponse, QuotaSnapshot};

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

        info!("slot {}: sending warmup request to {}", cfg.slot, url);

        let response = self
            .client
            .post(url)
            .header(AUTHORIZATION, Self::auth_header(&cfg.api_key))
            .header(ACCEPT_LANGUAGE, "en-US")
            .header(CONTENT_TYPE, "application/json")
            .json(&json!({
                "model": "glm-5",
                "messages": [
                    { "role": "system", "content": "You are a helpful assistant." },
                    { "role": "user", "content": "ping" }
                ]
            }))
            .send()
            .await
            .map_err(|err| format!("warmup request failed: {err}"))?;

        if !response.status().is_success() {
            return Err(format!("warmup HTTP error: {}", response.status()));
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

        info!("slot {}: sending scheduled wake request to {}", cfg.slot, url);

        let response = self
            .client
            .post(url)
            .header(AUTHORIZATION, Self::auth_header(&cfg.api_key))
            .header(ACCEPT_LANGUAGE, "en-US")
            .header(CONTENT_TYPE, "application/json")
            .json(&json!({
                "model": "glm-5",
                "messages": [
                    { "role": "system", "content": "You are a helpful assistant." },
                    { "role": "user", "content": "ping" }
                ]
            }))
            .send()
            .await
            .map_err(|err| format!("wake request failed: {err}"))?;

        if !response.status().is_success() {
            return Err(format!("wake HTTP error: {}", response.status()));
        }

        info!("slot {}: wake request succeeded", cfg.slot);
        Ok(())
    }

    pub async fn fetch_quota(&self, cfg: &KeySlotConfig) -> Result<QuotaSnapshot, String> {
        debug!("slot {}: fetching quota from {}", cfg.slot, cfg.quota_url);
        let req = self
            .client
            .get(&cfg.quota_url)
            .header(AUTHORIZATION, Self::auth_header(&cfg.api_key))
            .header(ACCEPT_LANGUAGE, "en-US")
            .header(CONTENT_TYPE, "application/json");

        let response = req
            .send()
            .await
            .map_err(|err| format!("quota request failed: {err}"))?;

        if !response.status().is_success() {
            return Err(format!("quota HTTP error: {}", response.status()));
        }

        let payload = response
            .json::<QuotaApiResponse>()
            .await
            .map_err(|err| format!("invalid quota JSON response: {err}"))?;

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
}
