import { defineStore } from 'pinia';
import { ref } from 'vue';
import type { AppConfig } from '../lib/types';
import { backendInvoke, normalizeConfig } from '../lib/api';

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
