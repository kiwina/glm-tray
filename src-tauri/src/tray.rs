use log::{debug, info};
use tauri::image::Image;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager, Wry};

use crate::models::RuntimeStatus;

pub const TRAY_ID: &str = "quota_tray";
const NORMAL_ICON_BYTES: &[u8] = include_bytes!("../icons/tray-normal.png");
const ALERT_ICON_BYTES: &[u8] = include_bytes!("../icons/tray-alert.png");

fn build_tray_menu(
    app: &AppHandle,
    has_ready_slot: bool,
    monitoring: bool,
) -> Result<Menu<Wry>, String> {
    let start_enabled = has_ready_slot && !monitoring;
    let stop_enabled = monitoring;
    let warmup_enabled = has_ready_slot;

    let open = MenuItem::with_id(app, "open_settings", "Open Settings", true, None::<&str>)
        .map_err(|err| format!("failed to create Open Settings menu item: {err}"))?;
    let start = MenuItem::with_id(app, "start_monitoring", "Start Monitoring", start_enabled, None::<&str>)
        .map_err(|err| format!("failed to create Start Monitoring menu item: {err}"))?;
    let stop = MenuItem::with_id(app, "stop_monitoring", "Stop Monitoring", stop_enabled, None::<&str>)
        .map_err(|err| format!("failed to create Stop Monitoring menu item: {err}"))?;
    let sep = PredefinedMenuItem::separator(app)
        .map_err(|err| format!("failed to create separator: {err}"))?;
    let warmup = MenuItem::with_id(app, "warmup_all", "Warmup All Keys", warmup_enabled, None::<&str>)
        .map_err(|err| format!("failed to create Warmup All menu item: {err}"))?;
    let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)
        .map_err(|err| format!("failed to create Quit menu item: {err}"))?;

    let menu = Menu::with_items(app, &[&open, &start, &stop, &sep, &warmup, &quit])
        .map_err(|err| format!("failed to create tray menu: {err}"))?;
    Ok(menu)
}

pub fn setup_tray(app: &AppHandle, has_ready_slot: bool) -> Result<(), String> {
    let menu = build_tray_menu(app, has_ready_slot, false)?;

    let default_icon = app
        .default_window_icon()
        .cloned()
        .ok_or_else(|| "default icon is missing".to_string())?;

    TrayIconBuilder::with_id(TRAY_ID)
        .icon(default_icon)
        .tooltip("Quota monitor idle")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| {
            let app_handle = app.clone();
            match event.id().as_ref() {
                "open_settings" => {
                    info!("tray menu: open settings");
                    let _ = show_or_focus_settings(&app_handle);
                }
                "start_monitoring" => {
                    info!("tray menu: start monitoring");
                    tauri::async_runtime::spawn(async move {
                        let _ = crate::start_monitoring_internal(app_handle).await;
                    });
                }
                "stop_monitoring" => {
                    info!("tray menu: stop monitoring");
                    tauri::async_runtime::spawn(async move {
                        let _ = crate::stop_monitoring_internal(app_handle).await;
                    });
                }
                "warmup_all" => {
                    info!("tray menu: warmup all keys");
                    tauri::async_runtime::spawn(async move {
                        let _ = crate::warmup_all_internal(app_handle).await;
                    });
                }
                "quit" => {
                    info!("tray menu: quit");
                    app_handle.exit(0);
                }
                _ => {}
            }
        })
        .on_tray_icon_event(|tray, event| {
            if matches!(
                event,
                TrayIconEvent::Click {
                    button: MouseButton::Left,
                    button_state: MouseButtonState::Up,
                    ..
                }
            ) {
                let _ = show_or_focus_settings(&tray.app_handle());
            }
        })
        .build(app)
        .map_err(|err| format!("failed to build tray icon: {err}"))?;

    info!("system tray initialized");
    Ok(())
}

pub fn show_or_focus_settings(app: &AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("main") {
        window
            .show()
            .map_err(|err| format!("failed to show settings window: {err}"))?;
        window
            .set_focus()
            .map_err(|err| format!("failed to focus settings window: {err}"))?;
        return Ok(());
    }

    Err("settings window not found".to_string())
}

pub fn refresh_tray(app: &AppHandle, runtime: RuntimeStatus, has_ready_slot: bool) -> Result<(), String> {
    let tray = app
        .tray_by_id(TRAY_ID)
        .ok_or_else(|| "tray icon not initialized".to_string())?;

        let menu = build_tray_menu(app, has_ready_slot, runtime.monitoring)?;
        tray
            .set_menu(Some(menu))
            .map_err(|err| format!("failed to set tray menu: {err}"))?;

    let enabled_slots: Vec<_> = runtime.slots.iter().filter(|s| s.enabled).collect();

    let mut lines = Vec::new();
    for slot in &enabled_slots {
        let label = if slot.name.is_empty() {
            format!("k{}", slot.slot)
        } else {
            slot.name.clone()
        };

        if slot.auto_disabled {
            lines.push(format!("{}: DISABLED (errors)", label));
            continue;
        }

        if slot.wake_auto_disabled {
            let wake_errors = slot.wake_consecutive_errors;
            lines.push(format!(
                "{}: WAKE PAUSED (wake errors x{})",
                label,
                wake_errors
            ));
            continue;
        }

        let time_text = slot
            .next_reset_hms
            .clone()
            .unwrap_or_else(|| if slot.timer_active { "--:--:--".to_string() } else { "idle".to_string() });

        let pct_text = slot
            .percentage
            .map(|p| format!("{p}%"))
            .unwrap_or_else(|| "n/a".to_string());

        if slot.consecutive_errors > 0 {
            lines.push(format!("{}: {} / {} (err x{})", label, time_text, pct_text, slot.consecutive_errors));
        } else {
            lines.push(format!("{}: {} / {}", label, time_text, pct_text));
        }
    }

    if lines.is_empty() {
        lines.push("Quota monitor idle".to_string());
    }

    let tooltip = lines.join("\n");
    debug!("tray tooltip: {}", tooltip.replace('\n', " | "));

    tray.set_tooltip(Some(&tooltip))
        .map_err(|err| format!("failed to set tray tooltip: {err}"))?;

    // Red icon when no keys are configured/enabled, or any slot auto-disabled
    let any_auto_disabled = enabled_slots.iter().any(|s| s.auto_disabled || s.wake_auto_disabled);
    let use_alert = (enabled_slots.is_empty() && !runtime.monitoring) || any_auto_disabled;
    let icon_bytes = if use_alert {
        ALERT_ICON_BYTES
    } else {
        NORMAL_ICON_BYTES
    };

    if use_alert {
        debug!("tray icon: alert ({})",
            if any_auto_disabled { "slot auto-disabled" } else { "no enabled keys" });
    }

    let icon = Image::from_bytes(icon_bytes)
        .map_err(|err| format!("failed to load tray icon: {err}"))?;

    tray.set_icon(Some(icon))
        .map_err(|err| format!("failed to set tray icon: {err}"))?;

    Ok(())
}
