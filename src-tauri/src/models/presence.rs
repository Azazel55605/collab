use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct PresenceEntry {
    pub user_id: String,
    pub user_name: String,
    pub user_color: String,
    pub active_file: Option<String>,
    pub cursor_line: Option<i32>,
    pub last_seen: u64,
    pub app_version: String,
}
