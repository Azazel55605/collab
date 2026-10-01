//! The live form of a `.deck` presentation.
//!
//! A deck lives in the same root map (`doc`) as the other structured kinds:
//! objects are `Y.Map`s and arrays `Y.Array`s, so different slides and
//! different elements merge independently. Two things differ, and the desktop
//! client (`src/lib/deck/liveDeckDocument.ts`) follows the same rules:
//!
//! - **Rich text** — any object whose only key is `paragraphs` (a
//!   `DeckRichText`) — is one `Y.Text` in the encoding of
//!   `src/lib/deck/liveText.ts`: characters carry run formatting as one
//!   attribute per style key, every paragraph ends in `\n` carrying the
//!   paragraph's id and style, and U+2028 is a soft break. Two people typing
//!   in one text box then merge character by character.
//! - **Geometry values** (`frame`, `crop`, `from`, `to`, `size`) are stored
//!   whole, so two concurrent moves of one object end at one of the two
//!   positions, never at a mix of both.
//!
//! Materialization reads this back to ordinary `.deck` JSON. Integral numbers
//! are written as integers (the validator reads some fields as `u64`), and the
//! ordering lists that concurrent edits can leave inconsistent — a slide or
//! element ordered twice after two simultaneous moves, or an order entry for
//! something a peer deleted — are repaired the same way the desktop repairs a
//! stored deck on open: drop dangling and duplicate entries, append anything
//! unordered. Deletion therefore wins over a concurrent move or edit.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::sync::Arc;

use serde_json::{Map, Number, Value};
use yrs::types::text::YChange;
use yrs::{
    Any, Array, ArrayPrelim, ArrayRef, Doc, Map as _, MapPrelim, MapRef, Out, ReadTxn, Text,
    TextPrelim, TextRef, Transact, TransactionMut,
};

use crate::{LiveError, JSON_ROOT_NAME};

const PARAGRAPH_END: char = '\n';
const SOFT_BREAK: char = '\u{2028}';
/// Values written whole rather than as nested maps.
const ATOMIC_KEYS: [&str; 5] = ["frame", "crop", "from", "to", "size"];
const PARAGRAPH_KEYS: [&str; 4] = ["pid", "pstyle", "pend", "pempty"];

/// True for a `DeckRichText` value: an object whose only key is `paragraphs`.
pub fn is_rich_text(value: &Value) -> bool {
    matches!(value, Value::Object(map)
        if map.len() == 1 && map.get("paragraphs").is_some_and(Value::is_array))
}

/* ------------------------------------------------------------------------- */
/* JSON -> live                                                               */
/* ------------------------------------------------------------------------- */

/// Writes a whole deck into the (cleared) root map.
pub(crate) fn write_deck(doc: &Doc, content: &str, clear: bool) -> Result<(), LiveError> {
    let Ok(Value::Object(object)) = serde_json::from_str::<Value>(content) else {
        return Err(LiveError::InvalidStructuredContent);
    };
    let root = doc.get_or_insert_map(JSON_ROOT_NAME);
    let mut txn = doc.transact_mut();
    if clear {
        root.clear(&mut txn);
    }
    for (key, value) in &object {
        insert_into_map(&mut txn, &root, key, value);
    }
    Ok(())
}

fn insert_into_map(txn: &mut TransactionMut, map: &MapRef, key: &str, value: &Value) {
    if ATOMIC_KEYS.contains(&key) {
        map.insert(txn, key, json_to_any(value));
        return;
    }
    match value {
        Value::Object(_) if is_rich_text(value) => {
            let text: TextRef = map.insert(txn, key, TextPrelim::new(""));
            write_rich_text(txn, &text, value);
        }
        Value::Object(object) => {
            let child: MapRef = map.insert(txn, key, MapPrelim::default());
            for (child_key, child_value) in object {
                insert_into_map(txn, &child, child_key, child_value);
            }
        }
        Value::Array(items) => {
            let child: ArrayRef = map.insert(txn, key, ArrayPrelim::default());
            for item in items {
                push_into_array(txn, &child, item);
            }
        }
        _ => {
            map.insert(txn, key, json_to_any(value));
        }
    }
}

fn push_into_array(txn: &mut TransactionMut, array: &ArrayRef, value: &Value) {
    match value {
        Value::Object(_) if is_rich_text(value) => {
            let text: TextRef = array.push_back(txn, TextPrelim::new(""));
            write_rich_text(txn, &text, value);
        }
        Value::Object(object) => {
            let child: MapRef = array.push_back(txn, MapPrelim::default());
            for (key, child_value) in object {
                insert_into_map(txn, &child, key, child_value);
            }
        }
        Value::Array(items) => {
            let child: ArrayRef = array.push_back(txn, ArrayPrelim::default());
            for item in items {
                push_into_array(txn, &child, item);
            }
        }
        _ => {
            array.push_back(txn, json_to_any(value));
        }
    }
}

fn json_to_any(value: &Value) -> Any {
    match value {
        Value::Null => Any::Null,
        Value::Bool(value) => Any::Bool(*value),
        Value::Number(number) => Any::Number(number.as_f64().unwrap_or(0.0)),
        Value::String(text) => Any::String(text.as_str().into()),
        Value::Array(items) => Any::Array(items.iter().map(json_to_any).collect::<Vec<_>>().into()),
        Value::Object(map) => Any::Map(Arc::new(
            map.iter()
                .map(|(key, value)| (key.clone(), json_to_any(value)))
                .collect::<HashMap<_, _>>(),
        )),
    }
}

/// Canonical JSON (sorted keys), so equal styles produce equal attribute strings.
fn canonical(value: &Value) -> String {
    fn sort(value: &Value) -> Value {
        match value {
            Value::Object(map) => Value::Object(
                map.iter()
                    .map(|(key, value)| (key.clone(), sort(value)))
                    .collect::<BTreeMap<_, _>>()
                    .into_iter()
                    .collect(),
            ),
            Value::Array(items) => Value::Array(items.iter().map(sort).collect()),
            other => other.clone(),
        }
    }
    serde_json::to_string(&sort(value)).unwrap_or_default()
}

fn run_attributes(style: Option<&Value>, link: Option<&Value>) -> HashMap<Arc<str>, Any> {
    let mut attrs: HashMap<Arc<str>, Any> = HashMap::new();
    if let Some(Value::Object(style)) = style {
        for (flag, key) in [
            ("bold", "b"),
            ("italic", "i"),
            ("underline", "u"),
            ("strike", "s"),
        ] {
            if style.get(flag).and_then(Value::as_bool) == Some(true) {
                attrs.insert(key.into(), Any::Bool(true));
            }
        }
        if let Some(size) = style.get("size").and_then(Value::as_f64) {
            attrs.insert("sz".into(), Any::Number(size));
        }
        match style.get("font") {
            Some(Value::String(font)) => {
                attrs.insert("font".into(), Any::String(font.as_str().into()));
            }
            Some(Value::Object(font)) => {
                if let Some(theme) = font.get("theme").and_then(Value::as_str) {
                    attrs.insert("font".into(), Any::String(format!("theme:{theme}").into()));
                }
            }
            _ => {}
        }
        if let Some(color @ Value::Object(_)) = style.get("color") {
            attrs.insert("color".into(), Any::String(canonical(color).into()));
        }
        if let Some(Value::String(baseline)) = style.get("baseline") {
            attrs.insert("base".into(), Any::String(baseline.as_str().into()));
        }
        if let Some(Value::String(lang)) = style.get("lang") {
            attrs.insert("lang".into(), Any::String(lang.as_str().into()));
        }
    }
    if let Some(link @ Value::Object(_)) = link {
        attrs.insert("link".into(), Any::String(canonical(link).into()));
    }
    attrs
}

fn write_rich_text(txn: &mut TransactionMut, text: &TextRef, value: &Value) {
    let paragraphs = value
        .get("paragraphs")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    for paragraph in &paragraphs {
        for run in paragraph
            .get("runs")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            let is_break = run.get("kind").and_then(Value::as_str) == Some("break");
            let content = if is_break {
                SOFT_BREAK.to_string()
            } else {
                run.get("text")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .replace([PARAGRAPH_END, SOFT_BREAK], " ")
            };
            if content.is_empty() {
                continue;
            }
            let attrs = run_attributes(
                run.get("style"),
                if is_break { None } else { run.get("link") },
            );
            let index = text.len(txn);
            text.insert_with_attributes(txn, index, &content, attrs);
        }
        let mut attrs: HashMap<Arc<str>, Any> = HashMap::new();
        let id = paragraph.get("id").and_then(Value::as_str).unwrap_or("p");
        attrs.insert("pid".into(), Any::String(id.into()));
        for (field, key) in [("style", "pstyle"), ("endStyle", "pend")] {
            if let Some(style @ Value::Object(map)) = paragraph.get(field) {
                if !map.is_empty() {
                    attrs.insert(key.into(), Any::String(canonical(style).into()));
                }
            }
        }
        // Empty runs carry no characters, yet a placeholder's empty run is where
        // its colour and font come from: they ride on the paragraph end.
        let empty: Vec<Value> = paragraph
            .get("runs")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .enumerate()
            .filter(|(_, run)| {
                run.get("kind").and_then(Value::as_str) == Some("text")
                    && run.get("text").and_then(Value::as_str) == Some("")
            })
            .map(|(index, run)| serde_json::json!([index, run]))
            .collect();
        if !empty.is_empty() {
            attrs.insert(
                "pempty".into(),
                Any::String(canonical(&Value::Array(empty)).into()),
            );
        }
        let index = text.len(txn);
        text.insert_with_attributes(txn, index, &PARAGRAPH_END.to_string(), attrs);
    }
}

/* ------------------------------------------------------------------------- */
/* live -> JSON                                                               */
/* ------------------------------------------------------------------------- */

/// Integral numbers become JSON integers; everything else maps directly.
fn any_to_json(value: &Any) -> Value {
    match value {
        Any::Null | Any::Undefined => Value::Null,
        Any::Bool(value) => Value::Bool(*value),
        Any::Number(number) => number_to_json(*number),
        Any::BigInt(number) => Value::Number((*number).into()),
        Any::String(text) => Value::String(text.to_string()),
        Any::Buffer(_) => Value::Null,
        Any::Array(items) => Value::Array(items.iter().map(any_to_json).collect()),
        Any::Map(map) => Value::Object(
            map.iter()
                .map(|(key, value)| (key.clone(), any_to_json(value)))
                .collect(),
        ),
    }
}

fn number_to_json(number: f64) -> Value {
    if number.is_finite() && number.fract() == 0.0 && number.abs() <= 9.0e15 {
        Value::Number((number as i64).into())
    } else {
        Number::from_f64(number).map_or(Value::Null, Value::Number)
    }
}

fn out_to_json<T: ReadTxn>(txn: &T, value: Out) -> Value {
    match value {
        Out::Any(any) => any_to_json(&any),
        Out::YMap(map) => {
            let mut object = Map::new();
            for (key, child) in map.iter(txn) {
                object.insert(key.to_string(), out_to_json(txn, child));
            }
            Value::Object(object)
        }
        Out::YArray(array) => Value::Array(
            array
                .iter(txn)
                .map(|child| out_to_json(txn, child))
                .collect(),
        ),
        Out::YText(text) => read_rich_text(txn, &text),
        _ => Value::Null,
    }
}

type Attrs = HashMap<Arc<str>, Any>;

fn attr_string<'a>(attrs: Option<&'a Attrs>, key: &str) -> Option<&'a str> {
    match attrs?.get(key)? {
        Any::String(text) => Some(text),
        _ => None,
    }
}

fn parse_json_attr(attrs: Option<&Attrs>, key: &str) -> Option<Value> {
    let parsed: Value = serde_json::from_str(attr_string(attrs, key)?).ok()?;
    Some(normalize_numbers(parsed))
}

fn normalize_numbers(value: Value) -> Value {
    match value {
        Value::Number(number) => number
            .as_f64()
            .filter(|_| !number.is_i64() && !number.is_u64())
            .map_or(Value::Number(number), number_to_json),
        Value::Array(items) => Value::Array(items.into_iter().map(normalize_numbers).collect()),
        Value::Object(map) => Value::Object(
            map.into_iter()
                .map(|(key, value)| (key, normalize_numbers(value)))
                .collect(),
        ),
        other => other,
    }
}

fn run_style(attrs: Option<&Attrs>) -> Map<String, Value> {
    let mut style = Map::new();
    let flag = |key: &str| {
        matches!(
            attrs.and_then(|attrs| attrs.get(key)),
            Some(Any::Bool(true))
        )
    };
    for (key, field) in [
        ("b", "bold"),
        ("i", "italic"),
        ("u", "underline"),
        ("s", "strike"),
    ] {
        if flag(key) {
            style.insert(field.into(), Value::Bool(true));
        }
    }
    match attrs.and_then(|attrs| attrs.get("sz")) {
        Some(Any::Number(size)) => {
            style.insert("size".into(), number_to_json(*size));
        }
        Some(Any::BigInt(size)) => {
            style.insert("size".into(), Value::Number((*size).into()));
        }
        _ => {}
    }
    if let Some(font) = attr_string(attrs, "font") {
        let value = match font.strip_prefix("theme:") {
            Some(theme) => serde_json::json!({
                "theme": if theme == "heading" { "heading" } else { "body" }
            }),
            None => Value::String(font.to_string()),
        };
        style.insert("font".into(), value);
    }
    if let Some(color) = parse_json_attr(attrs, "color") {
        style.insert("color".into(), color);
    }
    if let Some(base) = attr_string(attrs, "base") {
        if base == "superscript" || base == "subscript" {
            style.insert("baseline".into(), Value::String(base.into()));
        }
    }
    if let Some(lang) = attr_string(attrs, "lang") {
        style.insert("lang".into(), Value::String(lang.into()));
    }
    style
}

/// Reads one `Y.Text` back into `DeckRichText`, as `readRichText` does:
/// adjacent runs with equal formatting merge, paragraph ids stay unique, and
/// text after the last paragraph end becomes a final paragraph.
fn read_rich_text<T: ReadTxn>(txn: &T, text: &TextRef) -> Value {
    let mut paragraphs: Vec<Value> = Vec::new();
    let mut runs: Vec<Value> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();

    let mut end_paragraph = |runs: &mut Vec<Value>,
                             paragraphs: &mut Vec<Value>,
                             attrs: Option<&Attrs>| {
        let mut id = attr_string(attrs, "pid")
            .map(str::to_string)
            .unwrap_or_else(|| format!("p-{}", paragraphs.len()));
        while seen.contains(&id) {
            id = format!("{id}-{}", paragraphs.len());
        }
        seen.insert(id.clone());
        let mut paragraph = Map::new();
        paragraph.insert("id".into(), Value::String(id));
        if let Some(style) = parse_json_attr(attrs, "pstyle") {
            paragraph.insert("style".into(), style);
        }
        let mut paragraph_runs = std::mem::take(runs);
        if let Some(Value::Array(empty)) = parse_json_attr(attrs, "pempty") {
            for entry in empty {
                let (Some(index), Some(run)) = (entry.get(0).and_then(Value::as_u64), entry.get(1))
                else {
                    continue;
                };
                let at = (index as usize).min(paragraph_runs.len());
                paragraph_runs.insert(at, run.clone());
            }
        }
        paragraph.insert("runs".into(), Value::Array(paragraph_runs));
        if let Some(style) = parse_json_attr(attrs, "pend") {
            paragraph.insert("endStyle".into(), style);
        }
        paragraphs.push(Value::Object(paragraph));
    };

    let push_text = |runs: &mut Vec<Value>, piece: &str, attrs: Option<&Attrs>| {
        let style = run_style(attrs);
        let link = parse_json_attr(attrs, "link");
        if let Some(Value::Object(previous)) = runs.last_mut() {
            let same = previous.get("kind").and_then(Value::as_str) == Some("text")
                && previous
                    .get("style")
                    .and_then(Value::as_object)
                    .cloned()
                    .unwrap_or_default()
                    == style
                && previous.get("link") == link.as_ref();
            if same {
                if let Some(Value::String(existing)) = previous.get_mut("text") {
                    existing.push_str(piece);
                    return;
                }
            }
        }
        let mut run = Map::new();
        run.insert("kind".into(), Value::String("text".into()));
        run.insert("text".into(), Value::String(piece.into()));
        if !style.is_empty() {
            run.insert("style".into(), Value::Object(style));
        }
        if let Some(link) = link {
            run.insert("link".into(), link);
        }
        runs.push(Value::Object(run));
    };

    for chunk in text.diff(txn, YChange::identity) {
        let Out::Any(Any::String(content)) = chunk.insert else {
            continue;
        };
        let attrs = chunk.attributes.as_deref();
        let run_attrs: Option<Attrs> = attrs.map(|attrs| {
            attrs
                .iter()
                .filter(|(key, value)| {
                    !PARAGRAPH_KEYS.contains(&key.as_ref()) && !matches!(value, Any::Null)
                })
                .map(|(key, value)| (key.clone(), value.clone()))
                .collect()
        });
        let parts: Vec<&str> = content.split(PARAGRAPH_END).collect();
        for (index, part) in parts.iter().enumerate() {
            for (piece_index, piece) in part.split(SOFT_BREAK).enumerate() {
                if piece_index > 0 {
                    let mut run = Map::new();
                    run.insert("kind".into(), Value::String("break".into()));
                    let style = run_style(run_attrs.as_ref());
                    if !style.is_empty() {
                        run.insert("style".into(), Value::Object(style));
                    }
                    runs.push(Value::Object(run));
                }
                if !piece.is_empty() {
                    push_text(&mut runs, piece, run_attrs.as_ref());
                }
            }
            if index + 1 < parts.len() {
                end_paragraph(&mut runs, &mut paragraphs, attrs);
            }
        }
    }
    if !runs.is_empty() {
        end_paragraph(&mut runs, &mut paragraphs, None);
    }
    serde_json::json!({ "paragraphs": paragraphs })
}

/// The live deck as `.deck` JSON, structurally repaired; `None` when empty.
pub(crate) fn read_deck(doc: &Doc) -> Option<String> {
    let root = doc.get_or_insert_map(JSON_ROOT_NAME);
    let txn = doc.transact();
    if root.len(&txn) == 0 {
        return None;
    }
    let mut value = out_to_json(&txn, Out::YMap(root));
    if let Value::Object(deck) = &mut value {
        repair_structure(deck);
    }
    serde_json::to_string(&value).ok()
}

/* ------------------------------------------------------------------------- */
/* Structural repair                                                          */
/* ------------------------------------------------------------------------- */

fn string_ids(value: Option<&Value>) -> Vec<String> {
    value
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|entry| entry.as_str().map(str::to_string))
        .collect()
}

/// Drops dangling, duplicate, and grouped order entries and shared or missing
/// group children; appends unordered top-level elements (in id order).
fn repair_container(container: &mut Map<String, Value>) {
    let Some(Value::Object(elements)) = container.get_mut("elements") else {
        return;
    };
    let ids: HashSet<String> = elements.keys().cloned().collect();
    let mut grouped: HashSet<String> = HashSet::new();
    let mut group_ids: Vec<String> = elements
        .iter()
        .filter(|(_, element)| element.get("type").and_then(Value::as_str) == Some("group"))
        .map(|(id, _)| id.clone())
        .collect();
    group_ids.sort();
    for group_id in group_ids {
        let Some(Value::Object(group)) = elements.get_mut(&group_id) else {
            continue;
        };
        let kept: Vec<Value> = string_ids(group.get("childIds"))
            .into_iter()
            .filter(|child| {
                ids.contains(child) && *child != group_id && grouped.insert(child.clone())
            })
            .map(Value::String)
            .collect();
        group.insert("childIds".into(), Value::Array(kept));
    }
    let mut order: Vec<String> = Vec::new();
    let mut ordered: HashSet<String> = HashSet::new();
    for id in string_ids(container.get("elementOrder")) {
        if ids.contains(&id) && !grouped.contains(&id) && ordered.insert(id.clone()) {
            order.push(id);
        }
    }
    let mut missing: Vec<&String> = ids
        .iter()
        .filter(|id| !ordered.contains(*id) && !grouped.contains(*id))
        .collect();
    missing.sort();
    order.extend(missing.into_iter().cloned());
    container.insert(
        "elementOrder".into(),
        Value::Array(order.into_iter().map(Value::String).collect()),
    );
}

fn repair_structure(deck: &mut Map<String, Value>) {
    let layout_ids: HashSet<String> = deck
        .get("layouts")
        .and_then(Value::as_object)
        .map(|layouts| layouts.keys().cloned().collect())
        .unwrap_or_default();
    for field in ["masters", "layouts", "slides"] {
        if let Some(Value::Object(containers)) = deck.get_mut(field) {
            for container in containers.values_mut() {
                if let Value::Object(container) = container {
                    if field == "slides" {
                        let layout = container.get("layoutId").and_then(Value::as_str);
                        if layout.is_some_and(|layout| !layout_ids.contains(layout)) {
                            container.remove("layoutId");
                        }
                    }
                    repair_container(container);
                }
            }
        }
    }
    let slide_ids: HashSet<String> = deck
        .get("slides")
        .and_then(Value::as_object)
        .map(|slides| slides.keys().cloned().collect())
        .unwrap_or_default();
    let mut order: Vec<String> = Vec::new();
    let mut ordered: HashSet<String> = HashSet::new();
    for id in string_ids(deck.get("slideOrder")) {
        if slide_ids.contains(&id) && ordered.insert(id.clone()) {
            order.push(id);
        }
    }
    let mut missing: Vec<&String> = slide_ids
        .iter()
        .filter(|id| !ordered.contains(*id))
        .collect();
    missing.sort();
    order.extend(missing.into_iter().cloned());
    deck.insert(
        "slideOrder".into(),
        Value::Array(order.into_iter().map(Value::String).collect()),
    );
    if let Some(Value::Array(sections)) = deck.get_mut("sections") {
        sections.retain(|section| {
            section
                .get("firstSlideId")
                .and_then(Value::as_str)
                .is_some_and(|id| slide_ids.contains(id))
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        apply_update, compact_state, materialization_decision, materialized_content, seed_document,
        state_vector, LiveDocumentKind, LiveLimits, MaterializationDecision,
    };
    use yrs::{updates::decoder::Decode, ReadTxn, Update};

    const FIXTURE: &str = include_str!("../../collab-documents/fixtures/deck-fixture.deck");
    const CLIENT_UPDATE: &[u8] = include_bytes!("../fixtures/deck-live-client.bin");

    /// The fixture exactly: the live form loses nothing.
    fn canonical_fixture() -> Value {
        serde_json::from_str(FIXTURE).unwrap()
    }

    fn seeded(client: u64) -> Doc {
        let doc = Doc::with_client_id(client);
        seed_document(&doc, LiveDocumentKind::Deck, FIXTURE).unwrap();
        doc
    }

    fn fork(source: &Doc, client: u64) -> Doc {
        let doc = Doc::with_client_id(client);
        apply_update(&doc, &compact_state(source), LiveLimits::default()).unwrap();
        doc
    }

    fn sync(a: &Doc, b: &Doc) {
        let to_b = crate::diff(a, &state_vector(b), LiveLimits::default()).unwrap();
        let to_a = crate::diff(b, &state_vector(a), LiveLimits::default()).unwrap();
        apply_update(b, &to_b, LiveLimits::default()).unwrap();
        apply_update(a, &to_a, LiveLimits::default()).unwrap();
    }

    fn materialize(doc: &Doc) -> Value {
        let content = materialized_content(doc, LiveDocumentKind::Deck).expect("content");
        assert_eq!(
            materialization_decision(LiveDocumentKind::Deck, None, Some(&content)),
            MaterializationDecision::Ready,
            "materialized deck must validate"
        );
        serde_json::from_str(&content).unwrap()
    }

    /// `get_or_insert_map` waits for an open transaction, so tests take the
    /// root before opening one and walk from it.
    fn map_at(root: &MapRef, txn: &impl ReadTxn, path: &[&str]) -> MapRef {
        let mut current = root.clone();
        for key in path {
            current = match current.get(txn, key) {
                Some(Out::YMap(map)) => map,
                other => panic!("no map at {key}: {other:?}"),
            };
        }
        current
    }

    fn text_at(doc: &Doc, path: &[&str], key: &str) -> TextRef {
        let root = doc.get_or_insert_map(JSON_ROOT_NAME);
        let txn = doc.transact();
        match map_at(&root, &txn, path).get(&txn, key) {
            Some(Out::YText(text)) => text,
            other => panic!("no text at {key}: {other:?}"),
        }
    }

    #[test]
    fn the_fixture_round_trips_through_the_live_form() {
        let doc = seeded(1);
        assert_eq!(materialize(&doc), canonical_fixture());
        // Rich text is a Y.Text; geometry is one atomic value.
        let element = ["slides", "slide-3", "elements", "s3-card"];
        text_at(
            &doc,
            &["slides", "slide-2", "elements", "s2-body", "text"],
            "content",
        );
        let root = doc.get_or_insert_map(JSON_ROOT_NAME);
        let txn = doc.transact();
        let body = map_at(&root, &txn, &element);
        assert!(matches!(
            body.get(&txn, "frame"),
            Some(Out::Any(Any::Map(_)))
        ));
    }

    #[test]
    fn the_desktop_encoding_materializes_to_the_same_deck() {
        // Written by `liveDeckDocument.test.ts` from the shared fixture with the
        // desktop codec; regenerate with COLLAB_LIVE_FIXTURE_WRITE=1 there.
        let doc = Doc::with_client_id(9);
        apply_update(&doc, CLIENT_UPDATE, LiveLimits::default()).unwrap();
        assert_eq!(materialize(&doc), canonical_fixture());
    }

    #[test]
    fn the_server_seed_is_checked_in_for_the_desktop_tests() {
        // `liveDeckDocument.test.ts` decodes this with the desktop codec.
        // Regenerate with COLLAB_UPDATE_FIXTURES=1 cargo test -p collab-live.
        let path = concat!(env!("CARGO_MANIFEST_DIR"), "/fixtures/deck-live-server.bin");
        if std::env::var_os("COLLAB_UPDATE_FIXTURES").is_some() {
            std::fs::write(path, compact_state(&seeded(5))).unwrap();
        }
        let doc = Doc::with_client_id(9);
        apply_update(&doc, &std::fs::read(path).unwrap(), LiveLimits::default()).unwrap();
        assert_eq!(materialize(&doc), canonical_fixture());
    }

    #[test]
    fn concurrent_slides_objects_and_text_merge() {
        let base = seeded(1);
        let a = fork(&base, 2);
        let b = fork(&base, 3);
        {
            // A moves an element on slide 3 and types at the start of a body.
            let root = a.get_or_insert_map(JSON_ROOT_NAME);
            let mut txn = a.transact_mut();
            let shape = map_at(&root, &txn, &["slides", "slide-3", "elements", "s3-card"]);
            let mut frame = match shape.get(&txn, "frame") {
                Some(Out::Any(Any::Map(frame))) => (*frame).clone(),
                other => panic!("frame: {other:?}"),
            };
            frame.insert("x".into(), Any::Number(1234.0));
            shape.insert(&mut txn, "frame", Any::Map(Arc::new(frame)));
        }
        let body_a = text_at(
            &a,
            &["slides", "slide-2", "elements", "s2-body", "text"],
            "content",
        );
        body_a.insert(&mut a.transact_mut(), 0, "Alpha ");
        // B edits another slide and types at the end of the same body.
        let body_b = text_at(
            &b,
            &["slides", "slide-2", "elements", "s2-body", "text"],
            "content",
        );
        {
            let root = b.get_or_insert_map(JSON_ROOT_NAME);
            let mut txn = b.transact_mut();
            let len = body_b.len(&txn);
            // Before the final paragraph end, inside the last paragraph.
            body_b.insert(&mut txn, len - 1, " Omega");
            let slide = map_at(&root, &txn, &["slides", "slide-4"]);
            slide.insert(&mut txn, "hidden", true);
        }
        sync(&a, &b);
        let merged_a = materialize(&a);
        assert_eq!(merged_a, materialize(&b));
        assert_eq!(
            merged_a["slides"]["slide-3"]["elements"]["s3-card"]["frame"]["x"],
            1234
        );
        assert_eq!(merged_a["slides"]["slide-4"]["hidden"], true);
        let text =
            serde_json::to_string(&merged_a["slides"]["slide-2"]["elements"]["s2-body"]).unwrap();
        assert!(text.contains("Alpha "), "{text}");
        assert!(text.contains(" Omega"), "{text}");
    }

    #[test]
    fn concurrent_moves_and_deletes_repair_to_a_valid_deck() {
        let base = seeded(1);
        let a = fork(&base, 2);
        let b = fork(&base, 3);
        let move_to_front = |doc: &Doc, path: &[&str], key: &str, id: &str| {
            let root = doc.get_or_insert_map(JSON_ROOT_NAME);
            let mut txn = doc.transact_mut();
            let array = match map_at(&root, &txn, path).get(&txn, key) {
                Some(Out::YArray(array)) => array,
                other => panic!("{other:?}"),
            };
            let index = array
                .iter(&txn)
                .position(|entry| matches!(entry, Out::Any(Any::String(ref s)) if s.as_ref() == id))
                .unwrap() as u32;
            array.remove(&mut txn, index);
            array.insert(&mut txn, 0, id);
        };
        // Both move slide 5 to the front at once: it is now ordered twice.
        move_to_front(&a, &[], "slideOrder", "slide-5");
        move_to_front(&b, &[], "slideOrder", "slide-5");
        // A deletes an element that B moves to the back of the paint order.
        {
            let root = a.get_or_insert_map(JSON_ROOT_NAME);
            let mut txn = a.transact_mut();
            let elements = map_at(&root, &txn, &["slides", "slide-3", "elements"]);
            elements.remove(&mut txn, "s3-card");
            let slide = map_at(&root, &txn, &["slides", "slide-3"]);
            let Some(Out::YArray(order)) = slide.get(&txn, "elementOrder") else {
                panic!()
            };
            let index = order
                .iter(&txn)
                .position(|entry| matches!(entry, Out::Any(Any::String(ref s)) if s.as_ref() == "s3-card"))
                .unwrap() as u32;
            order.remove(&mut txn, index);
        }
        move_to_front(&b, &["slides", "slide-3"], "elementOrder", "s3-card");
        sync(&a, &b);

        let raw: Value = {
            let root = a.get_or_insert_map(JSON_ROOT_NAME);
            let txn = a.transact();
            out_to_json(&txn, Out::YMap(root))
        };
        let raw_order = string_ids(raw.get("slideOrder"));
        assert_eq!(raw_order.iter().filter(|id| *id == "slide-5").count(), 2);

        let deck = materialize(&a);
        let order = string_ids(deck.get("slideOrder"));
        assert_eq!(order[0], "slide-5");
        assert_eq!(order.iter().filter(|id| *id == "slide-5").count(), 1);
        assert_eq!(order.len(), 5);
        // Delete wins: the element and its order entry are gone.
        let slide = &deck["slides"]["slide-3"];
        assert!(slide["elements"].get("s3-card").is_none());
        assert!(!string_ids(slide.get("elementOrder")).contains(&"s3-card".to_string()));
    }

    #[test]
    fn replacing_from_a_rest_revision_keeps_the_room_valid() {
        let doc = seeded(1);
        let mut edited: Value = serde_json::from_str(FIXTURE).unwrap();
        edited["name"] = Value::String("Renamed".into());
        let update =
            crate::replace_document(&doc, LiveDocumentKind::Deck, &edited.to_string()).unwrap();
        assert!(!update.is_empty());
        assert_eq!(materialize(&doc)["name"], "Renamed");
        // The update alone brings a peer that had the old state up to date.
        let peer = Doc::with_client_id(2);
        apply_update(&peer, &compact_state(&seeded(1)), LiveLimits::default()).unwrap();
        Update::decode_v1(&update).unwrap();
    }

    #[test]
    fn integral_numbers_materialize_as_integers() {
        let doc = seeded(1);
        let content = materialized_content(&doc, LiveDocumentKind::Deck).unwrap();
        assert!(
            content.contains("\"schemaVersion\":1"),
            "{}",
            &content[..200]
        );
        assert!(!content.contains(".0,"));
    }
}
