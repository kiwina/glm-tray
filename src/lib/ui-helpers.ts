import type { KeySlotConfig } from './types';

export function getDotClass(slot: KeySlotConfig | undefined, rt: any) {
    if (!rt) return 'bg-base-content/30';
    if (rt.auto_disabled || rt.wake_auto_disabled || rt.quota_consecutive_errors > 0) return 'bg-error';
    if (rt.timer_active) return 'bg-success shadow-[0_0_8px_rgba(0,255,100,0.6)]';
    if (slot?.enabled) return 'bg-success'; // Idle but enabled
    return 'bg-base-content/30';
}

export function formatTokens(n: number): string {
    if (n >= 1_000_000_000) return (n / 1_000_000_000).toFixed(1) + "B";
    if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
    if (n >= 1_000) return (n / 1_000).toFixed(1) + "K";
    return String(n);
}

export function pctBarClass(pct: number): string {
    if (pct >= 80) return "progress-error";
    if (pct >= 50) return "progress-warning";
    return "progress-info";
}

export function isValidHm(s: string): boolean {
    return /^([0-1]?[0-9]|2[0-3]):[0-5][0-9]$/.test(s);
}
