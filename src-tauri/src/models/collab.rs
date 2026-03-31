use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ChatMessage {
    pub id: String,
    pub user_id: String,
    pub user_name: String,
    pub user_color: String,
    pub content: String,
    pub timestamp: u64,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotMeta {
    pub id: String,
    pub relative_path: String,
    pub author_id: String,
    pub author_name: String,
    pub timestamp: u64,
    pub hash: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
}
