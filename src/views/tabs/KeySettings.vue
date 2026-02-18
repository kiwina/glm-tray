<template>
  <form id="settings-form" class="flex flex-col gap-3" @submit.prevent="save">
      <div class="card bg-base-100 card-border border-base-300 card-sm">
        <div class="card-body p-4 gap-3">
          <!-- Platform -->
          <div class="flex flex-col gap-1">
            <label class="text-xs font-medium opacity-60">Platform</label>
            <div class="join w-full">
              <input class="join-item btn btn-sm flex-1" type="radio" value="zai" v-model="platform" aria-label="Z.ai" />
              <input class="join-item btn btn-sm flex-1" type="radio" value="bigmodel" v-model="platform" aria-label="BigModel" />
            </div>
          </div>

          <!-- API Key -->
          <div class="flex flex-col gap-1">
            <label class="text-xs font-medium opacity-60">API Key</label>
            <input type="password" class="input input-sm input-bordered w-full" v-model="form.api_key" placeholder="Bearer ..." autocomplete="off" />
          </div>

          <!-- Name -->
          <div class="flex flex-col gap-1">
            <label class="text-xs font-medium opacity-60">Name</label>
            <input type="text" class="input input-sm input-bordered w-full" v-model="form.name" placeholder="e.g. Production" />
          </div>

          <!-- Poll Interval & Enabled -->
          <div class="flex items-center justify-between gap-3">
            <div class="flex items-center gap-2 flex-1">
              <span class="text-sm font-medium">Poll every</span>
              <input type="number" class="input input-sm input-bordered w-16" min="1" step="1" v-model.number="form.poll_interval_minutes" />
              <span class="text-xs opacity-40">min</span>
            </div>
            <input type="checkbox" class="toggle toggle-sm toggle-primary" v-model="form.enabled" />
          </div>

          <!-- Logging -->
          <div class="flex gap-4 mt-1">
            <label class="flex cursor-pointer items-center gap-2 text-xs">
              <input type="checkbox" class="toggle toggle-xs toggle-primary" v-model="form.logging" />
              Logging
            </label>
          </div>
        </div>
      </div>

      <div class="card-actions grid grid-cols-2 gap-2">
        <button type="button" class="btn btn-sm" @click="resetSlot" id="slot-reset-btn">Reset Slot</button>
        <button type="submit" class="btn btn-primary btn-sm" :disabled="!dirty" id="slot-save-btn">Save</button>
      </div>
      <p v-if="saved" class="text-success text-xs text-center font-medium">Settings saved</p>
      <p v-if="error" class="text-error font-semibold text-sm text-center">{{ error }}</p>
  </form>
</template>

<script setup lang="ts">
import { ref, computed, watch, onMounted } from 'vue';
import { useSettingsStore } from '../../stores/settings';
import { useKeysStore } from '../../stores/keys';
import { PLATFORMS, detectPlatform, defaultSlot } from '../../lib/constants';
import { logUiAction } from '../../lib/api';

const props = defineProps<{ slotId: number }>();
const settingsStore = useSettingsStore();
const keysStore = useKeysStore();

const form = ref({
    name: '',
    api_key: '',
    poll_interval_minutes: 30,
    enabled: false,
    logging: false,
    quota_url: '',
    request_url: '' as string | null,
});

const platform = ref<'zai' | 'bigmodel'>('zai');
const error = ref('');
const saved = ref(false);
const original = ref('');

function loadForm() {
    const slot = settingsStore.config?.slots.find(s => s.slot === props.slotId);
    if (!slot) return;

    form.value = {
        name: slot.name,
        api_key: slot.api_key,
        poll_interval_minutes: slot.poll_interval_minutes,
        enabled: slot.enabled,
        logging: slot.logging,
        quota_url: slot.quota_url,
        request_url: slot.request_url,
    };

    platform.value = detectPlatform(slot.quota_url);
    original.value = JSON.stringify({ ...form.value, platform: platform.value });
}

const dirty = computed(() => JSON.stringify({ ...form.value, platform: platform.value }) !== original.value);

// When platform changes, update URLs
watch(platform, (p) => {
    const plat = PLATFORMS[p];
    if (plat) {
        form.value.quota_url = plat.quota;
        form.value.request_url = plat.request;
    }
});

// Auto-enable when API key is entered
watch(() => form.value.api_key, (newVal) => {
    if (newVal.trim().length > 0 && !form.value.enabled) {
        form.value.enabled = true;
    }
});

async function save() {
    error.value = '';
    if (!dirty.value) return;

    const slot = settingsStore.config?.slots.find(s => s.slot === props.slotId);
    if (!slot) return;

    // validate
    if (form.value.api_key.trim() && form.value.enabled) {
        if (!form.value.quota_url?.startsWith('http')) {
            error.value = 'Invalid quota URL';
            return;
        }
    }

    logUiAction('save-key-settings', props.slotId);

    Object.assign(slot, form.value);
    try {
        await settingsStore.saveSettings(settingsStore.config!);
        await keysStore.fetchRuntime();
        original.value = JSON.stringify({ ...form.value, platform: platform.value });
        saved.value = true;
        setTimeout(() => saved.value = false, 2000);
    } catch (e) {
        error.value = 'Failed to save';
    }
}

async function resetSlot() {
    logUiAction('reset-slot', props.slotId);

    const slot = settingsStore.config?.slots.find(s => s.slot === props.slotId);
    if (!slot) return;

    const def = defaultSlot(slot.slot);
    if (settingsStore.config?.global_quota_url) {
        def.quota_url = settingsStore.config.global_quota_url;
    }
    if (settingsStore.config?.global_request_url) {
        def.request_url = settingsStore.config.global_request_url;
    }
    Object.assign(slot, def);
    try {
        await settingsStore.saveSettings(settingsStore.config!);
        await keysStore.fetchRuntime();
        loadForm();
    } catch (e) {
        error.value = 'Failed to reset slot';
    }
}

watch(() => props.slotId, loadForm);
onMounted(loadForm);
</script>
