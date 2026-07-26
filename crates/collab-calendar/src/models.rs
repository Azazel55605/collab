use serde::{Deserialize, Serialize};

pub const CALENDAR_SCHEMA_VERSION: u32 = 1;
pub const MAX_ICALENDAR_PROPERTIES: usize = 64;
pub const MAX_ICALENDAR_PROPERTY_LENGTH: usize = 16_384;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum CalendarLocation {
    Local {
        profile_id: String,
    },
    Hosted {
        server_url: String,
        user_id: String,
    },
    Subscription {
        subscription_id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        server_url: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        user_id: Option<String>,
    },
    Kanban {
        origin_key: String,
    },
}

impl CalendarLocation {
    pub fn is_inherently_read_only(&self) -> bool {
        matches!(self, Self::Subscription { .. } | Self::Kanban { .. })
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CalendarDefinition {
    #[serde(default = "calendar_schema_version")]
    pub schema_version: u32,
    pub id: String,
    pub global_id: String,
    pub location: CalendarLocation,
    pub name: String,
    pub color: String,
    pub default_time_zone: String,
    #[serde(default)]
    pub archived: bool,
    #[serde(default)]
    pub read_only: bool,
    pub revision: i64,
    pub created_at: String,
    pub updated_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub deleted_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CalendarSubscription {
    pub id: String,
    pub calendar_id: String,
    pub feed_url: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub etag: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_modified: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_refreshed_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_error: Option<String>,
    pub created_at: String,
    pub updated_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub server_url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub user_id: Option<String>,
}

fn calendar_schema_version() -> u32 {
    CALENDAR_SCHEMA_VERSION
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum CalendarTimeValue {
    Date {
        date: String,
    },
    DateTime {
        date_time: String,
        time_zone: String,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum CalendarReminder {
    Relative { minutes_before: i64 },
    Absolute { at: String },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CalendarRecurrence {
    pub rrule: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub rdates: Vec<CalendarTimeValue>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub exdates: Vec<CalendarTimeValue>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum CalendarAttendee {
    CollabUser {
        id: String,
        server_url: String,
        user_id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        display_name: Option<String>,
        response: String,
        role: String,
    },
    Email {
        id: String,
        email: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        display_name: Option<String>,
        response: String,
        role: String,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum CalendarAttachment {
    VaultFile {
        id: String,
        name: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        server_url: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        vault_id: Option<String>,
        file_id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        path: Option<String>,
    },
    KanbanTask {
        id: String,
        name: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        server_url: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        vault_id: Option<String>,
        file_id: String,
        card_id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        path: Option<String>,
    },
    Uploaded {
        id: String,
        name: String,
        attachment_id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        content_type: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        size_bytes: Option<i64>,
    },
    ExternalUrl {
        id: String,
        name: String,
        url: String,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(untagged)]
pub enum CalendarEventLocation {
    Legacy(String),
    Structured {
        label: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        address: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        latitude: Option<f64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        longitude: Option<f64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        provider: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        provider_place_id: Option<String>,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum CalendarSourceBinding {
    Kanban {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        server_url: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        vault_id: Option<String>,
        file_id: String,
        card_id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        path: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        source_revision: Option<i64>,
    },
    External {
        subscription_id: String,
        external_uid: String,
    },
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum CalendarItemKind {
    Event,
    Task,
    Birthday,
}

impl CalendarItemKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Event => "event",
            Self::Task => "task",
            Self::Birthday => "birthday",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CalendarItem {
    pub id: String,
    pub uid: String,
    pub calendar_id: String,
    pub kind: CalendarItemKind,
    pub title: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    #[serde(default)]
    pub reminders: Vec<CalendarReminder>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub attendees: Vec<CalendarAttendee>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub attachments: Vec<CalendarAttachment>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub recurrence: Option<CalendarRecurrence>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub recurrence_id: Option<CalendarTimeValue>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub recurrence_series_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_binding: Option<CalendarSourceBinding>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub icalendar_properties: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub start: Option<CalendarTimeValue>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub end: Option<CalendarTimeValue>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub due: Option<CalendarTimeValue>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub date: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub birth_year: Option<i32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub location: Option<CalendarEventLocation>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub availability: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub priority: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub status: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub completed_at: Option<String>,
    pub revision: i64,
    pub created_at: String,
    pub updated_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub deleted_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum CalendarMutation {
    CreateCalendar {
        calendar: CalendarDefinition,
    },
    UpdateCalendar {
        calendar: CalendarDefinition,
    },
    DeleteCalendar {
        calendar_id: String,
    },
    UpsertItem {
        item: CalendarItem,
    },
    DeleteItem {
        calendar_id: String,
        item_id: String,
        deleted_at: String,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CalendarOperation {
    pub client_operation_id: String,
    pub device_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expected_revision: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_change_id: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub propagation_lineage: Vec<String>,
    pub mutation: CalendarMutation,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CalendarOperationFailure {
    pub operation: CalendarOperation,
    pub attempt_count: i64,
    pub last_error: String,
    pub last_attempt_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CalendarSyncState {
    pub origin_key: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cursor: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_synced_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CalendarMirrorMember {
    pub id: String,
    pub calendar_id: String,
    pub location: CalendarLocation,
    pub added_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CalendarMirrorGroup {
    pub schema_version: u32,
    pub id: String,
    pub name: String,
    #[serde(default = "mirror_enabled")]
    pub enabled: bool,
    pub members: Vec<CalendarMirrorMember>,
    pub created_at: String,
    pub updated_at: String,
}

fn mirror_enabled() -> bool {
    true
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CalendarMirrorAnchor {
    pub group_id: String,
    pub logical_item_key: String,
    pub member_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub item_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub revision: Option<i64>,
    pub fingerprint: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub deleted_at: Option<String>,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CalendarMirrorConflictVersion {
    pub member_id: String,
    pub fingerprint: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub item: Option<CalendarItem>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CalendarMirrorConflict {
    pub id: String,
    pub group_id: String,
    pub logical_item_key: String,
    pub status: String,
    pub versions: Vec<CalendarMirrorConflictVersion>,
    pub detected_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resolved_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CalendarRemoteChange {
    pub sequence: i64,
    pub entity_type: String,
    pub entity_id: String,
    pub operation: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub payload: Option<serde_json::Value>,
    pub changed_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CalendarCleanupResult {
    pub calendars_removed: u64,
    pub items_removed: u64,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn wire_values_match_the_typescript_calendar_contract() {
        assert_eq!(
            serde_json::to_value(CalendarLocation::Hosted {
                server_url: "https://server.test".into(),
                user_id: "user-1".into(),
            })
            .unwrap(),
            json!({
                "kind": "hosted",
                "serverUrl": "https://server.test",
                "userId": "user-1"
            })
        );
        assert_eq!(
            serde_json::to_value(CalendarTimeValue::DateTime {
                date_time: "2026-07-22T08:00:00Z".into(),
                time_zone: "Europe/Berlin".into(),
            })
            .unwrap(),
            json!({
                "kind": "dateTime",
                "dateTime": "2026-07-22T08:00:00Z",
                "timeZone": "Europe/Berlin"
            })
        );
        assert_eq!(
            serde_json::to_value(CalendarItemKind::Event).unwrap(),
            json!("event")
        );
        assert_eq!(
            serde_json::to_value(CalendarMutation::DeleteItem {
                calendar_id: "calendar-1".into(),
                item_id: "item-1".into(),
                deleted_at: "2026-07-22T08:00:00Z".into(),
            })
            .unwrap(),
            json!({
                "type": "deleteItem",
                "calendarId": "calendar-1",
                "itemId": "item-1",
                "deletedAt": "2026-07-22T08:00:00Z"
            })
        );
    }
}
