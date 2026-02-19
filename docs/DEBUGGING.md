# Debugging Guide

How to test GLM Tray without hitting production API endpoints.

---

## Quick Start

**1. Start the mock server**

```bash
node docs/mock-server.cjs
```

The server starts on port `3456` by default and prints a confirmation:

```
Mock server running on http://localhost:3456
```

**2. Enable debug mode in the app**

- Open the app → click the **gear icon** (Global Settings)
- Scroll to the **Developer** section
- Toggle **"Debug mode (use mock server)"**
- The URL field defaults to `http://localhost:3456` — change it if you used a custom port

**3. Use any API key**

In debug mode the mock server accepts any value as an API key. Add `test-key` to Slot 1 and enable the slot to begin.

---

## Mock Server

`docs/mock-server.cjs` simulates the Z.ai / BigModel API locally.

### Options

```bash
# Defaults: port 3456, quota expires after 2 minutes
node docs/mock-server.cjs

# Custom port
node docs/mock-server.cjs --port=8080

# Custom expiry (minutes)
node docs/mock-server.cjs --expiry=5

# Combined
node docs/mock-server.cjs --port=8080 --expiry=1
```

| Option | Env var | Default |
|--------|---------|---------|
| `--port` | `MOCK_PORT` | `3456` |
| `--expiry` | `MOCK_EXPIRY` | `2` (minutes) |

### Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/monitor/usage/quota/limit` | GET | Returns current quota state |
| `/api/monitor/usage/model-usage` | GET | Returns mock model usage data |
| `/api/monitor/usage/tool-usage` | GET | Returns mock tool usage data |
| `/api/coding/paas/v4/chat/completions` | POST | Wake request — starts the quota timer |
| `/health` | GET | Server status and current quota state |

### Quota States

The mock server cycles between two states:

**COLD** — initial state and after timer expires
- `TOKENS_LIMIT` has no `nextResetTime`
- App detects this and sends a wake request

**WARM** — after a POST to `/chat/completions`
- `TOKENS_LIMIT` has a `nextResetTime` set to `now + expiry`
- Timer counts down until it expires, then returns to COLD

### Health Check

```bash
curl http://localhost:3456/health
```

```json
{
  "status": "ok",
  "quota": {
    "state": "cold",
    "percentage": 23,
    "remainingSeconds": 0,
    "remainingHMS": null,
    "expiresAt": null
  },
  "config": { "expiryMinutes": 2 }
}
```

---

## What Debug Mode Does

When debug mode is active:

1. **URL rewriting** — every API request is redirected:
   - `https://api.z.ai/...` → `http://localhost:3456/...`
   - `https://open.bigmodel.cn/...` → `http://localhost:3456/...`
2. **TLS disabled** — certificate validation is skipped for localhost
3. **Banner shown** — Global Settings displays a warning banner while debug mode is on

---

## Testing Scenarios

### Manual wake test

```bash
node docs/mock-server.cjs --expiry=1
```

1. Enable debug mode in the app
2. Add Slot 1 with key `test-key`, enable the slot
3. Click the **lightning bolt** (warmup) button
4. Watch the mock server console — you should see the POST wake request
5. Check quota shows `nextResetTime` present (state = WARM)
6. Wait ~1 minute and verify quota returns to COLD

### Scheduled wake test

1. Enable debug mode, configure Slot 1
2. In Key Settings, enable **"Schedule after reset"** with a 1-minute delay
3. Start monitoring
4. Observe the mock server console for:
   - Initial wake on startup
   - Regular quota polls
   - Automatic re-wake after the expiry timer triggers reset

---

## Troubleshooting

**Mock server not responding**

```bash
# Check it's running
curl http://localhost:3456/health

# Check for port conflicts
lsof -i :3456

# Use a different port
node docs/mock-server.cjs --port=3457
```

Then update the mock URL in Global Settings → Developer to match.

**App still hitting production**

- Confirm debug mode is toggled **on** in Global Settings → Developer
- Restart the app after changing debug settings
- Verify the mock URL starts with `http://` (not `https://`)

**Config file location**

| Platform | Path |
|----------|------|
| Windows | `%APPDATA%\glm-tray\settings.json` |
| macOS | `~/Library/Application Support/glm-tray/settings.json` |
| Linux | `~/.config/glm-tray/settings.json` |

The `debug` and `mock_url` fields are stored here:

```json
{
  "debug": true,
  "mock_url": "http://localhost:3456"
}
```
