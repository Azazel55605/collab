use crate::models::note::{ConflictInfo, NoteContent, NoteFile, WriteResult};
use sha2::{Digest, Sha256};
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};
use walkdir::WalkDir;

fn compute_hash(content: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(content.as_bytes());
    hex::encode(hasher.finalize())
}

fn system_time_to_ms(t: SystemTime) -> u64 {
    t.duration_since(UNIX_EPOCH).unwrap_or_default().as_millis() as u64
}

fn is_allowed_extension(ext: &str) -> bool {
    matches!(ext, "md" | "canvas" | "kanban")
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
            // Exclude .collab and hidden directories/files at any level
            !name.starts_with('.')
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
pub fn read_note(vault_path: String, relative_path: String) -> Result<NoteContent, String> {
    let full_path = Path::new(&vault_path).join(&relative_path);
    let content = std::fs::read_to_string(&full_path)
        .map_err(|e| format!("Failed to read '{}': {}", relative_path, e))?;
    let hash = compute_hash(&content);
    let modified_at = std::fs::metadata(&full_path)
        .and_then(|m| m.modified())
        .map(system_time_to_ms)
        .unwrap_or(0);

    Ok(NoteContent {
        content,
        hash,
        modified_at,
    })
}

#[tauri::command]
pub fn write_note(
    vault_path: String,
    relative_path: String,
    content: String,
    expected_hash: Option<String>,
) -> Result<WriteResult, String> {
    let full_path = Path::new(&vault_path).join(&relative_path);

    // If expected_hash is provided and file exists, check for conflicts
    if let Some(ref expected) = expected_hash {
        if full_path.exists() {
            let current_content = std::fs::read_to_string(&full_path)
                .map_err(|e| format!("Failed to read current file: {}", e))?;
            let current_hash = compute_hash(&current_content);

            if &current_hash != expected {
                // Conflict detected
                let hash = compute_hash(&content);
                return Ok(WriteResult {
                    hash,
                    conflict: Some(ConflictInfo {
                        our_content: content,
                        their_content: current_content,
                        relative_path,
                    }),
                });
            }
        }
    }

    // Create parent directories if needed
    if let Some(parent) = full_path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }

    // Atomic write: write to .tmp then rename
    let tmp_path = full_path.with_extension("tmp");
    std::fs::write(&tmp_path, &content).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp_path, &full_path).map_err(|e| e.to_string())?;

    let hash = compute_hash(&content);
    Ok(WriteResult {
        hash,
        conflict: None,
    })
}

#[tauri::command]
pub fn create_note(vault_path: String, relative_path: String) -> Result<NoteFile, String> {
    let full_path = Path::new(&vault_path).join(&relative_path);

    // Create parent directories if needed
    if let Some(parent) = full_path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }

    // Write empty file with frontmatter stub
    let name = full_path
        .file_stem()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_default();

    let frontmatter = format!("---\ntitle: {}\ntags: []\n---\n\n", name);
    std::fs::write(&full_path, &frontmatter).map_err(|e| e.to_string())?;

    let metadata = std::fs::metadata(&full_path).map_err(|e| e.to_string())?;
    let modified_at = metadata
        .modified()
        .map(system_time_to_ms)
        .unwrap_or(0);

    let ext = full_path
        .extension()
        .map(|e| e.to_string_lossy().to_lowercase())
        .unwrap_or_default();

    Ok(NoteFile {
        relative_path,
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

#[tauri::command]
pub fn delete_note(vault_path: String, relative_path: String) -> Result<(), String> {
    let full_path = Path::new(&vault_path).join(&relative_path);
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
) -> Result<(), String> {
    let base = Path::new(&vault_path);
    let old_full = base.join(&old_path);
    let new_full = base.join(&new_path);

    // Create parent directories for destination if needed
    if let Some(parent) = new_full.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }

    std::fs::rename(&old_full, &new_full).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn create_folder(vault_path: String, relative_path: String) -> Result<(), String> {
    let full_path = Path::new(&vault_path).join(&relative_path);
    std::fs::create_dir_all(&full_path).map_err(|e| e.to_string())
}
