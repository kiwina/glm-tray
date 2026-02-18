<template>
  <main class="flex h-screen bg-base-300 font-sans text-base-content selection:bg-primary selection:text-primary-content overflow-hidden">
    <Sidebar />
    <div class="flex-1 flex flex-col min-w-0 bg-base-100">
      <div v-if="!ready" class="flex-1 flex items-center justify-center">
        <span class="loading loading-spinner loading-sm opacity-30"></span>
      </div>
      <div v-else class="flex-1 overflow-hidden relative" id="content-area">
        <router-view v-slot="{ Component }">
          <transition name="fade" mode="out-in">
             <component :is="Component" />
          </transition>
        </router-view>
      </div>
    </div>

    <!-- Update Notification Toast -->
    <div v-if="appStore.updateAvailable" class="fixed top-4 right-4 z-[100]">
      <div class="card bg-base-100 card-border border-base-300 shadow-xl w-72">
        <div class="card-body p-4">
          <div class="flex items-start justify-between gap-2">
            <div class="flex items-center gap-2">
              <div class="p-1.5 rounded-lg bg-gradient-to-br from-blue-500 to-purple-600">
                <svg class="w-4 h-4 text-white" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
              </div>
              <div>
                <h3 class="font-bold text-sm">Update Available</h3>
                <p class="text-xs text-primary font-medium">v{{ appStore.updateAvailable.version }}</p>
              </div>
            </div>
            <button @click="appStore.dismissUpdate" class="btn btn-xs btn-ghost btn-circle"><svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>
          </div>

          <div v-if="appStore.updateStatus === 'downloading'" class="mt-3">
            <progress class="progress progress-primary w-full" :value="appStore.updateProgress" max="100"></progress>
            <p class="text-xs text-center mt-1 opacity-60">{{ appStore.updateProgress }}%</p>
          </div>

          <div v-else-if="appStore.updateStatus === 'ready'" class="mt-3">
             <button @click="appStore.restartApp" class="btn btn-primary btn-sm btn-block">Restart to Update</button>
          </div>

          <div v-else class="flex gap-2 mt-3">
            <button @click="appStore.installUpdate" class="btn btn-primary btn-sm flex-1">Download</button>
            <button @click="appStore.dismissUpdate" class="btn btn-ghost btn-sm">Later</button>
          </div>
        </div>
      </div>
    </div>
  </main>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue';
import Sidebar from './components/Sidebar.vue';
import { useAppStore } from './stores/app';
import { useSettingsStore } from './stores/settings';
import { useKeysStore } from './stores/keys';

const appStore = useAppStore();
const settingsStore = useSettingsStore();
const keysStore = useKeysStore();
const ready = ref(false);

onMounted(async () => {
    await appStore.init();

    // Load config + runtime before showing content
    await settingsStore.fetchSettings();
    await keysStore.fetchRuntime();

    ready.value = true;

    // Auto-check for updates after settings are loaded (respects auto_update preference)
    if (settingsStore.config?.auto_update !== false) {
        setTimeout(() => void appStore.checkAndShowUpdate(), 3000);
    }

    // Start runtime polling (every 5 seconds)
    keysStore.startPolling();

    // Setup Tauri event listeners
    await keysStore.setupListeners();
});
</script>

<style>
.fade-enter-active,
.fade-leave-active {
  transition: opacity 0.15s ease;
}

.fade-enter-from,
.fade-leave-to {
  opacity: 0;
}
</style>
