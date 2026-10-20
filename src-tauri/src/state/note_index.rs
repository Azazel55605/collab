use crate::models::note::NoteMetadata;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};
use std::sync::Arc;

#[derive(Clone, Serialize, Deserialize)]
pub struct IndexedNote {
    pub metadata: NoteMetadata,
    pub content: String,
    #[serde(skip)]
    pub folded: String,
    pub stamp: (u128, u64),
}

/// One native index slot. Immutable entry snapshots share text/metadata; an
/// incremental publication copies tree pointers, never every note's strings.
#[derive(Default)]
pub struct ScopedNoteIndex {
    vault_path: Option<String>,
    generation: u64,
    entries: Arc<BTreeMap<String, Arc<IndexedNote>>>,
    reverse: BTreeMap<String, BTreeSet<String>>,
}
impl ScopedNoteIndex {
    pub fn clear(&mut self) {
        self.generation = self.generation.wrapping_add(1);
        self.vault_path = None;
        self.entries = Arc::default();
        self.reverse.clear();
    }
    pub fn begin(&mut self, path: &str) -> u64 {
        if self.vault_path.as_deref() != Some(path) {
            self.clear();
            self.vault_path = Some(path.to_owned());
        }
        self.generation = self.generation.wrapping_add(1);
        self.generation
    }
    pub fn is_current(&self, path: &str, generation: u64) -> bool {
        self.vault_path.as_deref() == Some(path) && self.generation == generation
    }
    pub fn publish_entries(
        &mut self,
        path: &str,
        generation: u64,
        entries: BTreeMap<String, Arc<IndexedNote>>,
    ) -> bool {
        if !self.is_current(path, generation) {
            return false;
        }
        for (path, old) in self.entries.iter() {
            if entries.get(path).is_some_and(|new| Arc::ptr_eq(old, new)) {
                continue;
            }
            for link in &old.metadata.wikilinks_out {
                let key = link.to_lowercase();
                if let Some(sources) = self.reverse.get_mut(&key) {
                    sources.remove(path);
                    if sources.is_empty() {
                        self.reverse.remove(&key);
                    }
                }
            }
        }
        for (path, note) in &entries {
            if self
                .entries
                .get(path)
                .is_some_and(|old| Arc::ptr_eq(old, note))
            {
                continue;
            }
            for link in &note.metadata.wikilinks_out {
                self.reverse
                    .entry(link.to_lowercase())
                    .or_default()
                    .insert(path.clone());
            }
        }
        self.entries = Arc::new(entries);
        true
    }
    pub fn entries_for(&self, path: &str) -> Arc<BTreeMap<String, Arc<IndexedNote>>> {
        if self.vault_path.as_deref() == Some(path) {
            self.entries.clone()
        } else {
            Arc::default()
        }
    }
    pub fn backlinks(&self, vault: &str, path: &str) -> Vec<String> {
        if self.vault_path.as_deref() != Some(vault) {
            return vec![];
        }
        let lower = path.to_lowercase();
        let stem = std::path::Path::new(&lower)
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("");
        [lower.as_str(), lower.trim_end_matches(".md"), stem]
            .iter()
            .filter_map(|key| self.reverse.get(*key))
            .flatten()
            .filter(|source| source.as_str() != path)
            .cloned()
            .collect::<BTreeSet<_>>()
            .into_iter()
            .collect()
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    fn note(name: &str, links: &[&str]) -> Arc<IndexedNote> {
        Arc::new(IndexedNote {
            metadata: NoteMetadata {
                relative_path: name.into(),
                title: name.into(),
                tags: vec![],
                wikilinks_out: links.iter().map(|s| (*s).into()).collect(),
                modified_at: 0,
                word_count: 0,
                hash: String::new(),
            },
            content: String::new(),
            folded: String::new(),
            stamp: (0, 0),
        })
    }
    #[test]
    fn generations_snapshots_and_incremental_reverse_links() {
        let mut cache = ScopedNoteIndex::default();
        let old = cache.begin("A");
        let current = cache.begin("B");
        let entries = BTreeMap::from([("a.md".into(), note("a.md", &["TARGET", "Dir/Target.md"]))]);
        assert!(!cache.publish_entries("A", old, entries.clone()));
        assert!(cache.publish_entries("B", current, entries));
        assert!(cache.entries_for("A").is_empty());
        let first = cache.entries_for("B");
        assert!(Arc::ptr_eq(&first, &cache.entries_for("B")));
        assert_eq!(cache.backlinks("B", "Dir/Target.md"), vec!["a.md"]);
        // Ambiguous stems deliberately match all target paths, as before.
        assert_eq!(cache.backlinks("B", "Other/Target.md"), vec!["a.md"]);
        let generation = cache.begin("B");
        cache.publish_entries(
            "B",
            generation,
            BTreeMap::from([("a.md".into(), note("a.md", &["Elsewhere"]))]),
        );
        assert!(cache.backlinks("B", "Dir/Target.md").is_empty());
        cache.clear();
        assert_eq!(first.len(), 1);
        cache.begin("B");
        assert!(!cache.publish_entries("B", generation, BTreeMap::new()));
    }
}
