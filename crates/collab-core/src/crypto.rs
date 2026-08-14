//! Shared byte-level AES-256-GCM content encryption.
//!
//! This is the single implementation of the at-rest `CENC` container format used
//! both by the desktop vault encryption (`src-tauri/src/crypto.rs`) and by the
//! native hosted-vault replica store (`collab-replica`). Keeping it here prevents
//! the two consumers from forking the on-disk format.
//!
//! On-disk layout for every encrypted blob:
//!   `[4B magic "CENC"] [12B random nonce] [ciphertext || 16B GCM tag]`
//!
//! Key derivation (Argon2id) and the vault password/header helpers are *not* part
//! of this module; they stay with the desktop vault crypto that owns them.

use aes_gcm::{
    aead::{Aead, KeyInit},
    Aes256Gcm, Key, Nonce,
};
use rand::RngCore;

/// Magic prefix that marks an encrypted blob.
pub const MAGIC: &[u8; 4] = b"CENC";
const NONCE_LEN: usize = 12;
const TAG_LEN: usize = 16;

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

/// Decrypt data produced by [`encrypt_bytes`]. Returns the original plaintext.
/// Fails with a clear error if the MAGIC header is missing or authentication fails.
pub fn decrypt_bytes(key: &[u8; 32], data: &[u8]) -> Result<Vec<u8>, String> {
    if data.len() < 4 + NONCE_LEN + TAG_LEN {
        return Err("File is too short to be a valid encrypted file".to_string());
    }
    if &data[..4] != MAGIC {
        return Err("File does not have the encrypted-file header".to_string());
    }

    let nonce = Nonce::from_slice(&data[4..4 + NONCE_LEN]);
    let ciphertext = &data[4 + NONCE_LEN..];
    let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(key));

    cipher
        .decrypt(nonce, ciphertext)
        .map_err(|_| "Decryption failed — incorrect password or corrupted file".to_string())
}

#[cfg(test)]
mod tests {
    use super::{decrypt_bytes, encrypt_bytes, is_encrypted_data, MAGIC};

    #[test]
    fn roundtrips_and_detects_header() {
        let key = [7u8; 32];
        let encrypted = encrypt_bytes(&key, b"hello replica").expect("encrypt");
        assert!(is_encrypted_data(&encrypted));
        assert_eq!(
            decrypt_bytes(&key, &encrypted).expect("decrypt"),
            b"hello replica"
        );
    }

    #[test]
    fn detects_and_rejects_non_container_data() {
        assert!(is_encrypted_data(MAGIC));
        assert!(!is_encrypted_data(b"not-encrypted"));
        assert!(!is_encrypted_data(b"CEN"));
        assert!(decrypt_bytes(&[0u8; 32], b"too-short").is_err());
    }

    #[test]
    fn wrong_key_fails_authentication() {
        let encrypted = encrypt_bytes(&[1u8; 32], b"secret").expect("encrypt");
        assert!(decrypt_bytes(&[2u8; 32], &encrypted).is_err());
    }
}
