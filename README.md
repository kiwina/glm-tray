# GLM Tray

A cross-platform system tray utility for monitoring Z.ai/BigModel API key quota usage and keeping keys warm.

![Tauri](https://img.shields.io/badge/Tauri-v2-blue)
![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-lightgrey)

## Features

- **Quota Monitoring** — Track token and request limits for up to 4 API keys
- **Keep-Alive Warmup** — Prevent keys from going stale with scheduled wake requests
- **Flexible Scheduling** — Wake by interval, at specific times, or after quota reset
- **System Tray** — Minimal UI, lives in your tray with status indicators
- **Detailed Stats** — View usage limits, model calls, and token consumption (24h window)
- **JSONL Logging** — Optional request/response logging for debugging

## Screenshots

<img src="docs/images/screenshot.jpg" width="50%" alt="Stats View">

## Building

### Prerequisites

- [Rust](https://rustup.rs/) (1.70+)
- [Node.js](https://nodejs.org/) (18+) or [Bun](https://bun.sh/)
- Platform-specific dependencies (see below)

### Linux

```bash
sudo apt-get install -y \
  libwebkit2gtk-4.1-dev \
  libappindicator3-dev \
  librsvg2-dev \
  patchelf
```

### macOS

```bash
xcode-select --install
```

### Windows

- Visual Studio Build Tools (Desktop development with C++)
- WebView2 Runtime (usually pre-installed)

### Development

```bash
# Install dependencies
bun install   # or npm ci

# Run in development mode
bun run tauri dev
```

### Production Build

```bash
# Build for current platform
bun run tauri build

# Cross-compile for Windows (from Linux)
bun run tauri build --runner cargo-xwin --target x86_64-pc-windows-msvc
```

The built installer will be in `src-tauri/target/release/bundle/`.

## Configuration

Configuration is stored in the platform's application data directory:

| Platform | Path |
|----------|------|
| Windows | `%APPDATA%\glm-tray\config.json` |
| macOS | `~/Library/Application Support/glm-tray/config.json` |
| Linux | `~/.config/glm-tray/config.json` |

### Per-Slot Settings

- **Name** — Display label for the key
- **API Key** — Your Z.ai or BigModel API key
- **Quota URL** — Endpoint for quota monitoring
- **Request URL** — Endpoint for warmup requests
- **Wake Mode** — `Interval`, `Times`, or `AfterReset`
- **Logging** — Enable JSONL request/response logging

## Architecture

```
src/
  main.ts          # Frontend logic (vanilla TS)
  styles.css       # DaisyUI + Tailwind CSS 4

src-tauri/
  src/
    lib.rs         # Tauri setup, commands, state
    config.rs      # Config load/save with migration
    api_client.rs  # HTTP client for all API calls
    scheduler.rs   # Background polling scheduler
    tray.rs        # System tray management
    models.rs      # Data structures
    file_logger.rs # JSONL logging module
```

## API Endpoints

| Purpose | URL |
|---------|-----|
| Quota Limits | `https://api.z.ai/api/monitor/usage/quota/limit` |
| Model Usage | `https://api.z.ai/api/monitor/usage/model-usage` |
| Tool Usage | `https://api.z.ai/api/monitor/usage/tool-usage` |
| Chat Completions | `https://api.z.ai/api/coding/paas/v4/chat/completions` |

For BigModel, replace `api.z.ai` with `open.bigmodel.cn`.

## Logs

When logging is enabled, requests and responses are written to daily JSONL files:

```
{app_data_dir}/logs/2024-01-15.jsonl
```

Each entry includes:
- Timestamp, slot number, action type
- Request method, URL, body
- Response status, body, error (if any)

## License

MIT

---

## Disclaimer

**This software is not affiliated with, endorsed by, or sponsored by Z.ai, BigModel, or any of their subsidiaries.**

"Z.ai" and "BigModel" are trademarks of their respective owners. This is an independent, community-developed tool for personal API key management. Use at your own risk.

The software is provided "as is", without warranty of any kind, express or implied. The authors are not liable for any damages arising from the use of this software.
