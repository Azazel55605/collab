//! Portable team contracts. Server administration and team ownership are distinct.
use serde::{Deserialize, Serialize};
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TeamSummary {
    pub id: String,
    pub name: String,
    pub role: String,
    pub archived: bool,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TeamChannel {
    pub id: String,
    pub name: String,
    pub private: bool,
    pub archived: bool,
    pub library_vault_id: Option<String>,
    pub unread: i64,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TeamMember {
    pub user_id: String,
    pub display_name: String,
    pub role: String,
    pub active: bool,
}
pub fn may_remove_owner(role: &str, active: bool, active_owners: i64) -> bool {
    role != "owner" || !active || active_owners > 1
}
#[cfg(test)]
mod tests {
    #[test]
    fn last_active_owner_is_protected() {
        assert!(!super::may_remove_owner("owner", true, 1));
        assert!(super::may_remove_owner("owner", true, 2));
        assert!(super::may_remove_owner("member", true, 1));
        assert!(super::may_remove_owner("owner", false, 1));
    }
}
