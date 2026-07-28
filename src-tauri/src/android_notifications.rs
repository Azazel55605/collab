#![cfg(target_os = "android")]

use crate::notifications::{profile_ids, NotificationRecord, NotificationStore};
use jni::objects::{JClass, JObject, JString};
use jni::sys::jstring;
use jni::JNIEnv;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

const DELIVERY_BATCH_SIZE: u32 = 40;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct AndroidNotificationAction {
    kind: String,
    token: String,
    minutes: Option<u64>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct AndroidNotificationDelivery {
    notification_id: String,
    profile_id: String,
    channel: String,
    kind: String,
    title: String,
    body: Option<String>,
    time_sensitive: bool,
    actions: Vec<AndroidNotificationAction>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct AndroidProfileSchedule {
    profile_id: String,
    scheduled_at: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PushInvalidation {
    schema_version: u32,
    invalidation_id: String,
    account_key: String,
    category: String,
    cursor: Option<String>,
    created_at: String,
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

fn presentation(record: &NotificationRecord) -> (String, Option<String>) {
    match record.envelope.privacy.as_str() {
        "hidden" => (hidden_title(&record.envelope.kind).to_string(), None),
        "title-only" => (record.envelope.title.clone(), None),
        _ => (record.envelope.title.clone(), record.envelope.body.clone()),
    }
}

fn decode_string(env: &mut JNIEnv<'_>, value: &JString<'_>, label: &str) -> Result<String, String> {
    env.get_string(value)
        .map(|value| value.to_string_lossy().into_owned())
        .map_err(|_| format!("Could not decode {label}."))
}

fn encode_result(env: &mut JNIEnv<'_>, result: Result<String, String>) -> jstring {
    match result {
        Ok(payload) => env
            .new_string(payload)
            .map(JString::into_raw)
            .unwrap_or(std::ptr::null_mut()),
        Err(error) => {
            let _ = env.throw_new("java/lang/IllegalStateException", error);
            std::ptr::null_mut()
        }
    }
}

async fn store(profile_id: &str) -> Result<NotificationStore, String> {
    NotificationStore::open(&crate::commands::app_config_dir()?, profile_id)
        .await
        .map_err(|error| error.to_string())
}

async fn due_payload(profile_id: &str) -> Result<String, String> {
    let store = store(profile_id).await?;
    let records = store
        .list_due(profile_id, DELIVERY_BATCH_SIZE)
        .await
        .map_err(|error| error.to_string())?;
    let mut deliveries = Vec::with_capacity(records.len());
    for record in records {
        let mut actions = Vec::new();
        for action in &record.envelope.actions {
            let Some(kind) = action.get("kind").and_then(Value::as_str) else {
                continue;
            };
            if !matches!(kind, "dismiss" | "snooze") {
                continue;
            }
            let token = store
                .create_action_token(&record.envelope.id, action)
                .await
                .map_err(|error| error.to_string())?;
            actions.push(AndroidNotificationAction {
                kind: kind.to_string(),
                token: token.token,
                minutes: action.get("minutes").and_then(Value::as_u64),
            });
        }
        let (title, body) = presentation(&record);
        deliveries.push(AndroidNotificationDelivery {
            notification_id: record.envelope.id,
            profile_id: profile_id.to_string(),
            channel: record.envelope.channel,
            kind: record.envelope.kind,
            title,
            body,
            time_sensitive: record.envelope.priority == "time-sensitive",
            actions,
        });
    }
    serde_json::to_string(&deliveries)
        .map_err(|error| format!("Could not encode Android notifications: {error}"))
}

async fn complete_delivery(
    profile_id: &str,
    notification_id: &str,
    error: &str,
) -> Result<String, String> {
    let store = store(profile_id).await?;
    if error.is_empty() {
        store
            .mark_delivered(notification_id, "native")
            .await
            .map_err(|error| error.to_string())?;
    } else {
        store
            .mark_failed(notification_id, error)
            .await
            .map_err(|error| error.to_string())?;
    }
    Ok("{}".to_string())
}

async fn apply_action(profile_id: &str, token: &str) -> Result<String, String> {
    let store = store(profile_id).await?;
    let consumed = store
        .consume_action_token(token)
        .await
        .map_err(|error| error.to_string())?;
    let kind = consumed
        .action
        .get("kind")
        .and_then(Value::as_str)
        .ok_or_else(|| "Notification action is invalid.".to_string())?;
    match kind {
        "dismiss" => store
            .dismiss(&consumed.notification_id)
            .await
            .map_err(|error| error.to_string())?,
        "snooze" => {
            let minutes = consumed
                .action
                .get("minutes")
                .and_then(Value::as_u64)
                .and_then(|value| u32::try_from(value).ok())
                .ok_or_else(|| "Notification snooze duration is invalid.".to_string())?;
            store
                .snooze(&consumed.notification_id, minutes)
                .await
                .map_err(|error| error.to_string())?;
        }
        _ => return Err("Notification action is not available from Android.".to_string()),
    }
    serde_json::to_string(&json!({
        "notificationId": consumed.notification_id,
        "action": kind,
    }))
    .map_err(|error| error.to_string())
}

async fn profile_schedules() -> Result<String, String> {
    let root = crate::commands::app_config_dir()?;
    let mut schedules = Vec::new();
    for profile_id in profile_ids(&root).map_err(|error| error.to_string())? {
        let store = NotificationStore::open(&root, &profile_id)
            .await
            .map_err(|error| error.to_string())?;
        let scheduled_at = store
            .next_delivery_at(&profile_id)
            .await
            .map_err(|error| error.to_string())?
            .map(|value| value.to_rfc3339());
        schedules.push(AndroidProfileSchedule {
            profile_id,
            scheduled_at,
        });
    }
    serde_json::to_string(&schedules)
        .map_err(|error| format!("Could not encode Android schedules: {error}"))
}

async fn request_reconciliation(reason: &str) -> Result<String, String> {
    if !matches!(
        reason,
        "android.intent.action.BOOT_COMPLETED"
            | "android.intent.action.MY_PACKAGE_REPLACED"
            | "android.intent.action.TIME_SET"
            | "android.intent.action.TIMEZONE_CHANGED"
    ) {
        return Err("Android notification lifecycle reason is invalid.".to_string());
    }
    let root = crate::commands::app_config_dir()?;
    for profile_id in profile_ids(&root).map_err(|error| error.to_string())? {
        let store = NotificationStore::open(&root, &profile_id)
            .await
            .map_err(|error| error.to_string())?;
        store
            .request_reconciliation(&profile_id, "calendar.reminder")
            .await
            .map_err(|error| error.to_string())?;
    }
    Ok("{}".to_string())
}

fn validate_push_invalidation(payload: &str) -> Result<PushInvalidation, String> {
    let invalidation: PushInvalidation = serde_json::from_str(payload)
        .map_err(|_| "Push invalidation payload is invalid.".to_string())?;
    let opaque = |value: &str, min: usize, max: usize| {
        (min..=max).contains(&value.len())
            && value
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
    };
    if invalidation.schema_version != 1
        || !opaque(&invalidation.invalidation_id, 16, 256)
        || !opaque(&invalidation.account_key, 16, 160)
        || !matches!(
            invalidation.category.as_str(),
            "calendar.invitation"
                | "collaboration.message"
                | "collaboration.mention"
                | "sync.action-required"
        )
        || invalidation
            .cursor
            .as_ref()
            .is_some_and(|cursor| !opaque(cursor, 1, 256))
        || chrono::DateTime::parse_from_rfc3339(&invalidation.created_at).is_err()
    {
        return Err("Push invalidation payload is invalid.".to_string());
    }
    Ok(invalidation)
}

async fn register_push_token(
    installation_id: &str,
    token: &str,
    app_version: &str,
) -> Result<String, String> {
    if installation_id.is_empty()
        || installation_id.len() > 160
        || token.is_empty()
        || token.len() > 4_096
        || app_version.len() > 80
    {
        return Err("Android push registration is invalid.".to_string());
    }
    crate::background::notification_sync::register_push_token(
        &crate::state::app_state::shared_background_coordinator(),
        installation_id,
        token,
        (!app_version.is_empty()).then_some(app_version),
    )
    .await?;
    Ok("{}".to_string())
}

async fn handle_push_invalidation(payload: &str) -> Result<String, String> {
    let invalidation = validate_push_invalidation(payload)?;
    let _ = (
        invalidation.invalidation_id,
        invalidation.account_key,
        invalidation.category,
        invalidation.cursor,
    );
    let outcome = crate::state::app_state::shared_background_coordinator()
        .run_push_invalidation_to_completion(std::time::Duration::from_secs(60))
        .await?;
    serde_json::to_string(&outcome)
        .map_err(|error| format!("Could not encode push catch-up outcome: {error}"))
}

#[no_mangle]
pub extern "system" fn Java_com_azazel_collab_companion_CollabNotificationBridge_nativeListDue(
    mut env: JNIEnv<'_>,
    _class: JClass<'_>,
    context: JObject<'_>,
    profile_id: JString<'_>,
) -> jstring {
    let result = (|| {
        crate::android_jni::register_worker_context(&mut env, &context)?;
        let profile_id = decode_string(&mut env, &profile_id, "notification profile ID")?;
        tauri::async_runtime::block_on(due_payload(&profile_id))
    })();
    encode_result(&mut env, result)
}

#[no_mangle]
pub extern "system" fn Java_com_azazel_collab_companion_CollabNotificationBridge_nativeCompleteDelivery(
    mut env: JNIEnv<'_>,
    _class: JClass<'_>,
    context: JObject<'_>,
    profile_id: JString<'_>,
    notification_id: JString<'_>,
    error: JString<'_>,
) -> jstring {
    let result = (|| {
        crate::android_jni::register_worker_context(&mut env, &context)?;
        let profile_id = decode_string(&mut env, &profile_id, "notification profile ID")?;
        let notification_id = decode_string(&mut env, &notification_id, "notification ID")?;
        let error = decode_string(&mut env, &error, "notification delivery error")?;
        tauri::async_runtime::block_on(complete_delivery(&profile_id, &notification_id, &error))
    })();
    encode_result(&mut env, result)
}

#[no_mangle]
pub extern "system" fn Java_com_azazel_collab_companion_CollabNotificationBridge_nativeApplyAction(
    mut env: JNIEnv<'_>,
    _class: JClass<'_>,
    context: JObject<'_>,
    profile_id: JString<'_>,
    token: JString<'_>,
) -> jstring {
    let result = (|| {
        crate::android_jni::register_worker_context(&mut env, &context)?;
        let profile_id = decode_string(&mut env, &profile_id, "notification profile ID")?;
        let token = decode_string(&mut env, &token, "notification action token")?;
        tauri::async_runtime::block_on(apply_action(&profile_id, &token))
    })();
    encode_result(&mut env, result)
}

#[no_mangle]
pub extern "system" fn Java_com_azazel_collab_companion_CollabNotificationBridge_nativeProfileSchedules(
    mut env: JNIEnv<'_>,
    _class: JClass<'_>,
    context: JObject<'_>,
) -> jstring {
    let result = (|| {
        crate::android_jni::register_worker_context(&mut env, &context)?;
        tauri::async_runtime::block_on(profile_schedules())
    })();
    encode_result(&mut env, result)
}

#[no_mangle]
pub extern "system" fn Java_com_azazel_collab_companion_CollabNotificationBridge_nativeRequestReconciliation(
    mut env: JNIEnv<'_>,
    _class: JClass<'_>,
    context: JObject<'_>,
    reason: JString<'_>,
) -> jstring {
    let result = (|| {
        crate::android_jni::register_worker_context(&mut env, &context)?;
        let reason = decode_string(&mut env, &reason, "notification lifecycle reason")?;
        tauri::async_runtime::block_on(request_reconciliation(&reason))
    })();
    encode_result(&mut env, result)
}

#[no_mangle]
pub extern "system" fn Java_com_azazel_collab_companion_CollabNotificationBridge_nativeRegisterPushToken(
    mut env: JNIEnv<'_>,
    _class: JClass<'_>,
    context: JObject<'_>,
    installation_id: JString<'_>,
    token: JString<'_>,
    app_version: JString<'_>,
) -> jstring {
    let result = (|| {
        crate::android_jni::register_worker_context(&mut env, &context)?;
        let installation_id = decode_string(&mut env, &installation_id, "push installation ID")?;
        let token = decode_string(&mut env, &token, "push token")?;
        let app_version = decode_string(&mut env, &app_version, "app version")?;
        tauri::async_runtime::block_on(register_push_token(&installation_id, &token, &app_version))
    })();
    encode_result(&mut env, result)
}

#[no_mangle]
pub extern "system" fn Java_com_azazel_collab_companion_CollabNotificationBridge_nativeHandlePushInvalidation(
    mut env: JNIEnv<'_>,
    _class: JClass<'_>,
    context: JObject<'_>,
    payload: JString<'_>,
) -> jstring {
    let result = (|| {
        crate::android_jni::register_worker_context(&mut env, &context)?;
        let payload = decode_string(&mut env, &payload, "push invalidation")?;
        tauri::async_runtime::block_on(handle_push_invalidation(&payload))
    })();
    encode_result(&mut env, result)
}
