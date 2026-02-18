import { defineStore } from 'pinia';
import { ref } from 'vue';
import { getName, getVersion } from '@tauri-apps/api/app';
import { check, Update } from '@tauri-apps/plugin-updater';
import { relaunch } from '@tauri-apps/plugin-process';

export const useAppStore = defineStore('app', () => {
    const theme = ref(localStorage.getItem('theme') || 'dim');
    const version = ref('0.0.0');
    const platform = ref('unknown');
    const updateAvailable = ref<Update | null>(null);
    const pageTitle = ref('GLM Tray');

    async function init() {
        try {
            version.value = await getVersion();
            const name = await getName();
            platform.value = `${name} on ${navigator.platform}`; // Simplified
        } catch {
            version.value = 'dev';
            platform.value = 'Browser';
        }

        // Apply theme
        setTheme(theme.value);

        // Check updates
        checkForUpdates();
    }

    function setTheme(t: string) {
        theme.value = t;
        document.documentElement.setAttribute('data-theme', t);
        localStorage.setItem('theme', t);
    }

    async function checkForUpdates() {
        try {
            const update = await check();
            if (update?.available) {
                updateAvailable.value = update;
            }
        } catch (e) {
            console.warn('Update check failed', e);
        }
    }

    async function installUpdate() {
        if (updateAvailable.value) {
            await updateAvailable.value.downloadAndInstall();
            await relaunch();
        }
    }

    function dismissUpdate() {
        updateAvailable.value = null;
    }

    return { theme, version, platform, updateAvailable, pageTitle, init, setTheme, checkForUpdates, installUpdate, dismissUpdate };
});
