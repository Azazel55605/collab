use crate::crypto;
use crate::models::collab::{ChatMessage, SnapshotMeta};
use crate::models::note::WriteResult;
use crate::models::presence::PresenceEntry;
use crate::models::vault::{KnownUser, MemberRole, VaultConfig, VaultMember};
use crate::state::AppState;
use sha2::{Digest, Sha256};
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, State};

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

fn chat_dir(vault_path: &str) -> std::path::PathBuf {
    Path::new(vault_path).join(".collab").join("chat")
}

fn history_dir(vault_path: &str) -> std::path::PathBuf {
    Path::new(vault_path).join(".collab").join("history")
}

/// Flatten a relative path into a single safe directory name.
/// e.g. "notes/foo.md" → "notes__foo.md"
fn path_key(relative_path: &str) -> String {
    relative_path.replace('/', "__")
}

fn compute_hash(content: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(content.as_bytes());
    hex::encode(hasher.finalize())
}

fn persist_chat_message(vault_path: &str, message: &ChatMessage) -> Result<(), String> {
    let dir = chat_dir(vault_path);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let file_path = dir.join("messages.json");

    let mut messages: Vec<ChatMessage> = if file_path.exists() {
        let data = std::fs::read_to_string(&file_path).map_err(|e| e.to_string())?;
        serde_json::from_str(&data).unwrap_or_default()
    } else {
        Vec::new()
    };

    messages.push(message.clone());

    if messages.len() > 500 {
        messages.drain(0..messages.len() - 500);
    }

    let data = serde_json::to_string_pretty(&messages).map_err(|e| e.to_string())?;
    let tmp = file_path.with_extension("tmp");
    std::fs::write(&tmp, data).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &file_path).map_err(|e| e.to_string())?;

    Ok(())
}

// ── Presence ──────────────────────────────────────────────────────────────────

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
    let stale_threshold = 30_000u64;
    let mut entries: Vec<PresenceEntry> = Vec::new();
    let read_dir = std::fs::read_dir(&dir).map_err(|e| e.to_string())?;
    for item in read_dir {
        let item = item.map_err(|e| e.to_string())?;
        let path = item.path();
        if path.extension().map(|e| e == "json").unwrap_or(false) {
            let data = match std::fs::read_to_string(&path) {
                Ok(d) => d,
                Err(_) => continue,
            };
            let presence: PresenceEntry = match serde_json::from_str(&data) {
                Ok(p) => p,
                Err(_) => continue,
            };
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

// ── Vault config ──────────────────────────────────────────────────────────────

fn write_config_atomic(vault_path: &str, config: &VaultConfig, app: &AppHandle) -> Result<(), String> {
    let config_path = vault_config_path(vault_path);
    if let Some(parent) = config_path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let data = serde_json::to_string_pretty(config).map_err(|e| e.to_string())?;
    let tmp = config_path.with_extension("tmp");
    std::fs::write(&tmp, &data).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &config_path).map_err(|e| e.to_string())?;
    // Notify all windows that the vault config changed
    let _ = app.emit("collab:config-changed", serde_json::json!({}));
    Ok(())
}

#[tauri::command]
pub fn get_vault_config(vault_path: String) -> Result<VaultConfig, String> {
    let config_path = vault_config_path(&vault_path);
    if !config_path.exists() {
        return Err(format!("vault.json not found at '{}'", config_path.display()));
    }
    let data = std::fs::read_to_string(&config_path).map_err(|e| e.to_string())?;
    serde_json::from_str(&data).map_err(|e| e.to_string())
}

/// Update vault-level settings (name, etc.) — admin only.
/// The `owner` field is always preserved from the existing config.
#[tauri::command]
pub fn update_vault_config(
    vault_path: String,
    requesting_user_id: String,
    config: VaultConfig,
    app: AppHandle,
) -> Result<(), String> {
    let existing = get_vault_config(vault_path.clone())?;
    require_admin(&existing, &requesting_user_id)?;

    // Preserve owner and members — use dedicated commands to change those
    let protected = VaultConfig {
        owner: existing.owner,
        members: existing.members,
        known_users: config.known_users,
        ..config
    };
    write_config_atomic(&vault_path, &protected, &app)
}

/// Register the current user in known_users — no admin required.
/// Only updates the `known_users` list; cannot touch `owner` or `members`.
#[tauri::command]
pub fn register_known_user(
    vault_path: String,
    user_id: String,
    user_name: String,
    user_color: String,
    app: AppHandle,
) -> Result<VaultConfig, String> {
    let mut config = get_vault_config(vault_path.clone())?;
    let now = now_ms();

    if let Some(existing) = config.known_users.iter_mut().find(|u| u.user_id == user_id) {
        // Update mutable fields but keep user_id stable
        existing.user_name = user_name;
        existing.user_color = user_color;
        existing.last_seen = now;
    } else {
        config.known_users.push(KnownUser { user_id, user_name, user_color, last_seen: now });
    }

    write_config_atomic(&vault_path, &config, &app)?;
    Ok(config)
}

/// Claim ownership of a vault that has no owner set yet — no admin required.
/// Fails if an owner is already set. This is the migration path for legacy vaults.
#[tauri::command]
pub fn claim_vault_ownership(
    vault_path: String,
    user_id: String,
    user_name: String,
    app: AppHandle,
) -> Result<VaultConfig, String> {
    let mut config = get_vault_config(vault_path.clone())?;

    if config.owner.is_some() {
        return Err("Vault already has an owner".to_string());
    }

    // Set owner
    config.owner = Some(user_id.clone());

    // Upsert as Admin member (avoid duplicate)
    config.members.retain(|m| m.user_id != user_id);
    config.members.push(VaultMember { user_id, user_name, role: MemberRole::Admin });

    write_config_atomic(&vault_path, &config, &app)?;
    Ok(config)
}

// ── Chat ──────────────────────────────────────────────────────────────────────

#[tauri::command]
pub fn send_chat_message(
    vault_path: String,
    message: ChatMessage,
    app: AppHandle,
) -> Result<(), String> {
    persist_chat_message(&vault_path, &message)?;

    // Emit so other open windows receive the message immediately
    let _ = app.emit("collab:chat-message", &message);

    Ok(())
}

#[tauri::command]
pub fn read_chat_messages(vault_path: String, limit: u32) -> Result<Vec<ChatMessage>, String> {
    let file_path = chat_dir(&vault_path).join("messages.json");
    if !file_path.exists() {
        return Ok(vec![]);
    }
    let data = std::fs::read_to_string(&file_path).map_err(|e| e.to_string())?;
    let messages: Vec<ChatMessage> = serde_json::from_str(&data).unwrap_or_default();
    let limit = limit as usize;
    let start = messages.len().saturating_sub(limit);
    Ok(messages[start..].to_vec())
}

// ── Snapshots (version history) ───────────────────────────────────────────────

#[tauri::command]
pub fn create_snapshot(
    vault_path: String,
    relative_path: String,
    content: String,
    author_id: String,
    author_name: String,
    label: Option<String>,
) -> Result<SnapshotMeta, String> {
    let now = now_ms();
    let hash = compute_hash(&content);
    let id = format!("{}_{}", now, &hash[..8]);
    let key = path_key(&relative_path);
    let dir = history_dir(&vault_path).join(&key);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;

    std::fs::write(dir.join(format!("{}.snap", id)), &content)
        .map_err(|e| e.to_string())?;

    let meta = SnapshotMeta {
        id: id.clone(),
        relative_path: relative_path.clone(),
        author_id,
        author_name,
        timestamp: now,
        hash,
        label,
    };

    let index_path = dir.join("index.json");
    let mut index: Vec<SnapshotMeta> = if index_path.exists() {
        let data = std::fs::read_to_string(&index_path).map_err(|e| e.to_string())?;
        serde_json::from_str(&data).unwrap_or_default()
    } else {
        Vec::new()
    };

    index.push(meta.clone());

    // Keep at most 50 snapshots; delete oldest .snap files
    if index.len() > 50 {
        let old: Vec<_> = index.drain(0..index.len() - 50).collect();
        for o in old {
            let _ = std::fs::remove_file(dir.join(format!("{}.snap", o.id)));
        }
    }

    let data = serde_json::to_string_pretty(&index).map_err(|e| e.to_string())?;
    let tmp = index_path.with_extension("tmp");
    std::fs::write(&tmp, data).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &index_path).map_err(|e| e.to_string())?;

    Ok(meta)
}

#[tauri::command]
pub fn list_snapshots(
    vault_path: String,
    relative_path: String,
) -> Result<Vec<SnapshotMeta>, String> {
    let index_path = history_dir(&vault_path)
        .join(path_key(&relative_path))
        .join("index.json");

    if !index_path.exists() {
        return Ok(vec![]);
    }

    let data = std::fs::read_to_string(&index_path).map_err(|e| e.to_string())?;
    let mut index: Vec<SnapshotMeta> = serde_json::from_str(&data).unwrap_or_default();
    index.reverse(); // newest first
    Ok(index)
}

#[tauri::command]
pub fn read_snapshot(
    vault_path: String,
    relative_path: String,
    snapshot_id: String,
) -> Result<String, String> {
    let snap_path = history_dir(&vault_path)
        .join(path_key(&relative_path))
        .join(format!("{}.snap", snapshot_id));

    if !snap_path.exists() {
        return Err(format!("Snapshot '{}' not found", snapshot_id));
    }

    std::fs::read_to_string(&snap_path).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn restore_snapshot(
    vault_path: String,
    relative_path: String,
    snapshot_id: String,
    restoring_user_id: String,
    restoring_user_name: String,
    state: State<AppState>,
) -> Result<WriteResult, String> {
    let snapshot_content =
        read_snapshot(vault_path.clone(), relative_path.clone(), snapshot_id)?;

    // Auto-snapshot the current state so the restore can be undone
    let full_path = Path::new(&vault_path).join(&relative_path);
    if full_path.exists() {
        let raw = std::fs::read(&full_path).map_err(|e| e.to_string())?;
        let current: String = if crypto::is_encrypted_data(&raw) {
            let key_guard = state.encryption_key.read();
            match *key_guard {
                Some(k) => {
                    let bytes = crypto::decrypt_bytes(&k, &raw).map_err(|e| e.to_string())?;
                    String::from_utf8(bytes).map_err(|e| e.to_string())?
                }
                None => return Err("Vault is encrypted but no decryption key is loaded".to_string()),
            }
        } else {
            String::from_utf8(raw).map_err(|e| e.to_string())?
        };

        let _ = create_snapshot(
            vault_path.clone(),
            relative_path.clone(),
            current,
            restoring_user_id,
            restoring_user_name,
            Some("Before restore".to_string()),
        );
    }

    // Write the restored content, encrypting if a vault key is active
    let key_opt: Option<[u8; 32]> = *state.encryption_key.read();
    let bytes: Vec<u8> = if let Some(key) = key_opt {
        crypto::encrypt_bytes(&key, snapshot_content.as_bytes()).map_err(|e| e.to_string())?
    } else {
        snapshot_content.as_bytes().to_vec()
    };

    if let Some(parent) = full_path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let tmp = full_path.with_extension("tmp");
    std::fs::write(&tmp, &bytes).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &full_path).map_err(|e| e.to_string())?;

    Ok(WriteResult { hash: compute_hash(&snapshot_content), conflict: None })
}

// ── Permissions ───────────────────────────────────────────────────────────────

fn require_admin(config: &VaultConfig, requesting_user_id: &str) -> Result<(), String> {
    if config.owner.as_deref() == Some(requesting_user_id) {
        return Ok(());
    }
    let is_admin = config
        .members
        .iter()
        .any(|m| m.user_id == requesting_user_id && m.role == MemberRole::Admin);
    if is_admin {
        Ok(())
    } else {
        Err("Permission denied: only vault admins can manage members".to_string())
    }
}

#[tauri::command]
pub fn invite_member(
    vault_path: String,
    requesting_user_id: String,
    user_id: String,
    role: MemberRole,
    app: AppHandle,
) -> Result<VaultConfig, String> {
    let mut config = get_vault_config(vault_path.clone())?;
    require_admin(&config, &requesting_user_id)?;

    // Only the vault owner can grant admin role
    if role == MemberRole::Admin && config.owner.as_deref() != Some(&requesting_user_id) {
        return Err("Permission denied: only the vault owner can grant admin role".to_string());
    }

    let user_name = config
        .known_users
        .iter()
        .find(|u| u.user_id == user_id)
        .map(|u| u.user_name.clone())
        .ok_or_else(|| {
            "User not found in vault history. They must open this vault at least once first."
                .to_string()
        })?;

    config.members.retain(|m| m.user_id != user_id);
    config.members.push(VaultMember { user_id, user_name, role });

    write_config_atomic(&vault_path, &config, &app)?;
    Ok(config)
}

#[tauri::command]
pub fn update_member_role(
    vault_path: String,
    requesting_user_id: String,
    user_id: String,
    role: MemberRole,
    app: AppHandle,
) -> Result<VaultConfig, String> {
    let mut config = get_vault_config(vault_path.clone())?;
    require_admin(&config, &requesting_user_id)?;

    // Only the vault owner can grant admin role
    if role == MemberRole::Admin && config.owner.as_deref() != Some(&requesting_user_id) {
        return Err("Permission denied: only the vault owner can grant admin role".to_string());
    }

    // Cannot demote or change the owner's own role
    if config.owner.as_deref() == Some(&user_id) {
        return Err("Cannot change the vault owner's role".to_string());
    }

    match config.members.iter_mut().find(|m| m.user_id == user_id) {
        Some(m) => m.role = role,
        None => return Err("Member not found".to_string()),
    }

    write_config_atomic(&vault_path, &config, &app)?;
    Ok(config)
}

#[tauri::command]
pub fn remove_member(
    vault_path: String,
    requesting_user_id: String,
    user_id: String,
    app: AppHandle,
) -> Result<VaultConfig, String> {
    let mut config = get_vault_config(vault_path.clone())?;
    require_admin(&config, &requesting_user_id)?;

    // Cannot remove the owner
    if config.owner.as_deref() == Some(&user_id) {
        return Err("Cannot remove the vault owner".to_string());
    }

    config.members.retain(|m| m.user_id != user_id);
    write_config_atomic(&vault_path, &config, &app)?;
    Ok(config)
}

#[cfg(test)]
mod tests {
    use super::{
        clear_presence, create_snapshot, list_snapshots, path_key, persist_chat_message,
        read_all_presence, read_chat_messages, read_snapshot, write_presence,
    };
    use crate::{
        models::{
            collab::ChatMessage,
            presence::PresenceEntry,
        },
        test_support::TempVault,
    };

    fn sample_presence(user_id: &str, last_seen: u64) -> PresenceEntry {
        PresenceEntry {
            user_id: user_id.to_string(),
            user_name: format!("User {user_id}"),
            user_color: "#abcdef".into(),
            active_file: Some("Notes/Test.md".into()),
            cursor_line: Some(3),
            chat_typing_until: None,
            last_seen,
            app_version: "0.2.8".into(),
        }
    }

    fn sample_chat_message(index: u64) -> ChatMessage {
        ChatMessage {
            id: format!("msg-{index}"),
            user_id: format!("user-{index}"),
            user_name: format!("User {index}"),
            user_color: "#00aaff".into(),
            content: format!("message {index}"),
            timestamp: index,
        }
    }

    #[test]
    fn path_key_flattens_relative_paths() {
        assert_eq!(path_key("notes/foo.md"), "notes__foo.md");
        assert_eq!(path_key("Board.kanban"), "Board.kanban");
    }

    #[test]
    fn presence_write_read_filters_stale_and_clear_removes_file() {
        let vault = TempVault::new().expect("temp vault should exist");
        let now = super::now_ms();

        write_presence(
            vault.path_string(),
            "fresh".into(),
            sample_presence("fresh", now),
        )
        .expect("fresh presence should write");
        write_presence(
            vault.path_string(),
            "stale".into(),
            sample_presence("stale", now.saturating_sub(31_000)),
        )
        .expect("stale presence should write");

        let presence = read_all_presence(vault.path_string())
            .expect("presence should read");

        assert_eq!(presence.len(), 1);
        assert_eq!(presence[0].user_id, "fresh");

        clear_presence(vault.path_string(), "fresh".into())
            .expect("presence file should clear");
        let cleared = read_all_presence(vault.path_string())
            .expect("presence should read after clear");
        assert!(cleared.is_empty());
    }

    #[test]
    fn chat_persistence_prunes_history_and_reads_latest_messages() {
        let vault = TempVault::new().expect("temp vault should exist");

        for index in 0..505 {
            persist_chat_message(&vault.path_string(), &sample_chat_message(index))
                .expect("chat message should persist");
        }

        let latest = read_chat_messages(vault.path_string(), 3)
            .expect("latest chat messages should read");

        assert_eq!(latest.len(), 3);
        assert_eq!(latest[0].id, "msg-502");
        assert_eq!(latest[1].id, "msg-503");
        assert_eq!(latest[2].id, "msg-504");

        let all = read_chat_messages(vault.path_string(), 600)
            .expect("full pruned chat history should read");
        assert_eq!(all.len(), 500);
        assert_eq!(all.first().map(|msg| msg.id.as_str()), Some("msg-5"));
        assert_eq!(all.last().map(|msg| msg.id.as_str()), Some("msg-504"));
    }

    #[test]
    fn snapshot_create_list_and_read_roundtrip() {
        let vault = TempVault::new().expect("temp vault should exist");

        let first = create_snapshot(
            vault.path_string(),
            "Notes/Test.md".into(),
            "first version".into(),
            "user-1".into(),
            "User One".into(),
            Some("Initial".into()),
        )
        .expect("first snapshot should create");
        std::thread::sleep(std::time::Duration::from_millis(2));
        let second = create_snapshot(
            vault.path_string(),
            "Notes/Test.md".into(),
            "second version".into(),
            "user-2".into(),
            "User Two".into(),
            None,
        )
        .expect("second snapshot should create");

        let snapshots = list_snapshots(vault.path_string(), "Notes/Test.md".into())
            .expect("snapshots should list");
        assert_eq!(snapshots.len(), 2);
        assert_eq!(snapshots[0].id, second.id);
        assert_eq!(snapshots[1].id, first.id);

        let restored = read_snapshot(
            vault.path_string(),
            "Notes/Test.md".into(),
            first.id.clone(),
        )
        .expect("snapshot content should read");
        assert_eq!(restored, "first version");
    }

    #[test]
    fn snapshot_history_prunes_to_fifty_entries() {
        let vault = TempVault::new().expect("temp vault should exist");

        for index in 0..55 {
            std::thread::sleep(std::time::Duration::from_millis(1));
            create_snapshot(
                vault.path_string(),
                "Notes/Test.md".into(),
                format!("version {index}"),
                "user".into(),
                "User".into(),
                None,
            )
            .expect("snapshot should create");
        }

        let snapshots = list_snapshots(vault.path_string(), "Notes/Test.md".into())
            .expect("snapshots should list");

        assert_eq!(snapshots.len(), 50);
        assert_eq!(snapshots.first().map(|meta| meta.label.clone()), Some(None));
        assert_eq!(snapshots.last().map(|meta| meta.id.as_str()).is_some(), true);
    }

    #[test]
    fn read_snapshot_errors_for_missing_snapshot() {
        let vault = TempVault::new().expect("temp vault should exist");

        let err = read_snapshot(
            vault.path_string(),
            "Notes/Test.md".into(),
            "missing".into(),
        )
        .expect_err("missing snapshot should fail");

        assert!(err.contains("not found"));
    }
}
