use super::{files, media_jobs::MediaJob, replica};
use crate::{
    crypto,
    hosted_client::{
        decode_hosted_error, server_client, server_request_error, validate_identifier,
    },
    hosted_session::fresh_session_for,
    state::AppState,
};
use serde::Deserialize;
use std::{
    io::{Cursor, Read},
    sync::LazyLock,
};
use tauri::{ipc::Response, State};
const MAX_ASSET_BYTES: usize = 256 * 1024 * 1024;
static ASSET_SLOTS: LazyLock<tokio::sync::Semaphore> =
    LazyLock::new(|| tokio::sync::Semaphore::new(2));
static THUMBNAIL_SLOTS: LazyLock<tokio::sync::Semaphore> =
    LazyLock::new(|| tokio::sync::Semaphore::new(1));
#[derive(Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum AssetSource {
    Local {
        vault_path: String,
        relative_path: String,
    },
    Hosted {
        server_url: String,
        vault_id: String,
        file_id: String,
        cached: bool,
        expected_hash: Option<String>,
        cache_download: bool,
    },
}
fn read_file(path: &std::path::Path, job: &MediaJob) -> Result<Vec<u8>, String> {
    let mut file = std::fs::File::open(path).map_err(|e| e.to_string())?;
    if file.metadata().map_err(|e| e.to_string())?.len() > MAX_ASSET_BYTES as u64 {
        return Err("Asset exceeds the 256 MiB limit".into());
    }
    let mut bytes = Vec::new();
    let mut chunk = [0u8; 65536];
    loop {
        job.check()?;
        let count = file.read(&mut chunk).map_err(|e| e.to_string())?;
        if count == 0 {
            break;
        }
        if bytes.len() + count > MAX_ASSET_BYTES {
            return Err("Asset exceeds the 256 MiB limit".into());
        }
        bytes.extend_from_slice(&chunk[..count]);
    }
    Ok(bytes)
}
pub(crate) fn thumbnail(bytes: Vec<u8>, job: &MediaJob) -> Result<Vec<u8>, String> {
    thumbnail_sized(bytes, job, 640)
}
fn thumbnail_sized(bytes: Vec<u8>, job: &MediaJob, maximum: u32) -> Result<Vec<u8>, String> {
    let width_limit = maximum.clamp(128, 2048);
    let height_limit = width_limit * 3 / 4;
    job.check()?;
    // SVG remains a bounded vector image; it is never decoded as a huge raster.
    if bytes.len() <= 2 * 1024 * 1024
        && std::str::from_utf8(&bytes).is_ok_and(|s| {
            s.trim_start().starts_with("<svg")
                || (s.trim_start().starts_with("<?xml") && s.contains("<svg"))
        })
    {
        return Ok(bytes);
    }
    let mut reader = image::ImageReader::new(Cursor::new(bytes))
        .with_guessed_format()
        .map_err(|e| e.to_string())?;
    let mut limits = image::Limits::default();
    limits.max_image_width = Some(16384);
    limits.max_image_height = Some(16384);
    limits.max_alloc = Some(192 * 1024 * 1024);
    reader.limits(limits);
    let mut decoder = reader
        .into_decoder()
        .map_err(|e| format!("Thumbnail decoder: {e}"))?;
    use image::ImageDecoder;
    let (width, height) = decoder.dimensions();
    if u64::from(width) * u64::from(height) > 48_000_000 {
        return Err("Image exceeds the 48 megapixel preview limit".into());
    }
    job.check()?;
    let orientation = decoder
        .orientation()
        .unwrap_or(image::metadata::Orientation::NoTransforms);
    let image = image::DynamicImage::from_decoder(decoder).map_err(|e| e.to_string())?;
    job.check()?;
    let transpose = matches!(
        orientation,
        image::metadata::Orientation::Rotate90
            | image::metadata::Orientation::Rotate270
            | image::metadata::Orientation::Rotate90FlipH
            | image::metadata::Orientation::Rotate270FlipH
    );
    let mut small = if transpose {
        image.thumbnail(height_limit, width_limit)
    } else {
        image.thumbnail(width_limit, height_limit)
    };
    small.apply_orientation(orientation);
    let mut result = Cursor::new(Vec::new());
    small
        .write_to(&mut result, image::ImageFormat::Png)
        .map_err(|e| e.to_string())?;
    job.check()?;
    Ok(result.into_inner())
}
#[tauri::command]
pub async fn read_vault_asset_bytes(
    state: State<'_, AppState>,
    source: AssetSource,
    thumbnail_only: bool,
    thumbnail_max_dimension: Option<u32>,
    request_id: String,
) -> Result<Response, String> {
    let job = MediaJob::start(request_id)?;
    let _thumbnail_slot = if thumbnail_only {
        Some(
            job.wait(THUMBNAIL_SLOTS.acquire())
                .await?
                .map_err(|e| e.to_string())?,
        )
    } else {
        None
    };
    let _slot = job
        .wait(ASSET_SLOTS.acquire())
        .await?
        .map_err(|e| e.to_string())?;
    let security_key = *state.encryption_key.read();
    let local_scope = match &source {
        AssetSource::Local { vault_path, .. } => Some(vault_path.clone()),
        _ => None,
    };
    let bytes = match source {
        AssetSource::Local {
            vault_path,
            relative_path,
        } => {
            let active = state.active_vault.clone();
            let key = security_key;
            let worker = job.clone();
            tauri::async_runtime::spawn_blocking(move || {
                if !active
                    .read()
                    .as_ref()
                    .is_some_and(|vault| vault.path == vault_path)
                {
                    return Err("Vault is no longer active".into());
                }
                let path = files::resolve_vault_path(&vault_path, &relative_path)?;
                let canonical = path.canonicalize().map_err(|e| e.to_string())?;
                let root = std::path::Path::new(&vault_path)
                    .canonicalize()
                    .map_err(|e| e.to_string())?;
                if !canonical.starts_with(root) {
                    return Err("Asset is outside the vault".into());
                }
                let raw = read_file(&canonical, &worker)?;
                let bytes = if crypto::is_encrypted_data(&raw) {
                    crypto::decrypt_bytes(&key.ok_or("Vault is locked")?, &raw)?
                } else {
                    raw
                };
                worker.check()?;
                if !active
                    .read()
                    .as_ref()
                    .is_some_and(|vault| vault.path == vault_path)
                {
                    return Err("Vault changed while reading asset".into());
                }
                Ok::<_, String>(bytes)
            })
            .await
            .map_err(|e| e.to_string())??
        }
        AssetSource::Hosted {
            server_url,
            vault_id,
            file_id,
            cached,
            expected_hash,
            cache_download,
        } => {
            validate_identifier(&vault_id)?;
            validate_identifier(&file_id)?;
            if cached {
                let worker = job.clone();
                tauri::async_runtime::spawn_blocking(move || {
                    worker.check()?;
                    let store = replica::existing_read(&server_url, &vault_id)?
                        .ok_or("Asset is not available offline")?;
                    let bytes = store
                        .read_cached_asset_bounded(&file_id, MAX_ASSET_BYTES)?
                        .ok_or("Asset is not available offline")?;
                    if bytes.len() > MAX_ASSET_BYTES {
                        return Err("Asset exceeds the 256 MiB limit".into());
                    }
                    if let Some(expected) = expected_hash {
                        if collab_core::sha256_bytes(&bytes) != expected {
                            return Err("Cached asset revision changed".into());
                        }
                    }
                    worker.check()?;
                    Ok::<_, String>(bytes)
                })
                .await
                .map_err(|e| e.to_string())??
            } else {
                let session = fresh_session_for(
                    state.hosted_sessions(),
                    &server_url,
                    "Connect to the server before reading assets",
                )
                .await?;
                let mut response = job
                    .wait(
                        server_client(session.allow_invalid_certificates)?
                            .get(format!(
                                "{}/api/v1/vaults/{vault_id}/files/{file_id}/content",
                                session.server_url
                            ))
                            .bearer_auth(&session.access_token)
                            .timeout(std::time::Duration::from_secs(60))
                            .send(),
                    )
                    .await?
                    .map_err(server_request_error)?;
                if !response.status().is_success() {
                    return Err(decode_hosted_error(response).await);
                }
                if response
                    .content_length()
                    .is_some_and(|length| length > MAX_ASSET_BYTES as u64)
                {
                    return Err("Asset exceeds the 256 MiB limit".into());
                }
                let mut bytes = Vec::new();
                while let Some(chunk) = job
                    .wait(response.chunk())
                    .await?
                    .map_err(server_request_error)?
                {
                    if bytes.len() + chunk.len() > MAX_ASSET_BYTES {
                        return Err("Asset exceeds the 256 MiB limit".into());
                    }
                    bytes.extend_from_slice(&chunk);
                }
                job.check()?;
                let bytes = if cache_download {
                    let worker = job.clone();
                    tauri::async_runtime::spawn_blocking(move || {
                        worker.check()?;
                        if let Ok(store) = replica::existing(&server_url, &vault_id) {
                            if store
                                .read_sync_state()
                                .ok()
                                .is_some_and(|state| state.offline_available_at.is_some())
                            {
                                let _ = store.cache_asset(&file_id, &bytes);
                            }
                        }
                        worker.check()?;
                        Ok::<_, String>(bytes)
                    })
                    .await
                    .map_err(|e| e.to_string())??
                } else {
                    bytes
                };
                bytes
            }
        }
    };
    job.check()?;
    let bytes = if thumbnail_only {
        let worker = job.clone();
        tauri::async_runtime::spawn_blocking(move || {
            if let Some(maximum) = thumbnail_max_dimension {
                thumbnail_sized(bytes, &worker, maximum)
            } else {
                thumbnail(bytes, &worker)
            }
        })
        .await
        .map_err(|e| e.to_string())??
    } else {
        bytes
    };
    job.check()?;
    if let Some(path) = local_scope {
        if *state.encryption_key.read() != security_key
            || !state
                .active_vault
                .read()
                .as_ref()
                .is_some_and(|vault| vault.path == path)
        {
            return Err("Vault was closed or locked during asset work".into());
        }
    }
    Ok(Response::new(bytes))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn thumbnail_is_bounded_and_cancellation_prevents_decode() {
        let image = image::DynamicImage::new_rgba8(1600, 1200);
        let mut source = Cursor::new(Vec::new());
        image
            .write_to(&mut source, image::ImageFormat::Png)
            .unwrap();
        let id = uuid::Uuid::new_v4().to_string();
        let job = MediaJob::start(id.clone()).unwrap();
        let output = thumbnail(source.into_inner(), &job).unwrap();
        let decoded = image::load_from_memory(&output).unwrap();
        assert_eq!((decoded.width(), decoded.height()), (640, 480));
        assert!(output.len() < 100_000);
        super::super::media_jobs::cancel_media_job(id);
        assert!(thumbnail(output, &job).unwrap_err().contains("cancelled"));
    }
    #[test]
    fn rejects_unsupported_and_empty_images_without_fallback_to_original() {
        let job = MediaJob::start(uuid::Uuid::new_v4().to_string()).unwrap();
        assert!(thumbnail(Vec::new(), &job).is_err());
    }
}

/// Raw desktop IPC avoids base64/JSON output copies; publication stays atomic.
#[tauri::command]
pub async fn write_downloaded_bytes(request: tauri::ipc::Request<'_>) -> Result<(), String> {
    use base64::Engine;
    static WRITES: LazyLock<tokio::sync::Semaphore> =
        LazyLock::new(|| tokio::sync::Semaphore::new(2));
    let permit = WRITES
        .try_acquire()
        .map_err(|_| "Two native exports are already writing")?;
    let encoded = request
        .headers()
        .get("x-collab-destination")
        .and_then(|value| value.to_str().ok())
        .ok_or("Missing export destination")?;
    if encoded.len() > 32768 {
        return Err("Export destination is too long".into());
    }
    let path = String::from_utf8(
        base64::engine::general_purpose::STANDARD
            .decode(encoded)
            .map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;
    if !std::path::Path::new(&path).is_absolute() {
        return Err("Export destination must be absolute".into());
    }
    let bytes = match request.body() {
        tauri::ipc::InvokeBody::Raw(bytes) if bytes.len() <= MAX_ASSET_BYTES => bytes.clone(),
        _ => return Err("Export requires raw bytes within its 256 MiB limit".into()),
    };
    tauri::async_runtime::spawn_blocking(move || {
        let _permit = permit;
        write_export_atomic(std::path::Path::new(&path), &bytes)
    })
    .await
    .map_err(|e| e.to_string())?
}

fn write_export_atomic(destination: &std::path::Path, bytes: &[u8]) -> Result<(), String> {
    use std::io::Write;
    let _mutation = crate::local_mutation::lock_path(destination)?;
    let parent = destination.parent().ok_or("Missing export folder")?;
    std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    let mut staged = tempfile::NamedTempFile::new_in(parent).map_err(|e| e.to_string())?;
    staged.write_all(bytes).map_err(|e| e.to_string())?;
    staged.as_file().sync_all().map_err(|e| e.to_string())?;
    staged.persist(destination).map_err(|e| e.to_string())?;
    Ok(())
}
#[cfg(test)]
mod export_tests {
    #[test]
    fn binary_export_atomically_replaces_the_chosen_file_and_cleans_staging() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("export.bin");
        std::fs::write(&path, b"before").unwrap();
        super::write_export_atomic(&path, &[0, 255, 1, 2]).unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), vec![0, 255, 1, 2]);
        assert_eq!(std::fs::read_dir(directory.path()).unwrap().count(), 1);
    }
}
