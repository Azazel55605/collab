mod calendar_sync;
mod models;
pub(crate) mod notification_sync;
mod persistence;
mod sync;

#[cfg(not(mobile))]
pub use models::BackgroundCloseBehavior;
pub use models::{
    BackgroundJobAggregate, BackgroundJobKind, BackgroundJobProgress, BackgroundJobRecord,
    BackgroundJobRequest, BackgroundJobStatus, BackgroundJobTrigger, BackgroundRunOutcome,
    BackgroundServerRegistration, BackgroundSettings, BackgroundStatusSnapshot,
    BackgroundSyncInterval,
};

use crate::hosted_client::validate_server_url;
use crate::state::HostedSessionRuntime;
use chrono::{Duration as ChronoDuration, Utc};
use collab_replica::ReplicaStore;
use parking_lot::Mutex;
use persistence::BackgroundPersistence;
use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::Semaphore;
use uuid::Uuid;

/// A read-only view of the durable background state for one config root.
///
/// Widget snapshots are built in processes that have no session runtime and
/// therefore no `BackgroundCoordinator` — the WorkManager worker and the
/// foreground app both reach the builder through the JNI bridge. Reading the
/// same ledger, registry, and settings files the coordinator writes keeps the
/// widget reporting on real coordinator state instead of a parallel copy.
#[cfg_attr(not(any(target_os = "android", test)), allow(dead_code))]
pub(crate) struct BackgroundLedgerView {
    pub jobs: Vec<BackgroundJobRecord>,
    pub servers: Vec<BackgroundServerRegistration>,
    pub settings: BackgroundSettings,
}

#[cfg_attr(not(any(target_os = "android", test)), allow(dead_code))]
pub(crate) fn read_ledger_view(
    config_root: &std::path::Path,
) -> Result<BackgroundLedgerView, String> {
    let persistence = BackgroundPersistence::at(config_root.to_path_buf());
    Ok(BackgroundLedgerView {
        jobs: persistence.list_jobs(MAX_LEDGER_VIEW_JOBS)?,
        servers: persistence.list_servers()?,
        settings: persistence.settings()?,
    })
}

/// Matches the coordinator's own aggregate window, so the widget and the app
/// summarize the same slice of the ledger.
const MAX_LEDGER_VIEW_JOBS: usize = 200;
const DEFAULT_RUNTIME_BUDGET_SECONDS: u64 = 120;
const MAX_RUNTIME_BUDGET_SECONDS: u64 = 600;
const MAX_IDEMPOTENCY_KEY_LENGTH: usize = 128;

struct ActiveJob {
    id: String,
    cancel: Arc<AtomicBool>,
}

/// How often a running job's progress reaches the durable ledger.
///
/// Progress used to be persisted on every tick, and a tick happens once per
/// file cached and once per queued operation replayed. Each one rewrote the
/// whole ledger — measured at ~580µs and ~126KB on a desktop SSD, so a
/// 1500-file vault wrote roughly 190MB and spent about a second in blocking IO
/// on the async runtime, holding a lock every UI read contends on. Android
/// flash is far slower than that, which is what made a background sync stall
/// the app. The live value now lives in memory and readers see it immediately;
/// the ledger only needs to be good enough to survive a crash.
const PROGRESS_PERSIST_INTERVAL: Duration = Duration::from_secs(2);

/// How often a run in flight republishes the launcher widgets.
///
/// Widget publication rebuilds every snapshot for the profile, so it is far too
/// expensive to do per tick — but publishing only at completion is why the sync
/// widget showed nothing at all while a sync was running.
#[cfg(target_os = "android")]
const WIDGET_PROGRESS_INTERVAL: Duration = Duration::from_secs(5);

struct LiveProgress {
    progress: BackgroundJobProgress,
    persisted_at: Instant,
    /// Captured when the job starts so a widget republication does not have to
    /// re-read the ledger to find out which profile to publish.
    #[cfg_attr(not(target_os = "android"), allow(dead_code))]
    profile_id: Option<String>,
    #[cfg(target_os = "android")]
    widgets_published_at: Instant,
}

/// Notified when background work starts, progresses, or lands new content.
///
/// The coordinator is a process-level singleton that must run headless in the
/// WorkManager process, where there is no Tauri app at all — so it cannot hold
/// an `AppHandle`. The running app installs this observer during setup and the
/// headless path simply has none.
pub trait BackgroundObserver: Send + Sync {
    /// A job started, made persisted progress, or reached a terminal state.
    fn status_changed(&self, snapshot: &BackgroundStatusSnapshot);
    /// A vault's replica took on new content. Views showing that vault are
    /// stale until they reload.
    fn vault_synced(&self, server_url: &str, vault_id: &str, changed: u64);
}

pub struct BackgroundCoordinator {
    pub(crate) sessions: Arc<HostedSessionRuntime>,
    persistence: BackgroundPersistence,
    active: Mutex<HashMap<String, ActiveJob>>,
    /// Progress of running jobs, ahead of the ledger. Overlaid onto every read
    /// so the UI and the widgets see the live value without paying for a write.
    live_progress: Mutex<HashMap<String, LiveProgress>>,
    observer: Mutex<Option<Arc<dyn BackgroundObserver>>>,
    concurrency: Arc<Semaphore>,
    shutting_down: AtomicBool,
    #[cfg(test)]
    allow_unencrypted_replicas: bool,
}

impl BackgroundCoordinator {
    pub fn new(sessions: Arc<HostedSessionRuntime>) -> Self {
        let coordinator = Self {
            sessions,
            persistence: BackgroundPersistence::new(),
            active: Mutex::new(HashMap::new()),
            live_progress: Mutex::new(HashMap::new()),
            observer: Mutex::new(None),
            concurrency: Arc::new(Semaphore::new(2)),
            shutting_down: AtomicBool::new(false),
            #[cfg(test)]
            allow_unencrypted_replicas: false,
        };
        let _ = coordinator.persistence.recover_on_startup();
        coordinator
    }

    #[cfg(test)]
    fn for_test(sessions: Arc<HostedSessionRuntime>, root: std::path::PathBuf) -> Self {
        let coordinator = Self {
            sessions,
            persistence: BackgroundPersistence::at(root),
            active: Mutex::new(HashMap::new()),
            live_progress: Mutex::new(HashMap::new()),
            observer: Mutex::new(None),
            concurrency: Arc::new(Semaphore::new(2)),
            shutting_down: AtomicBool::new(false),
            allow_unencrypted_replicas: true,
        };
        coordinator
            .persistence
            .recover_on_startup()
            .expect("recover background ledger");
        coordinator
    }

    pub fn list_servers(&self) -> Result<Vec<BackgroundServerRegistration>, String> {
        self.persistence.list_servers()
    }

    pub fn settings(&self) -> Result<BackgroundSettings, String> {
        self.persistence.settings()
    }

    pub fn save_settings(
        &self,
        settings: BackgroundSettings,
    ) -> Result<BackgroundSettings, String> {
        self.persistence.save_settings(settings)
    }

    pub fn replace_servers(
        &self,
        servers: Vec<BackgroundServerRegistration>,
    ) -> Result<Vec<BackgroundServerRegistration>, String> {
        let previous = self.list_servers()?;
        let normalized = servers
            .into_iter()
            .map(normalize_registration)
            .collect::<Result<Vec<_>, _>>()?;
        let saved = self.persistence.replace_servers(normalized)?;
        let retained = saved
            .iter()
            .map(|server| server.server_url.as_str())
            .collect::<HashSet<_>>();
        for removed in previous
            .iter()
            .filter(|server| !retained.contains(server.server_url.as_str()))
        {
            self.cancel_for_server(&removed.server_url);
        }
        Ok(saved)
    }

    pub fn upsert_server(
        &self,
        server: BackgroundServerRegistration,
    ) -> Result<BackgroundServerRegistration, String> {
        self.persistence
            .upsert_server(normalize_registration(server)?)
    }

    pub fn remove_server(&self, server_url: &str) -> Result<(), String> {
        let server_url = validate_server_url(server_url)?;
        self.cancel_for_server(&server_url);
        self.persistence.remove_server(&server_url)
    }

    pub fn cancel_for_replica(&self, server_url: &str, vault_id: &str) -> Result<(), String> {
        let server_url = validate_server_url(server_url)?;
        let resource_prefix = format!("server:{server_url}|profile:*|vault:{vault_id}");
        for (resource, active) in self.active.lock().iter() {
            if resource.starts_with(&resource_prefix) {
                active.cancel.store(true, Ordering::Release);
            }
        }
        Ok(())
    }

    pub fn register_profile_for_all_servers(&self, profile_id: &str) -> Result<(), String> {
        let profile_id = profile_id.trim();
        if profile_id.is_empty() || profile_id.len() > 128 {
            return Err("Background profile IDs must be between 1 and 128 characters.".to_string());
        }
        for mut server in self.list_servers()? {
            if !server.profile_ids.iter().any(|known| known == profile_id) {
                server.profile_ids.push(profile_id.to_string());
                self.persistence.upsert_server(server)?;
            }
        }
        Ok(())
    }

    pub fn list_jobs(&self, limit: usize) -> Result<Vec<BackgroundJobRecord>, String> {
        Ok(self.with_live_progress(self.persistence.list_jobs(limit)?))
    }

    pub fn job(&self, id: &str) -> Result<Option<BackgroundJobRecord>, String> {
        let Some(job) = self.persistence.job(id)? else {
            return Ok(None);
        };
        Ok(self.with_live_progress(vec![job]).pop())
    }

    pub fn aggregate(&self) -> Result<BackgroundJobAggregate, String> {
        let jobs = self.persistence.list_jobs(200)?;
        let mut aggregate = BackgroundJobAggregate::default();
        for job in jobs {
            match job.status {
                BackgroundJobStatus::Queued => aggregate.queued += 1,
                BackgroundJobStatus::Running => aggregate.running += 1,
                BackgroundJobStatus::Succeeded => aggregate.succeeded += 1,
                BackgroundJobStatus::Partial
                | BackgroundJobStatus::AuthenticationRequired
                | BackgroundJobStatus::PermissionDenied
                | BackgroundJobStatus::Conflict
                | BackgroundJobStatus::Failed => aggregate.attention_required += 1,
                BackgroundJobStatus::Deferred | BackgroundJobStatus::Cancelled => {}
            }
            if job.finished_at > aggregate.latest_finished_at {
                aggregate.latest_finished_at = job.finished_at;
            }
        }
        Ok(aggregate)
    }

    pub fn status_snapshot(&self) -> Result<BackgroundStatusSnapshot, String> {
        let jobs = self.with_live_progress(self.persistence.list_jobs(200)?);
        let mut snapshot = BackgroundStatusSnapshot {
            generated_at: Utc::now().to_rfc3339(),
            ..BackgroundStatusSnapshot::default()
        };
        for job in jobs {
            if matches!(
                job.status,
                BackgroundJobStatus::Queued | BackgroundJobStatus::Running
            ) {
                snapshot.active_jobs += 1;
                snapshot.progress.completed = snapshot
                    .progress
                    .completed
                    .saturating_add(job.progress.completed);
                snapshot.progress.total = match (
                    snapshot.active_jobs,
                    snapshot.progress.total,
                    job.progress.total,
                ) {
                    (1, _, Some(total)) => Some(total),
                    (_, Some(current), Some(total)) => Some(current.saturating_add(total)),
                    _ => None,
                };
                if snapshot.progress.detail.is_none() {
                    snapshot.progress.detail = job.progress.detail;
                }
            }
            if job.status == BackgroundJobStatus::Succeeded
                && job.finished_at > snapshot.last_successful_at
            {
                snapshot.last_successful_at = job.finished_at.clone();
            }
            if matches!(
                job.status,
                BackgroundJobStatus::Partial
                    | BackgroundJobStatus::AuthenticationRequired
                    | BackgroundJobStatus::PermissionDenied
                    | BackgroundJobStatus::Conflict
                    | BackgroundJobStatus::Failed
            ) {
                snapshot.attention_required += 1;
            }
            if let Some(next_retry_at) = job.next_retry_at {
                if snapshot
                    .next_eligible_retry_at
                    .as_ref()
                    .is_none_or(|current| next_retry_at < *current)
                {
                    snapshot.next_eligible_retry_at = Some(next_retry_at);
                }
            }
        }
        Ok(snapshot)
    }

    pub fn enqueue(
        self: &Arc<Self>,
        request: BackgroundJobRequest,
    ) -> Result<BackgroundJobRecord, String> {
        if self.shutting_down.load(Ordering::Acquire) {
            return Err("The background coordinator is shutting down.".to_string());
        }
        let request = self.validate_request(request)?;
        self.remember_calendar_profile(&request)?;
        let resource = resource_key(&request)?;
        let recent_jobs = self.persistence.list_jobs(200)?;
        if let Some(existing) = recent_jobs.iter().find(|job| {
            job.idempotency_key == request.idempotency_key
                && job.server_url == request.server_url
                && job.profile_id == request.profile_id
                && job.vault_id == request.vault_id
                && job.kind == request.kind
        }) {
            return Ok(existing.clone());
        }
        let attempt = recent_jobs
            .iter()
            .find(|job| same_resource(job, &request))
            .filter(|job| job.retryable)
            .map_or(1, |job| job.attempt.saturating_add(1).min(16));
        let mut active_jobs = self.active.lock();
        if let Some(active) = active_jobs.get(&resource) {
            return self
                .persistence
                .job(&active.id)?
                .ok_or_else(|| "The active background job record is missing.".to_string());
        }

        let id = Uuid::new_v4().to_string();
        let record = BackgroundJobRecord {
            id: id.clone(),
            idempotency_key: request.idempotency_key.clone(),
            kind: request.kind,
            server_url: request.server_url.clone(),
            profile_id: request.profile_id.clone(),
            vault_id: request.vault_id.clone(),
            trigger: request.trigger,
            attempt,
            status: BackgroundJobStatus::Queued,
            created_at: Utc::now().to_rfc3339(),
            started_at: None,
            finished_at: None,
            next_retry_at: None,
            progress: BackgroundJobProgress::default(),
            changed: None,
            summary: None,
            error_category: None,
            error_message: None,
            retryable: false,
        };
        self.persistence.insert_job(record.clone())?;
        let cancel = Arc::new(AtomicBool::new(false));
        active_jobs.insert(
            resource.clone(),
            ActiveJob {
                id: id.clone(),
                cancel: cancel.clone(),
            },
        );
        drop(active_jobs);

        let coordinator = self.clone();
        tauri::async_runtime::spawn(async move {
            coordinator.execute(id, resource, request, cancel).await;
        });
        Ok(record)
    }

    pub fn enqueue_registered(
        self: &Arc<Self>,
        trigger: BackgroundJobTrigger,
    ) -> Result<Vec<BackgroundJobRecord>, String> {
        self.enqueue_registered_for_profile(trigger, None)
    }

    pub fn enqueue_registered_notifications(
        self: &Arc<Self>,
        trigger: BackgroundJobTrigger,
        profile_filter: Option<&str>,
    ) -> Result<Vec<BackgroundJobRecord>, String> {
        let run_id = Uuid::new_v4();
        let mut jobs = Vec::new();
        for (server_index, server) in self.list_servers()?.into_iter().enumerate() {
            for profile_id in server
                .profile_ids
                .iter()
                .filter(|profile_id| profile_filter.is_none_or(|filter| *profile_id == filter))
            {
                jobs.push(self.enqueue(BackgroundJobRequest {
                    idempotency_key: format!(
                        "notification-catch-up-{run_id}-{server_index}-{profile_id}"
                    ),
                    kind: BackgroundJobKind::NotificationSync,
                    server_url: Some(server.server_url.clone()),
                    profile_id: Some(profile_id.clone()),
                    vault_id: None,
                    trigger,
                    runtime_budget_seconds: Some(60),
                })?);
            }
        }
        Ok(jobs)
    }

    pub fn enqueue_registered_for_profile(
        self: &Arc<Self>,
        trigger: BackgroundJobTrigger,
        profile_filter: Option<&str>,
    ) -> Result<Vec<BackgroundJobRecord>, String> {
        let settings = self.settings()?;
        if trigger != BackgroundJobTrigger::UserInitiated
            && (!settings.run_in_background || !settings.background_sync || settings.paused)
        {
            return Ok(Vec::new());
        }

        let registrations = self.list_servers()?;
        let replicas = ReplicaStore::list(&self.config_root()?)?;
        let run_id = Uuid::new_v4();
        let mut jobs = Vec::new();
        for (server_index, server) in registrations
            .into_iter()
            .filter(|server| server.background_sync_enabled)
            .enumerate()
        {
            for replica in replicas
                .iter()
                .filter(|replica| replica.server_url == server.server_url)
            {
                jobs.push(self.enqueue(BackgroundJobRequest {
                    idempotency_key: format!("scheduled-{run_id}-vault-{}", replica.vault_id),
                    kind: BackgroundJobKind::ReplicaSync,
                    server_url: Some(server.server_url.clone()),
                    profile_id: None,
                    vault_id: Some(replica.vault_id.clone()),
                    trigger,
                    runtime_budget_seconds: None,
                })?);
            }
            for profile_id in server
                .profile_ids
                .iter()
                .filter(|profile_id| profile_filter.is_none_or(|filter| *profile_id == filter))
            {
                jobs.push(self.enqueue(BackgroundJobRequest {
                    idempotency_key: format!(
                        "scheduled-{run_id}-{server_index}-calendar-{profile_id}"
                    ),
                    kind: BackgroundJobKind::CalendarSync,
                    server_url: Some(server.server_url.clone()),
                    profile_id: Some(profile_id.clone()),
                    vault_id: None,
                    trigger,
                    runtime_budget_seconds: None,
                })?);
                jobs.push(self.enqueue(BackgroundJobRequest {
                    idempotency_key: format!(
                        "scheduled-{run_id}-{server_index}-notifications-{profile_id}"
                    ),
                    kind: BackgroundJobKind::NotificationSync,
                    server_url: Some(server.server_url.clone()),
                    profile_id: Some(profile_id.clone()),
                    vault_id: None,
                    trigger,
                    runtime_budget_seconds: None,
                })?);
            }
        }
        Ok(jobs)
    }

    #[cfg_attr(not(target_os = "android"), allow(dead_code))]
    pub fn enqueue_push_invalidation(self: &Arc<Self>) -> Result<Vec<BackgroundJobRecord>, String> {
        let run_id = Uuid::new_v4();
        let mut jobs = Vec::new();
        for (server_index, server) in self.list_servers()?.into_iter().enumerate() {
            for profile_id in server.profile_ids {
                jobs.push(self.enqueue(BackgroundJobRequest {
                    idempotency_key: format!(
                        "push-{run_id}-{server_index}-{}",
                        profile_id.chars().take(48).collect::<String>()
                    ),
                    kind: BackgroundJobKind::NotificationSync,
                    server_url: Some(server.server_url.clone()),
                    profile_id: Some(profile_id),
                    vault_id: None,
                    trigger: BackgroundJobTrigger::PushInvalidation,
                    runtime_budget_seconds: Some(60),
                })?);
            }
        }
        Ok(jobs)
    }

    #[cfg_attr(not(target_os = "android"), allow(dead_code))]
    pub async fn run_push_invalidation_to_completion(
        self: &Arc<Self>,
        runtime_budget: Duration,
    ) -> Result<BackgroundRunOutcome, String> {
        let jobs = self.enqueue_push_invalidation()?;
        let job_ids = jobs.iter().map(|job| job.id.clone()).collect::<Vec<_>>();
        let started = std::time::Instant::now();
        loop {
            let records = job_ids
                .iter()
                .map(|id| self.job(id))
                .collect::<Result<Vec<_>, _>>()?
                .into_iter()
                .flatten()
                .collect::<Vec<_>>();
            if records.len() == job_ids.len()
                && records.iter().all(|record| record.status.is_terminal())
            {
                let mut outcome = BackgroundRunOutcome {
                    job_ids,
                    ..BackgroundRunOutcome::default()
                };
                for record in records {
                    match record.status {
                        BackgroundJobStatus::Succeeded => outcome.succeeded += 1,
                        BackgroundJobStatus::AuthenticationRequired => {
                            outcome.attention_required += 1;
                            outcome.authentication_required = true;
                        }
                        BackgroundJobStatus::PermissionDenied => {
                            outcome.attention_required += 1;
                            outcome.permission_denied = true;
                        }
                        BackgroundJobStatus::Partial
                        | BackgroundJobStatus::Conflict
                        | BackgroundJobStatus::Failed => outcome.attention_required += 1,
                        BackgroundJobStatus::Deferred
                        | BackgroundJobStatus::Cancelled
                        | BackgroundJobStatus::Queued
                        | BackgroundJobStatus::Running => {}
                    }
                    outcome.retry_recommended |= record.retryable;
                }
                return Ok(outcome);
            }
            if started.elapsed() >= runtime_budget {
                for id in &job_ids {
                    let _ = self.cancel(id);
                }
                return Err("The push invalidation execution window expired.".to_string());
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    }

    #[cfg_attr(not(target_os = "android"), allow(dead_code))]
    pub async fn run_registered_to_completion(
        self: &Arc<Self>,
        trigger: BackgroundJobTrigger,
        profile_filter: Option<&str>,
        runtime_budget: Duration,
    ) -> Result<BackgroundRunOutcome, String> {
        let jobs = self.enqueue_registered_for_profile(trigger, profile_filter)?;
        let job_ids = jobs.iter().map(|job| job.id.clone()).collect::<Vec<_>>();
        let started = std::time::Instant::now();
        loop {
            let records = job_ids
                .iter()
                .map(|id| self.job(id))
                .collect::<Result<Vec<_>, _>>()?
                .into_iter()
                .flatten()
                .collect::<Vec<_>>();
            if records.len() == job_ids.len()
                && records.iter().all(|record| record.status.is_terminal())
            {
                let mut outcome = BackgroundRunOutcome {
                    job_ids,
                    ..BackgroundRunOutcome::default()
                };
                for record in records {
                    match record.status {
                        BackgroundJobStatus::Succeeded => outcome.succeeded += 1,
                        BackgroundJobStatus::AuthenticationRequired => {
                            outcome.attention_required += 1;
                            outcome.authentication_required = true;
                        }
                        BackgroundJobStatus::PermissionDenied => {
                            outcome.attention_required += 1;
                            outcome.permission_denied = true;
                        }
                        BackgroundJobStatus::Partial
                        | BackgroundJobStatus::Conflict
                        | BackgroundJobStatus::Failed => outcome.attention_required += 1,
                        BackgroundJobStatus::Deferred
                        | BackgroundJobStatus::Cancelled
                        | BackgroundJobStatus::Queued
                        | BackgroundJobStatus::Running => {}
                    }
                    outcome.retry_recommended |= record.retryable;
                }
                return Ok(outcome);
            }
            if started.elapsed() >= runtime_budget {
                for id in &job_ids {
                    let _ = self.cancel(id);
                }
                return Err("The Android background execution window expired.".to_string());
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    }

    #[cfg_attr(mobile, allow(dead_code))]
    pub fn shutdown(&self) {
        if self.shutting_down.swap(true, Ordering::AcqRel) {
            return;
        }
        let active_ids = self
            .active
            .lock()
            .values()
            .map(|active| {
                active.cancel.store(true, Ordering::Release);
                active.id.clone()
            })
            .collect::<Vec<_>>();
        for id in active_ids {
            let _ = self.persistence.update_job(&id, |job| {
                job.status = BackgroundJobStatus::Cancelled;
                job.finished_at = Some(Utc::now().to_rfc3339());
                job.summary = Some("Application quit requested".to_string());
                job.retryable = false;
            });
        }
    }

    fn remember_calendar_profile(&self, request: &BackgroundJobRequest) -> Result<(), String> {
        if request.kind != BackgroundJobKind::CalendarSync {
            return Ok(());
        }
        let (Some(server_url), Some(profile_id)) =
            (request.server_url.as_deref(), request.profile_id.as_deref())
        else {
            return Ok(());
        };
        let Some(mut server) = self
            .list_servers()?
            .into_iter()
            .find(|server| server.server_url == server_url)
        else {
            return Ok(());
        };
        if !server.profile_ids.iter().any(|known| known == profile_id) {
            server.profile_ids.push(profile_id.to_string());
            server.profile_ids.sort();
            server.profile_ids.dedup();
            self.persistence.upsert_server(server)?;
        }
        Ok(())
    }

    pub fn cancel(&self, id: &str) -> Result<BackgroundJobRecord, String> {
        for active in self.active.lock().values() {
            if active.id == id {
                active.cancel.store(true, Ordering::Release);
                return self.persistence.update_job(id, |job| {
                    job.summary = Some("Cancellation requested".to_string());
                });
            }
        }
        let record = self
            .persistence
            .job(id)?
            .ok_or_else(|| "The background job does not exist.".to_string())?;
        if record.status.is_terminal() {
            Ok(record)
        } else {
            Err("The background job is not active in this process.".to_string())
        }
    }

    fn cancel_for_server(&self, server_url: &str) {
        let prefix = format!("server:{server_url}|");
        for (resource, active) in self.active.lock().iter() {
            if resource.starts_with(&prefix) {
                active.cancel.store(true, Ordering::Release);
            }
        }
    }

    /// Records a job's progress. Cheap by design — see
    /// [`PROGRESS_PERSIST_INTERVAL`]. The value is visible to readers
    /// immediately; only the durable copy is throttled.
    pub(crate) fn update_progress(
        &self,
        id: &str,
        progress: BackgroundJobProgress,
    ) -> Result<(), String> {
        let now = Instant::now();
        #[cfg(target_os = "android")]
        let mut publish_widgets = false;
        let persist = {
            let mut live = self.live_progress.lock();
            match live.get_mut(id) {
                Some(entry) => {
                    entry.progress = progress.clone();
                    #[cfg(target_os = "android")]
                    if now.duration_since(entry.widgets_published_at) >= WIDGET_PROGRESS_INTERVAL {
                        entry.widgets_published_at = now;
                        publish_widgets = true;
                    }
                    let due = now.duration_since(entry.persisted_at) >= PROGRESS_PERSIST_INTERVAL;
                    if due {
                        entry.persisted_at = now;
                    }
                    due
                }
                None => {
                    // The first tick persists and publishes, so a run is visible
                    // as soon as it starts rather than only once it finishes.
                    live.insert(
                        id.to_string(),
                        LiveProgress {
                            progress: progress.clone(),
                            persisted_at: now,
                            profile_id: None,
                            #[cfg(target_os = "android")]
                            widgets_published_at: now,
                        },
                    );
                    #[cfg(target_os = "android")]
                    {
                        publish_widgets = true;
                    }
                    true
                }
            }
        };
        if persist {
            self.persistence.update_job(id, |job| {
                job.progress = progress;
            })?;
            self.notify_status();
        }
        #[cfg(target_os = "android")]
        if publish_widgets {
            self.publish_widgets_for_job(id);
        }
        Ok(())
    }

    /// Hands the running app a status snapshot. Best effort: a headless process
    /// has no observer, and a failed notification must never fail a job.
    fn notify_status(&self) {
        let Some(observer) = self.observer.lock().clone() else {
            return;
        };
        if let Ok(snapshot) = self.status_snapshot() {
            observer.status_changed(&snapshot);
        }
    }

    pub(crate) fn notify_vault_synced(&self, server_url: &str, vault_id: &str, changed: u64) {
        if let Some(observer) = self.observer.lock().clone() {
            observer.vault_synced(server_url, vault_id, changed);
        }
    }

    /// Installs the running app's observer. Replacing it is intentional: the
    /// coordinator outlives any single app instance on Android.
    pub fn set_observer(&self, observer: Arc<dyn BackgroundObserver>) {
        *self.observer.lock() = Some(observer);
    }

    /// Opens a live-progress entry for a job that is about to run, so the first
    /// tick has the profile it belongs to and readers see it as active.
    fn begin_job_progress(&self, id: &str, profile_id: Option<&str>) {
        let now = Instant::now();
        self.live_progress.lock().insert(
            id.to_string(),
            LiveProgress {
                progress: BackgroundJobProgress::default(),
                // Backdated so the first real tick persists and publishes
                // immediately instead of waiting out an interval.
                persisted_at: now - PROGRESS_PERSIST_INTERVAL,
                profile_id: profile_id.map(str::to_string),
                #[cfg(target_os = "android")]
                widgets_published_at: now - WIDGET_PROGRESS_INTERVAL,
            },
        );
    }

    #[cfg(target_os = "android")]
    fn publish_widgets_for_job(&self, id: &str) {
        let profile_id = self
            .live_progress
            .lock()
            .get(id)
            .and_then(|entry| entry.profile_id.clone());
        if let Some(profile_id) = profile_id {
            let _ = crate::android_jni::request_widget_profile_rebuild(&profile_id);
        }
    }

    /// Replaces ledger progress with the live value for any job still running.
    ///
    /// Without this a reader would see progress up to
    /// [`PROGRESS_PERSIST_INTERVAL`] stale, which is exactly the "no progress"
    /// the sync widget and the status UI showed.
    fn with_live_progress(&self, mut jobs: Vec<BackgroundJobRecord>) -> Vec<BackgroundJobRecord> {
        let live = self.live_progress.lock();
        if live.is_empty() {
            return jobs;
        }
        for job in &mut jobs {
            if let Some(entry) = live.get(&job.id) {
                job.progress = entry.progress.clone();
            }
        }
        jobs
    }

    /// Drops the live entry for a job that has reached a terminal state, so its
    /// final persisted progress is what readers see from then on.
    fn forget_live_progress(&self, id: &str) {
        self.live_progress.lock().remove(id);
    }

    pub(crate) fn config_root(&self) -> Result<std::path::PathBuf, String> {
        self.persistence.root()
    }

    async fn execute(
        self: Arc<Self>,
        id: String,
        resource: String,
        request: BackgroundJobRequest,
        cancel: Arc<AtomicBool>,
    ) {
        let permit = self.concurrency.clone().acquire_owned().await;
        if permit.is_err() {
            let _ = self.finish_error(
                &id,
                BackgroundJobStatus::Failed,
                "scheduler",
                "The background scheduler is unavailable.",
                true,
            );
            self.forget_live_progress(&id);
            self.active.lock().remove(&resource);
            return;
        }
        if cancel.load(Ordering::Acquire) {
            let _ = self.finish_cancelled(&id);
            self.forget_live_progress(&id);
            self.active.lock().remove(&resource);
            return;
        }
        self.begin_job_progress(&id, request.profile_id.as_deref());
        let _ = self.persistence.update_job(&id, |job| {
            job.status = BackgroundJobStatus::Running;
            job.started_at = Some(Utc::now().to_rfc3339());
            job.summary = Some("Background job started".to_string());
        });
        self.notify_status();

        let budget = Duration::from_secs(
            request
                .runtime_budget_seconds
                .unwrap_or(DEFAULT_RUNTIME_BUDGET_SECONDS),
        );
        let result = match request.kind {
            BackgroundJobKind::ReplicaSync => {
                sync::run_replica_sync(&self, &id, &request, &cancel, budget).await
            }
            BackgroundJobKind::CalendarSync => {
                calendar_sync::run_calendar_sync(&self, &id, &request, &cancel, budget).await
            }
            BackgroundJobKind::NotificationSync => {
                notification_sync::run_notification_sync(&self, &id, &request, &cancel, budget)
                    .await
            }
            BackgroundJobKind::Maintenance => {
                sync::run_maintenance(&self, &id, &request, &cancel, budget).await
            }
        };
        match result {
            Ok(_) if cancel.load(Ordering::Acquire) => {
                let _ = self.finish_cancelled(&id);
            }
            Ok(summary) => {
                let status = if summary.failed > 0 {
                    BackgroundJobStatus::Partial
                } else {
                    BackgroundJobStatus::Succeeded
                };
                let _ = self.persistence.update_job(&id, |job| {
                    job.status = status;
                    job.finished_at = Some(Utc::now().to_rfc3339());
                    job.progress.completed = summary.completed;
                    job.progress.total = Some(summary.total);
                    job.changed = Some(summary.changed);
                    job.summary = Some(summary.message);
                    job.retryable = summary.failed > 0;
                    job.next_retry_at =
                        (summary.failed > 0).then(|| retry_at(job.attempt, &job.id));
                });
            }
            Err(_) if cancel.load(Ordering::Acquire) => {
                let _ = self.finish_cancelled(&id);
            }
            Err(error) => {
                let _ = self.finish_error(
                    &id,
                    error.status,
                    error.category,
                    &error.message,
                    error.retryable,
                );
            }
        }
        // Every branch above wrote a terminal record, so the live value has
        // served its purpose and would otherwise mask the final progress.
        self.forget_live_progress(&id);
        self.active.lock().remove(&resource);
        self.notify_status();
    }

    fn finish_cancelled(&self, id: &str) -> Result<(), String> {
        self.persistence.update_job(id, |job| {
            job.status = BackgroundJobStatus::Cancelled;
            job.finished_at = Some(Utc::now().to_rfc3339());
            job.summary = Some("Background job cancelled".to_string());
            job.retryable = false;
        })?;
        Ok(())
    }

    fn finish_error(
        &self,
        id: &str,
        status: BackgroundJobStatus,
        category: &str,
        message: &str,
        retryable: bool,
    ) -> Result<(), String> {
        let safe_message = redact_sensitive_text(message);
        self.persistence.update_job(id, |job| {
            job.status = status;
            job.finished_at = Some(Utc::now().to_rfc3339());
            job.error_category = Some(category.to_string());
            job.error_message = Some(safe_message);
            job.summary = Some("Background job did not complete".to_string());
            job.retryable = retryable;
            job.next_retry_at = retryable.then(|| retry_at(job.attempt, &job.id));
        })?;
        Ok(())
    }

    fn validate_request(
        &self,
        mut request: BackgroundJobRequest,
    ) -> Result<BackgroundJobRequest, String> {
        if request.idempotency_key.is_empty()
            || request.idempotency_key.len() > MAX_IDEMPOTENCY_KEY_LENGTH
            || !request.idempotency_key.is_ascii()
        {
            return Err("Background job idempotency keys must be short ASCII text.".to_string());
        }
        if let Some(server_url) = request.server_url.as_deref() {
            request.server_url = Some(validate_server_url(server_url)?);
        }
        if matches!(
            request.kind,
            BackgroundJobKind::ReplicaSync
                | BackgroundJobKind::CalendarSync
                | BackgroundJobKind::NotificationSync
        ) && request.server_url.is_none()
        {
            return Err("Synchronization jobs require a server URL.".to_string());
        }
        if request.kind == BackgroundJobKind::CalendarSync && request.profile_id.is_none() {
            return Err("Calendar sync jobs require a profile ID.".to_string());
        }
        if request.kind == BackgroundJobKind::NotificationSync && request.profile_id.is_none() {
            return Err("Notification sync jobs require a profile ID.".to_string());
        }
        if request.runtime_budget_seconds.unwrap_or(1) == 0
            || request
                .runtime_budget_seconds
                .unwrap_or(DEFAULT_RUNTIME_BUDGET_SECONDS)
                > MAX_RUNTIME_BUDGET_SECONDS
        {
            return Err(
                "The background runtime budget is outside the supported range.".to_string(),
            );
        }
        Ok(request)
    }

    #[cfg(test)]
    async fn wait_for_terminal(&self, id: &str) -> BackgroundJobRecord {
        for _ in 0..200 {
            if let Some(job) = self.persistence.job(id).expect("job read") {
                if job.status.is_terminal() {
                    return job;
                }
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        panic!("background job did not finish");
    }
}

fn same_resource(job: &BackgroundJobRecord, request: &BackgroundJobRequest) -> bool {
    job.kind == request.kind
        && job.server_url == request.server_url
        && job.profile_id == request.profile_id
        && job.vault_id == request.vault_id
}

fn retry_at(attempt: u32, job_id: &str) -> String {
    let exponent = attempt.saturating_sub(1).min(6);
    let base_seconds = 60_i64.saturating_mul(1_i64 << exponent);
    let jitter_ceiling = (base_seconds / 4).max(1);
    let jitter = job_id.bytes().fold(0_u64, |hash, byte| {
        hash.wrapping_mul(31).wrapping_add(byte as u64)
    }) % jitter_ceiling as u64;
    (Utc::now() + ChronoDuration::seconds(base_seconds + jitter as i64)).to_rfc3339()
}

fn redact_sensitive_text(message: &str) -> String {
    const SENSITIVE_MARKERS: [&str; 4] = ["Bearer ", "accessToken", "refreshToken", "password"];
    if SENSITIVE_MARKERS
        .iter()
        .any(|marker| message.contains(marker))
    {
        return "The background operation failed with a redacted sensitive response.".to_string();
    }
    message.chars().take(1024).collect()
}

fn normalize_registration(
    mut server: BackgroundServerRegistration,
) -> Result<BackgroundServerRegistration, String> {
    server.server_url = validate_server_url(&server.server_url)?;
    server
        .profile_ids
        .retain(|profile_id| !profile_id.trim().is_empty());
    server.profile_ids.sort();
    server.profile_ids.dedup();
    server.updated_at = Utc::now().to_rfc3339();
    Ok(server)
}

fn resource_key(request: &BackgroundJobRequest) -> Result<String, String> {
    if let Some(server_url) = request.server_url.as_deref() {
        return Ok(format!(
            "server:{server_url}|profile:{}|vault:{}|kind:{:?}",
            request.profile_id.as_deref().unwrap_or("*"),
            request.vault_id.as_deref().unwrap_or("*"),
            request.kind,
        ));
    }
    request
        .profile_id
        .as_deref()
        .map(|profile_id| format!("profile:{profile_id}|kind:{:?}", request.kind))
        .ok_or_else(|| "Background jobs require a server or profile resource.".to_string())
}

#[cfg(test)]
mod tests {
    use super::models::BackgroundJobTrigger;
    use super::*;
    use collab_protocol::{
        DataResponse, HostedFileEntry, HostedFileKind, HostedFileRevision, HostedFileState,
        HostedVault, HostedVaultManifest, HostedVaultManifestDelta, HostedVaultRole,
        HostedVaultStatus, NativeSession, ServerUser, ServerUserRole, ServerUserStatus,
    };
    use collab_replica::models::SyncStatus;
    use collab_replica::{ReplicaStore, ReplicaSyncState};
    use httpmock::Method::{GET, POST};
    use httpmock::MockServer;

    fn user() -> ServerUser {
        ServerUser {
            id: "user-1".to_string(),
            username: "alice".to_string(),
            display_name: "Alice".to_string(),
            role: ServerUserRole::Member,
            status: ServerUserStatus::Active,
            created_at: "2026-01-01T00:00:00Z".to_string(),
            last_login_at: None,
            active_sessions: 1,
            is_primary_admin: false,
            preferences: serde_json::Value::Null,
            has_avatar: false,
            avatar_updated_at: None,
        }
    }

    fn vault() -> HostedVault {
        HostedVault {
            id: "vault-1".to_string(),
            name: "Offline".to_string(),
            owner_user_id: "user-1".to_string(),
            owner_display_name: "Alice".to_string(),
            role: HostedVaultRole::Admin,
            status: HostedVaultStatus::Active,
            manifest_sequence: 2,
            members: 1,
            storage_bytes: 12,
            require_offline_copy: false,
            created_at: "2026-01-01T00:00:00Z".to_string(),
            updated_at: "2026-01-01T00:00:00Z".to_string(),
            capabilities: vec!["vault.read".to_string()],
        }
    }

    fn file() -> HostedFileEntry {
        HostedFileEntry {
            id: "file-1".to_string(),
            parent_id: None,
            name: "note.md".to_string(),
            relative_path: "note.md".to_string(),
            kind: HostedFileKind::Document,
            document_type: None,
            state: HostedFileState::Active,
            current_revision: Some(HostedFileRevision {
                id: "revision-1".to_string(),
                sequence: 1,
                content_hash: "hash".to_string(),
                size_bytes: 12,
                created_by_display_name: Some("Alice".to_string()),
                created_at: "2026-01-01T00:00:00Z".to_string(),
            }),
            trashed_by_display_name: None,
            trashed_at: None,
            created_at: "2026-01-01T00:00:00Z".to_string(),
            updated_at: "2026-01-01T00:00:00Z".to_string(),
        }
    }

    #[tokio::test]
    async fn restores_session_and_syncs_replica_without_a_webview() {
        let server = MockServer::start_async().await;
        let session = NativeSession {
            user: user(),
            access_token: "access".to_string(),
            refresh_token: "refresh".to_string(),
            access_expires_at: "2099-01-01T00:00:00Z".to_string(),
            refresh_expires_at: "2099-02-01T00:00:00Z".to_string(),
        };
        let refresh = server
            .mock_async(|when, then| {
                when.method(POST).path("/api/v1/auth/refresh");
                then.status(200)
                    .json_body_obj(&DataResponse::new(session.clone()));
            })
            .await;
        let hosted_vault = vault();
        let inventory = server
            .mock_async(|when, then| {
                when.method(GET).path("/api/v1/vaults");
                then.status(200)
                    .json_body_obj(&DataResponse::new(vec![hosted_vault.clone()]));
            })
            .await;
        let changed_file = file();
        let delta = server
            .mock_async(|when, then| {
                when.method(GET)
                    .path("/api/v1/vaults/vault-1/manifest/delta")
                    .query_param("since", "1");
                then.status(200)
                    .json_body_obj(&DataResponse::new(HostedVaultManifestDelta {
                        vault_id: "vault-1".to_string(),
                        base_sequence: 1,
                        sequence: 2,
                        changed_files: vec![changed_file.clone()],
                    }));
            })
            .await;

        let directory = tempfile::tempdir().expect("temporary directory");
        let store = ReplicaStore::open_or_create(
            directory.path(),
            &server.base_url(),
            "vault-1",
            "Offline",
            Some("admin"),
            &["vault.read".to_string()],
        )
        .expect("replica");
        store
            .write_manifest(&HostedVaultManifest {
                vault_id: "vault-1".to_string(),
                sequence: 1,
                files: Vec::new(),
            })
            .expect("manifest");
        store
            .write_sync_state(&ReplicaSyncState {
                manifest_sequence: 1,
                last_synced_at: None,
                offline_available_at: None,
                status: SyncStatus::Idle,
            })
            .expect("sync state");

        let runtime = Arc::new(HostedSessionRuntime::new());
        runtime
            .refresh_token_cache
            .write()
            .insert(server.base_url(), "refresh".to_string());
        let coordinator = Arc::new(BackgroundCoordinator::for_test(
            runtime,
            directory.path().to_path_buf(),
        ));
        coordinator
            .upsert_server(BackgroundServerRegistration {
                server_url: server.base_url(),
                allow_invalid_certificates: false,
                persist_across_reboots: false,
                background_sync_enabled: true,
                profile_ids: Vec::new(),
                updated_at: String::new(),
            })
            .expect("server registration");
        let request = BackgroundJobRequest {
            idempotency_key: "native-headless-sync".to_string(),
            kind: BackgroundJobKind::ReplicaSync,
            server_url: Some(server.base_url()),
            profile_id: None,
            vault_id: Some("vault-1".to_string()),
            trigger: BackgroundJobTrigger::Periodic,
            runtime_budget_seconds: Some(30),
        };
        let job = coordinator.enqueue(request.clone()).expect("enqueue");
        let finished = coordinator.wait_for_terminal(&job.id).await;
        let duplicate = coordinator.enqueue(request).expect("idempotent enqueue");

        assert_eq!(finished.status, BackgroundJobStatus::Succeeded);
        assert_eq!(finished.changed, Some(1));
        assert_eq!(duplicate.id, finished.id);
        let synced = store
            .read_manifest()
            .expect("read manifest")
            .expect("manifest exists");
        assert_eq!(synced.sequence, 2);
        assert_eq!(synced.files, vec![file()]);
        refresh.assert_hits_async(1).await;
        inventory.assert_hits_async(1).await;
        delta.assert_hits_async(1).await;

        let no_op_delta = server
            .mock_async(|when, then| {
                when.method(GET)
                    .path("/api/v1/vaults/vault-1/manifest/delta")
                    .query_param("since", "2");
                then.status(200)
                    .json_body_obj(&DataResponse::new(HostedVaultManifestDelta {
                        vault_id: "vault-1".to_string(),
                        base_sequence: 2,
                        sequence: 2,
                        changed_files: Vec::new(),
                    }));
            })
            .await;
        let mut invalidation = BackgroundJobRequest {
            idempotency_key: "push-invalidation-1".to_string(),
            kind: BackgroundJobKind::ReplicaSync,
            server_url: Some(server.base_url()),
            profile_id: None,
            vault_id: Some("vault-1".to_string()),
            trigger: BackgroundJobTrigger::PushInvalidation,
            runtime_budget_seconds: Some(30),
        };
        let first_invalidation = coordinator
            .enqueue(invalidation.clone())
            .expect("first invalidation");
        invalidation.idempotency_key = "push-invalidation-2".to_string();
        let coalesced_invalidation = coordinator
            .enqueue(invalidation)
            .expect("coalesced invalidation");
        let no_op = coordinator.wait_for_terminal(&first_invalidation.id).await;

        assert_eq!(coalesced_invalidation.id, first_invalidation.id);
        assert_eq!(no_op.status, BackgroundJobStatus::Succeeded);
        assert_eq!(no_op.changed, Some(0));
        assert_eq!(
            no_op.summary.as_deref(),
            Some("Offline replicas are already up to date")
        );
        no_op_delta.assert_hits_async(1).await;
    }


    /// A tick used to rewrite the whole ledger, and a tick happens once per file
    /// cached. On a large vault that was thousands of full-file writes holding a
    /// lock every UI read contends on — the stall the user saw. The live value
    /// still has to be exact, or the sync UI and widget show nothing.
    #[test]
    fn progress_ticks_stay_live_without_rewriting_the_ledger_each_time() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let coordinator = Arc::new(BackgroundCoordinator::for_test(
            Arc::new(HostedSessionRuntime::new()),
            directory.path().to_path_buf(),
        ));
        let ledger = directory.path().join("background-jobs.json");
        coordinator
            .persistence
            .insert_job(running_job("job-1", Some("profile-1")))
            .expect("insert");
        coordinator.begin_job_progress("job-1", Some("profile-1"));

        let mut persisted_writes = 0;
        let mut previous = Vec::new();
        for completed in 0..200u64 {
            coordinator
                .update_progress(
                    "job-1",
                    BackgroundJobProgress {
                        completed,
                        total: Some(200),
                        detail: Some(format!("Notes/file-{completed}.md")),
                    },
                )
                .expect("progress");
            let current = std::fs::read(&ledger).expect("ledger");
            if current != previous {
                persisted_writes += 1;
                previous = current;
            }
            // Every tick is visible immediately, whether or not it was persisted.
            let live = coordinator.job("job-1").expect("job").expect("record");
            assert_eq!(live.progress.completed, completed);
            assert_eq!(
                live.progress.detail.as_deref(),
                Some(format!("Notes/file-{completed}.md").as_str())
            );
        }

        // The whole burst runs well inside one persist interval, so it costs a
        // single write instead of 200.
        assert_eq!(persisted_writes, 1);

        // The status rollup readers use is live too, not just the record.
        let snapshot = coordinator.status_snapshot().expect("snapshot");
        assert_eq!(snapshot.active_jobs, 1);
        assert_eq!(snapshot.progress.completed, 199);
        assert_eq!(snapshot.progress.total, Some(200));

        // Once the job is done the durable record is authoritative again, so a
        // stale live value can never outlive the run that produced it.
        coordinator
            .persistence
            .update_job("job-1", |job| {
                job.status = BackgroundJobStatus::Succeeded;
                job.progress.completed = 200;
                job.finished_at = Some(Utc::now().to_rfc3339());
            })
            .expect("finish");
        coordinator.forget_live_progress("job-1");
        let finished = coordinator.job("job-1").expect("job").expect("record");
        assert_eq!(finished.progress.completed, 200);
        assert_eq!(coordinator.status_snapshot().expect("snapshot").active_jobs, 0);
    }

    /// The observer is how the app learns anything happened. Without it a sync
    /// could land new content under an open vault and nothing would reload it.
    #[test]
    fn the_app_observer_is_told_about_progress_and_new_vault_content() {
        #[derive(Default)]
        struct Recorder {
            statuses: Mutex<Vec<u64>>,
            vaults: Mutex<Vec<(String, String, u64)>>,
        }
        impl BackgroundObserver for Recorder {
            fn status_changed(&self, snapshot: &BackgroundStatusSnapshot) {
                self.statuses.lock().push(snapshot.progress.completed);
            }
            fn vault_synced(&self, server_url: &str, vault_id: &str, changed: u64) {
                self.vaults
                    .lock()
                    .push((server_url.to_string(), vault_id.to_string(), changed));
            }
        }

        let directory = tempfile::tempdir().expect("temporary directory");
        let coordinator = Arc::new(BackgroundCoordinator::for_test(
            Arc::new(HostedSessionRuntime::new()),
            directory.path().to_path_buf(),
        ));
        let recorder = Arc::new(Recorder::default());
        coordinator.set_observer(recorder.clone());
        coordinator
            .persistence
            .insert_job(running_job("job-1", Some("profile-1")))
            .expect("insert");

        coordinator
            .update_progress(
                "job-1",
                BackgroundJobProgress {
                    completed: 7,
                    total: Some(9),
                    detail: None,
                },
            )
            .expect("progress");
        coordinator.notify_vault_synced("https://collab.example", "vault-1", 3);

        assert_eq!(*recorder.statuses.lock(), vec![7]);
        assert_eq!(
            *recorder.vaults.lock(),
            vec![("https://collab.example".to_string(), "vault-1".to_string(), 3)]
        );
    }

    fn running_job(id: &str, profile_id: Option<&str>) -> BackgroundJobRecord {
        BackgroundJobRecord {
            id: id.to_string(),
            idempotency_key: id.to_string(),
            kind: BackgroundJobKind::ReplicaSync,
            server_url: Some("https://collab.example".to_string()),
            profile_id: profile_id.map(str::to_string),
            vault_id: None,
            trigger: BackgroundJobTrigger::Foreground,
            attempt: 1,
            status: BackgroundJobStatus::Running,
            created_at: Utc::now().to_rfc3339(),
            started_at: Some(Utc::now().to_rfc3339()),
            finished_at: None,
            next_retry_at: None,
            progress: BackgroundJobProgress::default(),
            changed: None,
            summary: None,
            error_category: None,
            error_message: None,
            retryable: false,
        }
    }

    #[test]
    fn persisted_running_jobs_recover_as_deferred() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let persistence = persistence::BackgroundPersistence::at(directory.path().to_path_buf());
        let mut record = BackgroundJobRecord {
            id: "job-1".to_string(),
            idempotency_key: "recovery".to_string(),
            kind: BackgroundJobKind::Maintenance,
            server_url: Some("https://example.com".to_string()),
            profile_id: None,
            vault_id: None,
            trigger: BackgroundJobTrigger::Periodic,
            attempt: 1,
            status: BackgroundJobStatus::Running,
            created_at: Utc::now().to_rfc3339(),
            started_at: Some(Utc::now().to_rfc3339()),
            finished_at: None,
            next_retry_at: None,
            progress: BackgroundJobProgress::default(),
            changed: None,
            summary: None,
            error_category: None,
            error_message: None,
            retryable: false,
        };
        persistence.insert_job(record.clone()).expect("insert");
        persistence.recover_on_startup().expect("recover");
        record = persistence.list_jobs(10).expect("list").remove(0);
        assert_eq!(record.status, BackgroundJobStatus::Deferred);
        assert_eq!(record.error_category.as_deref(), Some("interrupted"));
        assert!(record.retryable);
        assert!(record.next_retry_at.is_some());
    }

    #[test]
    fn settings_and_learned_calendar_profiles_survive_registry_refresh() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let persistence = persistence::BackgroundPersistence::at(directory.path().to_path_buf());
        let mut settings = BackgroundSettings::default();
        settings.run_in_background = true;
        settings.start_at_login = true;
        settings.sync_interval = BackgroundSyncInterval::ThirtyMinutes;
        persistence
            .save_settings(settings.clone())
            .expect("save settings");
        assert_eq!(persistence.settings().expect("read settings"), settings);

        let registration = BackgroundServerRegistration {
            server_url: "https://collab.example.test".to_string(),
            allow_invalid_certificates: false,
            persist_across_reboots: true,
            background_sync_enabled: true,
            profile_ids: vec!["user-1".to_string()],
            updated_at: Utc::now().to_rfc3339(),
        };
        persistence
            .upsert_server(registration.clone())
            .expect("initial registration");
        let mut refreshed = registration;
        refreshed.profile_ids.clear();
        let registrations = persistence
            .replace_servers(vec![refreshed])
            .expect("replace registry");
        assert_eq!(registrations[0].profile_ids, vec!["user-1"]);
    }

    #[test]
    fn retry_schedule_is_capped_and_sensitive_errors_are_redacted() {
        let first =
            chrono::DateTime::parse_from_rfc3339(&retry_at(1, "job-a")).expect("first retry");
        let later =
            chrono::DateTime::parse_from_rfc3339(&retry_at(5, "job-a")).expect("later retry");
        let capped =
            chrono::DateTime::parse_from_rfc3339(&retry_at(99, "job-a")).expect("capped retry");
        let now = Utc::now();

        assert!(first > now);
        assert!(later > first);
        assert!(capped.with_timezone(&Utc) - now < ChronoDuration::minutes(81));
        assert_eq!(
            redact_sensitive_text("request failed: Bearer secret-token"),
            "The background operation failed with a redacted sensitive response."
        );
        assert_eq!(
            redact_sensitive_text("network unavailable"),
            "network unavailable"
        );
    }

    #[test]
    fn server_and_replica_removal_cancel_only_matching_resources() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let coordinator = BackgroundCoordinator::for_test(
            Arc::new(HostedSessionRuntime::new()),
            directory.path().to_path_buf(),
        );
        let server_a = "https://a.example.test";
        let server_b = "https://b.example.test";
        for server_url in [server_a, server_b] {
            coordinator
                .upsert_server(BackgroundServerRegistration {
                    server_url: server_url.to_string(),
                    allow_invalid_certificates: false,
                    persist_across_reboots: true,
                    background_sync_enabled: true,
                    profile_ids: Vec::new(),
                    updated_at: String::new(),
                })
                .expect("server registration");
        }

        let cancel_a = Arc::new(AtomicBool::new(false));
        let cancel_b = Arc::new(AtomicBool::new(false));
        coordinator.active.lock().insert(
            format!("server:{server_a}|profile:*|vault:vault-a"),
            ActiveJob {
                id: "job-a".to_string(),
                cancel: cancel_a.clone(),
            },
        );
        coordinator.active.lock().insert(
            format!("server:{server_b}|profile:*|vault:vault-b"),
            ActiveJob {
                id: "job-b".to_string(),
                cancel: cancel_b.clone(),
            },
        );

        coordinator
            .replace_servers(vec![BackgroundServerRegistration {
                server_url: server_b.to_string(),
                allow_invalid_certificates: false,
                persist_across_reboots: true,
                background_sync_enabled: true,
                profile_ids: Vec::new(),
                updated_at: String::new(),
            }])
            .expect("replace server registry");
        assert!(cancel_a.load(Ordering::Acquire));
        assert!(!cancel_b.load(Ordering::Acquire));

        coordinator
            .cancel_for_replica(server_b, "vault-b")
            .expect("cancel replica");
        assert!(cancel_b.load(Ordering::Acquire));
    }

    #[tokio::test]
    async fn android_run_filters_calendar_work_to_the_requested_profile() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let coordinator = Arc::new(BackgroundCoordinator::for_test(
            Arc::new(HostedSessionRuntime::new()),
            directory.path().to_path_buf(),
        ));
        coordinator
            .upsert_server(BackgroundServerRegistration {
                server_url: "https://collab.example.test".to_string(),
                allow_invalid_certificates: false,
                persist_across_reboots: true,
                background_sync_enabled: true,
                profile_ids: vec!["profile-a".to_string(), "profile-b".to_string()],
                updated_at: Utc::now().to_rfc3339(),
            })
            .expect("server registration");

        let outcome = coordinator
            .run_registered_to_completion(
                BackgroundJobTrigger::UserInitiated,
                Some("profile-b"),
                Duration::from_secs(5),
            )
            .await
            .expect("bounded run");

        assert_eq!(outcome.job_ids.len(), 2);
        assert!(outcome.authentication_required);
        let records = outcome
            .job_ids
            .iter()
            .map(|job_id| {
                coordinator
                    .job(job_id)
                    .expect("job lookup")
                    .expect("job record")
            })
            .collect::<Vec<_>>();
        assert!(records
            .iter()
            .all(|record| record.profile_id.as_deref() == Some("profile-b")));
        assert!(records
            .iter()
            .any(|record| record.kind == BackgroundJobKind::CalendarSync));
        assert!(records
            .iter()
            .any(|record| record.kind == BackgroundJobKind::NotificationSync));
    }

    #[tokio::test]
    async fn notification_catch_up_targets_only_the_visible_profile() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let coordinator = Arc::new(BackgroundCoordinator::for_test(
            Arc::new(HostedSessionRuntime::new()),
            directory.path().to_path_buf(),
        ));
        coordinator
            .upsert_server(BackgroundServerRegistration {
                server_url: "https://collab.example.test".to_string(),
                allow_invalid_certificates: false,
                persist_across_reboots: true,
                background_sync_enabled: false,
                profile_ids: vec!["server-user".to_string(), "visible-profile".to_string()],
                updated_at: Utc::now().to_rfc3339(),
            })
            .expect("server registration");

        let jobs = coordinator
            .enqueue_registered_notifications(
                BackgroundJobTrigger::Foreground,
                Some("visible-profile"),
            )
            .expect("notification catch-up");

        assert_eq!(jobs.len(), 1);
        assert_eq!(jobs[0].kind, BackgroundJobKind::NotificationSync);
        assert_eq!(jobs[0].profile_id.as_deref(), Some("visible-profile"));
        assert_eq!(
            jobs[0].server_url.as_deref(),
            Some("https://collab.example.test")
        );
        coordinator.shutdown();
    }
}
