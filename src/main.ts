import { invoke } from "@tauri-apps/api/core";

type WakeMode = "interval" | "times" | "after_reset";
type View = "dashboard" | "1" | "2" | "3" | "4" | "5";

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
}

interface AppConfig {
  slots: KeySlotConfig[];
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

let currentView: View = "dashboard";
let configState: AppConfig | null = null;
let previewRuntime: RuntimeStatus = { monitoring: false, slots: [] };
let latestRuntime: RuntimeStatus | null = null;

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
  };
}

function defaultConfig(): AppConfig {
  return { slots: [1, 2, 3, 4, 5].map((s) => defaultSlot(s)) };
}

function defaultRuntimeStatus(): RuntimeStatus {
  return {
    monitoring: false,
    slots: [1, 2, 3, 4, 5].map((s) => ({
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
  const slots = [1, 2, 3, 4, 5].map((index) => {
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
  return { slots };
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
  if (pct >= 80) return "high";
  if (pct >= 50) return "mid";
  return "low";
}

function dotClass(
  slot: KeySlotConfig | undefined,
  rt: SlotRuntimeStatus | undefined,
): string {
  if (rt?.auto_disabled || (rt?.consecutive_errors && rt.consecutive_errors > 0))
    return "err";
  if (rt?.enabled || slot?.enabled) return "on";
  return "off";
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
    default:
      throw new Error(`Unsupported preview command: ${command}`);
  }
}

/* ======== Sidebar ======== */

function createSidebar() {
  const nav = document.getElementById("sidebar-nav") as HTMLDivElement;
  nav.innerHTML = "";

  // Dashboard / Home
  const dashBtn = document.createElement("button");
  dashBtn.className = "nav-btn";
  dashBtn.dataset.view = "dashboard";
  dashBtn.innerHTML = `
    <svg class="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor"
         stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
      <rect x="3" y="3" width="7" height="7" rx="1"/>
      <rect x="14" y="3" width="7" height="7" rx="1"/>
      <rect x="3" y="14" width="7" height="7" rx="1"/>
      <rect x="14" y="14" width="7" height="7" rx="1"/>
    </svg>
    <span class="nav-label">Home</span>`;
  dashBtn.addEventListener("click", () => {
    currentView = "dashboard";
    render();
  });
  nav.appendChild(dashBtn);

  // Key 1-5
  for (let i = 1; i <= 5; i++) {
    const btn = document.createElement("button");
    btn.className = "nav-btn";
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
        const name = slot?.name || `Key ${idx}`;
        const dc = dotClass(slot, rt);
        const shortName =
          name.length > 8 ? name.slice(0, 7) + "\u2026" : name;

        btn.innerHTML = `
          <span class="nav-num">
            ${idx}
            <span class="nav-dot ${dc}"></span>
          </span>
          <span class="nav-label">${esc(shortName)}</span>`;
      }
    });
}

/* ======== Dashboard View ======== */

function renderDashboard() {
  const root = document.getElementById("content-area") as HTMLDivElement;
  (document.getElementById("page-title") as HTMLHeadingElement).textContent =
    "Dashboard";

  const rt = latestRuntime ?? { monitoring: false, slots: [] };
  const config = configState ?? defaultConfig();
  const enabledCount = config.slots.filter((s) => s.enabled).length;
  const errorCount = rt.slots.reduce(
    (a, s) => a + s.consecutive_errors,
    0,
  );
  const disabledCount = rt.slots.filter((s) => s.auto_disabled).length;
  const wakeCount = config.slots.filter((s) => s.wake_enabled).length;

  const monBadge = rt.monitoring
    ? `<span class="dash-monitoring-on">\u25CF Monitoring</span>`
    : `<span class="dash-monitoring-off">\u25CB Idle</span>`;

  const errorMsg =
    errorCount > 0
      ? `${errorCount} error${errorCount !== 1 ? "s" : ""} across slots`
      : "All systems normal";

  let html = `
    <div class="dash-hero">
      <div class="dash-hero-title">Quota Monitor ${monBadge}</div>
      <div class="dash-hero-summary">${enabledCount} of 5 keys active</div>
      <div class="dash-hero-sub">${errorMsg}</div>
    </div>
    <div class="dash-grid">`;

  for (let i = 1; i <= 5; i++) {
    const slot = config.slots.find((s) => s.slot === i) ?? defaultSlot(i);
    const rtSlot = rt.slots.find((s) => s.slot === i);
    const name = slot.name || `Key ${i}`;
    const dc = dotClass(slot, rtSlot);

    let body = "";
    if (!slot.enabled) {
      body = `<div class="dash-card-unconfigured">Not enabled</div>`;
    } else if (rtSlot?.auto_disabled) {
      body = `
        <div class="dash-card-disabled-label">Auto-disabled</div>
        <div class="dash-card-detail error">${rtSlot.consecutive_errors} consecutive errors</div>`;
    } else if (rtSlot && rtSlot.percentage != null) {
      const pct = rtSlot.percentage;
      body = `
        <div class="progress-pct">${pct}%</div>
        <div class="progress-wrap">
          <div class="progress-bar">
            <div class="progress-fill ${pctBarClass(pct)}" style="width:${pct}%"></div>
          </div>
        </div>
        <div class="dash-card-detail">Reset ${rtSlot.next_reset_hms ?? "--:--:--"}</div>
        ${rtSlot.consecutive_errors > 0 ? `<div class="dash-card-detail error">err \u00D7${rtSlot.consecutive_errors}</div>` : ""}`;
    } else {
      body = `<div class="dash-card-detail">Waiting for data\u2026</div>`;
    }

    html += `
      <div class="dash-card" data-slot="${i}">
        <div class="dash-card-header">
          <span class="dash-card-name">${esc(name)}</span>
          <span class="dash-card-status ${dc}"></span>
        </div>
        ${body}
      </div>`;
  }

  html += `
    </div>
    <div class="stats-row">
      <div class="stat-card">
        <span class="stat-label">Active Keys</span>
        <span class="stat-value">${enabledCount}</span>
      </div>
      <div class="stat-card">
        <span class="stat-label">Total Errors</span>
        <span class="stat-value" style="color:${errorCount > 0 ? "var(--danger)" : "var(--accent)"}">${errorCount}</span>
      </div>
      <div class="stat-card">
        <span class="stat-label">Disabled</span>
        <span class="stat-value" style="color:${disabledCount > 0 ? "var(--danger)" : "var(--accent)"}">${disabledCount}</span>
      </div>
      <div class="stat-card">
        <span class="stat-label">Wake Enabled</span>
        <span class="stat-value">${wakeCount}</span>
      </div>
    </div>`;

  root.innerHTML = html;

  // Click a key card → navigate to its config
  root.querySelectorAll<HTMLDivElement>(".dash-card").forEach((card) => {
    card.addEventListener("click", () => {
      const s = card.dataset.slot;
      if (s) {
        currentView = s as View;
        render();
      }
    });
  });
}

/* ======== Key Config View ======== */

function renderKeyConfig() {
  const slotNum = Number(currentView);
  const s = slotByView(currentView);
  const root = document.getElementById("content-area") as HTMLDivElement;
  (document.getElementById("page-title") as HTMLHeadingElement).textContent =
    s.name || `Key ${slotNum}`;

  const times = [0, 1, 2, 3, 4].map((i) => s.wake_times[i] ?? "");
  const intervalCls = s.wake_mode === "interval" ? "" : "hidden";
  const timesCls = s.wake_mode === "times" ? "" : "hidden";
  const resetCls = s.wake_mode === "after_reset" ? "" : "hidden";

  // Runtime status card (shown when key has data)
  const rtSlot = latestRuntime?.slots.find((rs) => rs.slot === slotNum);
  let statusCard = "";
  if (rtSlot && rtSlot.enabled) {
    if (rtSlot.auto_disabled) {
      statusCard = `
        <div class="card">
          <div class="dash-card-disabled-label">Auto-disabled (${rtSlot.consecutive_errors} errors)</div>
        </div>`;
    } else if (rtSlot.percentage != null) {
      const pct = rtSlot.percentage;
      statusCard = `
        <div class="card">
          <div class="key-status-header">
            <span class="progress-pct">${pct}%</span>
            <span class="dash-card-detail">Reset ${rtSlot.next_reset_hms ?? "--:--:--"}</span>
          </div>
          <div class="progress-wrap">
            <div class="progress-bar">
              <div class="progress-fill ${pctBarClass(pct)}" style="width:${pct}%"></div>
            </div>
          </div>
          ${rtSlot.consecutive_errors > 0 ? `<div class="dash-card-detail error" style="margin-top:6px">err \u00D7${rtSlot.consecutive_errors}</div>` : ""}
        </div>`;
    }
  }

  root.innerHTML = `
    <form id="slot-form" class="slot-form">
      ${statusCard}
      <div class="card">
        <h2>Configuration</h2>
        <p class="hint">Credentials and polling settings.</p>
        <div class="field">
          <label>Name
            <input id="slot-name" type="text" value="${esc(s.name)}" placeholder="e.g. Production" />
          </label>
        </div>
        <div class="field">
          <label>API Key
            <input id="api-key" type="password" value="${esc(s.api_key)}" placeholder="Bearer ..." autocomplete="off" />
          </label>
        </div>
        <div class="field">
          <label>Quota endpoint URL
            <input id="quota-url" type="url" value="${esc(s.quota_url)}" />
          </label>
        </div>
        <div class="field">
          <label>Request URL (wake endpoint)
            <input id="request-url" type="url" value="${esc(s.request_url ?? "")}" placeholder="https://..." />
          </label>
        </div>
        <div class="field">
          <label>Poll interval (minutes, min 1)
            <input id="poll-interval" type="number" min="1" step="1" value="${s.poll_interval_minutes}" />
          </label>
        </div>
        <div class="switches">
          <label class="check-row">
            <input id="enabled" type="checkbox" ${s.enabled ? "checked" : ""} />
            Enable polling
          </label>
          <label class="check-row">
            <input id="wake-enabled" type="checkbox" ${s.wake_enabled ? "checked" : ""} />
            Enable wake requests
          </label>
        </div>
      </div>

      <div class="card">
        <h2>Wake Schedule</h2>
        <p class="hint">One strategy per key.</p>
        <div class="field">
          <label>Wake mode
            <select id="wake-mode">
              <option value="interval" ${s.wake_mode === "interval" ? "selected" : ""}>Every N minutes</option>
              <option value="times" ${s.wake_mode === "times" ? "selected" : ""}>Specific times each day</option>
              <option value="after_reset" ${s.wake_mode === "after_reset" ? "selected" : ""}>After reset + offset</option>
            </select>
          </label>
        </div>
        <div id="wake-interval-wrap" class="mode-block ${intervalCls}">
          <label>Wake every (minutes)
            <input id="wake-interval" type="number" min="1" step="1" value="${s.wake_interval_minutes}" />
          </label>
        </div>
        <div id="wake-times-wrap" class="mode-block ${timesCls}">
          <p class="hint">Up to 5 times, 24h HH:MM.</p>
          <div class="times-grid">
            <input class="wake-time" data-index="0" type="text" placeholder="08:30" value="${esc(times[0])}" />
            <input class="wake-time" data-index="1" type="text" placeholder="12:00" value="${esc(times[1])}" />
            <input class="wake-time" data-index="2" type="text" placeholder="15:30" value="${esc(times[2])}" />
            <input class="wake-time" data-index="3" type="text" placeholder="18:00" value="${esc(times[3])}" />
            <input class="wake-time" data-index="4" type="text" placeholder="22:15" value="${esc(times[4])}" />
          </div>
        </div>
        <div id="wake-after-reset-wrap" class="mode-block ${resetCls}">
          <label>Minutes after reset
            <input id="wake-after-reset" type="number" min="1" step="1" value="${s.wake_after_reset_minutes}" />
          </label>
        </div>
      </div>

      <button type="submit" class="btn-primary">Save</button>
      <p id="form-error" class="form-error" hidden></p>
    </form>`;

  // Wire up wake-mode switcher
  (
    document.getElementById("wake-mode") as HTMLSelectElement
  ).addEventListener("change", (e) => {
    slotByView(currentView).wake_mode = (e.target as HTMLSelectElement)
      .value as WakeMode;
    renderKeyConfig();
  });

  // Wire up form submit
  (
    document.getElementById("slot-form") as HTMLFormElement
  ).addEventListener("submit", async (e) => {
    e.preventDefault();
    const errEl = document.getElementById(
      "form-error",
    ) as HTMLParagraphElement;
    errEl.hidden = true;

    const n = slotByView(currentView);
    n.name = (
      document.getElementById("slot-name") as HTMLInputElement
    ).value.trim();
    n.api_key = (
      document.getElementById("api-key") as HTMLInputElement
    ).value.trim();
    n.quota_url = (
      document.getElementById("quota-url") as HTMLInputElement
    ).value.trim();
    const rUrl = (
      document.getElementById("request-url") as HTMLInputElement
    ).value.trim();
    n.request_url = rUrl.length > 0 ? rUrl : null;
    n.poll_interval_minutes = Math.max(
      1,
      Number(
        (document.getElementById("poll-interval") as HTMLInputElement).value,
      ) || 30,
    );
    n.enabled = (
      document.getElementById("enabled") as HTMLInputElement
    ).checked;
    n.wake_enabled = (
      document.getElementById("wake-enabled") as HTMLInputElement
    ).checked;
    n.wake_mode = (document.getElementById("wake-mode") as HTMLSelectElement)
      .value as WakeMode;
    n.wake_interval_minutes = Math.max(
      1,
      Number(
        (document.getElementById("wake-interval") as HTMLInputElement).value,
      ) || 1,
    );
    n.wake_after_reset_minutes = Math.max(
      1,
      Number(
        (document.getElementById("wake-after-reset") as HTMLInputElement)
          .value,
      ) || 1,
    );

    const wakeTimes = Array.from(
      document.querySelectorAll<HTMLInputElement>(".wake-time"),
    )
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

    configState = await backendInvoke<AppConfig>("save_settings", {
      settings: configState,
    });
    render();
  });
}

/* ======== Render Orchestrator ======== */

function render() {
  updateSidebar();
  if (currentView === "dashboard") {
    renderDashboard();
  } else {
    renderKeyConfig();
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
  // Only refresh dashboard automatically — key config form would lose user input
  if (currentView === "dashboard") {
    renderDashboard();
  }
}

/* ======== Init ======== */

window.addEventListener("DOMContentLoaded", async () => {
  createSidebar();
  configState = await backendInvoke<AppConfig>("load_settings");
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

  document.getElementById("warmup-btn")?.addEventListener("click", async () => {
    await backendInvoke("warmup_all");
  });

  await refreshRuntimeStatus();
  setInterval(() => void refreshRuntimeStatus(), 5000);
});
