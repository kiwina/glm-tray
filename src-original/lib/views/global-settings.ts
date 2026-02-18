import type { AppConfig } from "../types";
import { appVersion, configState, latestRuntime, setConfigState } from "../state";
import { backendInvoke } from "../api";
import { clearHeaderActions, defaultConfig, normalizeConfig } from "../helpers";
import { render } from "./render";

export function renderGlobalSettings(): void {
  const root = document.getElementById("content-area") as HTMLDivElement;
  const cfg = configState
    ? normalizeConfig(configState)
    : normalizeConfig(defaultConfig());

  clearHeaderActions();

  const titleEl = document.getElementById("page-title") as HTMLHeadingElement | null;
  if (titleEl) {
    titleEl.closest("header")?.classList.add("hidden");
  }

  const enabledSlots = cfg.slots.filter((slot) => slot.enabled).length;
  const status = latestRuntime?.monitoring ? "Monitoring" : "Idle";

  // Check if running in debug mode (localhost URLs)
  const isDebugMode = cfg.global_quota_url.includes("localhost") || cfg.global_quota_url.startsWith("http://");
  const debugModeHtml = isDebugMode
    ? `<div class="alert alert-soft alert-warning text-xs font-bold">
        <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"/>
        </svg>
        <span>Debug mode - using mock server at ${cfg.global_quota_url.replace("/api/monitor/usage/quota/limit", "")}</span>
      </div>`
    : "";

  root.innerHTML = `
    <div class="flex flex-col h-full">
      <div class="overflow-y-auto p-4 main-content">
        ${debugModeHtml}
        <form id="global-settings-form" class="flex flex-col gap-4 ${isDebugMode ? 'mt-2' : ''}">
          <div class="card bg-base-100 card-border border-base-300 card-sm">
            <div class="card-body p-4 gap-2">
              <p class="text-xs font-semibold opacity-70">Runtime behavior</p>
              <div class="flex justify-between items-center">
                <span class="text-xs">Wake confirmation window (minutes)</span>
                <input id="global-wake-retry-window" class="input input-sm input-bordered w-20" type="number" min="1" max="1440" value="${cfg.wake_quota_retry_window_minutes}" />
              </div>
              <div class="flex justify-between items-center">
                <span class="text-xs">Max consecutive errors</span>
                <input id="global-max-consecutive-errors" class="input input-sm input-bordered w-20" type="number" min="1" max="1000" value="${cfg.max_consecutive_errors}" />
              </div>
              <div class="flex justify-between items-center">
                <span class="text-xs">Quota backoff max (minutes)</span>
                <input id="global-quota-backoff-cap" class="input input-sm input-bordered w-20" type="number" min="1" max="1440" value="${cfg.quota_poll_backoff_cap_minutes}" />
              </div>
            </div>
          </div>

          <div class="card bg-base-100 card-border border-base-300 card-sm">
            <div class="card-body p-4 gap-2">
              <p class="text-xs font-semibold opacity-70">Logging</p>
              <div class="form-control">
                <label class="label py-1">
                  <span class="label-text text-xs">Log directory (optional)</span>
                </label>
                <input id="global-log-directory" class="input input-sm input-bordered w-full" type="text" placeholder="Leave blank for default app data path" value="${cfg.log_directory ?? ""}" />
                <label class="label py-1 -mt-1">
                  <span class="label-text-alt text-[10px] opacity-50">Example: /tmp/glm-tray-logs</span>
                </label>
              </div>
              <div class="flex justify-between items-center">
                <span class="text-xs">Keep log files (days)</span>
                <input id="global-log-retention" class="input input-sm input-bordered w-20" type="number" min="1" max="365" value="${cfg.max_log_days}" />
              </div>
            </div>
          </div>

          <div class="card bg-base-100 card-border border-base-300 card-sm">
            <div class="card-body p-4 gap-2">
              <p class="text-xs font-semibold opacity-70">Developer</p>
              <div class="flex justify-between items-center">
                <span class="text-xs">Debug mode (use mock server)</span>
                <input id="global-debug" type="checkbox" class="toggle toggle-sm toggle-warning" ${cfg.debug ? "checked" : ""} />
              </div>
              <div class="form-control">
                <label class="label py-1">
                  <span class="label-text text-xs">Mock server URL</span>
                </label>
                <input id="global-mock-url" class="input input-sm input-bordered w-full" type="text" placeholder="http://localhost:3456" value="${cfg.mock_url ?? ""}" />
                <label class="label py-1 -mt-1">
                  <span class="label-text-alt text-[10px] opacity-50">Run npm run dev:mock to start mock server</span>
                </label>
              </div>
            </div>
          </div>

          <div class="card bg-base-100 card-border border-base-300 card-sm">
            <div class="card-body p-4 gap-1">
              <div class="flex items-center justify-between text-sm">
                <span>Keys enabled</span>
                <span class="font-semibold">${enabledSlots}</span>
              </div>
              <div class="flex items-center justify-between text-sm">
                <span>Runtime status</span>
                <span class="font-semibold">${status}</span>
              </div>
              <div class="text-xs opacity-40">Version ${appVersion || "dev"}</div>
              <div class="text-xs opacity-40">By Kiwina with <span class="text-error">❤</span> · <a href="https://z.ai/subscribe?ic=GONVESHW5A" class="link link-hover" target="_blank" rel="noopener">Subscribe to z.ai coding plan</a></div>
            </div>
          </div>

          <p id="global-form-error" class="text-error font-semibold text-sm text-center hidden"></p>
          <button type="submit" class="btn btn-primary btn-block hidden" id="global-settings-save-btn">Save settings</button>
        </form>
      </div>
    </div>`;

  const form = document.getElementById("global-settings-form") as HTMLFormElement;
  const saveBtn = document.getElementById("global-settings-save-btn") as HTMLButtonElement;
  const errEl = document.getElementById("global-form-error") as HTMLParagraphElement;

  const snapshot = {
    log_directory: cfg.log_directory,
    max_log_days: cfg.max_log_days,
    wake_quota_retry_window_minutes: cfg.wake_quota_retry_window_minutes,
    max_consecutive_errors: cfg.max_consecutive_errors,
    quota_poll_backoff_cap_minutes: cfg.quota_poll_backoff_cap_minutes,
    debug: cfg.debug,
    mock_url: cfg.mock_url,
  };

  function readForm(): AppConfig | null {
    const logDirectory = (document.getElementById("global-log-directory") as HTMLInputElement).value.trim();
    const days = Math.floor(Number((document.getElementById("global-log-retention") as HTMLInputElement).value) || cfg.max_log_days);
    const wakeRetryWindow = Math.floor(Number((document.getElementById("global-wake-retry-window") as HTMLInputElement).value) || cfg.wake_quota_retry_window_minutes);
    const maxConsecutiveErrors = Math.floor(Number((document.getElementById("global-max-consecutive-errors") as HTMLInputElement).value) || cfg.max_consecutive_errors);
    const quotaBackoffCap = Math.floor(Number((document.getElementById("global-quota-backoff-cap") as HTMLInputElement).value) || cfg.quota_poll_backoff_cap_minutes);
    const debug = (document.getElementById("global-debug") as HTMLInputElement).checked;
    const mockUrl = (document.getElementById("global-mock-url") as HTMLInputElement).value.trim();

    if (!Number.isFinite(days) || days < 1 || days > 365) {
      errEl.textContent = "Log retention must be between 1 and 365 days";
      errEl.hidden = false;
      return null;
    }
    if (!Number.isFinite(wakeRetryWindow) || wakeRetryWindow < 1 || wakeRetryWindow > 1440) {
      errEl.textContent = "Wake confirmation window must be between 1 and 1440 minutes";
      errEl.hidden = false;
      return null;
    }
    if (!Number.isFinite(maxConsecutiveErrors) || maxConsecutiveErrors < 1 || maxConsecutiveErrors > 1000) {
      errEl.textContent = "Max consecutive errors must be between 1 and 1000";
      errEl.hidden = false;
      return null;
    }
    if (!Number.isFinite(quotaBackoffCap) || quotaBackoffCap < 1 || quotaBackoffCap > 1440) {
      errEl.textContent = "Quota backoff max must be between 1 and 1440 minutes";
      errEl.hidden = false;
      return null;
    }

    const next = normalizeConfig({
      ...cfg,
      log_directory: logDirectory ? logDirectory : undefined,
      max_log_days: days,
      wake_quota_retry_window_minutes: wakeRetryWindow,
      max_consecutive_errors: maxConsecutiveErrors,
      quota_poll_backoff_cap_minutes: quotaBackoffCap,
      debug,
      mock_url: mockUrl ? mockUrl : null,
    } as AppConfig);
    errEl.hidden = true;
    return next;
  }

  function isDirty(): boolean {
    const next = readForm();
    if (!next) return false;
    return (
      (next.log_directory ?? "") !== (snapshot.log_directory ?? "") ||
      next.max_log_days !== snapshot.max_log_days ||
      next.wake_quota_retry_window_minutes !== snapshot.wake_quota_retry_window_minutes ||
      next.max_consecutive_errors !== snapshot.max_consecutive_errors ||
      next.quota_poll_backoff_cap_minutes !== snapshot.quota_poll_backoff_cap_minutes ||
      next.debug !== snapshot.debug ||
      (next.mock_url ?? "") !== (snapshot.mock_url ?? "")
    );
  }

  function checkDirty(): void {
    saveBtn.classList.toggle("hidden", !isDirty());
  }

  form.querySelectorAll("input").forEach((input) => {
    input.addEventListener("input", checkDirty);
    input.addEventListener("change", checkDirty);
  });

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    errEl.hidden = true;

    const nextConfig = readForm();
    if (!nextConfig) {
      return;
    }

    // keep current per-slot settings untouched while updating defaults/logging config
    setConfigState(await backendInvoke<AppConfig>("save_settings", { settings: nextConfig }));
    saveBtn.classList.add("hidden");
    render();
  });
}
