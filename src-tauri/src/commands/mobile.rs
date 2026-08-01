use serde::Serialize;
use serde_json::Value;
use tauri::Manager;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MobileAppDataProbe {
    pub value: String,
    pub previous_value: Option<String>,
    pub file_path: String,
}

#[tauri::command]
pub async fn mobile_app_data_probe(
    app: tauri::AppHandle,
    value: String,
) -> Result<MobileAppDataProbe, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|_| "Could not resolve the app data directory.".to_string())?;
    tokio::fs::create_dir_all(&dir)
        .await
        .map_err(|_| "Could not create the app data directory.".to_string())?;
    let path = dir.join("mobile-phase0-probe.txt");
    let previous_value = tokio::fs::read_to_string(&path).await.ok();
    tokio::fs::write(&path, value.as_bytes())
        .await
        .map_err(|_| "Could not write the app data probe.".to_string())?;
    let restored = tokio::fs::read_to_string(&path)
        .await
        .map_err(|_| "Could not read the app data probe.".to_string())?;
    Ok(MobileAppDataProbe {
        value: restored,
        previous_value,
        file_path: path.display().to_string(),
    })
}

#[tauri::command]
pub fn mobile_exit_app(app: tauri::AppHandle) {
    app.exit(0);
}

#[tauri::command]
pub fn mobile_app_destination_take_pending() -> Result<Option<Value>, String> {
    #[cfg(target_os = "android")]
    {
        return crate::android_jni::take_pending_app_destination()?
            .map(|payload| {
                serde_json::from_str(&payload)
                    .map_err(|error| format!("Android app destination is invalid: {error}"))
            })
            .transpose();
    }
    #[cfg(not(target_os = "android"))]
    {
        Ok(None)
    }
}
