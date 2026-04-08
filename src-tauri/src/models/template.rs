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
