use super::app_config_dir;
#[cfg(target_os = "android")]
use crate::widgets::active_profile;
use crate::widgets::{
    build_snapshot, clear_active_profile, save_appearance, set_active_profile, WidgetActionRequest,
    WidgetAppearanceSnapshot, WidgetBuildRequest, WidgetConfiguration, WidgetDiagnostics,
    WidgetPreparedAction, WidgetPublishOutcome, WidgetSnapshot, WidgetStore,
};

fn store(profile_id: &str) -> Result<WidgetStore, String> {
    WidgetStore::open(&app_config_dir()?, profile_id)
}

#[tauri::command]
pub fn widget_appearance_save(
    appearance: WidgetAppearanceSnapshot,
) -> Result<WidgetAppearanceSnapshot, String> {
    let root = app_config_dir()?;
    let saved = save_appearance(&root, appearance)?;
    #[cfg(target_os = "android")]
    if let Some(profile_id) = active_profile(&root)? {
        crate::android_jni::request_widget_profile_rebuild(&profile_id)?;
    }
    Ok(saved)
}

#[tauri::command]
pub fn widget_active_profile_set(profile_id: String) -> Result<(), String> {
    set_active_profile(&app_config_dir()?, &profile_id)?;
    #[cfg(target_os = "android")]
    crate::android_jni::request_widget_profile_rebuild(&profile_id)?;
    Ok(())
}

#[tauri::command]
pub fn widget_configuration_list(profile_id: String) -> Result<Vec<WidgetConfiguration>, String> {
    let configurations = store(&profile_id)?.list_configurations()?;
    #[cfg(target_os = "android")]
    {
        let bound = crate::android_jni::bound_widget_configuration_ids(&profile_id)?;
        let bound = bound.into_iter().collect::<std::collections::HashSet<_>>();
        return Ok(configurations
            .into_iter()
            .filter(|configuration| bound.contains(&configuration.configuration_id))
            .collect());
    }
    #[cfg(not(target_os = "android"))]
    Ok(configurations)
}

#[tauri::command]
pub async fn widget_configuration_save(
    profile_id: String,
    configuration: WidgetConfiguration,
) -> Result<WidgetConfiguration, String> {
    let saved = store(&profile_id)?.save_configuration(configuration)?;
    #[cfg(target_os = "android")]
    {
        let root = app_config_dir()?;
        let calendar_store = crate::commands::calendar::store(&profile_id).await?;
        let now = chrono::Utc::now();
        if let Err(error) = crate::widgets::build_and_publish_agenda_profile(
            &root,
            &profile_id,
            &calendar_store,
            now,
            "settings",
        )
        .await
        {
            let _ = store(&profile_id)?.record_refresh_failure(&now.to_rfc3339(), "settings");
            return Err(error);
        }
        crate::android_jni::update_widgets()?;
    }
    Ok(saved)
}

#[tauri::command]
pub fn widget_configuration_delete(
    profile_id: String,
    configuration_id: String,
) -> Result<bool, String> {
    let removed = store(&profile_id)?.delete_configuration(&configuration_id)?;
    #[cfg(target_os = "android")]
    crate::android_jni::request_widget_profile_rebuild(&profile_id)?;
    Ok(removed)
}

#[tauri::command]
pub fn widget_diagnostics_list(profile_id: String) -> Result<Vec<WidgetDiagnostics>, String> {
    store(&profile_id)?.list_diagnostics()
}

#[tauri::command]
pub async fn widget_refresh(profile_id: String) -> Result<Vec<WidgetDiagnostics>, String> {
    #[cfg(not(target_os = "android"))]
    {
        let _ = profile_id;
        return Err("Mobile widget refresh is only available on Android.".into());
    }
    #[cfg(target_os = "android")]
    {
        let root = app_config_dir()?;
        let calendar_store = crate::commands::calendar::store(&profile_id).await?;
        let now = chrono::Utc::now();
        if let Err(error) = crate::widgets::build_and_publish_agenda_profile(
            &root,
            &profile_id,
            &calendar_store,
            now,
            "manual",
        )
        .await
        {
            let _ = store(&profile_id)?.record_refresh_failure(&now.to_rfc3339(), "manual");
            return Err(error);
        }
        #[cfg(target_os = "android")]
        crate::android_jni::update_widgets()?;
        store(&profile_id)?.list_diagnostics()
    }
}

#[tauri::command]
pub fn widget_snapshot_build_and_publish(
    profile_id: String,
    request: WidgetBuildRequest,
) -> Result<WidgetPublishOutcome, String> {
    let snapshot = build_snapshot(&profile_id, request)?;
    store(&profile_id)?.publish(snapshot)
}

#[tauri::command]
pub fn widget_snapshot_read(
    profile_id: String,
    configuration_id: String,
) -> Result<Option<WidgetSnapshot>, String> {
    store(&profile_id)?.read_snapshot(&configuration_id)
}

#[tauri::command]
pub fn widget_action_prepare(
    profile_id: String,
    request: WidgetActionRequest,
) -> Result<WidgetPreparedAction, String> {
    store(&profile_id)?.prepare_action(request)
}

#[tauri::command]
pub fn widget_profile_cleanup(profile_id: String) -> Result<(), String> {
    let root = app_config_dir()?;
    WidgetStore::open(&root, &profile_id)?.cleanup_profile()?;
    let _ = clear_active_profile(&root, &profile_id)?;
    #[cfg(target_os = "android")]
    {
        crate::android_jni::cancel_widget_profile(&profile_id)?;
        crate::android_jni::update_widgets()?;
    }
    Ok(())
}
