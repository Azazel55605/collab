use crate::models::{note::NoteMetadata, vault::VaultMeta};
use notify::RecommendedWatcher;
use notify_debouncer_mini::Debouncer;
use parking_lot::RwLock;

pub struct AppState {
    pub active_vault: RwLock<Option<VaultMeta>>,
    pub watcher: parking_lot::Mutex<Option<Debouncer<RecommendedWatcher>>>,
    pub note_index: RwLock<Vec<NoteMetadata>>,
}

impl AppState {
    pub fn new() -> Self {
        Self {
            active_vault: RwLock::new(None),
            watcher: parking_lot::Mutex::new(None),
            note_index: RwLock::new(Vec::new()),
        }
    }
}
