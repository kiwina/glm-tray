<template>
  <div class="h-full overflow-y-auto p-4">
    <div class="card bg-base-100 card-border border-base-300 card-sm">
      <div class="card-body p-4 gap-3">
        <!-- Mock Mode (Debug) -->
        <div class="flex items-center justify-between gap-3">
           <div class="flex flex-col">
              <span class="text-sm font-medium">Debug Mode</span>
              <span class="text-xs opacity-40">Use mock API responses</span>
           </div>
           <input type="checkbox" class="toggle toggle-sm toggle-secondary" v-model="form.debug" />
        </div>

        <!-- Global Platform URLs -->
        <div class="divider text-xs opacity-30 my-0">Defaults</div>
        
        <div class="flex flex-col gap-1">
           <label class="text-xs font-medium opacity-60">Default Quota URL</label>
           <input type="text" class="input input-sm input-bordered w-full font-mono text-xs" v-model="form.global_quota_url" placeholder="https://..." />
        </div>

        <div class="flex flex-col gap-1">
           <label class="text-xs font-medium opacity-60">Default Request URL</label>
           <input type="text" class="input input-sm input-bordered w-full font-mono text-xs" v-model="form.global_request_url" placeholder="https://..." />
        </div>
      </div>
    </div>

    <!-- About -->
    <div class="mt-6 flex flex-col items-center gap-2 opacity-30 hover:opacity-100 transition duration-500">
        <img src="../assets/logo-white.svg" class="w-10 h-10 mb-1" />
        <div class="text-center">
            <h3 class="font-bold text-sm">GLM Tray</h3>
            <p class="text-xs">v{{ appStore.version }} · {{ appStore.platform }}</p>
        </div>
        <div class="flex gap-3 mt-2">
            <button class="btn btn-xs btn-outline" @click="checkForUpdates">Check for Updates</button>
            <a href="https://github.com/stevencm/glm-tray" target="_blank" class="btn btn-xs btn-ghost">GitHub</a>
        </div>
        <div class="text-[10px] mt-2 font-mono">{{ displayPath }}</div>
    </div>

    <!-- Save FAB -->
    <div v-if="dirty" class="fixed bottom-6 right-6">
        <button class="btn btn-primary shadow-lg" @click="save" :disabled="loading">
             <span v-if="loading" class="loading loading-spinner"></span>
             Save Changes
        </button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue';
import { useSettingsStore } from '../stores/settings';
import { useAppStore } from '../stores/app';

const settingsStore = useSettingsStore();
const appStore = useAppStore();

const form = ref({
    debug: false,
    global_quota_url: '',
    global_request_url: ''
});

const original = ref('');
const loading = ref(false);
const displayPath = ref('');

function loadForm() {
    if (settingsStore.config) {
        form.value = {
            debug: settingsStore.config.debug,
            global_quota_url: settingsStore.config.global_quota_url || '',
            global_request_url: settingsStore.config.global_request_url || ''
        };
        original.value = JSON.stringify(form.value);
    }
}

const dirty = computed(() => JSON.stringify(form.value) !== original.value);

async function save() {
    loading.value = true;
    try {
        if (settingsStore.config) {
            Object.assign(settingsStore.config, form.value);
            await settingsStore.saveSettings(settingsStore.config);
            original.value = JSON.stringify(form.value);
        }
    } finally {
        loading.value = false;
    }
}

async function checkForUpdates() {
    await appStore.checkForUpdates();
}

onMounted(async () => {
    appStore.pageTitle = 'Settings';
    loadForm();
    if (!settingsStore.config) {
       await settingsStore.fetchSettings();
       loadForm();
    }
    // Try to get path if possible (mocked)
    // displayPath.value = await resolveResource('appConfig');
});
</script>
