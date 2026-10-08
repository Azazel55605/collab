//! Server-local conversation contracts and portable membership policy.
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ConversationSummary {
    pub id: String,
    pub kind: String,
    pub name: String,
    pub role: String,
    pub last_sequence: String,
    pub read_sequence: String,
    pub unread: i64,
    pub updated_cursor: String,
    pub picture: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub team_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub team_name: Option<String>,
    /// Preview of the newest message visible to the caller, truncated server-side.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_message: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_message_at: Option<u64>,
    #[serde(default)]
    pub last_message_own: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ConversationMember {
    pub user_id: String,
    pub display_name: String,
    pub role: String,
    pub active: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ConversationMessage {
    pub id: String,
    pub user_id: String,
    pub user_name: String,
    pub content: String,
    pub timestamp: u64,
    pub sequence: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ConversationPage {
    pub messages: Vec<ConversationMessage>,
    pub next_before: Option<String>,
    pub next_after: Option<String>,
    pub has_more: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ConversationEvent {
    pub sequence: String,
    pub conversation_id: String,
    pub kind: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ConversationEvents {
    pub events: Vec<ConversationEvent>,
    pub next_after: String,
    pub has_more: bool,
}

/// Never demote/remove the final active owner. Adapter locks must cover the
/// snapshot and mutation together; server administrators are not participants.
pub fn can_remove_owner(target_is_active_owner: bool, active_owners: i64) -> bool {
    !target_is_active_owner || active_owners > 1
}

pub fn valid_message(content: &str) -> bool {
    let size = content.trim().chars().count();
    (1..=4000).contains(&size)
}

pub fn visible_sequence(sequence: i64, joined_sequence: i64) -> bool {
    sequence >= joined_sequence
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn membership_and_content_boundaries() {
        assert!(!can_remove_owner(true, 1));
        assert!(can_remove_owner(true, 2));
        assert!(can_remove_owner(false, 1));
        assert!(!visible_sequence(99, 100));
        assert!(visible_sequence(100, 100));
        assert!(!valid_message(" \n "));
        assert!(valid_message(&"é".repeat(4000)));
        assert!(!valid_message(&"é".repeat(4001)));
    }
}
