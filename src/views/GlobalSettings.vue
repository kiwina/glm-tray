<template>
  <div class="flex flex-col h-full">
    <div class="overflow-y-auto p-4 main-content">
      <!-- Debug mode alert -->
      <div v-if="isDebugMode" class="alert alert-soft alert-warning text-xs font-bold mb-2">
        <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"/>
        </svg>
        <span>Debug mode - using mock server at {{ debugBaseUrl }}</span>
      </div>

      <form id="global-settings-form" class="flex flex-col gap-4" :class="{ 'mt-2': isDebugMode }" @submit.prevent="save">
        <!-- Runtime behavior -->
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
              <label class="label py-1 -mt-1">
                <span class="label-text-alt text-[10px] opacity-50">Run npm run dev:mock to start mock server</span>
              </label>
            </div>
          </div>
        </div>

        <!-- Info card -->
        <div class="card bg-base-100 card-border border-base-300 card-sm">
          <div class="card-body p-4 gap-1">
            <div class="flex items-center justify-between text-sm">
              <span>Keys enabled</span>
              <span class="font-semibold">{{ enabledSlots }}</span>
            </div>
            <div class="flex items-center justify-between text-sm">
              <span>Runtime status</span>
              <span class="font-semibold">{{ status }}</span>
            </div>
            <div class="text-xs opacity-40">Version {{ appStore.version || 'dev' }}</div>
            <div class="text-xs opacity-40">By Kiwina with <span class="text-error">❤</span> · <a href="https://z.ai/subscribe?ic=GONVESHW5A" class="link link-hover" target="_blank" rel="noopener">Subscribe to z.ai coding plan</a></div>
          </div>
        </div>

        <p v-if="formError" class="text-error font-semibold text-sm text-center">{{ formError }}</p>
        <button v-show="dirty" type="submit" class="btn btn-primary btn-block" id="global-settings-save-btn">Save settings</button>
      </form>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, watch } from 'vue';
import { useSettingsStore } from '../stores/settings';
import { useKeysStore } from '../stores/keys';
import { useAppStore } from '../stores/app';
import { normalizeConfig } from '../lib/api';

const settingsStore = useSettingsStore();
const keysStore = useKeysStore();
const appStore = useAppStore();

const formError = ref('');

const form = ref({
    log_directory: '',
    max_log_days: 7,
    wake_quota_retry_window_minutes: 15,
    max_consecutive_errors: 10,
    quota_poll_backoff_cap_minutes: 480,
    debug: false,
    mock_url: '',
});

const snapshot = ref({
    log_directory: '' as string | undefined | null,
    max_log_days: 7,
    wake_quota_retry_window_minutes: 15,
    max_consecutive_errors: 10,
    quota_poll_backoff_cap_minutes: 480,
    debug: false,
    mock_url: '' as string | null,
});

const enabledSlots = computed(() => {
    return settingsStore.config?.slots.filter(s => s.enabled).length ?? 0;
});

const status = computed(() => {
    return keysStore.runtime.monitoring ? 'Monitoring' : 'Idle';
});

const isDebugMode = computed(() => {
    const url = settingsStore.config?.global_quota_url ?? '';
    return url.includes('localhost') || url.startsWith('http://');
});

const debugBaseUrl = computed(() => {
    const url = settingsStore.config?.global_quota_url ?? '';
    return url.replace('/api/monitor/usage/quota/limit', '');
});

function loadForm() {
    const cfg = settingsStore.config;
    if (!cfg) return;
    const n = normalizeConfig(cfg);

    form.value = {
        log_directory: n.log_directory ?? '',
        max_log_days: n.max_log_days,
        wake_quota_retry_window_minutes: n.wake_quota_retry_window_minutes,
        max_consecutive_errors: n.max_consecutive_errors,
        quota_poll_backoff_cap_minutes: n.quota_poll_backoff_cap_minutes,
        debug: n.debug,
        mock_url: n.mock_url ?? '',
    };

    snapshot.value = {
        log_directory: n.log_directory,
        max_log_days: n.max_log_days,
        wake_quota_retry_window_minutes: n.wake_quota_retry_window_minutes,
        max_consecutive_errors: n.max_consecutive_errors,
        quota_poll_backoff_cap_minutes: n.quota_poll_backoff_cap_minutes,
        debug: n.debug,
        mock_url: n.mock_url,
    };
}

const dirty = computed(() => {
    return (
        (form.value.log_directory || '') !== (snapshot.value.log_directory ?? '') ||
        form.value.max_log_days !== snapshot.value.max_log_days ||
        form.value.wake_quota_retry_window_minutes !== snapshot.value.wake_quota_retry_window_minutes ||
        form.value.max_consecutive_errors !== snapshot.value.max_consecutive_errors ||
        form.value.quota_poll_backoff_cap_minutes !== snapshot.value.quota_poll_backoff_cap_minutes ||
        form.value.debug !== snapshot.value.debug ||
        (form.value.mock_url || '') !== (snapshot.value.mock_url ?? '')
    );
});

function validate(): boolean {
    const { max_log_days, wake_quota_retry_window_minutes, max_consecutive_errors, quota_poll_backoff_cap_minutes } = form.value;

    if (!Number.isFinite(max_log_days) || max_log_days < 1 || max_log_days > 365) {
        formError.value = 'Log retention must be between 1 and 365 days';
        return false;
    }
    if (!Number.isFinite(wake_quota_retry_window_minutes) || wake_quota_retry_window_minutes < 1 || wake_quota_retry_window_minutes > 1440) {
        formError.value = 'Wake confirmation window must be between 1 and 1440 minutes';
        return false;
    }
    if (!Number.isFinite(max_consecutive_errors) || max_consecutive_errors < 1 || max_consecutive_errors > 1000) {
        formError.value = 'Max consecutive errors must be between 1 and 1000';
        return false;
    }
    if (!Number.isFinite(quota_poll_backoff_cap_minutes) || quota_poll_backoff_cap_minutes < 1 || quota_poll_backoff_cap_minutes > 1440) {
        formError.value = 'Quota backoff max must be between 1 and 1440 minutes';
        return false;
    }

    formError.value = '';
    return true;
}

async function save() {
    formError.value = '';
    if (!validate()) return;
    if (!settingsStore.config) return;

    const nextConfig = normalizeConfig({
        ...settingsStore.config,
        log_directory: form.value.log_directory.trim() || undefined,
        max_log_days: form.value.max_log_days,
        wake_quota_retry_window_minutes: form.value.wake_quota_retry_window_minutes,
        max_consecutive_errors: form.value.max_consecutive_errors,
        quota_poll_backoff_cap_minutes: form.value.quota_poll_backoff_cap_minutes,
        debug: form.value.debug,
        mock_url: form.value.mock_url.trim() || null,
    });

    await settingsStore.saveSettings(nextConfig);
    loadForm();
}

onMounted(() => {
    appStore.pageTitle = 'Settings';
    loadForm();
});

watch(() => settingsStore.config, () => {
    loadForm();
});
</script>
