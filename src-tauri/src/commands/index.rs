use crate::crypto;
use crate::models::note::{NoteMetadata, SearchResult};
use crate::state::AppState;
use collab_core::sha256_text;
use fuzzy_matcher::skim::SkimMatcherV2;
use fuzzy_matcher::FuzzyMatcher;
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, State};
use walkdir::WalkDir;

fn is_ignored_dir_name(name: &str) -> bool {
    matches!(
        name,
        "node_modules"
            | "target"
            | "dist"
            | "dist-builds"
            | "build"
            | "flatpak-build"
            | "flatpak-repo"
    )
}

fn should_skip_walk_entry(name: &str, is_dir: bool) -> bool {
    name.starts_with('.') || (is_dir && is_ignored_dir_name(name))
}

fn compute_hash(content: &str) -> String {
    sha256_text(content)
}

fn system_time_to_ms(t: SystemTime) -> u64 {
    t.duration_since(UNIX_EPOCH).unwrap_or_default().as_millis() as u64
}

fn extract_wikilinks(mut content: &str) -> Vec<String> {
    let mut links = Vec::new();
    while let Some(start) = content.find("[[") {
        content = &content[start + 2..];
        let Some(end) = content.find("]]") else {
            break;
        };
        let link = &content[..end];
        if !link.is_empty() {
            links.push(link.split('|').next().unwrap_or(link).trim().to_owned());
        }
        content = &content[end + 2..];
    }
    links
}

fn extract_title(content: &str, filename: &str) -> String {
    // Check frontmatter title
    if content.starts_with("---") {
        if let Some(end) = content[3..].find("---") {
            let fm = &content[3..end + 3];
            for line in fm.lines() {
                if let Some(title) = line.strip_prefix("title:") {
                    let t = title.trim().trim_matches('"').trim_matches('\'');
                    if !t.is_empty() {
                        return t.to_string();
                    }
                }
            }
        }
    }
    // Check first H1
    for line in content.lines() {
        if let Some(h) = line.strip_prefix("# ") {
            return h.trim().to_string();
        }
    }
    // Fallback to filename without extension
    filename.trim_end_matches(".md").to_string()
}

fn extract_tags(content: &str) -> Vec<String> {
    if !content.starts_with("---") {
        return vec![];
    }
    if let Some(end) = content[3..].find("---") {
        let fm = &content[3..end + 3];
        let mut in_tags = false;
        let mut tags = Vec::new();
        for line in fm.lines() {
            if line.trim_start().starts_with("tags:") {
                let inline = line.trim_start().strip_prefix("tags:").unwrap().trim();
                if inline.starts_with('[') {
                    // tags: [a, b, c]
                    let inner = inline.trim_start_matches('[').trim_end_matches(']');
                    tags.extend(
                        inner
                            .split(',')
                            .map(|t| t.trim().trim_matches('"').trim_matches('\'').to_string())
                            .filter(|t| !t.is_empty()),
                    );
                } else {
                    in_tags = true;
                }
            } else if in_tags {
                if let Some(tag) = line.trim().strip_prefix("- ") {
                    tags.push(tag.trim().trim_matches('"').trim_matches('\'').to_string());
                } else {
                    in_tags = false;
                }
            }
        }
        return tags;
    }
    vec![]
}

fn count_words(content: &str) -> u32 {
    content.split_whitespace().count() as u32
}

fn make_excerpt(content: &str, query: &str, max_len: usize) -> String {
    let folded = content.to_lowercase();
    let query = query.to_lowercase();
    let start = folded
        .find(&query)
        .and_then(|position| {
            let mut folded_offset = 0;
            content.chars().enumerate().find_map(|(index, character)| {
                let folded_len: usize = character.to_lowercase().map(char::len_utf8).sum();
                let contains = position < folded_offset + folded_len;
                folded_offset += folded_len;
                contains.then_some(index.saturating_sub(40))
            })
        })
        .unwrap_or(0);
    let mut chars = content.chars().skip(start);
    let excerpt: String = chars.by_ref().take(max_len).collect();
    if chars.next().is_some() {
        format!("{}...", excerpt.trim())
    } else {
        excerpt.trim().to_string()
    }
}

// Content is kept in one native vault-scoped slot. Disposable per-file records
// use the vault encryption key; no plaintext side index is written for encrypted vaults.
use crate::state::note_index::IndexedNote;
use serde::Serialize;
use std::collections::{BTreeMap, BinaryHeap};
use std::sync::Arc;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexDelta {
    upserted: Vec<NoteMetadata>,
    removed: Vec<String>,
    reconciled_paths: Vec<String>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchPage {
    results: Vec<SearchResult>,
    total: usize,
    next_offset: Option<usize>,
}

#[cfg(test)]
thread_local! { static SOURCE_READS: std::cell::Cell<usize> = const { std::cell::Cell::new(0) }; }

fn cache_path(base: &Path, relative: &str) -> std::path::PathBuf {
    base.join(".collab/search/v1")
        .join(format!("{}.entry", compute_hash(relative)))
}

fn read_indexed_note(
    base: &Path,
    relative: &str,
    key: Option<[u8; 32]>,
    force: bool,
    previous: Option<&Arc<IndexedNote>>,
) -> Result<Arc<IndexedNote>, String> {
    let _mutation = crate::local_mutation::lock_path(base)?;
    let path = base.join(relative);
    if !path
        .canonicalize()
        .map_err(|e| e.to_string())?
        .starts_with(base.canonicalize().map_err(|e| e.to_string())?)
    {
        return Err("Index path escapes vault".into());
    }
    let metadata = std::fs::metadata(&path).map_err(|e| e.to_string())?;
    let modified = metadata.modified().map_err(|e| e.to_string())?;
    let stamp = (
        modified
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos(),
        metadata.len(),
    );
    if !force {
        if let Some(note) = previous.filter(|note| note.stamp == stamp) {
            return Ok(note.clone());
        }
        if let Ok(bytes) = std::fs::read(cache_path(base, relative)) {
            let decoded = match key.as_ref() {
                Some(key) => crypto::decrypt_bytes(key, &bytes).ok(),
                None if !crypto::is_encrypted_data(&bytes) => Some(bytes),
                _ => None,
            };
            if let Some(note) = decoded.and_then(|b| serde_json::from_slice::<IndexedNote>(&b).ok())
            {
                if note.stamp == stamp
                    && note.metadata.relative_path == relative
                    && compute_hash(&note.content) == note.metadata.hash
                {
                    return Ok(Arc::new(IndexedNote {
                        folded: note.content.to_lowercase(),
                        ..note
                    }));
                }
            }
        }
    }
    #[cfg(test)]
    SOURCE_READS.with(|reads| reads.set(reads.get() + 1));
    let raw = std::fs::read(&path).map_err(|e| e.to_string())?;
    let raw = if crypto::is_encrypted_data(&raw) {
        crypto::decrypt_bytes(key.as_ref().ok_or("Vault is locked")?, &raw)?
    } else {
        raw
    };
    let content = String::from_utf8(raw).map_err(|e| e.to_string())?;
    let note = IndexedNote {
        metadata: NoteMetadata {
            relative_path: relative.into(),
            title: extract_title(
                &content,
                path.file_name()
                    .and_then(|s| s.to_str())
                    .unwrap_or(relative),
            ),
            tags: extract_tags(&content),
            wikilinks_out: extract_wikilinks(&content),
            modified_at: system_time_to_ms(modified),
            word_count: count_words(&content),
            hash: compute_hash(&content),
        },
        folded: content.to_lowercase(),
        content,
        stamp,
    };
    // Cache failure must not make a readable note disappear. Atomic publication
    // prevents interrupted writes from poisoning future warm starts.
    let _ = (|| -> Result<(), String> {
        let cache = cache_path(base, relative);
        std::fs::create_dir_all(cache.parent().unwrap()).map_err(|e| e.to_string())?;
        let bytes = serde_json::to_vec(&note).map_err(|e| e.to_string())?;
        let bytes = if let Some(key) = key.as_ref() {
            crypto::encrypt_bytes(key, &bytes)?
        } else {
            bytes
        };
        use std::io::Write;
        let mut tmp =
            tempfile::NamedTempFile::new_in(cache.parent().unwrap()).map_err(|e| e.to_string())?;
        tmp.write_all(&bytes).map_err(|e| e.to_string())?;
        tmp.persist(cache).map_err(|e| e.to_string())?;
        Ok(())
    })();
    Ok(Arc::new(note))
}

fn refresh_index(
    vault_path: &str,
    paths: Option<Vec<String>>,
    key: Option<[u8; 32]>,
    cache: &parking_lot::RwLock<crate::state::note_index::ScopedNoteIndex>,
    generation: u64,
    force: bool,
    progress: &dyn Fn(usize),
) -> Result<IndexDelta, String> {
    let base = Path::new(vault_path);
    let mut processed = 0;
    progress(processed);
    let previous = cache.read().entries_for(vault_path);
    let mut entries = if paths.is_some() {
        (*previous).clone()
    } else {
        BTreeMap::new()
    };
    let mut upserted = Vec::new();
    let mut removed = Vec::new();
    let full = paths.is_none();
    let roots = paths.unwrap_or_else(|| vec![String::new()]);
    let reconciled_paths = if full { vec![] } else { roots.clone() };
    for relative in roots {
        if !cache.read().is_current(vault_path, generation) {
            return Err("Index request superseded".into());
        }
        let normalized =
            collab_core::normalize_relative_path(&relative).map_err(|e| e.to_string())?;
        if normalized.components().any(|part| {
            let name = part.as_os_str().to_string_lossy();
            name.starts_with('.') || is_ignored_dir_name(&name)
        }) {
            continue;
        }
        let root = base.join(normalized);
        if !full {
            let prefix = format!("{relative}/");
            entries.retain(|path, _| path != &relative && !path.starts_with(&prefix));
        }
        if !root.exists() {
            continue;
        }
        for entry in WalkDir::new(root).into_iter().filter_entry(|e| {
            let name = e.file_name().to_string_lossy();
            e.path() == base || !should_skip_walk_entry(&name, e.file_type().is_dir())
        }) {
            if !cache.read().is_current(vault_path, generation) {
                return Err("Index request superseded".into());
            }
            let entry = entry.map_err(|e| e.to_string())?;
            if !entry.file_type().is_file()
                || !entry
                    .path()
                    .extension()
                    .is_some_and(|s| s.eq_ignore_ascii_case("md"))
            {
                continue;
            }
            let relative = entry
                .path()
                .strip_prefix(base)
                .map_err(|e| e.to_string())?
                .to_string_lossy()
                .replace('\\', "/");
            if let Ok(note) = read_indexed_note(
                base,
                &relative,
                key,
                force || !full,
                previous.get(&relative),
            ) {
                // A preceding native delta may have been rejected by the UI
                // after a newer event. Republish requested paths even when the
                // native record already has these bytes.
                upserted.push(note.metadata.clone());
                entries.insert(relative, note);
                processed += 1;
                if processed % 128 == 0 {
                    progress(processed);
                }
            }
        }
    }
    for path in previous.keys() {
        if !entries.contains_key(path) {
            removed.push(path.clone());
            let _ = std::fs::remove_file(cache_path(base, path));
        }
    }
    if !cache
        .write()
        .publish_entries(vault_path, generation, entries)
    {
        return Err("Index request superseded".into());
    }
    if full {
        let expected = cache
            .read()
            .entries_for(vault_path)
            .keys()
            .map(|path| format!("{}.entry", compute_hash(path)))
            .collect::<std::collections::HashSet<_>>();
        if let Ok(records) = std::fs::read_dir(base.join(".collab/search/v1")) {
            for record in records.flatten() {
                let name = record.file_name().to_string_lossy().into_owned();
                if name.ends_with(".entry") && !expected.contains(&name) {
                    let _ = std::fs::remove_file(record.path());
                }
            }
        }
    }
    progress(processed);
    Ok(IndexDelta {
        upserted,
        removed,
        reconciled_paths,
    })
}

fn start_index(vault_path: &str, state: &AppState) -> Result<(Option<[u8; 32]>, u64), String> {
    let active = state.active_vault.read();
    if active
        .as_ref()
        .is_some_and(|vault| vault.path != vault_path)
    {
        return Err("Vault changed before indexing".into());
    }
    let key = *state.encryption_key.read();
    if active.as_ref().is_some_and(|v| v.is_encrypted) && key.is_none() {
        return Err("Vault is locked".into());
    }
    let generation = state.note_index.write().begin(vault_path);
    Ok((key, generation))
}

#[tauri::command]
pub async fn build_note_index(
    vault_path: String,
    force: Option<bool>,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<Vec<NoteMetadata>, String> {
    let (key, generation) = start_index(&vault_path, &state)?;
    let cache = state.note_index.clone();
    super::vault_jobs::run(move || {
        if !cache.read().is_current(&vault_path, generation) { return Err("Index request superseded".into()); }
        let progress = |processed| { let _ = app.emit("vault:index-progress", serde_json::json!({ "vaultPath": vault_path, "generation": generation, "processed": processed })); };
        Ok(refresh_index(&vault_path, None, key, &cache, generation, force.unwrap_or(false), &progress)?.upserted)
    }).await
}

#[tauri::command]
pub async fn update_note_index(
    vault_path: String,
    paths: Vec<String>,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<IndexDelta, String> {
    let (key, generation) = start_index(&vault_path, &state)?;
    let cache = state.note_index.clone();
    super::vault_jobs::run(move || {
        let progress = |processed| { let _ = app.emit("vault:index-progress", serde_json::json!({ "vaultPath": vault_path, "generation": generation, "processed": processed })); };
        refresh_index(&vault_path, Some(paths), key, &cache, generation, false, &progress)
    }).await
}

#[tauri::command]
pub fn get_backlinks(
    vault_path: String,
    relative_path: String,
    state: State<AppState>,
) -> Result<Vec<String>, String> {
    Ok(state
        .note_index
        .read()
        .backlinks(&vault_path, &relative_path))
}

// The heap retains only offset+limit lightweight candidates; excerpts are built
// for the returned page. Ties sort by path, independent of filesystem order.
fn search_page(
    index: &BTreeMap<String, Arc<IndexedNote>>,
    query: &str,
    offset: usize,
    limit: usize,
) -> SearchPage {
    let limit = limit.clamp(1, 100);
    let matcher = SkimMatcherV2::default();
    let folded = query.to_lowercase();
    let mut heap = BinaryHeap::new();
    let mut total = 0;
    if !query.trim().is_empty() {
        for (path, note) in index {
            let title_score = matcher.fuzzy_match(&note.metadata.title, query);
            let score = match title_score {
                Some(score) => score,
                None if note.folded.contains(&folded) => 10,
                _ => continue,
            };
            total += 1;
            heap.push(std::cmp::Reverse((
                score,
                std::cmp::Reverse(path),
                title_score.is_some(),
            )));
            if heap.len() > offset.saturating_add(limit) {
                heap.pop();
            }
        }
    }
    let mut selected = heap.into_iter().map(|v| v.0).collect::<Vec<_>>();
    selected.sort_by(|a, b| b.cmp(a));
    let results = selected
        .into_iter()
        .skip(offset)
        .map(|(score, path, title)| {
            let note = &index[path.0];
            SearchResult {
                relative_path: path.0.clone(),
                title: note.metadata.title.clone(),
                excerpt: if title {
                    note.metadata.title.clone()
                } else {
                    make_excerpt(&note.content, query, 120)
                },
                score,
                match_type: if title { "title" } else { "content" }.into(),
            }
        })
        .collect();
    SearchPage {
        results,
        total,
        next_offset: (offset.saturating_add(limit) < total).then_some(offset.saturating_add(limit)),
    }
}

#[tauri::command]
pub async fn search_notes_page(
    vault_path: String,
    query: String,
    offset: usize,
    limit: usize,
    state: State<'_, AppState>,
) -> Result<SearchPage, String> {
    let cache = state.note_index.clone();
    let index = cache.read().entries_for(&vault_path);
    super::vault_jobs::run(move || {
        if !Arc::ptr_eq(&index, &cache.read().entries_for(&vault_path)) {
            return Err("Search index changed; retry query".into());
        }
        let page = search_page(&index, &query, offset, limit);
        if !Arc::ptr_eq(&index, &cache.read().entries_for(&vault_path)) {
            return Err("Search index changed; retry query".into());
        }
        Ok(page)
    })
    .await
}

// Compatibility for callers which need a small quick-open result list.
#[tauri::command]
pub async fn search_notes(
    vault_path: String,
    query: String,
    state: State<'_, AppState>,
) -> Result<Vec<SearchResult>, String> {
    Ok(search_notes_page(vault_path, query, 0, 100, state)
        .await?
        .results)
}

#[cfg(test)]
mod tests {
    use super::{count_words, extract_tags, extract_title, extract_wikilinks, make_excerpt};

    #[test]
    fn extract_wikilinks_handles_simple_and_aliased_links() {
        let content = "Before [[Alpha]] middle [[Beta Note|beta alias]] after";

        let links = extract_wikilinks(content);

        assert_eq!(links, vec!["Alpha".to_string(), "Beta Note".to_string()]);
    }

    #[test]
    fn extract_wikilinks_ignores_unclosed_markup() {
        let content = "Broken [[Alpha without any closing brackets";

        let links = extract_wikilinks(content);

        assert!(links.is_empty());
    }

    #[test]
    fn extract_title_prefers_frontmatter_title() {
        let content = "---\ntitle: \"Frontmatter Title\"\n---\n# Heading Title\n";

        let title = extract_title(content, "Fallback.md");

        assert_eq!(title, "Frontmatter Title");
    }

    #[test]
    fn extract_title_falls_back_to_first_heading_then_filename() {
        let heading_title = extract_title("# Heading Title\nBody", "Fallback.md");
        let filename_title = extract_title("Body only", "Fallback.md");

        assert_eq!(heading_title, "Heading Title");
        assert_eq!(filename_title, "Fallback");
    }

    #[test]
    fn extract_tags_supports_inline_and_list_forms() {
        let inline = "---\ntags: [alpha, \"beta note\", 'gamma']\n---\nBody";
        let list = "---\ntags:\n  - alpha\n  - \"beta note\"\n  - 'gamma'\n---\nBody";

        let inline_tags = extract_tags(inline);
        let list_tags = extract_tags(list);

        assert_eq!(inline_tags, vec!["alpha", "beta note", "gamma"]);
        assert_eq!(list_tags, vec!["alpha", "beta note", "gamma"]);
    }

    #[test]
    fn extract_tags_returns_empty_when_frontmatter_is_missing() {
        let content = "# Title\nNo frontmatter here";

        let tags = extract_tags(content);

        assert!(tags.is_empty());
    }

    #[test]
    fn count_words_counts_whitespace_separated_tokens() {
        let count = count_words("one two\nthree\tfour");

        assert_eq!(count, 4);
    }

    #[test]
    fn make_excerpt_prefers_query_neighborhood() {
        let content = "First line with some text before the SearchTerm appears in the middle of the note and keeps going after it.";

        let excerpt = make_excerpt(content, "searchterm", 80);

        assert!(excerpt.to_lowercase().contains("searchterm"));
        assert!(excerpt.len() <= 83);
    }

    #[test]
    fn make_excerpt_falls_back_to_leading_content_when_query_is_missing() {
        let content = "This is the first sentence. This is the second sentence.";

        let excerpt = make_excerpt(content, "missing", 20);

        assert_eq!(excerpt, "This is the first se...");
    }
    #[test]
    fn excerpts_use_original_unicode_character_boundaries() {
        let content = format!("{}needle{}", "中".repeat(30), "😀".repeat(60));
        let excerpt = make_excerpt(&content, "NEEDLE", 120);
        assert!(excerpt.contains("needle"));
        assert!(
            make_excerpt(&format!("{}needle", "İ".repeat(60)), "needle", 80).contains("needle")
        );
        assert_eq!(make_excerpt("😀中é", "missing", 2), "😀中...");
        assert_eq!(make_excerpt("😀", "😀", 0), "...");
    }
}

#[cfg(test)]
mod incremental_tests {
    use super::*;
    use crate::state::note_index::ScopedNoteIndex;
    use parking_lot::RwLock;

    fn refresh(
        root: &str,
        paths: Option<Vec<String>>,
        key: Option<[u8; 32]>,
        cache: &RwLock<ScopedNoteIndex>,
    ) -> IndexDelta {
        let generation = cache.write().begin(root);
        refresh_index(root, paths, key, cache, generation, false, &|_| {}).unwrap()
    }
    #[test]
    fn warm_search_has_zero_source_reads_and_deltas_preserve_other_entries() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_str().unwrap();
        std::fs::create_dir(dir.path().join("Docs")).unwrap();
        for (path, text) in [
            ("Docs/a.md", "# Alpha\nbodyonly [[Target|alias]]"),
            ("b.md", "# Beta\nbodyonly"),
        ] {
            std::fs::write(dir.path().join(path), text).unwrap();
        }
        let cache = RwLock::new(ScopedNoteIndex::default());
        SOURCE_READS.with(|reads| reads.set(0));
        assert_eq!(refresh(root, None, None, &cache).upserted.len(), 2);
        assert_eq!(SOURCE_READS.with(|reads| reads.get()), 2);
        let initial = cache.read().entries_for(root);
        for _ in 0..5 {
            let page = search_page(&initial, "bodyonly", 0, 1);
            assert_eq!(page.total, 2);
            assert_eq!(page.results[0].relative_path, "Docs/a.md");
            assert_eq!(page.next_offset, Some(1));
            assert_eq!(
                search_page(&initial, "bodyonly", 1, 1).results[0].relative_path,
                "b.md"
            );
        }
        assert_eq!(SOURCE_READS.with(|reads| reads.get()), 2);
        cache.write().clear();
        refresh(root, None, None, &cache);
        assert_eq!(
            SOURCE_READS.with(|reads| reads.get()),
            2,
            "warm startup reads cache records, not source notes"
        );
        let untouched = cache.read().entries_for(root)["b.md"].clone();
        std::fs::write(dir.path().join("Docs/a.md"), "# Changed\nneedle [[Next]]").unwrap();
        let delta = refresh(root, Some(vec!["Docs/a.md".into()]), None, &cache);
        assert_eq!(delta.upserted.len(), 1);
        assert_eq!(SOURCE_READS.with(|reads| reads.get()), 3);
        assert!(Arc::ptr_eq(
            &untouched,
            &cache.read().entries_for(root)["b.md"]
        ));
        assert!(cache.read().backlinks(root, "Target.md").is_empty());
        assert_eq!(cache.read().backlinks(root, "Next.md"), vec!["Docs/a.md"]);
        std::fs::rename(dir.path().join("Docs"), dir.path().join("Renamed")).unwrap();
        let delta = refresh(
            root,
            Some(vec!["Docs".into(), "Renamed".into()]),
            None,
            &cache,
        );
        assert_eq!(delta.removed, vec!["Docs/a.md"]);
        assert_eq!(delta.upserted[0].relative_path, "Renamed/a.md");
        std::fs::remove_file(dir.path().join("b.md")).unwrap();
        assert_eq!(
            refresh(root, Some(vec!["b.md".into()]), None, &cache).removed,
            vec!["b.md"]
        );
    }
    #[test]
    fn replayed_path_batches_repair_deltas_the_frontend_never_published() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_str().unwrap();
        std::fs::write(dir.path().join("a.md"), "# Before").unwrap();
        let cache = RwLock::new(ScopedNoteIndex::default());
        refresh(root, None, None, &cache);
        std::fs::write(dir.path().join("a.md"), "# After").unwrap();
        let _rejected_by_ui = refresh(root, Some(vec!["a.md".into()]), None, &cache);
        let next = refresh(root, Some(vec!["a.md".into()]), None, &cache);
        assert_eq!(next.upserted[0].title, "After");
        std::fs::remove_file(dir.path().join("a.md")).unwrap();
        let _rejected_deletion = refresh(root, Some(vec!["a.md".into()]), None, &cache);
        let next = refresh(root, Some(vec!["a.md".into()]), None, &cache);
        assert!(next.removed.is_empty());
        assert_eq!(next.reconciled_paths, vec!["a.md"]);
    }

    #[test]
    fn encrypted_disposable_records_never_expose_text_and_corruption_recovers() {
        let dir = tempfile::tempdir().unwrap();
        let key = [7; 32];
        let text = "# Secret\nUnicode İ中😀 [[目标|别名]]";
        std::fs::write(
            dir.path().join("secret.md"),
            crypto::encrypt_bytes(&key, text.as_bytes()).unwrap(),
        )
        .unwrap();
        let note = read_indexed_note(dir.path(), "secret.md", Some(key), false, None).unwrap();
        assert_eq!(note.metadata.wikilinks_out, vec!["目标"]);
        let path = cache_path(dir.path(), "secret.md");
        let bytes = std::fs::read(&path).unwrap();
        assert!(crypto::is_encrypted_data(&bytes));
        assert!(!bytes.windows(6).any(|s| s == b"Secret"));
        assert!(read_indexed_note(dir.path(), "secret.md", None, false, None).is_err());
        std::fs::write(path, b"incomplete record").unwrap();
        assert_eq!(
            read_indexed_note(dir.path(), "secret.md", Some(key), false, None)
                .unwrap()
                .content,
            text
        );
    }
    #[test]
    fn obsolete_jobs_stop_before_io_and_unicode_link_scan_preserves_boundaries() {
        let cache = RwLock::new(ScopedNoteIndex::default());
        let old = cache.write().begin("/missing");
        cache.write().clear();
        assert!(
            refresh_index("/missing", None, None, &cache, old, false, &|_| {})
                .unwrap_err()
                .contains("superseded")
        );
        assert_eq!(
            extract_wikilinks("😀[[目标|名称]] [[é]] [[unclosed"),
            vec!["目标", "é"]
        );
    }
    #[test]
    #[ignore = "10k-note filesystem measurement; run explicitly at batch verification"]
    fn ten_thousand_note_edit_measurement() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_str().unwrap();
        for i in 0..10000 {
            std::fs::write(
                dir.path().join(format!("{i:05}.md")),
                format!("# Note {i}\nsearchable body [[Target]]"),
            )
            .unwrap();
        }
        let cache = RwLock::new(ScopedNoteIndex::default());
        let cold = std::time::Instant::now();
        refresh(root, None, None, &cache);
        let cold_ms = cold.elapsed().as_millis();
        SOURCE_READS.with(|reads| reads.set(0));
        std::fs::write(
            dir.path().join("05000.md"),
            "# Edited\nchanged searchable body",
        )
        .unwrap();
        let edit = std::time::Instant::now();
        let delta = refresh(root, Some(vec!["05000.md".into()]), None, &cache);
        let edit_ms = edit.elapsed().as_millis();
        let query = std::time::Instant::now();
        let page = search_page(&cache.read().entries_for(root), "searchable", 0, 50);
        println!("10k notes: cold={cold_ms}ms edit={edit_ms}ms source_reads={} delta_notes={} query={}ms page={} total={}", SOURCE_READS.with(|reads| reads.get()), delta.upserted.len(), query.elapsed().as_millis(), page.results.len(), page.total);
        assert_eq!(SOURCE_READS.with(|reads| reads.get()), 1);
        assert_eq!(delta.upserted.len(), 1);
        assert_eq!(page.results.len(), 50);
        assert_eq!(page.total, 10000);
        let snapshot = cache.read().entries_for(root);
        let text_bytes: usize = snapshot
            .values()
            .map(|n| n.content.len() + n.folded.len())
            .sum();
        let metadata_bytes =
            serde_json::to_vec(&snapshot.values().map(|n| &n.metadata).collect::<Vec<_>>())
                .unwrap()
                .len();
        let delta_bytes = serde_json::to_vec(&delta).unwrap().len();
        let lock_start = std::time::Instant::now();
        let _shared = cache.read().entries_for(root);
        println!("retained text={text_bytes}B full metadata={metadata_bytes}B delta={delta_bytes}B snapshot lock={}ns", lock_start.elapsed().as_nanos());
    }
}
