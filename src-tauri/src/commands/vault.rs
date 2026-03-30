use crate::models::vault::{VaultConfig, VaultMeta};
use crate::state::AppState;
use std::io::Write as IoWrite;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, State};
use uuid::Uuid;

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

fn recents_path() -> Result<std::path::PathBuf, String> {
    let home = std::env::var("HOME").map_err(|e| e.to_string())?;
    let dir = std::path::Path::new(&home).join(".config").join("collab");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("recents.json"))
}

fn read_recents() -> Result<Vec<VaultMeta>, String> {
    let path = recents_path()?;
    if !path.exists() {
        return Ok(vec![]);
    }
    let data = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
    serde_json::from_str(&data).map_err(|e| e.to_string())
}

fn write_recents(recents: &[VaultMeta]) -> Result<(), String> {
    let path = recents_path()?;
    let data = serde_json::to_string_pretty(recents).map_err(|e| e.to_string())?;
    std::fs::write(&path, data).map_err(|e| e.to_string())
}

fn upsert_recent(meta: &VaultMeta) -> Result<(), String> {
    let mut recents = read_recents()?;
    recents.retain(|r| r.path != meta.path);
    recents.insert(0, meta.clone());
    // Keep at most 20 recent vaults
    recents.truncate(20);
    write_recents(&recents)
}

fn collab_dir(vault_path: &str) -> std::path::PathBuf {
    std::path::Path::new(vault_path).join(".collab")
}

fn vault_config_path(vault_path: &str) -> std::path::PathBuf {
    collab_dir(vault_path).join("vault.json")
}

fn read_vault_config(vault_path: &str) -> Result<VaultConfig, String> {
    read_vault_config_pub(vault_path)
}

pub fn read_vault_config_pub(vault_path: &str) -> Result<VaultConfig, String> {
    let config_path = vault_config_path(vault_path);
    if !config_path.exists() {
        return Err("vault.json not found".to_string());
    }
    let data = std::fs::read_to_string(&config_path).map_err(|e| e.to_string())?;
    serde_json::from_str(&data).map_err(|e| e.to_string())
}

fn write_vault_config(vault_path: &str, config: &VaultConfig) -> Result<(), String> {
    write_vault_config_pub(vault_path, config)
}

pub fn write_vault_config_pub(vault_path: &str, config: &VaultConfig) -> Result<(), String> {
    let config_path = vault_config_path(vault_path);
    std::fs::create_dir_all(config_path.parent().unwrap()).map_err(|e| e.to_string())?;
    let data = serde_json::to_string_pretty(config).map_err(|e| e.to_string())?;
    std::fs::write(&config_path, data).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn open_vault(path: String, state: State<AppState>) -> Result<VaultMeta, String> {
    let canonical = std::fs::canonicalize(&path)
        .map_err(|e| format!("Cannot open vault path '{}': {}", path, e))?;
    let canonical_str = canonical.to_string_lossy().to_string();

    // Read or create vault.json
    let config = if vault_config_path(&canonical_str).exists() {
        read_vault_config(&canonical_str)?
    } else {
        // Create new vault config for existing directory
        let name = canonical
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_else(|| "Vault".to_string());
        let config = VaultConfig {
            id: Uuid::new_v4().to_string(),
            name: name.clone(),
            known_users: vec![],
            ..Default::default()
        };
        write_vault_config(&canonical_str, &config)?;
        config
    };

    let meta = VaultMeta {
        id: config.id,
        name: config.name,
        path: canonical_str,
        last_opened: now_ms(),
        is_encrypted: config.is_encrypted,
    };

    // Update AppState — clear any stale encryption key from the previous vault.
    *state.encryption_key.write() = None;
    *state.active_vault.write() = Some(meta.clone());

    // Add to recents
    upsert_recent(&meta)?;

    Ok(meta)
}

#[tauri::command]
pub fn create_vault(
    path: String,
    name: String,
    state: State<AppState>,
) -> Result<VaultMeta, String> {
    // Create directory if it doesn't exist
    std::fs::create_dir_all(&path).map_err(|e| e.to_string())?;

    let canonical = std::fs::canonicalize(&path).map_err(|e| e.to_string())?;
    let canonical_str = canonical.to_string_lossy().to_string();

    let id = Uuid::new_v4().to_string();
    let config = VaultConfig {
        id: id.clone(),
        name: name.clone(),
        known_users: vec![],
        ..Default::default()
    };

    write_vault_config(&canonical_str, &config)?;

    // Create presence directory
    let presence_dir = collab_dir(&canonical_str).join("presence");
    std::fs::create_dir_all(&presence_dir).map_err(|e| e.to_string())?;

    let meta = VaultMeta {
        id,
        name,
        path: canonical_str,
        last_opened: now_ms(),
        is_encrypted: false,
    };

    *state.encryption_key.write() = None;
    *state.active_vault.write() = Some(meta.clone());
    upsert_recent(&meta)?;

    Ok(meta)
}

#[tauri::command]
pub fn get_recent_vaults() -> Result<Vec<VaultMeta>, String> {
    read_recents()
}

#[tauri::command]
pub fn remove_recent_vault(path: String) -> Result<(), String> {
    let mut recents = read_recents()?;
    recents.retain(|r| r.path != path);
    write_recents(&recents)
}

#[tauri::command]
pub fn rename_vault(
    vault_path: String,
    new_name: String,
    state: State<AppState>,
) -> Result<VaultMeta, String> {
    let mut config = read_vault_config(&vault_path)?;
    config.name = new_name.clone();
    write_vault_config(&vault_path, &config)?;

    let mut recents = read_recents()?;
    for r in &mut recents {
        if r.path == vault_path {
            r.name = new_name.clone();
        }
    }
    write_recents(&recents)?;

    // Keep active vault name in sync
    let mut av = state.active_vault.write();
    if let Some(ref mut meta) = *av {
        if meta.path == vault_path {
            meta.name = new_name.clone();
        }
    }
    drop(av);

    // Return the updated meta for this vault
    let updated = recents
        .into_iter()
        .find(|r| r.path == vault_path)
        .ok_or_else(|| "Vault not found in recents after rename".to_string())?;
    Ok(updated)
}

#[tauri::command]
pub async fn export_vault(vault_path: String, dest_path: String) -> Result<(), String> {
    use walkdir::WalkDir;

    let vault = std::path::Path::new(&vault_path);
    let file = std::fs::File::create(&dest_path).map_err(|e| e.to_string())?;
    let mut zip = zip::ZipWriter::new(file);
    let options =
        zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);

    for entry in WalkDir::new(vault).min_depth(1) {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();
        let relative = path.strip_prefix(vault).map_err(|e| e.to_string())?;
        let relative_str = relative.to_string_lossy();

        // Skip presence files (runtime artifacts, not meaningful in exports)
        if relative_str.starts_with(".collab/presence") {
            continue;
        }

        if path.is_file() {
            zip.start_file(relative_str.as_ref(), options)
                .map_err(|e| e.to_string())?;
            let data = std::fs::read(path).map_err(|e| e.to_string())?;
            zip.write_all(&data).map_err(|e| e.to_string())?;
        } else if !relative_str.is_empty() {
            zip.add_directory(relative_str.as_ref(), options)
                .map_err(|e| e.to_string())?;
        }
    }

    zip.finish().map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn show_save_dialog(
    app: AppHandle,
    default_name: String,
) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;

    let result = app
        .dialog()
        .file()
        .set_title("Export Vault as ZIP")
        .add_filter("ZIP Archive", &["zip"])
        .set_file_name(&default_name)
        .blocking_save_file();

    match result {
        Some(file_path) => {
            let path_str = file_path
                .into_path()
                .map_err(|e| e.to_string())?
                .to_string_lossy()
                .to_string();
            Ok(Some(path_str))
        }
        None => Ok(None),
    }
}

#[tauri::command]
pub async fn show_open_vault_dialog(app: AppHandle) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;

    let result = app
        .dialog()
        .file()
        .set_title("Open Vault")
        .blocking_pick_folder();

    match result {
        Some(file_path) => {
            // FilePath implements ToString / Into<PathBuf> on desktop
            let path_str = file_path
                .into_path()
                .map_err(|e| e.to_string())?
                .to_string_lossy()
                .to_string();
            Ok(Some(path_str))
        }
        None => Ok(None),
    }
}
