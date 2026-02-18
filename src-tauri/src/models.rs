use serde::{Deserialize, Serialize};

pub const MAX_SLOTS: usize = 4;
pub const CURRENT_CONFIG_VERSION: u32 = 3;

fn default_global_quota_url() -> String {
    "https://api.z.ai/api/monitor/usage/quota/limit".to_string()
}

fn default_global_request_url() -> String {
    "https://api.z.ai/api/coding/paas/v4/chat/completions".to_string()
}

fn default_max_log_days() -> u64 {
    7
}

fn default_wake_quota_retry_window_minutes() -> u64 {
    15
}

fn default_max_consecutive_errors() -> u32 {
    10
}

fn default_quota_poll_backoff_cap_minutes() -> u64 {
    480
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
    // Schedule modes - can enable multiple simultaneously
    #[serde(default)]
    pub schedule_interval_enabled: bool,
    #[serde(default)]
    pub schedule_times_enabled: bool,
    #[serde(default)]
    pub schedule_after_reset_enabled: bool,
    // Mode-specific settings
    pub schedule_interval_minutes: u64,
    pub schedule_times: Vec<String>,
    pub schedule_after_reset_minutes: u64,
    pub poll_interval_minutes: u64,
    pub logging: bool,
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
            schedule_interval_enabled: false,
            schedule_times_enabled: false,
            schedule_after_reset_enabled: false,
            schedule_interval_minutes: 60,
            schedule_times: Vec::new(),
            schedule_after_reset_minutes: 1,
            poll_interval_minutes: 30,
            logging: false,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct AppConfig {
    pub slots: Vec<KeySlotConfig>,
    pub theme: String,
    #[serde(default = "default_global_quota_url")]
    pub global_quota_url: String,
    #[serde(default = "default_global_request_url")]
    pub global_request_url: String,
    #[serde(default)]
    pub log_directory: Option<String>,
    #[serde(default = "default_max_log_days")]
    pub max_log_days: u64,
    #[serde(default = "default_wake_quota_retry_window_minutes")]
    pub wake_quota_retry_window_minutes: u64,
    #[serde(default = "default_max_consecutive_errors")]
    pub max_consecutive_errors: u32,
    #[serde(default = "default_quota_poll_backoff_cap_minutes")]
    pub quota_poll_backoff_cap_minutes: u64,
    #[serde(default)]
    pub config_version: u32,
}

impl Default for AppConfig {
    fn default() -> Self {
        let mut slots = Vec::with_capacity(MAX_SLOTS);
        for idx in 0..MAX_SLOTS {
            let mut slot = KeySlotConfig::default();
            slot.slot = idx + 1;
            slots.push(slot);
        }
        Self {
            slots,
            theme: "glm".to_string(),
            global_quota_url: default_global_quota_url(),
            global_request_url: default_global_request_url(),
            log_directory: None,
            max_log_days: default_max_log_days(),
            wake_quota_retry_window_minutes: default_wake_quota_retry_window_minutes(),
            max_consecutive_errors: default_max_consecutive_errors(),
            quota_poll_backoff_cap_minutes: default_quota_poll_backoff_cap_minutes(),
            config_version: CURRENT_CONFIG_VERSION,
        }
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
    pub wake_consecutive_errors: u32,
    pub quota_consecutive_errors: u32,
    pub consecutive_errors: u32,
    pub wake_pending: bool,
    pub wake_reset_epoch_ms: Option<i64>,
    pub wake_auto_disabled: bool,
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

// ---- Stats API types ----

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
#[allow(dead_code)]
pub struct QuotaLimitFull {
    pub r#type: String,
    #[serde(default)]
    pub unit: Option<u64>,
    #[serde(default)]
    pub number: Option<u64>,
    #[serde(default)]
    pub usage: Option<u64>,
    #[serde(default)]
    pub current_value: Option<u64>,
    #[serde(default)]
    pub remaining: Option<u64>,
    pub percentage: u8,
    #[serde(default)]
    pub next_reset_time: Option<i64>,
    #[serde(default)]
    pub usage_details: Vec<UsageDetailRaw>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageDetailRaw {
    pub model_code: String,
    pub usage: u64,
}

#[derive(Debug, Clone, Deserialize)]
pub struct QuotaDataFull {
    pub limits: Vec<QuotaLimitFull>,
    #[serde(default)]
    pub level: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[allow(dead_code)]
pub struct QuotaApiResponseFull {
    pub code: i32,
    pub data: Option<QuotaDataFull>,
}

// Model-usage response
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelUsageTotals {
    #[serde(default)]
    pub total_model_call_count: u64,
    #[serde(default)]
    pub total_tokens_usage: u64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelUsageData {
    #[serde(default)]
    pub total_usage: Option<ModelUsageTotals>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ModelUsageApiResponse {
    pub code: i32,
    pub data: Option<ModelUsageData>,
}

// Tool-usage response
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolUsageTotals {
    #[serde(default)]
    pub total_network_search_count: u64,
    #[serde(default)]
    pub total_web_read_mcp_count: u64,
    #[serde(default)]
    pub total_zread_mcp_count: u64,
    #[serde(default)]
    pub total_search_mcp_count: u64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolUsageData {
    #[serde(default)]
    pub total_usage: Option<ToolUsageTotals>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ToolUsageApiResponse {
    pub code: i32,
    pub data: Option<ToolUsageData>,
}

// Combined stats returned to frontend
#[derive(Debug, Clone, Serialize)]
pub struct LimitInfo {
    pub type_name: String,
    pub percentage: u8,
    pub unit: Option<u64>,
    pub usage: Option<u64>,
    pub current_value: Option<u64>,
    pub remaining: Option<u64>,
    pub next_reset_time: Option<i64>,
    pub next_reset_hms: Option<String>,
    pub usage_details: Vec<UsageDetailInfo>,
}

#[derive(Debug, Clone, Serialize)]
pub struct UsageDetailInfo {
    pub model_code: String,
    pub usage: u64,
}

#[derive(Debug, Clone, Serialize)]
pub struct SlotStats {
    pub level: String,
    pub limits: Vec<LimitInfo>,
    pub total_model_calls_24h: u64,
    pub total_tokens_24h: u64,
    pub total_model_calls_5h: u64,
    pub total_tokens_5h: u64,
    pub total_network_search_24h: u64,
    pub total_web_read_24h: u64,
    pub total_zread_24h: u64,
    pub total_search_mcp_24h: u64,
}
