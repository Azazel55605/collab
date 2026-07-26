//! Typed persistence models for the native hosted-vault replica store.
//!
//! These mirror the camelCase DTO shapes used elsewhere for hosted vaults so
//! they round-trip cleanly to and from the frontend. The replica holds vault
//! *content* only — never access or refresh tokens.

use collab_vault_domain::VaultDomainError;
use serde::{Deserialize, Serialize};
use serde_json::Value;

/// Schema version for the on-disk replica layout. Bump when the layout changes
/// in a way that requires migration or a rebuild.
pub const REPLICA_SCHEMA_VERSION: u32 = 1;

/// Identifying metadata for a single hosted-vault replica.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ReplicaMeta {
    pub server_url: String,
    pub vault_id: String,
    pub vault_name: String,
    pub schema_version: u32,
    pub created_at: String,
    pub updated_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub role: Option<String>,
    #[serde(default)]
    pub capabilities: Vec<String>,
}

/// The coarse synchronization status of a replica relative to the server.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum SyncStatus {
    Idle,
    Syncing,
    Offline,
    Error,
}

impl Default for SyncStatus {
    fn default() -> Self {
        SyncStatus::Idle
    }
}

/// Tracks how far the replica has synchronized with the server.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ReplicaSyncState {
    /// The server manifest sequence the replica last observed.
    pub manifest_sequence: i64,
    /// ISO-8601 timestamp of the last successful synchronization, if any.
    pub last_synced_at: Option<String>,
    /// Set after the user explicitly downloads active document/asset bodies.
    /// A manifest-only replica leaves this empty.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub offline_available_at: Option<String>,
    pub status: SyncStatus,
}

/// A lightweight inventory entry for an existing hosted-vault replica. This is
/// used by the native UI to show offline copies when the server cannot be
/// reached.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ReplicaSummary {
    pub server_url: String,
    pub vault_id: String,
    pub vault_name: String,
    pub manifest_sequence: i64,
    pub last_synced_at: Option<String>,
    /// Set only for replicas whose active file bodies were explicitly cached.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub offline_available_at: Option<String>,
    pub status: SyncStatus,
    pub pending_count: usize,
    pub updated_at: String,
    pub role: Option<String>,
    pub capabilities: Vec<String>,
}

impl Default for ReplicaSyncState {
    fn default() -> Self {
        Self {
            manifest_sequence: 0,
            last_synced_at: None,
            offline_available_at: None,
            status: SyncStatus::Idle,
        }
    }
}

/// The kind of structural or content mutation a pending operation represents.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum PendingOpKind {
    Create,
    Edit,
    Rename,
    Move,
    Trash,
    Restore,
    Delete,
    AssetUpload,
    #[serde(rename = "logicComponentSave")]
    LogicComponentSave,
    #[serde(rename = "logicComponentDelete")]
    LogicComponentDelete,
}

/// The lifecycle state of a pending operation in the replay queue.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum PendingOpStatus {
    Pending,
    InFlight,
    Failed,
}

/// A locally-recorded mutation that has not yet been confirmed by the server.
/// The queue is append-only and replayed against the server on reconnect by a
/// later Phase 6 increment.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PendingOperation {
    pub id: String,
    pub kind: PendingOpKind,
    /// Stable hosted file id the operation targets, when known. Offline-created
    /// files may not yet have a server id, so this is optional.
    pub file_id: Option<String>,
    pub relative_path: Option<String>,
    /// Operation-specific payload (e.g. new content, destination path).
    pub payload: Value,
    /// The manifest sequence the operation was authored against, used for
    /// optimistic conflict detection during replay.
    pub base_manifest_sequence: i64,
    pub created_at: String,
    pub status: PendingOpStatus,
    /// Machine-readable failure category from the last replay attempt.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub failure_code: Option<String>,
    /// Human-readable failure detail from the last replay attempt.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub failure_message: Option<String>,
}

impl PendingOperation {
    /// Returns the portable vault-domain conflict represented by the persisted
    /// machine code. Legacy free-form messages are intentionally not parsed.
    pub fn domain_conflict(&self) -> Option<VaultDomainError> {
        self.failure_code
            .as_deref()
            .and_then(VaultDomainError::from_code)
    }
}

/// A locally-known deletion. Tombstones let the replica distinguish an item the
/// user deleted offline from one that simply never synced.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Tombstone {
    pub file_id: String,
    pub relative_path: String,
    pub deleted_at: String,
}

/// The result of a replica integrity check.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ReplicaIntegrityReport {
    pub ok: bool,
    /// Tracked JSON files whose contents no longer match their recorded checksum.
    pub corrupt_files: Vec<String>,
}

/// The result of a bounded cache-cleanup pass over a replica's cached content.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CacheCleanupReport {
    /// Number of cached document/asset/CRDT files removed.
    pub removed_files: u64,
    /// Total bytes reclaimed by the cleanup pass.
    pub freed_bytes: u64,
    /// Total cached content bytes remaining after cleanup.
    pub remaining_bytes: u64,
}

/// Whether a cached document/asset body exists and matches a known revision
/// digest. Used to resume large offline-copy downloads without re-fetching
/// content that was already cached by a previous interrupted run.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CachedContentStatus {
    pub present: bool,
    pub matches_expected_hash: bool,
    pub actual_sha256: Option<String>,
    pub size_bytes: Option<u64>,
}
