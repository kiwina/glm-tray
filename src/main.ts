// Main entry point - imports and initializes the modularized app
import { listen } from "@tauri-apps/api/event";
import { getVersion } from "@tauri-apps/api/app";
import { openUrl } from "@tauri-apps/plugin-opener";

import type { AppConfig, QuotaUpdateEvent } from "./lib/types";
import { isTauriRuntime } from "./lib/constants";
import { setConfigState, setAppVersion, currentView, currentKeyTab, cachedStats, latestRuntime } from "./lib/state";
import { applyTheme } from "./lib/helpers";
import { backendInvoke, refreshRuntimeStatus, hasEnabledSlotWithKey, syncMonitorButtons, logUiAction } from "./lib/api";
import { createSidebar } from "./lib/sidebar";
import { render } from "./lib/views/render";
import { renderStatsTab } from "./lib/views/tabs/stats";
import { renderDashboard } from "./lib/views/dashboard";
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
      logUiAction(isMonitoring ? "monitor-stop" : "monitor-start");
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
    logUiAction("warmup-all");
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

        // Update runtime slot data immediately (dashboard reads from here)
        if (latestRuntime) {
          const rtSlot = latestRuntime.slots.find((s) => s.slot === slot);
          if (rtSlot) {
            rtSlot.percentage = event.payload.percentage;
            rtSlot.timer_active = event.payload.timer_active;
            rtSlot.next_reset_hms = event.payload.next_reset_hms ?? rtSlot.next_reset_hms;
            rtSlot.last_updated_epoch_ms = event.payload.next_reset_epoch_ms ?? rtSlot.last_updated_epoch_ms;
            rtSlot.total_model_calls_5h = event.payload.total_model_calls_5h;
            rtSlot.total_tokens_5h = event.payload.total_tokens_5h;
            rtSlot.quota_last_updated = event.payload.quota_last_updated;
          }
        }

        // Update cached stats if they exist (stats tab reads from here)
        const existing = cachedStats[slot];
        if (existing) {
          for (const lim of existing.limits) {
            if (lim.type_name === "TOKENS_LIMIT") {
              lim.percentage = event.payload.percentage;
              lim.next_reset_hms = event.payload.next_reset_hms ?? lim.next_reset_hms;
              lim.next_reset_time = event.payload.next_reset_epoch_ms ?? lim.next_reset_time;
            }
          }
          existing.total_model_calls_5h = event.payload.total_model_calls_5h;
          existing.total_tokens_5h = event.payload.total_tokens_5h;
        }

        // Re-render the appropriate view
        if (currentView === "dashboard") {
          renderDashboard();
        } else if (currentView === String(slot) && currentKeyTab === "stats") {
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
