<template>
  <main class="flex h-screen bg-base-300 font-sans text-base-content selection:bg-primary selection:text-primary-content overflow-hidden">
    <Sidebar />
    <div class="flex-1 flex flex-col min-w-0 bg-base-100">
      <header v-show="showHeader" class="flex items-center justify-between px-5 py-3.5 border-b border-base-content/10 shrink-0 bg-base-100/50 backdrop-blur-md z-10 h-[60px]"
              data-tauri-drag-region>
        <div class="flex items-center gap-3 min-w-0">
          <router-link v-show="$route.name === 'dashboard'" to="/settings" class="btn btn-xs btn-ghost btn-circle opacity-60 hover:opacity-100 transition"
                       id="global-settings-btn" title="Settings">
            <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/>
                <circle cx="12" cy="12" r="3"/>
            </svg>
          </router-link>
          <h1 id="page-title" class="text-lg font-semibold tracking-tight truncate select-none">
            {{ appStore.pageTitle }}
          </h1>
        </div>
        <div id="header-actions" class="flex gap-1.5 items-center">
            <!-- Teleport target for view-specific actions -->
        </div>
      </header>

      <div class="flex-1 overflow-hidden relative" id="content-area">
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
import { onMounted, computed } from 'vue';
import { useRoute } from 'vue-router';
import Sidebar from './components/Sidebar.vue';
import { useAppStore } from './stores/app';
import { useSettingsStore } from './stores/settings';
import { useKeysStore } from './stores/keys';

const route = useRoute();
const appStore = useAppStore();
const settingsStore = useSettingsStore();
const keysStore = useKeysStore();

// Hide header on settings page (matching original global-settings.ts behavior)
const showHeader = computed(() => route.name !== 'settings');

onMounted(async () => {
    await appStore.init();

    // Load config
    await settingsStore.fetchSettings();

    // Initial runtime fetch
    await keysStore.fetchRuntime();

    // Start runtime polling (every 5 seconds, matching original)
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
