mod calendar_sync;
mod models;
mod persistence;
mod sync;

pub use models::{
    BackgroundJobAggregate, BackgroundJobKind, BackgroundJobProgress, BackgroundJobRecord,
    BackgroundJobRequest, BackgroundJobStatus, BackgroundServerRegistration,
};

use crate::hosted_client::validate_server_url;
use crate::state::HostedSessionRuntime;
use chrono::{Duration as ChronoDuration, Utc};
use parking_lot::Mutex;
use persistence::BackgroundPersistence;
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::Semaphore;
use uuid::Uuid;

const DEFAULT_RUNTIME_BUDGET_SECONDS: u64 = 120;
const MAX_RUNTIME_BUDGET_SECONDS: u64 = 600;
const MAX_IDEMPOTENCY_KEY_LENGTH: usize = 128;

struct ActiveJob {
    id: String,
    cancel: Arc<AtomicBool>,
}

pub struct BackgroundCoordinator {
    pub(crate) sessions: Arc<HostedSessionRuntime>,
    persistence: BackgroundPersistence,
    active: Mutex<HashMap<String, ActiveJob>>,
    concurrency: Arc<Semaphore>,
    #[cfg(test)]
    allow_unencrypted_replicas: bool,
}

impl BackgroundCoordinator {
    pub fn new(sessions: Arc<HostedSessionRuntime>) -> Self {
        let coordinator = Self {
            sessions,
            persistence: BackgroundPersistence::new(),
            active: Mutex::new(HashMap::new()),
            concurrency: Arc::new(Semaphore::new(2)),
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
            concurrency: Arc::new(Semaphore::new(2)),
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

    pub fn replace_servers(
        &self,
        servers: Vec<BackgroundServerRegistration>,
    ) -> Result<Vec<BackgroundServerRegistration>, String> {
        let normalized = servers
            .into_iter()
            .map(normalize_registration)
            .collect::<Result<Vec<_>, _>>()?;
        self.persistence.replace_servers(normalized)
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

    pub fn list_jobs(&self, limit: usize) -> Result<Vec<BackgroundJobRecord>, String> {
        self.persistence.list_jobs(limit)
    }

    pub fn job(&self, id: &str) -> Result<Option<BackgroundJobRecord>, String> {
        self.persistence.job(id)
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

    pub fn enqueue(
        self: &Arc<Self>,
        request: BackgroundJobRequest,
    ) -> Result<BackgroundJobRecord, String> {
        let request = self.validate_request(request)?;
        let resource = resource_key(&request)?;
        if let Some(existing) = self.persistence.list_jobs(200)?.into_iter().find(|job| {
            job.idempotency_key == request.idempotency_key
                && job.server_url == request.server_url
                && job.profile_id == request.profile_id
                && job.vault_id == request.vault_id
                && job.kind == request.kind
        }) {
            return Ok(existing);
        }
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
            status: BackgroundJobStatus::Queued,
            created_at: Utc::now().to_rfc3339(),
            started_at: None,
            finished_at: None,
            next_retry_at: None,
            progress: BackgroundJobProgress::default(),
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

    pub(crate) fn update_progress(
        &self,
        id: &str,
        progress: BackgroundJobProgress,
    ) -> Result<(), String> {
        self.persistence.update_job(id, |job| {
            job.progress = progress;
        })?;
        Ok(())
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
            self.active.lock().remove(&resource);
            return;
        }
        if cancel.load(Ordering::Acquire) {
            let _ = self.finish_cancelled(&id);
            self.active.lock().remove(&resource);
            return;
        }
        let _ = self.persistence.update_job(&id, |job| {
            job.status = BackgroundJobStatus::Running;
            job.started_at = Some(Utc::now().to_rfc3339());
            job.summary = Some("Background job started".to_string());
        });

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
                    job.summary = Some(summary.message);
                    job.retryable = summary.failed > 0;
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
        self.active.lock().remove(&resource);
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
        self.persistence.update_job(id, |job| {
            job.status = status;
            job.finished_at = Some(Utc::now().to_rfc3339());
            job.error_category = Some(category.to_string());
            job.error_message = Some(message.to_string());
            job.summary = Some("Background job did not complete".to_string());
            job.retryable = retryable;
            job.next_retry_at =
                retryable.then(|| (Utc::now() + ChronoDuration::minutes(1)).to_rfc3339());
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
            BackgroundJobKind::ReplicaSync | BackgroundJobKind::CalendarSync
        ) && request.server_url.is_none()
        {
            return Err("Synchronization jobs require a server URL.".to_string());
        }
        if request.kind == BackgroundJobKind::CalendarSync && request.profile_id.is_none() {
            return Err("Calendar sync jobs require a profile ID.".to_string());
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

fn normalize_registration(
    mut server: BackgroundServerRegistration,
) -> Result<BackgroundServerRegistration, String> {
    server.server_url = validate_server_url(&server.server_url)?;
    server.updated_at = Utc::now().to_rfc3339();
    Ok(server)
}

fn resource_key(request: &BackgroundJobRequest) -> Result<String, String> {
    if let Some(server_url) = request.server_url.as_deref() {
        return Ok(format!(
            "server:{server_url}|profile:{}|vault:{}",
            request.profile_id.as_deref().unwrap_or("*"),
            request.vault_id.as_deref().unwrap_or("*"),
        ));
    }
    request
        .profile_id
        .as_deref()
        .map(|profile_id| format!("profile:{profile_id}"))
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
            status: BackgroundJobStatus::Running,
            created_at: Utc::now().to_rfc3339(),
            started_at: Some(Utc::now().to_rfc3339()),
            finished_at: None,
            next_retry_at: None,
            progress: BackgroundJobProgress::default(),
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
    }
}
