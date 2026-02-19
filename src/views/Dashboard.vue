<template>
  <div class="h-full flex flex-col">
    <div class="flex-1 overflow-y-auto p-2 main-content mt-2">

    <!-- Key List -->
    <div v-for="slot in enabledSlots" :key="slot.slot"
         class="cursor-pointer key-row pb-1.5"
         @click="goKey(slot.slot)">

       <!-- Key header row -->
         <div class="flex items-center gap-2 px-1 pt-1.5 pb-1">
           <span class="w-2 h-2 rounded-full shrink-0 ml-1" :class="dotClass(slot, getRuntime(slot.slot), keysStore.runtime.monitoring)"></span>
           <span class="text-sm font-semibold whitespace-nowrap min-w-[60px]">{{ slot.name || `Key ${slot.slot}` }}</span>

         <div class="flex items-center gap-2 ml-auto shrink-0">
            <template v-if="getRuntime(slot.slot)?.auto_disabled">
              <span class="badge badge-sm badge-soft badge-error">DISABLED</span>
            </template>
            <template v-else-if="getRuntime(slot.slot)?.wake_auto_disabled">
              <span class="badge badge-sm badge-soft badge-warning">WAKE PAUSED</span>
            </template>
            <template v-else>
              <span v-if="(getRuntime(slot.slot)?.quota_consecutive_errors || 0) > 0" class="badge badge-warning badge-xs">quota ×{{ getRuntime(slot.slot)?.quota_consecutive_errors }}</span>
              <span v-if="(getRuntime(slot.slot)?.wake_consecutive_errors || 0) > 0" class="badge badge-error badge-xs">wake ×{{ getRuntime(slot.slot)?.wake_consecutive_errors }}</span>
              <progress v-if="getRuntime(slot.slot)?.percentage != null"
                        class="progress w-14"
                        :class="pctBarClass(getRuntime(slot.slot)!.percentage || 0)"
                        :value="getRuntime(slot.slot)!.percentage || 0"
                        max="100"></progress>
              <span v-else-if="(getRuntime(slot.slot)?.quota_consecutive_errors || 0) === 0 && (getRuntime(slot.slot)?.wake_consecutive_errors || 0) === 0" class="text-xs opacity-30">waiting…</span>
            </template>
         </div>
       </div>

       <!-- Stats boxes -->
       <div class="px-1">
         <div class="stats bg-base-100 w-full overflow-hidden shadow-sm border border-base-300 rounded-lg">
           <div class="stat py-2 px-3 flex flex-col items-center justify-center">
             <div class="stat-title text-[9px] text-center opacity-50">Used</div>
             <div class="stat-value text-base text-center">{{ getRuntime(slot.slot)?.percentage ?? 0 }}%</div>
           </div>
           <div class="stat py-2 px-3 flex flex-col items-center justify-center">
              <div class="stat-title text-[9px] text-center opacity-50">Requests</div>
              <div class="stat-value text-base text-center">{{ (getRuntime(slot.slot)?.total_model_calls_5h ?? 0).toLocaleString() }}</div>
           </div>
           <div class="stat py-2 px-3 flex flex-col items-center justify-center">
              <div class="stat-title text-[9px] text-center opacity-50">Tokens</div>
              <div class="stat-value text-base text-center">{{ formatTokens(getRuntime(slot.slot)?.total_tokens_5h ?? 0) }}</div>
           </div>
         </div>
         <div class="text-[9px] opacity-40 text-center mt-1">Resets at {{ getRuntime(slot.slot)?.next_reset_hms || '--:--:--' }} · {{ formatUpdated(getRuntime(slot.slot)?.quota_last_updated) }}</div>
       </div>
    </div>

    <!-- Add Key -->
    <div v-if="nextFreeSlot"
         class="border-t-base-content/5 flex items-center justify-center gap-2 border-t border-dashed py-2.5 px-1 cursor-pointer opacity-30 hover:opacity-70 hover:text-primary transition add-key-row"
         @click="goKey(nextFreeSlot.slot)">
        <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
          <line x1="12" y1="5" x2="12" y2="19"/>
          <line x1="5" y1="12" x2="19" y2="12"/>
        </svg>
        <span class="text-sm font-semibold">Add Key</span>
    </div>
    </div>

    <!-- Footer -->
    <div class="px-3 py-2 shrink-0 text-center">
      <div class="text-xs"><a href="https://github.com/kiwina/glm-tray" class="link link-hover opacity-60" @click.prevent="openGithubLink">by @Kiwina</a> <span class="text-red-500">❤</span> <a href="https://z.ai/subscribe?ic=GONVESHW5A" class="link link-hover opacity-60" @click.prevent="openSubscribeLink">Subscribe to z.ai coding plan</a></div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { useRouter } from 'vue-router';
import { useSettingsStore } from '../stores/settings';
import { useKeysStore } from '../stores/keys';
import { dotClass, pctBarClass, formatTokens } from '../lib/ui-helpers';
import { isTauriRuntime } from '../lib/constants';

const router = useRouter();
const settingsStore = useSettingsStore();
const keysStore = useKeysStore();

const config = computed(() => settingsStore.config);
const enabledSlots = computed(() => config.value?.slots.filter(s => s.enabled) || []);

const nextFreeSlot = computed(() => {
    return config.value?.slots.filter(s => !s.enabled)?.[0] ?? null;
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

async function openSubscribeLink() {
    const url = 'https://z.ai/subscribe?ic=GONVESHW5A';
    if (isTauriRuntime) {
        const { openUrl } = await import('@tauri-apps/plugin-opener');
        await openUrl(url);
    } else {
        window.open(url, '_blank');
    }
}

async function openGithubLink() {
    const url = 'https://github.com/kiwina/glm-tray';
    if (isTauriRuntime) {
        const { openUrl } = await import('@tauri-apps/plugin-opener');
        await openUrl(url);
    } else {
        window.open(url, '_blank');
    }
}

</script>
