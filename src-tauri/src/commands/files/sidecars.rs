use super::{
    parse_data_url, read_source_file_cache_state, read_vault_bytes, resolve_vault_path,
    system_time_to_ms, write_vault_bytes,
};
use crate::state::AppState;
use base64::Engine as _;
use serde::{Deserialize, Serialize};
use std::path::Path;
use std::time::SystemTime;
use tauri::State;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PdfHighlightRect {
    pub left: f32,
    pub top: f32,
    pub width: f32,
    pub height: f32,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PdfBookmark {
    pub id: String,
    pub page: u32,
    pub label: Option<String>,
    pub created_at: u64,
    pub updated_at: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PdfHighlight {
    pub id: String,
    pub page: u32,
    pub text: String,
    pub rects: Vec<PdfHighlightRect>,
    pub color: Option<String>,
    pub note: Option<String>,
    pub created_at: u64,
    pub updated_at: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PdfTextAnnotation {
    pub id: String,
    pub page: u32,
    pub text: String,
    pub left: f32,
    pub top: f32,
    pub width: f32,
    pub height: f32,
    pub color: Option<String>,
    pub background_color: Option<String>,
    pub text_color: Option<String>,
    pub created_at: u64,
    pub updated_at: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PdfPageComment {
    pub id: String,
    pub page: u32,
    pub content: String,
    pub created_at: u64,
    pub updated_at: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PdfViewerState {
    pub last_page: Option<u32>,
    pub last_zoom_mode: Option<String>,
    pub last_zoom: Option<f32>,
    pub last_layout_mode: Option<String>,
    pub last_rotation: Option<u16>,
    pub last_bookmarks_open: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
#[serde(default)]
pub struct PdfSidecarState {
    pub schema_version: Option<u32>,
    pub bookmarks: Vec<PdfBookmark>,
    pub highlights: Vec<PdfHighlight>,
    pub text_annotations: Vec<PdfTextAnnotation>,
    pub page_comments: Vec<PdfPageComment>,
    /// Versioned `collab-annotations` document. Kept as JSON so the native
    /// adapter round-trips the framework-free ink schema without duplicating it.
    pub ink: Option<serde_json::Value>,
    pub viewer_state: Option<PdfViewerState>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct DocumentPreviewCacheEntry {
    source_modified_at: u64,
    source_size: u64,
    #[serde(default)]
    renderer_version: i32,
    preview_mime: String,
    generated_at: u64,
}

pub(super) fn overlay_relative_path(image_relative_path: &str) -> String {
    let encoded = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(image_relative_path);
    format!(".collab/image-overlays/{encoded}.json")
}

pub(super) fn pdf_sidecar_relative_path(pdf_relative_path: &str) -> String {
    let encoded = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(pdf_relative_path);
    format!(".collab/pdf/{encoded}.json")
}

pub(super) fn document_preview_cache_relative_path(relative_path: &str) -> String {
    let encoded = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(relative_path);
    // Separate from legacy .json/.bin pairs so older clients never decode a record as an image.
    format!(".collab/previews/documents/{encoded}.entry")
}

fn maybe_gc_preview_cache(vault: &str) {
    static LAST: std::sync::LazyLock<
        parking_lot::Mutex<std::collections::HashMap<String, std::time::Instant>>,
    > = std::sync::LazyLock::new(|| parking_lot::Mutex::new(std::collections::HashMap::new()));
    let mut last = LAST.lock();
    if last
        .get(vault)
        .is_some_and(|at| at.elapsed().as_secs() < 60)
    {
        return;
    }
    if last.len() >= 16 {
        last.clear();
    }
    last.insert(vault.into(), std::time::Instant::now());
    drop(last);
    gc_preview_cache(vault);
}
const PREVIEW_DISK_BYTES: u64 = 256 * 1024 * 1024;
const PREVIEW_DISK_AGE: std::time::Duration = std::time::Duration::from_secs(30 * 24 * 3600);
/// Only disposable records under this exact namespace are collected, never annotations/history.
pub(super) fn gc_preview_cache(vault_path: &str) {
    let root = Path::new(vault_path);
    let directory = root.join(".collab/previews/documents");
    let Ok(root_canonical) = root.canonicalize() else {
        return;
    };
    if directory.canonicalize().ok().as_ref()
        != Some(&root_canonical.join(".collab/previews/documents"))
    {
        return;
    }
    let Ok(entries) = std::fs::read_dir(&directory) else {
        return;
    };
    let mut records = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        let Ok(metadata) = std::fs::symlink_metadata(&path) else {
            continue;
        };
        if !metadata.is_file()
            || !matches!(
                path.extension().and_then(|value| value.to_str()),
                Some("entry" | "json" | "bin")
            )
        {
            continue;
        }
        let modified = metadata.modified().unwrap_or(SystemTime::UNIX_EPOCH);
        let source = path
            .file_stem()
            .and_then(|stem| {
                base64::engine::general_purpose::URL_SAFE_NO_PAD
                    .decode(stem.to_string_lossy().as_bytes())
                    .ok()
            })
            .and_then(|bytes| String::from_utf8(bytes).ok())
            .and_then(|relative| resolve_vault_path(vault_path, &relative).ok());
        if source.is_none_or(|source| !source.is_file())
            || modified.elapsed().is_ok_and(|age| age > PREVIEW_DISK_AGE)
        {
            let _ = std::fs::remove_file(path);
            continue;
        }
        records.push((modified, path, metadata.len()));
    }
    let mut bytes = records.iter().map(|record| record.2).sum::<u64>();
    records.sort_by_key(|record| record.0);
    let count = records.len();
    for (index, (_, path, size)) in records.into_iter().enumerate() {
        if bytes <= PREVIEW_DISK_BYTES && count - index <= 4096 {
            break;
        }
        if std::fs::remove_file(path).is_ok() {
            bytes = bytes.saturating_sub(size);
        }
    }
}

const PREVIEW_RECORD_MAGIC: &[u8; 8] = b"CLBPRV01";
const MAX_PREVIEW_METADATA_BYTES: usize = 16 * 1024;

fn preview_record(entry: &DocumentPreviewCacheEntry, payload: &[u8]) -> Result<Vec<u8>, String> {
    let metadata = serde_json::to_vec(entry).map_err(|error| error.to_string())?;
    if metadata.len() > MAX_PREVIEW_METADATA_BYTES {
        return Err("Preview metadata exceeds its size limit".into());
    }
    let mut record = Vec::with_capacity(12 + metadata.len() + payload.len() + 64);
    record.extend_from_slice(PREVIEW_RECORD_MAGIC);
    record.extend_from_slice(&(metadata.len() as u32).to_le_bytes());
    record.extend_from_slice(&metadata);
    record.extend_from_slice(payload);
    let checksum = collab_core::sha256_bytes(&record);
    record.extend_from_slice(checksum.as_bytes());
    Ok(record)
}

fn parse_preview_record(bytes: &[u8]) -> Option<(DocumentPreviewCacheEntry, &[u8])> {
    let checksum_offset = bytes.len().checked_sub(64)?;
    let (bytes, checksum) = bytes.split_at(checksum_offset);
    if collab_core::sha256_bytes(bytes).as_bytes() != checksum {
        return None;
    }
    if bytes.get(..8)? != PREVIEW_RECORD_MAGIC {
        return None;
    }
    let metadata_length = u32::from_le_bytes(bytes.get(8..12)?.try_into().ok()?) as usize;
    if metadata_length > MAX_PREVIEW_METADATA_BYTES {
        return None;
    }
    let payload_offset = 12usize.checked_add(metadata_length)?;
    let entry: DocumentPreviewCacheEntry =
        serde_json::from_slice(bytes.get(12..payload_offset)?).ok()?;
    let payload = bytes.get(payload_offset..)?;
    Some((entry, payload))
}

fn read_preview_record(
    source_path: &Path,
    cache_path: &Path,
    key_opt: Option<[u8; 32]>,
) -> Result<Option<String>, String> {
    if !source_path.exists() {
        return Ok(None);
    }
    if std::fs::metadata(cache_path).is_ok_and(|metadata| metadata.len() > 10 * 1024 * 1024) {
        return Ok(None);
    }
    let source_state = read_source_file_cache_state(source_path)?;
    // A disposable cache must not prevent regeneration after corruption/failed publication.
    let Ok(bytes) = read_vault_bytes(cache_path, key_opt) else {
        return Ok(None);
    };
    let Some((entry, payload)) = parse_preview_record(&bytes) else {
        return Ok(None);
    };
    if entry.renderer_version != collab_documents::preview::RENDERER_VERSION
        || (entry.source_modified_at, entry.source_size) != source_state
        || read_source_file_cache_state(source_path)? != source_state
    {
        return Ok(None);
    }
    Ok(Some(format!(
        "data:{};base64,{}",
        entry.preview_mime,
        base64::engine::general_purpose::STANDARD.encode(payload)
    )))
}

fn write_preview_record(
    source_path: &Path,
    cache_path: &Path,
    data_url: &str,
    expected_hash: Option<&str>,
    key_opt: Option<[u8; 32]>,
) -> Result<(), String> {
    if data_url.len() > 8 * 1024 * 1024 {
        return Err("Preview exceeds its 8 MiB record limit".into());
    }
    let (mime, encoded) = parse_data_url(data_url)?;
    let preview_bytes = base64::engine::general_purpose::STANDARD
        .decode(encoded)
        .map_err(|error| format!("Failed to decode cached preview data: {error}"))?;
    let (source_modified_at, source_size) = read_source_file_cache_state(source_path)?;
    if let Some(expected) = expected_hash {
        if collab_core::sha256_bytes(&read_vault_bytes(source_path, key_opt)?) != expected {
            return Err("Document changed while generating its preview.".into());
        }
    }
    let entry = DocumentPreviewCacheEntry {
        renderer_version: collab_documents::preview::RENDERER_VERSION,
        source_modified_at,
        source_size,
        preview_mime: mime.to_string(),
        generated_at: system_time_to_ms(SystemTime::now()),
    };
    // One staged, encrypted-as-needed atomic rename commits metadata and payload together.
    write_vault_bytes(
        cache_path,
        &preview_record(&entry, &preview_bytes)?,
        key_opt,
    )
}

#[tauri::command]
pub fn read_image_overlay(
    vault_path: String,
    image_relative_path: String,
    state: State<AppState>,
) -> Result<Option<String>, String> {
    let relative_path = overlay_relative_path(&image_relative_path);
    let full_path = resolve_vault_path(&vault_path, &relative_path)?;
    if !full_path.exists() {
        return Ok(None);
    }

    let key_opt: Option<[u8; 32]> = *state.encryption_key.read();
    let bytes = read_vault_bytes(&full_path, key_opt)?;
    let content = String::from_utf8(bytes).map_err(|error| error.to_string())?;
    Ok(Some(content))
}

#[tauri::command]
pub fn write_image_overlay(
    vault_path: String,
    image_relative_path: String,
    content: String,
    state: State<AppState>,
) -> Result<(), String> {
    let _mutation = crate::local_mutation::lock_path(Path::new(&vault_path))?;
    let relative_path = overlay_relative_path(&image_relative_path);
    let full_path = resolve_vault_path(&vault_path, &relative_path)?;
    let key_opt: Option<[u8; 32]> = *state.encryption_key.read();
    write_vault_bytes(&full_path, content.as_bytes(), key_opt)
}

#[tauri::command]
pub fn delete_image_overlay(vault_path: String, image_relative_path: String) -> Result<(), String> {
    let _mutation = crate::local_mutation::lock_path(Path::new(&vault_path))?;
    let relative_path = overlay_relative_path(&image_relative_path);
    let full_path = resolve_vault_path(&vault_path, &relative_path)?;
    if full_path.exists() {
        std::fs::remove_file(full_path).map_err(|error| error.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub fn read_pdf_sidecar_state(
    vault_path: String,
    pdf_relative_path: String,
    state: State<AppState>,
) -> Result<PdfSidecarState, String> {
    let relative_path = pdf_sidecar_relative_path(&pdf_relative_path);
    let full_path = resolve_vault_path(&vault_path, &relative_path)?;
    if !full_path.exists() {
        return Ok(PdfSidecarState::default());
    }

    let key_opt: Option<[u8; 32]> = *state.encryption_key.read();
    let bytes = read_vault_bytes(&full_path, key_opt)?;
    serde_json::from_slice(&bytes).map_err(|error| error.to_string())
}

#[tauri::command]
pub fn write_pdf_sidecar_state(
    vault_path: String,
    pdf_relative_path: String,
    state: PdfSidecarState,
    app_state: State<AppState>,
) -> Result<(), String> {
    let _mutation = crate::local_mutation::lock_path(Path::new(&vault_path))?;
    let relative_path = pdf_sidecar_relative_path(&pdf_relative_path);
    let full_path = resolve_vault_path(&vault_path, &relative_path)?;
    let key_opt: Option<[u8; 32]> = *app_state.encryption_key.read();
    let bytes = serde_json::to_vec_pretty(&state).map_err(|error| error.to_string())?;
    write_vault_bytes(&full_path, &bytes, key_opt)
}

#[tauri::command]
pub async fn read_cached_document_preview_data_url(
    vault_path: String,
    relative_path: String,
    state: State<'_, AppState>,
) -> Result<Option<String>, String> {
    let key_opt = *state.encryption_key.read();
    super::super::vault_jobs::run(move || {
        maybe_gc_preview_cache(&vault_path);
        let source_path = resolve_vault_path(&vault_path, &relative_path)?;
        let cache_path = resolve_vault_path(
            &vault_path,
            &document_preview_cache_relative_path(&relative_path),
        )?;
        read_preview_record(&source_path, &cache_path, key_opt)
    })
    .await
}

#[tauri::command]
pub async fn write_cached_document_preview_data_url(
    vault_path: String,
    relative_path: String,
    data_url: String,
    expected_hash: Option<String>,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let key_opt = *state.encryption_key.read();
    super::super::vault_jobs::run(move || {
        let _mutation = crate::local_mutation::lock_path(Path::new(&vault_path))?;
        let source_path = resolve_vault_path(&vault_path, &relative_path)?;
        let cache_path = resolve_vault_path(
            &vault_path,
            &document_preview_cache_relative_path(&relative_path),
        )?;
        write_preview_record(
            &source_path,
            &cache_path,
            &data_url,
            expected_hash.as_deref(),
            key_opt,
        )?;
        gc_preview_cache(&vault_path);
        Ok(())
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn preview_gc_enforces_bytes_without_touching_source_files() {
        let root = tempfile::tempdir().unwrap();
        let dir = root.path().join(".collab/previews/documents");
        std::fs::create_dir_all(&dir).unwrap();
        for name in ["one.pdf", "two.pdf"] {
            std::fs::write(root.path().join(name), b"source").unwrap();
            let cache = dir.join(format!(
                "{}.entry",
                base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(name)
            ));
            std::fs::File::create(cache)
                .unwrap()
                .set_len(160 * 1024 * 1024)
                .unwrap();
        }
        gc_preview_cache(root.path().to_str().unwrap());
        let bytes = std::fs::read_dir(&dir)
            .unwrap()
            .flatten()
            .map(|entry| entry.metadata().unwrap().len())
            .sum::<u64>();
        assert!(bytes <= PREVIEW_DISK_BYTES);
        assert_eq!(
            std::fs::read(root.path().join("one.pdf")).unwrap(),
            b"source"
        );
    }

    #[test]
    fn preview_gc_only_removes_disposable_orphans_and_enforces_count() {
        let root = tempfile::tempdir().unwrap();
        let dir = root.path().join(".collab/previews/documents");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::create_dir_all(root.path().join(".collab/pdf")).unwrap();
        std::fs::write(root.path().join(".collab/pdf/authoritative.json"), b"keep").unwrap();
        let live = dir.join(format!(
            "{}.entry",
            base64::engine::general_purpose::URL_SAFE_NO_PAD.encode("live.pdf")
        ));
        std::fs::write(root.path().join("live.pdf"), b"pdf").unwrap();
        std::fs::write(&live, b"opaque encrypted preview").unwrap();
        let orphan = dir.join(format!(
            "{}.entry",
            base64::engine::general_purpose::URL_SAFE_NO_PAD.encode("deleted.pdf")
        ));
        std::fs::write(&orphan, b"old").unwrap();
        gc_preview_cache(root.path().to_str().unwrap());
        assert!(live.exists());
        assert!(!orphan.exists());
        assert!(root.path().join(".collab/pdf/authoritative.json").exists());
        std::fs::rename(
            root.path().join("live.pdf"),
            root.path().join("renamed.pdf"),
        )
        .unwrap();
        gc_preview_cache(root.path().to_str().unwrap());
        assert!(!live.exists());
    }
    #[cfg(unix)]
    #[test]
    fn preview_gc_never_follows_a_symlinked_namespace() {
        let root = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(root.path().join(".collab/previews")).unwrap();
        std::os::unix::fs::symlink(
            outside.path(),
            root.path().join(".collab/previews/documents"),
        )
        .unwrap();
        let file = outside.path().join("unsafe.entry");
        std::fs::write(&file, b"keep").unwrap();
        gc_preview_cache(root.path().to_str().unwrap());
        assert!(file.exists());
    }

    #[test]
    fn sidecar_paths_are_deterministic_and_do_not_embed_source_paths() {
        let image = overlay_relative_path("Pictures/example.png");
        let pdf = pdf_sidecar_relative_path("Docs/spec.pdf");
        let cache = document_preview_cache_relative_path("Docs/spec.pdf");

        assert_eq!(image, overlay_relative_path("Pictures/example.png"));
        assert!(image.starts_with(".collab/image-overlays/"));
        assert!(pdf.starts_with(".collab/pdf/"));
        assert!(cache.starts_with(".collab/previews/documents/"));
        assert!(cache.ends_with(".entry"));
        assert!(!image.contains("Pictures"));
        assert!(!pdf.contains("Docs"));
        assert!(!cache.contains("Docs"));
    }

    fn preview_fixture() -> (
        crate::test_support::TempVault,
        std::path::PathBuf,
        std::path::PathBuf,
    ) {
        let vault = crate::test_support::TempVault::new().unwrap();
        vault
            .write_bytes("Docs/spec.pdf", b"source PDF bytes")
            .unwrap();
        let source = vault.resolve("Docs/spec.pdf");
        let cache = vault.resolve(&document_preview_cache_relative_path("Docs/spec.pdf"));
        (vault, source, cache)
    }

    #[test]
    fn concurrent_preview_readers_only_observe_complete_metadata_payload_pairs() {
        let (_vault, source, cache) = preview_fixture();
        let first = "data:image/png;base64,cG5n";
        let second = "data:image/svg+xml;base64,c3Zn";
        write_preview_record(&source, &cache, first, None, None).unwrap();
        std::thread::scope(|scope| {
            for _ in 0..2 {
                scope.spawn(|| {
                    for _ in 0..30 {
                        let result = read_preview_record(&source, &cache, None).unwrap().unwrap();
                        assert!(
                            result == first || result == second,
                            "mixed metadata/payload: {result}"
                        );
                    }
                });
            }
            for _ in 0..2 {
                scope.spawn(|| {
                    for url in [second, first].into_iter().cycle().take(20) {
                        write_preview_record(&source, &cache, url, None, None).unwrap();
                    }
                });
            }
        });
    }

    #[test]
    fn corrupt_truncated_or_legacy_cache_is_a_miss_and_can_be_regenerated() {
        let (vault, source, cache) = preview_fixture();
        let url = "data:image/png;base64,cG5n";
        // Legacy pairs are deliberately ignored rather than served with mixed-version clients.
        let legacy = cache.with_extension("bin");
        vault
            .write_bytes(
                legacy.strip_prefix(vault.path()).unwrap().to_str().unwrap(),
                b"legacy image",
            )
            .unwrap();
        assert_eq!(read_preview_record(&source, &cache, None).unwrap(), None);
        write_preview_record(&source, &cache, url, None, None).unwrap();
        let valid = std::fs::read(&cache).unwrap();
        let mut corrupt = valid.clone();
        corrupt[20] ^= 1;
        for invalid in [corrupt, valid[..20].to_vec(), b"legacy raw image".to_vec()] {
            std::fs::write(&cache, invalid).unwrap();
            assert_eq!(read_preview_record(&source, &cache, None).unwrap(), None);
            write_preview_record(&source, &cache, url, None, None).unwrap();
            assert_eq!(
                read_preview_record(&source, &cache, None)
                    .unwrap()
                    .as_deref(),
                Some(url)
            );
        }
    }

    #[test]
    fn preview_records_preserve_encrypted_storage_and_reject_wrong_keys() {
        let (_vault, source, cache) = preview_fixture();
        let url = "data:image/png;base64,cG5n";
        write_preview_record(&source, &cache, url, None, Some([7; 32])).unwrap();
        assert!(crate::crypto::is_encrypted_data(
            &std::fs::read(&cache).unwrap()
        ));
        assert_eq!(
            read_preview_record(&source, &cache, Some([7; 32]))
                .unwrap()
                .as_deref(),
            Some(url)
        );
        assert_eq!(
            read_preview_record(&source, &cache, Some([8; 32])).unwrap(),
            None
        );
        assert_eq!(read_preview_record(&source, &cache, None).unwrap(), None);
    }

    #[test]
    fn stale_preview_writes_do_not_replace_the_previous_record() {
        let (vault, source, cache) = preview_fixture();
        let url = "data:image/png;base64,cG5n";
        write_preview_record(&source, &cache, url, None, None).unwrap();
        let before = std::fs::read(&cache).unwrap();
        assert!(write_preview_record(
            &source,
            &cache,
            "data:image/png;base64,bmV3",
            Some("stale"),
            None
        )
        .is_err());
        assert_eq!(std::fs::read(&cache).unwrap(), before);
        vault
            .write_bytes("Docs/spec.pdf", b"changed source with different size")
            .unwrap();
        assert_eq!(read_preview_record(&source, &cache, None).unwrap(), None);
    }

    #[test]
    fn staged_preview_is_invisible_until_the_single_publish_and_old_renderer_is_a_miss() {
        let (_vault, source, cache) = preview_fixture();
        let url = "data:image/png;base64,cG5n";
        write_preview_record(&source, &cache, url, None, None).unwrap();
        let bytes = std::fs::read(&cache).unwrap();
        let (mut entry, _) = parse_preview_record(&bytes).unwrap();
        entry.preview_mime = "image/webp".into();
        let replacement = preview_record(&entry, b"new").unwrap();
        let mut staged = tempfile::NamedTempFile::new_in(cache.parent().unwrap()).unwrap();
        std::io::Write::write_all(&mut staged, &replacement).unwrap();
        assert_eq!(
            read_preview_record(&source, &cache, None)
                .unwrap()
                .as_deref(),
            Some(url)
        );
        staged.persist(&cache).unwrap();
        assert_eq!(
            read_preview_record(&source, &cache, None)
                .unwrap()
                .as_deref(),
            Some("data:image/webp;base64,bmV3")
        );
        entry.renderer_version -= 1;
        write_vault_bytes(&cache, &preview_record(&entry, b"new").unwrap(), None).unwrap();
        assert_eq!(read_preview_record(&source, &cache, None).unwrap(), None);
    }

    #[test]
    fn pdf_sidecar_defaults_survive_missing_fields() {
        let state: PdfSidecarState =
            serde_json::from_str(r#"{"bookmarks":[]}"#).expect("state should deserialize");
        assert!(state.highlights.is_empty());
        assert!(state.text_annotations.is_empty());
        assert!(state.page_comments.is_empty());
        assert_eq!(state.schema_version, None);
        assert_eq!(state.ink, None);
        assert_eq!(state.viewer_state, None);
    }

    #[test]
    fn pdf_sidecar_round_trips_anchored_ink() {
        let raw = r#"{
          "schemaVersion": 2,
          "bookmarks": [],
          "ink": {
            "kind": "collab-annotations",
            "schemaVersion": 1,
            "source": { "relativePath": "Docs/spec.pdf" },
            "surfaces": {},
            "surfaceOrder": []
          }
        }"#;
        let state: PdfSidecarState = serde_json::from_str(raw).unwrap();
        let encoded = serde_json::to_value(state).unwrap();
        assert_eq!(encoded["schemaVersion"], 2);
        assert_eq!(encoded["ink"]["kind"], "collab-annotations");
    }
}

#[tauri::command]
pub async fn generate_document_preview(
    relative_path: String,
    content: String,
    request_id: Option<String>,
) -> Result<String, String> {
    let job = super::super::media_jobs::MediaJob::start(
        request_id.unwrap_or_else(|| uuid::Uuid::new_v4().to_string()),
    )?;
    if content.len() > 8 * 1024 * 1024 {
        return Err("Document exceeds preview input budget".into());
    }
    super::super::vault_jobs::run(move || {
        job.check()?;
        let svg = collab_documents::preview::render(&relative_path, content.as_bytes())?;
        job.check()?;
        Ok(format!(
            "data:image/svg+xml;base64,{}",
            base64::engine::general_purpose::STANDARD.encode(svg)
        ))
    })
    .await
}
