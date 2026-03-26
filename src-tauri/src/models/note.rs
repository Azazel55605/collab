use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct NoteFile {
    pub relative_path: String,
    pub name: String,
    pub extension: String,
    pub modified_at: u64,
    pub size: u64,
    pub is_folder: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub children: Option<Vec<NoteFile>>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteContent {
    pub content: String,
    pub hash: String,
    pub modified_at: u64,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WriteResult {
    pub hash: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub conflict: Option<ConflictInfo>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ConflictInfo {
    pub our_content: String,
    pub their_content: String,
    pub relative_path: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct NoteMetadata {
    pub relative_path: String,
    pub title: String,
    pub tags: Vec<String>,
    pub wikilinks_out: Vec<String>,
    pub modified_at: u64,
    pub word_count: u32,
    pub hash: String,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchResult {
    pub relative_path: String,
    pub title: String,
    pub excerpt: String,
    pub score: i64,
    pub match_type: String,
}
