# GLM Tray

A simple system tray app to monitor your Z.ai/BigModel API usage and keep your keys active.

![Tauri](https://img.shields.io/badge/Tauri-v2-blue)
![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-lightgrey)

## What does it do?

GLM Tray helps you:

- **Monitor your API quota** — See how many tokens and requests you've used
- **Keep keys active** — Automatically send requests to prevent keys from becoming stale
- **Track multiple keys** — Manage up to 4 API keys in one place
- **Stay informed** — Get visual indicators in your system tray
- **Tune global defaults** — Set shared API endpoints and logging retention in one app-level settings view

## Screenshots

<img src="docs/images/screenshot.jpg" width="50%" alt="Stats View">

## Installation

### Download

Grab the latest release for your platform from the [Releases page](https://github.com/kiwina/glm-tray/releases/latest):

| Platform | Download |
|----------|----------|
| Windows | `glm-tray_X.X.X_x64-setup.exe` |
| macOS (Apple Silicon) | `glm-tray_X.X.X_aarch64.dmg` |
| macOS (Intel) | `glm-tray_X.X.X_x64.dmg` |
| Linux | `glm-tray_X.X.X_amd64.AppImage` |

### Install

**Windows**
1. Download and run the `.exe` installer
2. Follow the installation wizard

**macOS**
1. Download the `.dmg` file
2. Open it and drag GLM Tray to Applications
3. On first launch, right-click → Open (or allow in System Preferences → Privacy & Security)

**Linux**
1. Download the `.AppImage` file
2. Make it executable: `chmod +x glm-tray_*.AppImage`
3. Run it: `./glm-tray_*.AppImage`

## Quick Start

1. **Launch the app** — It will appear in your system tray
2. **Click the tray icon** — Opens the main window
3. **Add your API key** — Enter your Z.ai or BigModel API key in Slot 1
4. **Enable polling** — Toggle on "Enable polling" to start monitoring
5. **Check your usage** — Stats will appear in the main window

## Features

### Quota Monitoring

View your API usage including:
- Token limits and consumption
- Request counts
- Model-specific usage (24-hour window)
- Tool usage statistics

### Keep-Alive Scheduling

Prevent your API keys from going stale with three scheduling modes:

| Mode | Description |
|------|-------------|
| **Interval** | Send a request every X minutes |
| **Specific Times** | Send requests at specific times (e.g., 09:00, 12:00, 18:00) |
| **After Reset** | Send a request X minutes after quota resets |

You can enable multiple modes simultaneously.

#### Wake confirmation and retry

Open the home page (not a key tab) and click the gear icon in the header to update app-wide defaults.

Wake requests are not immediately considered successful until quota confirms that warmup restarted.

- The app sends wake requests based on your selected schedule mode(s).
- After a wake send, it marks the slot `wake_pending` and triggers an immediate quota poll.
- If quota shows a valid TOKENS `nextResetTime` advance, wake is confirmed and `wake_pending` is cleared.
- If quota confirms with missing/unchanged `nextResetTime`, wake confirmation failure is counted in `wake_consecutive_errors`.
- While pending, quota is retried every minute for up to the configured window (`wake_quota_retry_window_minutes`).
- After that window, the app performs one forced wake retry.
- If wake still cannot be confirmed and wake errors reach the configured `max_consecutive_errors`, the slot is temporarily auto-disabled for wake.

Global app settings now include:
- **Default quota URL** (`global_quota_url`) and **default LLM URL** (`global_request_url`)
- **Log directory** (`log_directory`) to redirect JSONL output
- **Log retention days** (`max_log_days`)

### JSONL Logging (Optional)

Enable logging to debug API issues:
- Logs are stored in daily files
- Includes full request/response data
- Adds `flow_id` to tie request and response log lines together
- Adds `phase` (`request`, `response`, `error`, `event`) for easier filtering
- Located in your app data folder by default; when `log_directory` is set, logs are written to `<log_directory>/logs`.
- Scheduler events now include important moments like wake pending set/cleared, retry windows, and task start/stop decisions

---

## For Developers

### Building from Source

#### Prerequisites

- [Rust](https://rustup.rs/) (1.70+)
- [Node.js](https://nodejs.org/) (18+)
- Platform-specific dependencies (see below)

#### Linux Dependencies

```bash
sudo apt-get install -y \
  libwebkit2gtk-4.1-dev \
  build-essential \
  curl \
  wget \
  file \
  libssl-dev \
  libgtk-3-dev \
  libayatana-appindicator3-dev \
  librsvg2-dev \
  patchelf \
  pkg-config \
  libsoup-3.0-dev \
  javascriptcoregtk-4.1 \
  libjavascriptcoregtk-4.1-dev
```

#### macOS

```bash
xcode-select --install
```

#### Windows

- Visual Studio Build Tools (Desktop development with C++)
- WebView2 Runtime (usually pre-installed)

### Development

```bash
# Clone the repository
git clone https://github.com/kiwina/glm-tray.git
cd glm-tray

# Install dependencies
npm install

# Run in development mode
npm run tauri dev
```

### Production Build

```bash
npm run tauri build
```

The built installers will be in `src-tauri/target/release/bundle/`.

### Debug Mode

For testing wake functionality without hitting production APIs:

1. Start the mock server: `node mock-server.cjs`
2. Enable debug mode in Global Settings → Developer section
3. All API calls will be routed to the mock server

See [docs/DEBUGGING.md](docs/DEBUGGING.md) for full documentation.

### Project Structure

```
src/
  main.ts          # Frontend logic (vanilla TS)
  styles.css       # DaisyUI + Tailwind CSS 4

src-tauri/
  src/
    lib.rs         # Tauri setup, commands, state
    config.rs      # Config load/save with migration
    api_client.rs  # HTTP client for API calls
    scheduler.rs   # Background polling scheduler
    tray.rs        # System tray management
    models.rs      # Data structures
    update_checker.rs # Auto-update checker
    file_logger.rs # JSONL logging module
```

### API Endpoints

| Purpose | URL |
|---------|-----|
| Quota Limits | `https://api.z.ai/api/monitor/usage/quota/limit` |
| Model Usage | `https://api.z.ai/api/monitor/usage/model-usage` |
| Tool Usage | `https://api.z.ai/api/monitor/usage/tool-usage` |
| Chat Completions | `https://api.z.ai/api/coding/paas/v4/chat/completions` |

For BigModel, replace `api.z.ai` with `open.bigmodel.cn`.

### Configuration

Config is stored in the platform's application data directory:

| Platform | Path |
|----------|------|
| Windows | `%APPDATA%\glm-tray\settings.json` |
| macOS | `~/Library/Application Support/glm-tray/settings.json` |
| Linux | `~/.config/glm-tray/settings.json` |

The `settings.json` file now also persists:
- `global_quota_url`
- `global_request_url`
- `log_directory` (optional)
- `max_log_days`

### Logs

When logging is enabled, requests and responses are written to daily JSONL files:

```
{app_data_dir}/logs/2024-01-15.jsonl
```

Custom directory example:

```
{log_directory}/logs/2024-01-15.jsonl
```

---

## License

MIT

## Disclaimer

**This software is not affiliated with, endorsed by, or sponsored by Z.ai, BigModel, or any of their subsidiaries.**

"Z.ai" and "BigModel" are trademarks of their respective owners. This is an independent, community-developed tool for personal API key management. Use at your own risk.

The software is provided "as is", without warranty of any kind, express or implied. The authors are not liable for any damages arising from the use of this software.
