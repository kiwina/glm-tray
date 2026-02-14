use serde::{Deserialize, Serialize};

pub const MAX_SLOTS: usize = 5;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WakeMode {
    Interval,
    Times,
    AfterReset,
}

impl Default for WakeMode {
    fn default() -> Self {
        Self::AfterReset
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct KeySlotConfig {
    pub slot: usize,
    pub name: String,
    pub enabled: bool,
    pub api_key: String,
    pub quota_url: String,
    pub request_url: Option<String>,
    pub wake_enabled: bool,
    pub wake_mode: WakeMode,
    pub wake_interval_minutes: u64,
    pub wake_times: Vec<String>,
    pub wake_after_reset_minutes: u64,
    pub poll_interval_minutes: u64,
}

impl Default for KeySlotConfig {
    fn default() -> Self {
        Self {
            slot: 1,
            name: String::new(),
            enabled: false,
            api_key: String::new(),
            quota_url: "https://api.z.ai/api/monitor/usage/quota/limit".to_string(),
            request_url: Some("https://api.z.ai/api/coding/paas/v4/chat/completions".to_string()),
            wake_enabled: false,
            wake_mode: WakeMode::AfterReset,
            wake_interval_minutes: 60,
            wake_times: Vec::new(),
            wake_after_reset_minutes: 1,
            poll_interval_minutes: 30,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct AppConfig {
    pub slots: Vec<KeySlotConfig>,
}

impl Default for AppConfig {
    fn default() -> Self {
        let mut slots = Vec::with_capacity(MAX_SLOTS);
        for idx in 0..MAX_SLOTS {
            let mut slot = KeySlotConfig::default();
            slot.slot = idx + 1;
            slots.push(slot);
        }
        Self { slots }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct SlotRuntimeStatus {
    pub slot: usize,
    pub name: String,
    pub enabled: bool,
    pub timer_active: bool,
    pub percentage: Option<u8>,
    pub next_reset_hms: Option<String>,
    pub last_error: Option<String>,
    pub last_updated_epoch_ms: Option<i64>,
    pub consecutive_errors: u32,
    pub auto_disabled: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct RuntimeStatus {
    pub monitoring: bool,
    pub slots: Vec<SlotRuntimeStatus>,
}

impl Default for RuntimeStatus {
    fn default() -> Self {
        let mut slots = Vec::with_capacity(MAX_SLOTS);
        for idx in 0..MAX_SLOTS {
            slots.push(SlotRuntimeStatus {
                slot: idx + 1,
                ..Default::default()
            });
        }
        Self {
            monitoring: false,
            slots,
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
pub struct QuotaApiResponse {
    pub code: i32,
    pub data: Option<QuotaData>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct QuotaData {
    pub limits: Vec<QuotaLimit>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QuotaLimit {
    pub r#type: String,
    pub percentage: u8,
    #[serde(default)]
    pub next_reset_time: Option<i64>,
}

#[derive(Debug, Clone)]
pub struct QuotaSnapshot {
    pub percentage: u8,
    pub timer_active: bool,
    pub next_reset_hms: Option<String>,
    pub next_reset_epoch_ms: Option<i64>,
}
