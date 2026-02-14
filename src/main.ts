import { invoke } from "@tauri-apps/api/core";

type WakeMode = "interval" | "times" | "after_reset";

interface KeySlotConfig {
  slot: number;
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
  enabled: boolean;
  percentage: number | null;
  next_reset_hms: string | null;
  last_error: string | null;
}

interface RuntimeStatus {
  monitoring: boolean;
  slots: SlotRuntimeStatus[];
}

const STORAGE_KEY = "glm-tray-preview-settings";
const isTauriRuntime = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

let currentTab = 1;
let configState: AppConfig | null = null;
let previewRuntime: RuntimeStatus = { monitoring: false, slots: [] };

function defaultSlot(slot: number): KeySlotConfig {
  return {
    slot,
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
  return {
    slots: [1, 2, 3, 4, 5].map((s) => defaultSlot(s)),
  };
}

function defaultRuntimeStatus(): RuntimeStatus {
  return {
    monitoring: false,
    slots: [1, 2, 3, 4, 5].map((s) => ({
      slot: s,
      enabled: false,
      percentage: null,
      next_reset_hms: null,
      last_error: null,
    })),
  };
}

async function backendInvoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  if (isTauriRuntime) {
    return invoke<T>(command, args);
  }

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
      previewRuntime.monitoring = true;
      previewRuntime.slots = config.slots.map((s) => ({
        slot: s.slot,
        enabled: s.enabled,
        percentage: s.enabled ? Math.floor(Math.random() * 100) : null,
        next_reset_hms: s.enabled ? "--:--:--" : null,
        last_error: null,
      }));
      return undefined as T;
    case "stop_monitoring":
      previewRuntime = defaultRuntimeStatus();
      return undefined as T;
    case "get_runtime_status":
      return previewRuntime as T;
    default:
      throw new Error(`Unsupported command in preview mode: ${command}`);
  }
}

function normalizeConfig(config: AppConfig): AppConfig {
  const slots = [1, 2, 3, 4, 5].map((index) => {
    const current = config.slots.find((s) => s.slot === index) ?? defaultSlot(index);
    return {
      ...current,
      slot: index,
      poll_interval_minutes: Math.max(1, Number(current.poll_interval_minutes) || 30),
      wake_interval_minutes: Math.max(1, Number(current.wake_interval_minutes) || 60),
      wake_after_reset_minutes: Math.max(1, Number(current.wake_after_reset_minutes) || 1),
      wake_times: (current.wake_times ?? []).slice(0, 5),
    };
  });
  return { slots };
}

function isValidHm(value: string): boolean {
  return /^([01]\d|2[0-3]):([0-5]\d)$/.test(value);
}

function slotByTab(tab: number): KeySlotConfig {
  if (!configState) throw new Error("Configuration is not loaded.");
  const found = configState.slots.find((s) => s.slot === tab);
  if (!found) throw new Error(`Missing slot for tab ${tab}`);
  return found;
}

function createTabs() {
  const tabs = document.getElementById("tabs") as HTMLDivElement;
  tabs.innerHTML = "";

  for (let i = 1; i <= 5; i += 1) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "tab-btn";
    btn.dataset.tab = String(i);
    btn.textContent = String(i);
    btn.addEventListener("click", () => {
      currentTab = i;
      render();
    });
    tabs.appendChild(btn);
  }
}

function renderPanel() {
  const root = document.getElementById("panels") as HTMLDivElement;
  const s = slotByTab(currentTab);
  const times = [0, 1, 2, 3, 4].map((i) => s.wake_times[i] ?? "");
  const intervalCls = s.wake_mode === "interval" ? "" : "hidden";
  const timesCls = s.wake_mode === "times" ? "" : "hidden";
  const resetCls = s.wake_mode === "after_reset" ? "" : "hidden";

  root.innerHTML = `
    <form id="slot-form" class="slot-form">
      <section class="card">
        <h2>Key ${s.slot}</h2>
        <p class="hint">Credentials and polling.</p>
        <div class="field">
          <label>API Key
            <input id="api-key" type="password" value="${s.api_key}" placeholder="Bearer ..." autocomplete="off" />
          </label>
        </div>
        <div class="field">
          <label>Quota endpoint URL
            <input id="quota-url" type="url" value="${s.quota_url}" />
          </label>
        </div>
        <div class="field">
          <label>Request URL (wake endpoint)
            <input id="request-url" type="url" value="${s.request_url ?? ""}" placeholder="https://..." />
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
      </section>

      <section class="card">
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
            <input class="wake-time" data-index="0" type="text" placeholder="08:30" value="${times[0]}" />
            <input class="wake-time" data-index="1" type="text" placeholder="12:00" value="${times[1]}" />
            <input class="wake-time" data-index="2" type="text" placeholder="15:30" value="${times[2]}" />
            <input class="wake-time" data-index="3" type="text" placeholder="18:00" value="${times[3]}" />
            <input class="wake-time" data-index="4" type="text" placeholder="22:15" value="${times[4]}" />
          </div>
        </div>

        <div id="wake-after-reset-wrap" class="mode-block ${resetCls}">
          <label>Minutes after reset
            <input id="wake-after-reset" type="number" min="1" step="1" value="${s.wake_after_reset_minutes}" />
          </label>
        </div>
      </section>

      <section class="form-actions">
        <button type="submit" class="primary">Save Slot ${s.slot}</button>
      </section>
      <p id="form-error" class="form-error" hidden></p>
    </form>
  `;

  (document.getElementById("wake-mode") as HTMLSelectElement).addEventListener("change", (e) => {
    slotByTab(currentTab).wake_mode = (e.target as HTMLSelectElement).value as WakeMode;
    renderPanel();
  });

  (document.getElementById("slot-form") as HTMLFormElement).addEventListener("submit", async (e) => {
    e.preventDefault();
    const errEl = document.getElementById("form-error") as HTMLParagraphElement;
    errEl.hidden = true;

    const n = slotByTab(currentTab);
    n.api_key = (document.getElementById("api-key") as HTMLInputElement).value.trim();
    n.quota_url = (document.getElementById("quota-url") as HTMLInputElement).value.trim();
    const rUrl = (document.getElementById("request-url") as HTMLInputElement).value.trim();
    n.request_url = rUrl.length > 0 ? rUrl : null;
    n.poll_interval_minutes = Math.max(1, Number((document.getElementById("poll-interval") as HTMLInputElement).value) || 30);
    n.enabled = (document.getElementById("enabled") as HTMLInputElement).checked;
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

function renderTabs() {
  document.querySelectorAll<HTMLButtonElement>(".tab-btn").forEach((btn) => {
    btn.classList.toggle("active", Number(btn.dataset.tab) === currentTab);
  });
}

function render() {
  renderTabs();
  renderPanel();
}

async function refreshRuntimeStatus() {
  const rt = await backendInvoke<RuntimeStatus>("get_runtime_status");
  const lines = rt.slots
    .filter((s) => s.enabled)
    .map((s) => {
      const pct = s.percentage == null ? "n/a" : `${s.percentage}%`;
      const reset = s.next_reset_hms ?? "--:--:--";
      const err = s.last_error ? ` err` : "";
      return `${s.slot}: ${pct} ${reset}${err}`;
    });

  const el = document.getElementById("runtime-status") as HTMLDivElement;
  if (lines.length === 0) {
    el.textContent = rt.monitoring ? "Monitoring (waiting...)" : "Idle";
  } else {
    el.textContent = lines.join("  \u00b7  ");
  }
}

window.addEventListener("DOMContentLoaded", async () => {
  const badge = document.getElementById("runtime-mode") as HTMLSpanElement;
  badge.textContent = isTauriRuntime ? "Tauri" : "Preview";

  createTabs();
  configState = await backendInvoke<AppConfig>("load_settings");
  render();

  document.getElementById("start-btn")?.addEventListener("click", async () => {
    await backendInvoke("start_monitoring");
    await refreshRuntimeStatus();
  });

  document.getElementById("stop-btn")?.addEventListener("click", async () => {
    await backendInvoke("stop_monitoring");
    await refreshRuntimeStatus();
  });

  await refreshRuntimeStatus();
  setInterval(() => void refreshRuntimeStatus(), 5000);
});
