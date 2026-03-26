use crate::models::note::{NoteMetadata, SearchResult};
use crate::state::AppState;
use fuzzy_matcher::skim::SkimMatcherV2;
use fuzzy_matcher::FuzzyMatcher;
use sha2::{Digest, Sha256};
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::State;
use walkdir::WalkDir;

fn compute_hash(content: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(content.as_bytes());
    hex::encode(hasher.finalize())
}

fn system_time_to_ms(t: SystemTime) -> u64 {
    t.duration_since(UNIX_EPOCH).unwrap_or_default().as_millis() as u64
}

fn extract_wikilinks(content: &str) -> Vec<String> {
    let mut links = Vec::new();
    let chars: Vec<char> = content.chars().collect();
    let len = chars.len();
    let mut i = 0;
    while i + 1 < len {
        if chars[i] == '[' && chars[i + 1] == '[' {
            i += 2;
            let mut link = String::new();
            let mut found_end = false;
            while i < len {
                if chars[i] == ']' && i + 1 < len && chars[i + 1] == ']' {
                    i += 2;
                    found_end = true;
                    break;
                }
                link.push(chars[i]);
                i += 1;
            }
            if found_end && !link.is_empty() {
                let target = link.split('|').next().unwrap_or(&link).trim().to_string();
                links.push(target);
            }
        } else {
            i += 1;
        }
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
                            .map(|t| {
                                t.trim()
                                    .trim_matches('"')
                                    .trim_matches('\'')
                                    .to_string()
                            })
                            .filter(|t| !t.is_empty()),
                    );
                } else {
                    in_tags = true;
                }
            } else if in_tags {
                if let Some(tag) = line.trim().strip_prefix("- ") {
                    tags.push(
                        tag.trim()
                            .trim_matches('"')
                            .trim_matches('\'')
                            .to_string(),
                    );
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
    let lower_content = content.to_lowercase();
    let lower_query = query.to_lowercase();

    if let Some(pos) = lower_content.find(&lower_query) {
        let start = pos.saturating_sub(40);
        let end = (pos + query.len() + 80).min(content.len());
        let excerpt = &content[start..end];
        // Trim to word boundary
        let trimmed = excerpt.trim();
        if trimmed.len() > max_len {
            format!("{}...", &trimmed[..max_len])
        } else {
            trimmed.to_string()
        }
    } else {
        // Return first max_len chars
        let first = content.chars().take(max_len).collect::<String>();
        if content.len() > max_len {
            format!("{}...", first.trim())
        } else {
            first.trim().to_string()
        }
    }
}

#[tauri::command]
pub fn build_note_index(
    vault_path: String,
    state: State<AppState>,
) -> Result<Vec<NoteMetadata>, String> {
    let base = Path::new(&vault_path);
    let mut index: Vec<NoteMetadata> = Vec::new();

    for entry in WalkDir::new(base)
        .min_depth(1)
        .into_iter()
        .filter_entry(|e| {
            let name = e.file_name().to_string_lossy();
            !name.starts_with('.')
        })
    {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();

        if !path.is_file() {
            continue;
        }

        let ext = path
            .extension()
            .map(|e| e.to_string_lossy().to_lowercase())
            .unwrap_or_default();

        if ext != "md" {
            continue;
        }

        let relative_path = path
            .strip_prefix(base)
            .map_err(|e| e.to_string())?
            .to_string_lossy()
            .replace('\\', "/");

        let content = match std::fs::read_to_string(path) {
            Ok(c) => c,
            Err(_) => continue,
        };

        let filename = path
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_default();

        let title = extract_title(&content, &filename);
        let tags = extract_tags(&content);
        let wikilinks_out = extract_wikilinks(&content);
        let word_count = count_words(&content);
        let hash = compute_hash(&content);

        let modified_at = entry
            .metadata()
            .ok()
            .and_then(|m| m.modified().ok())
            .map(system_time_to_ms)
            .unwrap_or(0);

        index.push(NoteMetadata {
            relative_path,
            title,
            tags,
            wikilinks_out,
            modified_at,
            word_count,
            hash,
        });
    }

    *state.note_index.write() = index.clone();
    Ok(index)
}

#[tauri::command]
pub fn get_backlinks(
    _vault_path: String,
    relative_path: String,
    state: State<AppState>,
) -> Result<Vec<String>, String> {
    let index = state.note_index.read();

    // The note's "name" without extension for matching [[NoteTitle]] links
    let note_stem = Path::new(&relative_path)
        .file_stem()
        .map(|s| s.to_string_lossy().to_lowercase())
        .unwrap_or_default();

    let backlinks: Vec<String> = index
        .iter()
        .filter(|meta| {
            meta.relative_path != relative_path
                && meta.wikilinks_out.iter().any(|link| {
                    let link_lower = link.to_lowercase();
                    // Match by stem name or by relative path
                    link_lower == note_stem
                        || link_lower == relative_path.to_lowercase()
                        || link_lower
                            == relative_path
                                .to_lowercase()
                                .trim_end_matches(".md")
                                .to_string()
                })
        })
        .map(|meta| meta.relative_path.clone())
        .collect();

    Ok(backlinks)
}

#[tauri::command]
pub fn search_notes(
    vault_path: String,
    query: String,
    state: State<AppState>,
) -> Result<Vec<SearchResult>, String> {
    if query.trim().is_empty() {
        return Ok(vec![]);
    }

    let matcher = SkimMatcherV2::default();
    let index = state.note_index.read();
    let mut results: Vec<SearchResult> = Vec::new();
    let mut seen_paths: std::collections::HashSet<String> = std::collections::HashSet::new();

    // First pass: fuzzy match on titles
    for meta in index.iter() {
        if let Some(score) = matcher.fuzzy_match(&meta.title, &query) {
            seen_paths.insert(meta.relative_path.clone());
            results.push(SearchResult {
                relative_path: meta.relative_path.clone(),
                title: meta.title.clone(),
                excerpt: meta.title.clone(),
                score,
                match_type: "title".to_string(),
            });
        }
    }

    // Second pass: substring match on content for notes not already matched
    let base = Path::new(&vault_path);
    let query_lower = query.to_lowercase();

    for meta in index.iter() {
        if seen_paths.contains(&meta.relative_path) {
            continue;
        }

        let full_path = base.join(&meta.relative_path);
        let content = match std::fs::read_to_string(&full_path) {
            Ok(c) => c,
            Err(_) => continue,
        };

        if content.to_lowercase().contains(&query_lower) {
            let excerpt = make_excerpt(&content, &query, 120);
            results.push(SearchResult {
                relative_path: meta.relative_path.clone(),
                title: meta.title.clone(),
                excerpt,
                score: 10, // lower base score for content matches
                match_type: "content".to_string(),
            });
        }
    }

    // Sort by score descending
    results.sort_by(|a, b| b.score.cmp(&a.score));

    Ok(results)
}
