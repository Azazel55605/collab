use crate::crypto;
use crate::state::AppState;
use crate::commands::vault::{read_vault_config_pub, write_vault_config_pub};
use rand::RngCore;
use tauri::State;

/// Derive key from password, verify it matches vault.enc, store in AppState.
/// Called when opening an already-encrypted vault.
#[tauri::command]
pub async fn unlock_vault(
    vault_path: String,
    password: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let key = crypto::load_key_from_password(&vault_path, &password)?;
    *state.encryption_key.write() = Some(key);
    Ok(())
}

/// Encrypt all vault files with `password`, create vault.enc, mark vault as encrypted.
/// The vault must currently be plaintext (isEncrypted == false).
#[tauri::command]
pub async fn enable_vault_encryption(
    vault_path: String,
    password: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let mut config = read_vault_config_pub(&vault_path)?;
    if config.is_encrypted {
        return Err("Vault is already encrypted".to_string());
    }

    // Generate a fresh 32-byte random salt.
    let mut salt = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut salt);

    let key = crypto::derive_key(&password, &salt)?;

    // Encrypt all note files.
    crypto::encrypt_vault_files(&vault_path, &key)?;

    // Persist vault.enc (salt + verification block).
    let header = crypto::create_enc_header(&key, &salt)?;
    crypto::save_enc_header(&vault_path, &header)?;

    // Update vault.json.
    config.is_encrypted = true;
    write_vault_config_pub(&vault_path, &config)?;

    // Keep the vault unlocked for this session.
    *state.encryption_key.write() = Some(key);
    Ok(())
}

/// Decrypt all vault files, remove vault.enc, mark vault as plaintext.
#[tauri::command]
pub async fn disable_vault_encryption(
    vault_path: String,
    password: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let mut config = read_vault_config_pub(&vault_path)?;
    if !config.is_encrypted {
        return Err("Vault is not encrypted".to_string());
    }

    let key = crypto::load_key_from_password(&vault_path, &password)?;
    crypto::decrypt_vault_files(&vault_path, &key)?;

    // Remove vault.enc.
    let enc_path = std::path::Path::new(&vault_path)
        .join(".collab")
        .join("vault.enc");
    if enc_path.exists() {
        std::fs::remove_file(&enc_path).map_err(|e| e.to_string())?;
    }

    config.is_encrypted = false;
    write_vault_config_pub(&vault_path, &config)?;

    *state.encryption_key.write() = None;
    Ok(())
}

/// Re-key the vault: decrypt with old password, encrypt with new password.
#[tauri::command]
pub async fn change_vault_password(
    vault_path: String,
    old_password: String,
    new_password: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let config = read_vault_config_pub(&vault_path)?;
    if !config.is_encrypted {
        return Err("Vault is not encrypted".to_string());
    }

    let old_key = crypto::load_key_from_password(&vault_path, &old_password)?;

    // Decrypt everything with old key.
    crypto::decrypt_vault_files(&vault_path, &old_key)?;

    // New salt + new key.
    let mut new_salt = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut new_salt);
    let new_key = crypto::derive_key(&new_password, &new_salt)?;

    // Re-encrypt with new key.
    crypto::encrypt_vault_files(&vault_path, &new_key)?;

    // Update vault.enc.
    let header = crypto::create_enc_header(&new_key, &new_salt)?;
    crypto::save_enc_header(&vault_path, &header)?;

    // Keep unlocked with new key.
    *state.encryption_key.write() = Some(new_key);
    Ok(())
}
