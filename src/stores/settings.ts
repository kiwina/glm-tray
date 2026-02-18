import { defineStore } from 'pinia';
import { ref } from 'vue';
import type { AppConfig } from '../lib/types';
import { backendInvoke } from '../lib/api';

export const useSettingsStore = defineStore('settings', () => {
    const config = ref<AppConfig | null>(null);
    const loading = ref(false);

    async function fetchSettings() {
        loading.value = true;
        try {
            config.value = await backendInvoke<AppConfig>('load_settings');
        } finally {
            loading.value = false;
        }
    }

    async function saveSettings(newConfig: AppConfig) {
        loading.value = true;
        try {
            const normalized = normalizeConfig(newConfig);
            config.value = await backendInvoke<AppConfig>('save_settings', { settings: normalized });
        } finally {
            loading.value = false;
        }
    }

    return { config, loading, fetchSettings, saveSettings };
});

function normalizeConfig(config: AppConfig): AppConfig {
    const global_quota_url = config.global_quota_url?.trim() || "https://api.z.ai/api/monitor/usage/quota/limit";
    const global_request_url = config.global_request_url?.trim() || "https://api.z.ai/api/coding/paas/v4/chat/completions";

    const max_log_days = Number.isFinite(config.max_log_days)
        ? Math.min(365, Math.max(1, Math.floor(config.max_log_days)))
        : 7;
    const wake_quota_retry_window_minutes = Number.isFinite(config.wake_quota_retry_window_minutes)
        ? Math.min(1_440, Math.max(1, Math.floor(config.wake_quota_retry_window_minutes)))
        : 15;
    const max_consecutive_errors = Number.isFinite(config.max_consecutive_errors)
        ? Math.min(1_000, Math.max(1, Math.floor(config.max_consecutive_errors)))
        : 10;
    const quota_poll_backoff_cap_minutes = Number.isFinite(config.quota_poll_backoff_cap_minutes)
        ? Math.min(1_440, Math.max(1, Math.floor(config.quota_poll_backoff_cap_minutes)))
        : 480;

    const slots = (config.slots || []).map((s) => ({
        ...s,
        poll_interval_minutes: Math.max(1, Number(s.poll_interval_minutes) || 30),
        schedule_interval_minutes: Math.max(1, Number(s.schedule_interval_minutes) || 60),
        schedule_after_reset_minutes: Math.max(1, Number(s.schedule_after_reset_minutes) || 1),
        schedule_times: (s.schedule_times ?? []).slice(0, 5),
    }));

    return {
        ...config,
        slots,
        global_quota_url,
        global_request_url,
        log_directory: config.log_directory?.trim() || undefined,
        max_log_days,
        wake_quota_retry_window_minutes,
        max_consecutive_errors,
        quota_poll_backoff_cap_minutes,
        debug: config.debug ?? false,
        mock_url: config.mock_url?.trim() || null,
    };
}
