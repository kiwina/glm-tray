import type { Platform } from "./types";

export const STORAGE_KEY = "glm-tray-preview-settings";
export const isTauriRuntime =
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

export const MAX_KEYS = 4;
export const KEY_RANGE = Array.from({ length: MAX_KEYS }, (_, i) => i + 1);

export const NAV_BTN_CLS =
  "nav-btn relative flex flex-col items-center justify-center gap-1 py-2.5 w-full border-none bg-transparent text-base-content/60 cursor-pointer hover:text-base-content hover:bg-base-content/[.04] transition";

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
