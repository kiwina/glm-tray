<template>
  <form id="schedule-form" class="flex flex-col gap-3" @submit.prevent="save">
    <!-- After Reset Mode -->
    <div class="card bg-base-100 card-border border-base-300 card-sm">
        <div class="card-body p-3 gap-2">
            <div class="flex items-center justify-between gap-3">
                <div class="flex items-center gap-2 flex-1">
                    <svg class="w-4 h-4 opacity-40 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/></svg>
                    <span class="text-sm font-medium">After reset + offset</span>
                    <input type="number" class="input input-sm input-bordered w-20" min="1" max="1440" step="1" v-model.number="form.schedule_after_reset_minutes" />
                    <span class="text-xs opacity-40">min</span>
                </div>
                <input type="checkbox" class="toggle toggle-sm toggle-primary" v-model="form.schedule_after_reset_enabled" />
            </div>
            <p class="text-[10px] opacity-40 pl-6">Wake N minutes after quota window resets</p>
        </div>
    </div>

    <!-- Interval Mode -->
    <div class="card bg-base-100 card-border border-base-300 card-sm">
        <div class="card-body p-3 gap-2">
            <div class="flex items-center justify-between gap-3">
                <div class="flex items-center gap-2 flex-1">
                    <svg class="w-4 h-4 opacity-40 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
                    <span class="text-sm font-medium">Every</span>
                    <input type="number" class="input input-sm input-bordered w-20" min="1" max="1440" step="1" v-model.number="form.schedule_interval_minutes" />
                    <span class="text-xs opacity-40">min</span>
                </div>
                <input type="checkbox" class="toggle toggle-sm toggle-primary" v-model="form.schedule_interval_enabled" />
            </div>
            <p class="text-[10px] opacity-40 pl-6">Periodic wake on a fixed interval</p>
        </div>
    </div>

    <!-- Times Mode -->
    <div class="card bg-base-100 card-border border-base-300 card-sm">
        <div class="card-body p-3 gap-2">
            <div class="flex items-center justify-between gap-3">
                <div class="flex items-center gap-2 flex-1">
                    <svg class="w-4 h-4 opacity-40 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2" ry="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>
                    <span class="text-sm font-medium">Specific times</span>
                </div>
                <input type="checkbox" class="toggle toggle-sm toggle-primary" v-model="form.schedule_times_enabled" />
            </div>
            <div class="pl-6">
                <div class="flex gap-1">
                    <input v-for="i in 5" :key="i"
                           class="input input-sm input-bordered w-12 wake-time text-center !px-1"
                           type="text" placeholder="--:--"
                           v-model="form.schedule_times[i-1]" />
                </div>
                <p class="text-[10px] opacity-40 mt-1.5">Up to 5 times in 24h HH:MM format</p>
            </div>
        </div>
    </div>

    <!-- Actions -->
    <button v-show="dirty && isFormValid" type="submit" class="btn btn-primary btn-block" id="schedule-save-btn">Save Schedule</button>
    <p v-if="saved" class="text-success text-xs text-center font-medium">Schedule saved</p>
    <p v-if="error" class="text-error font-semibold text-sm text-center">{{ error }}</p>
  </form>
</template>

<script setup lang="ts">
import { ref, computed, watch, onMounted } from 'vue';
import { useSettingsStore } from '../../stores/settings';
import { useKeysStore } from '../../stores/keys';
import { isValidHm } from '../../lib/ui-helpers';

const props = defineProps<{ slotId: number }>();
const settingsStore = useSettingsStore();
const keysStore = useKeysStore();

const form = ref({
    schedule_after_reset_enabled: false,
    schedule_after_reset_minutes: 1,
    schedule_interval_enabled: false,
    schedule_interval_minutes: 60,
    schedule_times_enabled: false,
    schedule_times: ['', '', '', '', ''] as string[],
});

const snapshot = ref({
    schedule_interval_enabled: false,
    schedule_times_enabled: false,
    schedule_after_reset_enabled: false,
    schedule_interval_minutes: 60,
    schedule_after_reset_minutes: 1,
    schedule_times: [] as string[],
});

const error = ref('');
const saved = ref(false);

function loadForm() {
    const slot = settingsStore.config?.slots.find(s => s.slot === props.slotId);
    if (!slot) return;

    const times = [0, 1, 2, 3, 4].map(i => slot.schedule_times[i] ?? '');

    form.value = {
        schedule_after_reset_enabled: slot.schedule_after_reset_enabled,
        schedule_after_reset_minutes: slot.schedule_after_reset_minutes,
        schedule_interval_enabled: slot.schedule_interval_enabled,
        schedule_interval_minutes: slot.schedule_interval_minutes,
        schedule_times_enabled: slot.schedule_times_enabled,
        schedule_times: times,
    };

    snapshot.value = {
        schedule_interval_enabled: slot.schedule_interval_enabled,
        schedule_times_enabled: slot.schedule_times_enabled,
        schedule_after_reset_enabled: slot.schedule_after_reset_enabled,
        schedule_interval_minutes: slot.schedule_interval_minutes,
        schedule_after_reset_minutes: slot.schedule_after_reset_minutes,
        schedule_times: [...slot.schedule_times],
    };
}

function getFormTimes(): string[] {
    return form.value.schedule_times
        .map(v => v.trim())
        .filter(v => v.length > 0)
        .slice(0, 5);
}

const isFormValid = computed(() => {
    // Validate time inputs
    for (const time of form.value.schedule_times) {
        const val = time.trim();
        if (val && !isValidHm(val)) return false;
    }

    // Validate number inputs
    const interval = form.value.schedule_interval_minutes;
    const afterReset = form.value.schedule_after_reset_minutes;

    if (isNaN(interval) || interval < 1 || interval > 1440) return false;
    if (isNaN(afterReset) || afterReset < 1 || afterReset > 1440) return false;

    return true;
});

const dirty = computed(() => {
    const intervalEnabled = form.value.schedule_interval_enabled;
    const timesEnabled = form.value.schedule_times_enabled;
    const afterResetEnabled = form.value.schedule_after_reset_enabled;
    const interval = Math.max(1, form.value.schedule_interval_minutes || 1);
    const afterReset = Math.max(1, form.value.schedule_after_reset_minutes || 1);
    const times = getFormTimes();

    return intervalEnabled !== snapshot.value.schedule_interval_enabled
        || timesEnabled !== snapshot.value.schedule_times_enabled
        || afterResetEnabled !== snapshot.value.schedule_after_reset_enabled
        || interval !== snapshot.value.schedule_interval_minutes
        || afterReset !== snapshot.value.schedule_after_reset_minutes
        || times.join(',') !== snapshot.value.schedule_times.join(',');
});

async function save() {
    error.value = '';

    // Validate times
    const scheduleTimes = getFormTimes();
    const invalid = scheduleTimes.find(v => !isValidHm(v));
    if (invalid) {
        error.value = `Invalid time: ${invalid}. Use HH:MM (24h).`;
        return;
    }

    const slot = settingsStore.config?.slots.find(s => s.slot === props.slotId);
    if (!slot) return;

    // Update slot
    slot.schedule_interval_enabled = form.value.schedule_interval_enabled;
    slot.schedule_times_enabled = form.value.schedule_times_enabled;
    slot.schedule_after_reset_enabled = form.value.schedule_after_reset_enabled;
    slot.schedule_interval_minutes = Math.max(1, form.value.schedule_interval_minutes || 1);
    slot.schedule_after_reset_minutes = Math.max(1, form.value.schedule_after_reset_minutes || 1);
    slot.schedule_times = scheduleTimes;

    try {
        await settingsStore.saveSettings(settingsStore.config!);
        await keysStore.fetchRuntime();
    } catch (err) {
        console.warn('failed to save schedule settings:', err);
        error.value = 'Failed to save schedule settings';
        return;
    }

    // Flash success toast
    saved.value = true;
    setTimeout(() => saved.value = false, 1500);

    // Update snapshot
    snapshot.value = {
        schedule_interval_enabled: slot.schedule_interval_enabled,
        schedule_times_enabled: slot.schedule_times_enabled,
        schedule_after_reset_enabled: slot.schedule_after_reset_enabled,
        schedule_interval_minutes: slot.schedule_interval_minutes,
        schedule_after_reset_minutes: slot.schedule_after_reset_minutes,
        schedule_times: [...slot.schedule_times],
    };
}

watch(() => props.slotId, loadForm);
onMounted(loadForm);
</script>
