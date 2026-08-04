//! Native hosted-vault replica store (Phase 6 offline-sync foundation).
//!
//! A replica is a per-vault, on-disk cache that lets a native client keep
//! working against a hosted vault while offline and reconcile later. It persists
//! the last-known server manifest, cached document/asset content, tombstones,
//! sync state, and an append-only pending-operation queue. It stores vault
//! *content only* and never holds access or refresh tokens.

pub mod models;
pub mod store;

// Re-export the surface the Tauri commands consume directly. Additional model
// types (e.g. PendingOpKind, SyncStatus, ReplicaMeta) and the path helpers remain
// reachable via `replica::models::` / `replica::store::` for later increments.
pub use models::{
    CacheCleanupReport, CachedContentStatus, PendingOpCounts, PendingOpStatus, PendingOperation,
    ReplicaIntegrityReport, ReplicaSummary, ReplicaSyncState, Tombstone,
};
pub use store::{server_key, ReplicaStore};
