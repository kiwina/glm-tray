import { defineStore } from 'pinia';
import { ref, reactive } from 'vue';
import type { RuntimeStatus, SlotStats, QuotaUpdateEvent } from '../lib/types';
import { backendInvoke, logUiAction } from '../lib/api';
import { isTauriRuntime } from '../lib/constants';
import { listen } from '@tauri-apps/api/event';

export const useKeysStore = defineStore('keys', () => {
    const runtime = ref<RuntimeStatus>({ monitoring: false, slots: [] });
    const cachedStats = reactive<Record<number, SlotStats>>({});
    const loadingStats = ref(false);
    let pollingInterval: ReturnType<typeof setInterval> | null = null;

    async function fetchRuntime() {
        try {
            runtime.value = await backendInvoke<RuntimeStatus>('get_runtime_status');
        } catch (e) {
            console.error('Failed to fetch runtime', e);
        }
    }

    async function fetchStats(slot: number) {
        if (loadingStats.value) return;
        loadingStats.value = true;
        try {
            const stats = await backendInvoke<SlotStats>('fetch_slot_stats', { slot });
            cachedStats[slot] = stats;
        } catch (e) {
            console.warn('stats fetch failed:', e);
            // Set empty stats on failure to prevent infinite retry loop
            cachedStats[slot] = {
                level: 'unknown',
                limits: [],
                total_model_calls_24h: 0,
                total_tokens_24h: 0,
                total_model_calls_5h: 0,
                total_tokens_5h: 0,
                total_network_search_24h: 0,
                total_web_read_24h: 0,
                total_zread_24h: 0,
                total_search_mcp_24h: 0,
            };
        } finally {
            loadingStats.value = false;
        }
    }

    function deleteCachedStats(slot: number) {
        delete cachedStats[slot];
    }

    function clearAllCachedStats() {
        Object.keys(cachedStats).forEach(key => delete cachedStats[Number(key)]);
    }

    async function startMonitoring() {
        logUiAction('monitor-start');
        await backendInvoke('start_monitoring');
        await fetchRuntime();
    }

    async function stopMonitoring() {
        logUiAction('monitor-stop');
        await backendInvoke('stop_monitoring');
        await fetchRuntime();
    }

    async function warmupAll() {
        logUiAction('warmup-all');
        await backendInvoke('warmup_all');
    }

    async function warmupSlot(slot: number) {
        logUiAction('warmup-slot', slot);
        await backendInvoke('warmup_slot', { slot });
    }

    function startPolling() {
        if (pollingInterval) return;
        pollingInterval = setInterval(() => void fetchRuntime(), 5000);
    }

    function stopPolling() {
        if (pollingInterval) {
            clearInterval(pollingInterval);
            pollingInterval = null;
        }
    }

    // Setup Tauri event listeners
    async function setupListeners() {
        if (!isTauriRuntime) return;

        try {
            await listen<QuotaUpdateEvent>('quota-updated', (event) => {
                const p = event.payload;
                const slot = p.slot;

                // Update runtime slot data immediately (dashboard reads from here)
                const rtSlot = runtime.value.slots.find(s => s.slot === slot);
                if (rtSlot) {
                    rtSlot.percentage = p.percentage;
                    rtSlot.timer_active = p.timer_active;
                    rtSlot.next_reset_hms = p.next_reset_hms ?? rtSlot.next_reset_hms;
                    rtSlot.last_updated_epoch_ms = p.next_reset_epoch_ms ?? rtSlot.last_updated_epoch_ms;
                    rtSlot.total_model_calls_5h = p.total_model_calls_5h;
                    rtSlot.total_tokens_5h = p.total_tokens_5h;
                    rtSlot.quota_last_updated = p.quota_last_updated;
                }

                // Update cached stats if they exist (stats tab reads from here)
                const existing = cachedStats[slot];
                if (existing) {
                    for (const lim of existing.limits) {
                        if (lim.type_name === 'TOKENS_LIMIT') {
                            lim.percentage = p.percentage;
                            lim.next_reset_hms = p.next_reset_hms ?? lim.next_reset_hms;
                            lim.next_reset_time = p.next_reset_epoch_ms ?? lim.next_reset_time;
                        }
                    }
                    existing.total_model_calls_5h = p.total_model_calls_5h;
                    existing.total_tokens_5h = p.total_tokens_5h;
                }
            });

            await listen<boolean>('monitoring-changed', (event) => {
                const monitoring = event.payload;
                if (!monitoring) {
                    clearAllCachedStats();
                }
                void fetchRuntime();
            });
        } catch (err) {
            console.warn('Failed to setup listeners:', err);
        }
    }

    return {
        runtime,
        cachedStats,
        loadingStats,
        fetchRuntime,
        fetchStats,
        deleteCachedStats,
        clearAllCachedStats,
        startMonitoring,
        stopMonitoring,
        warmupAll,
        warmupSlot,
        startPolling,
        stopPolling,
        setupListeners,
    };
});
