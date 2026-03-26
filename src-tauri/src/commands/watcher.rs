use crate::state::AppState;
use notify::RecursiveMode;
use notify_debouncer_mini::{new_debouncer, DebounceEventResult};
use std::path::Path;
use std::time::Duration;
use tauri::{AppHandle, Emitter, State};

#[tauri::command]
pub fn watch_vault(
    vault_path: String,
    app: AppHandle,
    state: State<AppState>,
) -> Result<(), String> {
    // Drop any existing watcher first
    {
        let mut watcher_lock = state.watcher.lock();
        *watcher_lock = None;
    }

    let app_handle = app.clone();
    let vault_path_clone = vault_path.clone();

    let mut debouncer =
        new_debouncer(
            Duration::from_millis(500),
            move |res: DebounceEventResult| {
                if let Ok(events) = res {
                    for event in events {
                        let path = &event.path;

                        // Get relative path string
                        let relative = path
                            .strip_prefix(&vault_path_clone)
                            .unwrap_or(path)
                            .to_string_lossy()
                            .replace('\\', "/");

                        // Check if this is a presence file
                        let is_presence = relative.starts_with(".collab/presence/");

                        if is_presence {
                            let _ = app_handle.emit("collab:presence-changed", serde_json::json!({}));
                            continue;
                        }

                        // Skip .collab directory changes (non-presence)
                        if relative.starts_with(".collab/") {
                            continue;
                        }

                        let payload = serde_json::json!({ "path": relative });
                        let _ = app_handle.emit("vault:file-modified", &payload);
                    }
                }
            },
        )
        .map_err(|e| e.to_string())?;

    debouncer
        .watcher()
        .watch(Path::new(&vault_path), RecursiveMode::Recursive)
        .map_err(|e| e.to_string())?;

    let mut watcher_lock = state.watcher.lock();
    *watcher_lock = Some(debouncer);

    Ok(())
}

#[tauri::command]
pub fn unwatch_vault(state: State<AppState>) -> Result<(), String> {
    let mut watcher_lock = state.watcher.lock();
    *watcher_lock = None;
    Ok(())
}
