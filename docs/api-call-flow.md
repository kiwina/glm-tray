# API Call Flow Analysis

> Updated 2026-02-18. Traces every outbound HTTP request and proposes fixes.

## Core Concept

The app's main purpose is **wake**: sending a POST `/chat/completions` to start
the Z.ai quota timer when no timer is currently running (`nextResetTime` is
null on `TOKENS_LIMIT`).

---

## Data Requirements by Screen

| Screen | Data needed | Source | Update frequency |
|--------|-------------|--------|-----------------|
| **Dashboard** | 5h percentage, model calls, tokens | Quota poller (live) | Every poll cycle |
| **Stats tab** | 5h % + calls + tokens (from poller cache) | Cached from poller | Auto from poller |
| **Stats tab** | 24h model usage, tool usage | Manual refresh only | User clicks refresh |

**Key insight:** The 5h usage data (`/model-usage?5h`) should be fetched as part
of the quota polling cycle, not only on manual stats refresh. This feeds both
the dashboard and stats tab automatically.

---

## Architecture: Two Concurrent Tasks Per Slot

| Task | Purpose | Loop interval |
|------|---------|---------------|
| `wake_scheduler_task` | Decides WHEN to wake, fires POST wake, sends `poll_now` | 60s |
| `quota_poller_task` | Polls quota + 5h usage, confirms wake | `poll_interval_minutes` (default 1min) |

Communication: `wake_scheduler` → `poll_now` channel → `quota_poller`

---

## CURRENT Flow (What Happens Today)

### Startup (cold quota):
```
T+0  quota_poller INIT:
  1. GET /quota/limit     [wake-precheck]    ← checks if wake needed
  2. POST /chat/completions [scheduled-wake]  ← fires wake
  3. GET /quota/limit     [quota-poll]        ← confirms wake worked
                                               TOTAL: 3 requests
```

### Each poll cycle:
```
  1. GET /quota/limit     [quota-poll]        ← percentage + timer only
                                               TOTAL: 1 request
```

### Manual stats refresh (user clicks refresh on stats tab):
```
  1. GET /quota/limit           [manual-stats-request]     ← REDUNDANT (poller has this)
  2. GET /model-usage?24h       [manual-model-usage-24h]
  3. GET /model-usage?5h        [manual-model-usage-5h]    ← should come from poller
  4. GET /tool-usage?24h        [manual-tool-usage]
                                               TOTAL: 4 requests (2 wasted)
```

### Wake cycle (timer expired → re-wake):
```
  1. GET /quota/limit     [wake-precheck]    ← validate cache
  2. POST /chat/completions [scheduled-wake]
  3. GET /quota/limit     [quota-poll]        ← triggered by poll_now
                                               TOTAL: 3 requests
```

---

## PROPOSED Flow (Correct Architecture)

### Startup (cold quota):
```
T+0  quota_poller first iteration:
  1. GET /quota/limit     [quota-poll]        ← check state AND feed UI
     → if COLD: signal wake_scheduler to fire immediately
  2. POST /chat/completions [scheduled-wake]  ← wake_scheduler fires wake
  3. GET /quota/limit     [quota-poll]        ← triggered by poll_now, confirm wake
  4. GET /model-usage?5h  [quota-poll]        ← 5h usage for dashboard
                                               TOTAL: 4 requests (but 1 fewer GET than current)
```
OR (simpler, keep init wake):
```
T+0  quota_poller INIT:
  1. GET /quota/limit     [wake-precheck]     ← checks if wake needed
  2. POST /chat/completions [scheduled-wake]   ← fires wake
  3. GET /quota/limit     [quota-poll]         ← confirms wake
  4. GET /model-usage?5h  [quota-poll]         ← 5h usage for dashboard
                                               TOTAL: 4 requests
```

### Each poll cycle (this is the main change):
```
  1. GET /quota/limit     [quota-poll]        ← percentage + timer
  2. GET /model-usage?5h  [quota-poll]        ← 5h model calls + tokens
                                               TOTAL: 2 requests
     → Updates runtime with: percentage, timer, 5h calls, 5h tokens
     → Dashboard auto-displays from runtime cache
     → Stats tab auto-displays 5h section from runtime cache
     → Emits "quota-updated" with 5h data to frontend
```

### Manual stats refresh (user clicks refresh on stats tab):
```
  1. GET /model-usage?24h       [manual-model-usage-24h]
  2. GET /tool-usage?24h        [manual-tool-usage]
                                               TOTAL: 2 requests (down from 4)
     → Gets 24h data + tool usage (not part of polling)
     → Quota + 5h data: read from runtime cache (already fresh from poller)
     → Shows "Last updated: X seconds ago" from poller timestamp
```

### Wake cycle (unchanged):
```
  1. GET /quota/limit     [wake-precheck]
  2. POST /chat/completions [scheduled-wake]
  3. GET /quota/limit     [quota-poll]
  4. GET /model-usage?5h  [quota-poll]
                                               TOTAL: 4 requests
```

---

## Changes Required

### 1. Quota Poller: Add 5h model-usage fetch

After each successful `fetch_quota()`, also fetch model-usage for 5h window.
Store in `RuntimeSlotStatus`:

```rust
// New fields on RuntimeSlotStatus
pub total_model_calls_5h: Option<u64>,
pub total_tokens_5h: Option<u64>,
pub quota_last_updated: Option<String>,  // ISO timestamp for "last updated" display
```

### 2. Quota-updated event: Include 5h data

```rust
app.emit("quota-updated", json!({
    "slot": idx + 1,
    "percentage": snapshot.percentage,
    "timer_active": snapshot.timer_active,
    "next_reset_hms": snapshot.next_reset_hms,
    "next_reset_epoch_ms": snapshot.next_reset_epoch_ms,
    // NEW:
    "total_model_calls_5h": model_calls_5h,
    "total_tokens_5h": tokens_5h,
    "last_updated": chrono::Local::now().to_rfc3339(),
}));
```

### 3. Dashboard: Read 5h data from runtime

Currently dashboard only shows slot status. Add 5h usage display reading
from `latestRuntime.slots[i].total_model_calls_5h` etc.

### 4. Stats tab: Use cached 5h data

- **5h section:** Read from `latestRuntime` (updated by poller)
- **24h section:** Read from `cachedStats` (updated by manual refresh)
- **Tool usage:** Read from `cachedStats` (manual refresh only)
- Show "Last updated: Xs ago" for 5h data

### 5. Manual stats refresh: Only fetch 24h + tools

Remove requests 1 and 3 from `fetch_slot_stats()`:
- ~~GET /quota/limit~~ → read from runtime
- GET /model-usage?24h → keep
- ~~GET /model-usage?5h~~ → read from runtime
- GET /tool-usage?24h → keep

---

## Mock Server Issues To Fix

| Issue | Impact | Fix |
|-------|--------|-----|
| Random data per request | UI flickers, testing unreliable | Generate data once at wake, return consistently |
| 2-min expiry | Constant wake cycles, can't test steady state | Make configurable (default 10min) |
| Needs /model-usage mock for polling | Poller will now call this endpoint each cycle | Already exists, verify format |

---

## Summary: Request Count Comparison

| Scenario | Current | Proposed |
|----------|---------|----------|
| Cold startup | 3 | 4 (adds 5h fetch) |
| Each poll cycle | 1 | 2 (adds 5h fetch) |
| Manual stats refresh | 4 | 2 (removes redundant quota + 5h) |
| Wake re-fire | 3 | 4 (adds 5h fetch) |
| Dashboard view | 0 (shows stale data) | 0 (shows fresh data from poller) |

Net effect: +1 request per poll cycle, but dashboard shows live data and
manual refresh is halved.
