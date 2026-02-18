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
    const updateStatus = ref<'idle' | 'downloading' | 'ready'>('idle');
    const updateProgress = ref(0);
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
            updateStatus.value = 'downloading';
            let contentLength = 0;
            let downloaded = 0;

            try {
                await updateAvailable.value.downloadAndInstall((event) => {
                    switch (event.event) {
                        case 'Started':
                            contentLength = event.data.contentLength || 0;
                            break;
                        case 'Progress':
                            downloaded += event.data.chunkLength;
                            if (contentLength > 0) {
                                updateProgress.value = Math.round((downloaded / contentLength) * 100);
                            }
                            break;
                        case 'Finished':
                            updateStatus.value = 'ready';
                            break;
                    }
                });
                updateStatus.value = 'ready';
            } catch (e) {
                console.error('Update failed', e);
                updateStatus.value = 'idle';
            }
        }
    }

    async function restartApp() {
        await relaunch();
    }

    function dismissUpdate() {
        updateAvailable.value = null;
        updateStatus.value = 'idle';
        updateProgress.value = 0;
    }

    return {
        theme,
        version,
        platform,
        updateAvailable,
        updateStatus,
        updateProgress,
        pageTitle,
        init,
        setTheme,
        checkForUpdates,
        installUpdate,
        restartApp,
        dismissUpdate
    };
});
