use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct VaultMeta {
    pub id: String,
    pub name: String,
    pub path: String,
    pub last_opened: u64,
    /// Whether the vault files are encrypted at rest.
    #[serde(default)]
    pub is_encrypted: bool,
}

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum MemberRole {
    Viewer,
    Editor,
    Admin,
}

impl Default for MemberRole {
    fn default() -> Self {
        MemberRole::Editor
    }
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct VaultMember {
    pub user_id: String,
    pub user_name: String,
    pub role: MemberRole,
}

#[derive(Debug, Serialize, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct VaultConfig {
    pub id: String,
    pub name: String,
    pub known_users: Vec<KnownUser>,
    /// UserId of the vault owner (the user who created it).
    #[serde(default)]
    pub owner: Option<String>,
    /// Explicit role assignments for collaborators.
    #[serde(default)]
    pub members: Vec<VaultMember>,
    /// Reserved for future encryption support.
    #[serde(default)]
    pub is_encrypted: bool,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct KnownUser {
    pub user_id: String,
    pub user_name: String,
    pub user_color: String,
    pub last_seen: u64,
}
