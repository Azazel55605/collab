use crate::crypto;
use crate::models::note::NoteFile;
use crate::models::template::{
    KanbanAutomationPreset, KanbanFilterPreset, KanbanTemplate, NoteSnippet, NoteSnippetScope,
    TemplateSource,
};
use crate::state::AppState;
use collab_core::normalize_relative_path as normalize_core_relative_path;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
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

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredNoteSnippet {
    version: u32,
    id: String,
    name: String,
    description: Option<String>,
    category: Option<String>,
    body: String,
    updated_at: u64,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredKanbanPreset {
    version: u32,
    kind: String,
    name: String,
    payload: Value,
    updated_at: u64,
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

use super::app_config_dir;

fn normalize_relative_path(relative_path: &str) -> Result<PathBuf, String> {
    normalize_core_relative_path(relative_path).map_err(|error| error.to_string())
}

fn resolve_vault_path(vault_path: &str, relative_path: &str) -> Result<PathBuf, String> {
    Ok(Path::new(vault_path).join(normalize_relative_path(relative_path)?))
}

fn scope_templates_dir(
    vault_path: Option<&str>,
    source: &TemplateSource,
) -> Result<PathBuf, String> {
    let dir = match source {
        TemplateSource::Builtin => {
            return Err("Built-in templates are bundled with the application".into());
        }
        TemplateSource::Vault => {
            let vault_path = vault_path.ok_or("Vault path is required for vault templates")?;
            Path::new(vault_path)
                .join(".collab")
                .join("templates")
                .join("kanban")
        }
        TemplateSource::App => app_config_dir()?.join("templates").join("kanban"),
    };
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

fn scope_kanban_preset_dir(
    vault_path: Option<&str>,
    source: &TemplateSource,
    preset_kind: &str,
) -> Result<PathBuf, String> {
    let dir = scope_templates_dir(vault_path, source)?.join(preset_kind);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

fn scope_note_snippets_dir(
    vault_path: Option<&str>,
    scope: &NoteSnippetScope,
) -> Result<PathBuf, String> {
    let dir = match scope {
        NoteSnippetScope::Vault => {
            let vault_path = vault_path.ok_or("Vault path is required for vault note snippets")?;
            Path::new(vault_path)
                .join(".collab")
                .join("templates")
                .join("notes")
        }
        NoteSnippetScope::App => app_config_dir()?.join("templates").join("notes"),
    };
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

fn scope_logic_components_dir(vault_path: &str) -> Result<PathBuf, String> {
    let dir = Path::new(vault_path)
        .join(".collab")
        .join("templates")
        .join("logic-components");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

fn note_snippet_scopes(include_vault_scope: bool) -> Vec<NoteSnippetScope> {
    if include_vault_scope {
        vec![NoteSnippetScope::Vault, NoteSnippetScope::App]
    } else {
        vec![NoteSnippetScope::App]
    }
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
    let stem = if safe.is_empty() {
        "template".to_string()
    } else {
        safe
    };
    let mut hasher = Sha256::new();
    hasher.update(name.as_bytes());
    let digest = hex::encode(hasher.finalize());
    format!("{stem}--{}.json", &digest[..10])
}

fn template_path(
    vault_path: Option<&str>,
    source: &TemplateSource,
    name: &str,
) -> Result<PathBuf, String> {
    Ok(scope_templates_dir(vault_path, source)?.join(template_file_name(name)))
}

fn preset_path(
    vault_path: Option<&str>,
    source: &TemplateSource,
    preset_kind: &str,
    name: &str,
) -> Result<PathBuf, String> {
    Ok(scope_kanban_preset_dir(vault_path, source, preset_kind)?.join(template_file_name(name)))
}

fn snippet_file_name(id: &str) -> String {
    let safe = id
        .chars()
        .map(|ch| match ch {
            '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' => '_',
            _ => ch,
        })
        .collect::<String>()
        .trim()
        .trim_matches('.')
        .to_string();
    let stem = if safe.is_empty() {
        "snippet".to_string()
    } else {
        safe
    };
    format!("{stem}.json")
}

fn logic_component_file_name(id: &str) -> String {
    snippet_file_name(id)
}

fn logic_component_path(vault_path: &str, id: &str) -> Result<PathBuf, String> {
    Ok(scope_logic_components_dir(vault_path)?.join(logic_component_file_name(id)))
}

fn snippet_path(
    vault_path: Option<&str>,
    scope: &NoteSnippetScope,
    id: &str,
) -> Result<PathBuf, String> {
    Ok(scope_note_snippets_dir(vault_path, scope)?.join(snippet_file_name(id)))
}

fn generate_note_snippet_id(name: &str) -> String {
    let ts = now_ms();
    let mut hasher = Sha256::new();
    hasher.update(format!("{name}:{ts}").as_bytes());
    let digest = hex::encode(hasher.finalize());
    format!("snippet-{}-{}", ts, &digest[..10])
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
        TemplateSource::App | TemplateSource::Builtin => raw,
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
    let _mutation = vault_path
        .map(|root| crate::local_mutation::lock_path(Path::new(root)))
        .transpose()?;
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
        TemplateSource::Builtin => {
            return Err("Built-in templates cannot be modified".into());
        }
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
    if source == &TemplateSource::Builtin {
        return builtin_template_by_name(name);
    }
    let path = template_path(vault_path, source, name)?;
    if !path.exists() {
        return Err(format!("Template '{}' not found", name));
    }
    load_template_from_path(&path, source.clone(), state)
}

fn load_note_snippet_from_path(
    path: &Path,
    scope: NoteSnippetScope,
    state: &State<AppState>,
) -> Result<NoteSnippet, String> {
    let raw = std::fs::read(path).map_err(|e| e.to_string())?;
    let bytes = match scope {
        NoteSnippetScope::Vault => maybe_decrypt_vault_bytes(raw, state)?,
        NoteSnippetScope::App => raw,
    };
    let stored: StoredNoteSnippet = serde_json::from_slice(&bytes).map_err(|e| e.to_string())?;
    Ok(NoteSnippet {
        id: stored.id,
        name: stored.name,
        description: stored.description,
        scope,
        category: stored.category,
        body: stored.body,
        updated_at: stored.updated_at,
    })
}

fn write_note_snippet_to_scope(
    vault_path: Option<&str>,
    scope: &NoteSnippetScope,
    snippet_id: Option<String>,
    name: String,
    description: Option<String>,
    category: Option<String>,
    body: String,
    state: &State<AppState>,
) -> Result<NoteSnippet, String> {
    let _mutation = vault_path
        .map(|root| crate::local_mutation::lock_path(Path::new(root)))
        .transpose()?;
    let id = snippet_id
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| generate_note_snippet_id(&name));
    let path = snippet_path(vault_path, scope, &id)?;
    let stored = StoredNoteSnippet {
        version: 1,
        id: id.clone(),
        name: name.clone(),
        description: description.clone().filter(|value| !value.trim().is_empty()),
        category: category.clone().filter(|value| !value.trim().is_empty()),
        body: body.clone(),
        updated_at: now_ms(),
    };
    let serialized = serde_json::to_vec_pretty(&stored).map_err(|e| e.to_string())?;
    let bytes = match scope {
        NoteSnippetScope::Vault => maybe_encrypt_vault_bytes(&serialized, state)?,
        NoteSnippetScope::App => serialized,
    };
    std::fs::write(&path, bytes).map_err(|e| e.to_string())?;
    Ok(NoteSnippet {
        id,
        name,
        description: stored.description,
        scope: scope.clone(),
        category: stored.category,
        body,
        updated_at: stored.updated_at,
    })
}

fn load_filter_preset_from_path(
    path: &Path,
    source: TemplateSource,
    state: &State<AppState>,
) -> Result<KanbanFilterPreset, String> {
    let raw = std::fs::read(path).map_err(|e| e.to_string())?;
    let bytes = match source {
        TemplateSource::Vault => maybe_decrypt_vault_bytes(raw, state)?,
        TemplateSource::App | TemplateSource::Builtin => raw,
    };
    let stored: StoredKanbanPreset = serde_json::from_slice(&bytes).map_err(|e| e.to_string())?;
    Ok(KanbanFilterPreset {
        kind: stored.kind,
        name: stored.name,
        source,
        updated_at: stored.updated_at,
        spec: stored.payload,
    })
}

fn write_filter_preset_to_scope(
    vault_path: Option<&str>,
    source: &TemplateSource,
    name: &str,
    spec: Value,
    state: &State<AppState>,
) -> Result<KanbanFilterPreset, String> {
    let _mutation = vault_path
        .map(|root| crate::local_mutation::lock_path(Path::new(root)))
        .transpose()?;
    if source == &TemplateSource::Builtin {
        return Err("Built-in presets cannot be modified".into());
    }
    let path = preset_path(vault_path, source, "filters", name)?;
    let stored = StoredKanbanPreset {
        version: 1,
        kind: "kanban-filter".into(),
        name: name.to_string(),
        payload: spec.clone(),
        updated_at: now_ms(),
    };
    let serialized = serde_json::to_vec_pretty(&stored).map_err(|e| e.to_string())?;
    let bytes = match source {
        TemplateSource::Vault => maybe_encrypt_vault_bytes(&serialized, state)?,
        TemplateSource::App => serialized,
        TemplateSource::Builtin => return Err("Built-in presets cannot be modified".into()),
    };
    std::fs::write(&path, bytes).map_err(|e| e.to_string())?;
    Ok(KanbanFilterPreset {
        kind: "kanban-filter".into(),
        name: name.to_string(),
        source: source.clone(),
        updated_at: stored.updated_at,
        spec,
    })
}

fn load_automation_preset_from_path(
    path: &Path,
    source: TemplateSource,
    state: &State<AppState>,
) -> Result<KanbanAutomationPreset, String> {
    let raw = std::fs::read(path).map_err(|e| e.to_string())?;
    let bytes = match source {
        TemplateSource::Vault => maybe_decrypt_vault_bytes(raw, state)?,
        TemplateSource::App | TemplateSource::Builtin => raw,
    };
    let stored: StoredKanbanPreset = serde_json::from_slice(&bytes).map_err(|e| e.to_string())?;
    Ok(KanbanAutomationPreset {
        kind: stored.kind,
        name: stored.name,
        source,
        updated_at: stored.updated_at,
        rule: stored.payload,
    })
}

fn write_automation_preset_to_scope(
    vault_path: Option<&str>,
    source: &TemplateSource,
    name: &str,
    rule: Value,
    state: &State<AppState>,
) -> Result<KanbanAutomationPreset, String> {
    let _mutation = vault_path
        .map(|root| crate::local_mutation::lock_path(Path::new(root)))
        .transpose()?;
    if source == &TemplateSource::Builtin {
        return Err("Built-in presets cannot be modified".into());
    }
    let path = preset_path(vault_path, source, "automations", name)?;
    let stored = StoredKanbanPreset {
        version: 1,
        kind: "kanban-automation".into(),
        name: name.to_string(),
        payload: rule.clone(),
        updated_at: now_ms(),
    };
    let serialized = serde_json::to_vec_pretty(&stored).map_err(|e| e.to_string())?;
    let bytes = match source {
        TemplateSource::Vault => maybe_encrypt_vault_bytes(&serialized, state)?,
        TemplateSource::App => serialized,
        TemplateSource::Builtin => return Err("Built-in presets cannot be modified".into()),
    };
    std::fs::write(&path, bytes).map_err(|e| e.to_string())?;
    Ok(KanbanAutomationPreset {
        kind: "kanban-automation".into(),
        name: name.to_string(),
        source: source.clone(),
        updated_at: stored.updated_at,
        rule,
    })
}

fn default_blank_board() -> Value {
    json!({ "columns": [] })
}

fn board_column(id: &str, title: &str, color: &str, cards: Vec<Value>, options: Value) -> Value {
    let mut column = json!({
        "id": id,
        "title": title,
        "color": color,
        "cards": cards,
    });

    if let Some(map) = column.as_object_mut() {
        if let Some(extra) = options.as_object() {
            for (key, value) in extra {
                map.insert(key.clone(), value.clone());
            }
        }
    }

    column
}

fn built_in_templates() -> Vec<KanbanTemplate> {
    let templates = vec![
        (
            "Content Pipeline",
            json!({
                "columns": [
                    board_column("content-ideas", "Ideas", "#64748b", vec![], json!({})),
                    board_column("content-drafting", "Drafting", "#2563eb", vec![], json!({ "defaultTags": ["draft"] })),
                    board_column("content-editing", "Editing", "#7c3aed", vec![], json!({ "defaultTags": ["edit"] })),
                    board_column("content-scheduled", "Scheduled", "#d97706", vec![], json!({ "hideFromTimeline": false })),
                    board_column("content-published", "Published", "#16a34a", vec![], json!({ "autoComplete": true, "isDoneDestination": true, "defaultTags": ["published"] })),
                ]
            }),
        ),
        (
            "Issue Board",
            json!({
                "columns": [
                    board_column("issue-backlog", "Backlog", "#64748b", vec![], json!({ "defaultTags": ["issue"] })),
                    board_column("issue-ready", "Ready", "#2563eb", vec![], json!({ "defaultTags": ["ready"] })),
                    board_column("issue-progress", "In Progress", "#f59e0b", vec![], json!({ "sort": { "field": "priority", "dir": "desc" } })),
                    board_column("issue-blocked", "Blocked", "#dc2626", vec![], json!({ "defaultTags": ["blocked"] })),
                    board_column("issue-done", "Done", "#16a34a", vec![], json!({ "autoComplete": true, "isDoneDestination": true })),
                ]
            }),
        ),
        (
            "Personal Planner",
            json!({
                "columns": [
                    board_column("planner-inbox", "Inbox", "#64748b", vec![], json!({})),
                    board_column("planner-today", "Today", "#2563eb", vec![], json!({ "defaultTags": ["today"], "sort": { "field": "dueDate", "dir": "asc" } })),
                    board_column("planner-week", "This Week", "#7c3aed", vec![], json!({ "defaultTags": ["this-week"], "sort": { "field": "startDate", "dir": "asc" } })),
                    board_column("planner-waiting", "Waiting", "#d97706", vec![], json!({ "defaultTags": ["waiting"] })),
                    board_column("planner-done", "Done", "#16a34a", vec![], json!({ "autoComplete": true, "isDoneDestination": true })),
                ]
            }),
        ),
        (
            "Project Roadmap",
            json!({
                "columns": [
                    board_column("roadmap-ideas", "Ideas", "#64748b", vec![], json!({})),
                    board_column("roadmap-planned", "Planned", "#2563eb", vec![], json!({ "sort": { "field": "startDate", "dir": "asc" } })),
                    board_column("roadmap-progress", "In Progress", "#f59e0b", vec![], json!({ "sort": { "field": "priority", "dir": "desc" } })),
                    board_column("roadmap-blocked", "Blocked", "#dc2626", vec![], json!({ "defaultTags": ["blocked"] })),
                    board_column("roadmap-done", "Done", "#16a34a", vec![], json!({ "autoComplete": true, "isDoneDestination": true })),
                ]
            }),
        ),
        (
            "Research Board",
            json!({
                "columns": [
                    board_column("research-questions", "Questions", "#64748b", vec![], json!({ "defaultTags": ["question"] })),
                    board_column("research-reading", "Reading", "#2563eb", vec![], json!({ "defaultTags": ["source"] })),
                    board_column("research-notes", "Notes", "#7c3aed", vec![], json!({ "defaultTags": ["note"] })),
                    board_column("research-insights", "Insights", "#d97706", vec![], json!({ "defaultTags": ["insight"] })),
                    board_column("research-next", "Next Steps", "#16a34a", vec![], json!({ "defaultTags": ["next-step"] })),
                ]
            }),
        ),
        (
            "Todo List",
            json!({
                "columns": [
                    board_column("todo-up-next", "Up Next", "#64748b", vec![], json!({})),
                    board_column("todo-doing", "Doing", "#2563eb", vec![], json!({ "sort": { "field": "priority", "dir": "desc" } })),
                    board_column("todo-waiting", "Waiting", "#d97706", vec![], json!({ "defaultTags": ["waiting"] })),
                    board_column("todo-done", "Done", "#16a34a", vec![], json!({ "autoComplete": true, "isDoneDestination": true })),
                ]
            }),
        ),
    ];

    templates
        .into_iter()
        .map(|(name, board)| {
            let hash = board_hash(&board).unwrap_or_default();
            KanbanTemplate {
                kind: "kanban".into(),
                name: name.into(),
                source: TemplateSource::Builtin,
                hash,
                updated_at: 0,
                board,
            }
        })
        .collect()
}

fn builtin_template_by_name(name: &str) -> Result<KanbanTemplate, String> {
    built_in_templates()
        .into_iter()
        .find(|template| template.name == name)
        .ok_or_else(|| format!("Template '{}' not found", name))
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
    let mut out = built_in_templates();

    for source in [TemplateSource::Vault, TemplateSource::App] {
        let dir = match scope_templates_dir(vault_path.as_deref(), &source) {
            Ok(dir) => dir,
            // A missing vault path means an app-only listing (e.g. hosted vaults):
            // skip the vault scope rather than failing the whole request.
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
    if source == TemplateSource::Builtin {
        return Err("Built-in templates cannot be modified".into());
    }
    write_template_to_scope(
        vault_path.as_deref(),
        &source,
        &template_name,
        board,
        &state,
    )
}

#[tauri::command]
pub fn delete_kanban_template(
    vault_path: Option<String>,
    source: TemplateSource,
    template_name: String,
) -> Result<(), String> {
    let _mutation = vault_path
        .as_deref()
        .map(|root| crate::local_mutation::lock_path(Path::new(root)))
        .transpose()?;
    if source == TemplateSource::Builtin {
        return Err("Built-in templates cannot be deleted".into());
    }
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
    if to_source == TemplateSource::Builtin {
        return Err("Built-in templates cannot be overwritten".into());
    }
    let template =
        read_template_by_name(vault_path.as_deref(), &from_source, &template_name, &state)?;
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
    if target_source == TemplateSource::Builtin {
        return Err("Cannot import into built-in templates".into());
    }
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
    let _mutation = crate::local_mutation::lock_path(Path::new(&file_path))?;
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
    let _mutation = crate::local_mutation::lock_path(Path::new(&vault_path))?;
    let template = read_template_by_name(Some(&vault_path), &source, &template_name, &state)?;
    let full_path = resolve_vault_path(&vault_path, &destination_relative_path)?;

    if let Some(parent) = full_path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    if full_path.exists() {
        return Err(format!(
            "A board already exists at '{}'",
            destination_relative_path
        ));
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
    if source == TemplateSource::Builtin {
        return Err("Built-in templates cannot be modified".into());
    }
    write_template_to_scope(
        vault_path.as_deref(),
        &source,
        &template_name,
        default_blank_board(),
        &state,
    )
}

#[tauri::command]
pub fn list_kanban_filter_presets(
    vault_path: Option<String>,
    state: State<AppState>,
) -> Result<Vec<KanbanFilterPreset>, String> {
    let mut out = Vec::new();

    for source in [TemplateSource::Vault, TemplateSource::App] {
        let dir = match scope_kanban_preset_dir(vault_path.as_deref(), &source, "filters") {
            Ok(dir) => dir,
            // A missing vault path means an app-only listing (e.g. hosted vaults):
            // skip the vault scope rather than failing the whole request.
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
            if let Ok(preset) = load_filter_preset_from_path(&path, source.clone(), &state) {
                out.push(preset);
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
pub fn save_kanban_filter_preset(
    vault_path: Option<String>,
    source: TemplateSource,
    preset_name: String,
    spec: Value,
    state: State<AppState>,
) -> Result<KanbanFilterPreset, String> {
    write_filter_preset_to_scope(vault_path.as_deref(), &source, &preset_name, spec, &state)
}

#[tauri::command]
pub fn delete_kanban_filter_preset(
    vault_path: Option<String>,
    source: TemplateSource,
    preset_name: String,
) -> Result<(), String> {
    let _mutation = vault_path
        .as_deref()
        .map(|root| crate::local_mutation::lock_path(Path::new(root)))
        .transpose()?;
    if source == TemplateSource::Builtin {
        return Err("Built-in presets cannot be deleted".into());
    }
    let path = preset_path(vault_path.as_deref(), &source, "filters", &preset_name)?;
    if !path.exists() {
        return Ok(());
    }
    std::fs::remove_file(path).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn copy_kanban_filter_preset(
    vault_path: Option<String>,
    from_source: TemplateSource,
    to_source: TemplateSource,
    preset_name: String,
    state: State<AppState>,
) -> Result<KanbanFilterPreset, String> {
    if to_source == TemplateSource::Builtin {
        return Err("Built-in presets cannot be overwritten".into());
    }
    let path = preset_path(vault_path.as_deref(), &from_source, "filters", &preset_name)?;
    let preset = load_filter_preset_from_path(&path, from_source, &state)?;
    write_filter_preset_to_scope(
        vault_path.as_deref(),
        &to_source,
        &preset.name,
        preset.spec,
        &state,
    )
}

#[tauri::command]
pub fn list_kanban_automation_presets(
    vault_path: Option<String>,
    state: State<AppState>,
) -> Result<Vec<KanbanAutomationPreset>, String> {
    let mut out = Vec::new();

    for source in [TemplateSource::Vault, TemplateSource::App] {
        let dir = match scope_kanban_preset_dir(vault_path.as_deref(), &source, "automations") {
            Ok(dir) => dir,
            // A missing vault path means an app-only listing (e.g. hosted vaults):
            // skip the vault scope rather than failing the whole request.
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
            if let Ok(preset) = load_automation_preset_from_path(&path, source.clone(), &state) {
                out.push(preset);
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
pub fn save_kanban_automation_preset(
    vault_path: Option<String>,
    source: TemplateSource,
    preset_name: String,
    rule: Value,
    state: State<AppState>,
) -> Result<KanbanAutomationPreset, String> {
    write_automation_preset_to_scope(vault_path.as_deref(), &source, &preset_name, rule, &state)
}

#[tauri::command]
pub fn delete_kanban_automation_preset(
    vault_path: Option<String>,
    source: TemplateSource,
    preset_name: String,
) -> Result<(), String> {
    let _mutation = vault_path
        .as_deref()
        .map(|root| crate::local_mutation::lock_path(Path::new(root)))
        .transpose()?;
    if source == TemplateSource::Builtin {
        return Err("Built-in presets cannot be deleted".into());
    }
    let path = preset_path(vault_path.as_deref(), &source, "automations", &preset_name)?;
    if !path.exists() {
        return Ok(());
    }
    std::fs::remove_file(path).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn copy_kanban_automation_preset(
    vault_path: Option<String>,
    from_source: TemplateSource,
    to_source: TemplateSource,
    preset_name: String,
    state: State<AppState>,
) -> Result<KanbanAutomationPreset, String> {
    if to_source == TemplateSource::Builtin {
        return Err("Built-in presets cannot be overwritten".into());
    }
    let path = preset_path(
        vault_path.as_deref(),
        &from_source,
        "automations",
        &preset_name,
    )?;
    let preset = load_automation_preset_from_path(&path, from_source, &state)?;
    write_automation_preset_to_scope(
        vault_path.as_deref(),
        &to_source,
        &preset.name,
        preset.rule,
        &state,
    )
}

#[tauri::command]
pub fn list_note_snippets(
    vault_path: Option<String>,
    state: State<AppState>,
) -> Result<Vec<NoteSnippet>, String> {
    let mut out = Vec::new();

    for scope in note_snippet_scopes(vault_path.is_some()) {
        let dir = scope_note_snippets_dir(vault_path.as_deref(), &scope)?;
        if !dir.exists() {
            continue;
        }
        for entry in std::fs::read_dir(&dir).map_err(|e| e.to_string())? {
            let path = entry.map_err(|e| e.to_string())?.path();
            if !path.is_file() {
                continue;
            }
            if let Ok(snippet) = load_note_snippet_from_path(&path, scope.clone(), &state) {
                out.push(snippet);
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
pub fn save_note_snippet(
    vault_path: Option<String>,
    scope: NoteSnippetScope,
    snippet_id: Option<String>,
    name: String,
    description: Option<String>,
    category: Option<String>,
    body: String,
    state: State<AppState>,
) -> Result<NoteSnippet, String> {
    write_note_snippet_to_scope(
        vault_path.as_deref(),
        &scope,
        snippet_id,
        name,
        description,
        category,
        body,
        &state,
    )
}

#[tauri::command]
pub fn delete_note_snippet(
    vault_path: Option<String>,
    scope: NoteSnippetScope,
    snippet_id: String,
) -> Result<(), String> {
    let _mutation = vault_path
        .as_deref()
        .map(|root| crate::local_mutation::lock_path(Path::new(root)))
        .transpose()?;
    let path = snippet_path(vault_path.as_deref(), &scope, &snippet_id)?;
    if !path.exists() {
        return Ok(());
    }
    std::fs::remove_file(path).map_err(|e| e.to_string())
}

fn load_logic_component_from_path(path: &Path, state: &State<AppState>) -> Result<Value, String> {
    let raw = std::fs::read(path).map_err(|e| e.to_string())?;
    let bytes = maybe_decrypt_vault_bytes(raw, state)?;
    serde_json::from_slice(&bytes).map_err(|e| e.to_string())
}

fn logic_component_string_field<'a>(component: &'a Value, field: &str) -> Result<&'a str, String> {
    component
        .get(field)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| format!("Logic component must include a non-empty {field}"))
}

fn logic_component_number_field(component: &Value, field: &str, fallback: u64) -> u64 {
    component
        .get(field)
        .and_then(Value::as_u64)
        .unwrap_or(fallback)
}

#[tauri::command]
pub fn list_logic_components(
    vault_path: String,
    state: State<AppState>,
) -> Result<Vec<Value>, String> {
    let dir = scope_logic_components_dir(&vault_path)?;
    let mut out = Vec::new();
    for entry in std::fs::read_dir(dir).map_err(|e| e.to_string())? {
        let entry = match entry {
            Ok(entry) => entry,
            Err(_) => continue,
        };
        let path = entry.path();
        if path.extension().and_then(|ext| ext.to_str()) != Some("json") {
            continue;
        }
        if let Ok(component) = load_logic_component_from_path(&path, &state) {
            out.push(component);
        }
    }
    out.sort_by(|a, b| {
        let a_name = a.get("name").and_then(Value::as_str).unwrap_or_default();
        let b_name = b.get("name").and_then(Value::as_str).unwrap_or_default();
        a_name.to_lowercase().cmp(&b_name.to_lowercase())
    });
    Ok(out)
}

#[tauri::command]
pub fn save_logic_component(
    vault_path: String,
    component: Value,
    state: State<AppState>,
) -> Result<Value, String> {
    let _mutation = crate::local_mutation::lock_path(Path::new(&vault_path))?;
    let id = logic_component_string_field(&component, "id")?.to_string();
    let name = logic_component_string_field(&component, "name")?.to_string();
    let now = now_ms();
    let mut next = component;
    let mut existing_same_name: Option<Value> = None;

    for existing in list_logic_components(vault_path.clone(), state.clone())? {
        let existing_name = existing
            .get("name")
            .and_then(Value::as_str)
            .unwrap_or_default();
        if existing_name.eq_ignore_ascii_case(&name) {
            existing_same_name = Some(existing);
            break;
        }
    }

    if let Some(existing) = existing_same_name {
        let existing_id = logic_component_string_field(&existing, "id")?.to_string();
        let version = logic_component_number_field(&existing, "version", 1).saturating_add(1);
        next["id"] = Value::String(existing_id);
        next["version"] = Value::from(version);
        next["createdAt"] = Value::from(logic_component_number_field(&existing, "createdAt", now));
    } else {
        next["id"] = Value::String(id);
        next["version"] = Value::from(logic_component_number_field(&next, "version", 1).max(1));
        next["createdAt"] = Value::from(logic_component_number_field(&next, "createdAt", now));
    }
    next["updatedAt"] = Value::from(now);

    let next_id = logic_component_string_field(&next, "id")?.to_string();
    let path = logic_component_path(&vault_path, &next_id)?;
    let bytes = serde_json::to_vec_pretty(&next).map_err(|e| e.to_string())?;
    let bytes = maybe_encrypt_vault_bytes(&bytes, &state)?;
    std::fs::write(path, bytes).map_err(|e| e.to_string())?;
    Ok(next)
}

#[tauri::command]
pub fn delete_logic_component(vault_path: String, component_id: String) -> Result<(), String> {
    let _mutation = crate::local_mutation::lock_path(Path::new(&vault_path))?;
    let path = logic_component_path(&vault_path, &component_id)?;
    if !path.exists() {
        return Ok(());
    }
    std::fs::remove_file(path).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::{
        board_hash, built_in_templates, generate_note_snippet_id, normalize_relative_path,
        note_snippet_scopes, parse_template_file, scope_kanban_preset_dir, snippet_file_name,
        template_file_name,
    };
    use crate::models::template::{NoteSnippetScope, TemplateSource};
    use crate::test_support::TempVault;
    use serde_json::json;
    use std::path::PathBuf;

    #[test]
    fn normalize_relative_path_accepts_safe_template_paths() {
        let normalized = normalize_relative_path("Templates/../Templates/Board.kanban")
            .expect("path should normalize");

        assert_eq!(normalized, PathBuf::from("Templates/Board.kanban"));
    }

    #[test]
    fn normalize_relative_path_rejects_escaping_template_paths() {
        let err =
            normalize_relative_path("../../outside.json").expect_err("escaping path should fail");

        assert!(err.contains("escapes the vault root"));
    }

    #[test]
    fn board_hash_is_stable_for_the_same_board() {
        let board = json!({
            "columns": [
                { "id": "todo", "title": "Todo", "cards": [] }
            ]
        });

        let hash_a = board_hash(&board).expect("hashing should succeed");
        let hash_b = board_hash(&board).expect("hashing should succeed");

        assert_eq!(hash_a, hash_b);
        assert_eq!(hash_a.len(), 64);
    }

    #[test]
    fn template_file_name_sanitizes_and_adds_digest_suffix() {
        let file_name = template_file_name("..Roadmap:/Board?..");

        assert!(file_name.starts_with("Roadmap__Board_--"));
        assert!(file_name.ends_with(".json"));
    }

    #[test]
    fn built_in_templates_have_expected_shape() {
        let templates = built_in_templates();

        assert!(!templates.is_empty());
        assert!(templates.iter().all(|template| template.kind == "kanban"));
        assert!(templates.iter().all(|template| !template.hash.is_empty()));
    }

    #[test]
    fn parse_template_file_accepts_named_template_payload() {
        let vault = TempVault::new().expect("temp vault should exist");
        let path = vault.resolve("template.json");
        std::fs::write(
            &path,
            serde_json::to_string(&json!({
                "name": "Imported Template",
                "board": {
                    "columns": []
                }
            }))
            .expect("json should serialize"),
        )
        .expect("template file should be written");

        let (name, board) =
            parse_template_file(&path.to_string_lossy()).expect("template file should parse");

        assert_eq!(name, "Imported Template");
        assert_eq!(board, json!({ "columns": [] }));
    }

    #[test]
    fn parse_template_file_accepts_raw_board_payload() {
        let vault = TempVault::new().expect("temp vault should exist");
        let path = vault.resolve("Roadmap.kanban-template.json");
        std::fs::write(
            &path,
            serde_json::to_string(&json!({
                "columns": []
            }))
            .expect("json should serialize"),
        )
        .expect("template file should be written");

        let (name, board) =
            parse_template_file(&path.to_string_lossy()).expect("raw board payload should parse");

        assert_eq!(name, "Roadmap");
        assert_eq!(board, json!({ "columns": [] }));
    }

    #[test]
    fn parse_template_file_rejects_invalid_template_payload() {
        let vault = TempVault::new().expect("temp vault should exist");
        let path = vault.resolve("invalid.json");
        std::fs::write(
            &path,
            serde_json::to_string(&json!({
                "name": "Missing board"
            }))
            .expect("json should serialize"),
        )
        .expect("template file should be written");

        let err =
            parse_template_file(&path.to_string_lossy()).expect_err("invalid template should fail");

        assert!(err.contains("valid kanban template"));
    }

    #[test]
    fn snippet_file_name_keeps_ids_stable() {
        assert_eq!(snippet_file_name("snippet-123"), "snippet-123.json");
    }

    #[test]
    fn generated_note_snippet_ids_are_prefixed() {
        let id = generate_note_snippet_id("Meeting Notes");
        assert!(id.starts_with("snippet-"));
    }

    #[test]
    fn hosted_note_snippet_listing_uses_app_scope_only() {
        assert_eq!(note_snippet_scopes(false), vec![NoteSnippetScope::App]);
        assert_eq!(
            note_snippet_scopes(true),
            vec![NoteSnippetScope::Vault, NoteSnippetScope::App]
        );
    }

    #[test]
    fn scope_kanban_preset_dir_uses_hidden_template_namespace() {
        let vault = TempVault::new().expect("temp vault should exist");
        let dir = scope_kanban_preset_dir(
            Some(vault.path().to_str().expect("vault path should be utf-8")),
            &TemplateSource::Vault,
            "filters",
        )
        .expect("preset dir should resolve");

        assert!(dir.ends_with(".collab/templates/kanban/filters"));
    }
}
