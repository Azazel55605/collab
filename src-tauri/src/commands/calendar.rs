use super::app_config_dir;
use collab_calendar::{
    CalendarCleanupResult, CalendarDefinition, CalendarItem, CalendarMirrorAnchor,
    CalendarMirrorConflict, CalendarMirrorGroup, CalendarOperation, CalendarOperationFailure,
    CalendarRemoteChange, CalendarStore, CalendarSubscription, CalendarSyncState,
};
use std::{collections::HashMap, sync::OnceLock};
use tokio::sync::Mutex;

static CALENDAR_STORES: OnceLock<Mutex<HashMap<String, CalendarStore>>> = OnceLock::new();

fn calendar_stores() -> &'static Mutex<HashMap<String, CalendarStore>> {
    CALENDAR_STORES.get_or_init(|| Mutex::new(HashMap::new()))
}

async fn store(profile_id: &str) -> Result<CalendarStore, String> {
    let mut stores = calendar_stores().lock().await;
    if let Some(store) = stores.get(profile_id) {
        return Ok(store.clone());
    }
    let store = CalendarStore::open(&app_config_dir()?, profile_id)
        .await
        .map_err(|error| error.to_string())?;
    stores.insert(profile_id.to_owned(), store.clone());
    Ok(store)
}

#[tauri::command]
pub async fn calendar_list(profile_id: String) -> Result<Vec<CalendarDefinition>, String> {
    store(&profile_id)
        .await?
        .list_calendars()
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn calendar_save(profile_id: String, calendar: CalendarDefinition) -> Result<(), String> {
    store(&profile_id)
        .await?
        .upsert_calendar(&calendar)
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn calendar_replace_generated_kanban(
    profile_id: String,
    calendar: CalendarDefinition,
    items: Vec<CalendarItem>,
) -> Result<(), String> {
    store(&profile_id)
        .await?
        .replace_generated_kanban_calendar(&calendar, &items)
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn calendar_replace_subscription(
    profile_id: String,
    calendar: CalendarDefinition,
    items: Vec<CalendarItem>,
    subscription: CalendarSubscription,
) -> Result<(), String> {
    store(&profile_id)
        .await?
        .replace_subscription_calendar(&calendar, &items, &subscription)
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn calendar_list_subscriptions(
    profile_id: String,
) -> Result<Vec<CalendarSubscription>, String> {
    store(&profile_id)
        .await?
        .list_subscriptions()
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn calendar_save_subscription(
    profile_id: String,
    subscription: CalendarSubscription,
) -> Result<(), String> {
    store(&profile_id)
        .await?
        .upsert_subscription(&subscription)
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn calendar_delete_subscription(
    profile_id: String,
    subscription_id: String,
) -> Result<(), String> {
    store(&profile_id)
        .await?
        .delete_subscription(&subscription_id)
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn calendar_save_with_operation(
    profile_id: String,
    calendar: CalendarDefinition,
    operation: CalendarOperation,
) -> Result<(), String> {
    store(&profile_id)
        .await?
        .upsert_calendar_with_operation(&calendar, &operation)
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn calendar_delete(
    profile_id: String,
    calendar_id: String,
    deleted_at: String,
    operation: CalendarOperation,
) -> Result<(), String> {
    store(&profile_id)
        .await?
        .delete_calendar_with_operation(&calendar_id, &deleted_at, &operation)
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn calendar_cleanup(
    profile_id: String,
    retention_days: u32,
) -> Result<CalendarCleanupResult, String> {
    if !(30..=3_650).contains(&retention_days) {
        return Err("Calendar tombstone retention must be between 30 and 3650 days.".into());
    }
    let cutoff = chrono::Utc::now() - chrono::Duration::days(i64::from(retention_days));
    store(&profile_id)
        .await?
        .cleanup_tombstones(&cutoff.to_rfc3339())
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn calendar_list_items(
    profile_id: String,
    from: String,
    to: String,
    limit: u32,
    include_deleted: bool,
) -> Result<Vec<CalendarItem>, String> {
    store(&profile_id)
        .await?
        .list_items_in_range(&from, &to, limit, include_deleted)
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn calendar_upsert_item(
    profile_id: String,
    item: CalendarItem,
    operation: CalendarOperation,
) -> Result<(), String> {
    store(&profile_id)
        .await?
        .upsert_item_with_operation(&item, &operation)
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn calendar_upsert_items(
    profile_id: String,
    entries: Vec<(CalendarItem, CalendarOperation)>,
) -> Result<(), String> {
    store(&profile_id)
        .await?
        .upsert_items_with_operations(&entries)
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn calendar_list_calendar_items(
    profile_id: String,
    calendar_id: String,
    limit: u32,
) -> Result<Vec<CalendarItem>, String> {
    store(&profile_id)
        .await?
        .list_items_for_calendar(&calendar_id, limit)
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn calendar_delete_item(
    profile_id: String,
    calendar_id: String,
    item_id: String,
    deleted_at: String,
    operation: CalendarOperation,
) -> Result<(), String> {
    store(&profile_id)
        .await?
        .delete_item_with_operation(&calendar_id, &item_id, &deleted_at, &operation)
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn calendar_search_items(
    profile_id: String,
    query: String,
    limit: u32,
) -> Result<Vec<CalendarItem>, String> {
    store(&profile_id)
        .await?
        .search_items(&query, limit)
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn calendar_acknowledge_operations(
    profile_id: String,
    client_operation_ids: Vec<String>,
) -> Result<(), String> {
    store(&profile_id)
        .await?
        .acknowledge_operations(&client_operation_ids)
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn calendar_read_sync_state(
    profile_id: String,
    origin_key: String,
) -> Result<Option<CalendarSyncState>, String> {
    store(&profile_id)
        .await?
        .read_sync_state(&origin_key)
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn calendar_write_sync_state(
    profile_id: String,
    state: CalendarSyncState,
) -> Result<(), String> {
    store(&profile_id)
        .await?
        .write_sync_state(&state)
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn calendar_apply_remote_changes(
    profile_id: String,
    changes: Vec<CalendarRemoteChange>,
    state: CalendarSyncState,
) -> Result<(), String> {
    store(&profile_id)
        .await?
        .apply_remote_changes(&changes, &state)
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn calendar_list_pending_operations(
    profile_id: String,
) -> Result<Vec<CalendarOperation>, String> {
    store(&profile_id)
        .await?
        .list_pending_operations()
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn calendar_list_failed_operations(
    profile_id: String,
) -> Result<Vec<CalendarOperationFailure>, String> {
    store(&profile_id)
        .await?
        .list_failed_operations()
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn calendar_mark_operation_failed(
    profile_id: String,
    client_operation_id: String,
    error: String,
    attempted_at: String,
) -> Result<(), String> {
    store(&profile_id)
        .await?
        .mark_operation_failed(&client_operation_id, &error, &attempted_at)
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn calendar_retry_operation(
    profile_id: String,
    client_operation_id: String,
) -> Result<(), String> {
    store(&profile_id)
        .await?
        .retry_operation(&client_operation_id)
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn calendar_discard_operation(
    profile_id: String,
    client_operation_id: String,
) -> Result<(), String> {
    store(&profile_id)
        .await?
        .discard_operation(&client_operation_id)
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn calendar_remove_hosted_cache(
    profile_id: String,
    server_url: String,
    user_id: String,
) -> Result<CalendarCleanupResult, String> {
    store(&profile_id)
        .await?
        .remove_hosted_origin_cache(&server_url, &user_id)
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn calendar_list_mirror_groups(
    profile_id: String,
) -> Result<Vec<CalendarMirrorGroup>, String> {
    store(&profile_id)
        .await?
        .list_mirror_groups()
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn calendar_save_mirror_group(
    profile_id: String,
    group: CalendarMirrorGroup,
) -> Result<(), String> {
    store(&profile_id)
        .await?
        .upsert_mirror_group(&group)
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn calendar_delete_mirror_group(
    profile_id: String,
    group_id: String,
) -> Result<(), String> {
    store(&profile_id)
        .await?
        .delete_mirror_group(&group_id)
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn calendar_list_mirror_anchors(
    profile_id: String,
    group_id: String,
) -> Result<Vec<CalendarMirrorAnchor>, String> {
    store(&profile_id)
        .await?
        .list_mirror_anchors(&group_id)
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn calendar_save_mirror_anchors(
    profile_id: String,
    anchors: Vec<CalendarMirrorAnchor>,
) -> Result<(), String> {
    store(&profile_id)
        .await?
        .upsert_mirror_anchors(&anchors)
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn calendar_list_mirror_conflicts(
    profile_id: String,
    group_id: Option<String>,
    include_resolved: bool,
) -> Result<Vec<CalendarMirrorConflict>, String> {
    store(&profile_id)
        .await?
        .list_mirror_conflicts(group_id.as_deref(), include_resolved)
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn calendar_save_mirror_conflict(
    profile_id: String,
    conflict: CalendarMirrorConflict,
) -> Result<(), String> {
    store(&profile_id)
        .await?
        .upsert_mirror_conflict(&conflict)
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn calendar_list_mirror_items(
    profile_id: String,
    calendar_ids: Vec<String>,
    limit: u32,
) -> Result<Vec<CalendarItem>, String> {
    store(&profile_id)
        .await?
        .list_items_for_mirror(&calendar_ids, limit)
        .await
        .map_err(|error| error.to_string())
}
