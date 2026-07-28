use super::{
    sync::{classify_session_error, request_json, JobExecutionError, JobExecutionSummary},
    BackgroundCoordinator, BackgroundJobProgress, BackgroundJobRequest, BackgroundJobStatus,
};
use crate::{
    hosted_session::refresh_session_locked,
    notifications::{NotificationEnvelope, NotificationStore},
};
use reqwest::Method;
use serde::Deserialize;
use serde_json::json;
use std::{
    sync::atomic::{AtomicBool, Ordering},
    time::{Duration, Instant},
};

const PAGE_SIZE: usize = 200;
const MAX_PAGES_PER_PASS: usize = 20;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct NotificationChangePage {
    cursor: i64,
    changes: Vec<NotificationEnvelope>,
    has_more: bool,
}

pub(super) async fn run_notification_sync(
    coordinator: &BackgroundCoordinator,
    job_id: &str,
    request: &BackgroundJobRequest,
    cancel: &AtomicBool,
    budget: Duration,
) -> Result<JobExecutionSummary, JobExecutionError> {
    let started = Instant::now();
    let server_url = request.server_url.as_deref().ok_or_else(|| {
        JobExecutionError::persistence("Notification sync requires a server URL.")
    })?;
    let profile_id = request.profile_id.as_deref().ok_or_else(|| {
        JobExecutionError::persistence("Notification sync requires a profile ID.")
    })?;
    let registration = coordinator
        .list_servers()
        .map_err(JobExecutionError::persistence)?
        .into_iter()
        .find(|entry| entry.server_url == server_url)
        .ok_or_else(|| JobExecutionError {
            status: BackgroundJobStatus::Deferred,
            category: "server_registry",
            message: "The server is not registered for notification sync.".to_string(),
            retryable: false,
        })?;
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
    let root = coordinator
        .config_root()
        .map_err(JobExecutionError::persistence)?;
    let store = NotificationStore::open(&root, profile_id)
        .await
        .map_err(|error| JobExecutionError::persistence(error.to_string()))?;
    let mut cursor = store
        .remote_cursor(profile_id, server_url)
        .await
        .map_err(|error| JobExecutionError::persistence(error.to_string()))?
        .and_then(|value| value.parse::<i64>().ok())
        .unwrap_or(0);
    let mut changed = 0_u64;
    for page_index in 0..MAX_PAGES_PER_PASS {
        ensure_running(cancel, started, budget)?;
        coordinator
            .update_progress(
                job_id,
                BackgroundJobProgress {
                    completed: changed,
                    total: None,
                    detail: Some("Fetching notification updates".to_string()),
                },
            )
            .map_err(JobExecutionError::persistence)?;
        let path = format!("/api/v1/notifications/changes?cursor={cursor}&limit={PAGE_SIZE}");
        let mut page: NotificationChangePage =
            request_json(&session, Method::GET, &path, None).await?;
        if page.cursor < cursor
            || (page.has_more && (page.changes.is_empty() || page.cursor == cursor))
        {
            return Err(JobExecutionError::persistence(
                "The server returned a non-advancing notification page.",
            ));
        }
        for change in &mut page.changes {
            change.server_url = Some(server_url.to_string());
        }
        store
            .ingest(profile_id, &page.changes)
            .await
            .map_err(|error| JobExecutionError::persistence(error.to_string()))?;
        changed += page.changes.len() as u64;
        cursor = page.cursor;
        store
            .save_remote_cursor(profile_id, server_url, &cursor.to_string())
            .await
            .map_err(|error| JobExecutionError::persistence(error.to_string()))?;
        if !page.has_more {
            break;
        }
        if page_index == MAX_PAGES_PER_PASS - 1 {
            return Err(JobExecutionError::interrupted(
                "Notification sync reached its bounded page limit.",
            ));
        }
    }
    #[cfg(target_os = "android")]
    crate::android_jni::schedule_notification_profile(
        profile_id,
        store
            .next_delivery_at(profile_id)
            .await
            .map_err(|error| JobExecutionError::persistence(error.to_string()))?
            .as_ref()
            .map(chrono::DateTime::to_rfc3339)
            .as_deref(),
    )
    .map_err(JobExecutionError::persistence)?;
    Ok(JobExecutionSummary {
        completed: changed,
        total: changed,
        failed: 0,
        changed,
        message: if changed == 0 {
            "Notifications are already up to date".to_string()
        } else {
            format!("Fetched {changed} notification update(s)")
        },
    })
}

#[cfg_attr(not(target_os = "android"), allow(dead_code))]
pub(crate) async fn register_push_token(
    coordinator: &BackgroundCoordinator,
    installation_id: &str,
    token: &str,
    app_version: Option<&str>,
) -> Result<(), String> {
    let mut failures = Vec::new();
    for registration in coordinator.list_servers()? {
        let session = match refresh_session_locked(
            &coordinator.sessions,
            &registration.server_url,
            registration.allow_invalid_certificates,
            registration.persist_across_reboots,
            true,
        )
        .await
        {
            Ok(session) => session,
            Err(error) => {
                failures.push(format!("{}: {error}", registration.server_url));
                continue;
            }
        };
        let body = json!({
            "installationId": installation_id,
            "platform": "android",
            "provider": "fcm",
            "token": token,
            "appVersion": app_version,
        });
        if let Err(error) = request_json::<serde_json::Value>(
            &session,
            Method::POST,
            "/api/v1/notifications/devices",
            Some(body),
        )
        .await
        {
            failures.push(format!("{}: {}", registration.server_url, error.message));
        }
    }
    if failures.is_empty() {
        Ok(())
    } else {
        Err(format!(
            "Push registration failed for {} server(s).",
            failures.len()
        ))
    }
}

fn ensure_running(
    cancel: &AtomicBool,
    started: Instant,
    budget: Duration,
) -> Result<(), JobExecutionError> {
    if cancel.load(Ordering::Acquire) {
        return Err(JobExecutionError {
            status: BackgroundJobStatus::Cancelled,
            category: "cancelled",
            message: "Notification sync was cancelled.".to_string(),
            retryable: false,
        });
    }
    if started.elapsed() >= budget {
        return Err(JobExecutionError::interrupted(
            "Notification sync reached its runtime budget.",
        ));
    }
    Ok(())
}
