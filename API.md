# GLM Tray — API Reference

All endpoints use the same authentication and headers:

```
Authorization: Bearer <api_key>
Accept-Language: en-US
Content-Type: application/json
```

## Base URLs

| Platform   | Base Domain                    |
|------------|--------------------------------|
| Z.ai       | `https://api.z.ai`            |
| BigModel   | `https://open.bigmodel.cn`    |

All API paths below are appended to the base domain.

---

## 1. Quota / Limits

```
GET /api/monitor/usage/quota/limit
```

No query parameters.

### Response

```json
{
  "code": 200,
  "msg": "Operation successful",
  "data": {
    "limits": [
      {
        "type": "TIME_LIMIT",
        "unit": 5,
        "number": 1,
        "usage": 1000,
        "currentValue": 8,
        "remaining": 992,
        "percentage": 1,
        "nextResetTime": 1772259238997,
        "usageDetails": [
          { "modelCode": "search-prime", "usage": 0 },
          { "modelCode": "web-reader", "usage": 0 },
          { "modelCode": "zread", "usage": 8 }
        ]
      },
      {
        "type": "TOKENS_LIMIT",
        "unit": 3,
        "number": 5,
        "percentage": 6,
        "nextResetTime": 1771116265149
      }
    ],
    "level": "pro"
  },
  "success": true
}
```

### Fields

| Field | Type | Description |
|-------|------|-------------|
| `data.level` | `string` | Account tier (`"pro"`, etc.) |
| `data.limits[]` | `array` | One entry per limit type |

#### Limit entry

| Field | Type | Description |
|-------|------|-------------|
| `type` | `string` | `"TOKENS_LIMIT"` or `"TIME_LIMIT"` |
| `unit` | `number` | Time unit enum (3 = hours, 5 = months) |
| `number` | `number` | How many units per reset window |
| `usage` | `number` | Total quota (only on `TIME_LIMIT`) |
| `currentValue` | `number` | Current usage count (only on `TIME_LIMIT`) |
| `remaining` | `number` | Remaining quota (only on `TIME_LIMIT`) |
| `percentage` | `number` | 0–100 usage percentage |
| `nextResetTime` | `number` | Epoch ms when quota resets |
| `usageDetails[]` | `array` | Per-tool breakdown (only on `TIME_LIMIT`) |

#### Usage detail entry

| Field | Type | Description |
|-------|------|-------------|
| `modelCode` | `string` | Tool identifier (`"search-prime"`, `"web-reader"`, `"zread"`) |
| `usage` | `number` | Call count for that tool |

---

## 2. Model Usage

```
GET /api/monitor/usage/model-usage?startTime={}&endTime={}
```

### Query Parameters

| Param | Format | Example |
|-------|--------|---------|
| `startTime` | `yyyy-MM-dd HH:mm:ss` | `2026-02-14 04:00:00` |
| `endTime` | `yyyy-MM-dd HH:mm:ss` | `2026-02-15 04:59:59` |

### Response

```json
{
  "code": 200,
  "msg": "Operation successful",
  "data": {
    "x_time": [
      "2026-02-14 04:00",
      "2026-02-14 05:00",
      "...",
      "2026-02-15 04:00"
    ],
    "modelCallCount": [null, null, null, null, null, null, null, 81, 109, 115, 20, 131, null, 74, 206, 44, 7, 49, 17, 90, 48, null, 1, 51, 29],
    "tokensUsage": [null, null, null, null, null, null, null, 10502503, 12082568, 5085033, 380786, 10467488, null, 6039952, 14987247, 3439945, 352654, 4234492, 1576678, 4661189, 4736085, null, 141835, 3927420, 2123584],
    "totalUsage": {
      "totalModelCallCount": 1072,
      "totalTokensUsage": 84739459
    }
  },
  "success": true
}
```

### Fields

| Field | Type | Description |
|-------|------|-------------|
| `data.x_time[]` | `string[]` | Hourly time labels (`"yyyy-MM-dd HH:mm"`) |
| `data.modelCallCount[]` | `(number\|null)[]` | Model API calls per hour (`null` = no activity) |
| `data.tokensUsage[]` | `(number\|null)[]` | Token count per hour (`null` = no activity) |
| `data.totalUsage.totalModelCallCount` | `number` | Sum of all model calls in window |
| `data.totalUsage.totalTokensUsage` | `number` | Sum of all tokens in window |

Arrays are aligned by index — `x_time[i]`, `modelCallCount[i]`, and `tokensUsage[i]` correspond to the same hour.

---

## 3. Tool Usage

```
GET /api/monitor/usage/tool-usage?startTime={}&endTime={}
```

Same query parameters as model-usage.

### Response

```json
{
  "code": 200,
  "msg": "Operation successful",
  "data": {
    "x_time": [
      "2026-02-14 04:00",
      "...",
      "2026-02-15 04:00"
    ],
    "networkSearchCount": [null, null, "..."],
    "webReadMcpCount": [null, null, "..."],
    "zreadMcpCount": [null, null, "..."],
    "totalUsage": {
      "totalNetworkSearchCount": 0,
      "totalWebReadMcpCount": 0,
      "totalZreadMcpCount": 0,
      "totalSearchMcpCount": 0,
      "toolDetails": []
    }
  },
  "success": true
}
```

### Fields

| Field | Type | Description |
|-------|------|-------------|
| `data.x_time[]` | `string[]` | Hourly time labels |
| `data.networkSearchCount[]` | `(number\|null)[]` | Network search calls per hour |
| `data.webReadMcpCount[]` | `(number\|null)[]` | Web reader MCP calls per hour |
| `data.zreadMcpCount[]` | `(number\|null)[]` | Zread MCP calls per hour |
| `data.totalUsage.totalNetworkSearchCount` | `number` | Total search calls |
| `data.totalUsage.totalWebReadMcpCount` | `number` | Total web reader calls |
| `data.totalUsage.totalZreadMcpCount` | `number` | Total zread calls |
| `data.totalUsage.totalSearchMcpCount` | `number` | Total search MCP calls |
| `data.totalUsage.toolDetails[]` | `array` | Additional tool detail breakdown (empty when no usage) |

---

## Shared Envelope

All responses share the same wrapper:

```json
{
  "code": 200,
  "msg": "Operation successful",
  "data": { ... },
  "success": true
}
```

Error responses return a non-200 `code` with a descriptive `msg`.
