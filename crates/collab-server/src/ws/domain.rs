use yrs::{
    types::ToJson, updates::decoder::Decode, Any, ArrayPrelim, Doc, In, Map, MapPrelim, Transact,
    Update,
};

const JSON_ROOT_NAME: &str = "doc";

#[derive(Debug, Clone, PartialEq, Eq)]
struct TextEditHunk {
    base_start: usize,
    base_end: usize,
    replacement: Vec<String>,
}

fn split_text_preserving_newlines(content: &str) -> Vec<String> {
    content
        .split_inclusive('\n')
        .map(|part| part.to_string())
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
    let mut active_start: Option<usize> = None;
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

    if let Some(start) = active_start.take() {
        hunks.push(TextEditHunk {
            base_start: start,
            base_end: active_end,
            replacement,
        });
    }

    hunks
}

pub(super) fn try_auto_merge_text(base: &str, ours: &str, theirs: &str) -> Option<String> {
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
            (Some(our_hunk), Some(their_hunk)) => {
                if our_hunk.base_end <= their_hunk.base_start {
                    merged_hunks.push(our_hunk.clone());
                    our_index += 1;
                } else if their_hunk.base_end <= our_hunk.base_start {
                    merged_hunks.push(their_hunk.clone());
                    their_index += 1;
                } else if our_hunk == their_hunk {
                    merged_hunks.push(our_hunk.clone());
                    our_index += 1;
                    their_index += 1;
                } else {
                    return None;
                }
            }
            (Some(our_hunk), None) => {
                merged_hunks.push(our_hunk.clone());
                our_index += 1;
            }
            (None, Some(their_hunk)) => {
                merged_hunks.push(their_hunk.clone());
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

fn json_to_in(value: &serde_json::Value) -> In {
    match value {
        serde_json::Value::Null => In::Any(Any::Null),
        serde_json::Value::Bool(value) => In::Any(Any::Bool(*value)),
        serde_json::Value::Number(value) => {
            // JSON numbers must remain JavaScript numbers, not Yjs BigInts.
            In::Any(Any::Number(value.as_f64().unwrap_or(0.0)))
        }
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

pub(super) fn replace_structured_doc(doc: &Doc, content: &str) -> bool {
    let Ok(serde_json::Value::Object(map)) = serde_json::from_str::<serde_json::Value>(content)
    else {
        return false;
    };
    let root = doc.get_or_insert_map(JSON_ROOT_NAME);
    let mut txn = doc.transact_mut();
    root.clear(&mut txn);
    for (key, value) in map {
        root.insert(&mut txn, key, json_to_in(&value));
    }
    true
}

pub(super) fn seed_structured_doc(doc: &Doc, content: &str) {
    let Ok(serde_json::Value::Object(map)) = serde_json::from_str::<serde_json::Value>(content)
    else {
        return;
    };
    let root = doc.get_or_insert_map(JSON_ROOT_NAME);
    let mut txn = doc.transact_mut();
    for (key, value) in map {
        root.insert(&mut txn, key, json_to_in(&value));
    }
}

pub(super) fn doc_json_content(doc: &Doc) -> Option<String> {
    let root = doc.get_or_insert_map(JSON_ROOT_NAME);
    let txn = doc.transact();
    if root.len(&txn) == 0 {
        return None;
    }
    serde_json::to_string(&root.to_json(&txn)).ok()
}

pub(super) fn canvas_node_count(content: &str) -> Option<usize> {
    let value = serde_json::from_str::<serde_json::Value>(content).ok()?;
    value.get("nodes")?.as_array().map(Vec::len)
}

pub(super) fn apply_update_bytes(doc: &Doc, bytes: &[u8]) {
    let Ok(update) = Update::decode_v1(bytes) else {
        return;
    };
    let mut txn = doc.transact_mut();
    let _ = txn.apply_update(update);
}

#[cfg(test)]
mod tests {
    use super::*;
    use yrs::{GetString, Text};

    #[test]
    fn text_merge_preserves_independent_line_edits_and_rejects_overlap() {
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

    #[test]
    fn structured_round_trip_keeps_json_numbers_and_nested_values() {
        let doc = Doc::new();
        seed_structured_doc(
            &doc,
            r#"{"count":2,"nested":{"enabled":true},"items":["a",3]}"#,
        );
        let value: serde_json::Value =
            serde_json::from_str(&doc_json_content(&doc).expect("document should serialize"))
                .expect("serialized document should be JSON");
        assert_eq!(value["count"], 2.0);
        assert_eq!(value["nested"]["enabled"], true);
        assert_eq!(value["items"][1], 3.0);
    }

    #[test]
    fn invalid_updates_do_not_modify_document_state() {
        let doc = Doc::new();
        let text = doc.get_or_insert_text("content");
        {
            let mut txn = doc.transact_mut();
            text.insert(&mut txn, 0, "stable");
        }
        apply_update_bytes(&doc, b"not-a-yjs-update");
        assert_eq!(text.get_string(&doc.transact()), "stable");
    }
}
