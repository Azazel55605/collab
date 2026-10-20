//! Transport-independent live document state and policy.
//!
//! This crate owns Yrs document conversion, update validation/application,
//! state-vector exchange, compaction, replay bounds, recovery decisions, and
//! materialization guards. Socket lifecycle, authentication, room registries,
//! persistence, and scheduling remain in adapters.

mod deck;
mod text_merge;

pub use text_merge::try_auto_merge_text;

pub use deck::is_rich_text;

use collab_documents::{canvas_node_count, DocumentInput, DocumentKind, DEFAULT_PARSER_LIMITS};
use serde::{Deserialize, Serialize};
use thiserror::Error;
pub use yrs::Doc;
use yrs::{
    types::ToJson,
    updates::{decoder::Decode, encoder::Encode},
    Any, ArrayPrelim, GetString, In, Map, MapPrelim, ReadTxn, StateVector, Text, TextPrelim,
    Transact, Update,
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
    Ink,
    Deck,
}

impl LiveDocumentKind {
    pub fn from_document_type(value: Option<&str>) -> Self {
        match value {
            Some("note") => Self::NoteText,
            Some("kanban") => Self::Json,
            Some("canvas") => Self::Canvas,
            Some("sheet") => Self::Sheet,
            Some("ink") => Self::Ink,
            Some("deck") => Self::Deck,
            _ => Self::None,
        }
    }

    pub fn is_structured(self) -> bool {
        matches!(
            self,
            Self::Json | Self::Canvas | Self::Sheet | Self::Ink | Self::Deck
        )
    }

    pub fn document_kind(self) -> Option<DocumentKind> {
        match self {
            Self::None => None,
            Self::NoteText => Some(DocumentKind::Note),
            Self::Json => Some(DocumentKind::Kanban),
            Self::Canvas => Some(DocumentKind::Canvas),
            Self::Sheet => Some(DocumentKind::Sheet),
            Self::Ink => Some(DocumentKind::Ink),
            Self::Deck => Some(DocumentKind::Deck),
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
        LiveDocumentKind::Deck => deck::write_deck(doc, content, false),
        LiveDocumentKind::Json
        | LiveDocumentKind::Canvas
        | LiveDocumentKind::Sheet
        | LiveDocumentKind::Ink => {
            let map = structured_object(content)?;
            let root = doc.get_or_insert_map(JSON_ROOT_NAME);
            let mut txn = doc.transact_mut();
            for (key, value) in map {
                root.insert(
                    &mut txn,
                    key,
                    json_to_in(&value, kind == LiveDocumentKind::Ink),
                );
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
        LiveDocumentKind::Deck => deck::write_deck(doc, content, true)?,
        LiveDocumentKind::Json
        | LiveDocumentKind::Canvas
        | LiveDocumentKind::Sheet
        | LiveDocumentKind::Ink => {
            let map = structured_object(content)?;
            let root = doc.get_or_insert_map(JSON_ROOT_NAME);
            let mut txn = doc.transact_mut();
            root.clear(&mut txn);
            for (key, value) in map {
                root.insert(
                    &mut txn,
                    key,
                    json_to_in(&value, kind == LiveDocumentKind::Ink),
                );
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
        LiveDocumentKind::Deck => deck::read_deck(doc),
        LiveDocumentKind::Json
        | LiveDocumentKind::Canvas
        | LiveDocumentKind::Sheet
        | LiveDocumentKind::Ink => {
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
        LiveDocumentKind::Json
        | LiveDocumentKind::Sheet
        | LiveDocumentKind::Ink
        | LiveDocumentKind::Deck => {
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

/// Structured documents compare JSON values, not indentation or object-key order.
/// Text documents retain exact byte semantics. Invalid JSON is never equivalent
/// to a different byte sequence.
pub fn content_matches(kind: LiveDocumentKind, left: &str, right: &str) -> bool {
    if left == right {
        return true;
    }
    if !kind.is_structured() {
        return false;
    }
    match (
        serde_json::from_str::<serde_json::Value>(left),
        serde_json::from_str::<serde_json::Value>(right),
    ) {
        (Ok(left), Ok(right)) => json_values_match(&left, &right),
        _ => false,
    }
}

fn json_values_match(left: &serde_json::Value, right: &serde_json::Value) -> bool {
    use serde_json::Value;
    match (left, right) {
        (Value::Number(left), Value::Number(right)) => {
            if left == right {
                return true;
            }
            // Yrs serializes JavaScript numbers as f64 (1.0), while REST JSON
            // commonly uses integers (1). Compare mixed forms exactly without
            // rounding distinct large integers through f64.
            let (float, integer) = if left.is_f64() && !right.is_f64() {
                (left, right)
            } else if right.is_f64() && !left.is_f64() {
                (right, left)
            } else {
                return false;
            };
            let integer = integer
                .as_i64()
                .map(i128::from)
                .or_else(|| integer.as_u64().map(i128::from));
            match (float.as_f64(), integer) {
                (Some(float), Some(integer)) => {
                    float.is_finite() && float.fract() == 0.0 && float as i128 == integer
                }
                _ => false,
            }
        }
        (Value::Array(left), Value::Array(right)) => {
            left.len() == right.len()
                && left
                    .iter()
                    .zip(right)
                    .all(|(left, right)| json_values_match(left, right))
        }
        (Value::Object(left), Value::Object(right)) => {
            left.len() == right.len()
                && left.iter().all(|(key, value)| {
                    right
                        .get(key)
                        .is_some_and(|other| json_values_match(value, other))
                })
        }
        _ => left == right,
    }
}

/// Reconcile a REST write against the room's current materialized content.
pub fn merge_external_content(
    kind: LiveDocumentKind,
    base: &str,
    incoming: &str,
    live: &str,
) -> Option<String> {
    if content_matches(kind, live, base) || content_matches(kind, live, incoming) {
        return Some(incoming.to_owned());
    }
    if content_matches(kind, incoming, base) {
        return Some(live.to_owned());
    }
    match kind {
        LiveDocumentKind::NoteText => try_auto_merge_text(base, incoming, live),
        LiveDocumentKind::None => Some(incoming.to_owned()),
        _ => None,
    }
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

fn json_to_in(value: &serde_json::Value, ink: bool) -> In {
    match value {
        serde_json::Value::Null => In::Any(Any::Null),
        serde_json::Value::Bool(value) => In::Any(Any::Bool(*value)),
        serde_json::Value::Number(value) => {
            In::Any(Any::Number(value.as_f64().unwrap_or(0.0).into()))
        }
        serde_json::Value::String(value) => In::Any(Any::String(value.as_str().into())),
        serde_json::Value::Array(items) => In::Array(ArrayPrelim::from(
            items
                .iter()
                .map(|item| json_to_in(item, ink))
                .collect::<Vec<_>>(),
        )),
        serde_json::Value::Object(map) => {
            let is_ink_text =
                ink && map.get("type").and_then(serde_json::Value::as_str) == Some("text");
            In::Map(MapPrelim::from_iter(map.iter().map(|(key, value)| {
                let child = if is_ink_text && key == "text" {
                    value
                        .as_str()
                        .map(|text| In::from(TextPrelim::new(text)))
                        .unwrap_or_else(|| json_to_in(value, ink))
                } else {
                    json_to_in(value, ink)
                };
                (key.clone(), child)
            })))
        }
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn structured_numeric_forms_match_without_rounding_real_changes() {
        use super::{content_matches, LiveDocumentKind::Canvas};
        assert!(content_matches(
            Canvas,
            r#"{"zoom":1,"position":[0,-2]}"#,
            r#"{"position":[0.0,-2.0],"zoom":1.0}"#
        ));
        assert!(!content_matches(
            Canvas,
            "9007199254740993",
            "9007199254740992.0"
        ));
        assert!(!content_matches(
            Canvas,
            "9007199254740993",
            "9007199254740992"
        ));
        assert!(!content_matches(Canvas, "[1,2]", "[2,1]"));
    }

    #[test]
    fn rest_canvas_edits_do_not_conflict_with_an_unchanged_live_json_document() {
        let base = "{\n  \"nodes\": [],\n  \"viewport\": {\"zoom\": 1, \"x\": 0, \"y\": 0}\n}";
        let live = r#"{"viewport":{"y":0,"x":0,"zoom":1},"nodes":[]}"#;
        let edited = r#"{"nodes":[{"id":"new"}],"viewport":{"zoom":1,"x":0,"y":0}}"#;
        assert_ne!(base, live);
        assert!(super::content_matches(
            super::LiveDocumentKind::Canvas,
            base,
            live
        ));
        for _ in 0..3 {
            assert_eq!(
                super::merge_external_content(super::LiveDocumentKind::Canvas, base, edited, live)
                    .as_deref(),
                Some(edited)
            );
        }
        assert!(super::merge_external_content(
            super::LiveDocumentKind::Canvas,
            base,
            edited,
            r#"{"nodes":[{"id":"remote"}]}"#
        )
        .is_none());
        assert!(!super::content_matches(
            super::LiveDocumentKind::NoteText,
            base,
            live
        ));
        assert!(!super::content_matches(
            super::LiveDocumentKind::Canvas,
            "{invalid",
            "{invalid "
        ));
    }

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
        let content = r##"{
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
        }"##;
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
    fn ink_documents_use_the_structured_live_boundary() {
        let content = r##"{
          "kind":"collab-ink","schemaVersion":1,"id":"ink1","name":"Shared ink",
          "pages":{"page-1":{"id":"page-1","mode":"fixed","width":38098,"height":53881,
            "background":{"pattern":"blank"},"scene":{
              "layers":{"layer-1":{"id":"layer-1","name":"Layer 1","visible":true,"locked":false,"opacity":1}},
              "layerOrder":["layer-1"],
              "objects":{"text-1":{"id":"text-1","type":"text","layerId":"layer-1","x":10,"y":20,"width":300,"height":100,"text":"hello","color":"#111111","fontSize":64}},
              "objectOrder":["text-1"]}}},
          "pageOrder":["page-1"],"brushes":{},"swatches":[]
        }"##;
        let doc = Doc::new();
        seed_document(&doc, LiveDocumentKind::Ink, content).unwrap();
        let materialized = materialized_content(&doc, LiveDocumentKind::Ink).unwrap();

        assert_eq!(
            LiveDocumentKind::from_document_type(Some("ink")),
            LiveDocumentKind::Ink
        );
        assert!(LiveDocumentKind::Ink.is_structured());
        assert_eq!(
            LiveDocumentKind::Ink.document_kind(),
            Some(DocumentKind::Ink)
        );
        assert_eq!(
            materialization_decision(LiveDocumentKind::Ink, Some(content), Some(&materialized)),
            MaterializationDecision::Ready
        );
        let value: serde_json::Value = serde_json::from_str(&materialized).unwrap();
        assert_eq!(
            value["pages"]["page-1"]["scene"]["objects"]["text-1"]["text"],
            "hello"
        );
    }

    #[test]
    fn ink_clients_converge_after_a_bounded_offline_soak() {
        fn content(author: &str, round: usize) -> String {
            format!(
                r##"{{
                  "kind":"collab-ink","schemaVersion":1,"id":"ink1","name":"Soak",
                  "pages":{{"page-1":{{"id":"page-1","mode":"fixed","width":38098,"height":53881,
                    "background":{{"pattern":"blank"}},"scene":{{
                      "layers":{{"layer-1":{{"id":"layer-1","name":"Layer 1","visible":true,"locked":false,"opacity":1}}}},
                      "layerOrder":["layer-1"],
                      "objects":{{"text-1":{{"id":"text-1","type":"text","layerId":"layer-1","x":10,"y":20,"width":300,"height":100,"text":"{author}-{round}","color":"#111111","fontSize":64}}}},
                      "objectOrder":["text-1"]
                    }}}}}},
                  "pageOrder":["page-1"],"brushes":{{}},"swatches":[]
                }}"##
            )
        }

        let first = Doc::new();
        let second = Doc::new();
        seed_document(&first, LiveDocumentKind::Ink, &content("base", 0)).unwrap();
        apply_update(&second, &compact_state(&first), LiveLimits::default()).unwrap();

        let first_before = state_vector(&first);
        let second_before = state_vector(&second);
        for round in 1..=100 {
            replace_document(&first, LiveDocumentKind::Ink, &content("first", round)).unwrap();
            replace_document(&second, LiveDocumentKind::Ink, &content("second", round)).unwrap();
        }

        let first_delta = diff(&first, &second_before, LiveLimits::default()).unwrap();
        let second_delta = diff(&second, &first_before, LiveLimits::default()).unwrap();
        apply_update(&first, &second_delta, LiveLimits::default()).unwrap();
        apply_update(&second, &first_delta, LiveLimits::default()).unwrap();

        assert_eq!(compact_state(&first), compact_state(&second));
        let materialized = materialized_content(&first, LiveDocumentKind::Ink).unwrap();
        let value: serde_json::Value = serde_json::from_str(&materialized).unwrap();
        assert!(
            value["pages"]["page-1"]["scene"]["objects"]["text-1"]["text"]
                .as_str()
                .is_some_and(|text| text.ends_with("-100"))
        );
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
