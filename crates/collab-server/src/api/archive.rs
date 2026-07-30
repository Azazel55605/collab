use super::ApiFailure;
use collab_archive::{
    plan_import, ArchiveEntryKind, ArchiveEntryMetadata, ArchiveLimits, ArchivePathPolicy,
    ArchivePlanError,
};
use collab_documents::{classify_path, DocumentKind};
use collab_protocol::{HostedDocumentType, HostedFileKind};
use std::io::{Cursor, Read};

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
    let mut metadata = Vec::with_capacity(archive.len());
    for index in 0..archive.len() {
        let entry = archive.by_index(index).map_err(|_| {
            ApiFailure::validation("Vault ZIP entry could not be read.", request_id.to_owned())
        })?;
        metadata.push(ArchiveEntryMetadata {
            source_index: index,
            raw_path: entry.name().to_owned(),
            kind: zip_entry_kind(&entry),
            declared_size: entry.size(),
        });
    }
    let plan = plan_import(
        &metadata,
        ArchiveLimits {
            max_entries: Some(1000),
            max_entry_bytes: Some(max_file_bytes as u64),
            max_expanded_bytes: Some(max_expanded_bytes as u64),
        },
        &ArchivePathPolicy {
            ignored_roots: vec![".collab".into()],
            ..ArchivePathPolicy::default()
        },
    )
    .map_err(|error| map_archive_error(error, request_id))?;

    let mut entries = Vec::with_capacity(plan.entries.len());
    let mut actual_expanded_bytes = 0usize;
    for planned in plan.entries {
        if planned.kind == collab_vault_domain::EntryKind::Folder {
            entries.push(import_entry(
                planned.relative_path,
                HostedFileKind::Folder,
                None,
                None,
            ));
            continue;
        }
        let source_index = planned
            .source_index
            .ok_or_else(|| ApiFailure::server(request_id.to_owned()))?;
        let mut entry = archive
            .by_index(source_index)
            .map_err(|_| ApiFailure::server(request_id.to_owned()))?;
        let mut content = Vec::with_capacity(entry.size() as usize);
        entry.read_to_end(&mut content).map_err(|_| {
            ApiFailure::validation(
                "Vault ZIP entry could not be expanded.",
                request_id.to_owned(),
            )
        })?;
        if content.len() > max_file_bytes {
            return Err(ApiFailure::quota_exceeded(request_id.to_owned()));
        }
        actual_expanded_bytes = actual_expanded_bytes.saturating_add(content.len());
        if actual_expanded_bytes > max_expanded_bytes {
            return Err(ApiFailure::quota_exceeded(request_id.to_owned()));
        }
        let path = planned.relative_path;
        let (kind, document_type) = imported_file_kind(&path);
        if kind == HostedFileKind::Document && String::from_utf8(content.clone()).is_err() {
            return Err(ApiFailure::validation(
                "Imported text documents must be valid UTF-8.",
                request_id.to_owned(),
            ));
        }
        entries.push(import_entry(path, kind, document_type, Some(content)));
    }
    Ok(entries)
}

fn zip_entry_kind(entry: &zip::read::ZipFile<'_>) -> ArchiveEntryKind {
    let unix_kind = entry.unix_mode().map(|mode| mode & 0o170000);
    if unix_kind == Some(0o120000) {
        ArchiveEntryKind::Symlink
    } else if entry.is_dir() {
        ArchiveEntryKind::Directory
    } else if unix_kind.is_some_and(|kind| kind != 0 && kind != 0o100000) {
        ArchiveEntryKind::Other
    } else {
        ArchiveEntryKind::File
    }
}

fn map_archive_error(error: ArchivePlanError, request_id: &str) -> ApiFailure {
    match error {
        ArchivePlanError::EntryCountExceeded
        | ArchivePlanError::EntrySizeExceeded
        | ArchivePlanError::ExpandedSizeExceeded => {
            ApiFailure::quota_exceeded(request_id.to_owned())
        }
        ArchivePlanError::InvalidPath | ArchivePlanError::InvalidSeparator => {
            ApiFailure::path_invalid(error.to_string(), request_id.to_owned())
        }
        _ => ApiFailure::validation(error.to_string(), request_id.to_owned()),
    }
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
        Some(DocumentKind::Sheet) => (HostedFileKind::Document, Some(HostedDocumentType::Sheet)),
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
            imported_file_kind("Budget.sheet"),
            (HostedFileKind::Document, Some(HostedDocumentType::Sheet))
        );
        assert_eq!(
            imported_file_kind("Manual.pdf"),
            (HostedFileKind::Asset, None)
        );
    }
}
