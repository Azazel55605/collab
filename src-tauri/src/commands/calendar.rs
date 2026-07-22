use super::app_config_dir;
use collab_calendar::{
    CalendarCleanupResult, CalendarDefinition, CalendarItem, CalendarOperation, CalendarStore,
    CalendarSyncState,
};

async fn store(profile_id: &str) -> Result<CalendarStore, String> {
    CalendarStore::open(&app_config_dir()?, profile_id)
        .await
        .map_err(|error| error.to_string())
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
pub async fn calendar_list_pending_operations(
    profile_id: String,
) -> Result<Vec<CalendarOperation>, String> {
    store(&profile_id)
        .await?
        .list_pending_operations()
        .await
        .map_err(|error| error.to_string())
}
