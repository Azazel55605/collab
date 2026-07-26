//! Semantic kanban diffing shared by the server and native clients.
//!
//! A `.kanban` document is parsed into a tolerant [`Board`] view and two
//! revisions are compared with [`classify_changes`] to determine which
//! fine-grained kanban capabilities a write requires. The server maps the
//! returned [`KanbanCapability`] tokens onto its `Capability` enum and rejects
//! writes whose classified changes exceed the actor's effective capabilities.
//!
//! The classifier is intentionally forgiving about board shape: unknown fields
//! are preserved and compared opaquely, missing ids fall back to positional
//! keys, and either revision may be empty. This keeps enforcement aligned with
//! whatever the client persists without forking the board schema.

use std::collections::{HashMap, HashSet};

use serde_json::{Map, Value};

/// A capability a kanban write may require. These mirror the dotted
/// `kanban.*` capability tokens defined in `collab-protocol`; this crate keeps
/// its own enum to avoid a dependency on the protocol crate. The server maps
/// [`KanbanCapability::as_token`] back onto its `Capability` enum.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum KanbanCapability {
    CardCreate,
    CardEditContent,
    CardMove,
    CardComment,
    CardDelete,
    CardArchive,
    ColumnManage,
}

impl KanbanCapability {
    /// Every kanban capability, used by callers that want to test whether an
    /// actor already holds the full kanban set (and can skip diffing).
    pub const ALL: [KanbanCapability; 7] = [
        KanbanCapability::CardCreate,
        KanbanCapability::CardEditContent,
        KanbanCapability::CardMove,
        KanbanCapability::CardComment,
        KanbanCapability::CardDelete,
        KanbanCapability::CardArchive,
        KanbanCapability::ColumnManage,
    ];

    /// The dotted capability token, identical to the matching `Capability`
    /// serde rename in `collab-protocol`.
    pub fn as_token(self) -> &'static str {
        match self {
            KanbanCapability::CardCreate => "kanban.card.create",
            KanbanCapability::CardEditContent => "kanban.card.editContent",
            KanbanCapability::CardMove => "kanban.card.move",
            KanbanCapability::CardComment => "kanban.card.comment",
            KanbanCapability::CardDelete => "kanban.card.delete",
            KanbanCapability::CardArchive => "kanban.card.archive",
            KanbanCapability::ColumnManage => "kanban.column.manage",
        }
    }
}

/// Fields excluded from a card's content comparison because they are classified
/// by a dedicated capability (comments) or are archive bookkeeping written
/// together with the `archived` flag.
const NON_CONTENT_CARD_FIELDS: [&str; 6] = [
    "comments",
    "archived",
    "archivedColumnId",
    "archivedAt",
    "archivedByUserId",
    "archivedByUserName",
];

/// A parse failure. Callers that cannot classify a board should fail closed
/// (reject the write) for partially-capable actors.
#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum KanbanParseError {
    #[error("kanban document is not valid JSON")]
    Json,
    #[error("kanban document is not a JSON object")]
    Shape,
}

/// A minimal, comparison-oriented view of a `.kanban` document.
#[derive(Debug, Clone, Default)]
pub struct Board {
    columns: Vec<Column>,
    /// Board-level settings other than `columns` (saved filters, active filter,
    /// view settings, automations, and any forward-compatible fields), compared
    /// opaquely for the column-management capability.
    settings: Map<String, Value>,
}

#[derive(Debug, Clone)]
struct Column {
    id: String,
    /// Column metadata excluding the `cards` array.
    meta: Map<String, Value>,
    cards: Vec<Card>,
}

#[derive(Debug, Clone)]
struct Card {
    id: String,
    column_id: String,
    comments: Value,
    archived: bool,
    /// All card fields except comments and archive bookkeeping, compared for
    /// the content-edit capability.
    content: Map<String, Value>,
}

impl Board {
    /// An empty board, used as the "previous" side when a kanban document has no
    /// prior revision (e.g. its first content write).
    pub fn empty() -> Board {
        Board::default()
    }

    /// Parses raw `.kanban` bytes into a tolerant board view.
    pub fn parse(raw: &[u8]) -> Result<Board, KanbanParseError> {
        let value: Value = serde_json::from_slice(raw).map_err(|_| KanbanParseError::Json)?;
        let object = value.as_object().ok_or(KanbanParseError::Shape)?;

        let mut settings = object.clone();
        let columns_value = settings.remove("columns");

        let columns = columns_value
            .as_ref()
            .and_then(Value::as_array)
            .map(|entries| {
                entries
                    .iter()
                    .enumerate()
                    .map(|(index, entry)| parse_column(index, entry))
                    .collect()
            })
            .unwrap_or_default();

        Ok(Board { columns, settings })
    }
}

fn parse_column(index: usize, value: &Value) -> Column {
    let object = value.as_object().cloned().unwrap_or_default();
    let id = string_id(object.get("id"), "column", index);
    let mut meta = object.clone();
    let cards_value = meta.remove("cards");
    let cards = cards_value
        .as_ref()
        .and_then(Value::as_array)
        .map(|entries| {
            entries
                .iter()
                .enumerate()
                .map(|(card_index, entry)| parse_card(&id, card_index, entry))
                .collect()
        })
        .unwrap_or_default();
    Column { id, meta, cards }
}

fn parse_card(column_id: &str, index: usize, value: &Value) -> Card {
    let object = value.as_object().cloned().unwrap_or_default();
    let id = string_id(object.get("id"), "card", index);
    let comments = object.get("comments").cloned().unwrap_or(Value::Null);
    let archived = object
        .get("archived")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let mut content = object;
    for field in NON_CONTENT_CARD_FIELDS {
        content.remove(field);
    }
    Card {
        id,
        column_id: column_id.to_owned(),
        comments,
        archived,
        content,
    }
}

/// A stable identity for an entity. Uses the JSON `id` string when present,
/// otherwise a positional fallback so unkeyed entries still compare positionally
/// instead of collapsing together.
fn string_id(value: Option<&Value>, prefix: &str, index: usize) -> String {
    match value.and_then(Value::as_str) {
        Some(id) if !id.is_empty() => id.to_owned(),
        _ => format!("__{prefix}_{index}"),
    }
}

/// Classifies the kanban capabilities a write from `old` to `new` requires.
///
/// An empty result means the write is structurally a no-op (or only touched
/// fields the engine treats as cosmetic) and requires no kanban capability
/// beyond the baseline `file.write` the endpoint already enforces.
pub fn classify_changes(old: &Board, new: &Board) -> HashSet<KanbanCapability> {
    let mut required = HashSet::new();

    let old_cards = index_cards(old);
    let new_cards = index_cards(new);

    for (id, new_card) in &new_cards {
        match old_cards.get(id) {
            None => {
                required.insert(KanbanCapability::CardCreate);
            }
            Some(old_card) => {
                if old_card.column_id != new_card.column_id {
                    required.insert(KanbanCapability::CardMove);
                }
                if old_card.archived != new_card.archived {
                    required.insert(KanbanCapability::CardArchive);
                }
                if old_card.comments != new_card.comments {
                    required.insert(KanbanCapability::CardComment);
                }
                if old_card.content != new_card.content {
                    required.insert(KanbanCapability::CardEditContent);
                }
            }
        }
    }

    for id in old_cards.keys() {
        if !new_cards.contains_key(id) {
            required.insert(KanbanCapability::CardDelete);
        }
    }

    if reordered_within_column(old, new) {
        required.insert(KanbanCapability::CardMove);
    }

    if columns_or_settings_changed(old, new) {
        required.insert(KanbanCapability::ColumnManage);
    }

    required
}

fn index_cards(board: &Board) -> HashMap<&str, &Card> {
    board
        .columns
        .iter()
        .flat_map(|column| column.cards.iter())
        .map(|card| (card.id.as_str(), card))
        .collect()
}

/// Detects whether any cards present in both revisions changed relative order
/// within a column. Comparing the relative order of the *common* cards avoids
/// the false positives that absolute card indices would produce when cards are
/// added to or removed from a column.
fn reordered_within_column(old: &Board, new: &Board) -> bool {
    for new_column in &new.columns {
        let Some(old_column) = old.columns.iter().find(|column| column.id == new_column.id) else {
            continue;
        };
        let old_order: HashMap<&str, usize> = old_column
            .cards
            .iter()
            .enumerate()
            .map(|(index, card)| (card.id.as_str(), index))
            .collect();
        let common_order: Vec<usize> = new_column
            .cards
            .iter()
            .filter_map(|card| old_order.get(card.id.as_str()).copied())
            .collect();
        if common_order.windows(2).any(|pair| pair[0] > pair[1]) {
            return true;
        }
    }
    false
}

/// Detects column add/remove/reorder, per-column metadata changes (including
/// renames), and any board-level setting change.
fn columns_or_settings_changed(old: &Board, new: &Board) -> bool {
    if old.settings != new.settings {
        return true;
    }
    let old_ids: Vec<&str> = old
        .columns
        .iter()
        .map(|column| column.id.as_str())
        .collect();
    let new_ids: Vec<&str> = new
        .columns
        .iter()
        .map(|column| column.id.as_str())
        .collect();
    if old_ids != new_ids {
        return true;
    }
    old.columns
        .iter()
        .zip(&new.columns)
        .any(|(old_column, new_column)| old_column.meta != new_column.meta)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn board(value: Value) -> Board {
        Board::parse(value.to_string().as_bytes()).unwrap()
    }

    fn single_column(cards: Value) -> Value {
        json!({ "columns": [{ "id": "c1", "title": "Todo", "cards": cards }] })
    }

    #[test]
    fn identical_boards_require_nothing() {
        let value = single_column(json!([{ "id": "a", "title": "A", "comments": [] }]));
        let required = classify_changes(&board(value.clone()), &board(value));
        assert!(required.is_empty());
    }

    #[test]
    fn adding_a_card_requires_create() {
        let old = board(single_column(
            json!([{ "id": "a", "title": "A", "comments": [] }]),
        ));
        let new = board(single_column(json!([
            { "id": "a", "title": "A", "comments": [] },
            { "id": "b", "title": "B", "comments": [] },
        ])));
        assert_eq!(
            classify_changes(&old, &new),
            HashSet::from([KanbanCapability::CardCreate])
        );
    }

    #[test]
    fn removing_a_card_requires_delete() {
        let old = board(single_column(json!([
            { "id": "a", "title": "A", "comments": [] },
            { "id": "b", "title": "B", "comments": [] },
        ])));
        let new = board(single_column(
            json!([{ "id": "a", "title": "A", "comments": [] }]),
        ));
        assert_eq!(
            classify_changes(&old, &new),
            HashSet::from([KanbanCapability::CardDelete])
        );
    }

    #[test]
    fn editing_card_content_requires_edit_content_only() {
        let old = board(single_column(
            json!([{ "id": "a", "title": "A", "comments": [] }]),
        ));
        let new = board(single_column(
            json!([{ "id": "a", "title": "A renamed", "comments": [] }]),
        ));
        assert_eq!(
            classify_changes(&old, &new),
            HashSet::from([KanbanCapability::CardEditContent])
        );
    }

    #[test]
    fn changing_comments_requires_comment_only() {
        let old = board(single_column(
            json!([{ "id": "a", "title": "A", "comments": [] }]),
        ));
        let new = board(single_column(json!([{
            "id": "a",
            "title": "A",
            "comments": [{ "id": "x", "content": "hi" }],
        }])));
        assert_eq!(
            classify_changes(&old, &new),
            HashSet::from([KanbanCapability::CardComment])
        );
    }

    #[test]
    fn archiving_requires_archive_not_edit_content() {
        let old = board(single_column(
            json!([{ "id": "a", "title": "A", "comments": [] }]),
        ));
        let new = board(single_column(json!([{
            "id": "a",
            "title": "A",
            "comments": [],
            "archived": true,
            "archivedAt": 1234,
            "archivedColumnId": "c1",
        }])));
        assert_eq!(
            classify_changes(&old, &new),
            HashSet::from([KanbanCapability::CardArchive])
        );
    }

    #[test]
    fn moving_a_card_between_columns_requires_move() {
        let old = board(json!({ "columns": [
            { "id": "c1", "cards": [{ "id": "a", "title": "A", "comments": [] }] },
            { "id": "c2", "cards": [] },
        ] }));
        let new = board(json!({ "columns": [
            { "id": "c1", "cards": [] },
            { "id": "c2", "cards": [{ "id": "a", "title": "A", "comments": [] }] },
        ] }));
        assert_eq!(
            classify_changes(&old, &new),
            HashSet::from([KanbanCapability::CardMove])
        );
    }

    #[test]
    fn reordering_within_a_column_requires_move() {
        let old = board(single_column(json!([
            { "id": "a", "title": "A", "comments": [] },
            { "id": "b", "title": "B", "comments": [] },
        ])));
        let new = board(single_column(json!([
            { "id": "b", "title": "B", "comments": [] },
            { "id": "a", "title": "A", "comments": [] },
        ])));
        assert_eq!(
            classify_changes(&old, &new),
            HashSet::from([KanbanCapability::CardMove])
        );
    }

    #[test]
    fn deleting_a_card_does_not_flag_others_as_moved() {
        // Removing the first card shifts the absolute index of the survivors but
        // must not be misclassified as a reorder.
        let old = board(single_column(json!([
            { "id": "a", "title": "A", "comments": [] },
            { "id": "b", "title": "B", "comments": [] },
            { "id": "c", "title": "C", "comments": [] },
        ])));
        let new = board(single_column(json!([
            { "id": "b", "title": "B", "comments": [] },
            { "id": "c", "title": "C", "comments": [] },
        ])));
        assert_eq!(
            classify_changes(&old, &new),
            HashSet::from([KanbanCapability::CardDelete])
        );
    }

    #[test]
    fn renaming_a_column_requires_column_manage() {
        let old = board(json!({ "columns": [{ "id": "c1", "title": "Todo", "cards": [] }] }));
        let new = board(json!({ "columns": [{ "id": "c1", "title": "Doing", "cards": [] }] }));
        assert_eq!(
            classify_changes(&old, &new),
            HashSet::from([KanbanCapability::ColumnManage])
        );
    }

    #[test]
    fn adding_a_column_requires_column_manage() {
        let old = board(json!({ "columns": [{ "id": "c1", "cards": [] }] }));
        let new = board(json!({ "columns": [
            { "id": "c1", "cards": [] },
            { "id": "c2", "cards": [] },
        ] }));
        assert_eq!(
            classify_changes(&old, &new),
            HashSet::from([KanbanCapability::ColumnManage])
        );
    }

    #[test]
    fn changing_board_settings_requires_column_manage() {
        let old = board(json!({ "columns": [], "automations": [] }));
        let new = board(json!({
            "columns": [],
            "automations": [{ "id": "r1", "enabled": true }],
        }));
        assert_eq!(
            classify_changes(&old, &new),
            HashSet::from([KanbanCapability::ColumnManage])
        );
    }

    #[test]
    fn combined_edits_accumulate_required_capabilities() {
        let old = board(single_column(json!([
            { "id": "a", "title": "A", "comments": [] },
            { "id": "b", "title": "B", "comments": [] },
        ])));
        // b is edited and a new card c is created.
        let new = board(single_column(json!([
            { "id": "a", "title": "A", "comments": [] },
            { "id": "b", "title": "B edited", "comments": [] },
            { "id": "c", "title": "C", "comments": [] },
        ])));
        assert_eq!(
            classify_changes(&old, &new),
            HashSet::from([
                KanbanCapability::CardEditContent,
                KanbanCapability::CardCreate,
            ])
        );
    }

    #[test]
    fn parsing_against_empty_previous_treats_cards_as_created() {
        // From a truly empty board, both the new column and its card are added,
        // so the write requires column management as well as card creation.
        let new = board(single_column(
            json!([{ "id": "a", "title": "A", "comments": [] }]),
        ));
        assert_eq!(
            classify_changes(&Board::empty(), &new),
            HashSet::from([KanbanCapability::CardCreate, KanbanCapability::ColumnManage,])
        );
    }

    #[test]
    fn adding_a_card_to_an_existing_empty_column_requires_only_create() {
        let old = board(single_column(json!([])));
        let new = board(single_column(
            json!([{ "id": "a", "title": "A", "comments": [] }]),
        ));
        assert_eq!(
            classify_changes(&old, &new),
            HashSet::from([KanbanCapability::CardCreate])
        );
    }

    #[test]
    fn invalid_json_is_rejected() {
        assert!(matches!(
            Board::parse(b"not json"),
            Err(KanbanParseError::Json)
        ));
        assert!(matches!(Board::parse(b"[]"), Err(KanbanParseError::Shape)));
    }
}
