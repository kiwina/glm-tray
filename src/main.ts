// Main entry point - imports and initializes the modularized app
import { listen } from "@tauri-apps/api/event";
import { getVersion } from "@tauri-apps/api/app";
import { openUrl } from "@tauri-apps/plugin-opener";

import type { AppConfig, QuotaUpdateEvent } from "./lib/types";
import { isTauriRuntime } from "./lib/constants";
import { setConfigState, setAppVersion, currentView, currentKeyTab, deleteCachedStats, latestRuntime } from "./lib/state";
import { applyTheme } from "./lib/helpers";
import { backendInvoke, refreshRuntimeStatus, hasEnabledSlotWithKey, syncMonitorButtons } from "./lib/api";
import { createSidebar } from "./lib/sidebar";
import { render } from "./lib/views/render";
import { renderStatsTab } from "./lib/views/tabs/stats";
import { checkAndShowUpdate } from "./lib/update";

function syncWarmupButton(): void {
  const warmupBtn = document.getElementById("warmup-btn") as HTMLButtonElement | null;
  if (!warmupBtn) return;
  const hasEnabledSlot = hasEnabledSlotWithKey();
  warmupBtn.disabled = !hasEnabledSlot;
  warmupBtn.title = hasEnabledSlot
    ? "Wake keys that are not ready"
    : "Add an API key first";
}

window.addEventListener("DOMContentLoaded", async () => {
  createSidebar();

  // Fetch app version
  if (isTauriRuntime) {
    try {
      const version = await getVersion();
      setAppVersion(version);
    } catch {
      setAppVersion("dev");
    }
  } else {
    setAppVersion("preview");
  }

  const config = await backendInvoke<AppConfig>("load_settings");
  setConfigState(config);
  applyTheme();
  render();
  syncWarmupButton();

  const monBtn = document.getElementById("monitor-btn") as HTMLButtonElement;
  monBtn.disabled = true;

  monBtn.addEventListener("click", async () => {
    monBtn.disabled = true;
    if (!hasEnabledSlotWithKey() && !latestRuntime?.monitoring) {
      syncMonitorButtons();
      return;
    }

    try {
      const isMonitoring = latestRuntime?.monitoring ?? false;
      await backendInvoke(isMonitoring ? "stop_monitoring" : "start_monitoring");
      await refreshRuntimeStatus();
      syncMonitorButtons();
    } catch (err) {
      console.warn("monitoring command failed:", err);
      await refreshRuntimeStatus().catch(() => syncMonitorButtons());
    } finally {
      monBtn.disabled = false;
    }
  });

  document.getElementById("warmup-btn")?.addEventListener("click", async () => {
    const warmupBtn = document.getElementById("warmup-btn") as HTMLButtonElement;
    if (!hasEnabledSlotWithKey()) {
      syncWarmupButton();
      return;
    }
    warmupBtn.classList.add("warming-up");
    warmupBtn.disabled = true;
    try {
      await backendInvoke("warmup_all");
    } finally {
      warmupBtn.classList.remove("warming-up");
      syncWarmupButton();
      warmupBtn.disabled = false;
    }
  });

  document.getElementById("global-settings-btn")?.addEventListener("click", () => {
    render("settings");
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
  setInterval(() => void refreshRuntimeStatus().then(syncWarmupButton), 5000);

  // Listen for quota-updated events from backend and refresh stats
  if (isTauriRuntime) {
    listen<QuotaUpdateEvent>(
      "quota-updated",
      (event) => {
        const slot = event.payload.slot;
        // Invalidate cached stats for this slot
        deleteCachedStats(slot);
        // If user is viewing this slot's stats tab, trigger a refresh
        if (currentView === String(slot) && currentKeyTab === "stats") {
          const tc = document.getElementById("tab-content");
          if (tc) renderStatsTab(tc as HTMLDivElement);
        }
      }
    ).catch((err) => console.warn("Failed to listen for quota-updated:", err));

    listen<boolean>("monitoring-changed", (_event) => {
      void refreshRuntimeStatus().then(syncWarmupButton);
    }).catch((err) => console.warn("Failed to listen for monitoring changes:", err));
  }

  // Check for updates on startup (after a short delay)
  setTimeout(() => void checkAndShowUpdate(), 3000);
});
