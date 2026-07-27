#![cfg(not(mobile))]

use crate::background::{
    BackgroundCloseBehavior, BackgroundJobTrigger, BackgroundSettings, BackgroundSyncInterval,
};
use crate::state::AppState;
use parking_lot::Mutex;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{Emitter, Manager, WindowEvent};
use tauri_plugin_autostart::ManagerExt;

const TRAY_ID: &str = "collab-background";
const TRAY_OPEN_ID: &str = "background-open";
const TRAY_SYNC_ID: &str = "background-sync";
const TRAY_PAUSE_ID: &str = "background-pause";
const TRAY_STATUS_ID: &str = "background-status";
const TRAY_QUIT_ID: &str = "background-quit";

pub struct DesktopBackgroundLifecycle {
    quitting: AtomicBool,
    pause_item: MenuItem<tauri::Wry>,
    status_item: MenuItem<tauri::Wry>,
    last_dispatch: Mutex<Option<Instant>>,
}

pub fn show_main_window(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
        let _ = app.emit("background:window-shown", ());
    }
}

pub fn set_autostart(app: &tauri::AppHandle, enabled: bool) -> Result<(), String> {
    let autostart = app.autolaunch();
    if enabled {
        autostart.enable()
    } else {
        autostart.disable()
    }
    .map_err(|error| format!("Could not update start-at-login: {error}"))
}

pub fn apply_settings(app: &tauri::AppHandle, settings: &BackgroundSettings) {
    if let Some(tray) = app.tray_by_id(TRAY_ID) {
        let _ = tray.set_visible(settings.run_in_background);
    }
    if let Some(lifecycle) = app.try_state::<DesktopBackgroundLifecycle>() {
        let _ = lifecycle.pause_item.set_text(if settings.paused {
            "Resume background sync"
        } else {
            "Pause background sync"
        });
    }
}

fn request_quit(app: &tauri::AppHandle) {
    if let Some(lifecycle) = app.try_state::<DesktopBackgroundLifecycle>() {
        if lifecycle.quitting.swap(true, Ordering::AcqRel) {
            return;
        }
    }
    let state = app.state::<AppState>();
    state.background.shutdown();
    state.live_ws.abort_all();
    let _ = app.emit("background:quitting", ());
    app.exit(0);
}

fn toggle_pause(app: &tauri::AppHandle) {
    let state = app.state::<AppState>();
    let Ok(mut settings) = state.background.settings() else {
        return;
    };
    settings.paused = !settings.paused;
    if let Ok(settings) = state.background.save_settings(settings) {
        apply_settings(app, &settings);
    }
}

fn sync_now(app: &tauri::AppHandle) {
    let coordinator = app.state::<AppState>().background.clone();
    tauri::async_runtime::spawn(async move {
        let _ = coordinator.enqueue_registered(BackgroundJobTrigger::UserInitiated);
    });
}

fn sync_interval(settings: &BackgroundSettings) -> Option<Duration> {
    if !settings.run_in_background || !settings.background_sync || settings.paused {
        return None;
    }
    match settings.sync_interval {
        BackgroundSyncInterval::SystemManaged | BackgroundSyncInterval::FifteenMinutes => {
            Some(Duration::from_secs(15 * 60))
        }
        BackgroundSyncInterval::ThirtyMinutes => Some(Duration::from_secs(30 * 60)),
        BackgroundSyncInterval::Hourly => Some(Duration::from_secs(60 * 60)),
        BackgroundSyncInterval::Manual => None,
    }
}

fn update_tray_status(app: &tauri::AppHandle) {
    let Some(lifecycle) = app.try_state::<DesktopBackgroundLifecycle>() else {
        return;
    };
    let state = app.state::<AppState>();
    let label = match (state.background.settings(), state.background.aggregate()) {
        (Ok(settings), _) if settings.paused => "Background sync paused".to_string(),
        (_, Ok(aggregate)) if aggregate.running > 0 || aggregate.queued > 0 => format!(
            "{} background job{} active",
            aggregate.running + aggregate.queued,
            if aggregate.running + aggregate.queued == 1 {
                ""
            } else {
                "s"
            }
        ),
        (_, Ok(aggregate)) if aggregate.attention_required > 0 => {
            format!("{} job(s) need attention", aggregate.attention_required)
        }
        (_, Ok(aggregate)) if aggregate.latest_finished_at.is_some() => {
            "Background sync idle".to_string()
        }
        _ => "No background jobs yet".to_string(),
    };
    let _ = lifecycle.status_item.set_text(label);
}

fn start_scheduler(app: tauri::AppHandle) {
    tauri::async_runtime::spawn(async move {
        loop {
            tokio::time::sleep(Duration::from_secs(2)).await;
            update_tray_status(&app);

            let state = app.state::<AppState>();
            let Ok(settings) = state.background.settings() else {
                continue;
            };
            let Some(interval) = sync_interval(&settings) else {
                continue;
            };
            let should_dispatch = app
                .state::<DesktopBackgroundLifecycle>()
                .last_dispatch
                .lock()
                .is_none_or(|last| last.elapsed() >= interval);
            if !should_dispatch {
                continue;
            }
            *app.state::<DesktopBackgroundLifecycle>()
                .last_dispatch
                .lock() = Some(Instant::now());
            let _ = state
                .background
                .clone()
                .enqueue_registered(BackgroundJobTrigger::Periodic);
        }
    });
}

pub fn setup_background_lifecycle(app: &mut tauri::App) -> tauri::Result<()> {
    let open = MenuItem::with_id(app, TRAY_OPEN_ID, "Open Collab", true, None::<&str>)?;
    let sync = MenuItem::with_id(app, TRAY_SYNC_ID, "Sync now", true, None::<&str>)?;
    let pause = MenuItem::with_id(
        app,
        TRAY_PAUSE_ID,
        "Pause background sync",
        true,
        None::<&str>,
    )?;
    let status = MenuItem::with_id(
        app,
        TRAY_STATUS_ID,
        "No background jobs yet",
        false,
        None::<&str>,
    )?;
    let separator = PredefinedMenuItem::separator(app)?;
    let quit = MenuItem::with_id(app, TRAY_QUIT_ID, "Quit Collab", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&open, &sync, &pause, &status, &separator, &quit])?;

    let mut tray = TrayIconBuilder::with_id(TRAY_ID)
        .menu(&menu)
        .tooltip("Collab")
        .on_menu_event(|app, event| match event.id().as_ref() {
            TRAY_OPEN_ID => show_main_window(app),
            TRAY_SYNC_ID => sync_now(app),
            TRAY_PAUSE_ID => toggle_pause(app),
            TRAY_QUIT_ID => request_quit(app),
            _ => {}
        });
    if let Some(icon) = app.default_window_icon() {
        tray = tray.icon(icon.clone());
    }
    tray.build(app)?;

    app.manage(DesktopBackgroundLifecycle {
        quitting: AtomicBool::new(false),
        pause_item: pause,
        status_item: status,
        last_dispatch: Mutex::new(None),
    });

    let settings = app
        .state::<AppState>()
        .background
        .settings()
        .unwrap_or_default();
    let _ = set_autostart(app.handle(), settings.start_at_login);
    apply_settings(app.handle(), &settings);

    if std::env::args().any(|argument| argument == "--background") && settings.run_in_background {
        if let Some(window) = app.get_webview_window("main") {
            let _ = window.hide();
        }
    }

    if let Some(window) = app.get_webview_window("main") {
        let app_handle = app.handle().clone();
        window.on_window_event(move |event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                let lifecycle = app_handle.state::<DesktopBackgroundLifecycle>();
                if lifecycle.quitting.load(Ordering::Acquire) {
                    return;
                }
                let settings = app_handle
                    .state::<AppState>()
                    .background
                    .settings()
                    .unwrap_or_default();
                if settings.run_in_background
                    && settings.close_behavior == BackgroundCloseBehavior::HideToTray
                {
                    api.prevent_close();
                    if let Some(window) = app_handle.get_webview_window("main") {
                        let _ = window.hide();
                    }
                    let _ = app_handle.emit("background:window-hidden", ());
                } else {
                    request_quit(&app_handle);
                }
            }
        });
    }

    start_scheduler(app.handle().clone());
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::sync_interval;
    use crate::background::{BackgroundSettings, BackgroundSyncInterval};
    use std::time::Duration;

    #[test]
    fn disabled_paused_and_manual_settings_do_not_schedule() {
        let mut settings = BackgroundSettings::default();
        assert!(sync_interval(&settings).is_none());
        settings.run_in_background = true;
        settings.sync_interval = BackgroundSyncInterval::Manual;
        assert!(sync_interval(&settings).is_none());
        settings.sync_interval = BackgroundSyncInterval::FifteenMinutes;
        settings.paused = true;
        assert!(sync_interval(&settings).is_none());
    }

    #[test]
    fn enabled_background_settings_have_a_bounded_interval() {
        let mut settings = BackgroundSettings::default();
        settings.run_in_background = true;
        assert_eq!(sync_interval(&settings), Some(Duration::from_secs(15 * 60)));
    }
}
