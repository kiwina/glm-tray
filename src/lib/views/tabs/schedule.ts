import { currentView, configState, scheduleSavedSnapshot, setScheduleSavedSnapshot, setConfigState } from "../../state";
import { esc, slotByView, isValidHm, setHeaderActions } from "../../helpers";
import { backendInvoke } from "../../api";
import { render } from "../render";

export function renderScheduleTab(tc: HTMLDivElement, preserveSnapshot = false): void {
  const s = slotByView(currentView);

  // Set header: key name
  setHeaderActions(`<span class="text-sm font-normal opacity-60">${esc(s.name || `Key ${s.slot}`)}</span>`);

  const times = [0, 1, 2, 3, 4].map((i) => s.wake_times[i] ?? "");

  // Only snapshot the "saved" state on first render
  if (!preserveSnapshot || !scheduleSavedSnapshot) {
    setScheduleSavedSnapshot({
      wake_interval_enabled: s.wake_interval_enabled,
      wake_times_enabled: s.wake_times_enabled,
      wake_after_reset_enabled: s.wake_after_reset_enabled,
      wake_interval_minutes: s.wake_interval_minutes,
      wake_after_reset_minutes: s.wake_after_reset_minutes,
      wake_times: [...s.wake_times],
    });
  }
  const snapshot = scheduleSavedSnapshot;

  tc.innerHTML = `
    <form id="schedule-form" class="flex flex-col gap-3">
      <!-- After Reset Mode -->
      <div class="card bg-base-100 card-border border-base-300 card-sm">
        <div class="card-body p-3 gap-2">
          <div class="flex items-center justify-between gap-3">
            <div class="flex items-center gap-2 flex-1">
              <svg class="w-4 h-4 opacity-40 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/>
                <path d="M3 3v5h5"/>
              </svg>
              <span class="text-sm font-medium">After reset + offset</span>
              <input id="wake-after-reset" type="number" class="input input-sm input-border w-20" min="1" max="1440" step="1" value="${s.wake_after_reset_minutes}" />
              <span class="text-xs opacity-40">min</span>
            </div>
            <input id="wake-after-reset-enabled" type="checkbox" class="toggle toggle-sm toggle-primary" ${s.wake_after_reset_enabled ? "checked" : ""} />
          </div>
          <p class="text-[10px] opacity-40 pl-6">Wake N minutes after quota window resets</p>
        </div>
      </div>

      <!-- Interval Mode -->
      <div class="card bg-base-100 card-border border-base-300 card-sm">
        <div class="card-body p-3 gap-2">
          <div class="flex items-center justify-between gap-3">
            <div class="flex items-center gap-2 flex-1">
              <svg class="w-4 h-4 opacity-40 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <circle cx="12" cy="12" r="10"/>
                <polyline points="12 6 12 12 16 14"/>
              </svg>
              <span class="text-sm font-medium">Every</span>
              <input id="wake-interval" type="number" class="input input-sm input-border w-20" min="1" max="1440" step="1" value="${s.wake_interval_minutes}" />
              <span class="text-xs opacity-40">min</span>
            </div>
            <input id="wake-interval-enabled" type="checkbox" class="toggle toggle-sm toggle-primary" ${s.wake_interval_enabled ? "checked" : ""} />
          </div>
          <p class="text-[10px] opacity-40 pl-6">Periodic wake on a fixed interval</p>
        </div>
      </div>

      <!-- Times Mode -->
      <div class="card bg-base-100 card-border border-base-300 card-sm">
        <div class="card-body p-3 gap-2">
          <div class="flex items-center justify-between gap-3">
            <div class="flex items-center gap-2 flex-1">
              <svg class="w-4 h-4 opacity-40 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <rect x="3" y="4" width="18" height="18" rx="2" ry="2"/>
                <line x1="16" y1="2" x2="16" y2="6"/>
                <line x1="8" y1="2" x2="8" y2="6"/>
                <line x1="3" y1="10" x2="21" y2="10"/>
              </svg>
              <span class="text-sm font-medium">Specific times</span>
            </div>
            <input id="wake-times-enabled" type="checkbox" class="toggle toggle-sm toggle-primary" ${s.wake_times_enabled ? "checked" : ""} />
          </div>
          <div class="pl-6">
            <div class="flex flex-wrap gap-1.5">
              <input class="input input-sm input-border w-[72px] wake-time text-center" data-index="0" type="text" placeholder="--:--" value="${esc(times[0])}" />
              <input class="input input-sm input-border w-[72px] wake-time text-center" data-index="1" type="text" placeholder="--:--" value="${esc(times[1])}" />
              <input class="input input-sm input-border w-[72px] wake-time text-center" data-index="2" type="text" placeholder="--:--" value="${esc(times[2])}" />
              <input class="input input-sm input-border w-[72px] wake-time text-center" data-index="3" type="text" placeholder="--:--" value="${esc(times[3])}" />
              <input class="input input-sm input-border w-[72px] wake-time text-center" data-index="4" type="text" placeholder="--:--" value="${esc(times[4])}" />
            </div>
            <p class="text-[10px] opacity-40 mt-1.5">Up to 5 times in 24h HH:MM format</p>
          </div>
        </div>
      </div>

      <button type="submit" class="btn btn-primary btn-block hidden" id="schedule-save-btn">Save Schedule</button>
      <p id="schedule-toast" class="text-success text-xs text-center font-medium hidden">Schedule saved</p>
      <p id="form-error" class="text-error font-semibold text-sm text-center" hidden></p>
    </form>`;

  const form = document.getElementById("schedule-form") as HTMLFormElement;
  const saveBtn = document.getElementById("schedule-save-btn") as HTMLButtonElement;

  function getFormTimes(): string[] {
    return Array.from(document.querySelectorAll<HTMLInputElement>(".wake-time"))
      .map((el) => el.value.trim())
      .filter((v) => v.length > 0)
      .slice(0, 5);
  }

  function isScheduleDirty(): boolean {
    const intervalEnabled = (document.getElementById("wake-interval-enabled") as HTMLInputElement).checked;
    const timesEnabled = (document.getElementById("wake-times-enabled") as HTMLInputElement).checked;
    const afterResetEnabled = (document.getElementById("wake-after-reset-enabled") as HTMLInputElement).checked;
    const interval = Math.max(1, Number((document.getElementById("wake-interval") as HTMLInputElement).value) || 1);
    const afterReset = Math.max(1, Number((document.getElementById("wake-after-reset") as HTMLInputElement).value) || 1);
    const times = getFormTimes();

    return intervalEnabled !== snapshot!.wake_interval_enabled
      || timesEnabled !== snapshot!.wake_times_enabled
      || afterResetEnabled !== snapshot!.wake_after_reset_enabled
      || interval !== snapshot!.wake_interval_minutes
      || afterReset !== snapshot!.wake_after_reset_minutes
      || times.join(",") !== snapshot!.wake_times.join(",");
  }

  function checkDirty(): void {
    saveBtn.classList.toggle("hidden", !isScheduleDirty());
  }

  form.querySelectorAll("input").forEach((el) => {
    el.addEventListener("input", checkDirty);
    el.addEventListener("change", checkDirty);
  });

  (document.getElementById("schedule-form") as HTMLFormElement)
    .addEventListener("submit", async (e) => {
      e.preventDefault();
      const errEl = document.getElementById("form-error") as HTMLParagraphElement;
      errEl.hidden = true;

      const n = slotByView(currentView);

      // Get enabled flags
      n.wake_interval_enabled = (document.getElementById("wake-interval-enabled") as HTMLInputElement).checked;
      n.wake_times_enabled = (document.getElementById("wake-times-enabled") as HTMLInputElement).checked;
      n.wake_after_reset_enabled = (document.getElementById("wake-after-reset-enabled") as HTMLInputElement).checked;

      // Compute legacy wake_enabled (true if any mode is enabled)
      n.wake_enabled = n.wake_interval_enabled || n.wake_times_enabled || n.wake_after_reset_enabled;

      // Get mode-specific settings
      n.wake_interval_minutes = Math.max(1, Number((document.getElementById("wake-interval") as HTMLInputElement).value) || 1);
      n.wake_after_reset_minutes = Math.max(1, Number((document.getElementById("wake-after-reset") as HTMLInputElement).value) || 1);

      // Get times
      const wakeTimes = getFormTimes();
      const invalid = wakeTimes.find((v) => !isValidHm(v));
      if (n.wake_times_enabled && invalid) {
        errEl.textContent = `Invalid time: ${invalid}. Use HH:MM (24h).`;
        errEl.hidden = false;
        return;
      }
      n.wake_times = wakeTimes;

      // Set legacy wake_mode based on first enabled mode (for backwards compat)
      if (n.wake_after_reset_enabled) {
        n.wake_mode = "after_reset";
      } else if (n.wake_interval_enabled) {
        n.wake_mode = "interval";
      } else if (n.wake_times_enabled) {
        n.wake_mode = "times";
      }

      setConfigState(await backendInvoke<typeof configState>("save_settings", { settings: configState }));

      // Flash success toast
      const toast = document.getElementById("schedule-toast") as HTMLParagraphElement;
      toast.classList.remove("hidden");
      saveBtn.classList.add("hidden");
      setTimeout(() => toast.classList.add("hidden"), 1500);

      // Update saved snapshot
      setScheduleSavedSnapshot({
        wake_interval_enabled: n.wake_interval_enabled,
        wake_times_enabled: n.wake_times_enabled,
        wake_after_reset_enabled: n.wake_after_reset_enabled,
        wake_interval_minutes: n.wake_interval_minutes,
        wake_after_reset_minutes: n.wake_after_reset_minutes,
        wake_times: [...n.wake_times],
      });

      render();
    });
}
