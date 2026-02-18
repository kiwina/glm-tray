<template>
  <div class="flex flex-col gap-2">
    <!-- Status Hero -->
    <div v-if="rtSlot?.enabled">
        <div v-if="rtSlot.auto_disabled" class="alert alert-soft alert-error text-xs font-bold mb-2">
           Auto-disabled (quota) · {{ rtSlot.consecutive_errors }} consecutive errors
        </div>
        <div v-else-if="rtSlot.wake_auto_disabled" class="alert alert-soft alert-warning text-xs font-bold mb-2">
           Wake temporarily disabled · {{ rtSlot.wake_consecutive_errors }} consecutive wake errors
        </div>
        <div v-else-if="rtSlot.consecutive_errors > 0" class="alert alert-dash alert-warning text-xs font-bold mb-2">
           {{ rtSlot.consecutive_errors }} error{{ rtSlot.consecutive_errors !== 1 ? 's' : '' }}
        </div>
    </div>

    <!-- Loading -->
    <div v-if="loading && !stats" class="flex items-center justify-center py-8 text-base-content/30">
        <span class="loading loading-spinner loading-sm mr-2"></span>Loading…
    </div>

    <div v-else-if="stats">
        <!-- 5h Usage (Runtime) -->
        <div class="card bg-base-100 card-border border-base-300 w-full mb-2">
          <div class="stats bg-base-100 w-full overflow-hidden">
            <div class="stat py-3 px-4 flex flex-col items-center justify-center">
              <div class="stat-title text-[10px] text-center">Model Calls</div>
              <div class="stat-value text-lg text-center">{{ (rtSlot?.total_model_calls_5h || 0).toLocaleString() }}</div>
              <div class="stat-desc opacity-40 text-center">current window</div>
            </div>
            <div class="stat py-3 px-4 flex flex-col items-center justify-center">
              <div class="stat-title text-[10px] text-center">Tokens</div>
              <div class="stat-value text-lg text-center">{{ formatTokens(rtSlot?.total_tokens_5h || 0) }}</div>
              <div class="stat-desc opacity-40 text-center">current window</div>
            </div>
          </div>
          <div class="text-[9px] opacity-30 text-center pb-1.5">{{ updatedLabel }}</div>
        </div>

        <!-- 24h Usage (Cached) -->
        <div class="card bg-base-100 card-border border-base-300 w-full mb-2">
          <div class="stats bg-base-100 w-full overflow-hidden">
            <div class="stat py-3 px-4 flex flex-col items-center justify-center">
              <div class="stat-title text-[10px] text-center">Model Calls</div>
              <div class="stat-value text-lg text-center">{{ stats.total_model_calls_24h.toLocaleString() }}</div>
              <div class="stat-desc opacity-40 text-center">24h window</div>
            </div>
            <div class="stat py-3 px-4 flex flex-col items-center justify-center">
              <div class="stat-title text-[10px] text-center">Tokens</div>
              <div class="stat-value text-lg text-center">{{ formatTokens(stats.total_tokens_24h) }}</div>
              <div class="stat-desc opacity-40 text-center">24h window</div>
            </div>
          </div>
          <div class="text-[9px] opacity-30 text-center pb-1.5">Manual refresh to update</div>
        </div>

        <!-- Limits -->
        <div class="flex gap-2">
            <div v-for="(lim, idx) in stats.limits" :key="idx" class="card bg-base-100 card-border border-base-300 card-sm flex-1 min-w-0">
                <div class="card-body p-3 gap-1 items-center">
                  <RadialGauge :percent="lim.percentage" />
                  <span class="text-xs font-semibold mt-1">{{ lim.type_name === 'TOKENS_LIMIT' ? 'Quota' : 'MCP Requests' }}</span>
                  <div class="flex items-baseline gap-1">
                    <span class="text-sm font-bold">{{ lim.current_value != null ? formatTokens(lim.current_value) : '—' }}</span>
                    <span v-if="lim.usage != null" class="text-[10px] opacity-40">/ {{ formatTokens(lim.usage) }}</span>
                  </div>
                  <span class="text-[10px] opacity-30">{{ (lim.unit ?? 3) <= 3 ? 'Reset' : 'Resets' }} {{ lim.next_reset_hms ?? '—' }}</span>
                </div>
            </div>
        </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, watch } from 'vue';
import { useKeysStore } from '../../stores/keys';
import { formatTokens } from '../../lib/ui-helpers';
import RadialGauge from '../../components/RadialGauge.vue';

const props = defineProps<{ slotId: number }>();
const keysStore = useKeysStore();

const rtSlot = computed(() => keysStore.runtime.slots.find(s => s.slot === props.slotId));
const stats = computed(() => keysStore.cachedStats[props.slotId]);
const loading = computed(() => keysStore.loadingStats);

const updatedLabel = computed(() => {
    const ts = rtSlot.value?.quota_last_updated;
    return ts ? `Polled ${new Date(ts).toLocaleTimeString()}` : 'Not yet polled';
});

onMounted(() => {
    if (!stats.value) {
        keysStore.fetchStats(props.slotId);
    }
});

watch(() => props.slotId, (newId) => {
    if (!keysStore.cachedStats[newId]) {
        keysStore.fetchStats(newId);
    }
});
</script>
