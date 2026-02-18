import type { Platform, KeySlotConfig } from "./types";

export const STORAGE_KEY = "glm-tray-preview-settings";
export const isTauriRuntime =
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

export const MAX_KEYS = 4;
export const KEY_RANGE = Array.from({ length: MAX_KEYS }, (_, i) => i + 1);

export const PLATFORMS: Record<Platform, { label: string; base: string; quota: string; request: string }> = {
  zai: {
    label: "Z.ai",
    base: "https://api.z.ai",
    quota: "https://api.z.ai/api/monitor/usage/quota/limit",
    request: "https://api.z.ai/api/coding/paas/v4/chat/completions",
  },
  bigmodel: {
    label: "BigModel",
    base: "https://open.bigmodel.cn",
    quota: "https://open.bigmodel.cn/api/monitor/usage/quota/limit",
    request: "https://open.bigmodel.cn/api/coding/paas/v4/chat/completions",
  },
};

export function detectPlatform(quotaUrl: string): Platform {
  if (quotaUrl.includes("bigmodel.cn")) return "bigmodel";
  return "zai";
}

export function defaultSlot(slot: number): KeySlotConfig {
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
    schedule_times: [],
    schedule_after_reset_minutes: 1,
    poll_interval_minutes: 30,
    logging: false,
  };
}
