use super::{
    BackgroundCoordinator, BackgroundJobProgress, BackgroundJobRequest, BackgroundJobStatus,
};
use crate::hosted_client::{decode_hosted_error, server_client, server_request_error};
use crate::hosted_session::refresh_session_locked;
use crate::state::ServerSessionState;
use base64::Engine as _;
use chrono::Utc;
use collab_protocol::{
    DataResponse, HostedFileEntry, HostedFileKind, HostedFileState, HostedTextDocument,
    HostedVault, HostedVaultManifest, HostedVaultManifestDelta, HostedVaultRole, HostedVaultStatus,
};
use collab_replica::models::{PendingOpKind, PendingOpStatus, SyncStatus};
use collab_replica::{PendingOperation, ReplicaStore, ReplicaSyncState};
use reqwest::{Method, StatusCode};
use serde::de::DeserializeOwned;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

const REPLICA_CACHE_BUDGET_BYTES: u64 = 512 * 1024 * 1024;
const MAX_BACKGROUND_ASSET_BYTES: u64 = 512 * 1024 * 1024;

pub(super) struct JobExecutionSummary {
    pub completed: u64,
    pub total: u64,
    pub failed: u64,
    pub message: String,
}

pub(super) struct JobExecutionError {
    pub status: BackgroundJobStatus,
    pub category: &'static str,
    pub message: String,
    pub retryable: bool,
}

impl JobExecutionError {
    pub(super) fn persistence(message: impl Into<String>) -> Self {
        Self {
            status: BackgroundJobStatus::Failed,
            category: "persistence",
            message: message.into(),
            retryable: false,
        }
    }

    pub(super) fn interrupted(message: impl Into<String>) -> Self {
        Self {
            status: BackgroundJobStatus::Deferred,
            category: "runtime_budget",
            message: message.into(),
            retryable: true,
        }
    }
}

pub(crate) async fn run_replica_sync(
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
        .ok_or_else(|| JobExecutionError::persistence("Replica sync requires a server URL."))?;
    let registration = coordinator
        .list_servers()
        .map_err(JobExecutionError::persistence)?
        .into_iter()
        .find(|entry| entry.server_url == server_url)
        .ok_or_else(|| JobExecutionError {
            status: BackgroundJobStatus::Deferred,
            category: "server_registry",
            message: "The server is not registered for native background work.".to_string(),
            retryable: false,
        })?;
    if !registration.background_sync_enabled {
        return Err(JobExecutionError {
            status: BackgroundJobStatus::Deferred,
            category: "disabled",
            message: "Background synchronization is disabled for this server.".to_string(),
            retryable: false,
        });
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
    let hosted_vaults: Vec<HostedVault> =
        request_json(&session, Method::GET, "/api/v1/vaults", None).await?;
    let config_root = coordinator
        .config_root()
        .map_err(JobExecutionError::persistence)?;
    let summaries = ReplicaStore::list(&config_root).map_err(JobExecutionError::persistence)?;
    let mut targets = summaries
        .into_iter()
        .filter(|replica| replica.server_url == server_url)
        .filter(|replica| {
            request
                .vault_id
                .as_deref()
                .is_none_or(|vault_id| replica.vault_id == vault_id)
        })
        .collect::<Vec<_>>();
    targets.sort_by(|left, right| left.vault_name.cmp(&right.vault_name));

    coordinator
        .update_progress(
            job_id,
            BackgroundJobProgress {
                completed: 0,
                total: Some(targets.len() as u64),
                detail: Some("Checking offline replicas".to_string()),
            },
        )
        .map_err(JobExecutionError::persistence)?;

    let total = targets.len() as u64;
    let mut completed = 0;
    let mut failed = 0;
    for target in targets {
        ensure_running(cancel, started, budget)?;
        let Some(vault) = hosted_vaults
            .iter()
            .find(|vault| vault.id == target.vault_id)
        else {
            failed += 1;
            completed += 1;
            continue;
        };
        if vault.status != HostedVaultStatus::Active {
            failed += 1;
            completed += 1;
            continue;
        }
        coordinator
            .update_progress(
                job_id,
                BackgroundJobProgress {
                    completed,
                    total: Some(total),
                    detail: Some(target.vault_name.clone()),
                },
            )
            .map_err(JobExecutionError::persistence)?;

        update_replica_metadata(&config_root, vault, server_url)?;
        let store = open_replica(coordinator, &config_root, server_url, &vault.id)?;
        let mut state = store
            .read_sync_state()
            .map_err(JobExecutionError::persistence)?;
        state.status = SyncStatus::Syncing;
        store
            .write_sync_state(&state)
            .map_err(JobExecutionError::persistence)?;

        match sync_replica(
            coordinator,
            job_id,
            &session,
            vault,
            &store,
            cancel,
            started,
            budget,
        )
        .await
        {
            Ok(()) => {}
            Err(error)
                if matches!(
                    error.status,
                    BackgroundJobStatus::AuthenticationRequired | BackgroundJobStatus::Deferred
                ) =>
            {
                let _ = mark_replica_error(&store, true);
                return Err(error);
            }
            Err(_) => {
                failed += 1;
                let _ = mark_replica_error(&store, false);
            }
        }
        completed += 1;
        coordinator
            .update_progress(
                job_id,
                BackgroundJobProgress {
                    completed,
                    total: Some(total),
                    detail: Some(target.vault_name),
                },
            )
            .map_err(JobExecutionError::persistence)?;
    }

    Ok(JobExecutionSummary {
        completed,
        total,
        failed,
        message: if failed == 0 {
            format!("Synchronized {completed} offline replica(s)")
        } else {
            format!(
                "Synchronized {} replica(s); {failed} require attention",
                completed - failed
            )
        },
    })
}

pub(crate) async fn run_maintenance(
    coordinator: &BackgroundCoordinator,
    job_id: &str,
    request: &BackgroundJobRequest,
    cancel: &AtomicBool,
    budget: Duration,
) -> Result<JobExecutionSummary, JobExecutionError> {
    let started = Instant::now();
    let config_root = coordinator
        .config_root()
        .map_err(JobExecutionError::persistence)?;
    let mut replicas = ReplicaStore::list(&config_root).map_err(JobExecutionError::persistence)?;
    replicas.retain(|replica| {
        request
            .server_url
            .as_deref()
            .is_none_or(|server_url| replica.server_url == server_url)
            && request
                .vault_id
                .as_deref()
                .is_none_or(|vault_id| replica.vault_id == vault_id)
    });
    let total = replicas.len() as u64;
    let mut completed = 0;
    let mut failed = 0;
    for replica in replicas {
        ensure_running(cancel, started, budget)?;
        coordinator
            .update_progress(
                job_id,
                BackgroundJobProgress {
                    completed,
                    total: Some(total),
                    detail: Some(replica.vault_name.clone()),
                },
            )
            .map_err(JobExecutionError::persistence)?;
        match open_replica(
            coordinator,
            &config_root,
            &replica.server_url,
            &replica.vault_id,
        )
        .and_then(|store| {
            store
                .cleanup(REPLICA_CACHE_BUDGET_BYTES)
                .map(|_| ())
                .map_err(JobExecutionError::persistence)
        }) {
            Ok(()) => {}
            Err(_) => failed += 1,
        }
        completed += 1;
    }
    Ok(JobExecutionSummary {
        completed,
        total,
        failed,
        message: format!("Maintained {completed} offline replica(s)"),
    })
}

async fn sync_replica(
    coordinator: &BackgroundCoordinator,
    job_id: &str,
    session: &ServerSessionState,
    vault: &HostedVault,
    store: &ReplicaStore,
    cancel: &AtomicBool,
    started: Instant,
    budget: Duration,
) -> Result<(), JobExecutionError> {
    replay_pending_operations(
        coordinator,
        job_id,
        session,
        vault,
        store,
        cancel,
        started,
        budget,
    )
    .await?;
    ensure_running(cancel, started, budget)?;

    let cached = store
        .read_manifest()
        .map_err(JobExecutionError::persistence)?;
    let old_state = store
        .read_sync_state()
        .map_err(JobExecutionError::persistence)?;
    let maintain_offline_copy = old_state.offline_available_at.is_some()
        && vault
            .capabilities
            .iter()
            .any(|capability| capability == "vault.offlineCopy");

    let (manifest, changed_files) = if let Some(cached) =
        cached.filter(|manifest| old_state.manifest_sequence <= manifest.sequence)
    {
        let path = format!(
            "/api/v1/vaults/{}/manifest/delta?since={}",
            vault.id, old_state.manifest_sequence
        );
        let delta: HostedVaultManifestDelta =
            request_json(session, Method::GET, &path, None).await?;
        if delta.base_sequence == old_state.manifest_sequence && delta.sequence >= cached.sequence {
            let mut files = cached
                .files
                .into_iter()
                .map(|file| (file.id.clone(), file))
                .collect::<HashMap<_, _>>();
            for file in &delta.changed_files {
                files.insert(file.id.clone(), file.clone());
            }
            (
                HostedVaultManifest {
                    vault_id: delta.vault_id,
                    sequence: delta.sequence,
                    files: files.into_values().collect(),
                },
                delta.changed_files,
            )
        } else {
            fetch_manifest(session, &vault.id).await?
        }
    } else {
        fetch_manifest(session, &vault.id).await?
    };

    store
        .write_manifest(&manifest)
        .map_err(JobExecutionError::persistence)?;
    if maintain_offline_copy {
        cache_changed_files(
            coordinator,
            job_id,
            session,
            vault,
            store,
            &changed_files,
            cancel,
            started,
            budget,
        )
        .await?;
        store
            .cleanup(REPLICA_CACHE_BUDGET_BYTES)
            .map_err(JobExecutionError::persistence)?;
    }
    store
        .write_sync_state(&ReplicaSyncState {
            manifest_sequence: manifest.sequence,
            last_synced_at: Some(Utc::now().to_rfc3339()),
            offline_available_at: maintain_offline_copy
                .then(|| Utc::now().to_rfc3339())
                .or(old_state.offline_available_at),
            status: SyncStatus::Idle,
        })
        .map_err(JobExecutionError::persistence)
}

async fn fetch_manifest(
    session: &ServerSessionState,
    vault_id: &str,
) -> Result<(HostedVaultManifest, Vec<HostedFileEntry>), JobExecutionError> {
    let path = format!("/api/v1/vaults/{vault_id}/manifest");
    let manifest: HostedVaultManifest = request_json(session, Method::GET, &path, None).await?;
    let changed = manifest.files.clone();
    Ok((manifest, changed))
}

#[allow(clippy::too_many_arguments)]
async fn replay_pending_operations(
    coordinator: &BackgroundCoordinator,
    job_id: &str,
    session: &ServerSessionState,
    vault: &HostedVault,
    store: &ReplicaStore,
    cancel: &AtomicBool,
    started: Instant,
    budget: Duration,
) -> Result<(), JobExecutionError> {
    let operations = store
        .list_pending_operations()
        .map_err(JobExecutionError::persistence)?;
    let replayable = operations
        .into_iter()
        .filter(|operation| operation.status != PendingOpStatus::Failed)
        .collect::<Vec<_>>();
    let mut id_map = HashMap::new();
    for operation in &replayable {
        if operation.status == PendingOpStatus::InFlight {
            store
                .update_operation_status(&operation.id, PendingOpStatus::Pending)
                .map_err(JobExecutionError::persistence)?;
        }
    }
    for (index, operation) in replayable.iter().enumerate() {
        ensure_running(cancel, started, budget)?;
        coordinator
            .update_progress(
                job_id,
                BackgroundJobProgress {
                    completed: index as u64,
                    total: Some(replayable.len() as u64),
                    detail: Some(
                        operation
                            .relative_path
                            .clone()
                            .or_else(|| operation.file_id.clone())
                            .unwrap_or_else(|| "Uploading queued change".to_string()),
                    ),
                },
            )
            .map_err(JobExecutionError::persistence)?;
        store
            .update_operation_status(&operation.id, PendingOpStatus::InFlight)
            .map_err(JobExecutionError::persistence)?;
        match replay_operation(session, vault, store, operation, &mut id_map).await {
            Ok(()) => store
                .remove_operation(&operation.id)
                .map_err(JobExecutionError::persistence)?,
            Err(error) if error.retryable => {
                let _ = store.update_operation_status(&operation.id, PendingOpStatus::Pending);
                return Err(error);
            }
            Err(error) => {
                let code = pending_failure_code(&error);
                store
                    .record_operation_failure(&operation.id, code, &error.message)
                    .map_err(JobExecutionError::persistence)?;
                return Err(error);
            }
        }
    }
    Ok(())
}

async fn replay_operation(
    session: &ServerSessionState,
    vault: &HostedVault,
    store: &ReplicaStore,
    operation: &PendingOperation,
    id_map: &mut HashMap<String, String>,
) -> Result<(), JobExecutionError> {
    let mut payload = replace_mapped_ids(operation.payload.clone(), id_map);
    match operation.kind {
        PendingOpKind::Create => {
            let temp_id = payload
                .get("tempFileId")
                .and_then(Value::as_str)
                .map(str::to_string);
            if let Some(object) = payload.as_object_mut() {
                object.remove("tempFileId");
            }
            let path = format!("/api/v1/vaults/{}/files", vault.id);
            let created: Value = request_json(session, Method::POST, &path, Some(payload)).await?;
            if let Some(created_id) = created.get("id").and_then(Value::as_str) {
                if let Some(file_id) = operation.file_id.as_deref() {
                    id_map.insert(file_id.to_string(), created_id.to_string());
                }
                if let Some(temp_id) = temp_id {
                    id_map.insert(temp_id, created_id.to_string());
                }
            }
        }
        PendingOpKind::Edit => {
            let target = required_string(&payload, "targetFileId")?;
            let path = format!("/api/v1/vaults/{}/files/{target}/revisions", vault.id);
            let body = json!({
                "expectedRevisionSequence": payload.get("expectedRevisionSequence"),
                "content": payload.get("content"),
            });
            let _: Value = request_json(session, Method::POST, &path, Some(body)).await?;
        }
        PendingOpKind::AssetUpload => {
            let cache_id = required_string(&payload, "assetCacheId")?;
            let bytes = store
                .read_cached_asset(&cache_id)
                .map_err(JobExecutionError::persistence)?
                .ok_or_else(|| {
                    JobExecutionError::persistence(
                        "Cached upload bytes are unavailable for a pending asset upload.",
                    )
                })?;
            let body = json!({
                "parentId": payload.get("parentId").cloned().unwrap_or(Value::Null),
                "name": payload.get("name"),
                "mediaType": payload.get("mediaType"),
                "contentBase64": base64::engine::general_purpose::STANDARD.encode(bytes),
                "expectedHash": payload.get("expectedHash"),
            });
            let path = format!("/api/v1/vaults/{}/uploads", vault.id);
            let _: Value = request_json(session, Method::POST, &path, Some(body)).await?;
        }
        PendingOpKind::LogicComponentSave => {
            let component = payload.get("component").cloned().unwrap_or(payload);
            let path = format!("/api/v1/vaults/{}/logic-components", vault.id);
            let saved: Value = request_json(session, Method::POST, &path, Some(component)).await?;
            let mut components = store
                .read_logic_components()
                .map_err(JobExecutionError::persistence)?;
            let saved_id = saved.get("id").and_then(Value::as_str);
            let saved_name = saved
                .get("name")
                .and_then(Value::as_str)
                .map(str::to_lowercase);
            components.retain(|component| {
                component.get("id").and_then(Value::as_str) != saved_id
                    && component
                        .get("name")
                        .and_then(Value::as_str)
                        .map(str::to_lowercase)
                        != saved_name
            });
            components.push(saved);
            components.sort_by_key(|component| {
                component
                    .get("name")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_lowercase()
            });
            store
                .write_logic_components(&components)
                .map_err(JobExecutionError::persistence)?;
        }
        PendingOpKind::LogicComponentDelete => {
            let component_id = required_string(&payload, "componentId")?;
            let path = format!(
                "/api/v1/vaults/{}/logic-components/{}",
                vault.id, component_id
            );
            let _: Value = request_json(session, Method::DELETE, &path, None).await?;
        }
        _ => {
            let path = format!("/api/v1/vaults/{}/operations", vault.id);
            let _: Value = request_json(session, Method::POST, &path, Some(payload)).await?;
        }
    }
    Ok(())
}

#[allow(clippy::too_many_arguments)]
async fn cache_changed_files(
    coordinator: &BackgroundCoordinator,
    job_id: &str,
    session: &ServerSessionState,
    vault: &HostedVault,
    store: &ReplicaStore,
    files: &[HostedFileEntry],
    cancel: &AtomicBool,
    started: Instant,
    budget: Duration,
) -> Result<(), JobExecutionError> {
    let cacheable = files
        .iter()
        .filter(|file| {
            file.state == HostedFileState::Active
                && matches!(file.kind, HostedFileKind::Document | HostedFileKind::Asset)
        })
        .collect::<Vec<_>>();
    for (index, file) in cacheable.iter().enumerate() {
        ensure_running(cancel, started, budget)?;
        coordinator
            .update_progress(
                job_id,
                BackgroundJobProgress {
                    completed: index as u64,
                    total: Some(cacheable.len() as u64),
                    detail: Some(file.relative_path.clone()),
                },
            )
            .map_err(JobExecutionError::persistence)?;
        let expected_hash = file
            .current_revision
            .as_ref()
            .map(|revision| revision.content_hash.as_str());
        let kind = match file.kind {
            HostedFileKind::Document => "document",
            HostedFileKind::Asset => "asset",
            HostedFileKind::Folder => continue,
        };
        let status = store
            .cached_content_status(&file.id, kind, expected_hash)
            .map_err(JobExecutionError::persistence)?;
        if status.present && status.matches_expected_hash {
            continue;
        }
        if file.kind == HostedFileKind::Document {
            let path = format!("/api/v1/vaults/{}/files/{}", vault.id, file.id);
            let document: HostedTextDocument =
                request_json(session, Method::GET, &path, None).await?;
            store
                .cache_document(&file.id, &document.content)
                .map_err(JobExecutionError::persistence)?;
        } else {
            let size = file
                .current_revision
                .as_ref()
                .map(|revision| revision.size_bytes)
                .unwrap_or(0);
            if size > MAX_BACKGROUND_ASSET_BYTES {
                continue;
            }
            let path = format!("/api/v1/vaults/{}/files/{}/content", vault.id, file.id);
            let bytes = request_bytes(session, &path, MAX_BACKGROUND_ASSET_BYTES).await?;
            store
                .cache_asset(&file.id, &bytes)
                .map_err(JobExecutionError::persistence)?;
        }
    }
    Ok(())
}

pub(super) async fn request_json<T: DeserializeOwned>(
    session: &ServerSessionState,
    method: Method,
    path: &str,
    body: Option<Value>,
) -> Result<T, JobExecutionError> {
    let client =
        server_client(session.allow_invalid_certificates).map_err(classify_transport_error)?;
    let mut request = client
        .request(method, format!("{}{}", session.server_url, path))
        .bearer_auth(&session.access_token);
    if let Some(body) = body {
        request = request.json(&body);
    }
    let response = request
        .send()
        .await
        .map_err(server_request_error)
        .map_err(classify_transport_error)?;
    if !response.status().is_success() {
        let status = response.status();
        let message = decode_hosted_error(response).await;
        return Err(classify_http_error(status, message));
    }
    response
        .json::<DataResponse<T>>()
        .await
        .map(|body| body.data)
        .map_err(|_| JobExecutionError {
            status: BackgroundJobStatus::Failed,
            category: "protocol",
            message: "The server returned an invalid background-sync response.".to_string(),
            retryable: false,
        })
}

async fn request_bytes(
    session: &ServerSessionState,
    path: &str,
    max_bytes: u64,
) -> Result<Vec<u8>, JobExecutionError> {
    let response = server_client(session.allow_invalid_certificates)
        .map_err(classify_transport_error)?
        .get(format!("{}{}", session.server_url, path))
        .bearer_auth(&session.access_token)
        .send()
        .await
        .map_err(server_request_error)
        .map_err(classify_transport_error)?;
    if !response.status().is_success() {
        let status = response.status();
        let message = decode_hosted_error(response).await;
        return Err(classify_http_error(status, message));
    }
    if response
        .content_length()
        .is_some_and(|length| length > max_bytes)
    {
        return Err(JobExecutionError::persistence(
            "The hosted asset exceeds the background-download limit.",
        ));
    }
    let bytes = response
        .bytes()
        .await
        .map_err(server_request_error)
        .map_err(classify_transport_error)?;
    if bytes.len() as u64 > max_bytes {
        return Err(JobExecutionError::persistence(
            "The hosted asset exceeds the background-download limit.",
        ));
    }
    Ok(bytes.to_vec())
}

pub(super) fn classify_session_error(message: String) -> JobExecutionError {
    if message.to_lowercase().contains("no saved server session") {
        JobExecutionError {
            status: BackgroundJobStatus::AuthenticationRequired,
            category: "authentication",
            message,
            retryable: false,
        }
    } else {
        classify_transport_error(message)
    }
}

fn classify_transport_error(message: String) -> JobExecutionError {
    JobExecutionError {
        status: BackgroundJobStatus::Deferred,
        category: "connectivity",
        message,
        retryable: true,
    }
}

fn classify_http_error(status: StatusCode, message: String) -> JobExecutionError {
    match status {
        StatusCode::UNAUTHORIZED => JobExecutionError {
            status: BackgroundJobStatus::AuthenticationRequired,
            category: "authentication",
            message,
            retryable: false,
        },
        StatusCode::FORBIDDEN => JobExecutionError {
            status: BackgroundJobStatus::PermissionDenied,
            category: "permission",
            message,
            retryable: false,
        },
        StatusCode::CONFLICT => JobExecutionError {
            status: BackgroundJobStatus::Conflict,
            category: "conflict",
            message,
            retryable: false,
        },
        StatusCode::TOO_MANY_REQUESTS
        | StatusCode::BAD_GATEWAY
        | StatusCode::SERVICE_UNAVAILABLE
        | StatusCode::GATEWAY_TIMEOUT => JobExecutionError {
            status: BackgroundJobStatus::Deferred,
            category: "server_busy",
            message,
            retryable: true,
        },
        _ if status.is_server_error() => JobExecutionError {
            status: BackgroundJobStatus::Deferred,
            category: "server",
            message,
            retryable: true,
        },
        _ => JobExecutionError {
            status: BackgroundJobStatus::Failed,
            category: "server_rejected",
            message,
            retryable: false,
        },
    }
}

fn pending_failure_code(error: &JobExecutionError) -> &'static str {
    match error.status {
        BackgroundJobStatus::PermissionDenied | BackgroundJobStatus::AuthenticationRequired => {
            "permission_revoked"
        }
        BackgroundJobStatus::Conflict => "manifest_conflict",
        _ if error.category == "server_rejected" => "server_rejected",
        _ => "vault_unavailable",
    }
}

fn required_string(value: &Value, key: &str) -> Result<String, JobExecutionError> {
    value
        .get(key)
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .ok_or_else(|| {
            JobExecutionError::persistence(format!(
                "Pending operation is missing the required {key} field."
            ))
        })
}

fn replace_mapped_ids(mut payload: Value, id_map: &HashMap<String, String>) -> Value {
    if let Some(object) = payload.as_object_mut() {
        for key in ["targetFileId", "parentId"] {
            let Some(value) = object.get(key).and_then(Value::as_str) else {
                continue;
            };
            if let Some(mapped) = id_map.get(value) {
                object.insert(key.to_string(), Value::String(mapped.clone()));
            }
        }
    }
    payload
}

fn role_name(role: HostedVaultRole) -> &'static str {
    match role {
        HostedVaultRole::Viewer => "viewer",
        HostedVaultRole::Editor => "editor",
        HostedVaultRole::Admin => "admin",
    }
}

fn update_replica_metadata(
    config_root: &std::path::Path,
    vault: &HostedVault,
    server_url: &str,
) -> Result<(), JobExecutionError> {
    ReplicaStore::open_or_create(
        config_root,
        server_url,
        &vault.id,
        &vault.name,
        Some(role_name(vault.role)),
        &vault.capabilities,
    )
    .map(|_| ())
    .map_err(JobExecutionError::persistence)
}

fn open_replica(
    coordinator: &BackgroundCoordinator,
    config_root: &std::path::Path,
    server_url: &str,
    vault_id: &str,
) -> Result<ReplicaStore, JobExecutionError> {
    #[cfg(test)]
    if coordinator.allow_unencrypted_replicas {
        return ReplicaStore::open_existing(config_root, server_url, vault_id).ok_or_else(|| {
            JobExecutionError::persistence(format!("No local replica for vault {vault_id}"))
        });
    }
    let _ = coordinator;
    crate::commands::replica::existing_at(config_root, server_url, vault_id)
        .map_err(JobExecutionError::persistence)
}

fn mark_replica_error(store: &ReplicaStore, offline: bool) -> Result<(), String> {
    let mut state = store.read_sync_state()?;
    state.status = if offline {
        SyncStatus::Offline
    } else {
        SyncStatus::Error
    };
    store.write_sync_state(&state)
}

pub(super) fn ensure_running(
    cancel: &AtomicBool,
    started: Instant,
    budget: Duration,
) -> Result<(), JobExecutionError> {
    if cancel.load(Ordering::Acquire) {
        return Err(JobExecutionError::interrupted(
            "The background job was cancelled.",
        ));
    }
    if started.elapsed() >= budget {
        return Err(JobExecutionError::interrupted(
            "The background runtime budget was exhausted.",
        ));
    }
    Ok(())
}
