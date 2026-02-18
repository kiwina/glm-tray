# Scheduler Architecture

## Overview

The GLM Tray scheduler uses a **dual-loop architecture** that separates wake scheduling from quota polling, enabling minute-precision wake triggers while maintaining efficient quota monitoring.

## Architecture Design

### Two Independent Loops Per Slot

Each enabled slot spawns **two independent async tasks**:

```
┌─────────────────────────────────────────────────────────────────┐
│                      SchedulerManager                           │
├─────────────────────────────────────────────────────────────────┤
│  For each enabled slot:                                         │
│                                                                 │
│  ┌──────────────────────┐      ┌──────────────────────┐        │
│  │  Wake Scheduler      │      │  Quota Poller        │        │
│  │  (Every 60 sec)      │      │  (Configurable)      │        │
│  ├──────────────────────┤      ├──────────────────────┤        │
│  │ • Read config        │      │ • Fetch API quota    │        │
│  │ • Read schedule state│      │ • Update schedule    │        │
│  │ • Check wake modes   │      │ • Update UI status   │        │
│  │ • Fire wake requests │      │ • Error backoff      │        │
│  │ • Update markers     │      │ • Refresh tray       │        │
│  └──────────────────────┘      └──────────────────────┘        │
│           │                              │                      │
│           └──────────┬───────────────────┘                      │
│                      │                                          │
│              ┌───────▼────────┐                                 │
│              │ SlotSchedule   │ (Shared State)                  │
│              │ - next_reset   │                                 │
│              │ - markers      │                                 │
│              └────────────────┘                                 │
└─────────────────────────────────────────────────────────────────┘
```

### Shared State: `SlotSchedule`

```rust
struct SlotSchedule {
    // Updated by quota poller, read by wake scheduler
    next_reset_epoch_ms: Option<i64>,
    
    // Wake deduplication markers (updated by wake scheduler)
    last_times_marker: Option<String>,      // "YYYY-MM-DD HH:MM"
    last_reset_marker: Option<i64>,         // Last fired reset timestamp
    last_interval_fire: Instant,            // Last interval wake time

    // Wake verification state
    wake_retry_window_deadline: Option<Instant>, // Active window after wake send
    wake_timeout_retry_fired: bool,              // Whether forced retry has already occurred
}
```

## Wake Modes

### 1. Interval Mode

**Trigger condition**: Time elapsed since last wake

```rust
if now - last_interval_fire >= wake_interval_minutes * 60 {
    fire_wake();
    last_interval_fire = now;
}
```

**Use case**: Regular keepalive pings (e.g., every 60 minutes)

**Precision**: ±60 seconds (checked every minute)

### 2. Times Mode

**Trigger condition**: Current time matches one of the scheduled times

```rust
current_hm = format!("{:02}:{:02}", hour, minute);
if wake_times.contains(current_hm) && marker != current_date_time {
    fire_wake();
    marker = format!("{}-{}", date, current_hm);
}
```

**Use case**: Specific times each day (e.g., "09:00", "12:00", "18:00")

**Precision**: ±60 seconds (checked every minute)

**Deduplication**: Date-time marker prevents double-firing

### 3. AfterReset Mode

**Trigger condition**: Current time is after `nextResetTime + offset`

```rust
if next_reset_epoch_ms.is_some() {
    target = next_reset_epoch_ms + (wake_after_reset_minutes * 60_000);
    if now >= target && last_reset_marker != next_reset_epoch_ms {
        fire_wake();
        last_reset_marker = next_reset_epoch_ms;
    }
}
```

**Use case**: Wake shortly after quota resets (e.g., 1 minute after reset)

**Precision**: ±60 seconds (checked every minute)

**Deduplication**: Reset timestamp marker prevents double-firing

**Initialization**: Requires an observed `nextResetTime` in quota data to calculate the target.

## Wake confirmation and retry behavior

Wake is only confirmed when a successful quota read shows a valid `nextResetTime` state change.

1. A wake request is sent when schedule is due or when wake needs confirmation.
2. `wake_pending` is set and an immediate quota poll is triggered.
3. While `wake_pending` is true, the poller confirms warm-up by checking `nextResetTime` is present and newer than the snapshot recorded before the wake.
4. On confirmation success, `wake_pending` clears and wake-specific errors reset.
5. On confirmation failure (while `wake_pending`), wake errors increment in two cases:
   - `nextResetTime` is missing in quota response; or
   - `nextResetTime` is present but does not advance beyond the snapshot taken before wake.
6. If wake errors hit 10, wake is auto-disabled for that slot only.

- **Flow**
  - `wake send` -> `wake_pending = true` -> immediate quota poll
  - **Success path**: `nextResetTime` present and advanced -> clear `wake_pending` -> reset wake errors
  - **Failure path**: `nextResetTime` missing/unchanged -> increment wake errors -> keep `wake_pending`
  - While `wake_pending` and within the configured wake-retry window: quota retries every minute
  - After one window elapses: one forced wake retry, then return to normal schedule flow
  - If wake errors reach the configured maximum: `wake_auto_disabled = true` for that slot

During warm-up confirmation, the system uses a configurable quota retry window.
One-time forced wake retry is executed after the window without successful confirmation.
The slot remains in wake-retry mode for the configured window and fetches quota every minute.
Once confirmed or forced retry is handled, normal poll interval resumes.
This retry window is controlled by `wake_quota_retry_window_minutes` in global app settings.

### Warm-up pre-check

The scheduler uses quota state to avoid unnecessary wakes:

- If `nextResetTime` is missing or in the past, wake may be required.
- If quota poller call fails during this pre-check, wake is still attempted (fail-open) to avoid missing a keep-alive opportunity.

## Configuration Updates

### Live Configuration Reload

The scheduler supports **hot-reloading** configuration without restarting tasks:

```rust
pub async fn reload_if_running(&mut self, config: AppConfig, ...) {
    for (idx, slot_task) in self.slot_tasks.iter() {
        let _ = slot_task.config_tx.send(new_config);
    }
}
```

**How it works**:
1. User edits configuration in UI
2. `reload_if_running()` called with new config
3. New config broadcast via `watch::channel`
4. Both tasks receive config update on next loop iteration
5. Tasks immediately use new config without restart

### Watch Channels

Each slot has two watch channels:

```rust
struct SlotTaskControl {
    stop_tx: watch::Sender<bool>,           // Stop signal
    config_tx: watch::Sender<KeySlotConfig>, // Config updates
    wake_handle: JoinHandle<()>,            // Wake task handle
    poll_handle: JoinHandle<()>,            // Poll task handle
}
```

Tasks listen for changes:

```rust
tokio::select! {
    _ = stop_rx.changed() => break,
    _ = config_rx.changed() => apply_new_config(),
    _ = time::sleep(duration) => continue,
}
```

## Quota Polling

### Independent Timing

Quota polling runs on its own schedule (`poll_interval_minutes`), independent of wake scheduling:

```
Time:  0----5----10---15---20---25---30---35---40---45---50
Poll:  P---------P---------P---------P---------P---------P   (every 30 min)
Wake:  W-W-W-W-W-W-W-W-W-W-W-W-W-W-W-W-W-W-W-W-W-W-W-W-W-W   (every 1 min)
```

### Error Backoff

Consecutive quota errors trigger exponential backoff:

```
Error 1:  poll_interval * 2^1 = 60 min
Error 2:  poll_interval * 2^2 = 120 min
Error 3:  poll_interval * 2^3 = 240 min
Error 4+: poll_interval * 2^4, then capped by `quota_poll_backoff_cap_minutes`

When wake confirmation is pending, quota fetches are retried every minute independently of the backoff.
```

After the configured `max_consecutive_errors` threshold, slot is **auto-disabled**.

### Immediate Initialization

Quota poller sends an **initial wake request** immediately on startup:

```rust
// Send initial wake request
let cfg = config_rx.borrow().clone();
client.send_wake_request(&cfg).await?;
```

This ensures:
1. API key is validated immediately
2. `nextResetTime` is fetched quickly
3. Initial wake state is established when required

## API Priority

The scheduler prioritizes **TOKENS_LIMIT** over **TIME_LIMIT**:

```rust
// In api_client.rs
let selected = limits
    .iter()
    .find(|limit| limit.r#type == "TOKENS_LIMIT")
    .or_else(|| limits.first())
```

**Why**:
- **TOKENS_LIMIT** (`unit=3=hours, number=5`): Rolling 5-hour token quota - **used for warmup scheduling**
- **TIME_LIMIT** (`unit=5=months`): Monthly MCP tools usage stats only - **irrelevant for warmup**

**Warmup behavior:**
- If connection is **cold** (no recent LLM calls): `nextResetTime` is **absent** in TOKENS_LIMIT
- If connection is **warm** (recent LLM calls): `nextResetTime` is **present** with ~5-hour future timestamp
- `percentage` field shows current token usage (e.g., 7%)

**Example from actual API response:**
```json
{
  "limits": [
    {
      "type": "TIME_LIMIT",
      "unit": 5,              // 5 = months
      "number": 1,            // 1 month
      "usage": 1000,          // Monthly quota: 1000 calls
      "currentValue": 10,     // Used: 10 calls
      "remaining": 990,       // Remaining: 990 calls
      "nextResetTime": 1772259238997,  // Monthly reset (NOT used for warmup)
      "usageDetails": [
        {"modelCode": "search-prime", "usage": 0},
        {"modelCode": "web-reader", "usage": 0},
        {"modelCode": "zread", "usage": 10}
      ]
    },
    {
      "type": "TOKENS_LIMIT",
      "unit": 3,              // 3 = hours
      "number": 5,            // 5 hours (rolling window)
      "percentage": 7,        // Current usage: 7%
      "nextResetTime": 1771177008218  // ~5 hours away (USED for warmup!)
    }
  ]
}
```

**Key insight**: Only TOKENS_LIMIT's `nextResetTime` matters for warmup scheduling. TIME_LIMIT is purely for monthly usage statistics.

## Logs and Debugging

### JSONL schema

Important log fields:

- `action`: logical step (`scheduled-wake`, `background-quota-poll`, `quota-poller.wake-confirmed`, etc.)
- `phase`: `request`, `response`, `error`, `event`
- `flow_id`: shared identifier that links request and response/error lines for the same HTTP transaction
- `duration_ms`: request latency for request/response pairs
- `details`: structured event payload for internal scheduler moments

### Wake Scheduler Logs

```
INFO  slot 1 wake scheduler started
INFO  slot 1 wake condition met: interval mode (60 min elapsed)
INFO  slot 1 scheduled wake fired
INFO  slot 1 wake scheduler detected config change
```

### Quota Poller Logs

```
INFO  slot 1 quota poller started
INFO  slot 1 quota refreshed (next_reset: Some(1772259238997))
WARN  slot 1 poll failed (1/{max_consecutive_errors} consecutive): connection timeout
INFO  slot 1 backing off: next poll in 60 min
INFO  slot 1 recovered after 1 consecutive error(s)
```

### Common Issues

| Issue | Cause | Solution |
|-------|-------|----------|
| AfterReset never fires | TOKENS_LIMIT `nextResetTime` is missing | Wake is required to start/reset the timer |
| Wake fires twice | Deduplication marker not updated | Check marker update logic |
| Config changes ignored | `reload_if_running` not called | Call after config save |
| Slot auto-disabled | `max_consecutive_errors` consecutive errors | Fix API/network issues |

## Performance Characteristics

### Wake Scheduler
- **Loop interval**: 60 seconds
- **CPU usage**: Minimal (sleeps most of the time)
- **Memory**: ~100 bytes per slot for schedule state

### Quota Poller
- **Loop interval**: Configurable (default 30 minutes)
- **CPU usage**: Burst on poll, otherwise idle
- **Network**: 1 HTTP request per poll interval per slot

### Scalability
- **Max slots**: 4 (configurable via `MAX_SLOTS`)
- **Total tasks**: 2 × enabled_slots
- **Concurrent HTTP clients**: 1 per task (8 total max)

## Testing

### Unit Tests

Test each wake mode independently:

```rust
#[test]
fn test_interval_mode() {
    let mut schedule = SlotSchedule::default();
    schedule.last_interval_fire = Instant::now() - Duration::from_secs(3600);
    assert!(should_fire_wake(&interval_cfg(), &schedule).is_some());
}

#[test]
fn test_times_mode() {
    // Mock current time to match scheduled time
    // Verify wake fires and marker updates
}

#[test]
fn test_after_reset_mode() {
    let mut schedule = SlotSchedule::default();
    schedule.next_reset_epoch_ms = Some(past_timestamp);
    assert!(should_fire_wake(&after_reset_cfg(), &schedule).is_some());
}
```

### Integration Tests

1. **Config reload**: Verify tasks pick up new config without restart
2. **Deduplication**: Ensure each wake condition fires exactly once
3. **Error recovery**: Verify backoff and auto-disable work correctly
4. **Race conditions**: Test concurrent access to shared schedule state

## Future Enhancements

1. **Adaptive polling**: Reduce poll frequency when quota is stable
2. **Wake batching**: Combine multiple slot wakes into single request
3. **Health checks**: Monitor task health and auto-restart if stuck
4. **Metrics**: Export Prometheus metrics for monitoring
5. **Persisted state**: Save schedule markers across restarts

## References

- [API Reference](./API.md) - Quota API endpoints
- [Configuration](../README.md#configuration) - Slot configuration options
- [Tokio Watch Channel](https://docs.rs/tokio/latest/tokio/sync/watch/index.html) - Async broadcast primitive
