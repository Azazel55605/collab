use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use tauri::{AppHandle, Emitter};
use tauri_plugin_updater::UpdaterExt;

#[derive(serde::Serialize)]
pub struct UpdateInfo {
    pub available: bool,
    pub version: Option<String>,
    pub notes: Option<String>,
    pub date: Option<String>,
}

/// Check whether a new version is available. Does not download anything.
#[tauri::command]
pub async fn check_for_update(app: AppHandle) -> Result<UpdateInfo, String> {
    let updater = app.updater().map_err(|e| e.to_string())?;
    match updater.check().await.map_err(|e| e.to_string())? {
        Some(update) => Ok(UpdateInfo {
            available: true,
            version: Some(update.version.clone()),
            notes: update.body.clone(),
            date: update.date.map(|d| d.to_string()),
        }),
        None => Ok(UpdateInfo {
            available: false,
            version: None,
            notes: None,
            date: None,
        }),
    }
}

/// Download and install the latest update, emitting "update:progress" events during download.
/// The app will restart automatically once installation completes.
///
/// Emitted event payload: `{ downloaded: number, contentLength: number | null }`
#[tauri::command]
pub async fn download_and_install_update(app: AppHandle) -> Result<(), String> {
    let updater = app.updater().map_err(|e| e.to_string())?;
    let update = updater
        .check()
        .await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "No update available".to_string())?;

    let downloaded = Arc::new(AtomicU64::new(0));
    let downloaded_clone = downloaded.clone();
    let app_clone = app.clone();

    update
        .download_and_install(
            move |chunk_len, content_len| {
                let total = downloaded_clone.fetch_add(chunk_len as u64, Ordering::SeqCst)
                    + chunk_len as u64;
                let _ = app_clone.emit(
                    "update:progress",
                    serde_json::json!({
                        "downloaded": total,
                        "contentLength": content_len
                    }),
                );
            },
            || {},
        )
        .await
        .map_err(|e| e.to_string())?;

    Ok(())
}
