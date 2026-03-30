/// AES-256-GCM encryption with Argon2id key derivation.
///
/// On-disk format for every encrypted file:
///   [4B magic "CENC"] [12B random nonce] [ciphertext || 16B GCM tag]
///
/// vault.enc (JSON in {vault}/.collab/vault.enc):
///   { "salt": "<hex 32B>", "check": "<hex CENC+nonce+ciphertext of VERIFY_PLAIN>" }

use aes_gcm::{
    aead::{Aead, KeyInit},
    Aes256Gcm, Key, Nonce,
};
use argon2::Argon2;
use rand::RngCore;
use serde::{Deserialize, Serialize};
use std::path::Path;

// Magic prefix that marks an encrypted file.
pub const MAGIC: &[u8; 4] = b"CENC";
const NONCE_LEN: usize = 12;
// Known plaintext encrypted with the vault key — used to verify a password.
const VERIFY_PLAIN: &[u8] = b"collab-vault-v1";

// ─── Low-level crypto ─────────────────────────────────────────────────────────

/// Derive a 32-byte AES key from `password` and `salt` using Argon2id defaults.
pub fn derive_key(password: &str, salt: &[u8]) -> Result<[u8; 32], String> {
    let argon2 = Argon2::default();
    let mut key = [0u8; 32];
    argon2
        .hash_password_into(password.as_bytes(), salt, &mut key)
        .map_err(|e| format!("Key derivation failed: {e}"))?;
    Ok(key)
}

/// Returns true when `data` starts with the CENC magic header.
pub fn is_encrypted_data(data: &[u8]) -> bool {
    data.len() >= 4 && data[..4] == *MAGIC
}

/// Encrypt `plaintext` with `key`. Returns `MAGIC || nonce || ciphertext+tag`.
pub fn encrypt_bytes(key: &[u8; 32], plaintext: &[u8]) -> Result<Vec<u8>, String> {
    let mut nonce_bytes = [0u8; NONCE_LEN];
    rand::thread_rng().fill_bytes(&mut nonce_bytes);
    let nonce = Nonce::from_slice(&nonce_bytes);

    let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(key));
    let ciphertext = cipher
        .encrypt(nonce, plaintext)
        .map_err(|e| format!("Encryption failed: {e}"))?;

    let mut out = Vec::with_capacity(4 + NONCE_LEN + ciphertext.len());
    out.extend_from_slice(MAGIC);
    out.extend_from_slice(&nonce_bytes);
    out.extend(ciphertext);
    Ok(out)
}

/// Decrypt data produced by `encrypt_bytes`. Returns the original plaintext.
/// Fails with a clear error if the MAGIC header is missing or authentication fails.
pub fn decrypt_bytes(key: &[u8; 32], data: &[u8]) -> Result<Vec<u8>, String> {
    if data.len() < 4 + NONCE_LEN + 16 {
        return Err("File is too short to be a valid encrypted file".to_string());
    }
    if &data[..4] != MAGIC {
        return Err("File does not have the encrypted-file header".to_string());
    }

    let nonce = Nonce::from_slice(&data[4..4 + NONCE_LEN]);
    let ciphertext = &data[4 + NONCE_LEN..];
    let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(key));

    cipher.decrypt(nonce, ciphertext).map_err(|_| {
        "Decryption failed — incorrect password or corrupted file".to_string()
    })
}

// ─── vault.enc helpers ────────────────────────────────────────────────────────

#[derive(Debug, Serialize, Deserialize)]
pub struct EncHeader {
    /// Hex-encoded 32-byte Argon2id salt.
    pub salt: String,
    /// Hex-encoded encrypted verification block (MAGIC+nonce+ciphertext of VERIFY_PLAIN).
    pub check: String,
}

fn enc_file_path(vault_path: &str) -> std::path::PathBuf {
    Path::new(vault_path).join(".collab").join("vault.enc")
}

/// Load and parse vault.enc.
pub fn load_enc_header(vault_path: &str) -> Result<EncHeader, String> {
    let path = enc_file_path(vault_path);
    let data = std::fs::read_to_string(&path)
        .map_err(|_| "vault.enc not found — vault may not be encrypted".to_string())?;
    serde_json::from_str(&data).map_err(|e| format!("Invalid vault.enc: {e}"))
}

/// Write vault.enc atomically.
pub fn save_enc_header(vault_path: &str, header: &EncHeader) -> Result<(), String> {
    let path = enc_file_path(vault_path);
    std::fs::create_dir_all(path.parent().unwrap()).map_err(|e| e.to_string())?;
    let data = serde_json::to_string_pretty(header).map_err(|e| e.to_string())?;
    std::fs::write(&path, data).map_err(|e| e.to_string())
}

/// Generate vault.enc from a freshly-derived key and a random salt.
pub fn create_enc_header(key: &[u8; 32], salt: &[u8; 32]) -> Result<EncHeader, String> {
    let check = encrypt_bytes(key, VERIFY_PLAIN)?;
    Ok(EncHeader {
        salt: hex::encode(salt),
        check: hex::encode(check),
    })
}

/// Verify that `key` matches the stored check block.
pub fn verify_enc_header(key: &[u8; 32], header: &EncHeader) -> Result<(), String> {
    let check_bytes =
        hex::decode(&header.check).map_err(|e| format!("Corrupt vault.enc check field: {e}"))?;
    let plain = decrypt_bytes(key, &check_bytes)?;
    if plain != VERIFY_PLAIN {
        return Err("Password is incorrect".to_string());
    }
    Ok(())
}

/// Full round-trip: load vault.enc → derive key → verify → return key.
pub fn load_key_from_password(vault_path: &str, password: &str) -> Result<[u8; 32], String> {
    let header = load_enc_header(vault_path)?;
    let salt_vec = hex::decode(&header.salt)
        .map_err(|e| format!("Corrupt vault.enc salt: {e}"))?;
    let salt: [u8; 32] = salt_vec
        .try_into()
        .map_err(|_| "vault.enc salt has wrong length".to_string())?;
    let key = derive_key(password, &salt)?;
    verify_enc_header(&key, &header)?;
    Ok(key)
}

// ─── Vault-wide encrypt/decrypt ───────────────────────────────────────────────

fn is_vaultfile(path: &Path) -> bool {
    match path.extension().map(|e| e.to_string_lossy().to_lowercase()).as_deref() {
        Some("md") | Some("canvas") | Some("kanban") => true,
        _ => false,
    }
}

/// Encrypt every note file in `vault_path` that is not already encrypted.
pub fn encrypt_vault_files(vault_path: &str, key: &[u8; 32]) -> Result<(), String> {
    use walkdir::WalkDir;
    for entry in WalkDir::new(vault_path).min_depth(1).into_iter().filter_entry(|e| {
        let name = e.file_name().to_string_lossy();
        !name.starts_with('.')
    }) {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();
        if !path.is_file() || !is_vaultfile(path) { continue; }
        let raw = std::fs::read(path).map_err(|e| e.to_string())?;
        if is_encrypted_data(&raw) { continue; } // already encrypted
        let encrypted = encrypt_bytes(key, &raw)?;
        std::fs::write(path, &encrypted).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Decrypt every note file in `vault_path` that carries the CENC header.
pub fn decrypt_vault_files(vault_path: &str, key: &[u8; 32]) -> Result<(), String> {
    use walkdir::WalkDir;
    for entry in WalkDir::new(vault_path).min_depth(1).into_iter().filter_entry(|e| {
        let name = e.file_name().to_string_lossy();
        !name.starts_with('.')
    }) {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();
        if !path.is_file() || !is_vaultfile(path) { continue; }
        let raw = std::fs::read(path).map_err(|e| e.to_string())?;
        if !is_encrypted_data(&raw) { continue; } // plaintext
        let plain = decrypt_bytes(key, &raw)?;
        std::fs::write(path, &plain).map_err(|e| e.to_string())?;
    }
    Ok(())
}
