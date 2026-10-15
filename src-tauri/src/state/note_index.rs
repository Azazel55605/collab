use crate::models::note::NoteMetadata;
use std::sync::Arc;

/// A single bounded index slot with vault identity and request-generation ownership.
#[derive(Default)]
pub struct ScopedNoteIndex {
    vault_path: Option<String>,
    generation: u64,
    notes: Arc<Vec<NoteMetadata>>,
}
impl ScopedNoteIndex {
    pub fn clear(&mut self) {
        self.generation = self.generation.wrapping_add(1);
        self.vault_path = None;
        self.notes = Arc::new(Vec::new());
    }
    pub fn begin(&mut self, path: &str) -> u64 {
        if self.vault_path.as_deref() != Some(path) {
            self.notes = Arc::new(Vec::new());
            self.vault_path = Some(path.to_owned());
        }
        self.generation = self.generation.wrapping_add(1);
        self.generation
    }
    pub fn is_current(&self, path: &str, generation: u64) -> bool {
        self.vault_path.as_deref() == Some(path) && self.generation == generation
    }
    pub fn publish(&mut self, path: &str, generation: u64, notes: Vec<NoteMetadata>) -> bool {
        if !self.is_current(path, generation) {
            return false;
        }
        self.notes = Arc::new(notes);
        true
    }
    pub fn snapshot_for(&self, path: &str) -> Arc<Vec<NoteMetadata>> {
        if self.vault_path.as_deref() == Some(path) {
            Arc::clone(&self.notes)
        } else {
            Arc::default()
        }
    }
    pub fn notes_for(&self, path: &str) -> &[NoteMetadata] {
        if self.vault_path.as_deref() == Some(path) {
            &self.notes
        } else {
            &[]
        }
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    fn note(name: &str) -> NoteMetadata {
        NoteMetadata {
            relative_path: name.into(),
            title: name.into(),
            tags: vec![],
            wikilinks_out: vec![],
            modified_at: 0,
            word_count: 0,
            hash: String::new(),
        }
    }
    #[test]
    fn late_cross_vault_and_same_vault_jobs_cannot_replace_the_current_index() {
        let mut cache = ScopedNoteIndex::default();
        let old = cache.begin("A");
        let current = cache.begin("B");
        assert!(cache.publish("B", current, vec![note("b.md")]));
        assert!(!cache.publish("A", old, vec![note("a.md")]));
        assert!(cache.notes_for("A").is_empty());
        assert_eq!(cache.notes_for("B")[0].relative_path, "b.md");
        let old = cache.begin("B");
        let current = cache.begin("B");
        assert!(cache.publish("B", current, vec![note("new.md")]));
        assert!(!cache.publish("B", old, vec![note("old.md")]));
    }
    #[test]
    fn searches_share_an_immutable_snapshot_without_copying_all_metadata() {
        let mut cache = ScopedNoteIndex::default();
        let generation = cache.begin("A");
        cache.publish("A", generation, vec![note("a.md")]);
        let first = cache.snapshot_for("A");
        let second = cache.snapshot_for("A");
        assert!(Arc::ptr_eq(&first, &second));
        cache.clear();
        assert_eq!(first[0].relative_path, "a.md");
        assert!(cache.snapshot_for("B").is_empty());
    }
    #[test]
    fn reopening_the_same_path_does_not_revive_an_old_job() {
        let mut cache = ScopedNoteIndex::default();
        let old = cache.begin("A");
        cache.clear();
        cache.begin("A");
        assert!(!cache.publish("A", old, vec![note("old.md")]));
        assert!(cache.notes_for("A").is_empty());
    }
}
