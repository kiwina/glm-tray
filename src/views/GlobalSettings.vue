<template>
  <div class="h-full overflow-y-auto p-4">
    <form @submit.prevent="save">
    <div class="flex flex-col gap-4">
    
    <!-- Runtime Behavior -->
    <div class="card bg-base-100 card-border border-base-300 card-sm">
      <div class="card-body p-4 gap-2">
        <p class="text-xs font-semibold opacity-70">Runtime behavior</p>
        <div class="flex justify-between items-center">
          <span class="text-xs">Wake confirmation window (minutes)</span>
          <input class="input input-sm input-bordered w-20" type="number" min="1" max="1440" v-model.number="form.wake_quota_retry_window_minutes" />
        </div>
        <div class="flex justify-between items-center">
          <span class="text-xs">Max consecutive errors</span>
          <input class="input input-sm input-bordered w-20" type="number" min="1" max="1000" v-model.number="form.max_consecutive_errors" />
        </div>
        <div class="flex justify-between items-center">
          <span class="text-xs">Quota backoff max (minutes)</span>
          <input class="input input-sm input-bordered w-20" type="number" min="1" max="1440" v-model.number="form.quota_poll_backoff_cap_minutes" />
        </div>
      </div>
    </div>

    <!-- Logging -->
    <div class="card bg-base-100 card-border border-base-300 card-sm">
      <div class="card-body p-4 gap-2">
        <p class="text-xs font-semibold opacity-70">Logging</p>
        <div class="form-control">
          <label class="label py-1">
            <span class="label-text text-xs">Log directory (optional)</span>
          </label>
          <input class="input input-sm input-bordered w-full" type="text" placeholder="Leave blank for default app data path" v-model="form.log_directory" />
          <label class="label py-1 -mt-1">
            <span class="label-text-alt text-[10px] opacity-50">Example: /tmp/glm-tray-logs</span>
          </label>
        </div>
        <div class="flex justify-between items-center">
          <span class="text-xs">Keep log files (days)</span>
          <input class="input input-sm input-bordered w-20" type="number" min="1" max="365" v-model.number="form.max_log_days" />
        </div>
      </div>
    </div>

    <!-- Developer -->
    <div class="card bg-base-100 card-border border-base-300 card-sm">
        <div class="card-body p-4 gap-2">
            <p class="text-xs font-semibold opacity-70">Developer</p>
            <div class="flex justify-between items-center">
                <span class="text-xs">Debug mode (use mock server)</span>
                <input type="checkbox" class="toggle toggle-sm toggle-warning" v-model="form.debug" />
            </div>
            <div class="form-control">
                <label class="label py-1">
                    <span class="label-text text-xs">Mock server URL</span>
                </label>
                <input class="input input-sm input-bordered w-full" type="text" placeholder="http://localhost:3456" v-model="form.mock_url" />
            </div>
        </div>
    </div>
    
    <!-- Defaults -->
    <div class="card bg-base-100 card-border border-base-300 card-sm">
      <div class="card-body p-4 gap-2">
        <p class="text-xs font-semibold opacity-70">Default URLs</p>
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
    <div class="mt-2 flex flex-col items-center gap-2 opacity-30 hover:opacity-100 transition duration-500">
        <img src="../assets/logo-white.svg" class="w-10 h-10 mb-1" />
        <div class="text-center">
            <h3 class="font-bold text-sm">GLM Tray</h3>
            <p class="text-xs">v{{ appStore.version }} · {{ appStore.platform }}</p>
        </div>
        <div class="flex gap-3 mt-2">
            <button type="button" class="btn btn-xs btn-outline" @click="checkForUpdates">Check for Updates</button>
            <a href="https://github.com/stevencm/glm-tray" target="_blank" class="btn btn-xs btn-ghost">GitHub</a>
        </div>
    </div>

    <!-- Save FAB -->
    <div v-if="dirty" class="fixed bottom-6 right-6">
        <button type="submit" class="btn btn-primary shadow-lg" :disabled="loading">
             <span v-if="loading" class="loading loading-spinner"></span>
             Save Settings
        </button>
    </div>
    
    </div>
    </form>
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
    global_request_url: '',
    log_directory: '',
    max_log_days: 7,
    wake_quota_retry_window_minutes: 15,
    max_consecutive_errors: 10,
    quota_poll_backoff_cap_minutes: 480,
    mock_url: ''
});

const original = ref('');
const loading = ref(false);

function loadForm() {
    if (settingsStore.config) {
        form.value = {
            debug: settingsStore.config.debug,
            global_quota_url: settingsStore.config.global_quota_url || '',
            global_request_url: settingsStore.config.global_request_url || '',
            log_directory: settingsStore.config.log_directory || '',
            max_log_days: settingsStore.config.max_log_days,
            wake_quota_retry_window_minutes: settingsStore.config.wake_quota_retry_window_minutes,
            max_consecutive_errors: settingsStore.config.max_consecutive_errors,
            quota_poll_backoff_cap_minutes: settingsStore.config.quota_poll_backoff_cap_minutes,
            mock_url: settingsStore.config.mock_url || ''
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
            // Refresh form to capture normalized values
            loadForm();
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
});
</script>
