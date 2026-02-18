import type { View } from "../types";
import { MAX_KEYS } from "../constants";
import { configState, latestRuntime, appVersion, cachedStats } from "../state";
import { esc, defaultConfig, dotClass, pctBarClass, formatTokens } from "../helpers";
import { render } from "./render";

export function renderDashboard(): void {
  const root = document.getElementById("content-area") as HTMLDivElement;
  const titleEl = document.getElementById("page-title") as HTMLHeadingElement;
  titleEl.textContent = "GLM Tray";
  titleEl.closest("header")?.classList.remove("hidden");

  const rt = latestRuntime ?? { monitoring: false, slots: [] };
  const config = configState ?? defaultConfig();
  const enabledSlots = config.slots.filter((s) => s.enabled);
  const errorCount = rt.slots.reduce(
    (a, s) =>
      a +
      s.quota_consecutive_errors +
      s.wake_consecutive_errors +
      (s.quota_consecutive_errors === 0 ? s.consecutive_errors : 0),
    0,
  );

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
    } else if (rtSlot?.wake_auto_disabled) {
      rightSide = `<span class="badge badge-sm badge-soft badge-warning">WAKE PAUSED</span>`;
    } else if (rtSlot && rtSlot.percentage != null) {
      const pct = rtSlot.percentage;
      const reset = rtSlot.next_reset_hms ?? "--:--:--";
      const quotaErrBadge =
        rtSlot.quota_consecutive_errors > 0
          ? `<span class="badge badge-error badge-xs">quota \u00D7${rtSlot.quota_consecutive_errors}</span>`
        : "";
      const wakeErrBadge =
        rtSlot.wake_consecutive_errors > 0
          ? `<span class="badge badge-warning badge-xs">wake \u00D7${rtSlot.wake_consecutive_errors}</span>`
          : "";
      rightSide = `
        <progress class="progress ${pctBarClass(pct)} w-14" value="${pct}" max="100"></progress>
        <span class="text-sm font-bold tabular-nums min-w-8 text-right">${pct}%</span>
        <span class="text-[10px] opacity-40 tabular-nums">${reset}</span>
        ${quotaErrBadge}${wakeErrBadge}`;
    } else {
      rightSide = `<span class="text-xs opacity-30">waiting\u2026</span>`;
    }

    html += `
      <div class="border-t-base-content/5 flex items-center gap-2.5 border-t border-dashed py-2.5 px-1 cursor-pointer hover:bg-base-content/[.03] transition key-row" data-slot="${slot.slot}">
        <span class="w-2 h-2 rounded-full shrink-0 ${dc}"></span>
        <span class="text-sm font-semibold whitespace-nowrap min-w-[60px]">${esc(name)}</span>
        <div class="flex items-center gap-2 ml-auto shrink-0">${rightSide}</div>
      </div>`;

    // Demo stats boxes below each key
    const stats = cachedStats[slot.slot];
    const pct = rtSlot?.percentage ?? 0;
    const reset = rtSlot?.next_reset_hms ?? "--:--:--";
    const calls = stats?.total_model_calls_5h ?? 0;
    const tokens = stats?.total_tokens_5h ?? 0;

    html += `
      <div class="border-t-base-content/5 border-t border-dashed px-1 pb-2">
        <div class="stats bg-base-100 w-full overflow-hidden shadow-sm border border-base-300 rounded-lg">
          <div class="stat py-2 px-3 flex flex-col items-center justify-center">
            <div class="stat-title text-[9px] text-center opacity-50">Used</div>
            <div class="stat-value text-base text-center">${pct}%</div>
          </div>
          <div class="stat py-2 px-3 flex flex-col items-center justify-center">
            <div class="stat-title text-[9px] text-center opacity-50">Requests</div>
            <div class="stat-value text-base text-center">${calls.toLocaleString()}</div>
          </div>
          <div class="stat py-2 px-3 flex flex-col items-center justify-center">
            <div class="stat-title text-[9px] text-center opacity-50">Tokens</div>
            <div class="stat-value text-base text-center">${formatTokens(tokens)}</div>
          </div>
        </div>
        <div class="text-[9px] opacity-40 text-center mt-1">Resets in ${reset}</div>
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

  html += `<div class="text-center text-[10px] opacity-20 mt-3 pb-1">v${appVersion || "dev"}</div>`;
  html += `</div>`;

  root.innerHTML = html;

  root.querySelectorAll<HTMLDivElement>(".key-row").forEach((row) => {
    row.addEventListener("click", () => {
      const s = row.dataset.slot;
      if (s) {
        render(s as View);
      }
    });
  });

  root.querySelectorAll<HTMLDivElement>(".add-key-row").forEach((row) => {
    row.addEventListener("click", () => {
      const s = row.dataset.slot;
      if (s) {
        render(s as View);
      }
    });
  });
}
