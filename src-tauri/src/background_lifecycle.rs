#![cfg(not(mobile))]

use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{Manager, WindowEvent};

const PROBE_ENV: &str = "COLLAB_BACKGROUND_PROBE";
const TRAY_OPEN_ID: &str = "background-probe-open";
const TRAY_QUIT_ID: &str = "background-probe-quit";

fn probe_enabled_value(value: Option<&std::ffi::OsStr>) -> bool {
    value
        .and_then(|value| value.to_str())
        .is_some_and(|value| matches!(value, "1" | "true" | "TRUE" | "yes" | "YES"))
}

fn show_main_window(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

pub fn setup_background_lifecycle_probe(app: &mut tauri::App) -> tauri::Result<()> {
    if !probe_enabled_value(std::env::var_os(PROBE_ENV).as_deref()) {
        return Ok(());
    }

    let open = MenuItem::with_id(app, TRAY_OPEN_ID, "Open Collab", true, None::<&str>)?;
    let separator = PredefinedMenuItem::separator(app)?;
    let quit = MenuItem::with_id(app, TRAY_QUIT_ID, "Quit", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&open, &separator, &quit])?;

    let mut tray = TrayIconBuilder::with_id("collab-background-probe")
        .menu(&menu)
        .tooltip("Collab background lifecycle probe")
        .on_menu_event(|app, event| match event.id().as_ref() {
            TRAY_OPEN_ID => show_main_window(app),
            TRAY_QUIT_ID => app.exit(0),
            _ => {}
        });
    if let Some(icon) = app.default_window_icon() {
        tray = tray.icon(icon.clone());
    }
    tray.build(app)?;

    // A tray can keep the event loop alive after the last window closes.
    // Phase 0 deliberately preserves the current close-means-quit behavior.
    if let Some(window) = app.get_webview_window("main") {
        let app_handle = app.handle().clone();
        window.on_window_event(move |event| {
            if matches!(event, WindowEvent::CloseRequested { .. }) {
                app_handle.exit(0);
            }
        });
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::probe_enabled_value;
    use std::ffi::OsStr;

    #[test]
    fn background_probe_requires_an_explicit_opt_in() {
        assert!(!probe_enabled_value(None));
        assert!(!probe_enabled_value(Some(OsStr::new("0"))));
        assert!(probe_enabled_value(Some(OsStr::new("1"))));
        assert!(probe_enabled_value(Some(OsStr::new("true"))));
    }
}
