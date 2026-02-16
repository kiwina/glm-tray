import type { AppConfig, Platform } from "../../types";
import { PLATFORMS, detectPlatform } from "../../constants";
import { currentView, configState, setConfigState, setCurrentView } from "../../state";
import { esc, slotByView, defaultSlot, setHeaderActions, warmupButtonHtml, setupWarmupButton } from "../../helpers";
import { backendInvoke } from "../../api";
import { render } from "../render";

export function renderSettingsTab(tc: HTMLDivElement): void {
  const s = slotByView(currentView);

  // Set header: warmup button
  setHeaderActions(warmupButtonHtml(s.slot));
  setTimeout(() => setupWarmupButton(), 0);

  const platform = detectPlatform(s.quota_url);

  // Snapshot for dirty-tracking
  const snapshot = {
    name: s.name,
    api_key: s.api_key,
    platform,
    poll_interval_minutes: s.poll_interval_minutes,
    enabled: s.enabled,
    logging: s.logging,
  };

  tc.innerHTML = `
    <form id="settings-form" class="flex flex-col gap-3">
      <div class="card bg-base-100 card-border border-base-300 card-sm">
        <div class="card-body p-4 gap-3">
          <div class="flex flex-col gap-1">
            <label class="text-xs font-medium opacity-60">Platform</label>
            <div class="join w-full">
              <input class="join-item btn btn-sm flex-1" type="radio" name="platform" aria-label="Z.ai" value="zai" ${platform === "zai" ? "checked" : ""} />
              <input class="join-item btn btn-sm flex-1" type="radio" name="platform" aria-label="BigModel" value="bigmodel" ${platform === "bigmodel" ? "checked" : ""} />
            </div>
          </div>

          <div class="flex flex-col gap-1">
            <label class="text-xs font-medium opacity-60">API Key</label>
            <input id="api-key" type="password" class="input input-sm input-border w-full" value="${esc(s.api_key)}" placeholder="Bearer ..." autocomplete="off" />
          </div>

          <div class="flex gap-3">
            <div class="flex flex-col gap-1 flex-1">
              <label class="text-xs font-medium opacity-60">Name</label>
              <input id="slot-name" type="text" class="input input-sm input-border w-full" value="${esc(s.name)}" placeholder="e.g. Production" />
            </div>
            <div class="flex flex-col gap-1 w-20">
              <label class="text-xs font-medium opacity-60">Poll (min)</label>
              <input id="poll-interval" type="number" class="input input-sm input-border w-full" min="1" step="1" value="${s.poll_interval_minutes}" />
            </div>
          </div>

          <div class="flex gap-4 mt-1">
            <label class="flex cursor-pointer items-center gap-2 text-xs">
              <input id="enabled" type="checkbox" class="toggle toggle-xs toggle-primary" ${s.enabled ? "checked" : ""} />
              Enable polling
            </label>
            <label class="flex cursor-pointer items-center gap-2 text-xs">
              <input id="logging" type="checkbox" class="toggle toggle-xs toggle-primary" ${s.logging ? "checked" : ""} />
              Logging
            </label>
          </div>
        </div>
      </div>

      <div class="card-actions grid grid-cols-2 gap-2">
        <button type="button" class="btn btn-sm" id="delete-slot-btn">Reset Slot</button>
        <button type="submit" class="btn btn-primary btn-sm hidden" id="settings-save-btn">Save</button>
      </div>
      <p id="save-toast" class="text-success text-xs text-center font-medium hidden">Settings saved</p>
      <p id="form-error" class="text-error font-semibold text-sm text-center" hidden></p>
    </form>`;

  const form = document.getElementById("settings-form") as HTMLFormElement;
  const saveBtn = document.getElementById("settings-save-btn") as HTMLButtonElement;

  function isSettingsDirty(): boolean {
    const name = (document.getElementById("slot-name") as HTMLInputElement).value.trim();
    const apiKey = (document.getElementById("api-key") as HTMLInputElement).value.trim();
    const plat = (document.querySelector<HTMLInputElement>('input[name="platform"]:checked')?.value ?? "zai") as Platform;
    const poll = Math.max(1, Number((document.getElementById("poll-interval") as HTMLInputElement).value) || 30);
    const enabled = (document.getElementById("enabled") as HTMLInputElement).checked;
    const logging = (document.getElementById("logging") as HTMLInputElement).checked;

    return name !== snapshot.name
      || apiKey !== snapshot.api_key
      || plat !== snapshot.platform
      || poll !== snapshot.poll_interval_minutes
      || enabled !== snapshot.enabled
      || logging !== snapshot.logging;
  }

  function checkDirty(): void {
    saveBtn.classList.toggle("hidden", !isSettingsDirty());
  }

  form.querySelectorAll("input").forEach((el) => {
    el.addEventListener("input", checkDirty);
    el.addEventListener("change", checkDirty);
  });

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const errEl = document.getElementById("form-error") as HTMLParagraphElement;
    errEl.hidden = true;

    const n = slotByView(currentView);
    n.name = (document.getElementById("slot-name") as HTMLInputElement).value.trim();
    n.api_key = (document.getElementById("api-key") as HTMLInputElement).value.trim();

    const selectedPlatform = (document.querySelector<HTMLInputElement>('input[name="platform"]:checked')?.value ?? "zai") as Platform;
    const p = PLATFORMS[selectedPlatform];
    n.quota_url = p.quota;
    n.request_url = p.request;

    n.poll_interval_minutes = Math.max(1, Number((document.getElementById("poll-interval") as HTMLInputElement).value) || 30);
    n.enabled = (document.getElementById("enabled") as HTMLInputElement).checked;
    n.logging = (document.getElementById("logging") as HTMLInputElement).checked;

    setConfigState(await backendInvoke<AppConfig>("save_settings", { settings: configState }));

    // Flash success toast
    const toast = document.getElementById("save-toast") as HTMLParagraphElement;
    toast.classList.remove("hidden");
    saveBtn.classList.add("hidden");
    setTimeout(() => toast.classList.add("hidden"), 1500);

    // Update snapshot
    snapshot.name = n.name;
    snapshot.api_key = n.api_key;
    snapshot.platform = detectPlatform(n.quota_url);
    snapshot.poll_interval_minutes = n.poll_interval_minutes;
    snapshot.enabled = n.enabled;
    snapshot.logging = n.logging;

    render();
  });

  document.getElementById("delete-slot-btn")?.addEventListener("click", async () => {
    const n = slotByView(currentView);
    const def = defaultSlot(n.slot);
    Object.assign(n, def);
    setConfigState(await backendInvoke<AppConfig>("save_settings", { settings: configState }));
    setCurrentView("dashboard");
    render();
  });
}
