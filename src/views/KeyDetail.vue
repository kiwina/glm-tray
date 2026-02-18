<template>
  <div class="flex flex-col h-full">
    <div class="flex-1 overflow-y-auto p-4 main-content" id="tab-content">
       <Teleport to="#header-actions">
           <button v-if="hasKey" class="btn btn-xs btn-ghost btn-circle warmup-slot-btn" :class="{ 'warming-up': isWarmingUp }" title="Warmup this key" @click="warmupKey">
              <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/></svg>
           </button>
           <button v-if="currentTab === 'stats'" class="btn btn-xs btn-ghost btn-circle refresh-header-btn" title="Refresh stats" @click="refreshStats">
              <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/><path d="M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16"/><path d="M16 16h5v5"/></svg>
           </button>
       </Teleport>

       <component :is="activeTabComponent" :slotId="slotId" :key="slotId + '-' + currentTab" />
    </div>

    <div class="key-dock shrink-0" id="key-dock">
       <button data-tab="stats" @click="switchTab('stats')" :class="{ 'dock-active': currentTab === 'stats', 'opacity-30 pointer-events-none': !hasKey }" :disabled="!hasKey" :title="!hasKey ? 'Add an API key first' : ''">
         <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
           <path d="M18 20V10"/><path d="M12 20V4"/><path d="M6 20v-6"/>
         </svg>
         Stats
       </button>
       <button data-tab="schedule" @click="switchTab('schedule')" :class="{ 'dock-active': currentTab === 'schedule', 'opacity-30 pointer-events-none': !hasKey }" :disabled="!hasKey" :title="!hasKey ? 'Add an API key first' : ''">
         <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
           <circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>
         </svg>
         Schedule
       </button>
       <button data-tab="settings" @click="switchTab('settings')" :class="{ 'dock-active': currentTab === 'settings' }">
         <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
           <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/>
           <circle cx="12" cy="12" r="3"/>
         </svg>
         Settings
       </button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch, onMounted } from 'vue';
import { useRoute } from 'vue-router';
import { useSettingsStore } from '../stores/settings';
import { useKeysStore } from '../stores/keys';
import { useAppStore } from '../stores/app';
import { logUiAction } from '../lib/api';
import KeyStats from './tabs/KeyStats.vue';
import KeySchedule from './tabs/KeySchedule.vue';
import KeySettings from './tabs/KeySettings.vue';

const route = useRoute();
const settingsStore = useSettingsStore();
const keysStore = useKeysStore();
const appStore = useAppStore();

const slotId = computed(() => Number(route.params.id));
const currentTab = ref<'stats' | 'schedule' | 'settings'>('stats');

const slotConfig = computed(() => settingsStore.config?.slots.find(s => s.slot === slotId.value));
const hasKey = computed(() => !!(slotConfig.value?.api_key?.trim()));

// Force settings tab when no API key is configured
watch(hasKey, (val) => {
    if (!val && currentTab.value !== 'settings') {
        currentTab.value = 'settings';
    }
}, { immediate: true });

// Update page title based on tab (matching original key-detail.ts)
const tabTitles: Record<string, string> = {
    stats: 'Stats',
    schedule: 'Schedule',
    settings: 'Settings',
};

watch([slotId, currentTab], () => {
    appStore.pageTitle = tabTitles[currentTab.value] || 'Stats';
}, { immediate: true });

const activeTabComponent = computed(() => {
    switch (currentTab.value) {
        case 'stats': return KeyStats;
        case 'schedule': return KeySchedule;
        case 'settings': return KeySettings;
        default: return KeyStats;
    }
});

function switchTab(tab: 'stats' | 'schedule' | 'settings') {
    if (tab === currentTab.value) return;
    logUiAction('tab-switch', slotId.value, { tab });
    currentTab.value = tab;
}

// Header actions logic
const isWarmingUp = ref(false);

async function refreshStats() {
    logUiAction('stats-refresh', slotId.value);
    keysStore.deleteCachedStats(slotId.value);
    // Re-fetch will happen automatically due to reactivity in KeyStats
}

async function warmupKey() {
    if (isWarmingUp.value) return;
    isWarmingUp.value = true;
    try {
        await keysStore.warmupSlot(slotId.value);
    } finally {
        isWarmingUp.value = false;
    }
}
</script>
