#![cfg(not(mobile))]

use crate::commands;
use crate::notifications::{profile_ids, NotificationEnvelope};
use serde::Serialize;
use tauri::{Emitter, Manager};
use tauri_plugin_notification::NotificationExt;

const DELIVERY_BATCH_SIZE: u32 = 20;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopNotificationPermission {
    pub status: String,
    pub supported: bool,
}

fn permission_name(state: tauri::plugin::PermissionState) -> &'static str {
    match state {
        tauri::plugin::PermissionState::Granted => "granted",
        tauri::plugin::PermissionState::Denied => "denied",
        tauri::plugin::PermissionState::Prompt => "prompt",
        tauri::plugin::PermissionState::PromptWithRationale => "prompt-with-rationale",
    }
}

pub fn permission_status(app: &tauri::AppHandle) -> Result<DesktopNotificationPermission, String> {
    let state = app
        .notification()
        .permission_state()
        .map_err(|error| format!("Could not read notification permission: {error}"))?;
    Ok(DesktopNotificationPermission {
        status: permission_name(state).to_string(),
        supported: true,
    })
}

pub fn request_permission(app: &tauri::AppHandle) -> Result<DesktopNotificationPermission, String> {
    let state = app
        .notification()
        .request_permission()
        .map_err(|error| format!("Could not request notification permission: {error}"))?;
    Ok(DesktopNotificationPermission {
        status: permission_name(state).to_string(),
        supported: true,
    })
}

pub fn send_test(app: &tauri::AppHandle) -> Result<(), String> {
    if permission_status(app)?.status != "granted" {
        return Err("Desktop notification permission is not granted.".into());
    }
    app.notification()
        .builder()
        .title("Collab notifications")
        .body("Desktop notifications are working.")
        .show()
        .map_err(|error| format!("Could not show the test notification: {error}"))
}

fn hidden_title(kind: &str) -> &'static str {
    match kind {
        "calendar.event-reminder" => "Calendar reminder",
        "calendar.task-reminder" => "Task reminder",
        "calendar.birthday-reminder" => "Birthday reminder",
        "calendar.invitation" | "calendar.invitation-update" => "Calendar invitation",
        "collaboration.message" => "New collaboration message",
        "collaboration.mention" => "New mention",
        "sync.conflict" | "sync.authentication-required" | "sync.permission-denied" => {
            "Sync needs attention"
        }
        "transfer.complete" => "Transfer complete",
        _ => "Collab notification",
    }
}

fn presentation(envelope: &NotificationEnvelope) -> (String, Option<String>) {
    match envelope.privacy.as_str() {
        "hidden" => (hidden_title(&envelope.kind).to_string(), None),
        "title-only" => (envelope.title.clone(), None),
        _ => (envelope.title.clone(), envelope.body.clone()),
    }
}

fn app_is_focused(app: &tauri::AppHandle) -> bool {
    app.get_webview_window("main").is_some_and(|window| {
        window.is_visible().unwrap_or(false)
            && window.is_focused().unwrap_or(false)
            && !window.is_minimized().unwrap_or(false)
    })
}

fn show_native(app: &tauri::AppHandle, envelope: &NotificationEnvelope) -> Result<(), String> {
    let (title, body) = presentation(envelope);
    let mut builder = app.notification().builder().title(title);
    if let Some(body) = body {
        builder = builder.body(body);
    }
    builder
        .show()
        .map_err(|error| format!("Could not show desktop notification: {error}"))
}

pub async fn dispatch_due(app: &tauri::AppHandle) -> Result<u64, String> {
    let root = commands::app_config_dir()?;
    let focused = app_is_focused(app);
    let permission_granted = if focused {
        false
    } else {
        permission_status(app)
            .map(|permission| permission.status == "granted")
            .unwrap_or(false)
    };
    let mut delivered = 0;
    for profile_id in profile_ids(&root).map_err(|error| error.to_string())? {
        let store = commands::notifications::store(&profile_id).await?;
        let due = store
            .list_due(&profile_id, DELIVERY_BATCH_SIZE)
            .await
            .map_err(|error| error.to_string())?;
        for record in due {
            let surface = if focused {
                "in-app"
            } else if permission_granted {
                if let Err(error) = show_native(app, &record.envelope) {
                    store
                        .mark_failed(&record.envelope.id, &error)
                        .await
                        .map_err(|store_error| store_error.to_string())?;
                    continue;
                }
                "native"
            } else {
                continue;
            };
            store
                .mark_delivered(&record.envelope.id, surface)
                .await
                .map_err(|error| error.to_string())?;
            delivered += 1;
            let _ = app.emit(
                "notifications:inbox-changed",
                serde_json::json!({
                    "profileId": profile_id,
                    "notificationId": record.envelope.id,
                    "surface": surface,
                }),
            );
        }
    }
    Ok(delivered)
}
