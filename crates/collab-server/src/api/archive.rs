use super::ApiFailure;
use collab_documents::{classify_path, DocumentKind};
use collab_protocol::{HostedDocumentType, HostedFileKind};
use std::{
    collections::HashSet,
    io::{Cursor, Read},
};

pub(super) struct VaultImportEntry {
    pub(super) relative_path: String,
    pub(super) name: String,
    pub(super) parent_path: Option<String>,
    pub(super) kind: HostedFileKind,
    pub(super) document_type: Option<HostedDocumentType>,
    pub(super) content: Option<Vec<u8>>,
    pub(super) digest: Option<String>,
}

pub(super) fn parse_vault_zip(
    bytes: &[u8],
    max_file_bytes: usize,
    max_expanded_bytes: usize,
    request_id: &str,
) -> Result<Vec<VaultImportEntry>, ApiFailure> {
    let mut archive = zip::ZipArchive::new(Cursor::new(bytes)).map_err(|_| {
        ApiFailure::validation(
            "Vault import is not a valid ZIP archive.",
            request_id.to_owned(),
        )
    })?;
    if archive.len() > 1000 {
        return Err(ApiFailure::quota_exceeded(request_id.to_owned()));
    }

    let mut files = Vec::<(String, Vec<u8>)>::new();
    let mut explicit_folders = HashSet::<String>::new();
    let mut comparison_paths = HashSet::<String>::new();
    let mut expanded_bytes = 0usize;
    for index in 0..archive.len() {
        let mut entry = archive.by_index(index).map_err(|_| {
            ApiFailure::validation("Vault ZIP entry could not be read.", request_id.to_owned())
        })?;
        if entry
            .unix_mode()
            .is_some_and(|mode| mode & 0o170000 == 0o120000)
        {
            return Err(ApiFailure::validation(
                "Vault ZIP symlinks are not supported.",
                request_id.to_owned(),
            ));
        }

        // Windows ZIP writers sometimes use backslashes despite the ZIP spec.
        let normalized_separators = entry.name().replace('\\', "/");
        let raw_name = normalized_separators.trim_end_matches('/');
        if raw_name.is_empty() {
            continue;
        }
        if raw_name
            .split('/')
            .next()
            .is_some_and(|name| name.eq_ignore_ascii_case(".collab"))
        {
            continue;
        }
        let path = collab_core::normalize_hosted_path(raw_name)
            .map_err(|error| ApiFailure::path_invalid(error.to_string(), request_id.to_owned()))?;
        if !comparison_paths.insert(path.to_lowercase()) {
            return Err(ApiFailure::validation(
                "Vault ZIP contains duplicate normalized paths.",
                request_id.to_owned(),
            ));
        }
        if entry.is_dir() {
            explicit_folders.insert(path);
            continue;
        }
        if entry.size() > max_file_bytes as u64 {
            return Err(ApiFailure::quota_exceeded(request_id.to_owned()));
        }

        let mut content = Vec::with_capacity(entry.size() as usize);
        entry.read_to_end(&mut content).map_err(|_| {
            ApiFailure::validation(
                "Vault ZIP entry could not be expanded.",
                request_id.to_owned(),
            )
        })?;
        expanded_bytes = expanded_bytes.saturating_add(content.len());
        if expanded_bytes > max_expanded_bytes {
            return Err(ApiFailure::quota_exceeded(request_id.to_owned()));
        }
        files.push((path, content));
    }

    let mut folders = explicit_folders;
    for (path, _) in &files {
        let mut parts = path.split('/').collect::<Vec<_>>();
        parts.pop();
        while !parts.is_empty() {
            folders.insert(parts.join("/"));
            parts.pop();
        }
    }
    let file_paths = files
        .iter()
        .map(|(path, _)| path.to_lowercase())
        .collect::<HashSet<_>>();
    if folders
        .iter()
        .any(|folder| file_paths.contains(&folder.to_lowercase()))
    {
        return Err(ApiFailure::validation(
            "Vault ZIP contains a path used as both a file and folder.",
            request_id.to_owned(),
        ));
    }

    let mut entries = folders
        .into_iter()
        .map(|path| import_entry(path, HostedFileKind::Folder, None, None))
        .collect::<Vec<_>>();
    for (path, content) in files {
        let (kind, document_type) = imported_file_kind(&path);
        if kind == HostedFileKind::Document && String::from_utf8(content.clone()).is_err() {
            return Err(ApiFailure::validation(
                "Imported text documents must be valid UTF-8.",
                request_id.to_owned(),
            ));
        }
        entries.push(import_entry(path, kind, document_type, Some(content)));
    }
    entries.sort_by_key(|entry| {
        (
            entry.relative_path.matches('/').count(),
            entry.kind != HostedFileKind::Folder,
            entry.relative_path.to_lowercase(),
        )
    });
    Ok(entries)
}

fn import_entry(
    relative_path: String,
    kind: HostedFileKind,
    document_type: Option<HostedDocumentType>,
    content: Option<Vec<u8>>,
) -> VaultImportEntry {
    let (parent_path, name) = relative_path
        .rsplit_once('/')
        .map(|(parent, name)| (Some(parent.to_owned()), name.to_owned()))
        .unwrap_or_else(|| (None, relative_path.clone()));
    VaultImportEntry {
        relative_path,
        name,
        parent_path,
        kind,
        document_type,
        content,
        digest: None,
    }
}

fn imported_file_kind(path: &str) -> (HostedFileKind, Option<HostedDocumentType>) {
    match classify_path(path) {
        Some(DocumentKind::Note) => (HostedFileKind::Document, Some(HostedDocumentType::Note)),
        Some(DocumentKind::Kanban) => (HostedFileKind::Document, Some(HostedDocumentType::Kanban)),
        Some(DocumentKind::Canvas) => (HostedFileKind::Document, Some(HostedDocumentType::Canvas)),
        Some(DocumentKind::Logic | DocumentKind::Svg) => {
            (HostedFileKind::Document, Some(HostedDocumentType::Note))
        }
        _ => (HostedFileKind::Asset, None),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn archive(entries: &[(&str, &[u8])]) -> Vec<u8> {
        let mut writer = zip::ZipWriter::new(Cursor::new(Vec::new()));
        let options = zip::write::SimpleFileOptions::default();
        for (name, content) in entries {
            writer.start_file(*name, options).unwrap();
            writer.write_all(content).unwrap();
        }
        writer.finish().unwrap().into_inner()
    }

    #[test]
    fn archive_plan_normalizes_windows_paths_and_builds_parent_folders() {
        let bytes = archive(&[("Notes\\nested\\entry.md", b"# note")]);
        let entries = parse_vault_zip(&bytes, 1024, 4096, "request").unwrap();
        let paths = entries
            .iter()
            .map(|entry| entry.relative_path.as_str())
            .collect::<Vec<_>>();
        assert_eq!(paths, ["Notes", "Notes/nested", "Notes/nested/entry.md"]);
    }

    #[test]
    fn archive_plan_rejects_normalized_duplicates_and_file_folder_conflicts() {
        let duplicates = archive(&[("Notes/A.md", b"a"), ("notes/a.md", b"b")]);
        assert!(parse_vault_zip(&duplicates, 1024, 4096, "request").is_err());

        let conflict = archive(&[("folder", b"file"), ("folder/child.md", b"child")]);
        assert!(parse_vault_zip(&conflict, 1024, 4096, "request").is_err());
    }

    #[test]
    fn archive_plan_enforces_per_entry_and_total_expanded_budgets() {
        let bytes = archive(&[("a.bin", &[0; 700]), ("b.bin", &[1; 700])]);
        assert!(parse_vault_zip(&bytes, 600, 4096, "request").is_err());
        assert!(parse_vault_zip(&bytes, 1024, 1200, "request").is_err());
        assert!(parse_vault_zip(&bytes, 1024, 1600, "request").is_ok());
    }

    #[test]
    fn archive_document_classification_uses_the_shared_document_kinds() {
        assert_eq!(
            imported_file_kind("Board.KANBAN"),
            (HostedFileKind::Document, Some(HostedDocumentType::Kanban))
        );
        assert_eq!(
            imported_file_kind("Circuit.logic"),
            (HostedFileKind::Document, Some(HostedDocumentType::Note))
        );
        assert_eq!(
            imported_file_kind("Drawing.svg"),
            (HostedFileKind::Document, Some(HostedDocumentType::Note))
        );
        assert_eq!(
            imported_file_kind("Manual.pdf"),
            (HostedFileKind::Asset, None)
        );
    }
}
