//! SQLite snapshots are binary assets, separate from text document formats.
pub const MEDIA_TYPE: &str = "application/vnd.sqlite3";
pub const HEADER: &[u8; 16] = b"SQLite format 3\0";

pub fn matches_path(path: &str) -> bool {
    path.rsplit_once('.').is_some_and(|(_, ext)| {
        ["sqlite", "sqlite3", "db"]
            .iter()
            .any(|kind| ext.eq_ignore_ascii_case(kind))
    })
}

pub fn has_header(bytes: &[u8]) -> bool {
    bytes.len() >= 100 && bytes.starts_with(HEADER)
}

/// SQLite sidecars are tied to a live database and cannot travel independently.
pub fn is_sidecar(path: &str) -> bool {
    let path = path.to_ascii_lowercase();
    ["-wal", "-shm", "-journal"]
        .iter()
        .any(|suffix| path.strip_suffix(suffix).is_some_and(matches_path))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn database_files_and_sidecars_have_different_types() {
        assert!(matches_path("Data/Inventory.SQLite3"));
        assert!(matches_path("Data/Inventory.db"));
        for path in [
            "Inventory.sqlite-wal",
            "Inventory.sqlite-shm",
            "Inventory.db-journal",
            "notes.sql",
        ] {
            assert!(!matches_path(path));
        }
        assert_eq!(crate::classify_path("Data/Inventory.db"), None);
    }
}
