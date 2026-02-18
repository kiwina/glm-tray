<template>
  <aside class="w-[76px] bg-base-200 border-r border-neutral flex flex-col shrink-0 z-20 relative h-full">
    <div class="flex-1 flex flex-col items-center w-full gap-1 overflow-y-auto no-scrollbar py-2">
      <!-- Home -->
      <router-link to="/dashboard" class="nav-btn relative flex flex-col items-center justify-center gap-1 py-2.5 w-full border-none bg-transparent text-base-content/60 cursor-pointer hover:text-base-content hover:bg-base-content/[.04] transition" active-class="active">
        <svg class="w-[22px] h-[22px]" viewBox="0 0 24 24" fill="none" stroke="currentColor"
             stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
          <rect x="3" y="3" width="7" height="7" rx="1"/>
          <rect x="14" y="3" width="7" height="7" rx="1"/>
          <rect x="3" y="14" width="7" height="7" rx="1"/>
          <rect x="14" y="14" width="7" height="7" rx="1"/>
        </svg>
        <span class="text-[10px] font-medium tracking-wide">Home</span>
      </router-link>

      <!-- Dynamic Keys -->
      <router-link v-for="s in visibleSlots" :key="s.slot" :to="`/key/${s.slot}`"
                   class="nav-btn relative flex flex-col items-center justify-center gap-1 py-2.5 w-full border-none bg-transparent text-base-content/60 cursor-pointer hover:text-base-content hover:bg-base-content/[.04] transition"
                   active-class="active">
          <span class="nav-num relative w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold border border-neutral transition-colors">
            {{ s.slot }}
            <span class="absolute -top-0.5 -right-0.5 w-[7px] h-[7px] rounded-full border-[1.5px] border-base-200" :class="dotClass(s, getRuntime(s.slot))"></span>
          </span>
          <span class="text-[10px] font-medium tracking-wide max-w-[68px] text-center truncate">{{ shortName(s) }}</span>
      </router-link>
    </div>

    <!-- Controls -->
    <div class="border-t border-neutral py-2 flex flex-col w-full px-0 gap-1">
        <!-- Monitor button -->
        <button id="monitor-btn"
                class="nav-btn relative flex flex-col items-center justify-center gap-1 py-2.5 w-full border-none bg-transparent cursor-pointer transition"
                :class="monitorBtnClass"
                :disabled="monitorBtnDisabled"
                :title="monitorBtnTitle"
                @click="toggleMonitoring">
            <svg v-if="keysStore.runtime.monitoring" class="w-[22px] h-[22px]" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>
            <svg v-else class="w-[22px] h-[22px]" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>
            <span class="text-[10px] font-medium tracking-wide">{{ keysStore.runtime.monitoring ? 'Stop' : 'Start' }}</span>
        </button>

        <!-- Warmup button -->
        <button id="warmup-btn"
                class="nav-btn relative flex flex-col items-center justify-center gap-1 py-2.5 w-full border-none bg-transparent text-base-content/60 cursor-pointer hover:text-base-content hover:bg-base-content/[.04] transition"
                :class="{ 'warming-up': warmingUp }"
                :disabled="!hasKeys"
                :title="hasKeys ? 'Wake keys that are not ready' : 'Add an API key first'"
                @click="doWarmupAll">
            <svg class="w-[22px] h-[22px]" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/>
            </svg>
            <span class="text-[10px] font-medium tracking-wide">Warmup</span>
        </button>
    </div>

    <!-- Logo -->
    <div class="border-t border-neutral py-2 w-full">
        <a href="https://z.ai/subscribe?ic=GONVESHW5A" @click.prevent="openLogoLink" class="sidebar-logo-link block mt-1 mb-1 text-center opacity-50 hover:opacity-90 transition-opacity">
            <img src="../assets/logo-white.svg" alt="logo" class="w-8 h-8 mx-auto" />
        </a>
    </div>
  </aside>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue';
import { useSettingsStore } from '../stores/settings';
import { useKeysStore } from '../stores/keys';
import { dotClass } from '../lib/ui-helpers';
import { hasSlotWithKey } from '../lib/api';
import { isTauriRuntime } from '../lib/constants';
import type { KeySlotConfig } from '../lib/types';

const settingsStore = useSettingsStore();
const keysStore = useKeysStore();
const warmingUp = ref(false);

const visibleSlots = computed(() => {
    return settingsStore.config?.slots.filter(s => s.enabled || s.api_key || s.name) || [];
});

const hasKeys = computed(() => hasSlotWithKey(settingsStore.config));

function getRuntime(slot: number) {
    return keysStore.runtime.slots.find(s => s.slot === slot);
}

function shortName(slot: KeySlotConfig) {
    const name = slot.name || `Key ${slot.slot}`;
    return name.length > 8 ? name.slice(0, 7) + '…' : name;
}

const monitorBtnClass = computed(() => {
    if (keysStore.runtime.monitoring) {
        return 'text-error hover:bg-error/10';
    }
    if (!hasKeys.value) {
        return 'text-base-content/30 cursor-not-allowed opacity-40';
    }
    return 'text-base-content/60 hover:text-base-content hover:bg-base-content/[.04]';
});

const monitorBtnDisabled = computed(() => {
    if (keysStore.runtime.monitoring) return false;
    return !hasKeys.value;
});

const monitorBtnTitle = computed(() => {
    if (keysStore.runtime.monitoring) return 'Stop monitoring';
    return hasKeys.value ? 'Start monitoring all keys' : 'Add an API key first';
});

async function toggleMonitoring() {
    if (!hasKeys.value && !keysStore.runtime.monitoring) return;
    try {
        if (keysStore.runtime.monitoring) {
            await keysStore.stopMonitoring();
        } else {
            await keysStore.startMonitoring();
        }
    } catch (err) {
        console.warn('monitoring command failed:', err);
        await keysStore.fetchRuntime().catch(() => {});
    }
}

async function doWarmupAll() {
    if (!hasKeys.value) return;
    warmingUp.value = true;
    try {
        await keysStore.warmupAll();
    } finally {
        warmingUp.value = false;
    }
}

async function openLogoLink() {
    const url = 'https://z.ai/subscribe?ic=GONVESHW5A';
    if (isTauriRuntime) {
        const { openUrl } = await import('@tauri-apps/plugin-opener');
        await openUrl(url);
    } else {
        window.open(url, '_blank');
    }
}
</script>
