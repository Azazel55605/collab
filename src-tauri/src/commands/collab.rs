use crate::models::presence::PresenceEntry;
use crate::models::vault::VaultConfig;
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

fn presence_dir(vault_path: &str) -> std::path::PathBuf {
    Path::new(vault_path).join(".collab").join("presence")
}

fn vault_config_path(vault_path: &str) -> std::path::PathBuf {
    Path::new(vault_path).join(".collab").join("vault.json")
}

#[tauri::command]
pub fn write_presence(
    vault_path: String,
    user_id: String,
    entry: PresenceEntry,
) -> Result<(), String> {
    let dir = presence_dir(&vault_path);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;

    let file_path = dir.join(format!("{}.json", user_id));
    let data = serde_json::to_string_pretty(&entry).map_err(|e| e.to_string())?;
    std::fs::write(&file_path, data).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn read_all_presence(vault_path: String) -> Result<Vec<PresenceEntry>, String> {
    let dir = presence_dir(&vault_path);

    if !dir.exists() {
        return Ok(vec![]);
    }

    let now = now_ms();
    let stale_threshold = 30_000u64; // 30 seconds in ms

    let mut entries: Vec<PresenceEntry> = Vec::new();

    let read_dir = std::fs::read_dir(&dir).map_err(|e| e.to_string())?;
    for entry in read_dir {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();

        if path.extension().map(|e| e == "json").unwrap_or(false) {
            let data = match std::fs::read_to_string(&path) {
                Ok(d) => d,
                Err(_) => continue,
            };

            let presence: PresenceEntry = match serde_json::from_str(&data) {
                Ok(p) => p,
                Err(_) => continue,
            };

            // Filter out stale entries (older than 30 seconds)
            if now.saturating_sub(presence.last_seen) <= stale_threshold {
                entries.push(presence);
            }
        }
    }

    Ok(entries)
}

#[tauri::command]
pub fn clear_presence(vault_path: String, user_id: String) -> Result<(), String> {
    let file_path = presence_dir(&vault_path).join(format!("{}.json", user_id));
    if file_path.exists() {
        std::fs::remove_file(&file_path).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub fn get_vault_config(vault_path: String) -> Result<VaultConfig, String> {
    let config_path = vault_config_path(&vault_path);
    if !config_path.exists() {
        return Err(format!(
            "vault.json not found at '{}'",
            config_path.display()
        ));
    }
    let data = std::fs::read_to_string(&config_path).map_err(|e| e.to_string())?;
    serde_json::from_str(&data).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn update_vault_config(vault_path: String, config: VaultConfig) -> Result<(), String> {
    let config_path = vault_config_path(&vault_path);
    if let Some(parent) = config_path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let data = serde_json::to_string_pretty(&config).map_err(|e| e.to_string())?;
    std::fs::write(&config_path, data).map_err(|e| e.to_string())
}
