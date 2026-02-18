<template>
  <div class="flex flex-col h-full">
    <div class="flex-1 overflow-y-auto p-4 main-component" id="tab-content">
       <Teleport to="#header-actions">
           <button v-if="currentTab === 'stats'" class="btn btn-xs btn-ghost btn-circle" title="Refresh stats" @click="refreshStats">
              <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/><path d="M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16"/><path d="M16 16h5v5"/></svg>
           </button>
           <button v-if="hasKey" class="btn btn-xs btn-ghost btn-circle" :class="{ 'warming-up': isWarmingUp }" title="Warmup key" @click="warmupValues">
              <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/></svg>
           </button>
       </Teleport>

       <KeepAlive>
         <component :is="activeTabComponent" :slotId="slotId" />
       </KeepAlive>
    </div>

    <div class="key-dock shrink-0" id="key-dock">
       <button @click="currentTab = 'stats'" :class="{ 'dock-active': currentTab === 'stats', 'opacity-30 pointer-events-none': !hasKey }" :disabled="!hasKey">Stats</button>
       <button @click="currentTab = 'schedule'" :class="{ 'dock-active': currentTab === 'schedule', 'opacity-30 pointer-events-none': !hasKey }" :disabled="!hasKey">Schedule</button>
       <button @click="currentTab = 'settings'" :class="{ 'dock-active': currentTab === 'settings' }">Settings</button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch, defineAsyncComponent, onMounted } from 'vue';
import { useRoute } from 'vue-router';
import { useSettingsStore } from '../stores/settings';
import { useKeysStore } from '../stores/keys';
import { useAppStore } from '../stores/app';

const KeyStats = defineAsyncComponent(() => import('./tabs/KeyStats.vue'));
const KeySchedule = defineAsyncComponent(() => import('./tabs/KeySchedule.vue'));
const KeySettings = defineAsyncComponent(() => import('./tabs/KeySettings.vue'));

const route = useRoute();
const settingsStore = useSettingsStore();
const keysStore = useKeysStore();
const appStore = useAppStore();

const slotId = computed(() => Number(route.params.id));
const currentTab = ref('stats');

const config = computed(() => settingsStore.config?.slots.find(s => s.slot === slotId.value));
const hasKey = computed(() => !!config.value?.api_key);

// Reset tab if no key
watch(hasKey, (val) => {
    if (!val) currentTab.value = 'settings';
    else if (currentTab.value === 'settings' && val) currentTab.value = 'stats';
});

// Update page title
watch(() => [slotId.value, config.value?.name], () => {
    const name = config.value?.name || `Key ${slotId.value}`;
    appStore.pageTitle = name;
}, { immediate: true });

const activeTabComponent = computed(() => {
    switch(currentTab.value) {
        case 'stats': return KeyStats;
        case 'schedule': return KeySchedule;
        case 'settings': return KeySettings;
        default: return KeyStats;
    }
});

// Header actions logic
const isWarmingUp = ref(false);

async function refreshStats() {
    await keysStore.fetchStats(slotId.value);
}

async function warmupValues() {
    if (isWarmingUp.value) return;
    isWarmingUp.value = true;
    try {
        await keysStore.warmupSlot(slotId.value);
    } finally {
        setTimeout(() => isWarmingUp.value = false, 1000);
    }
}
</script>
