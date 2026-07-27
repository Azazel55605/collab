use super::sync::{
    classify_session_error, ensure_running, request_json, JobExecutionError, JobExecutionSummary,
};
use super::{BackgroundCoordinator, BackgroundJobProgress, BackgroundJobRequest};
use crate::hosted_session::refresh_session_locked;
use collab_calendar::{
    CalendarDefinition, CalendarLocation, CalendarMutation, CalendarOperation,
    CalendarRemoteChange, CalendarSyncState,
};
use reqwest::Method;
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::HashSet;
use std::sync::atomic::AtomicBool;
use std::time::{Duration, Instant};

const CHANGE_PAGE_SIZE: u32 = 500;
const OPERATION_BATCH_SIZE: usize = 500;
const MAX_CHANGE_PAGES_PER_PASS: usize = 100;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CalendarChangesPage {
    cursor: i64,
    changes: Vec<CalendarRemoteChange>,
    has_more: bool,
}

pub(crate) async fn run_calendar_sync(
    coordinator: &BackgroundCoordinator,
    job_id: &str,
    request: &BackgroundJobRequest,
    cancel: &AtomicBool,
    budget: Duration,
) -> Result<JobExecutionSummary, JobExecutionError> {
    let started = Instant::now();
    let server_url = request
        .server_url
        .as_deref()
        .ok_or_else(|| JobExecutionError::persistence("Calendar sync requires a server URL."))?;
    let profile_id = request
        .profile_id
        .as_deref()
        .ok_or_else(|| JobExecutionError::persistence("Calendar sync requires a profile ID."))?;
    let registration = coordinator
        .list_servers()
        .map_err(JobExecutionError::persistence)?
        .into_iter()
        .find(|entry| entry.server_url == server_url)
        .ok_or_else(|| {
            JobExecutionError::interrupted(
                "The server is not registered for native background work.",
            )
        })?;
    if !registration.background_sync_enabled {
        return Err(JobExecutionError::interrupted(
            "Background synchronization is disabled for this server.",
        ));
    }
    ensure_running(cancel, started, budget)?;
    let session = refresh_session_locked(
        &coordinator.sessions,
        server_url,
        registration.allow_invalid_certificates,
        registration.persist_across_reboots,
        true,
    )
    .await
    .map_err(classify_session_error)?;
    let user_id = session.user.id.clone();
    let origin_key = format!("{}::{user_id}", session.server_url);
    let store = crate::commands::calendar::store(profile_id)
        .await
        .map_err(JobExecutionError::persistence)?;
    let old_state = store
        .read_sync_state(&origin_key)
        .await
        .map_err(|error| JobExecutionError::persistence(error.to_string()))?;
    let mut cursor = old_state
        .as_ref()
        .and_then(|state| state.cursor.as_deref())
        .and_then(|cursor| cursor.parse::<i64>().ok())
        .filter(|cursor| *cursor >= 0)
        .unwrap_or(0);

    coordinator
        .update_progress(
            job_id,
            BackgroundJobProgress {
                completed: 0,
                total: None,
                detail: Some("Discovering hosted calendars".to_string()),
            },
        )
        .map_err(JobExecutionError::persistence)?;
    let remote_calendars: Vec<Value> =
        request_json(&session, Method::GET, "/api/v1/calendars", None).await?;
    let mut calendar_ids = HashSet::new();
    for value in remote_calendars {
        ensure_running(cancel, started, budget)?;
        let calendar = normalize_remote_calendar(value, &session.server_url, &user_id)?;
        calendar_ids.insert(calendar.id.clone());
        store
            .upsert_calendar(&calendar)
            .await
            .map_err(|error| JobExecutionError::persistence(error.to_string()))?;
    }
    for calendar in store
        .list_calendars()
        .await
        .map_err(|error| JobExecutionError::persistence(error.to_string()))?
    {
        if matches!(
            calendar.location,
            CalendarLocation::Hosted {
                ref server_url,
                ref user_id
            } if server_url.trim_end_matches('/') == session.server_url && user_id == &session.user.id
        ) {
            calendar_ids.insert(calendar.id);
        }
    }

    let pending = store
        .list_pending_operations()
        .await
        .map_err(|error| JobExecutionError::persistence(error.to_string()))?
        .into_iter()
        .filter(|operation| {
            operation_calendar_id(operation)
                .is_some_and(|calendar_id| calendar_ids.contains(calendar_id))
        })
        .collect::<Vec<_>>();
    let mut replayed = 0_u64;
    let mut failed = 0_u64;
    for batch in pending.chunks(OPERATION_BATCH_SIZE) {
        ensure_running(cancel, started, budget)?;
        coordinator
            .update_progress(
                job_id,
                BackgroundJobProgress {
                    completed: replayed + failed,
                    total: Some(pending.len() as u64),
                    detail: Some("Uploading calendar changes".to_string()),
                },
            )
            .map_err(JobExecutionError::persistence)?;
        let result = replay_operation_groups(&session, &store, batch).await?;
        replayed += result.0;
        failed += result.1;
    }
    if failed > 0 {
        store
            .write_sync_state(&CalendarSyncState {
                origin_key,
                cursor: Some(cursor.to_string()),
                last_synced_at: old_state.and_then(|state| state.last_synced_at),
                last_error: Some(format!("{failed} calendar change(s) require attention.")),
            })
            .await
            .map_err(|error| JobExecutionError::persistence(error.to_string()))?;
        return Ok(JobExecutionSummary {
            completed: replayed + failed,
            total: replayed + failed,
            failed,
            message: format!("{failed} calendar change(s) require attention"),
        });
    }

    let mut applied = 0_u64;
    for page_index in 0..MAX_CHANGE_PAGES_PER_PASS {
        ensure_running(cancel, started, budget)?;
        coordinator
            .update_progress(
                job_id,
                BackgroundJobProgress {
                    completed: applied,
                    total: None,
                    detail: Some("Downloading calendar changes".to_string()),
                },
            )
            .map_err(JobExecutionError::persistence)?;
        let path = format!("/api/v1/calendars/changes?cursor={cursor}&limit={CHANGE_PAGE_SIZE}");
        let page: CalendarChangesPage = request_json(&session, Method::GET, &path, None).await?;
        if page.cursor < cursor
            || (page.has_more && (page.changes.is_empty() || page.cursor == cursor))
        {
            return Err(JobExecutionError::persistence(
                "The server returned a non-advancing calendar change page.",
            ));
        }
        let changes = page
            .changes
            .into_iter()
            .map(|change| normalize_remote_change(change, &session.server_url, &user_id))
            .collect::<Result<Vec<_>, _>>()?;
        cursor = page.cursor;
        let state = CalendarSyncState {
            origin_key: origin_key.clone(),
            cursor: Some(cursor.to_string()),
            last_synced_at: Some(chrono::Utc::now().to_rfc3339()),
            last_error: None,
        };
        store
            .apply_remote_changes(&changes, &state)
            .await
            .map_err(|error| JobExecutionError::persistence(error.to_string()))?;
        applied += changes.len() as u64;
        if !page.has_more {
            break;
        }
        if page_index == MAX_CHANGE_PAGES_PER_PASS - 1 {
            return Err(JobExecutionError::interrupted(
                "Calendar sync reached its bounded page limit.",
            ));
        }
    }

    Ok(JobExecutionSummary {
        completed: replayed + failed + applied,
        total: replayed + failed + applied,
        failed,
        message: format!("Replayed {replayed} and applied {applied} calendar change(s)"),
    })
}

async fn replay_batch(
    session: &crate::state::ServerSessionState,
    operations: &[CalendarOperation],
) -> Result<(), JobExecutionError> {
    let _: Value = request_json(
        session,
        Method::POST,
        "/api/v1/calendars/operations",
        Some(json!({ "operations": operations })),
    )
    .await?;
    Ok(())
}

async fn replay_operation_groups(
    session: &crate::state::ServerSessionState,
    store: &collab_calendar::CalendarStore,
    operations: &[CalendarOperation],
) -> Result<(u64, u64), JobExecutionError> {
    let mut groups = vec![operations.to_vec()];
    let mut replayed = 0;
    let mut failed = 0;
    while let Some(group) = groups.pop() {
        match replay_batch(session, &group).await {
            Ok(()) => {
                let ids = group
                    .iter()
                    .map(|operation| operation.client_operation_id.clone())
                    .collect::<Vec<_>>();
                store
                    .acknowledge_operations(&ids)
                    .await
                    .map_err(|error| JobExecutionError::persistence(error.to_string()))?;
                replayed += group.len() as u64;
            }
            Err(error) if error.retryable => return Err(error),
            Err(_) if group.len() > 1 => {
                let middle = group.len().div_ceil(2);
                groups.push(group[middle..].to_vec());
                groups.push(group[..middle].to_vec());
            }
            Err(error) => {
                let operation = &group[0];
                store
                    .mark_operation_failed(
                        &operation.client_operation_id,
                        &error.message,
                        &chrono::Utc::now().to_rfc3339(),
                    )
                    .await
                    .map_err(|store_error| {
                        JobExecutionError::persistence(store_error.to_string())
                    })?;
                failed += 1;
            }
        }
    }
    Ok((replayed, failed))
}

fn operation_calendar_id(operation: &CalendarOperation) -> Option<&str> {
    match &operation.mutation {
        CalendarMutation::CreateCalendar { calendar }
        | CalendarMutation::UpdateCalendar { calendar } => Some(&calendar.id),
        CalendarMutation::DeleteCalendar { calendar_id }
        | CalendarMutation::DeleteItem { calendar_id, .. } => Some(calendar_id),
        CalendarMutation::UpsertItem { item } => Some(&item.calendar_id),
    }
}

fn normalize_remote_calendar(
    mut value: Value,
    server_url: &str,
    user_id: &str,
) -> Result<CalendarDefinition, JobExecutionError> {
    let location_kind = value
        .get("location")
        .and_then(|location| location.get("kind"))
        .and_then(Value::as_str);
    let location = match location_kind {
        Some("kanban") => {
            let origin_key = value
                .get("location")
                .and_then(|location| location.get("originKey"))
                .and_then(Value::as_str)
                .map(str::to_string)
                .ok_or_else(|| {
                    JobExecutionError::persistence(
                        "The server returned an invalid Kanban calendar origin.",
                    )
                })?;
            set_read_only(&mut value);
            json!({ "kind": "kanban", "originKey": format!("{server_url}::{origin_key}") })
        }
        Some("subscription") => {
            let subscription_id = value
                .get("location")
                .and_then(|location| location.get("subscriptionId"))
                .and_then(Value::as_str)
                .map(str::to_string)
                .ok_or_else(|| {
                    JobExecutionError::persistence(
                        "The server returned an invalid calendar subscription.",
                    )
                })?;
            set_read_only(&mut value);
            json!({
                "kind": "subscription",
                "subscriptionId": subscription_id,
                "serverUrl": server_url,
                "userId": user_id
            })
        }
        _ => json!({ "kind": "hosted", "serverUrl": server_url, "userId": user_id }),
    };
    value
        .as_object_mut()
        .ok_or_else(|| {
            JobExecutionError::persistence("The server returned an invalid calendar definition.")
        })?
        .insert("location".to_string(), location);
    serde_json::from_value(value).map_err(|_| {
        JobExecutionError::persistence("The server returned an invalid calendar definition.")
    })
}

fn normalize_remote_change(
    mut change: CalendarRemoteChange,
    server_url: &str,
    user_id: &str,
) -> Result<CalendarRemoteChange, JobExecutionError> {
    if change.operation != "upsert" {
        return Ok(change);
    }
    if change.entity_type == "calendar" {
        let calendar = normalize_remote_calendar(
            change.payload.take().ok_or_else(|| {
                JobExecutionError::persistence("Remote calendar upsert has no payload.")
            })?,
            server_url,
            user_id,
        )?;
        change.payload = Some(
            serde_json::to_value(calendar)
                .map_err(|error| JobExecutionError::persistence(error.to_string()))?,
        );
    } else if change.entity_type == "item" {
        if let Some(payload) = change.payload.as_mut() {
            if payload
                .get("sourceBinding")
                .and_then(|binding| binding.get("kind"))
                .and_then(Value::as_str)
                == Some("kanban")
            {
                if let Some(binding) = payload
                    .get_mut("sourceBinding")
                    .and_then(Value::as_object_mut)
                {
                    binding.insert(
                        "serverUrl".to_string(),
                        Value::String(server_url.to_string()),
                    );
                }
            }
        }
    }
    Ok(change)
}

fn set_read_only(value: &mut Value) {
    if let Some(object) = value.as_object_mut() {
        object.insert("readOnly".to_string(), Value::Bool(true));
    }
}
