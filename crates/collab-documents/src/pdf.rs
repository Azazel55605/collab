//! Semantic PDF-annotation diffing shared by server and native clients.
//!
//! A hosted PDF's shared annotation state is a JSON object with four annotation
//! collections — `bookmarks`, `highlights`, `textAnnotations`, and
//! `pageComments`. [`classify_changes`] compares two revisions and returns the
//! [`PdfCapability`] tokens a write requires, so a commenter can change page
//! comments while a full annotator can change everything. The server maps these
//! tokens onto its `Capability` enum and rejects writes whose changes exceed the
//! actor's effective capabilities.
//!
//! Per-user viewer state (last page, zoom, layout) is intentionally not part of
//! the shared model and is ignored here even if present.

use std::collections::HashSet;

use serde_json::Value;

/// A capability a PDF-annotation write may require. These mirror the dotted
/// `pdf.*` capability tokens defined in `collab-protocol`; this crate keeps its
/// own enum to avoid a dependency on the protocol crate. The server maps
/// [`PdfCapability::as_token`] back onto its `Capability` enum.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum PdfCapability {
    /// Add, edit, or remove page comments.
    Comment,
    /// Add, edit, or remove bookmarks, highlights, and text annotations.
    Annotate,
}

impl PdfCapability {
    pub const ALL: [PdfCapability; 2] = [PdfCapability::Comment, PdfCapability::Annotate];

    /// The dotted capability token, identical to the matching `Capability`
    /// serde rename in `collab-protocol`.
    pub fn as_token(self) -> &'static str {
        match self {
            PdfCapability::Comment => "pdf.comment",
            PdfCapability::Annotate => "pdf.annotate",
        }
    }
}

/// Annotation fields classified under the `pdf.annotate` capability. Any change
/// to one of these requires full annotation rights.
const ANNOTATE_FIELDS: [&str; 3] = ["bookmarks", "highlights", "textAnnotations"];

/// The page-comment field, classified under the dedicated `pdf.comment`
/// capability.
const COMMENT_FIELD: &str = "pageComments";

/// Returns a normalized view of an annotation collection so that a missing
/// field, an explicit `null`, and an empty array all compare equal (the client
/// may serialize an empty collection in any of those forms).
fn collection(state: &Value, key: &str) -> Value {
    match state.get(key) {
        None | Some(Value::Null) => Value::Array(Vec::new()),
        Some(value) => value.clone(),
    }
}

/// Classifies the PDF capabilities a write from `old` to `new` requires.
///
/// An empty result means the annotation collections are unchanged (e.g. only
/// ignored viewer state differs) and the write requires no PDF capability.
pub fn classify_changes(old: &Value, new: &Value) -> HashSet<PdfCapability> {
    let mut required = HashSet::new();

    if collection(old, COMMENT_FIELD) != collection(new, COMMENT_FIELD) {
        required.insert(PdfCapability::Comment);
    }

    if ANNOTATE_FIELDS
        .iter()
        .any(|key| collection(old, key) != collection(new, key))
    {
        required.insert(PdfCapability::Annotate);
    }

    required
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn state(bookmarks: Value, highlights: Value, comments: Value) -> Value {
        json!({
            "bookmarks": bookmarks,
            "highlights": highlights,
            "textAnnotations": [],
            "pageComments": comments,
        })
    }

    #[test]
    fn identical_states_require_nothing() {
        let value = state(
            json!([]),
            json!([]),
            json!([{ "id": "k", "content": "hi" }]),
        );
        assert!(classify_changes(&value, &value).is_empty());
    }

    #[test]
    fn changing_page_comments_requires_comment_only() {
        let old = state(json!([]), json!([]), json!([]));
        let new = state(
            json!([]),
            json!([]),
            json!([{ "id": "k", "page": 1, "content": "hi" }]),
        );
        assert_eq!(
            classify_changes(&old, &new),
            HashSet::from([PdfCapability::Comment])
        );
    }

    #[test]
    fn changing_a_bookmark_requires_annotate_only() {
        let old = state(json!([]), json!([]), json!([]));
        let new = state(json!([{ "id": "b", "page": 2 }]), json!([]), json!([]));
        assert_eq!(
            classify_changes(&old, &new),
            HashSet::from([PdfCapability::Annotate])
        );
    }

    #[test]
    fn changing_a_highlight_requires_annotate() {
        let old = state(json!([]), json!([]), json!([]));
        let new = state(
            json!([]),
            json!([{ "id": "h", "page": 1, "text": "x" }]),
            json!([]),
        );
        assert_eq!(
            classify_changes(&old, &new),
            HashSet::from([PdfCapability::Annotate])
        );
    }

    #[test]
    fn changing_text_annotations_requires_annotate() {
        let old = json!({ "textAnnotations": [] });
        let new = json!({ "textAnnotations": [{ "id": "t", "page": 1, "text": "x" }] });
        assert_eq!(
            classify_changes(&old, &new),
            HashSet::from([PdfCapability::Annotate])
        );
    }

    #[test]
    fn editing_both_comments_and_annotations_requires_both() {
        let old = state(json!([]), json!([]), json!([]));
        let new = state(
            json!([{ "id": "b", "page": 1 }]),
            json!([]),
            json!([{ "id": "k", "page": 1, "content": "hi" }]),
        );
        assert_eq!(
            classify_changes(&old, &new),
            HashSet::from([PdfCapability::Comment, PdfCapability::Annotate])
        );
    }

    #[test]
    fn ignored_viewer_state_changes_require_nothing() {
        let old = json!({ "pageComments": [], "viewerState": { "lastPage": 1 } });
        let new = json!({ "pageComments": [], "viewerState": { "lastPage": 9 } });
        assert!(classify_changes(&old, &new).is_empty());
    }

    #[test]
    fn missing_and_empty_collections_compare_equal() {
        let old = json!({});
        let new =
            json!({ "pageComments": [], "bookmarks": [], "highlights": [], "textAnnotations": [] });
        assert!(classify_changes(&old, &new).is_empty());
    }
}
