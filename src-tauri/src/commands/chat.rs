//! Private unsent drafts, encrypted and scoped to server/account/vault. History
//! is always authorized online; this outbox does not grant offline chat access.
use super::{app_config_dir, replica::replica_key};
use crate::{hosted_client::validate_server_url, state::AppState};
use collab_core::crypto::{decrypt_bytes, encrypt_bytes};
use collab_replica::server_key;
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use std::{
    fs,
    io::Write,
    path::{Path, PathBuf},
};
use tauri::State;
use uuid::Uuid;

static OUTBOX_LOCK: Mutex<()> = Mutex::new(());
const MAX_PENDING: usize = 100;
const MAX_BYTES: u64 = 2 * 1024 * 1024;

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PendingChatMessage {
    pub id: Uuid,
    pub content: String,
    pub created_at: u64,
    /// Conversation replies keep their quoted message across retries.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reply_to: Option<Uuid>,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct ChatOutbox {
    schema_version: u32,
    messages: Vec<PendingChatMessage>,
}

fn scope(
    state: &AppState,
    server_url: &str,
    vault_id: &str,
    expected_account: &str,
    kind: &str,
) -> Result<(PathBuf, String, String), String> {
    if !matches!(kind, "vault" | "conversation") {
        return Err("Invalid chat scope.".into());
    }
    let base = validate_server_url(server_url)?.to_owned();
    let vault = Uuid::parse_str(vault_id).map_err(|_| "Invalid chat vault ID.")?;
    let account = state
        .hosted_sessions()
        .server_sessions
        .read()
        .get(&base)
        .map(|session| session.user.id.clone())
        .ok_or("Reconnect this account before accessing chat drafts.")?;
    if account != expected_account {
        return Err("The connected chat account changed. Reopen chat.".into());
    }
    let account = Uuid::parse_str(&account).map_err(|_| "Invalid chat account ID.")?;
    let path = app_config_dir()?
        .join(if kind == "conversation" {
            "conversation-outbox"
        } else {
            "chat-outbox"
        })
        .join(server_key(&base))
        .join(account.to_string())
        .join(format!("{vault}.enc"));
    Ok((
        path,
        base,
        if kind == "vault" {
            format!("chat-{account}-{vault}")
        } else {
            format!("conversation-chat-{account}-{vault}")
        },
    ))
}

fn read(path: &Path, key: &[u8; 32]) -> Result<Vec<PendingChatMessage>, String> {
    if !path.exists() {
        return Ok(Vec::new());
    }
    if fs::metadata(path).map_err(|e| e.to_string())?.len() > MAX_BYTES {
        return Err("The chat outbox exceeds its storage limit.".into());
    }
    let bytes = fs::read(path).map_err(|e| e.to_string())?;
    let outbox: ChatOutbox = serde_json::from_slice(&decrypt_bytes(key, &bytes)?)
        .map_err(|_| "The chat outbox is corrupted.".to_owned())?;
    if outbox.schema_version != 1 {
        return Err("This chat outbox requires a compatible app version.".into());
    }
    let messages = outbox.messages;
    if messages.len() > MAX_PENDING {
        return Err("Too many pending chat messages.".into());
    }
    Ok(messages)
}

fn write(path: &Path, key: &[u8; 32], messages: &[PendingChatMessage]) -> Result<(), String> {
    let parent = path.parent().ok_or("Invalid chat outbox path.")?;
    fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    let bytes = encrypt_bytes(
        key,
        &serde_json::to_vec(&ChatOutbox {
            schema_version: 1,
            messages: messages.to_vec(),
        })
        .map_err(|e| e.to_string())?,
    )?;
    if bytes.len() as u64 > MAX_BYTES {
        return Err("The chat outbox is full.".into());
    }
    let temporary = path.with_extension("tmp");
    let mut file = fs::File::create(&temporary).map_err(|e| e.to_string())?;
    file.write_all(&bytes).map_err(|e| e.to_string())?;
    file.sync_all().map_err(|e| e.to_string())?;
    drop(file);
    fs::rename(temporary, path).map_err(|e| e.to_string())?;
    #[cfg(unix)]
    fs::File::open(parent)
        .and_then(|directory| directory.sync_all())
        .map_err(|e| e.to_string())?;
    Ok(())
}

fn key_for(path: &Path, base: &str, account: &str) -> Result<[u8; 32], String> {
    // Never replace a missing key for existing encrypted drafts.
    replica_key(base, account, !path.exists())?
        .ok_or_else(|| "The saved chat draft key is unavailable.".into())
}

#[tauri::command]
pub fn hosted_chat_outbox(
    state: State<'_, AppState>,
    server_url: String,
    vault_id: String,
    account_id: String,
    scope_kind: Option<String>,
) -> Result<Vec<PendingChatMessage>, String> {
    let _lock = OUTBOX_LOCK.lock();
    let (path, base, account) = scope(
        &state,
        &server_url,
        &vault_id,
        &account_id,
        scope_kind.as_deref().unwrap_or("vault"),
    )?;
    if !path.exists() {
        return Ok(Vec::new());
    }
    read(&path, &key_for(&path, &base, &account)?)
}

#[tauri::command]
pub fn hosted_chat_queue(
    state: State<'_, AppState>,
    server_url: String,
    vault_id: String,
    account_id: String,
    scope_kind: Option<String>,
    message: PendingChatMessage,
) -> Result<(), String> {
    let _lock = OUTBOX_LOCK.lock();
    let (path, base, account) = scope(
        &state,
        &server_url,
        &vault_id,
        &account_id,
        scope_kind.as_deref().unwrap_or("vault"),
    )?;
    let key = key_for(&path, &base, &account)?;
    let mut messages = read(&path, &key)?;
    let content = message.content.trim();
    if content.is_empty() || content.chars().count() > 4000 {
        return Err("Chat messages must be between 1 and 4000 characters.".into());
    }
    if let Some(previous) = messages.iter().find(|previous| previous.id == message.id) {
        return if previous.content == content {
            Ok(())
        } else {
            Err("That draft ID has already been used.".into())
        };
    }
    if messages.len() >= MAX_PENDING {
        return Err("The chat outbox is full. Retry or discard pending messages first.".into());
    }
    messages.push(PendingChatMessage {
        content: content.to_owned(),
        ..message
    });
    write(&path, &key, &messages)
}

#[tauri::command]
pub fn hosted_chat_discard(
    state: State<'_, AppState>,
    server_url: String,
    vault_id: String,
    account_id: String,
    scope_kind: Option<String>,
    message_id: Uuid,
) -> Result<(), String> {
    let _lock = OUTBOX_LOCK.lock();
    let (path, base, account) = scope(
        &state,
        &server_url,
        &vault_id,
        &account_id,
        scope_kind.as_deref().unwrap_or("vault"),
    )?;
    if !path.exists() {
        return Ok(());
    }
    let key = key_for(&path, &base, &account)?;
    let mut messages = read(&path, &key)?;
    messages.retain(|message| message.id != message_id);
    write(&path, &key, &messages)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn outbox_roundtrip_is_encrypted_and_account_keys_cannot_decrypt_other_drafts() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("drafts.enc");
        let key = [7; 32];
        let message = PendingChatMessage {
            id: Uuid::now_v7(),
            content: "private unsent text".into(),
            created_at: 1,
            reply_to: Some(Uuid::now_v7()),
        };
        write(&path, &key, &[message.clone()]).unwrap();
        assert_eq!(read(&path, &key).unwrap(), vec![message]);
        assert!(!String::from_utf8_lossy(&fs::read(&path).unwrap()).contains("private unsent text"));
        assert!(read(&path, &[8; 32]).is_err());
        write(&path, &key, &[]).unwrap();
        assert!(read(&path, &key).unwrap().is_empty());
    }
}
