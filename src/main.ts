import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";

type WakeMode = "interval" | "times" | "after_reset";
type View = "dashboard" | "1" | "2" | "3" | "4";
type KeyTab = "stats" | "schedule" | "settings";

interface KeySlotConfig {
  slot: number;
  name: string;
  enabled: boolean;
  api_key: string;
  quota_url: string;
  request_url: string | null;
  wake_enabled: boolean;
  wake_mode: WakeMode;
  wake_interval_minutes: number;
  wake_times: string[];
  wake_after_reset_minutes: number;
  poll_interval_minutes: number;
  logging: boolean;
}

interface AppConfig {
  slots: KeySlotConfig[];
  theme: string;
}

interface SlotRuntimeStatus {
  slot: number;
  name: string;
  enabled: boolean;
  timer_active: boolean;
  percentage: number | null;
  next_reset_hms: string | null;
  last_error: string | null;
  last_updated_epoch_ms: number | null;
  consecutive_errors: number;
  auto_disabled: boolean;
}

interface RuntimeStatus {
  monitoring: boolean;
  slots: SlotRuntimeStatus[];
}

/* ======== Constants & State ======== */

const STORAGE_KEY = "glm-tray-preview-settings";
const isTauriRuntime =
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

const MAX_KEYS = 4;
const KEY_RANGE = Array.from({ length: MAX_KEYS }, (_, i) => i + 1);

type Platform = "zai" | "bigmodel";

const PLATFORMS: Record<Platform, { label: string; base: string; quota: string; request: string }> = {
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

function detectPlatform(quotaUrl: string): Platform {
  if (quotaUrl.includes("bigmodel.cn")) return "bigmodel";
  return "zai";
}

let currentView: View = "dashboard";
let currentKeyTab: KeyTab = "stats";
let configState: AppConfig | null = null;
let previewRuntime: RuntimeStatus = { monitoring: false, slots: [] };
let latestRuntime: RuntimeStatus | null = null;
let cachedStats: Record<number, SlotStats> = {};
let statsLoading = false;

interface LimitInfo {
  type_name: string;
  percentage: number;
  usage: number | null;
  current_value: number | null;
  remaining: number | null;
  next_reset_time: number | null;
  next_reset_hms: string | null;
  usage_details: { model_code: string; usage: number }[];
}

interface SlotStats {
  level: string;
  limits: LimitInfo[];
  total_model_calls_24h: number;
  total_tokens_24h: number;
  total_network_search_24h: number;
  total_web_read_24h: number;
  total_zread_24h: number;
  total_search_mcp_24h: number;
}

/* ======== Helpers ======== */

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function defaultSlot(slot: number): KeySlotConfig {
  return {
    slot,
    name: "",
    enabled: false,
    api_key: "",
    quota_url: "https://api.z.ai/api/monitor/usage/quota/limit",
    request_url: "https://api.z.ai/api/coding/paas/v4/chat/completions",
    wake_enabled: false,
    wake_mode: "after_reset",
    wake_interval_minutes: 60,
    wake_times: [],
    wake_after_reset_minutes: 1,
    poll_interval_minutes: 30,
    logging: false,
  };
}

function defaultConfig(): AppConfig {
  return { slots: KEY_RANGE.map((s) => defaultSlot(s)), theme: "glm" };
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
      last_updated_epoch_ms: null,
      consecutive_errors: 0,
      auto_disabled: false,
    })),
  };
}

function normalizeConfig(config: AppConfig): AppConfig {
  const slots = KEY_RANGE.map((index) => {
    const current =
      config.slots.find((s) => s.slot === index) ?? defaultSlot(index);
    return {
      ...current,
      slot: index,
      poll_interval_minutes: Math.max(
        1,
        Number(current.poll_interval_minutes) || 30,
      ),
      wake_interval_minutes: Math.max(
        1,
        Number(current.wake_interval_minutes) || 60,
      ),
      wake_after_reset_minutes: Math.max(
        1,
        Number(current.wake_after_reset_minutes) || 1,
      ),
      wake_times: (current.wake_times ?? []).slice(0, 5),
    };
  });
  return { slots, theme: config.theme ?? "glm" };
}

function applyTheme(theme: string) {
  document.documentElement.setAttribute("data-theme", theme);
}

function isValidHm(value: string): boolean {
  return /^([01]\d|2[0-3]):([0-5]\d)$/.test(value);
}

function slotByView(view: View): KeySlotConfig {
  if (!configState) throw new Error("Configuration is not loaded.");
  const idx = Number(view);
  const found = configState.slots.find((s) => s.slot === idx);
  if (!found) throw new Error(`Missing slot ${idx}`);
  return found;
}

function pctBarClass(pct: number): string {
  if (pct >= 80) return "progress-error";
  if (pct >= 50) return "progress-warning";
  return "progress-info";
}

function dotClass(
  slot: KeySlotConfig | undefined,
  rt: SlotRuntimeStatus | undefined,
): string {
  if (rt?.auto_disabled || (rt?.consecutive_errors && rt.consecutive_errors > 0))
    return "bg-error";
  if (rt?.enabled || slot?.enabled) return "bg-success";
  return "bg-base-content/20";
}

/* ======== Backend Invoke ======== */

async function backendInvoke<T>(
  command: string,
  args?: Record<string, unknown>,
): Promise<T> {
  if (isTauriRuntime) return invoke<T>(command, args);

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
      previewRuntime.monitoring = true;
      previewRuntime.slots = config.slots.map((s) => ({
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
      }));
      return undefined as T;
    case "stop_monitoring":
      previewRuntime = defaultRuntimeStatus();
      return undefined as T;
    case "get_runtime_status":
      return previewRuntime as T;
    case "warmup_all":
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

/* ======== Sidebar ======== */

const NAV_BTN_CLS =
  "nav-btn relative flex flex-col items-center justify-center gap-1 py-2.5 w-full border-none bg-transparent text-base-content/60 cursor-pointer hover:text-base-content hover:bg-base-content/[.04] transition";

function createSidebar() {
  const nav = document.getElementById("sidebar-nav") as HTMLDivElement;
  nav.innerHTML = "";

  const dashBtn = document.createElement("button");
  dashBtn.className = NAV_BTN_CLS;
  dashBtn.dataset.view = "dashboard";
  dashBtn.innerHTML = `
    <svg class="w-[22px] h-[22px]" viewBox="0 0 24 24" fill="none" stroke="currentColor"
         stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
      <rect x="3" y="3" width="7" height="7" rx="1"/>
      <rect x="14" y="3" width="7" height="7" rx="1"/>
      <rect x="3" y="14" width="7" height="7" rx="1"/>
      <rect x="14" y="14" width="7" height="7" rx="1"/>
    </svg>
    <span class="text-[10px] font-medium tracking-wide">Home</span>`;
  dashBtn.addEventListener("click", () => {
    currentView = "dashboard";
    render();
  });
  nav.appendChild(dashBtn);

  for (let i = 1; i <= MAX_KEYS; i++) {
    const btn = document.createElement("button");
    btn.className = NAV_BTN_CLS;
    btn.dataset.view = String(i);
    btn.addEventListener("click", () => {
      currentView = String(i) as View;
      render();
    });
    nav.appendChild(btn);
  }
}

function updateSidebar() {
  document
    .querySelectorAll<HTMLButtonElement>("#sidebar-nav .nav-btn")
    .forEach((btn) => {
      const view = btn.dataset.view ?? "";
      btn.classList.toggle("active", view === currentView);

      if (view !== "dashboard") {
        const idx = Number(view);
        const slot = configState?.slots.find((s) => s.slot === idx);
        const rt = latestRuntime?.slots.find((s) => s.slot === idx);
        const hasContent = slot?.enabled || slot?.api_key || slot?.name;

        if (!hasContent) {
          btn.classList.add("hidden");
          return;
        }
        btn.classList.remove("hidden");

        const name = slot?.name || `Key ${idx}`;
        const dc = dotClass(slot, rt);
        const shortName =
          name.length > 8 ? name.slice(0, 7) + "\u2026" : name;

        btn.innerHTML = `
          <span class="nav-num relative w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold border border-neutral transition-colors">
            ${idx}
            <span class="absolute -top-0.5 -right-0.5 w-[7px] h-[7px] rounded-full border-[1.5px] border-base-200 ${dc}"></span>
          </span>
          <span class="text-[10px] font-medium tracking-wide max-w-[68px] text-center truncate">${esc(shortName)}</span>`;
      }
    });
}

/* ======== Dashboard View ======== */

function renderDashboard() {
  const root = document.getElementById("content-area") as HTMLDivElement;
  (document.getElementById("page-title") as HTMLHeadingElement).textContent =
    "GLM Tray";

  const rt = latestRuntime ?? { monitoring: false, slots: [] };
  const config = configState ?? defaultConfig();
  const enabledSlots = config.slots.filter((s) => s.enabled);
  const errorCount = rt.slots.reduce((a, s) => a + s.consecutive_errors, 0);

  const monLabel = rt.monitoring
    ? `<span class="text-success">● Monitoring</span>`
    : `<span class="text-base-content/30">○ Idle</span>`;
  const errLabel =
    errorCount > 0
      ? `<span class="text-error ml-auto">${errorCount} error${errorCount !== 1 ? "s" : ""}</span>`
      : "";

  let html = `<div class="h-full overflow-y-auto p-4 main-content">
    <div class="card bg-base-100 border border-neutral mb-2.5">
      <div class="flex items-center gap-3 px-3 py-2 text-xs font-semibold">
        ${monLabel}
        <span class="text-base-content/50">${enabledSlots.length}/${MAX_KEYS} active</span>
        ${errLabel}
      </div>
    </div>`;

  for (const slot of enabledSlots) {
    const rtSlot = rt.slots.find((s) => s.slot === slot.slot);
    const name = slot.name || `Key ${slot.slot}`;
    const dc = dotClass(slot, rtSlot);

    let rightSide = "";
    if (rtSlot?.auto_disabled) {
      rightSide = `<span class="text-error text-xs font-semibold">DISABLED (${rtSlot.consecutive_errors} err)</span>`;
    } else if (rtSlot && rtSlot.percentage != null) {
      const pct = rtSlot.percentage;
      const reset = rtSlot.next_reset_hms ?? "--:--:--";
      const errBadge =
        rtSlot.consecutive_errors > 0
          ? `<span class="badge badge-error badge-xs">\u00D7${rtSlot.consecutive_errors}</span>`
          : "";
      rightSide = `
        <progress class="progress ${pctBarClass(pct)} w-16" value="${pct}" max="100"></progress>
        <span class="text-sm font-bold tabular-nums min-w-8 text-right">${pct}%</span>
        <span class="text-xs text-base-content/50 tabular-nums">${reset}</span>
        ${errBadge}`;
    } else {
      rightSide = `<span class="text-xs text-base-content/30">waiting\u2026</span>`;
    }

    html += `
      <div class="card bg-base-100 border border-neutral mb-1.5 cursor-pointer hover:border-base-content/20 hover:bg-base-content/[.03] transition key-row" data-slot="${slot.slot}">
        <div class="flex items-center gap-2.5 px-3 py-2.5">
          <span class="w-2.5 h-2.5 rounded-full shrink-0 ${dc}"></span>
          <span class="text-sm font-semibold whitespace-nowrap min-w-[60px]">${esc(name)}</span>
          <div class="flex items-center gap-2 ml-auto shrink-0">${rightSide}</div>
        </div>
      </div>`;
  }

  const freeSlots = config.slots.filter((s) => !s.enabled);
  if (freeSlots.length > 0) {
    const nextFree = freeSlots[0].slot;
    html += `
      <div class="card border border-dashed border-neutral mb-1.5 cursor-pointer hover:text-primary hover:border-primary transition add-key-row" data-slot="${nextFree}">
        <div class="flex items-center justify-center gap-2 px-3 py-2.5 text-sm font-semibold text-base-content/30">
          <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
            <line x1="12" y1="5" x2="12" y2="19"/>
            <line x1="5" y1="12" x2="19" y2="12"/>
          </svg>
          <span>Add Key</span>
        </div>
      </div>`;
  }

  html += `</div>`; // close scrolling wrapper

  root.innerHTML = html;

  root.querySelectorAll<HTMLDivElement>(".key-row").forEach((row) => {
    row.addEventListener("click", () => {
      const s = row.dataset.slot;
      if (s) {
        currentView = s as View;
        render();
      }
    });
  });

  root.querySelectorAll<HTMLDivElement>(".add-key-row").forEach((row) => {
    row.addEventListener("click", () => {
      const s = row.dataset.slot;
      if (s) {
        currentView = s as View;
        render();
      }
    });
  });
}

/* ======== Key Detail View (Tabbed) ======== */

function renderKeyDetailShell() {
  const slotNum = Number(currentView);
  const s = slotByView(currentView);
  const root = document.getElementById("content-area") as HTMLDivElement;
  (document.getElementById("page-title") as HTMLHeadingElement).textContent =
    s.name || `Key ${slotNum}`;

  root.innerHTML = `
    <div class="flex flex-col h-full">
      <div class="flex-1 overflow-y-auto p-4 main-content" id="tab-content"></div>
      <div class="key-dock shrink-0" id="key-dock">
        <button data-tab="stats" class="${currentKeyTab === "stats" ? "dock-active" : ""}">
          <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M18 20V10"/><path d="M12 20V4"/><path d="M6 20v-6"/>
          </svg>
          Stats
        </button>
        <button data-tab="schedule" class="${currentKeyTab === "schedule" ? "dock-active" : ""}">
          <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>
          </svg>
          Schedule
        </button>
        <button data-tab="settings" class="${currentKeyTab === "settings" ? "dock-active" : ""}">
          <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/>
            <circle cx="12" cy="12" r="3"/>
          </svg>
          Settings
        </button>
      </div>
    </div>`;

  document.querySelectorAll<HTMLButtonElement>("#key-dock button").forEach((btn) => {
    btn.addEventListener("click", () => {
      currentKeyTab = btn.dataset.tab as KeyTab;
      renderKeyDetailShell();
    });
  });

  renderActiveTab();
}

function renderActiveTab() {
  const tc = document.getElementById("tab-content") as HTMLDivElement;
  if (!tc) return;
  switch (currentKeyTab) {
    case "stats":
      renderStatsTab(tc);
      break;
    case "schedule":
      renderScheduleTab(tc);
      break;
    case "settings":
      renderSettingsTab(tc);
      break;
  }
}

/* ======== Stats Tab ======== */

function formatTokens(n: number): string {
  if (n >= 1_000_000_000) return (n / 1_000_000_000).toFixed(1) + "B";
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(1) + "K";
  return String(n);
}

async function loadStats(slotNum: number) {
  if (statsLoading) return;
  statsLoading = true;
  try {
    const stats = await backendInvoke<SlotStats>("fetch_slot_stats", { slot: slotNum });
    cachedStats[slotNum] = stats;
  } catch (err) {
    console.warn("stats fetch failed:", err);
  } finally {
    statsLoading = false;
    if (currentView === String(slotNum) && currentKeyTab === "stats") {
      const tc = document.getElementById("tab-content") as HTMLDivElement | null;
      if (tc) renderStatsTab(tc);
    }
  }
}

function renderStatsTab(tc: HTMLDivElement) {
  const slotNum = Number(currentView);
  const rtSlot = latestRuntime?.slots.find((rs) => rs.slot === slotNum);
  const stats = cachedStats[slotNum];

  /* ── helper: SVG radial gauge ── */
  const radialGauge = (pct: number, size = 80, stroke = 6) => {
    const r = (size - stroke) / 2;
    const c = 2 * Math.PI * r;
    const offset = c * (1 - pct / 100);
    const clr = pct >= 80 ? "var(--color-error)" : pct >= 50 ? "var(--color-warning)" : "var(--color-primary)";
    return `<svg viewBox="0 0 ${size} ${size}" width="${size}" height="${size}" class="block">
      <circle cx="${size / 2}" cy="${size / 2}" r="${r}" fill="none" stroke="var(--color-neutral)" stroke-width="${stroke}" />
      <circle cx="${size / 2}" cy="${size / 2}" r="${r}" fill="none" stroke="${clr}" stroke-width="${stroke}"
        stroke-dasharray="${c}" stroke-dashoffset="${offset}" class="gauge-ring"
        transform="rotate(-90 ${size / 2} ${size / 2})" />
      <text x="50%" y="50%" dominant-baseline="central" text-anchor="middle"
        fill="var(--color-base-content)" font-size="${size * 0.26}px" font-weight="700">${pct}%</text>
    </svg>`;
  };

  /* ── status hero ── */
  let heroHtml = "";
  if (rtSlot && rtSlot.enabled) {
    if (rtSlot.auto_disabled) {
      heroHtml = `
        <div class="flex flex-col items-center py-4">
          <div class="text-error stat-value mb-1">!</div>
          <div class="stat-label text-error">Auto-disabled &middot; ${rtSlot.consecutive_errors} errors</div>
        </div>`;
    } else if (rtSlot.percentage != null) {
      heroHtml = `
        <div class="flex flex-col items-center py-3">
          ${radialGauge(rtSlot.percentage, 96, 7)}
          <span class="stat-label mt-2">Quota used &middot; Reset ${rtSlot.next_reset_hms ?? "--:--:--"}</span>
          ${rtSlot.consecutive_errors > 0 ? `<span class="text-xs text-error mt-1">err \u00D7${rtSlot.consecutive_errors}</span>` : ""}
        </div>`;
    }
  }

  /* ── loading state ── */
  if (!stats && !statsLoading) {
    tc.innerHTML = `${heroHtml}
      <div class="flex items-center justify-center py-8 text-base-content/30">
        <span class="loading loading-spinner loading-sm mr-2"></span>Loading\u2026
      </div>`;
    void loadStats(slotNum);
    return;
  }
  if (!stats) {
    tc.innerHTML = `${heroHtml}
      <div class="flex items-center justify-center py-8 text-base-content/30">
        <span class="loading loading-spinner loading-sm mr-2"></span>Loading\u2026
      </div>`;
    return;
  }

  /* ── limits ── */
  let limitsHtml = "";
  for (const lim of stats.limits) {
    const label = lim.type_name === "TOKENS_LIMIT" ? "Tokens" : "Requests";
    const resetStr = lim.next_reset_hms ?? "\u2014";
    const usedStr = lim.current_value != null ? formatTokens(lim.current_value) : "\u2014";
    const capStr = lim.usage != null ? formatTokens(lim.usage) : "";
    const remainStr = lim.remaining != null ? formatTokens(lim.remaining) : "";

    const detailBadges = lim.usage_details.length > 0
      ? `<div class="flex flex-wrap gap-1 mt-1.5">${lim.usage_details.map((d) => `<span class="badge badge-sm badge-outline">${esc(d.model_code)} ${d.usage}</span>`).join("")}</div>`
      : "";

    limitsHtml += `
      <div class="flex items-center gap-3 p-3 rounded-lg bg-base-200/60">
        ${radialGauge(lim.percentage, 56, 4)}
        <div class="flex-1 min-w-0">
          <div class="flex items-center justify-between mb-0.5">
            <span class="text-xs font-semibold">${label}</span>
            <span class="text-[10px] text-base-content/40">Reset ${resetStr}</span>
          </div>
          <div class="flex items-baseline gap-1">
            <span class="text-sm font-bold">${usedStr}</span>
            ${capStr ? `<span class="text-[10px] text-base-content/40">/ ${capStr}</span>` : ""}
          </div>
          ${remainStr ? `<span class="text-[10px] text-base-content/40">${remainStr} remaining</span>` : ""}
          ${detailBadges}
        </div>
      </div>`;
  }

  /* ── 24h usage summary ── */
  const usageHtml = `
    <div class="grid grid-cols-2 gap-2 mt-2">
      <div class="flex flex-col items-center p-3 rounded-lg bg-base-200/60">
        <span class="stat-value text-lg">${stats.total_model_calls_24h.toLocaleString()}</span>
        <span class="stat-label">Model calls</span>
      </div>
      <div class="flex flex-col items-center p-3 rounded-lg bg-base-200/60">
        <span class="stat-value text-lg">${formatTokens(stats.total_tokens_24h)}</span>
        <span class="stat-label">Tokens</span>
      </div>
    </div>`;

  /* ── tool usage ── */
  const totalTools = stats.total_network_search_24h + stats.total_web_read_24h + stats.total_zread_24h + stats.total_search_mcp_24h;
  const toolHtml = totalTools > 0 ? `
    <div class="mt-2 p-3 rounded-lg bg-base-200/60">
      <span class="stat-label block mb-2">24h tool usage</span>
      <div class="grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
        <span class="text-base-content/40">Search</span><span class="font-semibold text-right">${stats.total_network_search_24h}</span>
        <span class="text-base-content/40">Web Read</span><span class="font-semibold text-right">${stats.total_web_read_24h}</span>
        <span class="text-base-content/40">Zread</span><span class="font-semibold text-right">${stats.total_zread_24h}</span>
        <span class="text-base-content/40">Search MCP</span><span class="font-semibold text-right">${stats.total_search_mcp_24h}</span>
      </div>
    </div>` : "";

  /* ── level badge ── */
  const levelBadge = `<div class="flex justify-center mt-2">
    <span class="badge badge-sm badge-outline text-base-content/40">${esc(stats.level)}</span>
  </div>`;

  tc.innerHTML = `
    ${heroHtml}
    <div class="flex flex-col gap-2">${limitsHtml}</div>
    ${usageHtml}
    ${toolHtml}
    ${levelBadge}
    <button class="btn btn-sm btn-ghost btn-block text-base-content/30 mt-1 refresh-stats-btn">Refresh</button>`;

  tc.querySelector(".refresh-stats-btn")?.addEventListener("click", () => {
    delete cachedStats[slotNum];
    renderStatsTab(tc);
  });
}

/* ======== Schedule Tab ======== */

function renderScheduleTab(tc: HTMLDivElement) {
  const s = slotByView(currentView);
  const times = [0, 1, 2, 3, 4].map((i) => s.wake_times[i] ?? "");
  const intervalCls = s.wake_mode === "interval" ? "" : "hidden";
  const timesCls = s.wake_mode === "times" ? "" : "hidden";
  const resetCls = s.wake_mode === "after_reset" ? "" : "hidden";

  tc.innerHTML = `
    <form id="schedule-form" class="flex flex-col gap-3">
      <div class="card bg-base-100 border border-neutral">
        <div class="card-body p-4 gap-0">
          <h2 class="card-title text-sm mb-0.5">Wake Schedule</h2>
          <p class="text-xs text-base-content/50 mb-3">One strategy per key.</p>

          <label class="flex items-center gap-2.5 text-sm cursor-pointer mb-3">
            <input id="wake-enabled" type="checkbox" class="toggle toggle-sm toggle-primary" ${s.wake_enabled ? "checked" : ""} />
            Enable wake requests
          </label>

          <label class="text-xs font-medium text-base-content/60 mb-1 block">Wake mode</label>
          <select id="wake-mode" class="select select-sm w-full mb-3">
            <option value="interval" ${s.wake_mode === "interval" ? "selected" : ""}>Every N minutes</option>
            <option value="times" ${s.wake_mode === "times" ? "selected" : ""}>Specific times each day</option>
            <option value="after_reset" ${s.wake_mode === "after_reset" ? "selected" : ""}>After reset + offset</option>
          </select>

          <div id="wake-interval-wrap" class="${intervalCls}">
            <label class="text-xs font-medium text-base-content/60 mb-1 block">Wake every (minutes)</label>
            <input id="wake-interval" type="number" class="input input-sm w-full" min="1" step="1" value="${s.wake_interval_minutes}" />
          </div>
          <div id="wake-times-wrap" class="${timesCls}">
            <p class="text-xs text-base-content/50 mb-2">Up to 5 times, 24h HH:MM.</p>
            <div class="grid grid-cols-3 gap-1.5">
              <input class="input input-sm wake-time" data-index="0" type="text" placeholder="08:30" value="${esc(times[0])}" />
              <input class="input input-sm wake-time" data-index="1" type="text" placeholder="12:00" value="${esc(times[1])}" />
              <input class="input input-sm wake-time" data-index="2" type="text" placeholder="15:30" value="${esc(times[2])}" />
              <input class="input input-sm wake-time" data-index="3" type="text" placeholder="18:00" value="${esc(times[3])}" />
              <input class="input input-sm wake-time" data-index="4" type="text" placeholder="22:15" value="${esc(times[4])}" />
            </div>
          </div>
          <div id="wake-after-reset-wrap" class="${resetCls}">
            <label class="text-xs font-medium text-base-content/60 mb-1 block">Minutes after reset</label>
            <input id="wake-after-reset" type="number" class="input input-sm w-full" min="1" step="1" value="${s.wake_after_reset_minutes}" />
          </div>
        </div>
      </div>

      <button type="submit" class="btn btn-primary btn-block">Save Schedule</button>
      <p id="form-error" class="text-error font-semibold text-sm text-center" hidden></p>
    </form>`;

  (document.getElementById("wake-mode") as HTMLSelectElement)
    .addEventListener("change", (e) => {
      slotByView(currentView).wake_mode = (e.target as HTMLSelectElement).value as WakeMode;
      renderScheduleTab(tc);
    });

  (document.getElementById("schedule-form") as HTMLFormElement)
    .addEventListener("submit", async (e) => {
      e.preventDefault();
      const errEl = document.getElementById("form-error") as HTMLParagraphElement;
      errEl.hidden = true;

      const n = slotByView(currentView);
      n.wake_enabled = (document.getElementById("wake-enabled") as HTMLInputElement).checked;
      n.wake_mode = (document.getElementById("wake-mode") as HTMLSelectElement).value as WakeMode;
      n.wake_interval_minutes = Math.max(1, Number((document.getElementById("wake-interval") as HTMLInputElement).value) || 1);
      n.wake_after_reset_minutes = Math.max(1, Number((document.getElementById("wake-after-reset") as HTMLInputElement).value) || 1);

      const wakeTimes = Array.from(document.querySelectorAll<HTMLInputElement>(".wake-time"))
        .map((el) => el.value.trim())
        .filter((v) => v.length > 0)
        .slice(0, 5);

      const invalid = wakeTimes.find((v) => !isValidHm(v));
      if (n.wake_mode === "times" && invalid) {
        errEl.textContent = `Invalid time: ${invalid}. Use HH:MM (24h).`;
        errEl.hidden = false;
        return;
      }
      n.wake_times = wakeTimes;

      configState = await backendInvoke<AppConfig>("save_settings", { settings: configState });
      render();
    });
}

/* ======== Settings Tab ======== */

function renderSettingsTab(tc: HTMLDivElement) {
  const s = slotByView(currentView);
  const platform = detectPlatform(s.quota_url);

  tc.innerHTML = `
    <form id="settings-form" class="flex flex-col gap-3">
      <div class="card bg-base-100 border border-neutral">
        <div class="card-body p-4 gap-0">
          <h2 class="card-title text-sm mb-0.5">Configuration</h2>
          <p class="text-xs text-base-content/50 mb-3">Credentials and polling settings.</p>

          <label class="text-xs font-medium text-base-content/60 mb-1 block">Name</label>
          <input id="slot-name" type="text" class="input input-sm w-full mb-2.5" value="${esc(s.name)}" placeholder="e.g. Production" />

          <label class="text-xs font-medium text-base-content/60 mb-1.5 block">API Key</label>
          <input id="api-key" type="password" class="input input-sm w-full mb-3" value="${esc(s.api_key)}" placeholder="Bearer ..." autocomplete="off" />

          <label class="text-xs font-medium text-base-content/60 mb-1.5 block">Platform</label>
          <div class="join w-full mb-3">
            <input class="join-item btn btn-sm flex-1" type="radio" name="platform" aria-label="Z.ai" value="zai" ${platform === "zai" ? "checked" : ""} />
            <input class="join-item btn btn-sm flex-1" type="radio" name="platform" aria-label="BigModel" value="bigmodel" ${platform === "bigmodel" ? "checked" : ""} />
          </div>

          <label class="text-xs font-medium text-base-content/60 mb-1 block">Poll interval (minutes)</label>
          <input id="poll-interval" type="number" class="input input-sm w-full mb-3" min="1" step="1" value="${s.poll_interval_minutes}" />

          <div class="flex flex-col gap-2.5">
            <label class="flex items-center gap-2.5 text-sm cursor-pointer">
              <input id="enabled" type="checkbox" class="toggle toggle-sm toggle-primary" ${s.enabled ? "checked" : ""} />
              Enable polling
            </label>
            <label class="flex items-center gap-2.5 text-sm cursor-pointer">
              <input id="logging" type="checkbox" class="toggle toggle-sm toggle-primary" ${s.logging ? "checked" : ""} />
              Log requests &amp; responses
            </label>
          </div>
        </div>
      </div>

      <button type="submit" class="btn btn-primary btn-block">Save Settings</button>
      <p id="form-error" class="text-error font-semibold text-sm text-center" hidden></p>
    </form>`;

  (document.getElementById("settings-form") as HTMLFormElement)
    .addEventListener("submit", async (e) => {
      e.preventDefault();
      const errEl = document.getElementById("form-error") as HTMLParagraphElement;
      errEl.hidden = true;

      const n = slotByView(currentView);
      n.name = (document.getElementById("slot-name") as HTMLInputElement).value.trim();
      n.api_key = (document.getElementById("api-key") as HTMLInputElement).value.trim();

      const selectedPlatform = (document.querySelector<HTMLInputElement>('input[name="platform"]:checked')?.value ?? "zai") as Platform;
      const p = PLATFORMS[selectedPlatform];
      n.quota_url = p.quota;
      n.request_url = p.request;

      n.poll_interval_minutes = Math.max(1, Number((document.getElementById("poll-interval") as HTMLInputElement).value) || 30);
      n.enabled = (document.getElementById("enabled") as HTMLInputElement).checked;
      n.logging = (document.getElementById("logging") as HTMLInputElement).checked;

      configState = await backendInvoke<AppConfig>("save_settings", { settings: configState });
      render();
    });
}

/* ======== Render Orchestrator ======== */

function render() {
  updateSidebar();
  if (currentView === "dashboard") {
    renderDashboard();
  } else {
    renderKeyDetailShell();
  }
}

function syncButtons(monitoring: boolean) {
  const start = document.getElementById(
    "start-btn",
  ) as HTMLButtonElement | null;
  const stop = document.getElementById(
    "stop-btn",
  ) as HTMLButtonElement | null;
  if (start) start.disabled = monitoring;
  if (stop) stop.disabled = !monitoring;
}

async function refreshRuntimeStatus() {
  const rt = await backendInvoke<RuntimeStatus>("get_runtime_status");
  latestRuntime = rt;
  syncButtons(rt.monitoring);
  updateSidebar();
  if (currentView === "dashboard") {
    renderDashboard();
  }
}

/* ======== Init ======== */

window.addEventListener("DOMContentLoaded", async () => {
  createSidebar();
  configState = await backendInvoke<AppConfig>("load_settings");
  applyTheme(configState.theme ?? "glm");
  render();

  const startBtn = document.getElementById(
    "start-btn",
  ) as HTMLButtonElement;
  const stopBtn = document.getElementById("stop-btn") as HTMLButtonElement;
  startBtn.disabled = true;
  stopBtn.disabled = true;

  startBtn.addEventListener("click", async () => {
    startBtn.disabled = true;
    await backendInvoke("start_monitoring");
    await refreshRuntimeStatus();
  });

  stopBtn.addEventListener("click", async () => {
    stopBtn.disabled = true;
    await backendInvoke("stop_monitoring");
    await refreshRuntimeStatus();
  });

  document.getElementById("theme-btn")?.addEventListener("click", async () => {
    if (!configState) return;
    configState.theme = configState.theme === "business" ? "glm" : "business";
    applyTheme(configState.theme);
    configState = await backendInvoke<AppConfig>("save_settings", { settings: configState });
  });

  document.getElementById("warmup-btn")?.addEventListener("click", async () => {
    await backendInvoke("warmup_all");
  });

  document.querySelector(".sidebar-logo-link")?.addEventListener("click", async (e) => {
    e.preventDefault();
    if (isTauriRuntime) {
      await openUrl("https://z.ai/subscribe?ic=GONVESHW5A");
    } else {
      window.open("https://z.ai/subscribe?ic=GONVESHW5A", "_blank");
    }
  });

  await refreshRuntimeStatus();
  setInterval(() => void refreshRuntimeStatus(), 5000);
});
