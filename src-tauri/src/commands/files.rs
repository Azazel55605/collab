use crate::crypto;
use crate::models::note::{ConflictInfo, NoteContent, NoteFile, WriteResult};
use crate::state::AppState;
use base64::Engine as _;
use regex::{Captures, Regex};
use sha2::{Digest, Sha256};
use std::path::{Component, Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::State;
use walkdir::WalkDir;

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
        is_allowed_extension, normalize_relative_path, overlay_relative_path, parse_data_url,
        read_note_from_path, read_vault_bytes, relative_path_from_dir, remap_path,
        replace_markdown_references, resolve_vault_path, rewrite_all_references,
        rewrite_canvas_references, rewrite_kanban_references, sanitize_file_name,
        should_skip_walk_entry, unique_target_path, write_note_to_path, write_vault_bytes,
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
