export type View = "dashboard" | "settings" | "1" | "2" | "3" | "4";
export type KeyTab = "stats" | "schedule" | "settings";
export type Platform = "zai" | "bigmodel";

export interface KeySlotConfig {
  slot: number;
  name: string;
  enabled: boolean;
  api_key: string;
  quota_url: string;
  request_url: string | null;
  // Schedule modes - can enable multiple simultaneously
  schedule_interval_enabled: boolean;
  schedule_times_enabled: boolean;
  schedule_after_reset_enabled: boolean;
  // Mode-specific settings
  schedule_interval_minutes: number;
  schedule_times: string[];
  schedule_after_reset_minutes: number;
  poll_interval_minutes: number;
  logging: boolean;
}

export interface AppConfig {
  slots: KeySlotConfig[];
  theme: string;
  global_quota_url: string;
  global_request_url: string;
  log_directory?: string | null;
  max_log_days: number;
  wake_quota_retry_window_minutes: number;
  max_consecutive_errors: number;
  quota_poll_backoff_cap_minutes: number;
  config_version?: number;
}

export interface SlotRuntimeStatus {
  slot: number;
  name: string;
  enabled: boolean;
  timer_active: boolean;
  percentage: number | null;
  next_reset_hms: string | null;
  last_error: string | null;
  wake_consecutive_errors: number;
  quota_consecutive_errors: number;
  last_updated_epoch_ms: number | null;
  consecutive_errors: number;
  wake_pending: boolean;
  wake_reset_epoch_ms: number | null;
  wake_auto_disabled: boolean;
  auto_disabled: boolean;
}

export interface RuntimeStatus {
  monitoring: boolean;
  slots: SlotRuntimeStatus[];
}

export interface LimitInfo {
  type_name: string;
  percentage: number;
  unit: number | null;
  usage: number | null;
  current_value: number | null;
  remaining: number | null;
  next_reset_time: number | null;
  next_reset_hms: string | null;
  usage_details: { model_code: string; usage: number }[];
}

export interface SlotStats {
  level: string;
  limits: LimitInfo[];
  total_model_calls_24h: number;
  total_tokens_24h: number;
  total_model_calls_5h: number;
  total_tokens_5h: number;
  total_network_search_24h: number;
  total_web_read_24h: number;
  total_zread_24h: number;
  total_search_mcp_24h: number;
}

export interface UpdateInfo {
  current_version: string;
  latest_version: string;
  has_update: boolean;
  download_url: string;
  release_notes: string;
  published_at: string;
  source?: string;
}

export interface QuotaUpdateEvent {
  slot: number;
  percentage: number;
  timer_active: boolean;
  next_reset_hms: string | null;
  next_reset_epoch_ms: number | null;
}
