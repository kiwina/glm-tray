# Debugging Guide

This document explains how to use debug mode and the mock server for development and testing.

## Quick Start

1. **Start the mock server:**
   ```bash
   node mock-server.cjs
   ```

2. **Enable debug mode in the app:**
   - Open Global Settings (gear icon)
   - Scroll to "Developer" section
   - Toggle "Debug mode (use mock server)"
   - Optionally set a custom mock server URL (default: `http://localhost:3456`)

3. **Test wake functionality:**
   - Add an API key (any value works with mock server)
   - Enable the key
   - Start monitoring
   - The app will route all API calls to the mock server

## Mock Server

The mock server (`mock-server.cjs`) simulates the Z.ai API for testing without hitting production endpoints.

### Starting the Server

```bash
# Default: port 3456, 2 minute quota expiry
node mock-server.cjs

# Custom port
node mock-server.cjs --port=8080

# Custom expiry time (in minutes)
node mock-server.cjs --expiry=5

# Combined
node mock-server.cjs --port=8080 --expiry=1
```

### Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `MOCK_PORT` | Server port | `3456` |
| `MOCK_EXPIRY` | Quota expiry in minutes | `2` |

### Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/monitor/usage/quota/limit` | GET | Returns quota info |
| `/api/coding/paas/v4/chat/completions` | POST | Wake request (activates quota timer) |
| `/health` | GET | Health check with current quota state |

### Quota States

The mock server simulates two quota states:

#### COLD State (Initial)
- `TOKENS_LIMIT` has NO `nextResetTime`
- App detects this and triggers a wake request
- Returns to COLD after timer expires

#### WARM State (After Wake)
- `TOKENS_LIMIT` HAS `nextResetTime`
- Timer counts down until expiry
- After expiry, returns to COLD state

### Health Check

```bash
curl http://localhost:3456/health
```

Response:
```json
{
  "status": "ok",
  "message": "Mock server running",
  "quota": {
    "state": "cold",
    "percentage": 23,
    "remainingSeconds": 0,
    "remainingHMS": null,
    "expiresAt": null
  },
  "config": {
    "expiryMinutes": 2
  }
}
```

## Debug Mode in App

### Enabling Debug Mode

1. Open the app
2. Click the gear icon (Global Settings)
3. Scroll to "Developer" section
4. Toggle "Debug mode (use mock server)"
5. Set mock server URL if different from default

### What Debug Mode Does

When debug mode is enabled:

1. **URL Rewriting**: All API URLs are rewritten to point to the mock server
   - `https://api.z.ai/api/monitor/usage/quota/limit` → `http://localhost:3456/api/monitor/usage/quota/limit`
   - `https://api.z.ai/api/coding/paas/v4/chat/completions` → `http://localhost:3456/api/coding/paas/v4/chat/completions`

2. **Certificate Validation**: Disabled for localhost testing

3. **Debug Banner**: Shows warning banner in Global Settings indicating debug mode is active

### Debug Mode Indicator

When debug mode is active, Global Settings shows:
```
⚠️ Debug mode - using mock server at http://localhost:3456
```

## Testing Wake Functionality

### Manual Wake Test

1. Start mock server with short expiry:
   ```bash
   node mock-server.cjs --expiry=1
   ```

2. Enable debug mode in app

3. Add a test key:
   - Go to Key 1 settings
   - Enter any API key (e.g., "test-key")
   - Enable the key

4. Click the warmup button (lightning icon)

5. Watch the mock server console for the wake request

6. Check the quota shows `nextResetTime` (timer active)

7. Wait for expiry and verify quota returns to COLD state

### Scheduled Wake Test

1. Enable debug mode and configure a key

2. Enable "Schedule after reset" with 1 minute delay

3. Start monitoring

4. Watch mock server console for:
   - Initial wake request
   - Quota polls
   - Scheduled wake after reset

## Troubleshooting

### Mock Server Not Responding

1. Check if server is running:
   ```bash
   curl http://localhost:3456/health
   ```

2. Check for port conflicts:
   ```bash
   lsof -i :3456
   ```

3. Try a different port:
   ```bash
   node mock-server.cjs --port=3457
   ```

### App Not Connecting to Mock Server

1. Verify debug mode is enabled in Global Settings

2. Check mock server URL matches the running server

3. Restart the app after changing debug settings

### Certificate Errors

Debug mode automatically accepts invalid certificates for localhost. If you see certificate errors:

1. Ensure debug mode is fully enabled (toggle off and on)

2. Check the mock server URL starts with `http://` (not `https://`)

## Configuration Files

Debug settings are stored in the app config:

```json
{
  "debug": true,
  "mock_url": "http://localhost:3456",
  ...
}
```

Config location:
- **Linux**: `~/.config/glm-tray/config.json`
- **macOS**: `~/Library/Application Support/glm-tray/config.json`
- **Windows**: `%APPDATA%\glm-tray\config.json`
