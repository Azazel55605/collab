use collab_core::normalize_relative_path;
use regex::{Captures, Regex};
use serde::{Deserialize, Serialize};
use std::path::{Component, Path, PathBuf};
use std::sync::LazyLock;

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum ReferenceError {
    #[error("The document is not valid JSON: {0}")]
    InvalidDocument(String),
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

#[derive(Debug, Clone)]
pub struct ReferenceLookupEntry {
    pub relative_path: String,
    pub name: String,
    pub title: String,
    pub is_note: bool,
}

static IMAGE_MD: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"!\[([^\]\n]*?)\]\(([^)\n]*?)\)").unwrap());
static IMAGE_WIKI: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"!\[\[([^\]|]+?)(\|([^\]]+?))?\]\]").unwrap());
static LINK_MD: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\[([^\]\n]+?)\]\(([^)\n]*?)\)").unwrap());
static WIKI: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\[\[([^\]|]+?)(\|([^\]]+?))?\]\]").unwrap());

pub fn path_matches_or_descends(candidate: &str, target: &str) -> bool {
    candidate == target || candidate.starts_with(&format!("{target}/"))
}

pub fn remap_path(candidate: &str, old_path: &str, new_path: &str) -> Option<String> {
    if candidate == old_path {
        return Some(new_path.to_string());
    }
    candidate
        .strip_prefix(&format!("{old_path}/"))
        .map(|suffix| format!("{new_path}/{suffix}"))
}

pub fn split_path_suffix(value: &str) -> (&str, &str) {
    match value.find(['?', '#']) {
        Some(index) => (&value[..index], &value[index..]),
        None => (value, ""),
    }
}

pub fn relative_path_from_dir(base_dir: &Path, target: &Path) -> String {
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

pub fn build_reference_lookup<I, S>(file_relative_paths: I) -> Vec<ReferenceLookupEntry>
where
    I: IntoIterator<Item = S>,
    S: AsRef<str>,
{
    file_relative_paths
        .into_iter()
        .map(|relative_path| {
            let relative_path = relative_path.as_ref().to_string();
            let name = relative_path
                .rsplit_once('/')
                .map(|(_, name)| name)
                .unwrap_or(&relative_path)
                .to_string();
            let title = Path::new(&relative_path)
                .file_stem()
                .and_then(|stem| stem.to_str())
                .unwrap_or(&name)
                .to_string();
            let is_note = Path::new(&relative_path)
                .extension()
                .and_then(|extension| extension.to_str())
                .is_some_and(|extension| extension.eq_ignore_ascii_case("md"));
            ReferenceLookupEntry {
                relative_path,
                name,
                title,
                is_note,
            }
        })
        .collect()
}

fn normalized_path_string(path: &str) -> Option<String> {
    normalize_relative_path(path)
        .ok()
        .map(|value| value.to_string_lossy().replace('\\', "/"))
}

fn resolve_relative_to_note(path_part: &str, note_relative_path: &str) -> Option<PathBuf> {
    if path_part.starts_with('/') {
        normalize_relative_path(path_part).ok()
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
        .ok()
    }
}

fn format_rewritten_target(
    note_relative_path: &str,
    original_target_path: &str,
    rewritten_path: &str,
    suffix: &str,
) -> String {
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
    let resolved = resolve_relative_to_note(path_part, note_relative_path)?;
    let resolved_str = resolved.to_string_lossy().replace('\\', "/");
    if !path_matches_or_descends(&resolved_str, old_path) {
        return None;
    }

    match new_path {
        Some(next_path) => {
            let rewritten = remap_path(&resolved_str, old_path, next_path)?;
            Some(Some(format_rewritten_target(
                note_relative_path,
                path_part,
                &rewritten,
                suffix,
            )))
        }
        None => Some(None),
    }
}

pub fn rewrite_note_references(
    content: &str,
    note_relative_path: &str,
    old_path: &str,
    new_path: Option<&str>,
) -> String {
    let content = IMAGE_MD.replace_all(content, |caps: &Captures| {
        match rewrite_target_reference(&caps[2], note_relative_path, old_path, new_path) {
            Some(Some(next_target)) => format!("![{}]({next_target})", &caps[1]),
            Some(None) => String::new(),
            None => caps[0].to_string(),
        }
    });

    let content =
        IMAGE_WIKI.replace_all(&content, |caps: &Captures| {
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
    let content = LINK_MD.replace_all(&content_string, |caps: &Captures| {
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
    WIKI.replace_all(&content_string, |caps: &Captures| {
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
            Some(None) => caps
                .get(3)
                .map(|label| label.as_str().to_string())
                .unwrap_or_else(|| caps[1].to_string()),
            None => full.to_string(),
        }
    })
    .into_owned()
}

pub fn resolve_note_target_reference(raw_target: &str, note_relative_path: &str) -> Option<String> {
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
    let resolved = resolve_relative_to_note(path_part, note_relative_path)?;
    Some(resolved.to_string_lossy().replace('\\', "/"))
}

pub fn resolve_wikilink_reference(
    raw_target: &str,
    note_relative_path: &str,
    lookup: &[ReferenceLookupEntry],
) -> Option<String> {
    let trimmed = raw_target.trim();
    if trimmed.is_empty() {
        return None;
    }

    let normalized = normalized_path_string(split_path_suffix(trimmed).0)?;
    let normalized_lower = normalized.to_ascii_lowercase();

    if let Some(entry) = lookup
        .iter()
        .find(|entry| entry.relative_path.eq_ignore_ascii_case(&normalized))
    {
        return Some(entry.relative_path.clone());
    }

    if let Some(path_like) = resolve_note_target_reference(trimmed, note_relative_path) {
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

    if !normalized.contains('/') {
        if let Some(entry) = lookup
            .iter()
            .find(|entry| entry.is_note && entry.name.eq_ignore_ascii_case(&normalized))
        {
            return Some(entry.relative_path.clone());
        }
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

fn collect_sheet_path_reference(
    references: &mut Vec<FileReference>,
    raw_target: &str,
    source_relative_path: &str,
    target_path: &str,
    reference_kind: &str,
    display_label: Option<String>,
) {
    let (path, _) = split_path_suffix(raw_target.trim());
    let Some(normalized) = normalized_path_string(path) else {
        return;
    };
    if !path_matches_or_descends(&normalized, target_path) {
        return;
    }
    references.push(FileReference {
        referenced_relative_path: normalized,
        source_relative_path: source_relative_path.to_string(),
        source_document_type: "sheet".into(),
        reference_kind: reference_kind.into(),
        display_label,
        context: Some(raw_target.to_string()),
    });
}

pub fn collect_sheet_references(
    content: &str,
    source_relative_path: &str,
    target_path: &str,
) -> Result<Vec<FileReference>, ReferenceError> {
    let document: serde_json::Value = serde_json::from_str(content)
        .map_err(|error| ReferenceError::InvalidDocument(error.to_string()))?;
    let mut references = Vec::new();
    let Some(worksheets) = document
        .get("worksheets")
        .and_then(serde_json::Value::as_array)
    else {
        return Ok(references);
    };
    for worksheet in worksheets {
        let Some(cells) = worksheet
            .get("cells")
            .and_then(serde_json::Value::as_object)
        else {
            continue;
        };
        for cell in cells.values() {
            if let Some(link) = cell.get("link").and_then(serde_json::Value::as_str) {
                collect_sheet_path_reference(
                    &mut references,
                    link,
                    source_relative_path,
                    target_path,
                    "sheet-cell-link",
                    None,
                );
            }
            let Some(attachments) = cell
                .get("attachments")
                .and_then(serde_json::Value::as_array)
            else {
                continue;
            };
            for attachment in attachments {
                let Some(path) = attachment
                    .get("relativePath")
                    .and_then(serde_json::Value::as_str)
                else {
                    continue;
                };
                collect_sheet_path_reference(
                    &mut references,
                    path,
                    source_relative_path,
                    target_path,
                    "sheet-cell-attachment",
                    attachment
                        .get("label")
                        .and_then(serde_json::Value::as_str)
                        .map(str::to_string),
                );
            }
        }
    }
    if let Some(connections) = document
        .get("dataConnections")
        .and_then(serde_json::Value::as_array)
    {
        for connection in connections {
            if let Some(path) = connection
                .get("sourcePath")
                .and_then(serde_json::Value::as_str)
            {
                collect_sheet_path_reference(
                    &mut references,
                    path,
                    source_relative_path,
                    target_path,
                    "sheet-data-snapshot-source",
                    None,
                );
            }
        }
    }
    Ok(references)
}

fn rewrite_sheet_path(raw_target: &str, old_path: &str, new_path: Option<&str>) -> Option<String> {
    let (path, suffix) = split_path_suffix(raw_target.trim());
    let normalized = normalized_path_string(path)?;
    if !path_matches_or_descends(&normalized, old_path) {
        return Some(raw_target.to_string());
    }
    new_path
        .and_then(|next| remap_path(&normalized, old_path, next))
        .map(|next| format!("{next}{suffix}"))
}

pub fn rewrite_sheet_references(
    content: &str,
    old_path: &str,
    new_path: Option<&str>,
) -> Result<String, ReferenceError> {
    let mut document: serde_json::Value = serde_json::from_str(content)
        .map_err(|error| ReferenceError::InvalidDocument(error.to_string()))?;
    let Some(worksheets) = document
        .get_mut("worksheets")
        .and_then(serde_json::Value::as_array_mut)
    else {
        return Ok(content.to_string());
    };
    for worksheet in worksheets {
        let Some(cells) = worksheet
            .get_mut("cells")
            .and_then(serde_json::Value::as_object_mut)
        else {
            continue;
        };
        for cell in cells.values_mut() {
            let Some(cell) = cell.as_object_mut() else {
                continue;
            };
            if let Some(link) = cell.get("link").and_then(serde_json::Value::as_str) {
                match rewrite_sheet_path(link, old_path, new_path) {
                    Some(next) => {
                        cell.insert("link".into(), serde_json::Value::String(next));
                    }
                    None => {
                        cell.remove("link");
                    }
                }
            }
            let Some(attachments) = cell
                .get_mut("attachments")
                .and_then(serde_json::Value::as_array_mut)
            else {
                continue;
            };
            attachments.retain_mut(|attachment| {
                let Some(attachment) = attachment.as_object_mut() else {
                    return false;
                };
                let Some(path) = attachment
                    .get("relativePath")
                    .and_then(serde_json::Value::as_str)
                else {
                    return false;
                };
                match rewrite_sheet_path(path, old_path, new_path) {
                    Some(next) => {
                        attachment.insert("relativePath".into(), serde_json::Value::String(next));
                        true
                    }
                    None => false,
                }
            });
            if attachments.is_empty() {
                cell.remove("attachments");
            }
        }
    }
    if let Some(connections) = document
        .get_mut("dataConnections")
        .and_then(serde_json::Value::as_array_mut)
    {
        connections.retain_mut(|connection| {
            let Some(connection) = connection.as_object_mut() else {
                return false;
            };
            let Some(path) = connection
                .get("sourcePath")
                .and_then(serde_json::Value::as_str)
            else {
                return true;
            };
            match rewrite_sheet_path(path, old_path, new_path) {
                Some(next) => {
                    connection.insert("sourcePath".into(), serde_json::Value::String(next));
                    true
                }
                None => false,
            }
        });
    }
    serde_json::to_string(&document)
        .map_err(|error| ReferenceError::InvalidDocument(error.to_string()))
}

fn snippet_for_reference_context(label: &str, target: &str) -> String {
    if label.trim().is_empty() {
        target.to_string()
    } else {
        format!("{label} -> {target}")
    }
}

fn is_image_prefixed(content: &str, match_start: usize) -> bool {
    content[..match_start].ends_with('!')
}

pub fn collect_note_references(
    content: &str,
    note_relative_path: &str,
    lookup: &[ReferenceLookupEntry],
    target_path: &str,
) -> Vec<FileReference> {
    let mut references = Vec::new();

    for caps in IMAGE_MD.captures_iter(content) {
        let Some(resolved) = resolve_note_target_reference(&caps[2], note_relative_path) else {
            continue;
        };
        if !path_matches_or_descends(&resolved, target_path) {
            continue;
        }
        let label = caps
            .get(1)
            .map(|value| value.as_str().trim())
            .unwrap_or_default();
        references.push(FileReference {
            referenced_relative_path: resolved,
            source_relative_path: note_relative_path.to_string(),
            source_document_type: "note".into(),
            reference_kind: "note-markdown-link".into(),
            display_label: if label.is_empty() {
                None
            } else {
                Some(label.to_string())
            },
            context: Some(snippet_for_reference_context(label, &caps[2])),
        });
    }

    for caps in IMAGE_WIKI.captures_iter(content) {
        let Some(resolved) = resolve_wikilink_reference(&caps[1], note_relative_path, lookup)
        else {
            continue;
        };
        if !path_matches_or_descends(&resolved, target_path) {
            continue;
        }
        let label = caps
            .get(3)
            .map(|value| value.as_str().trim())
            .unwrap_or_default();
        references.push(FileReference {
            referenced_relative_path: resolved,
            source_relative_path: note_relative_path.to_string(),
            source_document_type: "note".into(),
            reference_kind: "note-wikilink".into(),
            display_label: if label.is_empty() {
                Some(caps[1].to_string())
            } else {
                Some(label.to_string())
            },
            context: Some(snippet_for_reference_context(
                if label.is_empty() { &caps[1] } else { label },
                &caps[1],
            )),
        });
    }

    for caps in LINK_MD.captures_iter(content) {
        let Some(full) = caps.get(0) else { continue };
        if full.as_str().starts_with("![") || is_image_prefixed(content, full.start()) {
            continue;
        }
        let Some(resolved) = resolve_note_target_reference(&caps[2], note_relative_path) else {
            continue;
        };
        if !path_matches_or_descends(&resolved, target_path) {
            continue;
        }
        let label = caps
            .get(1)
            .map(|value| value.as_str().trim())
            .unwrap_or_default();
        references.push(FileReference {
            referenced_relative_path: resolved,
            source_relative_path: note_relative_path.to_string(),
            source_document_type: "note".into(),
            reference_kind: "note-markdown-link".into(),
            display_label: if label.is_empty() {
                None
            } else {
                Some(label.to_string())
            },
            context: Some(snippet_for_reference_context(label, &caps[2])),
        });
    }

    for caps in WIKI.captures_iter(content) {
        let Some(full) = caps.get(0) else { continue };
        if full.as_str().starts_with("![[") || is_image_prefixed(content, full.start()) {
            continue;
        }
        let Some(resolved) = resolve_wikilink_reference(&caps[1], note_relative_path, lookup)
        else {
            continue;
        };
        if !path_matches_or_descends(&resolved, target_path) {
            continue;
        }
        let label = caps
            .get(3)
            .map(|value| value.as_str().trim())
            .unwrap_or_default();
        references.push(FileReference {
            referenced_relative_path: resolved,
            source_relative_path: note_relative_path.to_string(),
            source_document_type: "note".into(),
            reference_kind: "note-wikilink".into(),
            display_label: if label.is_empty() {
                Some(caps[1].to_string())
            } else {
                Some(label.to_string())
            },
            context: Some(snippet_for_reference_context(
                if label.is_empty() { &caps[1] } else { label },
                &caps[1],
            )),
        });
    }

    references
}

pub fn collect_kanban_references(
    content: &str,
    source_relative_path: &str,
    target_path: &str,
) -> Result<Vec<FileReference>, ReferenceError> {
    let value: serde_json::Value = serde_json::from_str(content)
        .map_err(|error| ReferenceError::InvalidDocument(error.to_string()))?;
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
                .map(|paths| {
                    paths
                        .iter()
                        .filter_map(|value| value.as_str())
                        .collect::<Vec<_>>()
                })
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

pub fn collect_canvas_references(
    content: &str,
    source_relative_path: &str,
    target_path: &str,
) -> Result<Vec<FileReference>, ReferenceError> {
    let value: serde_json::Value = serde_json::from_str(content)
        .map_err(|error| ReferenceError::InvalidDocument(error.to_string()))?;
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

pub fn rewrite_kanban_references(
    content: &str,
    old_path: &str,
    new_path: Option<&str>,
) -> Result<String, ReferenceError> {
    let mut value: serde_json::Value = serde_json::from_str(content)
        .map_err(|error| ReferenceError::InvalidDocument(error.to_string()))?;
    let Some(columns) = value
        .get_mut("columns")
        .and_then(|columns| columns.as_array_mut())
    else {
        return Ok(content.to_string());
    };

    for column in columns {
        let Some(cards) = column
            .get_mut("cards")
            .and_then(|cards| cards.as_array_mut())
        else {
            continue;
        };
        for card in cards {
            let Some(card_obj) = card.as_object_mut() else {
                continue;
            };

            let mut remaining_paths: Vec<String> = card_obj
                .get("attachmentPaths")
                .and_then(|paths| paths.as_array())
                .map(|paths| {
                    paths
                        .iter()
                        .filter_map(|value| value.as_str())
                        .filter_map(|path| {
                            if !path_matches_or_descends(path, old_path) {
                                return Some(path.to_string());
                            }
                            new_path.and_then(|next_path| remap_path(path, old_path, next_path))
                        })
                        .collect()
                })
                .unwrap_or_default();

            if let Some(path) = card_obj
                .get("relativePath")
                .and_then(|value| value.as_str())
            {
                if !remaining_paths.iter().any(|candidate| candidate == path)
                    && !path_matches_or_descends(path, old_path)
                {
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
                    serde_json::Value::Array(
                        remaining_paths
                            .into_iter()
                            .map(serde_json::Value::String)
                            .collect(),
                    ),
                );
                if let Some(primary_path) = primary {
                    card_obj.insert(
                        "relativePath".into(),
                        serde_json::Value::String(primary_path),
                    );
                }
            }
        }
    }

    serde_json::to_string_pretty(&value)
        .map_err(|error| ReferenceError::InvalidDocument(error.to_string()))
}

pub fn rewrite_canvas_references(
    content: &str,
    old_path: &str,
    new_path: Option<&str>,
) -> Result<String, ReferenceError> {
    let mut value: serde_json::Value = serde_json::from_str(content)
        .map_err(|error| ReferenceError::InvalidDocument(error.to_string()))?;
    let Some(nodes) = value
        .get_mut("nodes")
        .and_then(|nodes| nodes.as_array_mut())
    else {
        return Ok(content.to_string());
    };

    let mut next_nodes = Vec::with_capacity(nodes.len());
    for mut node in nodes.drain(..) {
        let should_keep = if let Some(node_obj) = node.as_object_mut() {
            let node_type = node_obj
                .get("type")
                .and_then(|value| value.as_str())
                .unwrap_or_default();
            if matches!(node_type, "file" | "note") {
                if let Some(relative_path) = node_obj
                    .get("relativePath")
                    .and_then(|value| value.as_str())
                {
                    if path_matches_or_descends(relative_path, old_path) {
                        if let Some(next_path) =
                            new_path.and_then(|next| remap_path(relative_path, old_path, next))
                        {
                            node_obj.insert(
                                "relativePath".into(),
                                serde_json::Value::String(next_path),
                            );
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

    serde_json::to_string_pretty(&value)
        .map_err(|error| ReferenceError::InvalidDocument(error.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn remap_path_updates_exact_and_descendant_matches() {
        assert_eq!(
            remap_path("Notes/Old.md", "Notes/Old.md", "Archive/New.md"),
            Some("Archive/New.md".into())
        );
        assert_eq!(
            remap_path("Media/Pics/a.png", "Media", "Assets"),
            Some("Assets/Pics/a.png".into())
        );
        assert_eq!(remap_path("Other/file.md", "Notes", "Archive"), None);
    }

    #[test]
    fn rewrite_note_references_rewrites_links_and_removes_deleted_targets() {
        let content = "See [doc](Docs/Spec.md) and ![img](Media/pic.png) plus [[Docs/Spec.md|Spec]] and external [x](https://example.com/a.md).";
        let renamed =
            rewrite_note_references(content, "Index.md", "Docs/Spec.md", Some("Docs/Final.md"));
        assert!(renamed.contains("[doc](Docs/Final.md)"));
        assert!(renamed.contains("[[Docs/Final.md|Spec]]"));
        assert!(renamed.contains("https://example.com/a.md"));

        let removed = rewrite_note_references(content, "Index.md", "Media/pic.png", None);
        assert!(!removed.contains("Media/pic.png"));
        assert!(removed.contains("[doc](Docs/Spec.md)"));
    }

    #[test]
    fn rewrite_note_references_keeps_relative_targets_relative() {
        let content = "[sibling](../Shared/Target.md)";
        let rewritten = rewrite_note_references(
            content,
            "Notes/Inner.md",
            "Shared/Target.md",
            Some("Shared/Renamed.md"),
        );
        assert_eq!(rewritten, "[sibling](../Shared/Renamed.md)");
    }

    #[test]
    fn collect_note_references_resolves_wikilinks_through_lookup() {
        let lookup = build_reference_lookup(["Docs/Spec.md", "Media/pic.png"]);
        let references = collect_note_references(
            "Linked: [[Spec]] and ![shot](Media/pic.png)",
            "Index.md",
            &lookup,
            "Docs/Spec.md",
        );
        assert_eq!(references.len(), 1);
        assert_eq!(references[0].reference_kind, "note-wikilink");
        assert_eq!(references[0].referenced_relative_path, "Docs/Spec.md");
    }

    #[test]
    fn collect_note_references_counts_image_links_once() {
        let lookup = build_reference_lookup(["Media/pic.png"]);
        let markdown_image = collect_note_references(
            "Shot: ![shot](Media/pic.png)",
            "Index.md",
            &lookup,
            "Media/pic.png",
        );
        assert_eq!(markdown_image.len(), 1);
        assert_eq!(markdown_image[0].reference_kind, "note-markdown-link");

        let wiki_image = collect_note_references(
            "Shot: ![[Media/pic.png]]",
            "Index.md",
            &lookup,
            "Media/pic.png",
        );
        assert_eq!(wiki_image.len(), 1);
        assert_eq!(wiki_image[0].reference_kind, "note-wikilink");
    }

    #[test]
    fn rewrite_kanban_references_updates_attachment_paths() {
        let board = serde_json::json!({
            "columns": [{
                "title": "Todo",
                "cards": [{
                    "title": "Card",
                    "relativePath": "Docs/Spec.md",
                    "attachmentPaths": ["Docs/Spec.md", "Other.md"]
                }]
            }]
        })
        .to_string();
        let renamed =
            rewrite_kanban_references(&board, "Docs/Spec.md", Some("Docs/Final.md")).unwrap();
        assert!(renamed.contains("Docs/Final.md"));
        assert!(renamed.contains("Other.md"));

        let removed = rewrite_kanban_references(&board, "Docs/Spec.md", None).unwrap();
        assert!(!removed.contains("Docs/Spec.md"));
        assert!(removed.contains("Other.md"));
    }

    #[test]
    fn rewrite_canvas_references_updates_and_removes_file_nodes() {
        let canvas = serde_json::json!({
            "nodes": [
                {"id": "a", "type": "file", "relativePath": "Media/pic.png"},
                {"id": "b", "type": "note", "relativePath": "Docs/Spec.md"},
                {"id": "c", "type": "text", "text": "keep"}
            ],
            "edges": []
        })
        .to_string();
        let renamed =
            rewrite_canvas_references(&canvas, "Media/pic.png", Some("Assets/pic.png")).unwrap();
        assert!(renamed.contains("Assets/pic.png"));
        assert!(renamed.contains("Docs/Spec.md"));

        let removed = rewrite_canvas_references(&canvas, "Docs/Spec.md", None).unwrap();
        assert!(!removed.contains("Docs/Spec.md"));
        assert!(removed.contains("Media/pic.png"));
    }

    #[test]
    fn collect_kanban_and_canvas_references_report_descendants_of_folders() {
        let board = serde_json::json!({
            "columns": [{"title": "Todo", "cards": [{"title": "Card", "attachmentPaths": ["Media/Sub/pic.png"]}]}]
        })
        .to_string();
        let kanban_refs = collect_kanban_references(&board, "Board.kanban", "Media").unwrap();
        assert_eq!(kanban_refs.len(), 1);
        assert_eq!(kanban_refs[0].reference_kind, "kanban-attachment");

        let canvas = serde_json::json!({
            "nodes": [{"id": "a", "type": "file", "relativePath": "Media/Sub/pic.png"}]
        })
        .to_string();
        let canvas_refs = collect_canvas_references(&canvas, "Board.canvas", "Media").unwrap();
        assert_eq!(canvas_refs.len(), 1);
        assert_eq!(canvas_refs[0].reference_kind, "canvas-file-node");
    }

    #[test]
    fn sheet_links_and_attachments_are_collected_and_rewritten() {
        let sheet = serde_json::json!({
            "kind": "collab-sheet",
            "schemaVersion": 1,
            "worksheets": [{
                "cells": {
                    "r1:c1": {
                        "link": "Docs/Spec.md#section",
                        "attachments": [
                            {"id": "att1", "relativePath": "Media/pic.png", "label": "Diagram"}
                        ]
                    }
                }
            }],
            "dataConnections": [{
                "id": "conn1",
                "kind": "kanbanTasks",
                "sourcePath": "Boards/Project.kanban"
            }]
        })
        .to_string();
        let links = collect_sheet_references(&sheet, "Books/Data.sheet", "Docs/Spec.md").unwrap();
        assert_eq!(links.len(), 1);
        assert_eq!(links[0].reference_kind, "sheet-cell-link");
        let attachments = collect_sheet_references(&sheet, "Books/Data.sheet", "Media").unwrap();
        assert_eq!(attachments.len(), 1);
        assert_eq!(attachments[0].display_label.as_deref(), Some("Diagram"));
        let snapshots = collect_sheet_references(&sheet, "Books/Data.sheet", "Boards").unwrap();
        assert_eq!(snapshots[0].reference_kind, "sheet-data-snapshot-source");

        let renamed =
            rewrite_sheet_references(&sheet, "Docs/Spec.md", Some("Docs/Final.md")).unwrap();
        assert!(renamed.contains("Docs/Final.md#section"));
        let removed = rewrite_sheet_references(&sheet, "Media/pic.png", None).unwrap();
        assert!(!removed.contains("Media/pic.png"));
        assert!(!removed.contains("attachments"));
        let moved = rewrite_sheet_references(
            &sheet,
            "Boards/Project.kanban",
            Some("Archive/Project.kanban"),
        )
        .unwrap();
        assert!(moved.contains("Archive/Project.kanban"));
    }

    #[test]
    fn invalid_json_documents_surface_reference_errors() {
        assert!(matches!(
            rewrite_kanban_references("not json", "a", None),
            Err(ReferenceError::InvalidDocument(_))
        ));
        assert!(matches!(
            collect_canvas_references("not json", "a", "b"),
            Err(ReferenceError::InvalidDocument(_))
        ));
    }
}

/* -------------------------------------------------------------------------
 * Ink
 * ---------------------------------------------------------------------- */

/// Walks every image object of an `.ink` document.
///
/// Image objects are the only place a drawing names another vault file, so
/// they are the whole of its reference surface. Strokes, shapes, and text carry
/// no paths.
fn for_each_ink_image<F>(document: &mut serde_json::Value, mut visit: F)
where
    F: FnMut(&mut serde_json::Map<String, serde_json::Value>),
{
    let Some(pages) = document
        .get_mut("pages")
        .and_then(serde_json::Value::as_object_mut)
    else {
        return;
    };
    for page in pages.values_mut() {
        let Some(objects) = page
            .get_mut("scene")
            .and_then(|scene| scene.get_mut("objects"))
            .and_then(serde_json::Value::as_object_mut)
        else {
            continue;
        };
        for object in objects.values_mut() {
            let Some(object) = object.as_object_mut() else {
                continue;
            };
            if object.get("type").and_then(serde_json::Value::as_str) != Some("image") {
                continue;
            }
            visit(object);
        }
    }
}

pub fn collect_ink_references(
    content: &str,
    source_relative_path: &str,
    target_path: &str,
) -> Result<Vec<FileReference>, ReferenceError> {
    let mut document: serde_json::Value = serde_json::from_str(content)
        .map_err(|error| ReferenceError::InvalidDocument(error.to_string()))?;
    let mut references = Vec::new();

    for_each_ink_image(&mut document, |object| {
        let Some(raw_target) = object
            .get("relativePath")
            .and_then(serde_json::Value::as_str)
        else {
            return;
        };
        let (path, _) = split_path_suffix(raw_target.trim());
        let Some(normalized) = normalized_path_string(path) else {
            return;
        };
        if !path_matches_or_descends(&normalized, target_path) {
            return;
        }
        references.push(FileReference {
            referenced_relative_path: normalized,
            source_relative_path: source_relative_path.to_string(),
            source_document_type: "ink".into(),
            reference_kind: "ink-image".into(),
            display_label: object
                .get("id")
                .and_then(serde_json::Value::as_str)
                .map(str::to_string),
            context: Some(raw_target.to_string()),
        });
    });

    Ok(references)
}

pub fn rewrite_ink_references(
    content: &str,
    old_path: &str,
    new_path: Option<&str>,
) -> Result<String, ReferenceError> {
    let mut document: serde_json::Value = serde_json::from_str(content)
        .map_err(|error| ReferenceError::InvalidDocument(error.to_string()))?;

    // Objects whose target was deleted rather than moved. They are removed from
    // `objects` and `objectOrder` together — leaving an id in the order with no
    // object behind it is the exact corruption the normalizer has to repair.
    let mut dropped: Vec<(String, String)> = Vec::new();

    {
        let Some(pages) = document
            .get_mut("pages")
            .and_then(serde_json::Value::as_object_mut)
        else {
            return Ok(content.to_string());
        };
        for (page_id, page) in pages.iter_mut() {
            let Some(objects) = page
                .get_mut("scene")
                .and_then(|scene| scene.get_mut("objects"))
                .and_then(serde_json::Value::as_object_mut)
            else {
                continue;
            };
            let mut remove: Vec<String> = Vec::new();
            for (object_id, object) in objects.iter_mut() {
                let Some(object) = object.as_object_mut() else {
                    continue;
                };
                if object.get("type").and_then(serde_json::Value::as_str) != Some("image") {
                    continue;
                }
                let Some(raw_target) = object
                    .get("relativePath")
                    .and_then(serde_json::Value::as_str)
                else {
                    continue;
                };
                match rewrite_sheet_path(raw_target, old_path, new_path) {
                    Some(next) => {
                        object.insert("relativePath".into(), serde_json::Value::String(next));
                    }
                    None => remove.push(object_id.clone()),
                }
            }
            for object_id in remove {
                objects.remove(&object_id);
                dropped.push((page_id.clone(), object_id));
            }
        }
    }

    for (page_id, object_id) in dropped {
        let Some(order) = document
            .get_mut("pages")
            .and_then(|pages| pages.get_mut(&page_id))
            .and_then(|page| page.get_mut("scene"))
            .and_then(|scene| scene.get_mut("objectOrder"))
            .and_then(serde_json::Value::as_array_mut)
        else {
            continue;
        };
        order.retain(|entry| entry.as_str() != Some(object_id.as_str()));
    }

    serde_json::to_string_pretty(&document)
        .map_err(|error| ReferenceError::InvalidDocument(error.to_string()))
}
