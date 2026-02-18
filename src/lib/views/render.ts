import type { View } from "../types";
import { currentView as getCurrentView, setCurrentView } from "../state";
import { clearHeaderActions } from "../helpers";
import { updateSidebar } from "../sidebar";
import { renderDashboard } from "./dashboard";
import { renderKeyDetailShell } from "./key-detail";
import { renderGlobalSettings } from "./global-settings";

export function render(view?: View): void {
  if (view !== undefined) {
    setCurrentView(view);
  }
  clearHeaderActions();
  updateSidebar();

  const globalSettingsBtn = document.getElementById("global-settings-btn");
  if (globalSettingsBtn) {
    if (getCurrentView === "dashboard") {
      globalSettingsBtn.classList.remove("hidden");
    } else {
      globalSettingsBtn.classList.add("hidden");
    }
  }

  if (getCurrentView === "dashboard") {
    renderDashboard();
  } else if (getCurrentView === "settings") {
    renderGlobalSettings();
  } else {
    renderKeyDetailShell();
  }
}
