//! Transport-independent live document state and policy.
//!
//! This crate owns Yrs document conversion, update validation/application,
//! state-vector exchange, compaction, replay bounds, recovery decisions, and
//! materialization guards. Socket lifecycle, authentication, room registries,
//! persistence, and scheduling remain in adapters.

use collab_documents::{canvas_node_count, DocumentInput, DocumentKind, DEFAULT_PARSER_LIMITS};
use serde::{Deserialize, Serialize};
use thiserror::Error;
pub use yrs::Doc;
use yrs::{
    types::ToJson,
    updates::{decoder::Decode, encoder::Encode},
    Any, ArrayPrelim, GetString, In, Map, MapPrelim, ReadTxn, StateVector, Text, Transact, Update,
};

pub const NOTE_TEXT_NAME: &str = "content";
pub const JSON_ROOT_NAME: &str = "doc";

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum LiveDocumentKind {
    None,
    NoteText,
    Json,
    Canvas,
    Sheet,
}

impl LiveDocumentKind {
    pub fn from_document_type(value: Option<&str>) -> Self {
        match value {
            Some("note") => Self::NoteText,
            Some("kanban") => Self::Json,
            Some("canvas") => Self::Canvas,
            Some("sheet") => Self::Sheet,
            _ => Self::None,
        }
    }

    pub fn is_structured(self) -> bool {
        matches!(self, Self::Json | Self::Canvas | Self::Sheet)
    }

    pub fn document_kind(self) -> Option<DocumentKind> {
        match self {
            Self::None => None,
            Self::NoteText => Some(DocumentKind::Note),
            Self::Json => Some(DocumentKind::Kanban),
            Self::Canvas => Some(DocumentKind::Canvas),
            Self::Sheet => Some(DocumentKind::Sheet),
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LiveLimits {
    pub max_update_bytes: usize,
    pub max_replay_updates: usize,
    pub max_replay_bytes: usize,
}

impl Default for LiveLimits {
    fn default() -> Self {
        Self {
            max_update_bytes: 16 * 1024 * 1024,
            max_replay_updates: 100_000,
            max_replay_bytes: 512 * 1024 * 1024,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum LiveError {
    #[error("Live document update is invalid.")]
    InvalidUpdate,
    #[error("Live document state vector is invalid.")]
    InvalidStateVector,
    #[error("Live document update exceeds the configured size limit.")]
    UpdateTooLarge,
    #[error("Live document replay contains too many updates.")]
    ReplayUpdateLimitExceeded,
    #[error("Live document replay exceeds the configured byte limit.")]
    ReplayByteLimitExceeded,
    #[error("Live document replay was cancelled.")]
    Cancelled,
    #[error("Structured live document content must be a JSON object.")]
    InvalidStructuredContent,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ReplaySummary {
    pub applied_updates: usize,
    pub applied_bytes: usize,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RecoveryDecision {
    Keep,
    ReseedFromCanonical,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MaterializationDecision {
    Ready,
    EmptyStructuredState,
    InvalidDocument,
    CanvasNodeLoss,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RevisionDecision {
    Current,
    Stale,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct TextEditHunk {
    base_start: usize,
    base_end: usize,
    replacement: Vec<String>,
}

pub fn validate_update(bytes: &[u8], limits: LiveLimits) -> Result<(), LiveError> {
    if bytes.len() > limits.max_update_bytes {
        return Err(LiveError::UpdateTooLarge);
    }
    Update::decode_v1(bytes)
        .map(|_| ())
        .map_err(|_| LiveError::InvalidUpdate)
}

pub fn apply_update(doc: &Doc, bytes: &[u8], limits: LiveLimits) -> Result<(), LiveError> {
    validate_update(bytes, limits)?;
    let update = Update::decode_v1(bytes).map_err(|_| LiveError::InvalidUpdate)?;
    doc.transact_mut()
        .apply_update(update)
        .map_err(|_| LiveError::InvalidUpdate)
}

pub fn replay_updates<'a>(
    doc: &Doc,
    updates: impl IntoIterator<Item = &'a [u8]>,
    limits: LiveLimits,
    mut cancelled: impl FnMut() -> bool,
) -> Result<ReplaySummary, LiveError> {
    let mut count = 0usize;
    let mut bytes = 0usize;
    for update in updates {
        if cancelled() {
            return Err(LiveError::Cancelled);
        }
        count = count
            .checked_add(1)
            .ok_or(LiveError::ReplayUpdateLimitExceeded)?;
        if count > limits.max_replay_updates {
            return Err(LiveError::ReplayUpdateLimitExceeded);
        }
        bytes = bytes
            .checked_add(update.len())
            .ok_or(LiveError::ReplayByteLimitExceeded)?;
        if bytes > limits.max_replay_bytes {
            return Err(LiveError::ReplayByteLimitExceeded);
        }
        apply_update(doc, update, limits)?;
    }
    Ok(ReplaySummary {
        applied_updates: count,
        applied_bytes: bytes,
    })
}

pub fn state_vector(doc: &Doc) -> Vec<u8> {
    doc.transact().state_vector().encode_v1()
}

pub fn diff(
    doc: &Doc,
    remote_state_vector: &[u8],
    limits: LiveLimits,
) -> Result<Vec<u8>, LiveError> {
    if remote_state_vector.len() > limits.max_update_bytes {
        return Err(LiveError::UpdateTooLarge);
    }
    let state_vector =
        StateVector::decode_v1(remote_state_vector).map_err(|_| LiveError::InvalidStateVector)?;
    Ok(doc.transact().encode_state_as_update_v1(&state_vector))
}

pub fn compact_state(doc: &Doc) -> Vec<u8> {
    doc.transact()
        .encode_state_as_update_v1(&StateVector::default())
}

pub fn seed_document(doc: &Doc, kind: LiveDocumentKind, content: &str) -> Result<(), LiveError> {
    match kind {
        LiveDocumentKind::None => Ok(()),
        LiveDocumentKind::NoteText => {
            if !content.is_empty() {
                let text = doc.get_or_insert_text(NOTE_TEXT_NAME);
                text.insert(&mut doc.transact_mut(), 0, content);
            }
            Ok(())
        }
        LiveDocumentKind::Json | LiveDocumentKind::Canvas | LiveDocumentKind::Sheet => {
            let map = structured_object(content)?;
            let root = doc.get_or_insert_map(JSON_ROOT_NAME);
            let mut txn = doc.transact_mut();
            for (key, value) in map {
                root.insert(&mut txn, key, json_to_in(&value));
            }
            Ok(())
        }
    }
}

pub fn replace_document(
    doc: &Doc,
    kind: LiveDocumentKind,
    content: &str,
) -> Result<Vec<u8>, LiveError> {
    let before = doc.transact().state_vector();
    match kind {
        LiveDocumentKind::None => return Ok(Vec::new()),
        LiveDocumentKind::NoteText => {
            let text = doc.get_or_insert_text(NOTE_TEXT_NAME);
            let mut txn = doc.transact_mut();
            let len = text.len(&txn);
            if len > 0 {
                text.remove_range(&mut txn, 0, len);
            }
            if !content.is_empty() {
                text.insert(&mut txn, 0, content);
            }
        }
        LiveDocumentKind::Json | LiveDocumentKind::Canvas | LiveDocumentKind::Sheet => {
            let map = structured_object(content)?;
            let root = doc.get_or_insert_map(JSON_ROOT_NAME);
            let mut txn = doc.transact_mut();
            root.clear(&mut txn);
            for (key, value) in map {
                root.insert(&mut txn, key, json_to_in(&value));
            }
        }
    }
    Ok(doc.transact().encode_state_as_update_v1(&before))
}

pub fn materialized_content(doc: &Doc, kind: LiveDocumentKind) -> Option<String> {
    match kind {
        LiveDocumentKind::None => None,
        LiveDocumentKind::NoteText => {
            let text = doc.get_or_insert_text(NOTE_TEXT_NAME);
            Some(text.get_string(&doc.transact()))
        }
        LiveDocumentKind::Json | LiveDocumentKind::Canvas | LiveDocumentKind::Sheet => {
            let root = doc.get_or_insert_map(JSON_ROOT_NAME);
            let txn = doc.transact();
            if root.len(&txn) == 0 {
                return None;
            }
            serde_json::to_string(&root.to_json(&txn)).ok()
        }
    }
}

pub fn recovery_decision(
    kind: LiveDocumentKind,
    had_live_state: bool,
    canonical_content: Option<&str>,
    live_content: Option<&str>,
) -> RecoveryDecision {
    if !had_live_state {
        return RecoveryDecision::Keep;
    }
    let Some(canonical) = canonical_content.filter(|content| !content.trim().is_empty()) else {
        return RecoveryDecision::Keep;
    };
    match kind {
        LiveDocumentKind::NoteText => {
            if live_content.unwrap_or_default().is_empty() {
                RecoveryDecision::ReseedFromCanonical
            } else {
                RecoveryDecision::Keep
            }
        }
        LiveDocumentKind::Json | LiveDocumentKind::Sheet => {
            if live_content.is_none() {
                RecoveryDecision::ReseedFromCanonical
            } else {
                RecoveryDecision::Keep
            }
        }
        LiveDocumentKind::Canvas => {
            let canonical_nodes = canvas_node_count(canonical).unwrap_or(0);
            let live_nodes = live_content.and_then(canvas_node_count).unwrap_or(0);
            if live_content.is_none() || (canonical_nodes > 0 && live_nodes == 0) {
                RecoveryDecision::ReseedFromCanonical
            } else {
                RecoveryDecision::Keep
            }
        }
        LiveDocumentKind::None => RecoveryDecision::Keep,
    }
}

pub fn materialization_decision(
    kind: LiveDocumentKind,
    canonical_content: Option<&str>,
    live_content: Option<&str>,
) -> MaterializationDecision {
    let Some(content) = live_content else {
        return MaterializationDecision::EmptyStructuredState;
    };
    let Some(document_kind) = kind.document_kind() else {
        return MaterializationDecision::InvalidDocument;
    };
    if collab_documents::validate(
        DocumentInput {
            kind: document_kind,
            path: "",
            content: content.as_bytes(),
        },
        DEFAULT_PARSER_LIMITS,
    )
    .is_err()
    {
        return MaterializationDecision::InvalidDocument;
    }
    if kind == LiveDocumentKind::Canvas {
        let current_nodes = canonical_content.and_then(canvas_node_count).unwrap_or(0);
        let new_nodes = canvas_node_count(content).unwrap_or(0);
        if current_nodes > 0 && new_nodes == 0 {
            return MaterializationDecision::CanvasNodeLoss;
        }
    }
    MaterializationDecision::Ready
}

pub fn revision_decision<T: Eq>(expected: Option<&T>, current: Option<&T>) -> RevisionDecision {
    if expected == current {
        RevisionDecision::Current
    } else {
        RevisionDecision::Stale
    }
}

pub fn try_auto_merge_text(base: &str, ours: &str, theirs: &str) -> Option<String> {
    if ours == theirs {
        return Some(ours.to_string());
    }
    let our_hunks = compute_line_edit_hunks(base, ours);
    let their_hunks = compute_line_edit_hunks(base, theirs);
    let base_lines = split_text_preserving_newlines(base);
    let mut merged_hunks = Vec::new();
    let mut our_index = 0usize;
    let mut their_index = 0usize;

    while our_index < our_hunks.len() || their_index < their_hunks.len() {
        match (our_hunks.get(our_index), their_hunks.get(their_index)) {
            (Some(ours), Some(theirs)) if ours.base_end <= theirs.base_start => {
                merged_hunks.push(ours.clone());
                our_index += 1;
            }
            (Some(ours), Some(theirs)) if theirs.base_end <= ours.base_start => {
                merged_hunks.push(theirs.clone());
                their_index += 1;
            }
            (Some(ours), Some(theirs)) if ours == theirs => {
                merged_hunks.push(ours.clone());
                our_index += 1;
                their_index += 1;
            }
            (Some(_), Some(_)) => return None,
            (Some(ours), None) => {
                merged_hunks.push(ours.clone());
                our_index += 1;
            }
            (None, Some(theirs)) => {
                merged_hunks.push(theirs.clone());
                their_index += 1;
            }
            (None, None) => break,
        }
    }

    let mut merged = String::new();
    let mut cursor = 0usize;
    for hunk in merged_hunks {
        for line in &base_lines[cursor..hunk.base_start] {
            merged.push_str(line);
        }
        for line in &hunk.replacement {
            merged.push_str(line);
        }
        cursor = hunk.base_end;
    }
    for line in &base_lines[cursor..] {
        merged.push_str(line);
    }
    Some(merged)
}

pub fn is_document_message_tag(tag: u8) -> bool {
    matches!(
        tag,
        collab_protocol::ws_message::SYNC_STEP1 | collab_protocol::ws_message::SYNC_UPDATE
    )
}

fn structured_object(
    content: &str,
) -> Result<serde_json::Map<String, serde_json::Value>, LiveError> {
    match serde_json::from_str::<serde_json::Value>(content) {
        Ok(serde_json::Value::Object(map)) => Ok(map),
        _ => Err(LiveError::InvalidStructuredContent),
    }
}

fn json_to_in(value: &serde_json::Value) -> In {
    match value {
        serde_json::Value::Null => In::Any(Any::Null),
        serde_json::Value::Bool(value) => In::Any(Any::Bool(*value)),
        serde_json::Value::Number(value) => In::Any(Any::Number(value.as_f64().unwrap_or(0.0))),
        serde_json::Value::String(value) => In::Any(Any::String(value.as_str().into())),
        serde_json::Value::Array(items) => In::Array(ArrayPrelim::from(
            items.iter().map(json_to_in).collect::<Vec<_>>(),
        )),
        serde_json::Value::Object(map) => In::Map(MapPrelim::from_iter(
            map.iter()
                .map(|(key, value)| (key.clone(), json_to_in(value))),
        )),
    }
}

fn split_text_preserving_newlines(content: &str) -> Vec<String> {
    content
        .split_inclusive('\n')
        .map(ToOwned::to_owned)
        .collect()
}

fn compute_line_edit_hunks(base: &str, modified: &str) -> Vec<TextEditHunk> {
    let base_lines = split_text_preserving_newlines(base);
    let modified_lines = split_text_preserving_newlines(modified);
    let n = base_lines.len();
    let m = modified_lines.len();
    let mut lcs = vec![vec![0usize; m + 1]; n + 1];

    for i in (0..n).rev() {
        for j in (0..m).rev() {
            lcs[i][j] = if base_lines[i] == modified_lines[j] {
                lcs[i + 1][j + 1] + 1
            } else {
                lcs[i + 1][j].max(lcs[i][j + 1])
            };
        }
    }

    let mut i = 0usize;
    let mut j = 0usize;
    let mut base_index = 0usize;
    let mut hunks = Vec::new();
    let mut active_start = None;
    let mut active_end = 0usize;
    let mut replacement = Vec::new();

    while i < n || j < m {
        if i < n && j < m && base_lines[i] == modified_lines[j] {
            if let Some(start) = active_start.take() {
                hunks.push(TextEditHunk {
                    base_start: start,
                    base_end: active_end,
                    replacement: std::mem::take(&mut replacement),
                });
            }
            i += 1;
            j += 1;
            base_index += 1;
            continue;
        }
        if active_start.is_none() {
            active_start = Some(base_index);
            active_end = base_index;
        }
        if j < m && (i == n || lcs[i][j + 1] >= lcs[i + 1][j]) {
            replacement.push(modified_lines[j].clone());
            j += 1;
        } else if i < n {
            i += 1;
            base_index += 1;
            active_end += 1;
        }
    }
    if let Some(start) = active_start {
        hunks.push(TextEditHunk {
            base_start: start,
            base_end: active_end,
            replacement,
        });
    }
    hunks
}

#[cfg(test)]
mod tests {
    use super::*;

    fn text_state(content: &str) -> Vec<u8> {
        let doc = Doc::new();
        seed_document(&doc, LiveDocumentKind::NoteText, content).unwrap();
        compact_state(&doc)
    }

    #[test]
    fn concurrent_updates_converge_and_duplicates_are_idempotent() {
        let first = Doc::new();
        let second = Doc::new();
        seed_document(&first, LiveDocumentKind::NoteText, "base").unwrap();
        apply_update(&second, &compact_state(&first), LiveLimits::default()).unwrap();

        let first_before = state_vector(&first);
        let second_before = state_vector(&second);
        replace_document(&first, LiveDocumentKind::NoteText, "first").unwrap();
        replace_document(&second, LiveDocumentKind::NoteText, "second").unwrap();
        let first_delta = diff(&first, &second_before, LiveLimits::default()).unwrap();
        let second_delta = diff(&second, &first_before, LiveLimits::default()).unwrap();
        apply_update(&first, &second_delta, LiveLimits::default()).unwrap();
        apply_update(&second, &first_delta, LiveLimits::default()).unwrap();
        apply_update(&second, &first_delta, LiveLimits::default()).unwrap();

        assert_eq!(compact_state(&first), compact_state(&second));
    }

    #[test]
    fn structured_round_trip_preserves_nested_json_values() {
        let doc = Doc::new();
        seed_document(
            &doc,
            LiveDocumentKind::Json,
            r#"{"count":2,"nested":{"enabled":true},"items":["a",3]}"#,
        )
        .unwrap();
        let value: serde_json::Value =
            serde_json::from_str(&materialized_content(&doc, LiveDocumentKind::Json).unwrap())
                .unwrap();
        assert_eq!(value["count"], 2.0);
        assert_eq!(value["nested"]["enabled"], true);
        assert_eq!(value["items"][1], 3.0);
    }

    #[test]
    fn sheet_documents_use_the_structured_live_boundary() {
        let content = r#"{
          "kind":"collab-sheet",
          "schemaVersion":1,
          "id":"wb1",
          "name":"Budget",
          "createdAt":"2026-01-01T00:00:00Z",
          "updatedAt":"2026-01-01T00:00:00Z",
          "activeWorksheetId":"ws1",
          "worksheets":[{
            "id":"ws1",
            "name":"Sheet1",
            "rowOrder":["r1"],
            "columnOrder":["c1"],
            "cells":{"r1:c1":{"formula":"=1+1"}}
          }],
          "styles":{}
        }"#;
        let doc = Doc::new();
        seed_document(&doc, LiveDocumentKind::Sheet, content).unwrap();
        let materialized = materialized_content(&doc, LiveDocumentKind::Sheet).unwrap();

        assert_eq!(
            LiveDocumentKind::from_document_type(Some("sheet")),
            LiveDocumentKind::Sheet
        );
        assert_eq!(
            materialization_decision(LiveDocumentKind::Sheet, Some(content), Some(&materialized)),
            MaterializationDecision::Ready
        );
        let value: serde_json::Value = serde_json::from_str(&materialized).unwrap();
        assert_eq!(value["worksheets"][0]["cells"]["r1:c1"]["formula"], "=1+1");
        assert!(value.get("computedValues").is_none());
    }

    #[test]
    fn replay_is_bounded_validated_and_cancellable() {
        let update = text_state("valid");
        let doc = Doc::new();
        let limits = LiveLimits {
            max_update_bytes: update.len(),
            max_replay_updates: 1,
            max_replay_bytes: update.len(),
        };
        assert_eq!(
            replay_updates(&doc, [update.as_slice()], limits, || false).unwrap(),
            ReplaySummary {
                applied_updates: 1,
                applied_bytes: update.len()
            }
        );
        assert_eq!(
            replay_updates(
                &Doc::new(),
                [update.as_slice(), update.as_slice()],
                limits,
                || false
            ),
            Err(LiveError::ReplayUpdateLimitExceeded)
        );
        assert_eq!(
            replay_updates(&Doc::new(), [update.as_slice()], limits, || true),
            Err(LiveError::Cancelled)
        );
        assert_eq!(
            apply_update(&Doc::new(), b"invalid", limits),
            Err(LiveError::InvalidUpdate)
        );
    }

    #[test]
    fn recovery_and_materialization_protect_canonical_content() {
        assert_eq!(
            recovery_decision(
                LiveDocumentKind::NoteText,
                true,
                Some("canonical"),
                Some("")
            ),
            RecoveryDecision::ReseedFromCanonical
        );
        let canonical = r#"{"nodes":[{"id":"one"}],"edges":[]}"#;
        let degenerate = r#"{"nodes":[],"edges":[]}"#;
        assert_eq!(
            recovery_decision(
                LiveDocumentKind::Canvas,
                true,
                Some(canonical),
                Some(degenerate)
            ),
            RecoveryDecision::ReseedFromCanonical
        );
        assert_eq!(
            materialization_decision(LiveDocumentKind::Canvas, Some(canonical), Some(degenerate)),
            MaterializationDecision::CanvasNodeLoss
        );
    }

    #[test]
    fn revisions_and_text_merges_are_deterministic() {
        assert_eq!(
            revision_decision(Some(&2), Some(&2)),
            RevisionDecision::Current
        );
        assert_eq!(
            revision_decision(Some(&2), Some(&3)),
            RevisionDecision::Stale
        );
        let base = "alpha\nbeta\ngamma\n";
        assert_eq!(
            try_auto_merge_text(base, "ALPHA\nbeta\ngamma\n", "alpha\nbeta\nGAMMA\n"),
            Some("ALPHA\nbeta\nGAMMA\n".into())
        );
        assert_eq!(
            try_auto_merge_text(base, "ALPHA\nbeta\ngamma\n", "OTHER\nbeta\ngamma\n"),
            None
        );
    }
}
