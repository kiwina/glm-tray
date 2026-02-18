import { invoke } from "@tauri-apps/api/core";
import type { AppConfig, RuntimeStatus } from "./types";
import { STORAGE_KEY, isTauriRuntime, KEY_RANGE, PLATFORMS } from "./constants";

export function logUiAction(action: string, slot?: number, details?: Record<string, unknown>): void {
  if (!isTauriRuntime) return;
  void backendInvoke("log_ui_action", { action, slot: slot ?? null, details: details ?? null }).catch(() => { });
}

export function hasSlotWithKey(config: AppConfig | null): boolean {
  if (!config) return false;
  return config.slots.some((slot) => slot.api_key.trim().length > 0);
}

// Keep old name as alias for backwards compat
export const hasEnabledSlotWithKey = hasSlotWithKey;

function defaultSlot(slot: number) {
  return {
    slot,
    name: "",
    enabled: false,
    api_key: "",
    quota_url: PLATFORMS.zai.quota,
    request_url: PLATFORMS.zai.request,
    schedule_interval_enabled: false,
    schedule_times_enabled: false,
    schedule_after_reset_enabled: false,
    schedule_interval_minutes: 60,
    schedule_times: [] as string[],
    schedule_after_reset_minutes: 1,
    poll_interval_minutes: 30,
    logging: false,
  };
}

function defaultConfig(): AppConfig {
  return {
    slots: KEY_RANGE.map((s) => defaultSlot(s)),
    theme: "glm",
    global_quota_url: PLATFORMS.zai.quota,
    global_request_url: PLATFORMS.zai.request,
    log_directory: "",
    max_log_days: 7,
    wake_quota_retry_window_minutes: 15,
    max_consecutive_errors: 10,
    quota_poll_backoff_cap_minutes: 480,
    debug: false,
    mock_url: null,
  };
}

function defaultRuntimeStatus(): RuntimeStatus {
  return {
    monitoring: false,
    slots: KEY_RANGE.map((s) => ({
      slot: s,
      name: "",
      enabled: false,
      timer_active: false,
      percentage: null,
      next_reset_hms: null,
      last_error: null,
      wake_consecutive_errors: 0,
      quota_consecutive_errors: 0,
      last_updated_epoch_ms: null,
      consecutive_errors: 0,
      wake_pending: false,
      wake_reset_epoch_ms: null,
      wake_auto_disabled: false,
      auto_disabled: false,
      total_model_calls_5h: 0,
      total_tokens_5h: 0,
      quota_last_updated: null,
    })),
  };
}

export function normalizeConfig(config: AppConfig): AppConfig {
  const global_quota_url = config.global_quota_url?.trim() || PLATFORMS.zai.quota;
  const global_request_url = config.global_request_url?.trim() || PLATFORMS.zai.request;
  const validGlobalQuota = global_quota_url.startsWith("https://");
  const validGlobalRequest = global_request_url.startsWith("https://");
  const max_log_days = Number.isFinite(config.max_log_days)
    ? Math.min(365, Math.max(1, Math.floor(config.max_log_days)))
    : 7;
  const wake_quota_retry_window_minutes = Number.isFinite(config.wake_quota_retry_window_minutes)
    ? Math.min(1_440, Math.max(1, Math.floor(config.wake_quota_retry_window_minutes)))
    : 15;
  const max_consecutive_errors = Number.isFinite(config.max_consecutive_errors)
    ? Math.min(1_000, Math.max(1, Math.floor(config.max_consecutive_errors)))
    : 10;
  const quota_poll_backoff_cap_minutes = Number.isFinite(config.quota_poll_backoff_cap_minutes)
    ? Math.min(1_440, Math.max(1, Math.floor(config.quota_poll_backoff_cap_minutes)))
    : 480;

  const slots = KEY_RANGE.map((index) => {
    const current = config.slots.find((s) => s.slot === index) ?? defaultSlot(index);
    return {
      ...current,
      slot: index,
      poll_interval_minutes: Math.max(1, Number(current.poll_interval_minutes) || 30),
      schedule_interval_minutes: Math.max(1, Number(current.schedule_interval_minutes) || 60),
      schedule_after_reset_minutes: Math.max(1, Number(current.schedule_after_reset_minutes) || 1),
      schedule_times: (current.schedule_times ?? []).slice(0, 5),
    };
  });

  return {
    slots,
    theme: config.theme ?? "glm",
    global_quota_url: validGlobalQuota ? global_quota_url : PLATFORMS.zai.quota,
    global_request_url: validGlobalRequest ? global_request_url : PLATFORMS.zai.request,
    log_directory: (config.log_directory?.trim() || "") || undefined,
    max_log_days,
    wake_quota_retry_window_minutes,
    max_consecutive_errors,
    quota_poll_backoff_cap_minutes,
    debug: config.debug ?? false,
    mock_url: config.mock_url?.trim() || null,
  };
}

// In-memory preview runtime for non-Tauri mode
let previewRuntime: RuntimeStatus = { monitoring: false, slots: [] };

export async function backendInvoke<T>(
  command: string,
  args?: Record<string, unknown>,
): Promise<T> {
  if (isTauriRuntime) return invoke<T>(command, args);

  // Preview mode fallback using localStorage
  const inMemory = localStorage.getItem(STORAGE_KEY);
  const saved = inMemory ? (JSON.parse(inMemory) as AppConfig) : defaultConfig();
  const config = normalizeConfig(saved);

  switch (command) {
    case "load_settings":
      return config as T;
    case "save_settings": {
      const next = normalizeConfig((args?.settings as AppConfig) ?? config);
      localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
      return next as T;
    }
    case "start_monitoring":
      if (!hasSlotWithKey(config)) return undefined as T;
      previewRuntime = {
        monitoring: true,
        slots: config.slots.map((s) => ({
          slot: s.slot,
          name: s.name,
          enabled: s.enabled,
          timer_active: s.enabled,
          percentage: s.enabled ? Math.floor(Math.random() * 100) : null,
          next_reset_hms: s.enabled ? "--:--:--" : null,
          last_error: null,
          wake_consecutive_errors: 0,
          quota_consecutive_errors: 0,
          last_updated_epoch_ms: null,
          consecutive_errors: 0,
          wake_pending: false,
          wake_reset_epoch_ms: null,
          wake_auto_disabled: false,
          auto_disabled: false,
          total_model_calls_5h: 0,
          total_tokens_5h: 0,
          quota_last_updated: null,
        })),
      };
      return undefined as T;
    case "stop_monitoring":
      previewRuntime = defaultRuntimeStatus();
      return undefined as T;
    case "get_runtime_status":
      return previewRuntime as T;
    case "warmup_all":
      if (!hasSlotWithKey(config)) return undefined as T;
      await new Promise((r) => setTimeout(r, 3000));
      return undefined as T;
    case "warmup_slot":
      await new Promise((r) => setTimeout(r, 1500));
      return undefined as T;
    case "fetch_slot_stats": {
      const slot = (args?.slot as number) ?? 1;
      const slotCfg = config.slots.find((s) => s.slot === slot);
      return {
        level: "pro",
        limits: [
          { type_name: "TOKENS_LIMIT", percentage: Math.floor(Math.random() * 30), usage: null, current_value: null, remaining: null, next_reset_time: Date.now() + 3600000, next_reset_hms: "05:00:00", usage_details: [] },
          { type_name: "TIME_LIMIT", percentage: Math.floor(Math.random() * 15), usage: 1000, current_value: Math.floor(Math.random() * 50), remaining: 950, next_reset_time: Date.now() + 86400000, next_reset_hms: "00:00:00", usage_details: [{ model_code: "search-prime", usage: 0 }, { model_code: "web-reader", usage: 0 }, { model_code: "zread", usage: Math.floor(Math.random() * 20) }] },
        ],
        total_model_calls_24h: slotCfg?.enabled ? Math.floor(Math.random() * 2000) : 0,
        total_tokens_24h: slotCfg?.enabled ? Math.floor(Math.random() * 100000000) : 0,
        total_model_calls_5h: slotCfg?.enabled ? Math.floor(Math.random() * 500) : 0,
        total_tokens_5h: slotCfg?.enabled ? Math.floor(Math.random() * 25000000) : 0,
        total_network_search_24h: 0,
        total_web_read_24h: 0,
        total_zread_24h: slotCfg?.enabled ? Math.floor(Math.random() * 30) : 0,
        total_search_mcp_24h: 0,
      } as T;
    }
    case "check_for_updates_cmd":
      return { has_update: false, current_version: "preview", latest_version: "preview", download_url: "", release_notes: "", published_at: "" } as T;
    case "log_ui_action":
      return undefined as T;
    default:
      throw new Error(`Unsupported preview command: ${command}`);
  }
}
