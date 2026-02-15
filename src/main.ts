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

function applyTheme() {
  document.documentElement.setAttribute("data-theme", "glm");
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
    "GLM Tray v0.01-alpha";

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
    <div class="card bg-base-100 card-border border-base-300 card-sm from-base-content/5 bg-linear-to-bl to-50% mb-3">
      <div class="card-body p-3">
        <div class="flex items-center gap-3 text-xs font-semibold">
          ${monLabel}
          <span class="opacity-50">${enabledSlots.length}/${MAX_KEYS} active</span>
          ${errLabel}
        </div>
      </div>
    </div>`;

  for (const slot of enabledSlots) {
    const rtSlot = rt.slots.find((s) => s.slot === slot.slot);
    const name = slot.name || `Key ${slot.slot}`;
    const dc = dotClass(slot, rtSlot);

    let rightSide = "";
    if (rtSlot?.auto_disabled) {
      rightSide = `<span class="badge badge-sm badge-soft badge-error">DISABLED</span>`;
    } else if (rtSlot && rtSlot.percentage != null) {
      const pct = rtSlot.percentage;
      const reset = rtSlot.next_reset_hms ?? "--:--:--";
      const errBadge =
        rtSlot.consecutive_errors > 0
          ? `<span class="badge badge-error badge-xs">\u00D7${rtSlot.consecutive_errors}</span>`
          : "";
      rightSide = `
        <progress class="progress ${pctBarClass(pct)} w-14" value="${pct}" max="100"></progress>
        <span class="text-sm font-bold tabular-nums min-w-8 text-right">${pct}%</span>
        <span class="text-[10px] opacity-40 tabular-nums">${reset}</span>
        ${errBadge}`;
    } else {
      rightSide = `<span class="text-xs opacity-30">waiting\u2026</span>`;
    }

    html += `
      <div class="border-t-base-content/5 flex items-center gap-2.5 border-t border-dashed py-2.5 px-1 cursor-pointer hover:bg-base-content/[.03] transition key-row" data-slot="${slot.slot}">
        <span class="w-2 h-2 rounded-full shrink-0 ${dc}"></span>
        <span class="text-sm font-semibold whitespace-nowrap min-w-[60px]">${esc(name)}</span>
        <div class="flex items-center gap-2 ml-auto shrink-0">${rightSide}</div>
      </div>`;
  }

  const freeSlots = config.slots.filter((s) => !s.enabled);
  if (freeSlots.length > 0) {
    const nextFree = freeSlots[0].slot;
    html += `
      <div class="border-t-base-content/5 flex items-center justify-center gap-2 border-t border-dashed py-2.5 px-1 cursor-pointer opacity-30 hover:opacity-70 hover:text-primary transition add-key-row" data-slot="${nextFree}">
        <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
          <line x1="12" y1="5" x2="12" y2="19"/>
          <line x1="5" y1="12" x2="19" y2="12"/>
        </svg>
        <span class="text-sm font-semibold">Add Key</span>
      </div>`;
  }

  html += `<div class="text-center text-[10px] opacity-20 mt-3 pb-1">v0.01-alpha</div>`;
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
  const hasKey = s.api_key.trim().length > 0;
  const root = document.getElementById("content-area") as HTMLDivElement;
  const titleEl = document.getElementById("page-title") as HTMLHeadingElement;
  const stats = cachedStats[slotNum];
  const levelHtml = stats?.level ? ` <span class="badge badge-sm badge-soft opacity-50 ml-1 align-middle">${esc(stats.level)}</span>` : "";
  titleEl.innerHTML = `${esc(s.name || `Key ${slotNum}`)}${levelHtml}`;

  // Force settings tab when no API key is configured
  if (!hasKey && currentKeyTab !== "settings") {
    currentKeyTab = "settings";
  }

  const lockedCls = !hasKey ? "opacity-30 pointer-events-none" : "";

  root.innerHTML = `
    <div class="flex flex-col h-full">
      <div class="flex-1 overflow-y-auto p-4 main-content" id="tab-content"></div>
      <div class="key-dock shrink-0" id="key-dock">
        <button data-tab="stats" class="${currentKeyTab === "stats" ? "dock-active" : ""} ${lockedCls}" ${!hasKey ? 'disabled title="Add an API key first"' : ""}>
          <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M18 20V10"/><path d="M12 20V4"/><path d="M6 20v-6"/>
          </svg>
          Stats
        </button>
        <button data-tab="schedule" class="${currentKeyTab === "schedule" ? "dock-active" : ""} ${lockedCls}" ${!hasKey ? 'disabled title="Add an API key first"' : ""}>
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

  document.querySelectorAll<HTMLButtonElement>("#key-dock button:not([disabled])").forEach((btn) => {
    btn.addEventListener("click", () => {
      currentKeyTab = btn.dataset.tab as KeyTab;
      _scheduleSavedSnapshot = null; // reset schedule dirty tracking on tab switch
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
    if (currentView === String(slotNum)) {
      // Update header title with level badge after stats load
      const titleEl = document.getElementById("page-title") as HTMLHeadingElement | null;
      const s = slotByView(currentView);
      const stats = cachedStats[slotNum];
      const levelHtml = stats?.level ? ` <span class="badge badge-sm badge-soft opacity-50 ml-1 align-middle">${esc(stats.level)}</span>` : "";
      if (titleEl) titleEl.innerHTML = `${esc(s.name || `Key ${slotNum}`)}${levelHtml}`;
      // Re-render stats tab if active
      if (currentKeyTab === "stats") {
        const tc = document.getElementById("tab-content") as HTMLDivElement | null;
        if (tc) renderStatsTab(tc);
      }
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
        <div class="alert alert-soft alert-error text-xs font-bold mb-2">
          Auto-disabled &middot; ${rtSlot.consecutive_errors} consecutive errors
        </div>`;
    } else if (rtSlot.consecutive_errors > 0) {
      heroHtml = `
        <div class="alert alert-dash alert-warning text-xs font-bold mb-2">
          ${rtSlot.consecutive_errors} error${rtSlot.consecutive_errors !== 1 ? "s" : ""}
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
  /* ── limits (side-by-side) ── */
  let limitsCards: string[] = [];
  for (const lim of stats.limits) {
    const label = lim.type_name === "TOKENS_LIMIT" ? "Tokens" : "Requests";
    const resetStr = lim.next_reset_hms ?? "\u2014";
    const usedStr = lim.current_value != null ? formatTokens(lim.current_value) : "\u2014";
    const capStr = lim.usage != null ? formatTokens(lim.usage) : "";
    // remaining logic kept for future use
    const _remainStr = lim.remaining != null ? formatTokens(lim.remaining) : "";
    void _remainStr;

    limitsCards.push(`
      <div class="card bg-base-100 card-border border-base-300 card-sm flex-1 min-w-0">
        <div class="card-body p-3 gap-1 items-center">
          ${radialGauge(lim.percentage, 48, 4)}
          <span class="text-xs font-semibold mt-1">${label}</span>
          <div class="flex items-baseline gap-1">
            <span class="text-sm font-bold">${usedStr}</span>
            ${capStr ? `<span class="text-[10px] opacity-40">/ ${capStr}</span>` : ""}
          </div>
          <span class="text-[10px] opacity-30">Reset ${resetStr}</span>
        </div>
      </div>`);
  }
  const limitsHtml = `<div class="flex gap-2">${limitsCards.join("")}</div>`;

  /* ── 24h usage summary using DaisyUI stats ── */
  const usageHtml = `
    <div class="card bg-base-100 card-border border-base-300 w-full">
      <div class="stats bg-base-100 w-full overflow-hidden">
        <div class="stat py-3 px-4 flex flex-col items-center justify-center">
          <div class="stat-title text-[10px] text-center">Model Calls</div>
          <div class="stat-value text-lg text-center">${stats.total_model_calls_24h.toLocaleString()}</div>
          <div class="stat-desc opacity-40 text-center">24h window</div>
        </div>
        <div class="stat py-3 px-4 flex flex-col items-center justify-center">
          <div class="stat-title text-[10px] text-center">Tokens</div>
          <div class="stat-value text-lg text-center">${formatTokens(stats.total_tokens_24h)}</div>
          <div class="stat-desc opacity-40 text-center">24h window</div>
        </div>
      </div>
    </div>`;

  /* ── tool usage removed ── */

  tc.innerHTML = `
    ${heroHtml}
    <div class="mt-0">${usageHtml}</div>
    <div class="mt-2">${limitsHtml}</div>
    <button class="btn btn-sm btn-ghost btn-block opacity-30 mt-1 refresh-stats-btn">Refresh</button>`;

  tc.querySelector(".refresh-stats-btn")?.addEventListener("click", () => {
    delete cachedStats[slotNum];
    renderStatsTab(tc);
  });
}

/* ======== Schedule Tab ======== */

let _scheduleSavedSnapshot: {
  wake_enabled: boolean;
  wake_mode: WakeMode;
  wake_interval_minutes: number;
  wake_after_reset_minutes: number;
  wake_times: string[];
} | null = null;

function renderScheduleTab(tc: HTMLDivElement, preserveSnapshot = false) {
  const s = slotByView(currentView);
  const times = [0, 1, 2, 3, 4].map((i) => s.wake_times[i] ?? "");
  const intervalCls = s.wake_mode === "interval" ? "" : "hidden";
  const timesCls = s.wake_mode === "times" ? "" : "hidden";
  const resetCls = s.wake_mode === "after_reset" ? "" : "hidden";

  // Only snapshot the "saved" state on first render (not wake-mode toggles)
  if (!preserveSnapshot || !_scheduleSavedSnapshot) {
    _scheduleSavedSnapshot = {
      wake_enabled: s.wake_enabled,
      wake_mode: s.wake_mode,
      wake_interval_minutes: s.wake_interval_minutes,
      wake_after_reset_minutes: s.wake_after_reset_minutes,
      wake_times: [...s.wake_times],
    };
  }
  const snapshot = _scheduleSavedSnapshot;

  tc.innerHTML = `
    <form id="schedule-form" class="flex flex-col gap-3">
      <div class="card bg-base-100 card-border border-base-300 card-sm overflow-hidden">
        <div class="border-base-300 border-b border-dashed">
          <div class="flex items-center gap-2 p-4">
            <div class="grow">
              <div class="flex items-center gap-2 text-sm font-medium">
                <svg class="w-5 h-5 opacity-40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
                  <circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>
                </svg>
                Wake Schedule
              </div>
              <p class="text-xs opacity-50 mt-0.5">One strategy per key.</p>
            </div>
          </div>
        </div>
        <div class="card-body p-4 gap-3">
          <label class="flex cursor-pointer items-center gap-2.5 text-sm">
            <input id="wake-enabled" type="checkbox" class="toggle toggle-sm toggle-primary" ${s.wake_enabled ? "checked" : ""} />
            Enable wake requests
          </label>

          <label class="text-xs font-medium opacity-60 mb-0.5 block">Wake mode</label>
          <select id="wake-mode" class="select select-sm select-border w-full">
            <option value="interval" ${s.wake_mode === "interval" ? "selected" : ""}>Every N minutes</option>
            <option value="times" ${s.wake_mode === "times" ? "selected" : ""}>Specific times each day</option>
            <option value="after_reset" ${s.wake_mode === "after_reset" ? "selected" : ""}>After reset + offset</option>
          </select>

          <div id="wake-interval-wrap" class="${intervalCls}">
            <label class="text-xs font-medium opacity-60 mb-1 block">Wake every (minutes)</label>
            <input id="wake-interval" type="number" class="input input-sm input-border w-full" min="1" step="1" value="${s.wake_interval_minutes}" />
          </div>
          <div id="wake-times-wrap" class="${timesCls}">
            <p class="text-xs opacity-50 mb-2">Up to 5 times, 24h HH:MM.</p>
            <div class="grid grid-cols-3 gap-1.5">
              <input class="input input-sm input-border wake-time" data-index="0" type="text" placeholder="08:30" value="${esc(times[0])}" />
              <input class="input input-sm input-border wake-time" data-index="1" type="text" placeholder="12:00" value="${esc(times[1])}" />
              <input class="input input-sm input-border wake-time" data-index="2" type="text" placeholder="15:30" value="${esc(times[2])}" />
              <input class="input input-sm input-border wake-time" data-index="3" type="text" placeholder="18:00" value="${esc(times[3])}" />
              <input class="input input-sm input-border wake-time" data-index="4" type="text" placeholder="22:15" value="${esc(times[4])}" />
            </div>
          </div>
          <div id="wake-after-reset-wrap" class="${resetCls}">
            <label class="text-xs font-medium opacity-60 mb-1 block">Minutes after reset</label>
            <input id="wake-after-reset" type="number" class="input input-sm input-border w-full" min="1" step="1" value="${s.wake_after_reset_minutes}" />
          </div>
        </div>
      </div>

      <button type="submit" class="btn btn-primary btn-block hidden" id="schedule-save-btn">Save Schedule</button>
      <p id="schedule-toast" class="text-success text-xs text-center font-medium hidden">Schedule saved</p>
      <p id="form-error" class="text-error font-semibold text-sm text-center" hidden></p>
    </form>`;

  const form = document.getElementById("schedule-form") as HTMLFormElement;
  const saveBtn = document.getElementById("schedule-save-btn") as HTMLButtonElement;

  function getFormTimes(): string[] {
    return Array.from(document.querySelectorAll<HTMLInputElement>(".wake-time"))
      .map((el) => el.value.trim())
      .filter((v) => v.length > 0)
      .slice(0, 5);
  }

  function isScheduleDirty(): boolean {
    const wakeEnabled = (document.getElementById("wake-enabled") as HTMLInputElement).checked;
    const wakeMode = (document.getElementById("wake-mode") as HTMLSelectElement).value as WakeMode;
    const interval = Math.max(1, Number((document.getElementById("wake-interval") as HTMLInputElement).value) || 1);
    const afterReset = Math.max(1, Number((document.getElementById("wake-after-reset") as HTMLInputElement).value) || 1);
    const times = getFormTimes();

    return wakeEnabled !== snapshot.wake_enabled
      || wakeMode !== snapshot.wake_mode
      || interval !== snapshot.wake_interval_minutes
      || afterReset !== snapshot.wake_after_reset_minutes
      || times.join(",") !== snapshot.wake_times.join(",");
  }

  function checkDirty() {
    saveBtn.classList.toggle("hidden", !isScheduleDirty());
  }

  form.querySelectorAll("input, select").forEach((el) => {
    el.addEventListener("input", checkDirty);
    el.addEventListener("change", checkDirty);
  });

  (document.getElementById("wake-mode") as HTMLSelectElement)
    .addEventListener("change", (e) => {
      slotByView(currentView).wake_mode = (e.target as HTMLSelectElement).value as WakeMode;
      renderScheduleTab(tc, true);
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

      // Flash success toast
      const toast = document.getElementById("schedule-toast") as HTMLParagraphElement;
      toast.classList.remove("hidden");
      saveBtn.classList.add("hidden");
      setTimeout(() => toast.classList.add("hidden"), 1500);

      // Update saved snapshot
      _scheduleSavedSnapshot = {
        wake_enabled: n.wake_enabled,
        wake_mode: n.wake_mode,
        wake_interval_minutes: n.wake_interval_minutes,
        wake_after_reset_minutes: n.wake_after_reset_minutes,
        wake_times: [...n.wake_times],
      };

      render();
    });
}

/* ======== Settings Tab ======== */

function renderSettingsTab(tc: HTMLDivElement) {
  const s = slotByView(currentView);
  const platform = detectPlatform(s.quota_url);

  // Snapshot for dirty-tracking
  const snapshot = {
    name: s.name,
    api_key: s.api_key,
    platform,
    poll_interval_minutes: s.poll_interval_minutes,
    enabled: s.enabled,
    logging: s.logging,
  };

  tc.innerHTML = `
    <form id="settings-form" class="flex flex-col gap-3">
      <div class="card bg-base-100 card-border border-base-300 card-sm">
        <div class="card-body p-4 gap-3">
          <div class="flex flex-col gap-1">
            <label class="text-xs font-medium opacity-60">Name</label>
            <input id="slot-name" type="text" class="input input-sm input-border w-full" value="${esc(s.name)}" placeholder="e.g. Production" />
          </div>

          <div class="flex flex-col gap-1">
            <label class="text-xs font-medium opacity-60">API Key</label>
            <input id="api-key" type="password" class="input input-sm input-border w-full" value="${esc(s.api_key)}" placeholder="Bearer ..." autocomplete="off" />
          </div>

          <div class="flex flex-col gap-1">
            <label class="text-xs font-medium opacity-60">Platform</label>
            <div class="join w-full">
              <input class="join-item btn btn-sm flex-1" type="radio" name="platform" aria-label="Z.ai" value="zai" ${platform === "zai" ? "checked" : ""} />
              <input class="join-item btn btn-sm flex-1" type="radio" name="platform" aria-label="BigModel" value="bigmodel" ${platform === "bigmodel" ? "checked" : ""} />
            </div>
          </div>

          <div class="flex flex-col gap-1">
            <label class="text-xs font-medium opacity-60">Poll interval (minutes)</label>
            <input id="poll-interval" type="number" class="input input-sm input-border w-full" min="1" step="1" value="${s.poll_interval_minutes}" />
          </div>

          <div class="flex gap-4 mt-1">
            <label class="flex cursor-pointer items-center gap-2 text-xs">
              <input id="enabled" type="checkbox" class="toggle toggle-xs toggle-primary" ${s.enabled ? "checked" : ""} />
              Enable polling
            </label>
            <label class="flex cursor-pointer items-center gap-2 text-xs">
              <input id="logging" type="checkbox" class="toggle toggle-xs toggle-primary" ${s.logging ? "checked" : ""} />
              Logging
            </label>
          </div>
        </div>
      </div>

      <div class="card-actions grid grid-cols-2 gap-2">
        <button type="button" class="btn btn-sm" id="delete-slot-btn">Reset Slot</button>
        <button type="submit" class="btn btn-primary btn-sm hidden" id="settings-save-btn">Save</button>
      </div>
      <p id="save-toast" class="text-success text-xs text-center font-medium hidden">Settings saved</p>
      <p id="form-error" class="text-error font-semibold text-sm text-center" hidden></p>
    </form>`;

  const form = document.getElementById("settings-form") as HTMLFormElement;
  const saveBtn = document.getElementById("settings-save-btn") as HTMLButtonElement;

  function isSettingsDirty(): boolean {
    const name = (document.getElementById("slot-name") as HTMLInputElement).value.trim();
    const apiKey = (document.getElementById("api-key") as HTMLInputElement).value.trim();
    const plat = (document.querySelector<HTMLInputElement>('input[name="platform"]:checked')?.value ?? "zai") as Platform;
    const poll = Math.max(1, Number((document.getElementById("poll-interval") as HTMLInputElement).value) || 30);
    const enabled = (document.getElementById("enabled") as HTMLInputElement).checked;
    const logging = (document.getElementById("logging") as HTMLInputElement).checked;

    return name !== snapshot.name
      || apiKey !== snapshot.api_key
      || plat !== snapshot.platform
      || poll !== snapshot.poll_interval_minutes
      || enabled !== snapshot.enabled
      || logging !== snapshot.logging;
  }

  function checkDirty() {
    saveBtn.classList.toggle("hidden", !isSettingsDirty());
  }

  form.querySelectorAll("input").forEach((el) => {
    el.addEventListener("input", checkDirty);
    el.addEventListener("change", checkDirty);
  });

  form.addEventListener("submit", async (e) => {
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

      // Flash success toast
      const toast = document.getElementById("save-toast") as HTMLParagraphElement;
      toast.classList.remove("hidden");
      saveBtn.classList.add("hidden");
      setTimeout(() => toast.classList.add("hidden"), 1500);

      // Update snapshot so button stays hidden until next change
      snapshot.name = n.name;
      snapshot.api_key = n.api_key;
      snapshot.platform = detectPlatform(n.quota_url);
      snapshot.poll_interval_minutes = n.poll_interval_minutes;
      snapshot.enabled = n.enabled;
      snapshot.logging = n.logging;

      render();
    });

  document.getElementById("delete-slot-btn")?.addEventListener("click", async () => {
    const n = slotByView(currentView);
    const def = defaultSlot(n.slot);
    Object.assign(n, def);
    configState = await backendInvoke<AppConfig>("save_settings", { settings: configState });
    currentView = "dashboard";
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
  const btn = document.getElementById("monitor-btn") as HTMLButtonElement | null;
  if (!btn) return;
  btn.disabled = false;
  if (monitoring) {
    btn.title = "Stop monitoring";
    btn.className = "btn btn-sm btn-square btn-error";
    btn.innerHTML = `<svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>`;
  } else {
    btn.title = "Start monitoring";
    btn.className = "btn btn-sm btn-square btn-outline";
    btn.innerHTML = `<svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>`;
  }
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
  applyTheme();
  render();

  const monBtn = document.getElementById("monitor-btn") as HTMLButtonElement;
  monBtn.disabled = true;

  monBtn.addEventListener("click", async () => {
    monBtn.disabled = true;
    const isMonitoring = latestRuntime?.monitoring ?? false;
    await backendInvoke(isMonitoring ? "stop_monitoring" : "start_monitoring");
    await refreshRuntimeStatus();
  });

  document.getElementById("warmup-btn")?.addEventListener("click", async () => {
    const warmupBtn = document.getElementById("warmup-btn") as HTMLButtonElement;
    warmupBtn.classList.add("warming-up");
    warmupBtn.disabled = true;
    try {
      await backendInvoke("warmup_all");
    } finally {
      warmupBtn.classList.remove("warming-up");
      warmupBtn.disabled = false;
    }
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
