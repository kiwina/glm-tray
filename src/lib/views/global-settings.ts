import type { AppConfig } from "../types";
import { appVersion, configState, latestRuntime, setConfigState } from "../state";
import { backendInvoke } from "../api";
import { clearHeaderActions, defaultConfig, normalizeConfig } from "../helpers";
import { render } from "./render";

export function renderGlobalSettings(): void {
  const root = document.getElementById("content-area") as HTMLDivElement;
  const titleEl = document.getElementById("page-title") as HTMLHeadingElement | null;
  const cfg = configState
    ? normalizeConfig(configState)
    : normalizeConfig(defaultConfig());

  clearHeaderActions();

  if (titleEl) {
    titleEl.textContent = "Settings";
  }

  const enabledSlots = cfg.slots.filter((slot) => slot.enabled).length;
  const status = latestRuntime?.monitoring ? "Monitoring" : "Idle";

  root.innerHTML = `
    <div class="flex flex-col h-full">
      <div class="overflow-y-auto p-4 main-content">
        <form id="global-settings-form" class="flex flex-col gap-4">
          <div class="card bg-base-100 card-border border-base-300 card-sm">
            <div class="card-body p-4 gap-3">
              <p class="text-xs font-semibold opacity-70">Application defaults</p>
              <div class="form-control">
                <label class="label py-1">
                  <span class="label-text text-xs">Default quota URL</span>
                </label>
                <input id="global-quota-url" class="input input-sm input-bordered w-full" type="text" value="${cfg.global_quota_url}" />
              </div>
              <div class="form-control">
                <label class="label py-1">
                  <span class="label-text text-xs">Default LLM URL</span>
                </label>
                <input id="global-request-url" class="input input-sm input-bordered w-full" type="text" value="${cfg.global_request_url}" />
              </div>
              <p class="text-[10px] opacity-40">These defaults are used for new slots and validation fallbacks.</p>
            </div>
          </div>

          <div class="card bg-base-100 card-border border-base-300 card-sm">
            <div class="card-body p-4 gap-3">
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
              <div class="form-control">
                <label class="label py-1">
                  <span class="label-text text-xs">Keep log files (days)</span>
                </label>
                <input id="global-log-retention" class="input input-sm input-bordered w-24" type="number" min="1" max="365" value="${cfg.max_log_days}" />
              </div>
              <div class="form-control">
                <label class="label py-1">
                  <span class="label-text text-xs">Wake confirmation window (minutes)</span>
                </label>
                <input id="global-wake-retry-window" class="input input-sm input-bordered w-24" type="number" min="1" max="1440" value="${cfg.wake_quota_retry_window_minutes}" />
              </div>
              <div class="form-control">
                <label class="label py-1">
                  <span class="label-text text-xs">Max consecutive errors</span>
                </label>
                <input id="global-max-consecutive-errors" class="input input-sm input-bordered w-24" type="number" min="1" max="1000" value="${cfg.max_consecutive_errors}" />
              </div>
              <div class="form-control">
                <label class="label py-1">
                  <span class="label-text text-xs">Quota backoff max (minutes)</span>
                </label>
                <input id="global-quota-backoff-cap" class="input input-sm input-bordered w-24" type="number" min="1" max="1440" value="${cfg.quota_poll_backoff_cap_minutes}" />
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
    global_quota_url: cfg.global_quota_url,
    global_request_url: cfg.global_request_url,
    log_directory: cfg.log_directory,
    max_log_days: cfg.max_log_days,
    wake_quota_retry_window_minutes: cfg.wake_quota_retry_window_minutes,
    max_consecutive_errors: cfg.max_consecutive_errors,
    quota_poll_backoff_cap_minutes: cfg.quota_poll_backoff_cap_minutes,
  };

  function readForm(): AppConfig | null {
    const quotaUrl = (document.getElementById("global-quota-url") as HTMLInputElement).value.trim();
    const requestUrl = (document.getElementById("global-request-url") as HTMLInputElement).value.trim();
    const logDirectory = (document.getElementById("global-log-directory") as HTMLInputElement).value.trim();
    const days = Math.floor(Number((document.getElementById("global-log-retention") as HTMLInputElement).value) || cfg.max_log_days);
    const wakeRetryWindow = Math.floor(Number((document.getElementById("global-wake-retry-window") as HTMLInputElement).value) || cfg.wake_quota_retry_window_minutes);
    const maxConsecutiveErrors = Math.floor(Number((document.getElementById("global-max-consecutive-errors") as HTMLInputElement).value) || cfg.max_consecutive_errors);
    const quotaBackoffCap = Math.floor(Number((document.getElementById("global-quota-backoff-cap") as HTMLInputElement).value) || cfg.quota_poll_backoff_cap_minutes);

    if (!quotaUrl || !quotaUrl.startsWith("https://")) {
      errEl.textContent = "Default quota URL must start with https://";
      errEl.hidden = false;
      return null;
    }
    if (!requestUrl || !requestUrl.startsWith("https://")) {
      errEl.textContent = "Default LLM URL must start with https://";
      errEl.hidden = false;
      return null;
    }
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
      global_quota_url: quotaUrl,
      global_request_url: requestUrl,
      log_directory: logDirectory ? logDirectory : undefined,
      max_log_days: days,
      wake_quota_retry_window_minutes: wakeRetryWindow,
      max_consecutive_errors: maxConsecutiveErrors,
      quota_poll_backoff_cap_minutes: quotaBackoffCap,
    } as AppConfig);
    errEl.hidden = true;
    return next;
  }

  function isDirty(): boolean {
    const next = readForm();
    if (!next) return false;
    return (
      next.global_quota_url !== snapshot.global_quota_url ||
      next.global_request_url !== snapshot.global_request_url ||
      (next.log_directory ?? "") !== (snapshot.log_directory ?? "") ||
      next.max_log_days !== snapshot.max_log_days ||
      next.wake_quota_retry_window_minutes !== snapshot.wake_quota_retry_window_minutes ||
      next.max_consecutive_errors !== snapshot.max_consecutive_errors ||
      next.quota_poll_backoff_cap_minutes !== snapshot.quota_poll_backoff_cap_minutes
    );
  }

  function checkDirty(): void {
    const valid = Boolean((document.getElementById("global-quota-url") as HTMLInputElement).value.trim())
      && Boolean((document.getElementById("global-request-url") as HTMLInputElement).value.trim())
      && isDirty();
    saveBtn.classList.toggle("hidden", !valid);
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
