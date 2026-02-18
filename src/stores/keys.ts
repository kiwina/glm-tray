import { defineStore } from 'pinia';
import { ref, reactive } from 'vue';
import type { RuntimeStatus, SlotStats } from '../lib/types';
import { backendInvoke } from '../lib/api';
import { listen } from '@tauri-apps/api/event';

export const useKeysStore = defineStore('keys', () => {
    const runtime = ref<RuntimeStatus>({ monitoring: false, slots: [] });
    const cachedStats = reactive<Record<number, SlotStats>>({});
    const loadingStats = ref(false);

    async function fetchRuntime() {
        try {
            runtime.value = await backendInvoke<RuntimeStatus>('get_runtime_status');
        } catch (e) {
            console.error('Failed to fetch runtime', e);
        }
    }

    async function fetchStats(slot: number) {
        loadingStats.value = true;
        try {
            const stats = await backendInvoke<SlotStats>('fetch_slot_stats', { slot });
            cachedStats[slot] = stats;
        } catch (e) {
            console.warn('Failed to fetch stats for slot', slot, e);
        } finally {
            loadingStats.value = false;
        }
    }

    async function startMonitoring() {
        await backendInvoke('start_monitoring');
        await fetchRuntime();
    }

    async function stopMonitoring() {
        await backendInvoke('stop_monitoring');
        await fetchRuntime();
    }

    async function warmupAll() {
        await backendInvoke('warmup_all');
    }

    async function warmupSlot(slot: number) {
        await backendInvoke('warmup_slot', { slot });
    }

    // Setup listeners
    (async () => {
        try {
            await listen('quota-updated', (event: any) => {
                const p = event.payload;
                // Update runtime
                const slot = runtime.value.slots.find(s => s.slot === p.slot);
                if (slot) {
                    slot.percentage = p.percentage;
                    slot.timer_active = p.timer_active;
                    slot.next_reset_hms = p.next_reset_hms;
                    slot.total_model_calls_5h = p.total_model_calls_5h;
                    slot.total_tokens_5h = p.total_tokens_5h;
                    slot.quota_last_updated = p.quota_last_updated;
                }
                // Update stats if cached
                if (cachedStats[p.slot]) {
                    cachedStats[p.slot].total_model_calls_5h = p.total_model_calls_5h;
                    cachedStats[p.slot].total_tokens_5h = p.total_tokens_5h;
                }
            });

            await listen('monitoring-changed', () => {
                fetchRuntime();
            });

            // Initial fetch
            fetchRuntime();
        } catch (e) {
            console.warn('Listeners warning', e);
        }
    })();

    return { runtime, cachedStats, loadingStats, fetchRuntime, fetchStats, startMonitoring, stopMonitoring, warmupAll, warmupSlot };
});
