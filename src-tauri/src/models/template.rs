use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum TemplateSource {
    Builtin,
    Vault,
    App,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct KanbanTemplate {
    pub kind: String,
    pub name: String,
    pub source: TemplateSource,
    pub hash: String,
    pub updated_at: u64,
    pub board: Value,
}

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum NoteSnippetScope {
    Vault,
    App,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct NoteSnippet {
    pub id: String,
    pub name: String,
    pub description: Option<String>,
    pub scope: NoteSnippetScope,
    pub category: Option<String>,
    pub body: String,
    pub updated_at: u64,
}
