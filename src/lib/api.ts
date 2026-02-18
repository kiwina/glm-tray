import { invoke } from "@tauri-apps/api/core";

export function backendInvoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  return invoke<T>(command, args);
}

export function logUiAction(action: string, slot?: number, details?: Record<string, unknown>): void {
  backendInvoke("log_ui_action", { action, slot, details }).catch(console.error);
}
