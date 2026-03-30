use crate::models::{note::NoteMetadata, vault::VaultMeta};
use notify::RecommendedWatcher;
use notify_debouncer_mini::Debouncer;
use parking_lot::RwLock;

pub struct AppState {
    pub active_vault: RwLock<Option<VaultMeta>>,
    pub watcher: parking_lot::Mutex<Option<Debouncer<RecommendedWatcher>>>,
    pub note_index: RwLock<Vec<NoteMetadata>>,
    /// AES-256 key derived from the vault password. Present only while the
    /// vault is unlocked. Cleared whenever a new vault is opened.
    pub encryption_key: RwLock<Option<[u8; 32]>>,
}

impl AppState {
    pub fn new() -> Self {
        Self {
            active_vault: RwLock::new(None),
            watcher: parking_lot::Mutex::new(None),
            note_index: RwLock::new(Vec::new()),
            encryption_key: RwLock::new(None),
        }
    }
}
