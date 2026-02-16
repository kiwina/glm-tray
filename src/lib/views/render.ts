import type { View } from "../types";
import { currentView as getCurrentView, setCurrentView } from "../state";
import { clearHeaderActions } from "../helpers";
import { updateSidebar } from "../sidebar";
import { renderDashboard } from "./dashboard";
import { renderKeyDetailShell } from "./key-detail";

export function render(view?: View): void {
  if (view !== undefined) {
    setCurrentView(view);
  }
  clearHeaderActions();
  updateSidebar();
  if (getCurrentView === "dashboard") {
    renderDashboard();
  } else {
    renderKeyDetailShell();
  }
}
