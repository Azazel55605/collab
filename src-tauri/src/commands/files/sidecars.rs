use super::{
    parse_data_url, read_source_file_cache_state, read_vault_bytes, resolve_vault_path,
    system_time_to_ms, write_vault_bytes,
};
use crate::state::AppState;
use base64::Engine as _;
use serde::{Deserialize, Serialize};
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
    pub bookmarks: Vec<PdfBookmark>,
    pub highlights: Vec<PdfHighlight>,
    pub text_annotations: Vec<PdfTextAnnotation>,
    pub page_comments: Vec<PdfPageComment>,
    pub viewer_state: Option<PdfViewerState>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct DocumentPreviewCacheEntry {
    source_modified_at: u64,
    source_size: u64,
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

pub(super) fn document_preview_cache_metadata_relative_path(relative_path: &str) -> String {
    let encoded = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(relative_path);
    format!(".collab/previews/documents/{encoded}.json")
}

pub(super) fn document_preview_cache_payload_relative_path(relative_path: &str) -> String {
    let encoded = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(relative_path);
    format!(".collab/previews/documents/{encoded}.bin")
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
    let relative_path = overlay_relative_path(&image_relative_path);
    let full_path = resolve_vault_path(&vault_path, &relative_path)?;
    let key_opt: Option<[u8; 32]> = *state.encryption_key.read();
    write_vault_bytes(&full_path, content.as_bytes(), key_opt)
}

#[tauri::command]
pub fn delete_image_overlay(vault_path: String, image_relative_path: String) -> Result<(), String> {
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
    let relative_path = pdf_sidecar_relative_path(&pdf_relative_path);
    let full_path = resolve_vault_path(&vault_path, &relative_path)?;
    let key_opt: Option<[u8; 32]> = *app_state.encryption_key.read();
    let bytes = serde_json::to_vec_pretty(&state).map_err(|error| error.to_string())?;
    write_vault_bytes(&full_path, &bytes, key_opt)
}

#[tauri::command]
pub fn read_cached_document_preview_data_url(
    vault_path: String,
    relative_path: String,
    state: State<AppState>,
) -> Result<Option<String>, String> {
    let source_path = resolve_vault_path(&vault_path, &relative_path)?;
    if !source_path.exists() {
        return Ok(None);
    }

    let metadata_path = resolve_vault_path(
        &vault_path,
        &document_preview_cache_metadata_relative_path(&relative_path),
    )?;
    let payload_path = resolve_vault_path(
        &vault_path,
        &document_preview_cache_payload_relative_path(&relative_path),
    )?;
    if !metadata_path.exists() || !payload_path.exists() {
        return Ok(None);
    }

    let (source_modified_at, source_size) = read_source_file_cache_state(&source_path)?;
    let key_opt: Option<[u8; 32]> = *state.encryption_key.read();
    let metadata_bytes = read_vault_bytes(&metadata_path, key_opt)?;
    let cache_entry: DocumentPreviewCacheEntry =
        serde_json::from_slice(&metadata_bytes).map_err(|error| error.to_string())?;

    if cache_entry.source_modified_at != source_modified_at
        || cache_entry.source_size != source_size
    {
        return Ok(None);
    }

    let preview_bytes = read_vault_bytes(&payload_path, key_opt)?;
    let encoded = base64::engine::general_purpose::STANDARD.encode(preview_bytes);
    Ok(Some(format!(
        "data:{};base64,{}",
        cache_entry.preview_mime, encoded
    )))
}

#[tauri::command]
pub fn write_cached_document_preview_data_url(
    vault_path: String,
    relative_path: String,
    data_url: String,
    state: State<AppState>,
) -> Result<(), String> {
    let source_path = resolve_vault_path(&vault_path, &relative_path)?;
    if !source_path.exists() {
        return Err(format!("Source file '{relative_path}' does not exist"));
    }

    let (mime, encoded) = parse_data_url(&data_url)?;
    let preview_bytes = base64::engine::general_purpose::STANDARD
        .decode(encoded)
        .map_err(|error| format!("Failed to decode cached preview data: {error}"))?;
    let (source_modified_at, source_size) = read_source_file_cache_state(&source_path)?;
    let cache_entry = DocumentPreviewCacheEntry {
        source_modified_at,
        source_size,
        preview_mime: mime.to_string(),
        generated_at: system_time_to_ms(SystemTime::now()),
    };

    let metadata_path = resolve_vault_path(
        &vault_path,
        &document_preview_cache_metadata_relative_path(&relative_path),
    )?;
    let payload_path = resolve_vault_path(
        &vault_path,
        &document_preview_cache_payload_relative_path(&relative_path),
    )?;
    let key_opt: Option<[u8; 32]> = *state.encryption_key.read();
    let metadata_bytes =
        serde_json::to_vec_pretty(&cache_entry).map_err(|error| error.to_string())?;

    write_vault_bytes(&payload_path, &preview_bytes, key_opt)?;
    write_vault_bytes(&metadata_path, &metadata_bytes, key_opt)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sidecar_paths_are_deterministic_and_do_not_embed_source_paths() {
        let image = overlay_relative_path("Pictures/example.png");
        let pdf = pdf_sidecar_relative_path("Docs/spec.pdf");
        let metadata = document_preview_cache_metadata_relative_path("Docs/spec.pdf");
        let payload = document_preview_cache_payload_relative_path("Docs/spec.pdf");

        assert_eq!(image, overlay_relative_path("Pictures/example.png"));
        assert!(image.starts_with(".collab/image-overlays/"));
        assert!(pdf.starts_with(".collab/pdf/"));
        assert!(metadata.starts_with(".collab/previews/documents/"));
        assert!(payload.starts_with(".collab/previews/documents/"));
        assert!(!image.contains("Pictures"));
        assert!(!pdf.contains("Docs"));
        assert_ne!(metadata, payload);
    }

    #[test]
    fn pdf_sidecar_defaults_survive_missing_fields() {
        let state: PdfSidecarState =
            serde_json::from_str(r#"{"bookmarks":[]}"#).expect("state should deserialize");
        assert!(state.highlights.is_empty());
        assert!(state.text_annotations.is_empty());
        assert!(state.page_comments.is_empty());
        assert_eq!(state.viewer_state, None);
    }
}
