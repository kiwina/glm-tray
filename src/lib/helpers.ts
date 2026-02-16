import type { KeySlotConfig, AppConfig, RuntimeStatus, View } from "./types";
import { KEY_RANGE } from "./constants";
import { configState } from "./state";

export function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

export function defaultSlot(slot: number): KeySlotConfig {
  return {
    slot,
    name: "",
    enabled: false,
    api_key: "",
    quota_url: "https://api.z.ai/api/monitor/usage/quota/limit",
    request_url: "https://api.z.ai/api/coding/paas/v4/chat/completions",
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

export function defaultConfig(): AppConfig {
  return { slots: KEY_RANGE.map((s) => defaultSlot(s)), theme: "glm" };
}

export function defaultRuntimeStatus(): RuntimeStatus {
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

export function normalizeConfig(config: AppConfig): AppConfig {
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
      schedule_interval_minutes: Math.max(
        1,
        Number(current.schedule_interval_minutes) || 60,
      ),
      schedule_after_reset_minutes: Math.max(
        1,
        Number(current.schedule_after_reset_minutes) || 1,
      ),
      schedule_times: (current.schedule_times ?? []).slice(0, 5),
    };
  });
  return { slots, theme: config.theme ?? "glm" };
}

export function applyTheme(): void {
  document.documentElement.setAttribute("data-theme", "glm");
}

export function isValidHm(value: string): boolean {
  return /^([01]\d|2[0-3]):([0-5]\d)$/.test(value);
}

export function slotByView(view: View): KeySlotConfig {
  if (!configState) throw new Error("Configuration is not loaded.");
  const idx = Number(view);
  const found = configState.slots.find((s) => s.slot === idx);
  if (!found) throw new Error(`Missing slot ${idx}`);
  return found;
}

export function pctBarClass(pct: number): string {
  if (pct >= 80) return "progress-error";
  if (pct >= 50) return "progress-warning";
  return "progress-info";
}

export function dotClass(
  slot: KeySlotConfig | undefined,
  rt: { auto_disabled?: boolean; consecutive_errors?: number; enabled?: boolean } | undefined,
): string {
  if (rt?.auto_disabled || (rt?.consecutive_errors && rt.consecutive_errors > 0))
    return "bg-error";
  if (rt?.enabled || slot?.enabled) return "bg-success";
  return "bg-base-content/20";
}

export function formatTokens(n: number): string {
  if (n >= 1_000_000_000) return (n / 1_000_000_000).toFixed(1) + "B";
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(1) + "K";
  return String(n);
}

export function radialGauge(pct: number, size = 80, stroke = 6): string {
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
}

/** Set header action buttons (clears existing) */
export function setHeaderActions(html: string): void {
  const el = document.getElementById("header-actions");
  if (el) el.innerHTML = html;
}

/** Clear header action buttons */
export function clearHeaderActions(): void {
  const el = document.getElementById("header-actions");
  if (el) el.innerHTML = "";
}

/** Build warmup button HTML for a specific slot */
export function warmupButtonHtml(slot: number): string {
  return `
    <button class="btn btn-xs btn-ghost btn-circle warmup-slot-btn" data-slot="${slot}" title="Warmup this key">
      <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/>
      </svg>
    </button>`;
}

/** Set up warmup button click handler */
export function setupWarmupButton(): void {
  const btn = document.querySelector(".warmup-slot-btn") as HTMLButtonElement;
  if (!btn) return;
  btn.addEventListener("click", async () => {
    const slot = Number(btn.dataset.slot);
    btn.classList.add("warming-up");
    btn.disabled = true;
    try {
      await import("./api").then(({ backendInvoke }) => backendInvoke("warmup_slot", { slot }));
    } finally {
      btn.classList.remove("warming-up");
      btn.disabled = false;
    }
  });
}
