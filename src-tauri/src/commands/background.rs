use chrono::Utc;
use serde::{Deserialize, Serialize};
use std::path::Path;
use std::sync::Mutex;
use tauri::AppHandle;
use tauri::State;

use crate::background::{
    BackgroundJobAggregate, BackgroundJobRecord, BackgroundJobRequest, BackgroundJobTrigger,
    BackgroundServerRegistration, BackgroundSettings,
};
use crate::state::AppState;

const PROBE_FILE_NAME: &str = "background-phase0-probe.json";
const MAX_TRIGGER_LENGTH: usize = 64;
static PROBE_LOCK: Mutex<()> = Mutex::new(());

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackgroundRuntimeProbe {
    pub run_count: u64,
    pub last_trigger: String,
    pub last_run_at: String,
    pub process_id: u32,
    pub file_path: String,
}

#[derive(Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct PersistedBackgroundRuntimeProbe {
    run_count: u64,
    last_trigger: String,
    last_run_at: String,
    process_id: u32,
}

fn validate_trigger(trigger: &str) -> Result<(), String> {
    if trigger.is_empty() {
        return Err("The background probe trigger cannot be empty.".to_string());
    }
    if trigger.len() > MAX_TRIGGER_LENGTH || !trigger.is_ascii() {
        return Err("The background probe trigger must be short ASCII text.".to_string());
    }
    Ok(())
}

pub(crate) fn run_background_runtime_probe(
    root: &Path,
    trigger: &str,
) -> Result<BackgroundRuntimeProbe, String> {
    validate_trigger(trigger)?;
    let _guard = PROBE_LOCK
        .lock()
        .map_err(|_| "The background probe lock is unavailable.".to_string())?;

    std::fs::create_dir_all(root)
        .map_err(|error| format!("Could not create the background probe directory: {error}"))?;
    let path = root.join(PROBE_FILE_NAME);
    let previous = match std::fs::read(&path) {
        Ok(bytes) => serde_json::from_slice::<PersistedBackgroundRuntimeProbe>(&bytes)
            .map_err(|error| format!("Could not read the background probe ledger: {error}"))?,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            PersistedBackgroundRuntimeProbe::default()
        }
        Err(error) => {
            return Err(format!(
                "Could not read the background probe ledger: {error}"
            ))
        }
    };
    let run_count = previous
        .run_count
        .checked_add(1)
        .ok_or_else(|| "The background probe run counter overflowed.".to_string())?;
    let persisted = PersistedBackgroundRuntimeProbe {
        run_count,
        last_trigger: trigger.to_string(),
        last_run_at: Utc::now().to_rfc3339(),
        process_id: std::process::id(),
    };
    let encoded = serde_json::to_vec_pretty(&persisted)
        .map_err(|error| format!("Could not encode the background probe ledger: {error}"))?;
    std::fs::write(&path, encoded)
        .map_err(|error| format!("Could not write the background probe ledger: {error}"))?;

    Ok(BackgroundRuntimeProbe {
        run_count: persisted.run_count,
        last_trigger: persisted.last_trigger,
        last_run_at: persisted.last_run_at,
        process_id: persisted.process_id,
        file_path: path.display().to_string(),
    })
}

#[tauri::command]
pub fn background_runtime_probe(trigger: String) -> Result<BackgroundRuntimeProbe, String> {
    let root = super::app_config_dir()?;
    run_background_runtime_probe(&root, &trigger)
}

#[tauri::command]
pub fn background_server_list(
    state: State<'_, AppState>,
) -> Result<Vec<BackgroundServerRegistration>, String> {
    state.background.list_servers()
}

#[tauri::command]
pub fn background_server_replace(
    state: State<'_, AppState>,
    servers: Vec<BackgroundServerRegistration>,
) -> Result<Vec<BackgroundServerRegistration>, String> {
    state.background.replace_servers(servers)
}

#[tauri::command]
pub fn background_server_upsert(
    state: State<'_, AppState>,
    server: BackgroundServerRegistration,
) -> Result<BackgroundServerRegistration, String> {
    state.background.upsert_server(server)
}

#[tauri::command]
pub fn background_server_remove(
    state: State<'_, AppState>,
    server_url: String,
) -> Result<(), String> {
    state.background.remove_server(&server_url)
}

#[tauri::command]
pub fn background_job_run(
    state: State<'_, AppState>,
    request: BackgroundJobRequest,
) -> Result<BackgroundJobRecord, String> {
    state.background.clone().enqueue(request)
}

#[tauri::command]
pub fn background_job_get(
    state: State<'_, AppState>,
    job_id: String,
) -> Result<Option<BackgroundJobRecord>, String> {
    state.background.job(&job_id)
}

#[tauri::command]
pub fn background_job_list(
    state: State<'_, AppState>,
    limit: Option<usize>,
) -> Result<Vec<BackgroundJobRecord>, String> {
    state.background.list_jobs(limit.unwrap_or(50))
}

#[tauri::command]
pub fn background_job_cancel(
    state: State<'_, AppState>,
    job_id: String,
) -> Result<BackgroundJobRecord, String> {
    state.background.cancel(&job_id)
}

#[tauri::command]
pub fn background_job_aggregate(
    state: State<'_, AppState>,
) -> Result<BackgroundJobAggregate, String> {
    state.background.aggregate()
}

#[tauri::command]
pub fn background_settings_get(state: State<'_, AppState>) -> Result<BackgroundSettings, String> {
    state.background.settings()
}

#[tauri::command]
pub fn background_settings_save(
    app: AppHandle,
    state: State<'_, AppState>,
    mut settings: BackgroundSettings,
) -> Result<BackgroundSettings, String> {
    if !settings.run_in_background {
        settings.start_at_login = false;
        settings.paused = false;
    }
    #[cfg(not(mobile))]
    crate::background_lifecycle::set_autostart(&app, settings.start_at_login)?;
    #[cfg(mobile)]
    {
        let _ = app;
        settings.start_at_login = false;
    }
    let settings = state.background.save_settings(settings)?;
    #[cfg(not(mobile))]
    crate::background_lifecycle::apply_settings(&app, &settings);
    Ok(settings)
}

#[tauri::command]
pub fn background_sync_registered(
    state: State<'_, AppState>,
) -> Result<Vec<BackgroundJobRecord>, String> {
    state
        .background
        .clone()
        .enqueue_registered(BackgroundJobTrigger::UserInitiated)
}

#[tauri::command]
pub fn background_android_reconcile(
    state: State<'_, AppState>,
    profile_id: String,
) -> Result<(), String> {
    state
        .background
        .register_profile_for_all_servers(&profile_id)?;
    #[cfg(target_os = "android")]
    {
        let settings = state.background.settings()?;
        let enabled = !state.background.list_servers()?.is_empty()
            && settings.run_in_background
            && settings.background_sync
            && !settings.paused;
        let interval = match settings.sync_interval {
            crate::background::BackgroundSyncInterval::SystemManaged => "system_managed",
            crate::background::BackgroundSyncInterval::FifteenMinutes => "fifteen_minutes",
            crate::background::BackgroundSyncInterval::ThirtyMinutes => "thirty_minutes",
            crate::background::BackgroundSyncInterval::Hourly => "hourly",
            crate::background::BackgroundSyncInterval::Manual => "manual",
        };
        crate::android_jni::configure_background_scheduler(&profile_id, enabled, interval)
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = state;
        Err("Android background scheduling is only available on Android.".to_string())
    }
}

#[tauri::command]
pub fn background_android_request_immediate(
    state: State<'_, AppState>,
    profile_id: String,
    user_initiated: bool,
) -> Result<(), String> {
    state
        .background
        .register_profile_for_all_servers(&profile_id)?;
    #[cfg(target_os = "android")]
    {
        if !user_initiated {
            let settings = state.background.settings()?;
            if !settings.run_in_background || !settings.background_sync || settings.paused {
                return Ok(());
            }
        }
        crate::android_jni::request_immediate_background_work(&profile_id, user_initiated)
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = (state, user_initiated);
        Err("Android background scheduling is only available on Android.".to_string())
    }
}

#[tauri::command]
pub fn background_android_cancel_profile(profile_id: String) -> Result<(), String> {
    #[cfg(target_os = "android")]
    {
        crate::android_jni::cancel_background_profile(&profile_id)
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = profile_id;
        Err("Android background scheduling is only available on Android.".to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn probe_persists_and_increments_without_a_tauri_runtime() {
        let dir = tempfile::tempdir().expect("temporary directory");

        let first = run_background_runtime_probe(dir.path(), "test-first").expect("first probe");
        let second = run_background_runtime_probe(dir.path(), "test-second").expect("second probe");

        assert_eq!(first.run_count, 1);
        assert_eq!(second.run_count, 2);
        assert_eq!(second.last_trigger, "test-second");
        assert_eq!(
            second.file_path,
            dir.path().join(PROBE_FILE_NAME).display().to_string()
        );
    }

    #[test]
    fn probe_rejects_unbounded_or_ambiguous_triggers() {
        let dir = tempfile::tempdir().expect("temporary directory");

        assert!(run_background_runtime_probe(dir.path(), "").is_err());
        assert!(run_background_runtime_probe(dir.path(), &"x".repeat(65)).is_err());
        assert!(run_background_runtime_probe(dir.path(), "periodic-\u{2603}").is_err());
    }
}
