//! Tauri commands exposing the native hosted-vault replica store to the
//! frontend. Each command resolves the replica under the shared app config
//! directory. Mutations other than `replica_seed` require an already-seeded
//! replica (the replica is seeded when a hosted vault is opened).

use super::app_config_dir;
use base64::Engine as _;
use collab_protocol::HostedVaultManifest;
use collab_replica::{
    server_key, CacheCleanupReport, CachedContentStatus, PendingOpStatus, PendingOperation,
    ReplicaIntegrityReport, ReplicaStore, ReplicaSummary, ReplicaSyncState, Tombstone,
};
use rand::RngCore;
use serde_json::Value;

#[cfg(any(target_os = "linux", target_os = "windows", target_os = "macos"))]
const REPLICA_KEYRING_SERVICE: &str = "collab-replica";

pub(crate) fn existing_at(
    config_root: &std::path::Path,
    server_url: &str,
    vault_id: &str,
) -> Result<ReplicaStore, String> {
    let store = ReplicaStore::open_existing(&config_root, server_url, vault_id)
        .ok_or_else(|| format!("No local replica for vault {vault_id}"))?;
    let key = replica_key(server_url, vault_id, true)?
        .ok_or_else(|| "Could not create an offline replica key.".to_string())?;
    Ok(store.with_encryption_key(key))
}

fn existing(server_url: &str, vault_id: &str) -> Result<ReplicaStore, String> {
    existing_at(&app_config_dir()?, server_url, vault_id)
}

fn existing_read(server_url: &str, vault_id: &str) -> Result<Option<ReplicaStore>, String> {
    let Some(store) = ReplicaStore::open_existing(&app_config_dir()?, server_url, vault_id) else {
        return Ok(None);
    };
    Ok(match replica_key(server_url, vault_id, false)? {
        Some(key) => Some(store.with_encryption_key(key)),
        None => Some(store),
    })
}

fn replica_account(server_url: &str, vault_id: &str) -> String {
    format!("{}:{vault_id}", server_key(server_url))
}

// ── Replica key persistence ─────────────────────────────────────────────────
//
// The replica's at-rest encryption key must be DURABLE. Unlike a server refresh
// token — where losing the stored value merely forces a re-login — losing this
// key orphans every locally cached document/asset/CRDT blob AND any unsynced
// offline edits (they become undecryptable). It must therefore survive reboots.
//
// On Windows/macOS the native OS keystore is already durable, so the generic
// entry is used. On Linux the key is persisted to the D-Bus Secret Service
// (durable across reboots) and mirrored to the kernel keyutils keyring (a silent
// fast path). Reads try keyutils first (silent, same-session) and fall back to
// the Secret Service, so a key survives a keyutils clear on reboot and any
// legacy keyutils-only key written by an earlier build is still found. This
// fixes the failure where a lost keyutils key was silently regenerated, leaving
// previously-encrypted replica content undecryptable ("Decryption failed …").

#[cfg(any(target_os = "windows", target_os = "macos"))]
fn read_replica_key_encoded(server_url: &str, vault_id: &str) -> Option<String> {
    keyring::Entry::new(
        REPLICA_KEYRING_SERVICE,
        &replica_account(server_url, vault_id),
    )
    .ok()
    .and_then(|entry| entry.get_password().ok())
}

#[cfg(any(target_os = "windows", target_os = "macos"))]
fn write_replica_key_encoded(
    server_url: &str,
    vault_id: &str,
    encoded: &str,
) -> Result<(), String> {
    keyring::Entry::new(
        REPLICA_KEYRING_SERVICE,
        &replica_account(server_url, vault_id),
    )
    .map_err(|_| "The operating system credential store is unavailable.".to_string())?
    .set_password(encoded)
    .map_err(|_| {
        "Could not save the offline replica key in the operating system credential store."
            .to_string()
    })
}

#[cfg(any(target_os = "windows", target_os = "macos"))]
fn delete_replica_key(server_url: &str, vault_id: &str) {
    if let Ok(entry) = keyring::Entry::new(
        REPLICA_KEYRING_SERVICE,
        &replica_account(server_url, vault_id),
    ) {
        let _ = entry.delete_credential();
    }
}

// On Android the replica key is stored, like the refresh token, through the
// AndroidKeyStore-backed Kotlin `CollabReplicaKeyStore` (AES-GCM ciphertext in
// app-private SharedPreferences). This is durable across reboots — required
// because losing the key orphans all cached content and unsynced offline edits.
#[cfg(target_os = "android")]
const REPLICA_KEY_STORE_CLASS: &str = "com.azazel.collab.companion.CollabReplicaKeyStore";

#[cfg(target_os = "android")]
fn read_replica_key_encoded(server_url: &str, vault_id: &str) -> Option<String> {
    let account = replica_account(server_url, vault_id);
    crate::android_jni::call_static_string(REPLICA_KEY_STORE_CLASS, "readKey", &[&account])
        .ok()
        .flatten()
}

#[cfg(target_os = "android")]
fn write_replica_key_encoded(
    server_url: &str,
    vault_id: &str,
    encoded: &str,
) -> Result<(), String> {
    let account = replica_account(server_url, vault_id);
    // The Kotlin store returns an error message string on failure, or null on success.
    match crate::android_jni::call_static_string(
        REPLICA_KEY_STORE_CLASS,
        "storeKey",
        &[&account, encoded],
    )? {
        Some(error) => Err(format!(
            "Could not save the offline replica key in Android Keystore: {error}"
        )),
        None => Ok(()),
    }
}

#[cfg(target_os = "android")]
fn delete_replica_key(server_url: &str, vault_id: &str) {
    let account = replica_account(server_url, vault_id);
    let _ =
        crate::android_jni::call_static_string(REPLICA_KEY_STORE_CLASS, "deleteKey", &[&account]);
}

#[cfg(target_os = "ios")]
fn read_replica_key_encoded(_server_url: &str, _vault_id: &str) -> Option<String> {
    None
}

#[cfg(target_os = "ios")]
fn write_replica_key_encoded(
    _server_url: &str,
    _vault_id: &str,
    _encoded: &str,
) -> Result<(), String> {
    Err("iOS offline replica encryption keys are not implemented yet.".to_string())
}

#[cfg(target_os = "ios")]
fn delete_replica_key(_server_url: &str, _vault_id: &str) {}

#[cfg(target_os = "linux")]
fn replica_keyutils_entry(server_url: &str, vault_id: &str) -> Result<keyring::Entry, String> {
    let cred = keyring::keyutils::KeyutilsCredential::new_with_target(
        None,
        REPLICA_KEYRING_SERVICE,
        &replica_account(server_url, vault_id),
    )
    .map_err(|_| "The session keyring is unavailable.".to_string())?;
    Ok(keyring::Entry::new_with_credential(Box::new(cred)))
}

#[cfg(target_os = "linux")]
fn replica_secret_service_entry(
    server_url: &str,
    vault_id: &str,
) -> Result<keyring::Entry, String> {
    let cred = keyring::secret_service::SsCredential::new_with_target(
        None,
        REPLICA_KEYRING_SERVICE,
        &replica_account(server_url, vault_id),
    )
    .map_err(|_| "The system keyring (Secret Service) is unavailable.".to_string())?;
    Ok(keyring::Entry::new_with_credential(Box::new(cred)))
}

#[cfg(target_os = "linux")]
fn read_replica_key_encoded(server_url: &str, vault_id: &str) -> Option<String> {
    replica_keyutils_entry(server_url, vault_id)
        .ok()
        .and_then(|entry| entry.get_password().ok())
        .or_else(|| {
            replica_secret_service_entry(server_url, vault_id)
                .ok()
                .and_then(|entry| entry.get_password().ok())
        })
}

#[cfg(target_os = "linux")]
fn write_replica_key_encoded(
    server_url: &str,
    vault_id: &str,
    encoded: &str,
) -> Result<(), String> {
    // Durable Secret Service first, then mirror to keyutils; succeed if either
    // persists so a missing/locked Secret Service (e.g. headless) still works via
    // keyutils and is never worse than before.
    let ss = replica_secret_service_entry(server_url, vault_id)
        .and_then(|entry| entry.set_password(encoded).map_err(|e| e.to_string()));
    let ku = replica_keyutils_entry(server_url, vault_id)
        .and_then(|entry| entry.set_password(encoded).map_err(|e| e.to_string()));
    if ss.is_ok() || ku.is_ok() {
        Ok(())
    } else {
        Err(
            "Could not save the offline replica key in the operating system credential store."
                .to_string(),
        )
    }
}

#[cfg(target_os = "linux")]
fn delete_replica_key(server_url: &str, vault_id: &str) {
    if let Ok(entry) = replica_keyutils_entry(server_url, vault_id) {
        let _ = entry.delete_credential();
    }
    if let Ok(entry) = replica_secret_service_entry(server_url, vault_id) {
        let _ = entry.delete_credential();
    }
}

fn replica_key(server_url: &str, vault_id: &str, create: bool) -> Result<Option<[u8; 32]>, String> {
    let encoded = match read_replica_key_encoded(server_url, vault_id) {
        Some(encoded) => encoded,
        None if create => {
            let mut key = [0u8; 32];
            rand::thread_rng().fill_bytes(&mut key);
            let encoded = base64::engine::general_purpose::STANDARD.encode(key);
            write_replica_key_encoded(server_url, vault_id, &encoded)?;
            encoded
        }
        None => return Ok(None),
    };
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(encoded.as_bytes())
        .map_err(|_| "The saved offline replica key is invalid.".to_string())?;
    let key: [u8; 32] = bytes
        .try_into()
        .map_err(|_| "The saved offline replica key has an invalid length.".to_string())?;
    Ok(Some(key))
}

#[tauri::command]
pub fn replica_seed(
    server_url: String,
    vault_id: String,
    vault_name: String,
    manifest: HostedVaultManifest,
    sync_state: ReplicaSyncState,
    role: Option<String>,
    capabilities: Option<Vec<String>>,
) -> Result<(), String> {
    let config_root = app_config_dir()?;
    let capabilities = capabilities.unwrap_or_default();
    let key = replica_key(&server_url, &vault_id, true)?
        .ok_or_else(|| "Could not create an offline replica key.".to_string())?;
    let store = ReplicaStore::open_or_create(
        &config_root,
        &server_url,
        &vault_id,
        &vault_name,
        role.as_deref(),
        &capabilities,
    )?
    .with_encryption_key(key);
    store.write_manifest(&manifest)?;
    store.write_sync_state(&sync_state)
}

#[tauri::command]
pub fn replica_list() -> Result<Vec<ReplicaSummary>, String> {
    ReplicaStore::list(&app_config_dir()?)
}

#[tauri::command]
pub fn replica_read_manifest(
    server_url: String,
    vault_id: String,
) -> Result<Option<HostedVaultManifest>, String> {
    match existing_read(&server_url, &vault_id)? {
        Some(store) => store.read_manifest(),
        None => Ok(None),
    }
}

#[tauri::command]
pub fn replica_read_sync_state(
    server_url: String,
    vault_id: String,
) -> Result<ReplicaSyncState, String> {
    match existing_read(&server_url, &vault_id)? {
        Some(store) => store.read_sync_state(),
        None => Ok(ReplicaSyncState::default()),
    }
}

#[tauri::command]
pub fn replica_write_sync_state(
    server_url: String,
    vault_id: String,
    sync_state: ReplicaSyncState,
) -> Result<(), String> {
    existing(&server_url, &vault_id)?.write_sync_state(&sync_state)
}

#[tauri::command]
pub fn replica_enqueue_operation(
    server_url: String,
    vault_id: String,
    operation: PendingOperation,
) -> Result<(), String> {
    existing(&server_url, &vault_id)?.enqueue_operation(&operation)
}

#[tauri::command]
pub fn replica_list_pending_operations(
    server_url: String,
    vault_id: String,
) -> Result<Vec<PendingOperation>, String> {
    match existing_read(&server_url, &vault_id)? {
        Some(store) => store.list_pending_operations(),
        None => Ok(Vec::new()),
    }
}

#[tauri::command]
pub fn replica_update_operation_status(
    server_url: String,
    vault_id: String,
    operation_id: String,
    status: PendingOpStatus,
) -> Result<(), String> {
    existing(&server_url, &vault_id)?.update_operation_status(&operation_id, status)
}

#[tauri::command]
pub fn replica_record_operation_failure(
    server_url: String,
    vault_id: String,
    operation_id: String,
    failure_code: String,
    failure_message: String,
) -> Result<(), String> {
    existing(&server_url, &vault_id)?.record_operation_failure(
        &operation_id,
        &failure_code,
        &failure_message,
    )
}

#[tauri::command]
pub fn replica_remove_operation(
    server_url: String,
    vault_id: String,
    operation_id: String,
) -> Result<(), String> {
    existing(&server_url, &vault_id)?.remove_operation(&operation_id)
}

#[tauri::command]
pub fn replica_record_tombstone(
    server_url: String,
    vault_id: String,
    tombstone: Tombstone,
) -> Result<(), String> {
    existing(&server_url, &vault_id)?.record_tombstone(&tombstone)
}

#[tauri::command]
pub fn replica_list_tombstones(
    server_url: String,
    vault_id: String,
) -> Result<Vec<Tombstone>, String> {
    match existing_read(&server_url, &vault_id)? {
        Some(store) => store.list_tombstones(),
        None => Ok(Vec::new()),
    }
}

#[tauri::command]
pub fn replica_remove_tombstone(
    server_url: String,
    vault_id: String,
    file_id: String,
) -> Result<(), String> {
    existing(&server_url, &vault_id)?.remove_tombstone(&file_id)
}

#[tauri::command]
pub fn replica_write_logic_components(
    server_url: String,
    vault_id: String,
    components: Vec<Value>,
) -> Result<(), String> {
    existing(&server_url, &vault_id)?.write_logic_components(&components)
}

#[tauri::command]
pub fn replica_read_logic_components(
    server_url: String,
    vault_id: String,
) -> Result<Vec<Value>, String> {
    match existing_read(&server_url, &vault_id)? {
        Some(store) => store.read_logic_components(),
        None => Ok(Vec::new()),
    }
}

#[tauri::command]
pub fn replica_cache_document(
    server_url: String,
    vault_id: String,
    file_id: String,
    content: String,
) -> Result<(), String> {
    existing(&server_url, &vault_id)?.cache_document(&file_id, &content)
}

#[tauri::command]
pub fn replica_read_cached_document(
    server_url: String,
    vault_id: String,
    file_id: String,
) -> Result<Option<String>, String> {
    match existing_read(&server_url, &vault_id)? {
        Some(store) => store.read_cached_document(&file_id),
        None => Ok(None),
    }
}

#[tauri::command]
pub fn replica_cache_asset(
    server_url: String,
    vault_id: String,
    file_id: String,
    base64_content: String,
) -> Result<(), String> {
    use base64::Engine;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(base64_content.as_bytes())
        .map_err(|e| e.to_string())?;
    existing(&server_url, &vault_id)?.cache_asset(&file_id, &bytes)
}

#[tauri::command]
pub fn replica_read_cached_asset(
    server_url: String,
    vault_id: String,
    file_id: String,
) -> Result<Option<String>, String> {
    let bytes = match existing_read(&server_url, &vault_id)? {
        Some(store) => store.read_cached_asset(&file_id)?,
        None => None,
    };
    Ok(bytes.map(|bytes| base64::engine::general_purpose::STANDARD.encode(bytes)))
}

#[tauri::command]
pub fn replica_cached_content_status(
    server_url: String,
    vault_id: String,
    file_id: String,
    kind: String,
    expected_sha256: Option<String>,
) -> Result<CachedContentStatus, String> {
    match existing_read(&server_url, &vault_id)? {
        Some(store) => store.cached_content_status(&file_id, &kind, expected_sha256.as_deref()),
        None => Ok(CachedContentStatus {
            present: false,
            matches_expected_hash: false,
            actual_sha256: None,
            size_bytes: None,
        }),
    }
}

#[tauri::command]
pub fn replica_cache_crdt_state(
    server_url: String,
    vault_id: String,
    file_id: String,
    base64_content: String,
) -> Result<(), String> {
    use base64::Engine;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(base64_content.as_bytes())
        .map_err(|e| e.to_string())?;
    validate_crdt_cache_state(&bytes)?;
    existing(&server_url, &vault_id)?.cache_crdt_state(&file_id, &bytes)
}

fn validate_crdt_cache_state(bytes: &[u8]) -> Result<(), String> {
    collab_live::validate_update(bytes, collab_live::LiveLimits::default())
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn replica_read_crdt_state(
    server_url: String,
    vault_id: String,
    file_id: String,
) -> Result<Option<String>, String> {
    let bytes = match existing_read(&server_url, &vault_id)? {
        Some(store) => store.read_cached_crdt_state(&file_id)?,
        None => None,
    };
    Ok(bytes.map(|bytes| base64::engine::general_purpose::STANDARD.encode(bytes)))
}

#[tauri::command]
pub fn replica_clear_crdt_state(
    server_url: String,
    vault_id: String,
    file_id: String,
) -> Result<(), String> {
    match existing_read(&server_url, &vault_id)? {
        Some(store) => store.clear_cached_crdt_state(&file_id),
        None => Ok(()),
    }
}

#[tauri::command]
pub fn replica_verify(
    server_url: String,
    vault_id: String,
) -> Result<ReplicaIntegrityReport, String> {
    match existing_read(&server_url, &vault_id)? {
        Some(store) => store.verify(),
        None => Ok(ReplicaIntegrityReport {
            ok: true,
            corrupt_files: Vec::new(),
        }),
    }
}

#[tauri::command]
pub fn replica_rebuild(
    server_url: String,
    vault_id: String,
) -> Result<ReplicaIntegrityReport, String> {
    match existing_read(&server_url, &vault_id)? {
        Some(store) => store.rebuild(),
        None => Ok(ReplicaIntegrityReport {
            ok: true,
            corrupt_files: Vec::new(),
        }),
    }
}

#[tauri::command]
pub fn replica_cleanup(
    server_url: String,
    vault_id: String,
    budget_bytes: u64,
) -> Result<CacheCleanupReport, String> {
    match existing_read(&server_url, &vault_id)? {
        Some(store) => store.cleanup(budget_bytes),
        None => Ok(CacheCleanupReport {
            removed_files: 0,
            freed_bytes: 0,
            remaining_bytes: 0,
        }),
    }
}

#[tauri::command]
pub fn replica_delete(server_url: String, vault_id: String) -> Result<(), String> {
    if let Some(store) = ReplicaStore::open_existing(&app_config_dir()?, &server_url, &vault_id) {
        store.delete()?;
    }
    delete_replica_key(&server_url, &vault_id);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::validate_crdt_cache_state;
    use collab_live::{compact_state, seed_document, Doc, LiveDocumentKind, LiveError, LiveLimits};

    #[test]
    fn native_replica_boundary_accepts_yjs_state_and_rejects_invalid_bytes() {
        let doc = Doc::new();
        seed_document(&doc, LiveDocumentKind::NoteText, "offline edit").unwrap();
        assert!(validate_crdt_cache_state(&compact_state(&doc)).is_ok());
        assert_eq!(
            collab_live::validate_update(b"not-yjs", LiveLimits::default()),
            Err(LiveError::InvalidUpdate)
        );
        assert!(validate_crdt_cache_state(b"not-yjs").is_err());
    }
}
