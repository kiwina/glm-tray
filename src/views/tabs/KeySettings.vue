<template>
  <div class="flex flex-col gap-3">
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
        <button class="btn btn-sm" @click="resetSlot" :disabled="loading">Reset Slot</button>
        <button class="btn btn-primary btn-sm" @click="save" :disabled="!dirty || loading">
             <span v-if="loading" class="loading loading-spinner loading-xs"></span> 
             Save
        </button>
      </div>
      <p v-if="saved" class="text-success text-xs text-center font-medium">Settings saved</p>
      <p v-if="error" class="text-error font-semibold text-sm text-center">{{ error }}</p>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch, onMounted } from 'vue';
import { useSettingsStore } from '../../stores/settings';
import { PLATFORMS, detectPlatform, defaultSlot } from '../../lib/constants';

const props = defineProps<{ slotId: number }>();
const settingsStore = useSettingsStore();

const form = ref({
    name: '',
    api_key: '',
    poll_interval_minutes: 30,
    enabled: false,
    logging: false,
    quota_url: '',
    request_url: ''
});

const platform = ref('zai');
const original = ref('');
const error = ref('');
const loading = ref(false);
const saved = ref(false);

function loadForm() {
    const slot = settingsStore.config?.slots.find(s => s.slot === props.slotId);
    if (slot) {
        form.value = { ...slot };
        platform.value = detectPlatform(slot.quota_url);
        original.value = JSON.stringify({ ...form.value, platform: platform.value });
    }
}

const dirty = computed(() => JSON.stringify({ ...form.value, platform: platform.value }) !== original.value);

watch(platform, (p) => {
    const plat = PLATFORMS[p as keyof typeof PLATFORMS];
    if (plat) {
        form.value.quota_url = plat.quota;
        form.value.request_url = plat.request;
    }
});

watch(() => form.value.api_key, (newVal) => {
    if (newVal.trim().length > 0 && !form.value.enabled) {
        form.value.enabled = true;
    }
});

async function save() {
    loading.value = true;
    try {
        const slot = settingsStore.config?.slots.find(s => s.slot === props.slotId);
        if (slot) {
            Object.assign(slot, form.value);
            await settingsStore.saveSettings(settingsStore.config!);
            original.value = JSON.stringify({ ...form.value, platform: platform.value });
            saved.value = true;
            setTimeout(() => saved.value = false, 2000);
        }
    } catch (e) {
        error.value = 'Failed to save';
    } finally {
        loading.value = false;
    }
}

async function resetSlot() {
    if (!confirm('Are you sure you want to reset this slot?')) return;
    loading.value = true;
    try {
        const slot = settingsStore.config?.slots.find(s => s.slot === props.slotId);
        if (slot) {
            const def = defaultSlot(slot.slot);
            if (settingsStore.config?.global_quota_url) {
                def.quota_url = settingsStore.config.global_quota_url;
            }
            if (settingsStore.config?.global_request_url) {
                def.request_url = settingsStore.config.global_request_url;
            }
            Object.assign(slot, def);
            await settingsStore.saveSettings(settingsStore.config!);
            loadForm();
        }
    } finally {
        loading.value = false;
    }
}

watch(() => props.slotId, loadForm);
onMounted(loadForm);
</script>
