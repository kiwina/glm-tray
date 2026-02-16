import { currentView, configState, scheduleSavedSnapshot, setScheduleSavedSnapshot, setConfigState } from "../../state";
import { esc, slotByView, isValidHm, setHeaderActions, warmupButtonHtml, setupWarmupButton } from "../../helpers";
import { backendInvoke } from "../../api";
import { render } from "../render";

export function renderScheduleTab(tc: HTMLDivElement, preserveSnapshot = false): void {
  const s = slotByView(currentView);

  // Set header: warmup button
  setHeaderActions(warmupButtonHtml(s.slot));
  setTimeout(() => setupWarmupButton(), 0);

  const times = [0, 1, 2, 3, 4].map((i) => s.schedule_times[i] ?? "");

  // Only snapshot the "saved" state on first render
  if (!preserveSnapshot || !scheduleSavedSnapshot) {
    setScheduleSavedSnapshot({
      schedule_interval_enabled: s.schedule_interval_enabled,
      schedule_times_enabled: s.schedule_times_enabled,
      schedule_after_reset_enabled: s.schedule_after_reset_enabled,
      schedule_interval_minutes: s.schedule_interval_minutes,
      schedule_after_reset_minutes: s.schedule_after_reset_minutes,
      schedule_times: [...s.schedule_times],
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
              <input id="schedule-after-reset" type="number" class="input input-sm input-border w-20" min="1" max="1440" step="1" value="${s.schedule_after_reset_minutes}" />
              <span class="text-xs opacity-40">min</span>
            </div>
            <input id="schedule-after-reset-enabled" type="checkbox" class="toggle toggle-sm toggle-primary" ${s.schedule_after_reset_enabled ? "checked" : ""} />
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
              <input id="schedule-interval" type="number" class="input input-sm input-border w-20" min="1" max="1440" step="1" value="${s.schedule_interval_minutes}" />
              <span class="text-xs opacity-40">min</span>
            </div>
            <input id="schedule-interval-enabled" type="checkbox" class="toggle toggle-sm toggle-primary" ${s.schedule_interval_enabled ? "checked" : ""} />
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
            <input id="schedule-times-enabled" type="checkbox" class="toggle toggle-sm toggle-primary" ${s.schedule_times_enabled ? "checked" : ""} />
          </div>
          <div class="pl-6">
            <div class="flex gap-1">
              <input class="input input-sm input-border w-12 wake-time text-center !px-1" data-index="0" type="text" placeholder="--:--" value="${esc(times[0])}" />
              <input class="input input-sm input-border w-12 wake-time text-center !px-1" data-index="1" type="text" placeholder="--:--" value="${esc(times[1])}" />
              <input class="input input-sm input-border w-12 wake-time text-center !px-1" data-index="2" type="text" placeholder="--:--" value="${esc(times[2])}" />
              <input class="input input-sm input-border w-12 wake-time text-center !px-1" data-index="3" type="text" placeholder="--:--" value="${esc(times[3])}" />
              <input class="input input-sm input-border w-12 wake-time text-center !px-1" data-index="4" type="text" placeholder="--:--" value="${esc(times[4])}" />
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
  const errEl = document.getElementById("form-error") as HTMLParagraphElement;

  function getFormTimes(): string[] {
    return Array.from(document.querySelectorAll<HTMLInputElement>(".wake-time"))
      .map((el) => el.value.trim())
      .filter((v) => v.length > 0)
      .slice(0, 5);
  }

  function isFormValid(): boolean {
    // Validate time inputs - must be empty or valid HH:MM
    const timeInputs = document.querySelectorAll<HTMLInputElement>(".wake-time");
    for (const input of timeInputs) {
      const val = input.value.trim();
      if (val && !isValidHm(val)) {
        return false;
      }
    }

    // Validate number inputs - must be valid numbers in range
    const intervalVal = (document.getElementById("schedule-interval") as HTMLInputElement).value;
    const afterResetVal = (document.getElementById("schedule-after-reset") as HTMLInputElement).value;

    const interval = Number(intervalVal);
    const afterReset = Number(afterResetVal);

    if (intervalVal && (isNaN(interval) || interval < 1 || interval > 1440)) {
      return false;
    }
    if (afterResetVal && (isNaN(afterReset) || afterReset < 1 || afterReset > 1440)) {
      return false;
    }

    return true;
  }

  function isScheduleDirty(): boolean {
    const intervalEnabled = (document.getElementById("schedule-interval-enabled") as HTMLInputElement).checked;
    const timesEnabled = (document.getElementById("schedule-times-enabled") as HTMLInputElement).checked;
    const afterResetEnabled = (document.getElementById("schedule-after-reset-enabled") as HTMLInputElement).checked;
    const interval = Math.max(1, Number((document.getElementById("schedule-interval") as HTMLInputElement).value) || 1);
    const afterReset = Math.max(1, Number((document.getElementById("schedule-after-reset") as HTMLInputElement).value) || 1);
    const times = getFormTimes();

    return intervalEnabled !== snapshot!.schedule_interval_enabled
      || timesEnabled !== snapshot!.schedule_times_enabled
      || afterResetEnabled !== snapshot!.schedule_after_reset_enabled
      || interval !== snapshot!.schedule_interval_minutes
      || afterReset !== snapshot!.schedule_after_reset_minutes
      || times.join(",") !== snapshot!.schedule_times.join(",");
  }

  function checkDirty(): void {
    errEl.hidden = true;
    const valid = isFormValid();
    const dirty = isScheduleDirty();
    saveBtn.classList.toggle("hidden", !valid || !dirty);
  }

  form.querySelectorAll("input").forEach((el) => {
    el.addEventListener("input", checkDirty);
    el.addEventListener("change", checkDirty);
  });

  (document.getElementById("schedule-form") as HTMLFormElement)
    .addEventListener("submit", async (e) => {
      e.preventDefault();
      errEl.hidden = true;

      const n = slotByView(currentView);

      // Get enabled flags
      n.schedule_interval_enabled = (document.getElementById("schedule-interval-enabled") as HTMLInputElement).checked;
      n.schedule_times_enabled = (document.getElementById("schedule-times-enabled") as HTMLInputElement).checked;
      n.schedule_after_reset_enabled = (document.getElementById("schedule-after-reset-enabled") as HTMLInputElement).checked;

      // Get mode-specific settings
      n.schedule_interval_minutes = Math.max(1, Number((document.getElementById("schedule-interval") as HTMLInputElement).value) || 1);
      n.schedule_after_reset_minutes = Math.max(1, Number((document.getElementById("schedule-after-reset") as HTMLInputElement).value) || 1);

      // Get times - validate any entered time
      const scheduleTimes = getFormTimes();
      const invalid = scheduleTimes.find((v) => !isValidHm(v));
      if (invalid) {
        errEl.textContent = `Invalid time: ${invalid}. Use HH:MM (24h).`;
        errEl.hidden = false;
        return;
      }
      n.schedule_times = scheduleTimes;

      setConfigState(await backendInvoke<typeof configState>("save_settings", { settings: configState }));

      // Flash success toast
      const toast = document.getElementById("schedule-toast") as HTMLParagraphElement;
      toast.classList.remove("hidden");
      saveBtn.classList.add("hidden");
      setTimeout(() => toast.classList.add("hidden"), 1500);

      // Update saved snapshot
      setScheduleSavedSnapshot({
        schedule_interval_enabled: n.schedule_interval_enabled,
        schedule_times_enabled: n.schedule_times_enabled,
        schedule_after_reset_enabled: n.schedule_after_reset_enabled,
        schedule_interval_minutes: n.schedule_interval_minutes,
        schedule_after_reset_minutes: n.schedule_after_reset_minutes,
        schedule_times: [...n.schedule_times],
      });

      render();
    });
}
