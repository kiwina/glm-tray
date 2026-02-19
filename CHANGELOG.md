# Changelog

All notable changes to GLM Tray are documented here.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).
Versions follow [Semantic Versioning](https://semver.org/).

---

## [0.0.4] — 2026-02-19

### Added

- **Vue 3 frontend rewrite** — Full port to Vue 3 + Pinia + DaisyUI replacing the original vanilla TS UI
- **Auto-updater** — In-app update notifications powered by `@tauri-apps/plugin-updater`, with GitHub Releases as the update endpoint
- **Autostart** — App can be configured to launch on system login via `@tauri-apps/plugin-autostart`
- **Revamped sidebar** — New icons, improved button states, and Tauri-specific link handling
- **5-hour model usage tracking** — Per-model usage metrics displayed in the dashboard stats panel
- **Debug mode & mock server** — Developer toggle in Global Settings routes all API calls to a local mock server (`docs/mock-server.cjs`) for safe testing
- **Simulated monitoring interval** — Dashboard stats display enhanced with simulated monitoring state
- **Global settings enhancements** — Extended with `global_quota_url`, `global_request_url`, `log_directory`, and `max_log_days`
- **UI action logging** — Key actions are logged with `phase` and `flow_id` for traceability
- **Quota tracking improvements** — Immediate quota refresh after warmup, refined scheduler reset logic, and cached stats cleared on monitoring stop
- **Window resize support** — Window is now resizable with adjusted default dimensions

### Fixed

- Update icon background colour not refreshing correctly
- Auto-update notifications firing on manual checks (now suppressed)
- Updater endpoint incorrectly pointing to localhost after development testing

### Changed

- Refactored scheduler sleep timing and quota poll caller context for more accurate request attribution
- Build profile optimisations in `Cargo.toml`
- Mock server responses updated to reflect real API shape

---

## [0.0.3] — 2026-02-17

### Added

- **Schedule mode** — Replaced the previous `wake_mode` concept with a unified `schedule_mode`, giving users three keep-alive strategies: Interval, Specific Times, and After Reset
- **`SlotSchedule` struct** — New Rust data structure backing structured per-slot scheduling with full wake-mode documentation
- **Log file cleanup** — Automatic deletion of JSONL log files older than the configured `max_log_days` retention window
- **Warmup / keep-alive UI** — Warmup functionality exposed in the per-key detail view with toggle and status indicators
- **Global state management** — Centralised Pinia stores for dashboard, key details, and settings
- **Wake confirmation & retry** — Wake requests are verified via quota delta (`nextResetTime` advance); failed confirmations trigger per-minute retries up to the configured window, followed by a forced retry and eventual auto-disable on repeated failures
- **Config versioning** — `config_version` field added to `AppConfig` with automatic migration path on upgrade

### Fixed

- Incorrect artifact upload paths in release CI workflow
- macOS universal build target (`universal-apple-darwin`) removed — not a valid Rust cross-compile target
- Rust targets now explicitly installed for macOS `aarch64` and `x86_64` in CI

### Changed

- Refactored codebase for improved readability and module separation
- Perl used for cross-platform version sync in release workflow (replacing shell `sed`)

---

## [0.0.2] — 2026-02-15

### Added

- **Dual platform support** — Full support for both `api.z.ai` and `open.bigmodel.cn` API endpoints
- **DaisyUI theming** — UI components updated to use DaisyUI with improved dark-mode theme handling
- **Configuration migration** — Automatic migration and validation of `AppConfig` on version mismatch
- **Usage query script** — `docs/sample.mjs` helper for querying quota, model usage, and tool usage directly from the terminal

### Fixed

- macOS App Sandbox entitlements added to satisfy notarisation requirements
- Numeric version string enforced for MSI build compatibility
- Bundle `category` and `description` fields removed to avoid macOS bundling errors
- CI switched from Bun to npm to match known-good build environment
- Tauri build config aligned with reference project

### Changed

- Release CI workflow refined: ARM macOS temporarily dropped to unblock releases; Windows and Linux confirmed working

---

## [0.0.1] — 2026-02-15

### Added

- **Core quota monitoring** — Initial implementation of quota polling for Z.ai / BigModel API keys (up to 4 slots)
- **System tray integration** — App lives in the system tray with status icon reflecting current quota state
- **Dark UI** — Dark-themed interface from day one
- **Exponential backoff** — Automatic retry with backoff on API errors
- **Auto-start on login** — Initial autostart support
- **Release CI** — GitHub Actions workflow for multi-platform builds (Windows, Linux, macOS)
- **JSONL logging** — Optional structured request/response logging to daily files

---

[0.0.4]: https://github.com/kiwina/glm-tray/releases/tag/v0.0.4
[0.0.3]: https://github.com/kiwina/glm-tray/compare/v0.0.2...v0.0.3
[0.0.2]: https://github.com/kiwina/glm-tray/compare/v0.0.1...v0.0.2
[0.0.1]: https://github.com/kiwina/glm-tray/releases/tag/v0.0.1
