use crate::crypto;
use crate::models::note::{ConflictInfo, NoteContent, NoteFile, WriteResult};
use crate::state::AppState;
use base64::Engine as _;
use regex::{Captures, Regex};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::path::{Component, Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::State;
use walkdir::WalkDir;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RestoreConflictInfo {
    pub existing_relative_path: String,
    pub suggested_relative_path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TrashEntry {
    pub id: String,
    pub original_relative_path: String,
    pub deleted_at: u64,
    pub deleted_by_user_id: Option<String>,
    pub deleted_by_user_name: Option<String>,
    pub item_kind: String,
    pub extension: Option<String>,
    pub size: u64,
    pub root_name: String,
    pub restore_conflict: Option<RestoreConflictInfo>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredTrashEntry {
    id: String,
    original_relative_path: String,
    deleted_at: u64,
    deleted_by_user_id: Option<String>,
    deleted_by_user_name: Option<String>,
    item_kind: String,
    extension: Option<String>,
    size: u64,
    root_name: String,
    image_paths: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PathChangePreview {
    pub old_relative_path: String,
    pub new_relative_path: String,
    pub item_kind: String,
    pub operation: String,
    pub nested_item_count: usize,
    pub affected_reference_paths: Vec<String>,
    pub blocked_reason: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct FileReference {
    pub referenced_relative_path: String,
    pub source_relative_path: String,
    pub source_document_type: String,
    pub reference_kind: String,
    pub display_label: Option<String>,
    pub context: Option<String>,
}

fn is_ignored_dir_name(name: &str) -> bool {
    matches!(
        name,
        "node_modules" | "target" | "dist" | "dist-builds" | "build" | "flatpak-build" | "flatpak-repo"
    )
}

fn should_skip_walk_entry(name: &str, is_dir: bool) -> bool {
    name.starts_with('.') || (is_dir && is_ignored_dir_name(name))
}

fn compute_hash(content: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(content.as_bytes());
    hex::encode(hasher.finalize())
}

fn system_time_to_ms(t: SystemTime) -> u64 {
    t.duration_since(UNIX_EPOCH).unwrap_or_default().as_millis() as u64
}

fn is_allowed_extension(ext: &str) -> bool {
    matches!(
        ext,
        "md" | "canvas" | "kanban" | "png" | "jpg" | "jpeg" | "gif" | "webp" | "svg" | "bmp" | "ico" | "avif" | "pdf"
    )
}

fn normalize_relative_path(relative_path: &str) -> Result<PathBuf, String> {
    let mut out = PathBuf::new();

    for component in Path::new(relative_path).components() {
        match component {
            Component::Normal(part) => out.push(part),
            Component::CurDir => {}
            Component::ParentDir => {
                if !out.pop() {
                    return Err("Path escapes the vault root".into());
                }
            }
            Component::RootDir | Component::Prefix(_) => {
                return Err("Asset path must be relative to the vault root".into());
            }
        }
    }

    Ok(out)
}

fn resolve_vault_path(vault_path: &str, relative_path: &str) -> Result<PathBuf, String> {
    Ok(Path::new(vault_path).join(normalize_relative_path(relative_path)?))
}

fn overlay_relative_path(image_relative_path: &str) -> String {
    let encoded = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(image_relative_path);
    format!(".collab/image-overlays/{encoded}.json")
}

fn trash_entries_relative_dir() -> &'static str {
    ".collab/trash/entries"
}

fn trash_items_relative_dir() -> &'static str {
    ".collab/trash/items"
}

fn trash_entry_metadata_relative_path(entry_id: &str) -> String {
    format!("{}/{}.json", trash_entries_relative_dir(), entry_id)
}

fn trash_entry_payload_dir_relative_path(entry_id: &str) -> String {
    format!("{}/{}", trash_items_relative_dir(), entry_id)
}

fn is_image_extension(ext: &str) -> bool {
    matches!(
        ext,
        "png" | "jpg" | "jpeg" | "gif" | "webp" | "svg" | "bmp" | "ico" | "avif"
    )
}

fn guess_mime_type(relative_path: &str) -> &'static str {
    match Path::new(relative_path)
        .extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| ext.to_ascii_lowercase())
        .as_deref()
    {
        Some("png") => "image/png",
        Some("jpg") | Some("jpeg") => "image/jpeg",
        Some("gif") => "image/gif",
        Some("webp") => "image/webp",
        Some("svg") => "image/svg+xml",
        Some("bmp") => "image/bmp",
        Some("ico") => "image/x-icon",
        Some("avif") => "image/avif",
        Some("pdf") => "application/pdf",
        _ => "application/octet-stream",
    }
}

fn sanitize_file_name(name: &str) -> String {
    name.chars()
        .map(|ch| match ch {
            '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' => '_',
            _ => ch,
        })
        .collect::<String>()
        .trim()
        .trim_matches('.')
        .to_string()
}

fn write_vault_bytes(
    full_path: &Path,
    bytes: &[u8],
    key_opt: Option<[u8; 32]>,
) -> Result<(), String> {
    if let Some(parent) = full_path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }

    let bytes_to_write = if let Some(ref key) = key_opt {
        crypto::encrypt_bytes(key, bytes)?
    } else {
        bytes.to_vec()
    };

    let tmp_path = full_path.with_extension("tmp");
    std::fs::write(&tmp_path, &bytes_to_write).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp_path, full_path).map_err(|e| e.to_string())
}

fn read_vault_bytes(
    full_path: &Path,
    key_opt: Option<[u8; 32]>,
) -> Result<Vec<u8>, String> {
    let raw = std::fs::read(full_path).map_err(|e| e.to_string())?;
    if crypto::is_encrypted_data(&raw) {
        let key = key_opt
            .as_ref()
            .ok_or("Vault is locked — enter the password to unlock it")?;
        crypto::decrypt_bytes(key, &raw)
    } else {
        Ok(raw)
    }
}

fn read_trash_entry(vault_path: &str, entry_id: &str, key_opt: Option<[u8; 32]>) -> Result<StoredTrashEntry, String> {
    let metadata_path = resolve_vault_path(vault_path, &trash_entry_metadata_relative_path(entry_id))?;
    let bytes = read_vault_bytes(&metadata_path, key_opt)?;
    serde_json::from_slice(&bytes).map_err(|e| e.to_string())
}

fn write_trash_entry(vault_path: &str, entry: &StoredTrashEntry, key_opt: Option<[u8; 32]>) -> Result<(), String> {
    let metadata_path = resolve_vault_path(vault_path, &trash_entry_metadata_relative_path(&entry.id))?;
    let bytes = serde_json::to_vec_pretty(entry).map_err(|e| e.to_string())?;
    write_vault_bytes(&metadata_path, &bytes, key_opt)
}

fn payload_root_path(vault_path: &str, entry: &StoredTrashEntry) -> Result<PathBuf, String> {
    Ok(resolve_vault_path(vault_path, &trash_entry_payload_dir_relative_path(&entry.id))?.join(&entry.root_name))
}

fn parse_data_url(data_url: &str) -> Result<(&str, &str), String> {
    let payload = data_url
        .strip_prefix("data:")
        .ok_or("Generated image data is not a valid data URL")?;
    let (meta, encoded) = payload
        .split_once(',')
        .ok_or("Generated image data URL is malformed")?;
    let mime = meta
        .strip_suffix(";base64")
        .ok_or("Generated image data URL must be base64-encoded")?;
    Ok((mime, encoded))
}

fn extension_for_mime(mime: &str) -> &'static str {
    match mime {
        "image/jpeg" => "jpg",
        "image/webp" => "webp",
        _ => "png",
    }
}

fn unique_target_path(base_dir: &Path, file_name: &str) -> PathBuf {
    let stem = Path::new(file_name)
        .file_stem()
        .and_then(|s| s.to_str())
        .filter(|s| !s.is_empty())
        .unwrap_or("image");
    let ext = Path::new(file_name)
        .extension()
        .and_then(|e| e.to_str())
        .filter(|s| !s.is_empty());

    let mut candidate = base_dir.join(file_name);
    if !candidate.exists() {
        return candidate;
    }

    let mut index = 2;
    loop {
        let name = match ext {
            Some(ext) => format!("{stem}-{index}.{ext}"),
            None => format!("{stem}-{index}"),
        };
        candidate = base_dir.join(name);
        if !candidate.exists() {
            return candidate;
        }
        index += 1;
    }
}

fn path_matches_or_descends(candidate: &str, target: &str) -> bool {
    candidate == target || candidate.starts_with(&format!("{target}/"))
}

fn remap_path(candidate: &str, old_path: &str, new_path: &str) -> Option<String> {
    if candidate == old_path {
        return Some(new_path.to_string());
    }
    candidate
        .strip_prefix(&format!("{old_path}/"))
        .map(|suffix| format!("{new_path}/{suffix}"))
}

fn split_path_suffix(value: &str) -> (&str, &str) {
    match value.find(['?', '#']) {
        Some(index) => (&value[..index], &value[index..]),
        None => (value, ""),
    }
}

fn relative_path_from_dir(base_dir: &Path, target: &Path) -> String {
    let base_parts: Vec<_> = base_dir
        .components()
        .filter_map(|component| match component {
            Component::Normal(part) => Some(part.to_string_lossy().to_string()),
            _ => None,
        })
        .collect();
    let target_parts: Vec<_> = target
        .components()
        .filter_map(|component| match component {
            Component::Normal(part) => Some(part.to_string_lossy().to_string()),
            _ => None,
        })
        .collect();

    let mut common = 0;
    while common < base_parts.len()
        && common < target_parts.len()
        && base_parts[common] == target_parts[common]
    {
        common += 1;
    }

    let mut parts: Vec<String> = Vec::new();
    for _ in common..base_parts.len() {
        parts.push("..".into());
    }
    for part in target_parts.iter().skip(common) {
        parts.push(part.clone());
    }

    if parts.is_empty() {
        ".".into()
    } else {
        parts.join("/")
    }
}

fn format_rewritten_target(note_relative_path: &str, original_target_path: &str, rewritten_path: &str, suffix: &str) -> String {
    if original_target_path.starts_with('/') {
        return format!("/{rewritten_path}{suffix}");
    }

    let note_dir = normalize_relative_path(note_relative_path)
        .ok()
        .and_then(|path| path.parent().map(|parent| parent.to_path_buf()))
        .unwrap_or_default();
    let relative = relative_path_from_dir(&note_dir, Path::new(rewritten_path));
    format!("{relative}{suffix}")
}

fn rewrite_target_reference(
    raw_target: &str,
    note_relative_path: &str,
    old_path: &str,
    new_path: Option<&str>,
) -> Option<Option<String>> {
    let trimmed = raw_target.trim();
    if trimmed.is_empty()
        || trimmed.starts_with("data:")
        || trimmed.starts_with("blob:")
        || trimmed.starts_with("//")
        || trimmed.contains("://")
    {
        return None;
    }

    let (path_part, suffix) = split_path_suffix(trimmed);
    let resolved = if path_part.starts_with('/') {
        normalize_relative_path(path_part).ok()?
    } else {
        let note_dir = note_relative_path
            .rsplit_once('/')
            .map(|(dir, _)| dir)
            .unwrap_or("");
        normalize_relative_path(
            if note_dir.is_empty() {
                path_part.to_string()
            } else {
                format!("{note_dir}/{path_part}")
            }
            .as_str(),
        )
        .ok()?
    };

    let resolved_str = resolved.to_string_lossy().replace('\\', "/");
    if !path_matches_or_descends(&resolved_str, old_path) {
        return None;
    }

    match new_path {
      Some(next_path) => {
        let rewritten = remap_path(&resolved_str, old_path, next_path)?;
        Some(Some(format_rewritten_target(note_relative_path, path_part, &rewritten, suffix)))
      }
      None => Some(None),
    }
}

fn replace_markdown_references(
    content: &str,
    note_relative_path: &str,
    old_path: &str,
    new_path: Option<&str>,
) -> String {
    let image_md = Regex::new(r"!\[([^\]\n]*?)\]\(([^)\n]*?)\)").unwrap();
    let image_wiki = Regex::new(r"!\[\[([^\]|]+?)(\|([^\]]+?))?\]\]").unwrap();
    let link_md = Regex::new(r"\[([^\]\n]+?)\]\(([^)\n]*?)\)").unwrap();
    let wiki = Regex::new(r"\[\[([^\]|]+?)(\|([^\]]+?))?\]\]").unwrap();

    let content = image_md.replace_all(content, |caps: &Captures| {
        match rewrite_target_reference(&caps[2], note_relative_path, old_path, new_path) {
            Some(Some(next_target)) => format!("![{}]({next_target})", &caps[1]),
            Some(None) => String::new(),
            None => caps[0].to_string(),
        }
    });

    let content = image_wiki.replace_all(&content, |caps: &Captures| {
        match rewrite_target_reference(&caps[1], note_relative_path, old_path, new_path) {
            Some(Some(next_target)) => {
                if let Some(label) = caps.get(3) {
                    format!("![[{next_target}|{}]]", label.as_str())
                } else {
                    format!("![[{next_target}]]")
                }
            }
            Some(None) => String::new(),
            None => caps[0].to_string(),
        }
    });

    let content_string = content.into_owned();
    let content = link_md.replace_all(&content_string, |caps: &Captures| {
        let full = caps.get(0).map(|m| m.as_str()).unwrap_or_default();
        if full.starts_with("![") {
            return full.to_string();
        }
        match rewrite_target_reference(&caps[2], note_relative_path, old_path, new_path) {
            Some(Some(next_target)) => format!("[{}]({next_target})", &caps[1]),
            Some(None) => caps[1].to_string(),
            None => full.to_string(),
        }
    });

    let content_string = content.into_owned();
    wiki.replace_all(&content_string, |caps: &Captures| {
        let full = caps.get(0).map(|m| m.as_str()).unwrap_or_default();
        if full.starts_with("![[") {
            return full.to_string();
        }
        match rewrite_target_reference(&caps[1], note_relative_path, old_path, new_path) {
            Some(Some(next_target)) => {
                if let Some(label) = caps.get(3) {
                    format!("[[{next_target}|{}]]", label.as_str())
                } else {
                    format!("[[{next_target}]]")
                }
            }
            Some(None) => caps.get(3).map(|label| label.as_str().to_string()).unwrap_or_else(|| caps[1].to_string()),
            None => full.to_string(),
        }
    }).into_owned()
}

#[derive(Debug, Clone)]
struct VaultReferenceLookupEntry {
    relative_path: String,
    name: String,
    title: String,
    is_note: bool,
}

fn build_reference_lookup(entries: &[NoteFile]) -> Vec<VaultReferenceLookupEntry> {
    entries
        .iter()
        .filter(|entry| !entry.is_folder)
        .map(|entry| {
            let name = entry.name.clone();
            let title = Path::new(&entry.relative_path)
                .file_stem()
                .and_then(|stem| stem.to_str())
                .unwrap_or(&name)
                .to_string();
            VaultReferenceLookupEntry {
                relative_path: entry.relative_path.clone(),
                name,
                title,
                is_note: entry.extension.eq_ignore_ascii_case("md"),
            }
        })
        .collect()
}

fn resolve_vault_note_target_reference(
    raw_target: &str,
    note_relative_path: &str,
) -> Option<String> {
    let trimmed = raw_target.trim();
    if trimmed.is_empty()
        || trimmed.starts_with("data:")
        || trimmed.starts_with("blob:")
        || trimmed.starts_with("//")
        || trimmed.contains("://")
    {
        return None;
    }

    let (path_part, _) = split_path_suffix(trimmed);
    let resolved = if path_part.starts_with('/') {
        normalize_relative_path(path_part).ok()?
    } else {
        let note_dir = note_relative_path
            .rsplit_once('/')
            .map(|(dir, _)| dir)
            .unwrap_or("");
        normalize_relative_path(
            if note_dir.is_empty() {
                path_part.to_string()
            } else {
                format!("{note_dir}/{path_part}")
            }
            .as_str(),
        )
        .ok()?
    };

    Some(resolved.to_string_lossy().replace('\\', "/"))
}

fn resolve_vault_wikilink_reference(
    raw_target: &str,
    note_relative_path: &str,
    lookup: &[VaultReferenceLookupEntry],
) -> Option<String> {
    let trimmed = raw_target.trim();
    if trimmed.is_empty() {
        return None;
    }

    let normalized = normalize_relative_path(split_path_suffix(trimmed).0)
        .ok()?
        .to_string_lossy()
        .replace('\\', "/");
    let normalized_lower = normalized.to_ascii_lowercase();

    if let Some(entry) = lookup
        .iter()
        .find(|entry| entry.relative_path.eq_ignore_ascii_case(&normalized))
    {
        return Some(entry.relative_path.clone());
    }

    if let Some(path_like) = resolve_vault_note_target_reference(trimmed, note_relative_path) {
        if let Some(entry) = lookup
            .iter()
            .find(|entry| entry.relative_path.eq_ignore_ascii_case(&path_like))
        {
            return Some(entry.relative_path.clone());
        }
    }

    if let Some(entry) = lookup
        .iter()
        .find(|entry| entry.name.eq_ignore_ascii_case(&normalized))
    {
        return Some(entry.relative_path.clone());
    }

    if !normalized.contains('/') && Path::new(&normalized).extension().is_none() {
        if let Some(entry) = lookup
            .iter()
            .find(|entry| entry.is_note && entry.title.eq_ignore_ascii_case(&normalized_lower))
        {
            return Some(entry.relative_path.clone());
        }

        let matching_titles: Vec<_> = lookup
            .iter()
            .filter(|entry| entry.title.eq_ignore_ascii_case(&normalized_lower))
            .collect();
        if matching_titles.len() == 1 {
            return Some(matching_titles[0].relative_path.clone());
        }
    }

    None
}

fn snippet_for_reference_context(label: &str, target: &str) -> String {
    if label.trim().is_empty() {
        target.to_string()
    } else {
        format!("{label} -> {target}")
    }
}

fn collect_note_references(
    content: &str,
    note_relative_path: &str,
    lookup: &[VaultReferenceLookupEntry],
    target_path: &str,
) -> Vec<FileReference> {
    let image_md = Regex::new(r"!\[([^\]\n]*?)\]\(([^)\n]*?)\)").unwrap();
    let image_wiki = Regex::new(r"!\[\[([^\]|]+?)(\|([^\]]+?))?\]\]").unwrap();
    let link_md = Regex::new(r"\[([^\]\n]+?)\]\(([^)\n]*?)\)").unwrap();
    let wiki = Regex::new(r"\[\[([^\]|]+?)(\|([^\]]+?))?\]\]").unwrap();
    let mut references = Vec::new();

    for caps in image_md.captures_iter(content) {
        let Some(resolved) = resolve_vault_note_target_reference(&caps[2], note_relative_path) else {
            continue;
        };
        if !path_matches_or_descends(&resolved, target_path) {
            continue;
        }
        let label = caps.get(1).map(|value| value.as_str().trim()).unwrap_or_default();
        references.push(FileReference {
            referenced_relative_path: resolved,
            source_relative_path: note_relative_path.to_string(),
            source_document_type: "note".into(),
            reference_kind: "note-markdown-link".into(),
            display_label: if label.is_empty() { None } else { Some(label.to_string()) },
            context: Some(snippet_for_reference_context(label, &caps[2])),
        });
    }

    for caps in image_wiki.captures_iter(content) {
        let Some(resolved) = resolve_vault_wikilink_reference(&caps[1], note_relative_path, lookup) else {
            continue;
        };
        if !path_matches_or_descends(&resolved, target_path) {
            continue;
        }
        let label = caps.get(3).map(|value| value.as_str().trim()).unwrap_or_default();
        references.push(FileReference {
            referenced_relative_path: resolved,
            source_relative_path: note_relative_path.to_string(),
            source_document_type: "note".into(),
            reference_kind: "note-wikilink".into(),
            display_label: if label.is_empty() { Some(caps[1].to_string()) } else { Some(label.to_string()) },
            context: Some(snippet_for_reference_context(
                if label.is_empty() { &caps[1] } else { label },
                &caps[1],
            )),
        });
    }

    for caps in link_md.captures_iter(content) {
        let Some(full) = caps.get(0) else { continue; };
        if full.as_str().starts_with("![") {
            continue;
        }
        let Some(resolved) = resolve_vault_note_target_reference(&caps[2], note_relative_path) else {
            continue;
        };
        if !path_matches_or_descends(&resolved, target_path) {
            continue;
        }
        let label = caps.get(1).map(|value| value.as_str().trim()).unwrap_or_default();
        references.push(FileReference {
            referenced_relative_path: resolved,
            source_relative_path: note_relative_path.to_string(),
            source_document_type: "note".into(),
            reference_kind: "note-markdown-link".into(),
            display_label: if label.is_empty() { None } else { Some(label.to_string()) },
            context: Some(snippet_for_reference_context(label, &caps[2])),
        });
    }

    for caps in wiki.captures_iter(content) {
        let Some(full) = caps.get(0) else { continue; };
        if full.as_str().starts_with("![[") {
            continue;
        }
        let Some(resolved) = resolve_vault_wikilink_reference(&caps[1], note_relative_path, lookup) else {
            continue;
        };
        if !path_matches_or_descends(&resolved, target_path) {
            continue;
        }
        let label = caps.get(3).map(|value| value.as_str().trim()).unwrap_or_default();
        references.push(FileReference {
            referenced_relative_path: resolved,
            source_relative_path: note_relative_path.to_string(),
            source_document_type: "note".into(),
            reference_kind: "note-wikilink".into(),
            display_label: if label.is_empty() { Some(caps[1].to_string()) } else { Some(label.to_string()) },
            context: Some(snippet_for_reference_context(
                if label.is_empty() { &caps[1] } else { label },
                &caps[1],
            )),
        });
    }

    references
}

fn collect_kanban_file_references(
    content: &str,
    source_relative_path: &str,
    target_path: &str,
) -> Result<Vec<FileReference>, String> {
    let value: serde_json::Value = serde_json::from_str(content).map_err(|e| e.to_string())?;
    let Some(columns) = value.get("columns").and_then(|columns| columns.as_array()) else {
        return Ok(Vec::new());
    };

    let mut references = Vec::new();
    for column in columns {
        let column_title = column
            .get("title")
            .and_then(|value| value.as_str())
            .unwrap_or("Column");
        let Some(cards) = column.get("cards").and_then(|cards| cards.as_array()) else {
            continue;
        };
        for card in cards {
            let card_title = card
                .get("title")
                .and_then(|value| value.as_str())
                .unwrap_or("Card");
            let attachment_paths = card
                .get("attachmentPaths")
                .and_then(|paths| paths.as_array())
                .map(|paths| paths.iter().filter_map(|value| value.as_str()).collect::<Vec<_>>())
                .unwrap_or_default();

            for attachment_path in attachment_paths {
                if !path_matches_or_descends(attachment_path, target_path) {
                    continue;
                }
                references.push(FileReference {
                    referenced_relative_path: attachment_path.to_string(),
                    source_relative_path: source_relative_path.to_string(),
                    source_document_type: "kanban".into(),
                    reference_kind: "kanban-attachment".into(),
                    display_label: Some(card_title.to_string()),
                    context: Some(column_title.to_string()),
                });
            }
        }
    }

    Ok(references)
}

fn collect_canvas_file_references(
    content: &str,
    source_relative_path: &str,
    target_path: &str,
) -> Result<Vec<FileReference>, String> {
    let value: serde_json::Value = serde_json::from_str(content).map_err(|e| e.to_string())?;
    let Some(nodes) = value.get("nodes").and_then(|nodes| nodes.as_array()) else {
        return Ok(Vec::new());
    };

    let mut references = Vec::new();
    for node in nodes {
        let Some(node_type) = node.get("type").and_then(|value| value.as_str()) else {
            continue;
        };
        if !matches!(node_type, "file" | "note") {
            continue;
        }
        let Some(relative_path) = node.get("relativePath").and_then(|value| value.as_str()) else {
            continue;
        };
        if !path_matches_or_descends(relative_path, target_path) {
            continue;
        }
        references.push(FileReference {
            referenced_relative_path: relative_path.to_string(),
            source_relative_path: source_relative_path.to_string(),
            source_document_type: "canvas".into(),
            reference_kind: if node_type == "note" {
                "canvas-note-node".into()
            } else {
                "canvas-file-node".into()
            },
            display_label: node
                .get("id")
                .and_then(|value| value.as_str())
                .map(|value| value.to_string()),
            context: Some(if node_type == "note" {
                "Note card".to_string()
            } else {
                "File card".to_string()
            }),
        });
    }

    Ok(references)
}

fn list_file_references_inner(
    vault_path: &str,
    relative_path: &str,
    key_opt: Option<[u8; 32]>,
) -> Result<Vec<FileReference>, String> {
    let target_path = normalize_relative_path(relative_path)?
        .to_string_lossy()
        .replace('\\', "/");
    let entries = collect_entries(vault_path)?;
    let lookup = build_reference_lookup(&entries);
    let mut references = Vec::new();

    for entry in entries {
        if entry.is_folder || entry.relative_path == target_path || path_matches_or_descends(&entry.relative_path, &target_path) {
            continue;
        }

        let note = match entry.extension.as_str() {
            "md" | "kanban" | "canvas" => {
                read_note_from_path(&resolve_vault_path(vault_path, &entry.relative_path)?, &entry.relative_path, key_opt)?
            }
            _ => continue,
        };

        let mut next = match entry.extension.as_str() {
            "md" => collect_note_references(&note.content, &entry.relative_path, &lookup, &target_path),
            "kanban" => collect_kanban_file_references(&note.content, &entry.relative_path, &target_path)?,
            "canvas" => collect_canvas_file_references(&note.content, &entry.relative_path, &target_path)?,
            _ => Vec::new(),
        };
        references.append(&mut next);
    }

    references.sort_by(|a, b| {
        a.source_relative_path
            .cmp(&b.source_relative_path)
            .then(a.reference_kind.cmp(&b.reference_kind))
            .then(a.display_label.cmp(&b.display_label))
    });
    Ok(references)
}

fn rewrite_kanban_references(content: &str, old_path: &str, new_path: Option<&str>) -> Result<String, String> {
    let mut value: serde_json::Value = serde_json::from_str(content).map_err(|e| e.to_string())?;
    let Some(columns) = value.get_mut("columns").and_then(|columns| columns.as_array_mut()) else {
        return Ok(content.to_string());
    };

    for column in columns {
        let Some(cards) = column.get_mut("cards").and_then(|cards| cards.as_array_mut()) else {
            continue;
        };
        for card in cards {
            let Some(card_obj) = card.as_object_mut() else { continue; };

            let mut remaining_paths: Vec<String> = card_obj
                .get("attachmentPaths")
                .and_then(|paths| paths.as_array())
                .map(|paths| {
                    paths.iter().filter_map(|value| value.as_str()).filter_map(|path| {
                        if !path_matches_or_descends(path, old_path) {
                            return Some(path.to_string());
                        }
                        new_path.and_then(|next_path| remap_path(path, old_path, next_path))
                    }).collect()
                })
                .unwrap_or_default();

            if let Some(path) = card_obj.get("relativePath").and_then(|value| value.as_str()) {
                if !remaining_paths.iter().any(|candidate| candidate == path) && !path_matches_or_descends(path, old_path) {
                    remaining_paths.push(path.to_string());
                }
            }

            if remaining_paths.is_empty() {
                card_obj.remove("attachmentPaths");
                card_obj.remove("relativePath");
            } else {
                let primary = remaining_paths.first().cloned();
                card_obj.insert(
                    "attachmentPaths".into(),
                    serde_json::Value::Array(remaining_paths.into_iter().map(serde_json::Value::String).collect()),
                );
                if let Some(primary_path) = primary {
                    card_obj.insert("relativePath".into(), serde_json::Value::String(primary_path));
                }
            }
        }
    }

    serde_json::to_string_pretty(&value).map_err(|e| e.to_string())
}

fn rewrite_canvas_references(content: &str, old_path: &str, new_path: Option<&str>) -> Result<String, String> {
    let mut value: serde_json::Value = serde_json::from_str(content).map_err(|e| e.to_string())?;
    let Some(nodes) = value.get_mut("nodes").and_then(|nodes| nodes.as_array_mut()) else {
        return Ok(content.to_string());
    };

    let mut next_nodes = Vec::with_capacity(nodes.len());
    for mut node in nodes.drain(..) {
        let should_keep = if let Some(node_obj) = node.as_object_mut() {
            let node_type = node_obj.get("type").and_then(|value| value.as_str()).unwrap_or_default();
            if matches!(node_type, "file" | "note") {
                if let Some(relative_path) = node_obj.get("relativePath").and_then(|value| value.as_str()) {
                    if path_matches_or_descends(relative_path, old_path) {
                        if let Some(next_path) = new_path.and_then(|next| remap_path(relative_path, old_path, next)) {
                            node_obj.insert("relativePath".into(), serde_json::Value::String(next_path));
                            true
                        } else {
                            false
                        }
                    } else {
                        true
                    }
                } else {
                    true
                }
            } else {
                true
            }
        } else {
            true
        };

        if should_keep {
            next_nodes.push(node);
        }
    }
    *nodes = next_nodes;

    serde_json::to_string_pretty(&value).map_err(|e| e.to_string())
}

fn move_image_overlay_if_needed(vault_path: &str, old_path: &str, new_path: &str) -> Result<(), String> {
    let old_overlay = resolve_vault_path(vault_path, &overlay_relative_path(old_path))?;
    if !old_overlay.exists() {
        return Ok(());
    }
    let new_overlay = resolve_vault_path(vault_path, &overlay_relative_path(new_path))?;
    if let Some(parent) = new_overlay.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    std::fs::rename(old_overlay, new_overlay).map_err(|e| e.to_string())
}

fn delete_image_overlay_if_needed(vault_path: &str, image_relative_path: &str) -> Result<(), String> {
    let overlay = resolve_vault_path(vault_path, &overlay_relative_path(image_relative_path))?;
    if overlay.exists() {
        std::fs::remove_file(overlay).map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn gather_image_paths_for_entry(vault_path: &str, relative_path: &str) -> Result<Vec<String>, String> {
    let full_path = resolve_vault_path(vault_path, relative_path)?;
    let metadata = std::fs::metadata(&full_path).map_err(|e| e.to_string())?;
    if metadata.is_file() {
        let ext = Path::new(relative_path)
            .extension()
            .and_then(|value| value.to_str())
            .map(|value| value.to_ascii_lowercase())
            .unwrap_or_default();
        return Ok(if is_image_extension(&ext) {
            vec![relative_path.to_string()]
        } else {
            Vec::new()
        });
    }

    let mut image_paths = Vec::new();
    for entry in WalkDir::new(&full_path).into_iter() {
        let entry = entry.map_err(|e| e.to_string())?;
        if !entry.file_type().is_file() {
            continue;
        }
        let ext = entry
            .path()
            .extension()
            .and_then(|value| value.to_str())
            .map(|value| value.to_ascii_lowercase())
            .unwrap_or_default();
        if !is_image_extension(&ext) {
            continue;
        }
        let relative = entry
            .path()
            .strip_prefix(Path::new(vault_path))
            .map_err(|e| e.to_string())?
            .to_string_lossy()
            .replace('\\', "/");
        image_paths.push(relative);
    }

    Ok(image_paths)
}

fn compute_total_size(full_path: &Path) -> Result<u64, String> {
    let metadata = std::fs::metadata(full_path).map_err(|e| e.to_string())?;
    if metadata.is_file() {
        return Ok(metadata.len());
    }

    let mut size = 0;
    for entry in WalkDir::new(full_path).into_iter() {
        let entry = entry.map_err(|e| e.to_string())?;
        if entry.file_type().is_file() {
            size += entry.metadata().map_err(|e| e.to_string())?.len();
        }
    }
    Ok(size)
}

fn count_nested_items(full_path: &Path) -> Result<usize, String> {
    let metadata = std::fs::metadata(full_path).map_err(|e| e.to_string())?;
    if metadata.is_file() {
        return Ok(1);
    }

    let mut count = 0;
    for entry in WalkDir::new(full_path).min_depth(1).into_iter() {
        let _ = entry.map_err(|e| e.to_string())?;
        count += 1;
    }
    Ok(count)
}

fn generate_trash_entry_id(relative_path: &str) -> String {
    let ts = system_time_to_ms(SystemTime::now());
    let hash = compute_hash(&format!("{relative_path}:{ts}"));
    format!("{ts}-{}", &hash[..10])
}

fn suggest_available_relative_path(vault_path: &str, desired_relative_path: &str) -> Result<String, String> {
    let desired = normalize_relative_path(desired_relative_path)?;
    let desired_full = Path::new(vault_path).join(&desired);
    if !desired_full.exists() {
        return Ok(desired.to_string_lossy().replace('\\', "/"));
    }

    let parent = desired.parent().map(Path::to_path_buf).unwrap_or_default();
    let stem = desired
        .file_stem()
        .and_then(|value| value.to_str())
        .filter(|value| !value.is_empty())
        .unwrap_or("item");
    let ext = desired.extension().and_then(|value| value.to_str()).filter(|value| !value.is_empty());
    let mut index = 2;
    loop {
        let name = match ext {
            Some(ext) => format!("{stem}-restored-{index}.{ext}"),
            None => format!("{stem}-restored-{index}"),
        };
        let candidate = if parent.as_os_str().is_empty() {
            PathBuf::from(&name)
        } else {
            parent.join(&name)
        };
        if !Path::new(vault_path).join(&candidate).exists() {
            return Ok(candidate.to_string_lossy().replace('\\', "/"));
        }
        index += 1;
    }
}

fn move_path_to_trash(
    vault_path: &str,
    relative_path: &str,
    deleted_by_user_id: Option<String>,
    deleted_by_user_name: Option<String>,
    key_opt: Option<[u8; 32]>,
) -> Result<TrashEntry, String> {
    let normalized = normalize_relative_path(relative_path)?;
    if normalized == PathBuf::from("Pictures") {
        return Err("The Pictures folder is managed by the app and cannot be deleted".into());
    }

    let full_path = Path::new(vault_path).join(&normalized);
    let metadata = std::fs::metadata(&full_path).map_err(|e| e.to_string())?;
    let root_name = normalized
        .file_name()
        .and_then(|value| value.to_str())
        .map(|value| value.to_string())
        .ok_or("Invalid path")?;
    let extension = if metadata.is_file() {
        Path::new(relative_path)
            .extension()
            .and_then(|value| value.to_str())
            .map(|value| value.to_ascii_lowercase())
    } else {
        None
    };
    let entry = StoredTrashEntry {
        id: generate_trash_entry_id(relative_path),
        original_relative_path: normalized.to_string_lossy().replace('\\', "/"),
        deleted_at: system_time_to_ms(SystemTime::now()),
        deleted_by_user_id,
        deleted_by_user_name,
        item_kind: if metadata.is_dir() { "folder".into() } else { "file".into() },
        extension,
        size: compute_total_size(&full_path)?,
        root_name: root_name.clone(),
        image_paths: gather_image_paths_for_entry(vault_path, relative_path)?,
    };

    let payload_dir = resolve_vault_path(vault_path, &trash_entry_payload_dir_relative_path(&entry.id))?;
    std::fs::create_dir_all(&payload_dir).map_err(|e| e.to_string())?;
    std::fs::rename(&full_path, payload_dir.join(root_name)).map_err(|e| e.to_string())?;
    write_trash_entry(vault_path, &entry, key_opt)?;

    Ok(TrashEntry {
        id: entry.id,
        original_relative_path: entry.original_relative_path,
        deleted_at: entry.deleted_at,
        deleted_by_user_id: entry.deleted_by_user_id,
        deleted_by_user_name: entry.deleted_by_user_name,
        item_kind: entry.item_kind,
        extension: entry.extension,
        size: entry.size,
        root_name: entry.root_name,
        restore_conflict: None,
    })
}

fn list_trash_entries_inner(vault_path: &str, key_opt: Option<[u8; 32]>) -> Result<Vec<TrashEntry>, String> {
    let entries_dir = resolve_vault_path(vault_path, trash_entries_relative_dir())?;
    if !entries_dir.exists() {
        return Ok(Vec::new());
    }

    let mut items = Vec::new();
    for entry in std::fs::read_dir(&entries_dir).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        if !entry.file_type().map_err(|e| e.to_string())?.is_file() {
            continue;
        }
        let entry_path = entry.path();
        let Some(file_stem) = entry_path.file_stem().and_then(|value| value.to_str()).map(|value| value.to_string()) else {
            continue;
        };
        let stored = read_trash_entry(vault_path, &file_stem, key_opt)?;
        let original_full = Path::new(vault_path).join(normalize_relative_path(&stored.original_relative_path)?);
        let restore_conflict = if original_full.exists() {
            Some(RestoreConflictInfo {
                existing_relative_path: stored.original_relative_path.clone(),
                suggested_relative_path: suggest_available_relative_path(vault_path, &stored.original_relative_path)?,
            })
        } else {
            None
        };
        items.push(TrashEntry {
            id: stored.id,
            original_relative_path: stored.original_relative_path,
            deleted_at: stored.deleted_at,
            deleted_by_user_id: stored.deleted_by_user_id,
            deleted_by_user_name: stored.deleted_by_user_name,
            item_kind: stored.item_kind,
            extension: stored.extension,
            size: stored.size,
            root_name: stored.root_name,
            restore_conflict,
        });
    }

    items.sort_by(|a, b| b.deleted_at.cmp(&a.deleted_at));
    Ok(items)
}

fn remap_image_overlays_for_restore(vault_path: &str, entry: &StoredTrashEntry, restored_relative_path: &str) {
    for image_path in &entry.image_paths {
        if let Some(remapped) = remap_path(image_path, &entry.original_relative_path, restored_relative_path) {
            let _ = move_image_overlay_if_needed(vault_path, image_path, &remapped);
        }
    }
}

fn purge_image_overlays(vault_path: &str, entry: &StoredTrashEntry) {
    for image_path in &entry.image_paths {
        let _ = delete_image_overlay_if_needed(vault_path, image_path);
    }
}

fn restore_trashed_item_inner(
    vault_path: &str,
    entry_id: &str,
    target_relative_path: Option<String>,
    key_opt: Option<[u8; 32]>,
) -> Result<String, String> {
    let entry = read_trash_entry(vault_path, entry_id, key_opt)?;
    let restore_target = target_relative_path.unwrap_or_else(|| entry.original_relative_path.clone());
    let target_normalized = normalize_relative_path(&restore_target)?;
    let target_full = Path::new(vault_path).join(&target_normalized);
    if target_full.exists() {
        return Err(format!(
            "Restore target '{}' already exists",
            target_normalized.to_string_lossy().replace('\\', "/")
        ));
    }

    let payload_root = payload_root_path(vault_path, &entry)?;
    if !payload_root.exists() {
        return Err("Trashed item payload is missing".into());
    }
    if let Some(parent) = target_full.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    std::fs::rename(&payload_root, &target_full).map_err(|e| e.to_string())?;
    remap_image_overlays_for_restore(
        vault_path,
        &entry,
        &target_normalized.to_string_lossy().replace('\\', "/"),
    );

    let payload_dir = resolve_vault_path(vault_path, &trash_entry_payload_dir_relative_path(&entry.id))?;
    if payload_dir.exists() {
        let _ = std::fs::remove_dir(&payload_dir);
    }
    let metadata_path = resolve_vault_path(vault_path, &trash_entry_metadata_relative_path(&entry.id))?;
    if metadata_path.exists() {
        std::fs::remove_file(metadata_path).map_err(|e| e.to_string())?;
    }

    Ok(target_normalized.to_string_lossy().replace('\\', "/"))
}

fn purge_trashed_item_inner(
    vault_path: &str,
    entry_id: &str,
    remove_references: bool,
    key_opt: Option<[u8; 32]>,
) -> Result<(), String> {
    let entry = read_trash_entry(vault_path, entry_id, key_opt)?;
    if remove_references {
        rewrite_all_references(vault_path, &entry.original_relative_path, None, key_opt)?;
    }
    purge_image_overlays(vault_path, &entry);

    let payload_dir = resolve_vault_path(vault_path, &trash_entry_payload_dir_relative_path(&entry.id))?;
    if payload_dir.exists() {
        std::fs::remove_dir_all(&payload_dir).map_err(|e| e.to_string())?;
    }
    let metadata_path = resolve_vault_path(vault_path, &trash_entry_metadata_relative_path(&entry.id))?;
    if metadata_path.exists() {
        std::fs::remove_file(&metadata_path).map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn purge_all_trash_inner(vault_path: &str, key_opt: Option<[u8; 32]>) -> Result<(), String> {
    let items = list_trash_entries_inner(vault_path, key_opt)?;
    for entry in items {
        purge_trashed_item_inner(vault_path, &entry.id, false, key_opt)?;
    }
    Ok(())
}

fn collect_reference_impacts(
    vault_path: &str,
    old_path: &str,
    new_path: &str,
    key_opt: Option<[u8; 32]>,
) -> Result<Vec<String>, String> {
    let entries = collect_entries(vault_path)?;
    let mut impacted = Vec::new();

    for entry in entries {
        if entry.is_folder || entry.relative_path == old_path || path_matches_or_descends(&entry.relative_path, old_path) {
            continue;
        }

        let impacted_here = match entry.extension.as_str() {
            "md" => {
                let note = read_note_from_path(&resolve_vault_path(vault_path, &entry.relative_path)?, &entry.relative_path, key_opt)?;
                replace_markdown_references(&note.content, &entry.relative_path, old_path, Some(new_path)) != note.content
            }
            "kanban" => {
                let note = read_note_from_path(&resolve_vault_path(vault_path, &entry.relative_path)?, &entry.relative_path, key_opt)?;
                rewrite_kanban_references(&note.content, old_path, Some(new_path))? != note.content
            }
            "canvas" => {
                let note = read_note_from_path(&resolve_vault_path(vault_path, &entry.relative_path)?, &entry.relative_path, key_opt)?;
                rewrite_canvas_references(&note.content, old_path, Some(new_path))? != note.content
            }
            _ => false,
        };

        if impacted_here {
            impacted.push(entry.relative_path);
        }
    }

    impacted.sort();
    Ok(impacted)
}

fn preview_path_change_inner(
    vault_path: &str,
    old_path: &str,
    new_path: &str,
    key_opt: Option<[u8; 32]>,
) -> Result<PathChangePreview, String> {
    let old_normalized = normalize_relative_path(old_path)?;
    let new_normalized = normalize_relative_path(new_path)?;
    let old_full = Path::new(vault_path).join(&old_normalized);
    let new_full = Path::new(vault_path).join(&new_normalized);
    let old_str = old_normalized.to_string_lossy().replace('\\', "/");
    let new_str = new_normalized.to_string_lossy().replace('\\', "/");

    let metadata = std::fs::metadata(&old_full).map_err(|e| e.to_string())?;
    let item_kind = if metadata.is_dir() { "folder" } else { "file" }.to_string();
    let old_parent = old_normalized.parent().map(|p| p.to_string_lossy().replace('\\', "/")).unwrap_or_default();
    let new_parent = new_normalized.parent().map(|p| p.to_string_lossy().replace('\\', "/")).unwrap_or_default();
    let old_name = old_normalized.file_name().and_then(|value| value.to_str()).unwrap_or_default();
    let new_name = new_normalized.file_name().and_then(|value| value.to_str()).unwrap_or_default();
    let operation = match (old_parent != new_parent, old_name != new_name) {
        (true, true) => "move-and-rename",
        (true, false) => "move",
        (false, true) => "rename",
        (false, false) => "unchanged",
    }.to_string();

    let blocked_reason = if old_str == new_str {
        Some("The destination matches the current path".into())
    } else if metadata.is_dir() && new_str.starts_with(&format!("{old_str}/")) {
        Some("A folder cannot be moved into itself or one of its descendants".into())
    } else if new_full.exists() {
        Some("The destination path already exists".into())
    } else {
        None
    };

    let affected_reference_paths = if blocked_reason.is_none() {
        collect_reference_impacts(vault_path, &old_str, &new_str, key_opt)?
    } else {
        Vec::new()
    };

    Ok(PathChangePreview {
        old_relative_path: old_str,
        new_relative_path: new_str,
        item_kind,
        operation,
        nested_item_count: count_nested_items(&old_full)?,
        affected_reference_paths,
        blocked_reason,
    })
}

fn rewrite_all_references(
    vault_path: &str,
    old_path: &str,
    new_path: Option<&str>,
    key_opt: Option<[u8; 32]>,
) -> Result<(), String> {
    let entries = collect_entries(vault_path)?;

    for entry in entries {
        if entry.is_folder || entry.relative_path == old_path || path_matches_or_descends(&entry.relative_path, old_path) {
            continue;
        }

        let updated = match entry.extension.as_str() {
            "md" => {
                let note = read_note_from_path(&resolve_vault_path(vault_path, &entry.relative_path)?, &entry.relative_path, key_opt)?;
                let next = replace_markdown_references(&note.content, &entry.relative_path, old_path, new_path);
                if next == note.content { None } else { Some(next) }
            }
            "kanban" => {
                let note = read_note_from_path(&resolve_vault_path(vault_path, &entry.relative_path)?, &entry.relative_path, key_opt)?;
                let next = rewrite_kanban_references(&note.content, old_path, new_path)?;
                if next == note.content { None } else { Some(next) }
            }
            "canvas" => {
                let note = read_note_from_path(&resolve_vault_path(vault_path, &entry.relative_path)?, &entry.relative_path, key_opt)?;
                let next = rewrite_canvas_references(&note.content, old_path, new_path)?;
                if next == note.content { None } else { Some(next) }
            }
            _ => None,
        };

        if let Some(next_content) = updated {
            let full_path = resolve_vault_path(vault_path, &entry.relative_path)?;
            write_note_to_path(&full_path, &entry.relative_path, next_content, None, key_opt)?;
        }
    }

    Ok(())
}

fn read_note_from_path(
    full_path: &Path,
    relative_path: &str,
    key_opt: Option<[u8; 32]>,
) -> Result<NoteContent, String> {
    let raw = std::fs::read(full_path)
        .map_err(|e| format!("Failed to read '{}': {}", relative_path, e))?;

    let content_bytes = if crypto::is_encrypted_data(&raw) {
        let key = key_opt
            .as_ref()
            .ok_or("Vault is locked — enter the password to unlock it")?;
        crypto::decrypt_bytes(key, &raw)?
    } else {
        raw
    };

    let content = String::from_utf8(content_bytes)
        .map_err(|e| format!("File '{}' is not valid UTF-8: {}", relative_path, e))?;
    let hash = compute_hash(&content);
    let modified_at = std::fs::metadata(full_path)
        .and_then(|m| m.modified())
        .map(system_time_to_ms)
        .unwrap_or(0);

    Ok(NoteContent { content, hash, modified_at })
}

fn write_note_to_path(
    full_path: &Path,
    relative_path: &str,
    content: String,
    expected_hash: Option<String>,
    key_opt: Option<[u8; 32]>,
) -> Result<WriteResult, String> {
    if let Some(ref expected) = expected_hash {
        if full_path.exists() {
            let current = read_note_from_path(full_path, relative_path, key_opt)?;
            if &current.hash != expected {
                let hash = compute_hash(&content);
                return Ok(WriteResult {
                    hash,
                    conflict: Some(ConflictInfo {
                        our_content: content,
                        their_content: current.content,
                        relative_path: relative_path.to_string(),
                    }),
                });
            }
        }
    }

    if let Some(parent) = full_path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }

    let bytes_to_write: Vec<u8> = if let Some(ref key) = key_opt {
        crypto::encrypt_bytes(key, content.as_bytes())?
    } else {
        content.as_bytes().to_vec()
    };

    let tmp_path = full_path.with_extension("tmp");
    std::fs::write(&tmp_path, &bytes_to_write).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp_path, full_path).map_err(|e| e.to_string())?;

    let hash = compute_hash(&content);
    Ok(WriteResult { hash, conflict: None })
}

fn create_note_at_path(
    full_path: &Path,
    relative_path: &str,
    key_opt: Option<[u8; 32]>,
) -> Result<NoteFile, String> {
    if let Some(parent) = full_path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }

    let name = full_path
        .file_stem()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_default();

    let initial_content = format!("# {}\n\n", name);
    let bytes_to_write: Vec<u8> = if let Some(ref key) = key_opt {
        crypto::encrypt_bytes(key, initial_content.as_bytes())?
    } else {
        initial_content.into_bytes()
    };
    std::fs::write(full_path, &bytes_to_write).map_err(|e| e.to_string())?;

    let metadata = std::fs::metadata(full_path).map_err(|e| e.to_string())?;
    let modified_at = metadata
        .modified()
        .map(system_time_to_ms)
        .unwrap_or(0);

    let ext = full_path
        .extension()
        .map(|e| e.to_string_lossy().to_lowercase())
        .unwrap_or_default();

    Ok(NoteFile {
        relative_path: relative_path.to_string(),
        name: full_path
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_default(),
        extension: ext,
        modified_at,
        size: metadata.len(),
        is_folder: false,
        children: None,
    })
}

/// Build a flat list of NoteFile entries from the vault, excluding .collab/ and hidden dirs.
fn collect_entries(vault_path: &str) -> Result<Vec<NoteFile>, String> {
    let base = Path::new(vault_path);
    let mut entries: Vec<NoteFile> = Vec::new();

    for entry in WalkDir::new(base)
        .min_depth(1)
        .into_iter()
        .filter_entry(|e| {
            let name = e.file_name().to_string_lossy();
            !should_skip_walk_entry(&name, e.file_type().is_dir())
        })
    {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();

        let relative_path = path
            .strip_prefix(base)
            .map_err(|e| e.to_string())?
            .to_string_lossy()
            .replace('\\', "/");

        let name = entry
            .file_name()
            .to_string_lossy()
            .to_string();

        let metadata = entry.metadata().map_err(|e| e.to_string())?;

        if metadata.is_dir() {
            let modified_at = metadata
                .modified()
                .map(system_time_to_ms)
                .unwrap_or(0);

            entries.push(NoteFile {
                relative_path,
                name,
                extension: String::new(),
                modified_at,
                size: 0,
                is_folder: true,
                children: Some(vec![]),
            });
        } else {
            let ext = path
                .extension()
                .map(|e| e.to_string_lossy().to_lowercase())
                .unwrap_or_default();

            if !is_allowed_extension(&ext) {
                continue;
            }

            let modified_at = metadata
                .modified()
                .map(system_time_to_ms)
                .unwrap_or(0);

            entries.push(NoteFile {
                relative_path,
                name,
                extension: ext,
                modified_at,
                size: metadata.len(),
                is_folder: false,
                children: None,
            });
        }
    }

    Ok(entries)
}

/// Build a tree from the flat list. Folders get their children nested.
fn build_tree(entries: Vec<NoteFile>) -> Vec<NoteFile> {
    // Separate folders and files
    let mut folders: Vec<NoteFile> = entries
        .iter()
        .filter(|e| e.is_folder)
        .cloned()
        .collect();
    let files: Vec<NoteFile> = entries
        .into_iter()
        .filter(|e| !e.is_folder)
        .collect();

    // Sort folders by depth descending so we can nest deepest first
    folders.sort_by(|a, b| {
        let depth_a = a.relative_path.matches('/').count();
        let depth_b = b.relative_path.matches('/').count();
        depth_b.cmp(&depth_a)
    });

    // Assign files to their parent folders
    let mut orphan_files: Vec<NoteFile> = Vec::new();
    let mut file_pool: Vec<NoteFile> = files;

    // We'll use an index-based approach: build a map of folder path -> children
    // Then assemble from deepest to root.
    use std::collections::HashMap;
    let mut folder_children: HashMap<String, Vec<NoteFile>> = HashMap::new();

    for f in &folders {
        folder_children.entry(f.relative_path.clone()).or_default();
    }

    // Place each file into its parent folder bucket
    for file in file_pool.drain(..) {
        let parent = Path::new(&file.relative_path)
            .parent()
            .map(|p| p.to_string_lossy().replace('\\', "/"))
            .unwrap_or_default();

        if parent.is_empty() || !folder_children.contains_key(&parent) {
            orphan_files.push(file);
        } else {
            folder_children.get_mut(&parent).unwrap().push(file);
        }
    }

    // Now nest folders: assign sub-folders as children of their parents
    // Process in order of deepest first
    let folder_paths: Vec<String> = folders.iter().map(|f| f.relative_path.clone()).collect();

    for folder_path in &folder_paths {
        let parent = Path::new(folder_path)
            .parent()
            .map(|p| p.to_string_lossy().replace('\\', "/"))
            .unwrap_or_default();

        if parent.is_empty() || !folder_children.contains_key(&parent) {
            continue;
        }

        // Take children of this folder and build the NoteFile
        let children = folder_children.remove(folder_path).unwrap_or_default();
        let folder_entry = folders
            .iter_mut()
            .find(|f| &f.relative_path == folder_path)
            .unwrap();
        folder_entry.children = Some(children);

        // Clone to move into parent
        let folder_clone = folder_entry.clone();
        folder_children.get_mut(&parent).unwrap().push(folder_clone);
    }

    // Collect root-level folders (those whose parent has no folder bucket)
    let mut root: Vec<NoteFile> = Vec::new();
    for mut folder in folders {
        let parent = Path::new(&folder.relative_path)
            .parent()
            .map(|p| p.to_string_lossy().replace('\\', "/"))
            .unwrap_or_default();

        if parent.is_empty() {
            // Ensure children are set from our map (may have been updated)
            if let Some(children) = folder_children.remove(&folder.relative_path) {
                folder.children = Some(children);
            }
            root.push(folder);
        }
    }

    // Add orphan files (files at root level)
    root.extend(orphan_files);

    // Sort: folders first, then files, alphabetically
    root.sort_by(|a, b| match (a.is_folder, b.is_folder) {
        (true, false) => std::cmp::Ordering::Less,
        (false, true) => std::cmp::Ordering::Greater,
        _ => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
    });

    root
}

#[tauri::command]
pub fn list_vault_files(vault_path: String) -> Result<Vec<NoteFile>, String> {
    let entries = collect_entries(&vault_path)?;
    Ok(build_tree(entries))
}

#[tauri::command]
pub fn read_note(
    vault_path: String,
    relative_path: String,
    state: State<AppState>,
) -> Result<NoteContent, String> {
    let full_path = resolve_vault_path(&vault_path, &relative_path)?;
    let key_opt: Option<[u8; 32]> = *state.encryption_key.read();
    read_note_from_path(&full_path, &relative_path, key_opt)
}

#[tauri::command]
pub fn read_note_asset_data_url(
    vault_path: String,
    relative_path: String,
    state: State<AppState>,
) -> Result<String, String> {
    let full_path = resolve_vault_path(&vault_path, &relative_path)?;
    let raw = std::fs::read(&full_path)
        .map_err(|e| format!("Failed to read asset '{}': {}", relative_path, e))?;

    let bytes = if crypto::is_encrypted_data(&raw) {
        let key_guard = state.encryption_key.read();
        let key = key_guard
            .as_ref()
            .ok_or("Vault is locked — enter the password to unlock it")?;
        crypto::decrypt_bytes(key, &raw)?
    } else {
        raw
    };

    let mime = guess_mime_type(&relative_path);
    let encoded = base64::engine::general_purpose::STANDARD.encode(bytes);
    Ok(format!("data:{};base64,{}", mime, encoded))
}

#[tauri::command]
pub fn read_image_overlay(
    vault_path: String,
    image_relative_path: String,
    state: State<AppState>,
) -> Result<Option<String>, String> {
    let relative_path = overlay_relative_path(&image_relative_path);
    let full_path = resolve_vault_path(&vault_path, &relative_path)?;
    if !full_path.exists() {
        return Ok(None);
    }

    let key_opt: Option<[u8; 32]> = *state.encryption_key.read();
    let bytes = read_vault_bytes(&full_path, key_opt)?;
    let content = String::from_utf8(bytes).map_err(|e| e.to_string())?;
    Ok(Some(content))
}

#[tauri::command]
pub fn write_image_overlay(
    vault_path: String,
    image_relative_path: String,
    content: String,
    state: State<AppState>,
) -> Result<(), String> {
    let relative_path = overlay_relative_path(&image_relative_path);
    let full_path = resolve_vault_path(&vault_path, &relative_path)?;
    let key_opt: Option<[u8; 32]> = *state.encryption_key.read();
    write_vault_bytes(&full_path, content.as_bytes(), key_opt)
}

#[tauri::command]
pub fn delete_image_overlay(
    vault_path: String,
    image_relative_path: String,
) -> Result<(), String> {
    let relative_path = overlay_relative_path(&image_relative_path);
    let full_path = resolve_vault_path(&vault_path, &relative_path)?;
    if full_path.exists() {
        std::fs::remove_file(full_path).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub fn save_generated_image(
    vault_path: String,
    source_relative_path: String,
    data_url: String,
    overwrite: bool,
    suggested_file_name: Option<String>,
    state: State<AppState>,
) -> Result<String, String> {
    let (mime, encoded) = parse_data_url(&data_url)?;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(encoded)
        .map_err(|e| format!("Failed to decode generated image data: {e}"))?;
    let key_opt: Option<[u8; 32]> = *state.encryption_key.read();

    let target_path = if overwrite {
        resolve_vault_path(&vault_path, &source_relative_path)?
    } else {
        let source_path = normalize_relative_path(&source_relative_path)?;
        let source_parent = source_path.parent().unwrap_or_else(|| Path::new(""));
        let source_stem = source_path
            .file_stem()
            .and_then(|stem| stem.to_str())
            .filter(|stem| !stem.is_empty())
            .unwrap_or("image");
        let default_name = format!("{source_stem}-edited.{}", extension_for_mime(mime));
        let desired_name = suggested_file_name
            .as_deref()
            .map(sanitize_file_name)
            .filter(|name| !name.is_empty())
            .unwrap_or(default_name);
        let base_dir = Path::new(&vault_path).join(source_parent);
        unique_target_path(&base_dir, &desired_name)
    };

    write_vault_bytes(&target_path, &bytes, key_opt)?;

    let relative = target_path
        .strip_prefix(&vault_path)
        .map_err(|e| e.to_string())?
        .to_string_lossy()
        .replace('\\', "/");

    Ok(relative)
}

#[tauri::command]
pub fn import_asset_into_vault(
    vault_path: String,
    source_path: String,
    target_folder: Option<String>,
    state: State<AppState>,
) -> Result<String, String> {
    let source = Path::new(&source_path);
    if !source.is_file() {
        return Err(format!("Source asset does not exist or is not a file: {}", source_path));
    }

    let folder = target_folder.unwrap_or_else(|| "Pictures".into());
    let target_dir = resolve_vault_path(&vault_path, &folder)?;
    std::fs::create_dir_all(&target_dir).map_err(|e| e.to_string())?;

    let source_name = source
        .file_name()
        .and_then(|n| n.to_str())
        .map(sanitize_file_name)
        .filter(|name| !name.is_empty())
        .unwrap_or_else(|| "image".into());

    let target_path = unique_target_path(&target_dir, &source_name);
    let source_bytes = std::fs::read(source).map_err(|e| e.to_string())?;
    let key_opt: Option<[u8; 32]> = *state.encryption_key.read();
    let bytes_to_write = if let Some(ref key) = key_opt {
        crypto::encrypt_bytes(key, &source_bytes)?
    } else {
        source_bytes
    };

    std::fs::write(&target_path, bytes_to_write).map_err(|e| e.to_string())?;

    let relative = target_path
        .strip_prefix(&vault_path)
        .map_err(|e| e.to_string())?
        .to_string_lossy()
        .replace('\\', "/");

    Ok(relative)
}

#[cfg(test)]
mod tests {
    use super::{
        build_tree, collect_entries, create_note_at_path, extension_for_mime, guess_mime_type,
        list_file_references_inner,
        is_allowed_extension, normalize_relative_path, overlay_relative_path, parse_data_url,
        list_trash_entries_inner, move_path_to_trash, preview_path_change_inner, purge_trashed_item_inner,
        read_note_from_path, read_vault_bytes, relative_path_from_dir, remap_path,
        replace_markdown_references, resolve_vault_path, rewrite_all_references,
        rewrite_canvas_references, rewrite_kanban_references, sanitize_file_name,
        should_skip_walk_entry, restore_trashed_item_inner, unique_target_path, write_note_to_path,
        write_vault_bytes,
    };
    use crate::{crypto, test_support::TempVault};
    use std::path::{Path, PathBuf};

    #[test]
    fn normalize_relative_path_accepts_safe_paths() {
        let normalized = normalize_relative_path("Notes/../Notes/Test.md")
            .expect("path should normalize");

        assert_eq!(normalized, PathBuf::from("Notes/Test.md"));
    }

    #[test]
    fn normalize_relative_path_rejects_escaping_paths() {
        let err = normalize_relative_path("../../etc/passwd")
            .expect_err("escaping path should fail");

        assert!(err.contains("escapes the vault root"));
    }

    #[test]
    fn resolve_vault_path_stays_under_the_vault_root() {
        let resolved = resolve_vault_path("/vault-root", "Notes/Test.md")
            .expect("path should resolve");

        assert_eq!(resolved, PathBuf::from("/vault-root").join("Notes/Test.md"));
    }

    #[test]
    fn overlay_relative_path_is_deterministic_and_namespaced() {
        let overlay = overlay_relative_path("Pictures/example.png");

        assert!(overlay.starts_with(".collab/image-overlays/"));
        assert!(overlay.ends_with(".json"));
        assert_eq!(overlay, overlay_relative_path("Pictures/example.png"));
    }

    #[test]
    fn guess_mime_type_covers_images_and_pdfs() {
        assert_eq!(guess_mime_type("image.png"), "image/png");
        assert_eq!(guess_mime_type("photo.jpeg"), "image/jpeg");
        assert_eq!(guess_mime_type("doc.pdf"), "application/pdf");
        assert_eq!(guess_mime_type("archive.bin"), "application/octet-stream");
    }

    #[test]
    fn sanitize_file_name_replaces_reserved_characters_and_trims_dots() {
        let sanitized = sanitize_file_name("..bad:/\\name?.png..");

        assert_eq!(sanitized, "bad___name_.png");
    }

    #[test]
    fn parse_data_url_accepts_valid_base64_urls() {
        let (mime, encoded) = parse_data_url("data:image/png;base64,abcd1234")
            .expect("data url should parse");

        assert_eq!(mime, "image/png");
        assert_eq!(encoded, "abcd1234");
    }

    #[test]
    fn parse_data_url_rejects_invalid_urls() {
        let missing_prefix = parse_data_url("image/png;base64,abcd")
            .expect_err("missing data prefix should fail");
        let malformed = parse_data_url("data:image/png;base64")
            .expect_err("missing payload separator should fail");
        let not_base64 = parse_data_url("data:image/png,abcd")
            .expect_err("missing base64 marker should fail");

        assert!(missing_prefix.contains("valid data URL"));
        assert!(malformed.contains("malformed"));
        assert!(not_base64.contains("base64"));
    }

    #[test]
    fn extension_for_mime_maps_expected_output_extensions() {
        assert_eq!(extension_for_mime("image/jpeg"), "jpg");
        assert_eq!(extension_for_mime("image/webp"), "webp");
        assert_eq!(extension_for_mime("image/png"), "png");
    }

    #[test]
    fn unique_target_path_increments_when_file_exists() {
        let vault = TempVault::new().expect("temp vault should exist");
        vault.create_dir("Pictures").expect("pictures dir should be created");
        vault
            .write_text("Pictures/image.png", "existing")
            .expect("existing file should be written");

        let unique = unique_target_path(&vault.resolve("Pictures"), "image.png");

        assert_eq!(unique, vault.resolve("Pictures/image-2.png"));
    }

    #[test]
    fn relative_path_from_dir_builds_relative_targets() {
        let relative = relative_path_from_dir(Path::new("Notes/Daily"), Path::new("Pictures/image.png"));
        assert_eq!(relative, "../../Pictures/image.png");
    }

    #[test]
    fn remap_path_updates_exact_and_descendant_matches() {
        assert_eq!(remap_path("Docs/file.pdf", "Docs/file.pdf", "Archive/file.pdf"), Some("Archive/file.pdf".into()));
        assert_eq!(remap_path("Docs/sub/file.pdf", "Docs", "Archive"), Some("Archive/sub/file.pdf".into()));
        assert_eq!(remap_path("Other/file.pdf", "Docs", "Archive"), None);
    }

    #[test]
    fn replace_markdown_references_rewrites_links_and_removes_deleted_targets() {
        let content = "\
![Preview](../Pictures/demo.png)\n\
[Spec](../Docs/spec.pdf)\n\
![[../Pictures/demo.png|Preview]]\n\
[[../Docs/spec.pdf|Spec Doc]]\n";

        let renamed = replace_markdown_references(
            content,
            "Notes/today.md",
            "Pictures/demo.png",
            Some("Archive/demo.png"),
        );
        assert!(renamed.contains("![](../Archive/demo.png)") || renamed.contains("![Preview](../Archive/demo.png)"));
        assert!(renamed.contains("![[../Archive/demo.png|Preview]]"));

        let removed = replace_markdown_references(
            content,
            "Notes/today.md",
            "Docs/spec.pdf",
            None,
        );
        assert!(removed.contains("Spec"));
        assert!(!removed.contains("../Docs/spec.pdf"));
    }

    #[test]
    fn rewrite_kanban_references_updates_attachment_paths() {
        let content = r#"{
  "columns": [
    {
      "id": "todo",
      "title": "Todo",
      "cards": [
        {
          "id": "card-1",
          "title": "Card",
          "assignees": [],
          "tags": [],
          "comments": [],
          "checklist": [],
          "attachmentPaths": ["Docs/spec.pdf", "Other/file.pdf"],
          "relativePath": "Docs/spec.pdf"
        }
      ]
    }
  ]
}"#;

        let renamed = rewrite_kanban_references(content, "Docs/spec.pdf", Some("Archive/spec.pdf"))
            .expect("kanban refs should rewrite");
        assert!(renamed.contains("Archive/spec.pdf"));

        let removed = rewrite_kanban_references(content, "Docs/spec.pdf", None)
            .expect("kanban refs should remove");
        assert!(!removed.contains("Docs/spec.pdf"));
    }

    #[test]
    fn rewrite_canvas_references_updates_and_removes_file_nodes() {
        let content = r#"{
  "nodes": [
    { "id": "n1", "type": "file", "relativePath": "Docs/spec.pdf" },
    { "id": "n2", "type": "text", "content": "keep" }
  ],
  "edges": [],
  "viewport": { "x": 0, "y": 0, "zoom": 1 }
}"#;

        let renamed = rewrite_canvas_references(content, "Docs/spec.pdf", Some("Archive/spec.pdf"))
            .expect("canvas refs should rewrite");
        assert!(renamed.contains("Archive/spec.pdf"));

        let removed = rewrite_canvas_references(content, "Docs/spec.pdf", None)
            .expect("canvas refs should remove");
        assert!(!removed.contains("Docs/spec.pdf"));
        assert!(removed.contains("\"n2\""));
    }

    #[test]
    fn rewrite_all_references_updates_notes_boards_and_canvas_files() {
        let vault = TempVault::new().expect("temp vault should exist");
        vault.write_text("Notes/a.md", "![Img](../Pictures/demo.png)\n[Spec](../Docs/spec.pdf)\n").expect("note should be written");
        vault.write_text("Board.kanban", r#"{"columns":[{"id":"c1","title":"Todo","cards":[{"id":"card-1","title":"Card","assignees":[],"tags":[],"comments":[],"checklist":[],"attachmentPaths":["Docs/spec.pdf"],"relativePath":"Docs/spec.pdf"}]}]}"#).expect("board should be written");
        vault.write_text("Board.canvas", r#"{"nodes":[{"id":"n1","type":"file","relativePath":"Docs/spec.pdf"}],"edges":[],"viewport":{"x":0,"y":0,"zoom":1}}"#).expect("canvas should be written");

        rewrite_all_references(&vault.path_string(), "Docs/spec.pdf", Some("Archive/spec.pdf"), None)
            .expect("references should rewrite");

        assert!(vault.read_text("Notes/a.md").expect("note should be readable").contains("../Archive/spec.pdf"));
        assert!(vault.read_text("Board.kanban").expect("board should be readable").contains("Archive/spec.pdf"));
        assert!(vault.read_text("Board.canvas").expect("canvas should be readable").contains("Archive/spec.pdf"));
    }

    #[test]
    fn allowed_extensions_and_walk_skip_rules_match_vault_policy() {
        assert!(is_allowed_extension("md"));
        assert!(is_allowed_extension("pdf"));
        assert!(!is_allowed_extension("exe"));

        assert!(should_skip_walk_entry(".hidden", false));
        assert!(should_skip_walk_entry("node_modules", true));
        assert!(!should_skip_walk_entry("Notes", true));
        assert!(!should_skip_walk_entry("note.md", false));
    }

    #[test]
    fn collect_entries_filters_hidden_ignored_and_disallowed_files() {
        let vault = TempVault::new().expect("temp vault should exist");
        vault.write_text("Notes/alpha.md", "# Alpha").expect("note should be written");
        vault.write_text("Board.kanban", "{}").expect("kanban should be written");
        vault.write_text("Canvas.canvas", "{}").expect("canvas should be written");
        vault.write_bytes("Pictures/image.png", b"png").expect("image should be written");
        vault.write_bytes("Docs/file.pdf", b"pdf").expect("pdf should be written");
        vault.write_text(".secret.md", "# hidden").expect("hidden file should be written");
        vault.write_text("node_modules/skip.md", "# skip").expect("ignored file should be written");
        vault.write_text("target/skip.md", "# skip").expect("ignored file should be written");
        vault.write_text("Scripts/file.exe", "echo hi").expect("disallowed file should be written");

        let entries = collect_entries(&vault.path_string()).expect("entries should collect");
        let relative_paths: Vec<String> = entries.into_iter().map(|entry| entry.relative_path).collect();

        assert!(relative_paths.contains(&"Notes/alpha.md".to_string()));
        assert!(relative_paths.contains(&"Board.kanban".to_string()));
        assert!(relative_paths.contains(&"Canvas.canvas".to_string()));
        assert!(relative_paths.contains(&"Pictures/image.png".to_string()));
        assert!(relative_paths.contains(&"Docs/file.pdf".to_string()));
        assert!(!relative_paths.contains(&".secret.md".to_string()));
        assert!(!relative_paths.iter().any(|path| path.starts_with("node_modules/")));
        assert!(!relative_paths.iter().any(|path| path.starts_with("target/")));
        assert!(!relative_paths.contains(&"Scripts/file.exe".to_string()));
    }

    #[test]
    fn build_tree_nests_folder_children_and_keeps_root_files_sorted() {
        let vault = TempVault::new().expect("temp vault should exist");
        vault.write_text("Notes/Zeta.md", "# Zeta").expect("note should be written");
        vault.write_text("Notes/Projects/Alpha.md", "# Alpha").expect("nested note should be written");
        vault.write_text("Root.md", "# Root").expect("root note should be written");

        let entries = collect_entries(&vault.path_string()).expect("entries should collect");
        let tree = build_tree(entries);

        let notes_folder = tree.iter().find(|entry| entry.relative_path == "Notes").expect("notes folder should exist");
        let notes_children = notes_folder.children.as_ref().expect("notes folder should have children");
        let nested_folder = notes_children
            .iter()
            .find(|entry| entry.relative_path == "Notes/Projects")
            .expect("nested folder should exist");
        let nested_children = nested_folder.children.as_ref().expect("nested folder should have children");

        assert!(tree.iter().any(|entry| entry.relative_path == "Root.md" && !entry.is_folder));
        assert!(notes_children.iter().any(|entry| entry.relative_path == "Notes/Zeta.md"));
        assert!(nested_children.iter().any(|entry| entry.relative_path == "Notes/Projects/Alpha.md"));
    }

    #[test]
    fn write_and_read_vault_bytes_roundtrip_plaintext() {
        let vault = TempVault::new().expect("temp vault should exist");
        let target = vault.resolve("Notes/plain.txt");

        write_vault_bytes(&target, b"plain bytes", None).expect("plain write should succeed");
        let bytes = read_vault_bytes(&target, None).expect("plain read should succeed");

        assert_eq!(bytes, b"plain bytes");
    }

    #[test]
    fn write_and_read_vault_bytes_roundtrip_encrypted() {
        let vault = TempVault::new().expect("temp vault should exist");
        let target = vault.resolve("Notes/secret.md");
        let salt = [7u8; 32];
        let key = crypto::derive_key("files-test-password", &salt).expect("key should derive");

        write_vault_bytes(&target, b"secret bytes", Some(key)).expect("encrypted write should succeed");

        let raw = vault.read_bytes("Notes/secret.md").expect("raw bytes should be readable");
        assert!(crypto::is_encrypted_data(&raw));

        let bytes = read_vault_bytes(&target, Some(key)).expect("encrypted read should succeed");
        assert_eq!(bytes, b"secret bytes");
    }

    #[test]
    fn create_read_and_write_note_roundtrip_plaintext() {
        let vault = TempVault::new().expect("temp vault should exist");
        let target = vault.resolve("Notes/Test.md");

        let created = create_note_at_path(&target, "Notes/Test.md", None)
            .expect("note should be created");
        assert_eq!(created.relative_path, "Notes/Test.md");
        assert_eq!(created.extension, "md");

        let initial = read_note_from_path(&target, "Notes/Test.md", None)
            .expect("initial note should be readable");
        assert_eq!(initial.content, "# Test\n\n");

        let write = write_note_to_path(
            &target,
            "Notes/Test.md",
            "# Test\n\nUpdated body".into(),
            Some(initial.hash.clone()),
            None,
        )
        .expect("write should succeed");
        assert!(write.conflict.is_none());

        let updated = read_note_from_path(&target, "Notes/Test.md", None)
            .expect("updated note should be readable");
        assert_eq!(updated.content, "# Test\n\nUpdated body");
        assert_eq!(updated.hash, write.hash);
    }

    #[test]
    fn write_note_reports_conflict_when_expected_hash_is_stale() {
        let vault = TempVault::new().expect("temp vault should exist");
        let target = vault.resolve("Notes/Test.md");
        vault
            .write_text("Notes/Test.md", "Their version")
            .expect("existing note should be written");

        let stale_hash = super::compute_hash("Our stale base");
        let result = write_note_to_path(
            &target,
            "Notes/Test.md",
            "Our version".into(),
            Some(stale_hash),
            None,
        )
        .expect("write should return a conflict result");

        let conflict = result.conflict.expect("stale write should conflict");
        assert_eq!(conflict.our_content, "Our version");
        assert_eq!(conflict.their_content, "Their version");
        assert_eq!(conflict.relative_path, "Notes/Test.md");

        let on_disk = vault
            .read_text("Notes/Test.md")
            .expect("existing file should remain unchanged");
        assert_eq!(on_disk, "Their version");
    }

    #[test]
    fn create_read_and_write_note_roundtrip_encrypted() {
        let vault = TempVault::new().expect("temp vault should exist");
        let target = vault.resolve("Secret/Test.md");
        let salt = [9u8; 32];
        let key = crypto::derive_key("note-roundtrip-password", &salt).expect("key should derive");

        create_note_at_path(&target, "Secret/Test.md", Some(key))
            .expect("encrypted note should be created");
        let raw = vault
            .read_bytes("Secret/Test.md")
            .expect("raw encrypted note bytes should be readable");
        assert!(crypto::is_encrypted_data(&raw));

        let initial = read_note_from_path(&target, "Secret/Test.md", Some(key))
            .expect("encrypted note should decrypt");
        let write = write_note_to_path(
            &target,
            "Secret/Test.md",
            "# Test\n\nEncrypted body".into(),
            Some(initial.hash.clone()),
            Some(key),
        )
        .expect("encrypted write should succeed");
        assert!(write.conflict.is_none());

        let updated = read_note_from_path(&target, "Secret/Test.md", Some(key))
            .expect("updated encrypted note should decrypt");
        assert_eq!(updated.content, "# Test\n\nEncrypted body");
    }

    #[test]
    fn trash_roundtrip_moves_lists_restores_and_purges_items() {
        let vault = TempVault::new().expect("temp vault should exist");
        vault.write_text("Notes/alpha.md", "# Alpha").expect("note should be written");

        let trashed = move_path_to_trash(
            &vault.path_string(),
            "Notes/alpha.md",
            Some("user-1".into()),
            Some("Test User".into()),
            None,
        )
        .expect("move to trash should succeed");

        assert!(!vault.resolve("Notes/alpha.md").exists());

        let listed = list_trash_entries_inner(&vault.path_string(), None).expect("trash should list");
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].id, trashed.id);
        assert_eq!(listed[0].deleted_by_user_name.as_deref(), Some("Test User"));

        let restored_path = restore_trashed_item_inner(&vault.path_string(), &trashed.id, None, None)
            .expect("restore should succeed");
        assert_eq!(restored_path, "Notes/alpha.md");
        assert!(vault.resolve("Notes/alpha.md").exists());

        let trashed_again = move_path_to_trash(&vault.path_string(), "Notes/alpha.md", None, None, None)
            .expect("move to trash should succeed again");
        purge_trashed_item_inner(&vault.path_string(), &trashed_again.id, false, None)
            .expect("purge should succeed");
        assert!(list_trash_entries_inner(&vault.path_string(), None).expect("trash should list").is_empty());
    }

    #[test]
    fn trash_listing_reports_restore_conflicts() {
        let vault = TempVault::new().expect("temp vault should exist");
        vault.write_text("Docs/spec.pdf", "pdf").expect("pdf should exist");

        let trashed = move_path_to_trash(&vault.path_string(), "Docs/spec.pdf", None, None, None)
            .expect("move to trash should succeed");
        vault.write_text("Docs/spec.pdf", "replacement").expect("replacement file should exist");

        let listed = list_trash_entries_inner(&vault.path_string(), None).expect("trash should list");
        let entry = listed.into_iter().find(|entry| entry.id == trashed.id).expect("entry should exist");
        let conflict = entry.restore_conflict.expect("restore conflict should be reported");
        assert_eq!(conflict.existing_relative_path, "Docs/spec.pdf");
        assert!(conflict.suggested_relative_path.starts_with("Docs/spec-restored-"));
    }

    #[test]
    fn rename_move_preview_reports_reference_impacts() {
        let vault = TempVault::new().expect("temp vault should exist");
        vault.write_text("Docs/spec.pdf", "pdf").expect("pdf should exist");
        vault
            .write_text("Notes/alpha.md", "[Spec](../Docs/spec.pdf)")
            .expect("note should exist");
        vault
            .write_text(
                "Board.canvas",
                r#"{"nodes":[{"id":"n1","type":"file","relativePath":"Docs/spec.pdf"}],"edges":[],"viewport":{"x":0,"y":0,"zoom":1}}"#,
            )
            .expect("canvas should exist");

        let preview = preview_path_change_inner(
            &vault.path_string(),
            "Docs/spec.pdf",
            "Archive/spec.pdf",
            None,
        )
        .expect("preview should succeed");

        assert_eq!(preview.operation, "move");
        assert_eq!(preview.item_kind, "file");
        assert!(preview.affected_reference_paths.contains(&"Notes/alpha.md".to_string()));
        assert!(preview.affected_reference_paths.contains(&"Board.canvas".to_string()));
        assert_eq!(preview.blocked_reason, None);
    }

    #[test]
    fn list_file_references_reports_note_kanban_and_canvas_hits() {
        let vault = TempVault::new().expect("temp vault should exist");
        vault.write_text("Docs/spec.pdf", "pdf").expect("pdf should exist");
        vault
            .write_text(
                "Notes/alpha.md",
                "[Spec Doc](../Docs/spec.pdf)\n[[spec.pdf|PDF Alias]]\n",
            )
            .expect("note should exist");
        vault
            .write_text(
                "Board.kanban",
                r#"{"columns":[{"id":"todo","title":"Todo","cards":[{"id":"card-1","title":"Review spec","assignees":[],"tags":[],"comments":[],"checklist":[],"attachmentPaths":["Docs/spec.pdf"]}]}]}"#,
            )
            .expect("board should exist");
        vault
            .write_text(
                "Board.canvas",
                r#"{"nodes":[{"id":"n1","type":"file","relativePath":"Docs/spec.pdf"}],"edges":[],"viewport":{"x":0,"y":0,"zoom":1}}"#,
            )
            .expect("canvas should exist");

        let references = list_file_references_inner(&vault.path_string(), "Docs/spec.pdf", None)
            .expect("references should list");

        assert!(references.iter().any(|entry|
            entry.source_relative_path == "Notes/alpha.md"
            && entry.reference_kind == "note-markdown-link"
            && entry.display_label.as_deref() == Some("Spec Doc")
        ));
        assert!(references.iter().any(|entry|
            entry.source_relative_path == "Notes/alpha.md"
            && entry.reference_kind == "note-wikilink"
            && entry.display_label.as_deref() == Some("PDF Alias")
        ));
        assert!(references.iter().any(|entry|
            entry.source_relative_path == "Board.kanban"
            && entry.reference_kind == "kanban-attachment"
            && entry.display_label.as_deref() == Some("Review spec")
        ));
        assert!(references.iter().any(|entry|
            entry.source_relative_path == "Board.canvas"
            && entry.reference_kind == "canvas-file-node"
        ));
    }
}

#[tauri::command]
pub fn write_note(
    vault_path: String,
    relative_path: String,
    content: String,
    expected_hash: Option<String>,
    state: State<AppState>,
) -> Result<WriteResult, String> {
    let full_path = resolve_vault_path(&vault_path, &relative_path)?;
    let key_opt: Option<[u8; 32]> = *state.encryption_key.read();
    write_note_to_path(&full_path, &relative_path, content, expected_hash, key_opt)
}

#[tauri::command]
pub fn create_note(
    vault_path: String,
    relative_path: String,
    state: State<AppState>,
) -> Result<NoteFile, String> {
    let full_path = resolve_vault_path(&vault_path, &relative_path)?;
    let key_opt: Option<[u8; 32]> = *state.encryption_key.read();
    create_note_at_path(&full_path, &relative_path, key_opt)
}

#[tauri::command]
pub fn delete_note(
    vault_path: String,
    relative_path: String,
    remove_references: Option<bool>,
    state: State<AppState>,
) -> Result<(), String> {
    let normalized = normalize_relative_path(&relative_path)?;
    if normalized == PathBuf::from("Pictures") {
        return Err("The Pictures folder is managed by the app and cannot be deleted".into());
    }
    let key_opt: Option<[u8; 32]> = *state.encryption_key.read();
    if remove_references.unwrap_or(false) {
        rewrite_all_references(&vault_path, &relative_path, None, key_opt)?;
    }
    let full_path = resolve_vault_path(&vault_path, &relative_path)?;
    if !normalized.as_os_str().is_empty() {
        let ext = Path::new(&relative_path)
            .extension()
            .and_then(|value| value.to_str())
            .map(|value| value.to_ascii_lowercase())
            .unwrap_or_default();
        if matches!(ext.as_str(), "png" | "jpg" | "jpeg" | "gif" | "webp" | "svg" | "bmp" | "ico" | "avif") {
            let _ = delete_image_overlay_if_needed(&vault_path, &relative_path);
        }
    }
    if full_path.is_dir() {
        std::fs::remove_dir_all(&full_path).map_err(|e| e.to_string())
    } else {
        std::fs::remove_file(&full_path).map_err(|e| e.to_string())
    }
}

#[tauri::command]
pub fn move_note_to_trash(
    vault_path: String,
    relative_path: String,
    deleted_by_user_id: Option<String>,
    deleted_by_user_name: Option<String>,
    state: State<AppState>,
) -> Result<TrashEntry, String> {
    let key_opt: Option<[u8; 32]> = *state.encryption_key.read();
    move_path_to_trash(
        &vault_path,
        &relative_path,
        deleted_by_user_id,
        deleted_by_user_name,
        key_opt,
    )
}

#[tauri::command]
pub fn list_trash_entries(
    vault_path: String,
    state: State<AppState>,
) -> Result<Vec<TrashEntry>, String> {
    let key_opt: Option<[u8; 32]> = *state.encryption_key.read();
    list_trash_entries_inner(&vault_path, key_opt)
}

#[tauri::command]
pub fn restore_trashed_item(
    vault_path: String,
    entry_id: String,
    target_relative_path: Option<String>,
    state: State<AppState>,
) -> Result<String, String> {
    let key_opt: Option<[u8; 32]> = *state.encryption_key.read();
    restore_trashed_item_inner(&vault_path, &entry_id, target_relative_path, key_opt)
}

#[tauri::command]
pub fn purge_trashed_item(
    vault_path: String,
    entry_id: String,
    remove_references: Option<bool>,
    state: State<AppState>,
) -> Result<(), String> {
    let key_opt: Option<[u8; 32]> = *state.encryption_key.read();
    purge_trashed_item_inner(&vault_path, &entry_id, remove_references.unwrap_or(false), key_opt)
}

#[tauri::command]
pub fn purge_all_trash(
    vault_path: String,
    state: State<AppState>,
) -> Result<(), String> {
    let key_opt: Option<[u8; 32]> = *state.encryption_key.read();
    purge_all_trash_inner(&vault_path, key_opt)
}

#[tauri::command]
pub fn preview_rename_move(
    vault_path: String,
    old_path: String,
    new_path: String,
    state: State<AppState>,
) -> Result<PathChangePreview, String> {
    let key_opt: Option<[u8; 32]> = *state.encryption_key.read();
    preview_path_change_inner(&vault_path, &old_path, &new_path, key_opt)
}

#[tauri::command]
pub fn list_file_references(
    vault_path: String,
    relative_path: String,
    state: State<AppState>,
) -> Result<Vec<FileReference>, String> {
    let key_opt: Option<[u8; 32]> = *state.encryption_key.read();
    list_file_references_inner(&vault_path, &relative_path, key_opt)
}

#[tauri::command]
pub fn rename_note(
    vault_path: String,
    old_path: String,
    new_path: String,
    update_references: Option<bool>,
    state: State<AppState>,
) -> Result<(), String> {
    let base = Path::new(&vault_path);
    let old_full = base.join(normalize_relative_path(&old_path)?);
    let new_full = base.join(normalize_relative_path(&new_path)?);
    let key_opt: Option<[u8; 32]> = *state.encryption_key.read();

    // Create parent directories for destination if needed
    if let Some(parent) = new_full.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }

    std::fs::rename(&old_full, &new_full).map_err(|e| e.to_string())?;

    if update_references.unwrap_or(true) {
        rewrite_all_references(&vault_path, &old_path, Some(&new_path), key_opt)?;
    }

    let ext = Path::new(&new_path)
        .extension()
        .and_then(|value| value.to_str())
        .map(|value| value.to_ascii_lowercase())
        .unwrap_or_default();
    if matches!(ext.as_str(), "png" | "jpg" | "jpeg" | "gif" | "webp" | "svg" | "bmp" | "ico" | "avif") {
        let _ = move_image_overlay_if_needed(&vault_path, &old_path, &new_path);
    }

    Ok(())
}

#[tauri::command]
pub fn create_folder(vault_path: String, relative_path: String) -> Result<(), String> {
    let full_path = resolve_vault_path(&vault_path, &relative_path)?;
    std::fs::create_dir_all(&full_path).map_err(|e| e.to_string())
}
