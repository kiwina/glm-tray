# Scheduler Architecture

How GLM Tray keeps API keys alive automatically.

---

## Overview

For each enabled key slot the scheduler spawns **two independent async tasks** that run concurrently:

```
┌──────────────────────────────────────────────────────┐
│                   SchedulerManager                    │
│                                                      │
│  Per slot:                                           │
│  ┌─────────────────────┐  ┌────────────────────────┐ │
│  │  Wake Scheduler     │  │  Quota Poller          │ │
│  │  Loop: every 60s    │  │  Loop: poll_interval   │ │
│  │                     │  │                        │ │
│  │ • Read slot config  │  │ • GET /quota/limit     │ │
│  │ • Evaluate modes    │  │ • GET /model-usage?5h  │ │
│  │ • Fire POST /wake   │  │ • Update UI state      │ │
│  │ • Update markers    │  │ • Confirm wake success │ │
│  └─────────┬───────────┘  └───────────┬────────────┘ │
│            │     poll_now channel      │              │
│            └──────────────────────────┘              │
│                    ┌────────────┐                    │
│                    │ SlotSchedule (shared state)     │
│                    │ next_reset, markers, wake_state │
│                    └────────────┘                    │
└──────────────────────────────────────────────────────┘
```

Both tasks share a `SlotSchedule` struct and communicate via a `poll_now` channel — the wake scheduler can signal the quota poller to fetch immediately after firing a wake.

---

## Wake Modes

All three modes can be enabled simultaneously on a single slot.

### Interval Mode

Fires a wake request every N minutes regardless of quota state.

```
Trigger: elapsed_since_last_wake >= wake_interval_minutes * 60
```

Use when: you want a steady heartbeat (e.g. every 60 minutes).  
Precision: ±60 seconds.

---

### Times Mode

Fires at specific clock times each day (e.g. `09:00`, `12:00`, `18:00`).

```
Trigger: current_HH:MM ∈ wake_times AND date-time marker not already set
```

A `date + time` marker prevents the same scheduled time from firing twice in the same minute.  
Precision: ±60 seconds.

---

### After Reset Mode

Fires N minutes after the quota timer resets.

```
Trigger: now >= nextResetTime + (wake_after_reset_minutes * 60_000)
         AND this reset timestamp hasn't already triggered a wake
```

Requires an observed `nextResetTime` from a previous quota poll to calculate the target. If the key is cold on startup, an initial wake must warm it first before this mode can track resets.  
Precision: ±60 seconds.

---

## Wake Confirmation & Retry

Sending a wake request is not enough — the app verifies that the API accepted it:

1. Wake POST fires → slot marked `wake_pending = true` → immediate quota poll triggered
2. Quota poller checks `TOKENS_LIMIT.nextResetTime`:
   - **Advanced beyond pre-wake snapshot** → ✅ confirmed: clear `wake_pending`, reset error counter
   - **Missing or unchanged** → ❌ failed: increment `wake_consecutive_errors`
3. While `wake_pending` is true and within the retry window, quota is fetched every minute
4. After the retry window elapses, one **forced wake retry** is attempted
5. If `wake_consecutive_errors` reaches `max_consecutive_errors`, the slot is **auto-disabled for waking** until manually re-enabled

The retry window duration is controlled by `wake_quota_retry_window_minutes` in Global Settings.

---

## Quota Polling

The quota poller runs on its own `poll_interval_minutes` schedule (default: 30 min), independent of the 60-second wake scheduler loop.

**Each poll fetches:**
1. `GET /quota/limit` — percentage, timer state, `nextResetTime`
2. `GET /model-usage?5h` — call counts and token totals for the dashboard

**Error backoff:**

| Consecutive errors | Next poll delay |
|--------------------|-----------------|
| 1 | `poll_interval × 2` |
| 2 | `poll_interval × 4` |
| 3 | `poll_interval × 8` |
| N | Capped at `quota_poll_backoff_cap_minutes` |

After `max_consecutive_errors` consecutive failures, the slot is auto-disabled.

> During wake confirmation (`wake_pending = true`), backoff is suspended and quota is fetched every minute regardless.

---

## Live Config Reload

Changing settings in the UI does not restart the scheduler. New config is broadcast via a Tokio `watch::channel` and picked up by both tasks on their next loop iteration:

```
User saves settings
  → reload_if_running() called
    → new config sent on config_tx channel
      → wake_scheduler and quota_poller apply on next iteration
```

---

## Shared State: `SlotSchedule`

```rust
struct SlotSchedule {
    // Written by quota poller, read by wake scheduler
    next_reset_epoch_ms: Option<i64>,

    // Wake deduplication (written by wake scheduler)
    last_times_marker: Option<String>,   // "YYYY-MM-DD HH:MM"
    last_reset_marker: Option<i64>,      // last fired reset epoch
    last_interval_fire: Instant,

    // Wake verification
    wake_retry_window_deadline: Option<Instant>,
    wake_timeout_retry_fired: bool,
}
```

---

## JSONL Log Fields

When logging is enabled, every scheduler event is written to the daily `.jsonl` file:

| Field | Description |
|-------|-------------|
| `action` | Logical step, e.g. `scheduled-wake`, `quota-poll`, `wake-confirmed` |
| `phase` | `request`, `response`, `error`, or `event` |
| `flow_id` | Ties a request line and its response/error line together |
| `duration_ms` | Request latency (request/response pairs only) |
| `slot` | Slot index (1–4) |
| `details` | Structured payload for internal events (wake pending, retry window, etc.) |

---

## Common Issues

| Symptom | Likely cause | Fix |
|---------|-------------|-----|
| After Reset never fires | Key is cold — no `nextResetTime` available | Trigger a manual wake first to warm the key |
| Wake fires twice | Marker not updating | Check `last_times_marker` / `last_reset_marker` logic |
| Slot auto-disabled | Hit `max_consecutive_errors` | Resolve network/API issue, re-enable slot manually |
| Config change ignored | `reload_if_running` not called after save | Ensure config save path calls the reload method |

---

## Performance

| Task | Loop interval | CPU | Memory |
|------|--------------|-----|--------|
| Wake Scheduler | 60 s | Minimal | ~100 bytes/slot |
| Quota Poller | `poll_interval_minutes` | Burst on poll | ~1 KB/slot |

Maximum 4 slots × 2 tasks = **8 concurrent async tasks**.

---

## See Also

- [API Reference](./API.md) — Endpoint details and response shapes
- [Debugging Guide](./DEBUGGING.md) — Mock server and debug mode
