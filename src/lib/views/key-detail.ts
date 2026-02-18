import type { KeyTab } from "../types";
import { currentView, currentKeyTab, setCurrentKeyTab, resetScheduleSavedSnapshot } from "../state";
import { slotByView, clearHeaderActions } from "../helpers";
import { renderStatsTab } from "./tabs/stats";
import { renderScheduleTab } from "./tabs/schedule";
import { renderSettingsTab } from "./tabs/settings";
import { logUiAction } from "../api";

export function renderKeyDetailShell(): void {
  const s = slotByView(currentView);
  const hasKey = s.api_key.trim().length > 0;
  const root = document.getElementById("content-area") as HTMLDivElement;
  const titleEl = document.getElementById("page-title") as HTMLHeadingElement;
  titleEl.closest("header")?.classList.remove("hidden");

  // Set title based on current tab
  const tabTitles: Record<KeyTab, string> = {
    stats: "Stats",
    schedule: "Schedule",
    settings: "Settings",
  };
  titleEl.textContent = tabTitles[currentKeyTab];
  clearHeaderActions();

  // Force settings tab when no API key is configured
  if (!hasKey && currentKeyTab !== "settings") {
    setCurrentKeyTab("settings");
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
      const tab = btn.dataset.tab as KeyTab;
      if (tab !== currentKeyTab) {
        logUiAction("tab-switch", s.slot, { tab });
        setCurrentKeyTab(tab);
        resetScheduleSavedSnapshot();
        renderKeyDetailShell();
      }
    });
  });

  renderActiveTab();
}

export function renderActiveTab(): void {
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
