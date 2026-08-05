//! Bridges background coordinator activity to the webview.
//!
//! The coordinator is a process-level singleton that also runs headless in the
//! Android WorkManager process, where there is no Tauri app at all, so it
//! cannot hold an `AppHandle` itself. The running app installs this observer
//! during setup; the headless path simply has none.

use crate::background::{BackgroundObserver, BackgroundStatusSnapshot};
use serde::Serialize;
use tauri::{AppHandle, Emitter};

/// Emitted when a background job starts, makes persisted progress, or finishes.
pub const BACKGROUND_STATUS_EVENT: &str = "background:status";
/// Emitted when a replica sync brought new content into a vault.
pub const BACKGROUND_VAULT_SYNCED_EVENT: &str = "background:vault-synced";

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct VaultSyncedPayload {
    server_url: String,
    vault_id: String,
    changed: u64,
}

pub struct AppBackgroundObserver {
    app: AppHandle,
}

impl AppBackgroundObserver {
    pub fn new(app: AppHandle) -> Self {
        Self { app }
    }
}

impl BackgroundObserver for AppBackgroundObserver {
    fn status_changed(&self, snapshot: &BackgroundStatusSnapshot) {
        // Best effort throughout: a closed window or a torn-down event loop
        // must never fail a background job.
        let _ = self.app.emit(BACKGROUND_STATUS_EVENT, snapshot);
    }

    fn vault_synced(&self, server_url: &str, vault_id: &str, changed: u64) {
        let _ = self.app.emit(
            BACKGROUND_VAULT_SYNCED_EVENT,
            VaultSyncedPayload {
                server_url: server_url.to_string(),
                vault_id: vault_id.to_string(),
                changed,
            },
        );
    }
}
