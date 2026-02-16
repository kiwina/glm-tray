import type { View, KeyTab, AppConfig, RuntimeStatus, SlotStats } from "./types";

// Global UI state
export let currentView: View = "dashboard";
export let currentKeyTab: KeyTab = "stats";

// App state
export let appVersion: string = "";
export let configState: AppConfig | null = null;
export let previewRuntime: RuntimeStatus = { monitoring: false, slots: [] };
export let latestRuntime: RuntimeStatus | null = null;
export let cachedStats: Record<number, SlotStats> = {};
export let statsLoading = false;

// Schedule tab state
export let scheduleSavedSnapshot: {
  wake_interval_enabled: boolean;
  wake_times_enabled: boolean;
  wake_after_reset_enabled: boolean;
  wake_interval_minutes: number;
  wake_after_reset_minutes: number;
  wake_times: string[];
} | null = null;

// Setters
export function setAppVersion(version: string): void {
  appVersion = version;
}

export function setCurrentView(view: View): void {
  currentView = view;
}

export function setCurrentKeyTab(tab: KeyTab): void {
  currentKeyTab = tab;
}

export function setConfigState(config: AppConfig | null): void {
  configState = config;
}

export function setPreviewRuntime(runtime: RuntimeStatus): void {
  previewRuntime = runtime;
}

export function setLatestRuntime(runtime: RuntimeStatus | null): void {
  latestRuntime = runtime;
}

export function setCachedStats(slot: number, stats: SlotStats): void {
  cachedStats[slot] = stats;
}

export function deleteCachedStats(slot: number): void {
  delete cachedStats[slot];
}

export function setStatsLoading(loading: boolean): void {
  statsLoading = loading;
}

export function setScheduleSavedSnapshot(snapshot: typeof scheduleSavedSnapshot): void {
  scheduleSavedSnapshot = snapshot;
}

export function resetScheduleSavedSnapshot(): void {
  scheduleSavedSnapshot = null;
}
