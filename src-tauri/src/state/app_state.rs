use crate::models::{note::NoteMetadata, vault::VaultMeta};
use collab_protocol::ServerUser;
use notify::RecommendedWatcher;
use notify_debouncer_mini::Debouncer;
use parking_lot::RwLock;
use std::collections::HashMap;
use std::sync::Arc;

#[derive(Debug, Clone)]
pub struct ServerSessionState {
    pub server_url: String,
    pub allow_invalid_certificates: bool,
    pub persist_across_reboots: bool,
    pub access_token: String,
    /// Held in memory (like `access_token`) so reconnects and the auto-reconnect
    /// retry loop can rotate the session without re-reading the OS keyring — the
    /// keyring is otherwise touched once per launch. Never leaves the backend.
    pub refresh_token: String,
    pub access_expires_at: String,
    pub user: ServerUser,
}

pub struct HostedSessionRuntime {
    /// Native server access tokens are intentionally memory-only. Keyed by
    /// normalized server URL so every native caller selects the correct server.
    pub server_sessions: RwLock<HashMap<String, ServerSessionState>>,
    /// Per-process refresh-token cache. The OS credential store is touched only
    /// when a server is first restored during this process lifetime.
    pub refresh_token_cache: RwLock<HashMap<String, String>>,
    /// Refresh tokens are single-use, so rotation must be serialized across
    /// foreground commands and headless background jobs.
    pub server_refresh_lock: tokio::sync::Mutex<()>,
}

impl HostedSessionRuntime {
    pub fn new() -> Self {
        Self {
            server_sessions: RwLock::new(HashMap::new()),
            refresh_token_cache: RwLock::new(HashMap::new()),
            server_refresh_lock: tokio::sync::Mutex::new(()),
        }
    }
}

pub struct AppState {
    pub active_vault: RwLock<Option<VaultMeta>>,
    pub watcher: parking_lot::Mutex<Option<Debouncer<RecommendedWatcher>>>,
    pub note_index: RwLock<Vec<NoteMetadata>>,
    /// AES-256 key derived from the vault password. Present only while the
    /// vault is unlocked. Cleared whenever a new vault is opened.
    pub encryption_key: RwLock<Option<[u8; 32]>>,
    /// Shared by foreground Tauri commands and the headless background
    /// coordinator so token rotation and access-session state never fork.
    pub hosted_sessions: Arc<HostedSessionRuntime>,
    /// Process-owned scheduler, native registry, job ledger, and resource locks.
    pub background: Arc<crate::background::BackgroundCoordinator>,
    /// Active backend-proxied live-collaboration WebSockets. Routing the live
    /// socket through Rust lets it reuse the session TLS config (including the
    /// untrusted-certificate opt-in), which the webview's own `WebSocket` cannot.
    pub live_ws: crate::commands::live_ws::LiveWsRegistry,
    /// Bounded native circuit workers and their unconsumed terminal results.
    pub circuit_jobs: crate::commands::circuit::CircuitJobRegistry,
}

impl AppState {
    pub fn new() -> Self {
        let hosted_sessions = Arc::new(HostedSessionRuntime::new());
        let background = Arc::new(crate::background::BackgroundCoordinator::new(
            hosted_sessions.clone(),
        ));
        Self {
            active_vault: RwLock::new(None),
            watcher: parking_lot::Mutex::new(None),
            note_index: RwLock::new(Vec::new()),
            encryption_key: RwLock::new(None),
            hosted_sessions,
            background,
            live_ws: crate::commands::live_ws::LiveWsRegistry::default(),
            circuit_jobs: crate::commands::circuit::CircuitJobRegistry::default(),
        }
    }

    pub fn hosted_sessions(&self) -> &HostedSessionRuntime {
        &self.hosted_sessions
    }
}
