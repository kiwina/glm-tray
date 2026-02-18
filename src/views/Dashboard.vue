<template>
  <div class="h-full overflow-y-auto p-4">
    <!-- Status Hero -->
    <div class="card bg-base-100 card-border border-base-300 card-sm from-base-content/5 bg-linear-to-bl to-50% mb-3">
      <div class="card-body p-3">
        <div class="flex items-center gap-3 text-xs font-semibold">
           <span v-if="keysStore.runtime.monitoring" class="text-success">● Monitoring</span>
           <span v-else class="text-base-content/30">○ Idle</span>
           <span class="opacity-50">{{ activeCount }}/{{ slots.length }} active</span>
           <span v-if="errorCount > 0" class="text-error ml-auto">{{ errorCount }} error{{ errorCount !== 1 ? 's' : '' }}</span>
        </div>
      </div>
    </div>

    <!-- Key List (No Card Wrapper) -->
    <div v-for="s in visibleSlots" :key="s.slot">
       <div class="border-t-base-content/5 flex items-center gap-2.5 border-t border-dashed py-2.5 px-1 cursor-pointer hover:bg-base-content/[.03] transition"
            @click="goKey(s.slot)">
          <span class="w-2 h-2 rounded-full shrink-0" :class="getDotClass(s, getRuntime(s.slot))"></span>
          <span class="text-sm font-semibold whitespace-nowrap min-w-[60px]">{{ s.name || `Key ${s.slot}` }}</span>
          
          <div class="flex items-center gap-2 ml-auto shrink-0">
             <div v-if="getRuntime(s.slot)?.auto_disabled" class="badge badge-sm badge-soft badge-error">DISABLED</div>
             <div v-else-if="getRuntime(s.slot)?.wake_auto_disabled" class="badge badge-sm badge-soft badge-warning">WAKE PAUSED</div>
             <div v-else-if="getRuntime(s.slot)?.percentage != null" class="flex items-center gap-2">
                 <progress class="progress w-14" 
                           :class="pctBarClass(getRuntime(s.slot)?.percentage || 0)" 
                           :value="getRuntime(s.slot)?.percentage || 0" 
                           max="100"></progress>
                 <span class="text-sm font-bold tabular-nums min-w-8 text-right">{{ getRuntime(s.slot)?.percentage }}%</span>
                 <span class="text-[10px] opacity-40 tabular-nums">{{ getRuntime(s.slot)?.next_reset_hms || '--:--:--' }}</span>
                 <span v-if="(getRuntime(s.slot)?.quota_consecutive_errors || 0) > 0" class="badge badge-error badge-xs">quota ×{{ getRuntime(s.slot)?.quota_consecutive_errors }}</span>
                 <span v-if="(getRuntime(s.slot)?.wake_consecutive_errors || 0) > 0" class="badge badge-warning badge-xs">wake ×{{ getRuntime(s.slot)?.wake_consecutive_errors }}</span>
             </div>
             <div v-else class="text-xs opacity-30">waiting…</div>
          </div>
       </div>

       <div class="border-t-base-content/5 border-t border-dashed px-1 pb-2">
         <div class="stats bg-base-100 w-full overflow-hidden shadow-sm border border-base-300 rounded-lg">
           <div class="stat py-2 px-3 flex flex-col items-center justify-center">
             <div class="stat-title text-[9px] text-center opacity-50">Used</div>
             <div class="stat-value text-base text-center">{{ getRuntime(s.slot)?.percentage || 0 }}%</div>
           </div>
           <div class="stat py-2 px-3 flex flex-col items-center justify-center">
              <div class="stat-title text-[9px] text-center opacity-50">Requests</div>
              <div class="stat-value text-base text-center">{{ (getRuntime(s.slot)?.total_model_calls_5h || 0).toLocaleString() }}</div>
           </div>
           <div class="stat py-2 px-3 flex flex-col items-center justify-center">
              <div class="stat-title text-[9px] text-center opacity-50">Tokens</div>
              <div class="stat-value text-base text-center">{{ formatTokens(getRuntime(s.slot)?.total_tokens_5h || 0) }}</div>
           </div>
         </div>
         <div class="text-[9px] opacity-40 text-center mt-1">Resets in {{ getRuntime(s.slot)?.next_reset_hms || '--:--:--' }} · {{ formatUpdated(getRuntime(s.slot)?.quota_last_updated) }}</div>
       </div>
    </div>

    <!-- Add Key -->
    <div v-if="nextFreeSlot" 
         class="border-t-base-content/5 flex items-center justify-center gap-2 border-t border-dashed py-2.5 px-1 cursor-pointer opacity-30 hover:opacity-70 hover:text-primary transition"
         @click="goKey(nextFreeSlot.slot)">
        <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
          <line x1="12" y1="5" x2="12" y2="19"/>
          <line x1="5" y1="12" x2="19" y2="12"/>
        </svg>
        <span class="text-sm font-semibold">Add Key</span>
    </div>

    <div class="text-center text-[10px] opacity-20 mt-3 pb-1">v{{ appStore.version }}</div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted } from 'vue';
import { useRouter } from 'vue-router';
import { useSettingsStore } from '../stores/settings';
import { useKeysStore } from '../stores/keys';
import { useAppStore } from '../stores/app';
import { getDotClass, pctBarClass, formatTokens } from '../lib/ui-helpers';

const router = useRouter();
const settingsStore = useSettingsStore();
const keysStore = useKeysStore();
const appStore = useAppStore();

const slots = computed(() => settingsStore.config?.slots || []);
const visibleSlots = computed(() => slots.value.filter(s => s.enabled));
const activeCount = computed(() => visibleSlots.value.length);

const nextFreeSlot = computed(() => {
    return slots.value.find(s => !s.enabled);
});

const errorCount = computed(() => {
    return keysStore.runtime.slots.reduce((acc, s) => 
        acc + s.quota_consecutive_errors + s.wake_consecutive_errors + s.consecutive_errors, 0);
});

function getRuntime(slot: number) {
    return keysStore.runtime.slots.find(s => s.slot === slot);
}

function formatUpdated(ts: string | null | undefined) {
    if (!ts) return 'Not yet polled';
    return `Updated ${new Date(ts).toLocaleTimeString()}`;
}

function goKey(slot: number) {
    router.push(`/key/${slot}`);
}

onMounted(() => {
    appStore.pageTitle = 'GLM Tray';
});
</script>
