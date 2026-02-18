<template>
  <main class="flex h-screen bg-base-300 font-sans text-base-content selection:bg-primary selection:text-primary-content overflow-hidden">
    <Sidebar />
    <div class="flex-1 flex flex-col min-w-0 bg-base-100">
      <header class="flex items-center justify-between px-5 py-3.5 border-b border-base-content/10 shrink-0 bg-base-100/50 backdrop-blur-md z-10 h-[60px]"
              data-tauri-drag-region>
        <div class="flex items-center gap-3 min-w-0">
          <router-link to="/settings" class="btn btn-xs btn-ghost btn-circle opacity-60 hover:opacity-100 transition" 
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

    <!-- Update Toast -->
    <div v-if="appStore.updateAvailable" class="toast toast-top toast-end z-50">
        <div class="alert alert-info shadow-lg text-sm">
            <div>
                <h3 class="font-bold">Update Available</h3>
                <div class="text-xs">New version found.</div>
            </div>
            <div class="flex-none">
                <button class="btn btn-sm btn-ghost" @click="appStore.dismissUpdate">Later</button>
                <button class="btn btn-sm btn-primary" @click="appStore.installUpdate">Update</button>
            </div>
        </div>
    </div>
  </main>
</template>

<script setup lang="ts">
import { onMounted } from 'vue';
import Sidebar from './components/Sidebar.vue';
import { useAppStore } from './stores/app';

const appStore = useAppStore();

onMounted(async () => {
    await appStore.init();
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
