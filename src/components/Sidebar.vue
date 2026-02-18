<template>
  <aside class="w-[76px] bg-base-200 border-r border-neutral flex flex-col shrink-0 z-20 relative h-full">
    <div class="flex-1 flex flex-col items-center w-full gap-1 overflow-y-auto no-scrollbar py-2">
      <!-- Home -->
      <router-link to="/dashboard" class="nav-btn relative flex flex-col items-center justify-center gap-1 w-full aspect-square border-none bg-transparent text-base-content/60 cursor-pointer hover:bg-base-content/[.04] hover:text-base-content transition rounded-none" active-class="active">
        <svg class="w-6 h-6" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"></path>
            <polyline points="9 22 9 12 15 12 15 22"></polyline>
        </svg>
        <span class="text-[10px] font-medium tracking-wide">Home</span>
      </router-link>

      <!-- Dynamic Keys -->
      <router-link v-for="s in visibleSlots" :key="s.slot" :to="`/key/${s.slot}`" 
                   class="nav-btn relative flex flex-col items-center justify-center gap-1 w-full aspect-square border-none bg-transparent text-base-content/60 cursor-pointer hover:bg-base-content/[.04] hover:text-base-content transition rounded-none"
                   active-class="active">
          <span class="relative w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold border border-neutral transition-colors nav-num">
            {{ s.slot }}
            <span class="absolute -top-0.5 -right-0.5 w-[7px] h-[7px] rounded-full border-[1.5px] border-base-200" :class="getDotClass(s, getRuntime(s.slot))"></span>
          </span>
          <span class="text-[10px] font-medium tracking-wide max-w-[68px] text-center truncate px-1">{{ shortName(s.name) || `Key ${s.slot}` }}</span>
      </router-link>
    </div>

    <!-- Controls -->
    <div class="border-t border-neutral py-2 flex flex-col w-full px-0 gap-1">
        <button class="nav-btn relative flex flex-col items-center justify-center gap-1 py-1 w-full border-none bg-transparent cursor-pointer transition"
                :class="monitorBtnClass"
                :disabled="!hasKeys"
                @click="toggleMonitoring">
            <svg v-if="keysStore.runtime?.monitoring" class="w-[22px] h-[22px]" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>
            <svg v-else class="w-[22px] h-[22px]" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>
            <span class="text-[10px] font-medium tracking-wide">{{ keysStore.runtime?.monitoring ? 'Stop' : 'Start' }}</span>
        </button>

        <button class="nav-btn relative flex flex-col items-center justify-center gap-1 py-1 w-full border-none bg-transparent text-base-content/60 cursor-pointer hover:text-base-content hover:bg-base-content/[.04] transition"
                :disabled="!hasKeys"
                title="Warmup all keys"
                @click="warmupAll">
            <svg class="w-[22px] h-[22px]" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/>
            </svg>
            <span class="text-[10px] font-medium tracking-wide">Warmup</span>
        </button>
    </div>

    <!-- Logo -->
    <div class="border-t border-neutral py-2 w-full">
        <a href="https://z.ai/subscribe?ic=GONVESHW5A" target="_blank" class="block mt-1 mb-1 text-center opacity-50 hover:opacity-90 transition-opacity">
            <img src="../assets/logo-white.svg" alt="logo" class="w-8 h-8 mx-auto" />
        </a>
    </div>
  </aside>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { useSettingsStore } from '../stores/settings';
import { useKeysStore } from '../stores/keys';
import { getDotClass } from '../lib/ui-helpers';

const settingsStore = useSettingsStore();
const keysStore = useKeysStore();

const visibleSlots = computed(() => {
    return settingsStore.config?.slots.filter(s => s.enabled || s.api_key || s.name) || [];
});

const hasKeys = computed(() => visibleSlots.value.length > 0);

function getRuntime(slot: number) {
    return keysStore.runtime.slots.find(s => s.slot === slot);
}

const monitorBtnClass = computed(() => {
    if (keysStore.runtime.monitoring) return 'text-error hover:bg-error/10';
    if (!hasKeys.value) return 'text-base-content/30 opacity-50 cursor-not-allowed';
    return 'text-base-content/60 hover:text-base-content hover:bg-base-content/[.04]';
});

function shortName(name: string | undefined) {
    if (!name) return '';
    return name.length > 8 ? name.slice(0, 7) + '…' : name;
}

// Actions
async function toggleMonitoring() {
    if (keysStore.runtime.monitoring) {
        await keysStore.stopMonitoring();
    } else {
        await keysStore.startMonitoring();
    }
}

async function warmupAll() {
    await keysStore.warmupAll();
}
</script>

<style scoped>
.nav-btn.active {
    color: var(--color-primary);
    background-color: color-mix(in oklab, var(--color-primary) 10%, transparent);
    box-shadow: inset -2px 0 0 0 var(--color-primary); 
}

.nav-btn.active .nav-num {
    border-color: var(--color-primary);
    color: var(--color-primary);
}
</style>
