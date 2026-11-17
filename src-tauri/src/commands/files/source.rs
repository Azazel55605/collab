use super::{compute_hash, resolve_vault_path, write_note_to_path};
use crate::{crypto, state::AppState};
use collab_documents::source_text::{
    classify_source_path, decode_source_text, editable, LineEndings, MAX_EDIT_BYTES,
};
use serde::Serialize;
use std::{
    fs::File,
    io::{Read, Seek, Write},
    path::{Path, PathBuf},
};
use tauri::State;

// CENC stores a four-byte header, a nonce, and an authentication tag.
const MAX_STORED_BYTES: u64 = MAX_EDIT_BYTES as u64 + 32;
pub(super) const LIMIT_MESSAGE: &str =
    "This file exceeds the source editor's 1 MiB, 50,000 line, or 16 KiB line limit.";

pub(super) fn read_edit_bytes(path: &Path) -> Result<Vec<u8>, std::io::Error> {
    let mut bytes = Vec::new();
    File::open(path)?
        .take(MAX_STORED_BYTES + 1)
        .read_to_end(&mut bytes)?;
    Ok(bytes)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenSourceFile {
    content: Option<String>,
    version: Option<String>,
    preview: Option<String>,
    reason: Option<String>,
}

impl OpenSourceFile {
    fn read_only(bytes: &[u8], reason: impl Into<String>) -> Self {
        let bytes = &bytes[..bytes.len().min(64 * 1024)];
        // A bounded excerpt can end inside a UTF-8 scalar.
        let prefix = match std::str::from_utf8(bytes) {
            Ok(text) => Some(text),
            Err(error) if error.error_len().is_none() => {
                std::str::from_utf8(&bytes[..error.valid_up_to()]).ok()
            }
            Err(_) => None,
        };
        let preview = prefix
            .filter(|text| decode_source_text(text.as_bytes()).is_ok())
            .map(|text| {
                let end = text
                    .match_indices('\n')
                    .nth(199)
                    .map_or(text.len(), |(i, _)| i);
                text[..end].to_owned()
            });
        Self {
            content: None,
            version: None,
            preview,
            reason: Some(reason.into()),
        }
    }
}

pub(super) fn open_source(path: &Path, key: Option<[u8; 32]>) -> Result<OpenSourceFile, String> {
    let stored = read_edit_bytes(path).map_err(|error| error.to_string())?;
    let plain = if crypto::is_encrypted_data(&stored) {
        let key = key.ok_or("Vault is locked — enter the password to unlock it")?;
        if stored.len() as u64 > MAX_STORED_BYTES {
            return Ok(OpenSourceFile::read_only(&[], LIMIT_MESSAGE));
        }
        crypto::decrypt_bytes(&key, &stored)?
    } else {
        stored
    };
    if path
        .metadata()
        .map_err(|error| error.to_string())?
        .permissions()
        .readonly()
    {
        return Ok(OpenSourceFile::read_only(
            &plain,
            "This file is read-only on disk.",
        ));
    }
    if plain.len() > MAX_EDIT_BYTES {
        return Ok(OpenSourceFile::read_only(&plain, LIMIT_MESSAGE));
    }
    match decode_source_text(&plain) {
        Ok(decoded) if decoded.format.line_endings == LineEndings::Unsupported => Ok(
            OpenSourceFile::read_only(&plain, "This file uses mixed or unsupported line endings."),
        ),
        Ok(decoded) if !editable(plain.len(), decoded.content) => {
            Ok(OpenSourceFile::read_only(&plain, LIMIT_MESSAGE))
        }
        Ok(_) => {
            let content = String::from_utf8(plain).map_err(|error| error.to_string())?;
            Ok(OpenSourceFile {
                version: Some(compute_hash(&content)),
                content: Some(content),
                reason: None,
                preview: None,
            })
        }
        Err(error) => Ok(OpenSourceFile::read_only(&[], error.to_string())),
    }
}

fn source_path(vault_path: &str, relative_path: &str) -> Result<PathBuf, String> {
    if classify_source_path(relative_path).is_none() {
        return Err("This file is not a supported source document.".into());
    }
    let root = Path::new(vault_path)
        .canonicalize()
        .map_err(|error| error.to_string())?;
    let path = resolve_vault_path(vault_path, relative_path)?
        .canonicalize()
        .map_err(|error| error.to_string())?;
    let supported = path.strip_prefix(root).ok().is_some_and(|relative| {
        classify_source_path(&relative.to_string_lossy().replace('\\', "/")).is_some()
    });
    if !supported || !path.is_file() {
        return Err("Source file must be a regular file inside the vault.".into());
    }
    Ok(path)
}

#[tauri::command]
pub fn read_source_file(
    vault_path: String,
    relative_path: String,
    state: State<AppState>,
) -> Result<OpenSourceFile, String> {
    let path = source_path(&vault_path, &relative_path)?;
    open_source(&path, *state.encryption_key.read())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceSave {
    version: String,
    conflict: Option<SourceConflict>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SourceConflict {
    content: String,
    version: String,
}

#[tauri::command]
pub fn write_source_file(
    vault_path: String,
    relative_path: String,
    content: String,
    expected_hash: String,
    state: State<AppState>,
) -> Result<SourceSave, String> {
    let _mutation = crate::local_mutation::lock_path(Path::new(&vault_path))?;
    let path = source_path(&vault_path, &relative_path)?;
    let key = *state.encryption_key.read();
    let current = open_source(&path, key)?;
    if let Some(reason) = current.reason {
        return Err(reason);
    }
    let result = write_note_to_path(
        &path,
        &relative_path,
        content,
        Some(expected_hash),
        None,
        key,
    )?;
    Ok(SourceSave {
        version: result.hash,
        conflict: result.conflict.map(|conflict| SourceConflict {
            version: compute_hash(&conflict.their_content),
            content: conflict.their_content,
        }),
    })
}

pub(super) fn validate_write(text: &str) -> Result<(), String> {
    let source = decode_source_text(text.as_bytes()).map_err(|error| error.to_string())?;
    if source.format.line_endings == LineEndings::Unsupported {
        return Err("Cannot save mixed or unsupported line endings.".into());
    }
    if !editable(text.len(), source.content) {
        return Err(LIMIT_MESSAGE.into());
    }
    Ok(())
}

#[tauri::command]
pub async fn save_source_copy(
    vault_path: String,
    relative_path: String,
    destination_path: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let key = *state.encryption_key.read();
    tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
        let source = source_path(&vault_path, &relative_path)?;
        let destination = Path::new(&destination_path);
        if !destination.is_absolute() || destination.canonicalize().ok().as_ref() == Some(&source) {
            return Err("Choose a different destination for the source copy.".into());
        }
        let _mutation = crate::local_mutation::lock_paths(&[&source, destination])?;
        let mut file = File::open(&source).map_err(|error| error.to_string())?;
        let mut header = [0; 4];
        let encrypted = file.read_exact(&mut header).is_ok() && crypto::is_encrypted_data(&header);
        file.rewind().map_err(|error| error.to_string())?;
        let mut output = tempfile::NamedTempFile::new_in(
            destination
                .parent()
                .ok_or("The destination has no parent directory.")?,
        )
        .map_err(|error| error.to_string())?;
        if encrypted {
            const MAX_ENCRYPTED_COPY_BYTES: u64 = 256 * 1024 * 1024 + 32;
            let key = key.ok_or("Vault is locked — enter the password to unlock it")?;
            let mut ciphertext = Vec::new();
            file.take(MAX_ENCRYPTED_COPY_BYTES + 1)
                .read_to_end(&mut ciphertext)
                .map_err(|error| error.to_string())?;
            if ciphertext.len() as u64 > MAX_ENCRYPTED_COPY_BYTES {
                return Err("Encrypted source copies are limited to 256 MiB.".into());
            }
            output
                .write_all(&crypto::decrypt_bytes(&key, &ciphertext)?)
                .map_err(|error| error.to_string())?;
        } else {
            std::io::copy(&mut file, &mut output).map_err(|error| error.to_string())?;
        }
        output
            .as_file()
            .sync_all()
            .map_err(|error| error.to_string())?;
        output
            .persist(destination)
            .map_err(|error| error.to_string())?;
        Ok(())
    })
    .await
    .map_err(|error| error.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn opens_precise_plain_and_encrypted_source_and_bounds_fallbacks() {
        let file = tempfile::NamedTempFile::new().unwrap();
        let body = "\u{feff}λ\r\nlast";
        fs::write(file.path(), body).unwrap();
        let plain = open_source(file.path(), None).unwrap();
        assert_eq!(plain.content.as_deref(), Some(body));
        let key = [7; 32];
        fs::write(
            file.path(),
            crypto::encrypt_bytes(&key, body.as_bytes()).unwrap(),
        )
        .unwrap();
        assert!(open_source(file.path(), None).is_err());
        let encrypted = open_source(file.path(), Some(key)).unwrap();
        assert_eq!(encrypted.content, plain.content);
        assert_eq!(encrypted.version, plain.version);

        fs::write(file.path(), "abcd\n".repeat(MAX_EDIT_BYTES / 4)).unwrap();
        let fallback = open_source(file.path(), None).unwrap();
        assert!(fallback.content.is_none());
        assert!(fallback.preview.unwrap().lines().count() <= 200);

        fs::write(file.path(), b"before\r\nafter\n").unwrap();
        assert!(open_source(file.path(), None).unwrap().reason.is_some());
    }

    #[test]
    fn source_saves_preserve_raw_bytes_and_conflict_after_an_external_write() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("app.json");
        for key in [None, Some([7; 32])] {
            let raw = "\u{feff}{\r\n}";
            let bytes = key
                .map(|key| crypto::encrypt_bytes(&key, raw.as_bytes()).unwrap())
                .unwrap_or_else(|| raw.as_bytes().to_vec());
            fs::write(&path, bytes).unwrap();
            let before = open_source(&path, key).unwrap();
            let draft = "\u{feff}{\r\n  \"unfinished\": ";
            let result = write_note_to_path(
                &path,
                "app.json",
                draft.into(),
                before.version.clone(),
                None,
                key,
            )
            .unwrap();
            assert!(result.conflict.is_none());
            assert_eq!(
                open_source(&path, key).unwrap().content.as_deref(),
                Some(draft)
            );
            let conflict = write_note_to_path(
                &path,
                "app.json",
                "stale draft".into(),
                before.version,
                Some(raw.into()),
                key,
            )
            .unwrap()
            .conflict
            .unwrap();
            assert_eq!(conflict.their_content, draft);
            assert_eq!(
                open_source(&path, key).unwrap().content.as_deref(),
                Some(draft)
            );
        }
    }
}
