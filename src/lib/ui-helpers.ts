import type { KeySlotConfig } from './types';

export function dotClass(
    slot: KeySlotConfig | undefined,
    rt: {
        auto_disabled?: boolean;
        wake_auto_disabled?: boolean;
        wake_pending?: boolean;
        quota_consecutive_errors?: number;
        wake_consecutive_errors?: number;
        consecutive_errors?: number;
        enabled?: boolean;
    } | undefined,
    monitoring = true,
): string {
    // Check global monitoring state first
    if (!monitoring) return "bg-base-content/20";

    // No runtime slot = monitoring is stopped → muted
    if (!rt) return "bg-base-content/20";

    if (
        rt.auto_disabled ||
        rt.wake_auto_disabled ||
        (rt.consecutive_errors && rt.consecutive_errors > 0) ||
        (rt.quota_consecutive_errors && rt.quota_consecutive_errors > 0) ||
        (rt.wake_consecutive_errors && rt.wake_consecutive_errors > 0)
    )
        return "bg-error";

    // Green only when monitoring is active (rt exists) and slot is enabled in config
    if (slot?.enabled) return "bg-success";
    return "bg-base-content/20";
}

// Keep old name as alias
export const getDotClass = dotClass;

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

export function isValidHm(value: string): boolean {
    return /^([01]\d|2[0-3]):([0-5]\d)$/.test(value);
}
