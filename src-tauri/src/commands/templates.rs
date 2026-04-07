use crate::crypto;
use crate::models::note::NoteFile;
use crate::models::template::{KanbanTemplate, TemplateSource};
use crate::state::AppState;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::path::{Component, Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::State;

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredKanbanTemplate {
    version: u32,
    kind: String,
    name: String,
    board: Value,
    updated_at: u64,
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

fn app_config_dir() -> Result<PathBuf, String> {
    let dir = if let Ok(appdata) = std::env::var("APPDATA") {
        PathBuf::from(appdata).join("collab")
    } else {
        let home = std::env::var("HOME")
            .or_else(|_| std::env::var("USERPROFILE"))
            .map_err(|_| "Cannot determine home directory".to_string())?;
        Path::new(&home).join(".config").join("collab")
    };
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
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
                return Err("Path must be relative to the vault root".into());
            }
        }
    }

    Ok(out)
}

fn resolve_vault_path(vault_path: &str, relative_path: &str) -> Result<PathBuf, String> {
    Ok(Path::new(vault_path).join(normalize_relative_path(relative_path)?))
}

fn scope_templates_dir(vault_path: Option<&str>, source: &TemplateSource) -> Result<PathBuf, String> {
    let dir = match source {
        TemplateSource::Vault => {
            let vault_path = vault_path.ok_or("Vault path is required for vault templates")?;
            Path::new(vault_path).join(".collab").join("templates").join("kanban")
        }
        TemplateSource::App => app_config_dir()?.join("templates").join("kanban"),
    };
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

fn normalize_board(board: &Value) -> Result<String, String> {
    serde_json::to_string(board).map_err(|e| e.to_string())
}

fn board_hash(board: &Value) -> Result<String, String> {
    let normalized = normalize_board(board)?;
    let mut hasher = Sha256::new();
    hasher.update(normalized.as_bytes());
    Ok(hex::encode(hasher.finalize()))
}

fn template_file_name(name: &str) -> String {
    let safe = name
        .chars()
        .map(|ch| match ch {
            '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' => '_',
            _ => ch,
        })
        .collect::<String>()
        .trim()
        .trim_matches('.')
        .to_string();
    let stem = if safe.is_empty() { "template".to_string() } else { safe };
    let mut hasher = Sha256::new();
    hasher.update(name.as_bytes());
    let digest = hex::encode(hasher.finalize());
    format!("{stem}--{}.json", &digest[..10])
}

fn template_path(vault_path: Option<&str>, source: &TemplateSource, name: &str) -> Result<PathBuf, String> {
    Ok(scope_templates_dir(vault_path, source)?.join(template_file_name(name)))
}

fn maybe_decrypt_vault_bytes(bytes: Vec<u8>, state: &State<AppState>) -> Result<Vec<u8>, String> {
    if !crypto::is_encrypted_data(&bytes) {
        return Ok(bytes);
    }
    let key_guard = state.encryption_key.read();
    let key = key_guard
        .as_ref()
        .ok_or("Vault is locked — enter the password to unlock it")?;
    crypto::decrypt_bytes(key, &bytes)
}

fn maybe_encrypt_vault_bytes(bytes: &[u8], state: &State<AppState>) -> Result<Vec<u8>, String> {
    let key_guard = state.encryption_key.read();
    if let Some(key) = key_guard.as_ref() {
        crypto::encrypt_bytes(key, bytes)
    } else {
        Ok(bytes.to_vec())
    }
}

fn load_template_from_path(
    path: &Path,
    source: TemplateSource,
    state: &State<AppState>,
) -> Result<KanbanTemplate, String> {
    let raw = std::fs::read(path).map_err(|e| e.to_string())?;
    let bytes = match source {
        TemplateSource::Vault => maybe_decrypt_vault_bytes(raw, state)?,
        TemplateSource::App => raw,
    };
    let stored: StoredKanbanTemplate = serde_json::from_slice(&bytes).map_err(|e| e.to_string())?;
    let hash = board_hash(&stored.board)?;
    Ok(KanbanTemplate {
        kind: stored.kind,
        name: stored.name,
        source,
        hash,
        updated_at: stored.updated_at,
        board: stored.board,
    })
}

fn write_template_to_scope(
    vault_path: Option<&str>,
    source: &TemplateSource,
    name: &str,
    board: Value,
    state: &State<AppState>,
) -> Result<KanbanTemplate, String> {
    let path = template_path(vault_path, source, name)?;
    let stored = StoredKanbanTemplate {
        version: 1,
        kind: "kanban".into(),
        name: name.to_string(),
        board: board.clone(),
        updated_at: now_ms(),
    };
    let serialized = serde_json::to_vec_pretty(&stored).map_err(|e| e.to_string())?;
    let bytes = match source {
        TemplateSource::Vault => maybe_encrypt_vault_bytes(&serialized, state)?,
        TemplateSource::App => serialized,
    };
    std::fs::write(&path, bytes).map_err(|e| e.to_string())?;
    let hash = board_hash(&board)?;
    Ok(KanbanTemplate {
        kind: "kanban".into(),
        name: name.to_string(),
        source: source.clone(),
        hash,
        updated_at: stored.updated_at,
        board,
    })
}

fn read_template_by_name(
    vault_path: Option<&str>,
    source: &TemplateSource,
    name: &str,
    state: &State<AppState>,
) -> Result<KanbanTemplate, String> {
    let path = template_path(vault_path, source, name)?;
    if !path.exists() {
        return Err(format!("Template '{}' not found", name));
    }
    load_template_from_path(&path, source.clone(), state)
}

fn default_blank_board() -> Value {
    json!({ "columns": [] })
}

fn parse_template_file(path: &str) -> Result<(String, Value), String> {
    let content = std::fs::read_to_string(path).map_err(|e| e.to_string())?;
    let value: Value = serde_json::from_str(&content).map_err(|e| e.to_string())?;

    if let (Some(name), Some(board)) = (
        value.get("name").and_then(|v| v.as_str()),
        value.get("board"),
    ) {
        return Ok((name.to_string(), board.clone()));
    }

    if value.get("columns").and_then(|v| v.as_array()).is_some() {
        let stem = Path::new(path)
            .file_stem()
            .and_then(|v| v.to_str())
            .unwrap_or("Imported Template")
            .replace(".kanban-template", "");
        return Ok((stem, value));
    }

    Err("File is not a valid kanban template".into())
}

#[tauri::command]
pub fn list_kanban_templates(
    vault_path: Option<String>,
    state: State<AppState>,
) -> Result<Vec<KanbanTemplate>, String> {
    let mut out = Vec::new();

    for source in [TemplateSource::Vault, TemplateSource::App] {
        let dir = match scope_templates_dir(vault_path.as_deref(), &source) {
            Ok(dir) => dir,
            Err(err) if source == TemplateSource::Vault && vault_path.is_none() => return Err(err),
            Err(_) => continue,
        };

        if !dir.exists() {
            continue;
        }

        for entry in std::fs::read_dir(&dir).map_err(|e| e.to_string())? {
            let path = entry.map_err(|e| e.to_string())?.path();
            if !path.is_file() {
                continue;
            }
            if let Ok(template) = load_template_from_path(&path, source.clone(), &state) {
                out.push(template);
            }
        }
    }

    out.sort_by(|a, b| {
        a.name
            .to_lowercase()
            .cmp(&b.name.to_lowercase())
            .then(a.updated_at.cmp(&b.updated_at))
    });
    Ok(out)
}

#[tauri::command]
pub fn save_kanban_template(
    vault_path: Option<String>,
    source: TemplateSource,
    template_name: String,
    board: Value,
    state: State<AppState>,
) -> Result<KanbanTemplate, String> {
    write_template_to_scope(vault_path.as_deref(), &source, &template_name, board, &state)
}

#[tauri::command]
pub fn delete_kanban_template(
    vault_path: Option<String>,
    source: TemplateSource,
    template_name: String,
) -> Result<(), String> {
    let path = template_path(vault_path.as_deref(), &source, &template_name)?;
    if !path.exists() {
        return Ok(());
    }
    std::fs::remove_file(path).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn copy_kanban_template(
    vault_path: Option<String>,
    from_source: TemplateSource,
    to_source: TemplateSource,
    template_name: String,
    state: State<AppState>,
) -> Result<KanbanTemplate, String> {
    let template = read_template_by_name(vault_path.as_deref(), &from_source, &template_name, &state)?;
    write_template_to_scope(
        vault_path.as_deref(),
        &to_source,
        &template.name,
        template.board,
        &state,
    )
}

#[tauri::command]
pub fn import_kanban_template_from_file(
    vault_path: Option<String>,
    target_source: TemplateSource,
    file_path: String,
    state: State<AppState>,
) -> Result<KanbanTemplate, String> {
    let (name, board) = parse_template_file(&file_path)?;
    write_template_to_scope(vault_path.as_deref(), &target_source, &name, board, &state)
}

#[tauri::command]
pub fn export_kanban_template_to_file(
    vault_path: Option<String>,
    source: TemplateSource,
    template_name: String,
    file_path: String,
    state: State<AppState>,
) -> Result<(), String> {
    let template = read_template_by_name(vault_path.as_deref(), &source, &template_name, &state)?;
    let payload = json!({
        "version": 1,
        "kind": "kanban",
        "name": template.name,
        "board": template.board,
        "updatedAt": template.updated_at,
    });
    let data = serde_json::to_string_pretty(&payload).map_err(|e| e.to_string())?;
    std::fs::write(file_path, data).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn apply_kanban_template(
    vault_path: String,
    source: TemplateSource,
    template_name: String,
    destination_relative_path: String,
    state: State<AppState>,
) -> Result<NoteFile, String> {
    let template = read_template_by_name(Some(&vault_path), &source, &template_name, &state)?;
    let full_path = resolve_vault_path(&vault_path, &destination_relative_path)?;

    if let Some(parent) = full_path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    if full_path.exists() {
        return Err(format!("A board already exists at '{}'", destination_relative_path));
    }

    let content = serde_json::to_vec_pretty(&template.board).map_err(|e| e.to_string())?;
    let bytes = maybe_encrypt_vault_bytes(&content, &state)?;
    std::fs::write(&full_path, bytes).map_err(|e| e.to_string())?;

    let metadata = std::fs::metadata(&full_path).map_err(|e| e.to_string())?;
    let modified_at = metadata
        .modified()
        .map(|t| t.duration_since(UNIX_EPOCH).unwrap_or_default().as_millis() as u64)
        .unwrap_or(0);
    let ext = full_path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or_default()
        .to_string();

    Ok(NoteFile {
        relative_path: destination_relative_path,
        name: full_path
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or_default()
            .to_string(),
        extension: ext,
        modified_at,
        size: metadata.len(),
        is_folder: false,
        children: None,
    })
}

#[tauri::command]
pub fn create_blank_kanban_template(
    vault_path: Option<String>,
    source: TemplateSource,
    template_name: String,
    state: State<AppState>,
) -> Result<KanbanTemplate, String> {
    write_template_to_scope(
        vault_path.as_deref(),
        &source,
        &template_name,
        default_blank_board(),
        &state,
    )
}
