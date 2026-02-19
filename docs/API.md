# API Reference

All endpoints use the same authentication headers:

```
Authorization: Bearer <api_key>
Accept-Language: en-US
Content-Type: application/json
```

## Base URLs

| Platform | Base Domain |
|----------|-------------|
| Z.ai | `https://api.z.ai` |
| BigModel | `https://open.bigmodel.cn` |

All paths below are appended to the base domain.

---

## Endpoints

### GET `/api/monitor/usage/quota/limit`

Returns the current quota state for the authenticated key. This is the primary endpoint used by the scheduler to determine if a keep-alive wake is needed.

**No query parameters.**

**Response**

```json
{
  "code": 200,
  "msg": "Operation successful",
  "success": true,
  "data": {
    "level": "pro",
    "limits": [
      {
        "type": "TOKENS_LIMIT",
        "unit": 3,
        "number": 5,
        "percentage": 7,
        "nextResetTime": 1771177008218
      },
      {
        "type": "TIME_LIMIT",
        "unit": 5,
        "number": 1,
        "usage": 1000,
        "currentValue": 10,
        "remaining": 990,
        "percentage": 1,
        "nextResetTime": 1772259238997,
        "usageDetails": [
          { "modelCode": "search-prime", "usage": 0 },
          { "modelCode": "web-reader",   "usage": 0 },
          { "modelCode": "zread",        "usage": 10 }
        ]
      }
    ]
  }
}
```

**Fields**

| Field | Type | Description |
|-------|------|-------------|
| `data.level` | `string` | Account tier (`"pro"`, etc.) |
| `data.limits[].type` | `string` | `"TOKENS_LIMIT"` or `"TIME_LIMIT"` |
| `data.limits[].unit` | `number` | Time unit enum — `3` = hours, `5` = months |
| `data.limits[].number` | `number` | Number of units per reset window |
| `data.limits[].percentage` | `number` | 0–100 current usage percentage |
| `data.limits[].nextResetTime` | `number` | Epoch ms when this quota next resets |
| `data.limits[].usage` | `number` | Total quota (TIME_LIMIT only) |
| `data.limits[].currentValue` | `number` | Current usage count (TIME_LIMIT only) |
| `data.limits[].remaining` | `number` | Remaining quota (TIME_LIMIT only) |
| `data.limits[].usageDetails[]` | `array` | Per-tool call breakdown (TIME_LIMIT only) |

> **Warm vs Cold detection:** The app uses `TOKENS_LIMIT.nextResetTime` to determine key state. If it is **absent**, the key is cold (no active session) and a wake request is needed. If **present**, the key is warm with an active 5-hour rolling window.

---

### GET `/api/monitor/usage/model-usage`

Returns model-level call counts and token usage for a given time window.

**Query Parameters**

| Parameter | Format | Example |
|-----------|--------|---------|
| `startTime` | `yyyy-MM-dd HH:mm:ss` | `2026-02-14 04:00:00` |
| `endTime` | `yyyy-MM-dd HH:mm:ss` | `2026-02-15 04:59:59` |

**Response**

```json
{
  "code": 200,
  "success": true,
  "data": {
    "x_time": ["2026-02-14 04:00", "2026-02-14 05:00", "..."],
    "modelCallCount": [null, 81, 109, null, 20],
    "tokensUsage":    [null, 10502503, 12082568, null, 380786],
    "totalUsage": {
      "totalModelCallCount": 1072,
      "totalTokensUsage": 84739459
    }
  }
}
```

**Fields**

| Field | Type | Description |
|-------|------|-------------|
| `data.x_time[]` | `string[]` | Hourly time labels (`"yyyy-MM-dd HH:mm"`) |
| `data.modelCallCount[]` | `(number\|null)[]` | Model API calls per hour; `null` = no activity |
| `data.tokensUsage[]` | `(number\|null)[]` | Token count per hour; `null` = no activity |
| `data.totalUsage.totalModelCallCount` | `number` | Total calls across the window |
| `data.totalUsage.totalTokensUsage` | `number` | Total tokens across the window |

> Arrays are index-aligned: `x_time[i]`, `modelCallCount[i]`, and `tokensUsage[i]` correspond to the same hour.

---

### GET `/api/monitor/usage/tool-usage`

Returns MCP tool call counts for a given time window. Same query parameters as model-usage.

**Response**

```json
{
  "code": 200,
  "success": true,
  "data": {
    "x_time": ["2026-02-14 04:00", "..."],
    "networkSearchCount": [null, 0],
    "webReadMcpCount":   [null, 0],
    "zreadMcpCount":     [null, 3],
    "totalUsage": {
      "totalNetworkSearchCount": 0,
      "totalWebReadMcpCount": 0,
      "totalZreadMcpCount": 3,
      "totalSearchMcpCount": 0,
      "toolDetails": []
    }
  }
}
```

**Fields**

| Field | Type | Description |
|-------|------|-------------|
| `data.networkSearchCount[]` | `(number\|null)[]` | Network search calls per hour |
| `data.webReadMcpCount[]` | `(number\|null)[]` | Web reader MCP calls per hour |
| `data.zreadMcpCount[]` | `(number\|null)[]` | Zread MCP calls per hour |
| `data.totalUsage.*` | `number` | Totals for each tool type |

---

### POST `/api/coding/paas/v4/chat/completions`

Sends a minimal chat completion to activate the 5-hour rolling quota window. This is the **wake request**.

**Request body**

```json
{
  "model": "glm-4-flash",
  "messages": [{ "role": "user", "content": "hi" }],
  "max_tokens": 1
}
```

A `200` response with any valid completion body confirms the quota timer has started.

---

## Response Envelope

All responses share the same wrapper:

```json
{
  "code": 200,
  "msg": "Operation successful",
  "success": true,
  "data": { }
}
```

On error, `code` is non-200 and `msg` contains a descriptive message. `success` will be `false`.
