import { currentView, latestRuntime, cachedStats, statsLoading, deleteCachedStats } from "../../state";
import { formatTokens, radialGauge, setHeaderActions, esc, slotByView } from "../../helpers";
import { loadStats } from "../../api";

export function renderStatsTab(tc: HTMLDivElement): void {
  const slotNum = Number(currentView);
  const s = slotByView(currentView);
  const rtSlot = latestRuntime?.slots.find((rs) => rs.slot === slotNum);
  const stats = cachedStats[slotNum];

  // Set header: key name with level badge + refresh button
  const levelHtml = stats?.level ? ` <span class="badge badge-sm badge-soft opacity-50 ml-1 align-middle">${esc(stats.level)}</span>` : "";
  setHeaderActions(`
    <span class="text-sm font-normal opacity-60">${esc(s.name || `Key ${slotNum}`)}${levelHtml}</span>
    <button class="btn btn-xs btn-ghost btn-circle refresh-header-btn" title="Refresh stats">
      <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/>
        <path d="M3 3v5h5"/>
        <path d="M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16"/>
        <path d="M16 16h5v5"/>
      </svg>
    </button>
  `);

  // Add refresh button handler
  setTimeout(() => {
    document.querySelector(".refresh-header-btn")?.addEventListener("click", () => {
      deleteCachedStats(slotNum);
      renderStatsTab(tc);
    });
  }, 0);

  /* status hero */
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

  /* loading state */
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

  /* limits */
  let limitsCards: string[] = [];
  for (const lim of stats.limits) {
    const label = lim.type_name === "TOKENS_LIMIT" ? "Tokens" : "Requests";
    const resetStr = lim.next_reset_hms ?? "\u2014";
    const resetLabel = (lim.unit ?? 3) <= 3 ? "Reset" : "Resets";
    const usedStr = lim.current_value != null ? formatTokens(lim.current_value) : "\u2014";
    const capStr = lim.usage != null ? formatTokens(lim.usage) : "";

    limitsCards.push(`
      <div class="card bg-base-100 card-border border-base-300 card-sm flex-1 min-w-0">
        <div class="card-body p-3 gap-1 items-center">
          ${radialGauge(lim.percentage, 48, 4)}
          <span class="text-xs font-semibold mt-1">${label}</span>
          <div class="flex items-baseline gap-1">
            <span class="text-sm font-bold">${usedStr}</span>
            ${capStr ? `<span class="text-[10px] opacity-40">/ ${capStr}</span>` : ""}
          </div>
          <span class="text-[10px] opacity-30">${resetLabel} ${resetStr}</span>
        </div>
      </div>`);
  }
  const limitsHtml = `<div class="flex gap-2">${limitsCards.join("")}</div>`;

  /* 24h usage */
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

  tc.innerHTML = `
    ${heroHtml}
    <div class="mt-0">${usageHtml}</div>
    <div class="mt-2">${limitsHtml}</div>`;
}
