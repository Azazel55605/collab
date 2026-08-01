use serde::Serialize;

const AGENDA_SCHEMA_VERSION: u32 = 1;
const MAX_DATE_LABEL_BYTES: usize = 32;
const MAX_SNAPSHOT_BYTES: usize = 16_384;

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct AgendaPreviewItem<'a> {
    title: &'a str,
    detail: &'a str,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct AgendaPreviewSnapshot<'a> {
    schema_version: u32,
    date_label: &'a str,
    state_label: &'a str,
    items: [AgendaPreviewItem<'a>; 3],
}

/// Builds the deliberately non-private Phase 0 payload used to prove the
/// Rust-to-JNI publication path. Phase 1 replaces these preview rows with
/// profile-scoped calendar selection while preserving this bounded envelope.
pub(crate) fn build_phase0_agenda_preview(date_label: &str) -> Result<String, String> {
    let date_label = date_label.trim();
    if date_label.is_empty()
        || date_label.len() > MAX_DATE_LABEL_BYTES
        || date_label.chars().any(char::is_control)
    {
        return Err("The agenda widget date label is invalid.".to_string());
    }
    let snapshot = AgendaPreviewSnapshot {
        schema_version: AGENDA_SCHEMA_VERSION,
        date_label,
        state_label: "Phase 0 native preview",
        items: [
            AgendaPreviewItem {
                title: "Design review",
                detail: "09:30 · Event",
            },
            AgendaPreviewItem {
                title: "Project follow-up",
                detail: "Today · Task",
            },
            AgendaPreviewItem {
                title: "Team planning",
                detail: "Tomorrow · Event",
            },
        ],
    };
    let encoded = serde_json::to_string(&snapshot)
        .map_err(|error| format!("Could not encode the agenda widget preview: {error}"))?;
    if encoded.len() > MAX_SNAPSHOT_BYTES {
        return Err("The agenda widget preview exceeded its size limit.".to_string());
    }
    Ok(encoded)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn phase0_preview_is_versioned_bounded_and_content_safe() {
        let encoded = build_phase0_agenda_preview("2026-08-01").unwrap();
        assert!(encoded.len() <= MAX_SNAPSHOT_BYTES);
        assert!(!encoded.contains("http"));
        assert!(!encoded.to_lowercase().contains("token"));
        let value: serde_json::Value = serde_json::from_str(&encoded).unwrap();
        assert_eq!(value["schemaVersion"], AGENDA_SCHEMA_VERSION);
        assert_eq!(value["dateLabel"], "2026-08-01");
        assert_eq!(value["items"].as_array().unwrap().len(), 3);
    }

    #[test]
    fn phase0_preview_rejects_unbounded_or_control_text() {
        assert!(build_phase0_agenda_preview("").is_err());
        assert!(build_phase0_agenda_preview("today\nprivate").is_err());
        assert!(build_phase0_agenda_preview(&"x".repeat(MAX_DATE_LABEL_BYTES + 1)).is_err());
    }
}
