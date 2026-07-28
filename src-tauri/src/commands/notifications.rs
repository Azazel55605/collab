use super::app_config_dir;
use crate::notifications::{
    ConsumedNotificationAction, NotificationActionToken, NotificationEnvelope,
    NotificationReconcileResult, NotificationReconciliationRequest, NotificationRecord,
    NotificationStore,
};
use serde_json::Value;
use std::{collections::HashMap, sync::OnceLock};
use tauri::AppHandle;
use tokio::sync::Mutex;

static NOTIFICATION_STORES: OnceLock<Mutex<HashMap<String, NotificationStore>>> = OnceLock::new();

fn notification_stores() -> &'static Mutex<HashMap<String, NotificationStore>> {
    NOTIFICATION_STORES.get_or_init(|| Mutex::new(HashMap::new()))
}

pub(crate) async fn store(profile_id: &str) -> Result<NotificationStore, String> {
    let mut stores = notification_stores().lock().await;
    if let Some(store) = stores.get(profile_id) {
        return Ok(store.clone());
    }
    let store = NotificationStore::open(&app_config_dir()?, profile_id)
        .await
        .map_err(|error| error.to_string())?;
    stores.insert(profile_id.to_owned(), store.clone());
    Ok(store)
}

async fn reconcile_platform_schedule(
    profile_id: &str,
    store: &NotificationStore,
) -> Result<(), String> {
    #[cfg(target_os = "android")]
    {
        let scheduled_at = store
            .next_delivery_at(profile_id)
            .await
            .map_err(|error| error.to_string())?
            .map(|value| value.to_rfc3339());
        crate::android_jni::schedule_notification_profile(profile_id, scheduled_at.as_deref())?;
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = (profile_id, store);
    }
    Ok(())
}

#[tauri::command]
pub async fn notification_reconcile(
    profile_id: String,
    category: String,
    entries: Vec<NotificationEnvelope>,
) -> Result<NotificationReconcileResult, String> {
    let store = store(&profile_id).await?;
    let result = store
        .reconcile(&profile_id, &category, &entries)
        .await
        .map_err(|error| error.to_string())?;
    reconcile_platform_schedule(&profile_id, &store).await?;
    Ok(result)
}

#[tauri::command]
pub async fn notification_cancel_category(
    profile_id: String,
    category: String,
) -> Result<u64, String> {
    let store = store(&profile_id).await?;
    let cancelled = store
        .cancel_category(&profile_id, &category)
        .await
        .map_err(|error| error.to_string())?;
    reconcile_platform_schedule(&profile_id, &store).await?;
    Ok(cancelled)
}

#[tauri::command]
pub async fn notification_list_inbox(
    profile_id: String,
    include_dismissed: bool,
    limit: u32,
) -> Result<Vec<NotificationRecord>, String> {
    store(&profile_id)
        .await?
        .list_inbox(&profile_id, include_dismissed, limit)
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn notification_mark_read(
    profile_id: String,
    notification_id: String,
    read: bool,
) -> Result<(), String> {
    store(&profile_id)
        .await?
        .mark_read(&notification_id, read)
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn notification_dismiss(
    profile_id: String,
    notification_id: String,
) -> Result<(), String> {
    store(&profile_id)
        .await?
        .dismiss(&notification_id)
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn notification_snooze(
    profile_id: String,
    notification_id: String,
    minutes: u32,
) -> Result<NotificationRecord, String> {
    let store = store(&profile_id).await?;
    let record = store
        .snooze(&notification_id, minutes)
        .await
        .map_err(|error| error.to_string())?;
    reconcile_platform_schedule(&profile_id, &store).await?;
    Ok(record)
}

#[tauri::command]
pub async fn notification_mark_failed(
    profile_id: String,
    notification_id: String,
    message: String,
) -> Result<(), String> {
    store(&profile_id)
        .await?
        .mark_failed(&notification_id, &message)
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn notification_retry(profile_id: String, notification_id: String) -> Result<(), String> {
    let store = store(&profile_id).await?;
    store
        .retry(&notification_id)
        .await
        .map_err(|error| error.to_string())?;
    reconcile_platform_schedule(&profile_id, &store).await
}

#[tauri::command]
pub async fn notification_reconcile_platform_schedule(profile_id: String) -> Result<(), String> {
    let store = store(&profile_id).await?;
    reconcile_platform_schedule(&profile_id, &store).await
}

#[tauri::command]
pub async fn notification_create_action_token(
    profile_id: String,
    notification_id: String,
    action: Value,
) -> Result<NotificationActionToken, String> {
    store(&profile_id)
        .await?
        .create_action_token(&notification_id, &action)
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn notification_consume_action_token(
    profile_id: String,
    token: String,
) -> Result<ConsumedNotificationAction, String> {
    store(&profile_id)
        .await?
        .consume_action_token(&token)
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn notification_cleanup(profile_id: String, retention_days: u32) -> Result<u64, String> {
    store(&profile_id)
        .await?
        .cleanup(retention_days)
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn notification_list_reconciliation_requests(
    profile_id: String,
) -> Result<Vec<NotificationReconciliationRequest>, String> {
    store(&profile_id)
        .await?
        .list_reconciliation_requests(&profile_id)
        .await
        .map_err(|error| error.to_string())
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NotificationPermissionStatus {
    pub status: String,
    pub supported: bool,
}

#[tauri::command]
pub fn notification_permission_status(
    app: AppHandle,
) -> Result<NotificationPermissionStatus, String> {
    #[cfg(not(mobile))]
    {
        let status = crate::desktop_notifications::permission_status(&app)?;
        return Ok(NotificationPermissionStatus {
            status: status.status,
            supported: status.supported,
        });
    }
    #[cfg(mobile)]
    {
        let _ = app;
        #[cfg(target_os = "android")]
        {
            return Ok(NotificationPermissionStatus {
                status: crate::android_jni::notification_permission_status()?,
                supported: true,
            });
        }
        #[cfg(not(target_os = "android"))]
        {
            Ok(NotificationPermissionStatus {
                status: "unsupported".into(),
                supported: false,
            })
        }
    }
}

#[tauri::command]
pub fn notification_request_permission(
    app: AppHandle,
) -> Result<NotificationPermissionStatus, String> {
    #[cfg(not(mobile))]
    {
        let status = crate::desktop_notifications::request_permission(&app)?;
        return Ok(NotificationPermissionStatus {
            status: status.status,
            supported: status.supported,
        });
    }
    #[cfg(mobile)]
    {
        let _ = app;
        #[cfg(target_os = "android")]
        {
            return Ok(NotificationPermissionStatus {
                status: crate::android_jni::request_notification_permission()?,
                supported: true,
            });
        }
        #[cfg(not(target_os = "android"))]
        {
            Ok(NotificationPermissionStatus {
                status: "unsupported".into(),
                supported: false,
            })
        }
    }
}

#[tauri::command]
pub fn notification_send_test(app: AppHandle) -> Result<(), String> {
    #[cfg(not(mobile))]
    {
        return crate::desktop_notifications::send_test(&app);
    }
    #[cfg(mobile)]
    {
        let _ = app;
        #[cfg(target_os = "android")]
        {
            return crate::android_jni::send_test_notification();
        }
        #[cfg(not(target_os = "android"))]
        {
            Err("Notifications are unavailable on this platform.".into())
        }
    }
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AndroidExactAlarmStatus {
    pub status: String,
    pub supported: bool,
}

#[tauri::command]
pub fn notification_android_exact_alarm_status() -> Result<AndroidExactAlarmStatus, String> {
    #[cfg(target_os = "android")]
    {
        return Ok(AndroidExactAlarmStatus {
            status: crate::android_jni::exact_alarm_status()?,
            supported: true,
        });
    }
    #[cfg(not(target_os = "android"))]
    {
        Ok(AndroidExactAlarmStatus {
            status: "unsupported".into(),
            supported: false,
        })
    }
}

#[tauri::command]
pub fn notification_android_open_exact_alarm_settings() -> Result<(), String> {
    #[cfg(target_os = "android")]
    {
        return crate::android_jni::open_exact_alarm_settings();
    }
    #[cfg(not(target_os = "android"))]
    {
        Err("Exact alarm settings are available only on Android.".into())
    }
}

#[tauri::command]
pub fn notification_android_take_pending_open() -> Result<Option<Value>, String> {
    #[cfg(target_os = "android")]
    {
        return crate::android_jni::take_pending_notification_open()?
            .map(|payload| {
                serde_json::from_str(&payload)
                    .map_err(|error| format!("Android notification route is invalid: {error}"))
            })
            .transpose();
    }
    #[cfg(not(target_os = "android"))]
    {
        Ok(None)
    }
}
