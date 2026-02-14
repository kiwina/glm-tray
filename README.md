# GLM Tray Quota Monitor (Tauri v2)

Cross-platform system tray utility for monitoring API key quota usage (up to 5 independent key slots).

## Folder Structure

```text
index.html
src/
	main.ts
	styles.css
src-tauri/
	Cargo.toml
	tauri.conf.json
	src/
		main.rs
		lib.rs
		models.rs
		config.rs
		api_client.rs
		scheduler.rs
		tray.rs
.github/workflows/
	ci.yml
```

## Features

- Tray-first app behavior (hidden at launch)
- Dynamic tray tooltip per active key slot (`k1..k5`)
- Per-slot scheduler task (Tokio async, safe cancellation)
- Optional warmup request before polling loop
- Config persistence (JSON)
- Runtime status query from frontend
- Minimal HTML + TypeScript frontend (no heavy UI framework)

## Backend Architecture

- `main.rs`: native entrypoint
- `lib.rs`: Tauri setup, global state, command registration
- `tray.rs`: tray initialization, icon/tooltip refresh, menu + click behavior
- `scheduler.rs`: async polling manager and per-key loop lifecycle
- `config.rs`: load/save normalized JSON config (enforces max 5 slots)
- `api_client.rs`: HTTP request/warmup/quota parsing logic
- `models.rs`: strong data model for config/runtime/API responses

## API Parsing Behavior

For each quota response:

- Reads `data.limits`
- Uses `TOKENS_LIMIT` when present, otherwise first available limit
- Extracts `percentage`
- Converts `nextResetTime` (ms epoch) to local `HH:MM:SS`

## Command Surface

Frontend uses Tauri `invoke()` for:

- `load_settings`
- `save_settings`
- `start_monitoring`
- `stop_monitoring`
- `get_runtime_status`

## Environment Validation

### Linux

```bash
rustc --version
cargo --version
node --version
npm --version
npx tauri --version

sudo apt-get update
sudo apt-get install -y \
	libwebkit2gtk-4.1-dev \
	libappindicator3-dev \
	librsvg2-dev \
	patchelf
```

### macOS

```bash
rustc --version
cargo --version
node --version
npm --version
npx tauri --version

xcode-select -p
```

Install Xcode Command Line Tools when needed:

```bash
xcode-select --install
```

### Windows (PowerShell)

```powershell
rustc --version
cargo --version
node --version
npm --version
npx tauri --version
```

Required tools:

- Visual Studio Build Tools (Desktop development with C++)
- WebView2 Runtime

## Setup

```bash
npm ci
npm run tauri dev
```

## Build & Packaging

### Debug build

```bash
npm run tauri build -- --debug
```

### Optimized release build

```bash
npm run tauri build
```

Release profile optimizations are configured in `src-tauri/Cargo.toml`:

- `lto = true`
- `codegen-units = 1`
- `opt-level = "z"`
- `strip = true`

### Binary Size Reduction Tips

- Keep `reqwest` features minimal (`json`, `rustls-tls` only)
- Avoid UI/framework dependencies in frontend
- Prefer static/simple tray icon assets
- Remove unused plugins and capabilities

## CI

GitHub Actions workflow in `.github/workflows/ci.yml`:

- Builds on Ubuntu, Windows, and macOS
- Caches Rust and Node dependencies
- Uploads release binaries as artifacts

## Runtime Notes

- Closing settings window hides it (does not quit)
- Tray menu supports Open Settings / Start / Stop / Quit
- Monitoring restarts automatically after settings save when already running
- Scheduler prevents duplicate loops by stopping existing tasks before restart

## Extension Guide

Potential future additions:

- Per-slot custom headers
- TLS pinning or proxy support
- Retry/backoff policy per slot
- Detailed history chart in settings window
