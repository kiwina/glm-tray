import { invoke } from "@tauri-apps/api/core";
import type { AppConfig, SlotStats, RuntimeStatus } from "./types";
import { STORAGE_KEY, isTauriRuntime } from "./constants";
import {
  cachedStats,
  currentView,
  currentKeyTab,
  statsLoading,
  previewRuntime,
  setPreviewRuntime,
  setLatestRuntime,
  setCachedStats,
  setStatsLoading,
} from "./state";
import { defaultConfig, normalizeConfig, defaultRuntimeStatus, slotByView, esc } from "./helpers";
import { updateSidebar } from "./sidebar";
import { renderDashboard } from "./views/dashboard";
import { renderStatsTab } from "./views/tabs/stats";

export async function backendInvoke<T>(
  command: string,
  args?: Record<string, unknown>,
): Promise<T> {
  if (isTauriRuntime) return invoke<T>(command, args);

  // Preview mode fallback using localStorage
  const inMemory = localStorage.getItem(STORAGE_KEY);
  const saved = inMemory
    ? (JSON.parse(inMemory) as AppConfig)
    : defaultConfig();
  const config = normalizeConfig(saved);

  switch (command) {
    case "load_settings":
      return config as T;
    case "save_settings": {
      const next = normalizeConfig(
        (args?.settings as AppConfig) ?? config,
      );
      localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
      return next as T;
    }
    case "start_monitoring":
      setPreviewRuntime({
        monitoring: true,
        slots: config.slots.map((s) => ({
          slot: s.slot,
          name: s.name,
          enabled: s.enabled,
          timer_active: s.enabled,
          percentage: s.enabled ? Math.floor(Math.random() * 100) : null,
          next_reset_hms: s.enabled ? "--:--:--" : null,
          last_error: null,
          last_updated_epoch_ms: null,
          consecutive_errors: 0,
          auto_disabled: false,
        })),
      });
      return undefined as T;
    case "stop_monitoring":
      setPreviewRuntime(defaultRuntimeStatus());
      return undefined as T;
    case "get_runtime_status":
      return previewRuntime as T;
    case "warmup_all":
      await new Promise((r) => setTimeout(r, 3000));
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
        total_network_search_24h: 0,
        total_web_read_24h: 0,
        total_zread_24h: slotCfg?.enabled ? Math.floor(Math.random() * 30) : 0,
        total_search_mcp_24h: 0,
      } as T;
    }
    default:
      throw new Error(`Unsupported preview command: ${command}`);
  }
}

export async function loadStats(slotNum: number): Promise<void> {
  if (statsLoading) return;
  setStatsLoading(true);
  try {
    const stats = await backendInvoke<SlotStats>("fetch_slot_stats", { slot: slotNum });
    setCachedStats(slotNum, stats);
  } catch (err) {
    console.warn("stats fetch failed:", err);
  } finally {
    setStatsLoading(false);
    if (currentView === String(slotNum)) {
      const titleEl = document.getElementById("page-title") as HTMLHeadingElement | null;
      const s = slotByView(currentView);
      const stats = cachedStats[slotNum];
      const levelHtml = stats?.level ? ` <span class="badge badge-sm badge-soft opacity-50 ml-1 align-middle">${esc(stats.level)}</span>` : "";
      if (titleEl) titleEl.innerHTML = `${esc(s.name || `Key ${slotNum}`)}${levelHtml}`;
      if (currentKeyTab === "stats") {
        const tc = document.getElementById("tab-content") as HTMLDivElement | null;
        if (tc) renderStatsTab(tc);
      }
    }
  }
}

export async function refreshRuntimeStatus(): Promise<void> {
  const rt = await backendInvoke<RuntimeStatus>("get_runtime_status");
  setLatestRuntime(rt);
  syncButtons(rt.monitoring);
  updateSidebar();
  if (currentView === "dashboard") {
    renderDashboard();
  }
}

function syncButtons(monitoring: boolean): void {
  const btn = document.getElementById("monitor-btn") as HTMLButtonElement | null;
  if (!btn) return;
  btn.disabled = false;
  if (monitoring) {
    btn.title = "Stop monitoring";
    btn.className = "nav-btn relative flex flex-col items-center justify-center gap-1 py-2.5 w-full border-none bg-transparent text-error cursor-pointer hover:bg-error/10 transition";
    btn.innerHTML = `
      <svg class="w-[22px] h-[22px]" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>
      <span class="text-[10px] font-medium tracking-wide">Stop</span>`;
  } else {
    btn.title = "Start monitoring";
    btn.className = "nav-btn relative flex flex-col items-center justify-center gap-1 py-2.5 w-full border-none bg-transparent text-base-content/60 cursor-pointer hover:text-base-content hover:bg-base-content/[.04] transition";
    btn.innerHTML = `
      <svg class="w-[22px] h-[22px]" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>
      <span class="text-[10px] font-medium tracking-wide">Start</span>`;
  }
}
