import { defineStore } from 'pinia';
import { ref } from 'vue';
import { getVersion } from '@tauri-apps/api/app';
import { check as tauriCheck } from '@tauri-apps/plugin-updater';
import { relaunch as tauriRelaunch } from '@tauri-apps/plugin-process';
import { isTauriRuntime } from '../lib/constants';
import type { UpdateInfo } from '../lib/types';
import { backendInvoke } from '../lib/api';

export const useAppStore = defineStore('app', () => {
    const version = ref('');

    // Update state
    const updateInfo = ref<UpdateInfo | null>(null);
    const updateStatus = ref<'idle' | 'downloading' | 'ready'>('idle');
    const updateProgress = ref(0);

    // Computed-like
    const updateAvailable = ref<{ version: string } | null>(null);

    async function init() {
        // Fetch app version
        if (isTauriRuntime) {
            try {
                version.value = await getVersion();
            } catch {
                version.value = 'dev';
            }
        } else {
            version.value = 'preview';
        }

        // Apply theme
        document.documentElement.setAttribute('data-theme', 'glm');

        // Check for updates after a short delay
        setTimeout(() => void checkAndShowUpdate(), 3000);
    }

    async function checkAndShowUpdate() {
        if (!isTauriRuntime) return;

        try {
            const info = await backendInvoke<UpdateInfo>('check_for_updates_cmd');
            if (!info.has_update) return;

            updateInfo.value = info;
            updateAvailable.value = { version: info.latest_version };
        } catch (err) {
            console.warn('Update check failed:', err);
        }
    }

    async function installUpdate() {
        if (!isTauriRuntime) return;

        updateStatus.value = 'downloading';
        updateProgress.value = 0;

        try {
            const update = await tauriCheck();
            if (!update) {
                console.warn('Native updater returned null');
                updateStatus.value = 'idle';
                return;
            }

            let downloaded = 0;
            let contentLength = 0;

            await update.downloadAndInstall((event) => {
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
                        break;
                }
            });

            updateStatus.value = 'ready';
        } catch (err) {
            console.error('Update download failed:', err);
            updateStatus.value = 'idle';
        }
    }

    async function restartApp() {
        try {
            await tauriRelaunch();
        } catch (err) {
            console.error('Relaunch failed:', err);
        }
    }

    function dismissUpdate() {
        updateInfo.value = null;
        updateAvailable.value = null;
        updateStatus.value = 'idle';
        updateProgress.value = 0;
    }

    return {
        version,
        updateInfo,
        updateAvailable,
        updateStatus,
        updateProgress,
        init,
        checkAndShowUpdate,
        installUpdate,
        restartApp,
        dismissUpdate,
    };
});
