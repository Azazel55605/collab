//! Portable archive validation and materialization planning.
//!
//! Adapters remain responsible for ZIP/TAR decoding, decompression, streaming,
//! filesystem traversal, blob reads, and persistence. This crate only consumes
//! entry metadata and returns deterministic plans.

use collab_vault_domain::EntryKind;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashMap, HashSet};
use thiserror::Error;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ArchiveEntryKind {
    File,
    Directory,
    Symlink,
    Other,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ArchiveEntryMetadata {
    pub source_index: usize,
    pub raw_path: String,
    pub kind: ArchiveEntryKind,
    pub declared_size: u64,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SeparatorPolicy {
    NormalizeBackslashes,
    RejectBackslashes,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ArchivePathPolicy {
    pub separators: SeparatorPolicy,
    pub ignored_roots: Vec<String>,
    pub allowed_reserved_roots: Vec<String>,
    pub case_insensitive_duplicates: bool,
}

impl Default for ArchivePathPolicy {
    fn default() -> Self {
        Self {
            separators: SeparatorPolicy::NormalizeBackslashes,
            ignored_roots: Vec::new(),
            allowed_reserved_roots: Vec::new(),
            case_insensitive_duplicates: true,
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub struct ArchiveLimits {
    pub max_entries: Option<usize>,
    pub max_entry_bytes: Option<u64>,
    pub max_expanded_bytes: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ImportEntryPlan {
    pub source_index: Option<usize>,
    pub relative_path: String,
    pub kind: EntryKind,
    pub declared_size: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ImportPlan {
    pub entries: Vec<ImportEntryPlan>,
    pub ignored_source_indices: Vec<usize>,
    pub expanded_bytes: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ExportSource {
    pub source_id: String,
    pub relative_path: String,
    pub kind: EntryKind,
    pub size_bytes: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ExportEntryPlan {
    pub source_id: String,
    pub archive_path: String,
    pub kind: EntryKind,
    pub size_bytes: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ExportPlan {
    pub entries: Vec<ExportEntryPlan>,
    pub total_bytes: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum ArchivePlanError {
    #[error("Archive contains too many entries.")]
    EntryCountExceeded,
    #[error("Archive entry exceeds the per-entry size limit.")]
    EntrySizeExceeded,
    #[error("Archive expanded size exceeds the configured limit.")]
    ExpandedSizeExceeded,
    #[error("Archive contains an unsafe or invalid path.")]
    InvalidPath,
    #[error("Archive contains a path with a forbidden separator.")]
    InvalidSeparator,
    #[error("Archive contains duplicate normalized paths.")]
    DuplicatePath,
    #[error("Archive contains a path used as both a file and folder.")]
    FileFolderConflict,
    #[error("Archive symlinks are not supported.")]
    SymlinkUnsupported,
    #[error("Archive contains an unsupported entry type.")]
    UnsupportedEntryType,
    #[error("Archive is empty.")]
    EmptyArchive,
    #[error("Archive must contain exactly one root directory.")]
    MultipleRoots,
    #[error("Archive root is invalid.")]
    InvalidRoot,
    #[error("Archive manifest does not declare a version.")]
    ManifestVersionMissing,
    #[error("Archive manifest version is not supported.")]
    ManifestVersionUnsupported,
}

pub fn plan_import(
    metadata: &[ArchiveEntryMetadata],
    limits: ArchiveLimits,
    policy: &ArchivePathPolicy,
) -> Result<ImportPlan, ArchivePlanError> {
    if metadata.is_empty() {
        return Err(ArchivePlanError::EmptyArchive);
    }
    if limits
        .max_entries
        .is_some_and(|maximum| metadata.len() > maximum)
    {
        return Err(ArchivePlanError::EntryCountExceeded);
    }

    let mut ignored = Vec::new();
    let mut explicit = Vec::<ImportEntryPlan>::new();
    let mut comparison_paths = HashSet::new();
    let mut expanded_bytes = 0_u64;
    for entry in metadata {
        let Some(path) = normalize_entry_path(&entry.raw_path, policy)? else {
            ignored.push(entry.source_index);
            continue;
        };
        match entry.kind {
            ArchiveEntryKind::Symlink => return Err(ArchivePlanError::SymlinkUnsupported),
            ArchiveEntryKind::Other => return Err(ArchivePlanError::UnsupportedEntryType),
            ArchiveEntryKind::File | ArchiveEntryKind::Directory => {}
        }
        let comparison = comparison_key(&path, policy.case_insensitive_duplicates);
        if !comparison_paths.insert(comparison) {
            return Err(ArchivePlanError::DuplicatePath);
        }
        if entry.kind == ArchiveEntryKind::File {
            if limits
                .max_entry_bytes
                .is_some_and(|maximum| entry.declared_size > maximum)
            {
                return Err(ArchivePlanError::EntrySizeExceeded);
            }
            expanded_bytes = expanded_bytes.saturating_add(entry.declared_size);
            if limits
                .max_expanded_bytes
                .is_some_and(|maximum| expanded_bytes > maximum)
            {
                return Err(ArchivePlanError::ExpandedSizeExceeded);
            }
        }
        explicit.push(ImportEntryPlan {
            source_index: Some(entry.source_index),
            relative_path: path,
            kind: if entry.kind == ArchiveEntryKind::Directory {
                EntryKind::Folder
            } else {
                EntryKind::File
            },
            declared_size: entry.declared_size,
        });
    }

    let file_paths = explicit
        .iter()
        .filter(|entry| entry.kind == EntryKind::File)
        .map(|entry| comparison_key(&entry.relative_path, policy.case_insensitive_duplicates))
        .collect::<HashSet<_>>();
    let mut folders = BTreeMap::<String, Option<usize>>::new();
    for entry in &explicit {
        if entry.kind == EntryKind::Folder {
            folders.insert(entry.relative_path.clone(), entry.source_index);
        }
        let mut parent = entry.relative_path.as_str();
        while let Some((prefix, _)) = parent.rsplit_once('/') {
            if file_paths.contains(&comparison_key(prefix, policy.case_insensitive_duplicates)) {
                return Err(ArchivePlanError::FileFolderConflict);
            }
            folders.entry(prefix.to_owned()).or_insert(None);
            parent = prefix;
        }
    }
    if folders.iter().any(|(path, _)| {
        file_paths.contains(&comparison_key(path, policy.case_insensitive_duplicates))
    }) {
        return Err(ArchivePlanError::FileFolderConflict);
    }

    let mut entries = folders
        .into_iter()
        .map(|(relative_path, source_index)| ImportEntryPlan {
            source_index,
            relative_path,
            kind: EntryKind::Folder,
            declared_size: 0,
        })
        .chain(
            explicit
                .into_iter()
                .filter(|entry| entry.kind == EntryKind::File),
        )
        .collect::<Vec<_>>();
    entries.sort_by_key(|entry| {
        (
            entry.relative_path.matches('/').count(),
            entry.kind != EntryKind::Folder,
            entry.relative_path.to_lowercase(),
        )
    });
    ignored.sort_unstable();
    Ok(ImportPlan {
        entries,
        ignored_source_indices: ignored,
        expanded_bytes,
    })
}

pub fn plan_export(
    sources: &[ExportSource],
    root_path: Option<&str>,
    limits: ArchiveLimits,
    policy: &ArchivePathPolicy,
) -> Result<ExportPlan, ArchivePlanError> {
    let root = root_path
        .map(|path| normalize_archive_path(path, policy))
        .transpose()?;
    let parent_prefix = root
        .as_deref()
        .and_then(|root| {
            root.rsplit_once('/')
                .map(|(parent, _)| format!("{parent}/"))
        })
        .unwrap_or_default();
    let mut entries = Vec::new();
    for source in sources {
        let normalized = normalize_archive_path(&source.relative_path, policy)?;
        if let Some(root) = root.as_deref() {
            if normalized != root && !normalized.starts_with(&format!("{root}/")) {
                continue;
            }
        }
        let archive_path = normalized
            .strip_prefix(&parent_prefix)
            .unwrap_or(&normalized)
            .to_owned();
        entries.push(ExportEntryPlan {
            source_id: source.source_id.clone(),
            archive_path,
            kind: source.kind,
            size_bytes: source.size_bytes,
        });
    }
    validate_export_entries(&entries, limits, policy)
}

pub fn validate_export_entries(
    entries: &[ExportEntryPlan],
    limits: ArchiveLimits,
    policy: &ArchivePathPolicy,
) -> Result<ExportPlan, ArchivePlanError> {
    if limits
        .max_entries
        .is_some_and(|maximum| entries.len() > maximum)
    {
        return Err(ArchivePlanError::EntryCountExceeded);
    }
    let mut paths = HashSet::new();
    let mut kinds = HashMap::new();
    let mut total_bytes = 0_u64;
    let mut normalized_entries = Vec::with_capacity(entries.len());
    for entry in entries {
        let path = normalize_archive_path(&entry.archive_path, policy)?;
        let key = comparison_key(&path, policy.case_insensitive_duplicates);
        if !paths.insert(key.clone()) {
            return Err(ArchivePlanError::DuplicatePath);
        }
        kinds.insert(key, entry.kind);
        if entry.kind == EntryKind::File {
            if limits
                .max_entry_bytes
                .is_some_and(|maximum| entry.size_bytes > maximum)
            {
                return Err(ArchivePlanError::EntrySizeExceeded);
            }
            total_bytes = total_bytes.saturating_add(entry.size_bytes);
            if limits
                .max_expanded_bytes
                .is_some_and(|maximum| total_bytes > maximum)
            {
                return Err(ArchivePlanError::ExpandedSizeExceeded);
            }
        }
        normalized_entries.push(ExportEntryPlan {
            source_id: entry.source_id.clone(),
            archive_path: path,
            kind: entry.kind,
            size_bytes: entry.size_bytes,
        });
    }
    for entry in &normalized_entries {
        let mut parent = entry.archive_path.as_str();
        while let Some((prefix, _)) = parent.rsplit_once('/') {
            if kinds.get(&comparison_key(prefix, policy.case_insensitive_duplicates))
                == Some(&EntryKind::File)
            {
                return Err(ArchivePlanError::FileFolderConflict);
            }
            parent = prefix;
        }
    }
    let mut sorted = normalized_entries;
    sorted.sort_by_key(|entry| {
        (
            entry.archive_path.matches('/').count(),
            entry.kind != EntryKind::Folder,
            entry.archive_path.to_lowercase(),
        )
    });
    Ok(ExportPlan {
        entries: sorted,
        total_bytes,
    })
}

pub fn validate_single_root(
    metadata: &[ArchiveEntryMetadata],
    limits: ArchiveLimits,
    policy: &ArchivePathPolicy,
    valid_root: impl Fn(&str) -> bool,
) -> Result<String, ArchivePlanError> {
    let plan = plan_import(metadata, limits, policy)?;
    let mut root = None::<String>;
    for entry in &plan.entries {
        let first = entry
            .relative_path
            .split('/')
            .next()
            .ok_or(ArchivePlanError::EmptyArchive)?;
        if !valid_root(first) {
            return Err(ArchivePlanError::InvalidRoot);
        }
        match root.as_deref() {
            Some(existing) if existing != first => return Err(ArchivePlanError::MultipleRoots),
            None => root = Some(first.to_owned()),
            _ => {}
        }
    }
    root.ok_or(ArchivePlanError::EmptyArchive)
}

pub fn validate_manifest_version(
    manifest: &str,
    key: &str,
    supported_version: &str,
) -> Result<(), ArchivePlanError> {
    let version = manifest
        .lines()
        .find_map(|line| line.strip_prefix(key))
        .map(str::trim)
        .ok_or(ArchivePlanError::ManifestVersionMissing)?;
    if version != supported_version {
        return Err(ArchivePlanError::ManifestVersionUnsupported);
    }
    Ok(())
}

fn normalize_entry_path(
    raw_path: &str,
    policy: &ArchivePathPolicy,
) -> Result<Option<String>, ArchivePlanError> {
    if policy.separators == SeparatorPolicy::RejectBackslashes && raw_path.contains('\\') {
        return Err(ArchivePlanError::InvalidSeparator);
    }
    let separators = match policy.separators {
        SeparatorPolicy::NormalizeBackslashes => raw_path.replace('\\', "/"),
        SeparatorPolicy::RejectBackslashes => raw_path.to_owned(),
    };
    let trimmed = separators.trim_end_matches('/');
    if trimmed.is_empty() {
        return Ok(None);
    }
    if trimmed.starts_with('/')
        || trimmed
            .as_bytes()
            .get(1)
            .is_some_and(|character| *character == b':')
        || trimmed
            .split('/')
            .any(|part| part.is_empty() || part == "." || part == "..")
    {
        return Err(ArchivePlanError::InvalidPath);
    }
    let first = trimmed.split('/').next().unwrap_or_default();
    if policy
        .ignored_roots
        .iter()
        .any(|ignored| ignored.eq_ignore_ascii_case(first))
    {
        return Ok(None);
    }
    normalize_archive_path(trimmed, policy).map(Some)
}

fn comparison_key(path: &str, case_insensitive: bool) -> String {
    if case_insensitive {
        path.to_lowercase()
    } else {
        path.to_owned()
    }
}

fn normalize_archive_path(
    raw_path: &str,
    policy: &ArchivePathPolicy,
) -> Result<String, ArchivePlanError> {
    if policy.separators == SeparatorPolicy::RejectBackslashes && raw_path.contains('\\') {
        return Err(ArchivePlanError::InvalidSeparator);
    }
    let path = match policy.separators {
        SeparatorPolicy::NormalizeBackslashes => raw_path.replace('\\', "/"),
        SeparatorPolicy::RejectBackslashes => raw_path.to_owned(),
    };
    let trimmed = path.trim_end_matches('/');
    if trimmed.is_empty()
        || trimmed.starts_with('/')
        || trimmed
            .as_bytes()
            .get(1)
            .is_some_and(|character| *character == b':')
        || trimmed
            .split('/')
            .any(|part| part.is_empty() || part == "." || part == "..")
    {
        return Err(ArchivePlanError::InvalidPath);
    }
    let first = trimmed.split('/').next().unwrap_or_default();
    if policy
        .allowed_reserved_roots
        .iter()
        .any(|root| root.eq_ignore_ascii_case(first))
    {
        for component in trimmed.split('/').skip(1) {
            collab_core::normalize_hosted_name(component)
                .map_err(|_| ArchivePlanError::InvalidPath)?;
        }
        return Ok(trimmed.to_owned());
    }
    collab_core::normalize_hosted_path(trimmed).map_err(|_| ArchivePlanError::InvalidPath)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn file(index: usize, path: &str, size: u64) -> ArchiveEntryMetadata {
        ArchiveEntryMetadata {
            source_index: index,
            raw_path: path.into(),
            kind: ArchiveEntryKind::File,
            declared_size: size,
        }
    }

    #[test]
    fn import_normalizes_separators_and_builds_implicit_folders() {
        let plan = plan_import(
            &[file(0, "Notes\\nested\\entry.md", 10)],
            ArchiveLimits::default(),
            &ArchivePathPolicy::default(),
        )
        .unwrap();
        assert_eq!(
            plan.entries
                .iter()
                .map(|entry| entry.relative_path.as_str())
                .collect::<Vec<_>>(),
            ["Notes", "Notes/nested", "Notes/nested/entry.md"]
        );
    }

    #[test]
    fn import_rejects_traversal_absolute_and_bad_separators() {
        for path in ["../escape", "/absolute", "C:\\escape"] {
            assert!(plan_import(
                &[file(0, path, 1)],
                ArchiveLimits::default(),
                &ArchivePathPolicy::default(),
            )
            .is_err());
        }
        let policy = ArchivePathPolicy {
            separators: SeparatorPolicy::RejectBackslashes,
            ..ArchivePathPolicy::default()
        };
        assert_eq!(
            plan_import(
                &[file(0, "root\\file", 1)],
                ArchiveLimits::default(),
                &policy
            ),
            Err(ArchivePlanError::InvalidSeparator)
        );
    }

    #[test]
    fn import_rejects_duplicates_and_file_folder_conflicts() {
        assert_eq!(
            plan_import(
                &[file(0, "Notes/A.md", 1), file(1, "notes/a.md", 1)],
                ArchiveLimits::default(),
                &ArchivePathPolicy::default(),
            ),
            Err(ArchivePlanError::DuplicatePath)
        );
        assert_eq!(
            plan_import(
                &[file(0, "folder", 1), file(1, "folder/child", 1)],
                ArchiveLimits::default(),
                &ArchivePathPolicy::default(),
            ),
            Err(ArchivePlanError::FileFolderConflict)
        );
    }

    #[test]
    fn import_rejects_symlinks_and_unsupported_entries() {
        for kind in [ArchiveEntryKind::Symlink, ArchiveEntryKind::Other] {
            let result = plan_import(
                &[ArchiveEntryMetadata {
                    source_index: 0,
                    raw_path: "entry".into(),
                    kind,
                    declared_size: 0,
                }],
                ArchiveLimits::default(),
                &ArchivePathPolicy::default(),
            );
            assert!(result.is_err());
        }
    }

    #[test]
    fn budgets_cover_entry_count_entry_size_and_expanded_size() {
        let entries = [file(0, "a", 700), file(1, "b", 700)];
        assert_eq!(
            plan_import(
                &entries,
                ArchiveLimits {
                    max_entries: Some(1),
                    ..ArchiveLimits::default()
                },
                &ArchivePathPolicy::default(),
            ),
            Err(ArchivePlanError::EntryCountExceeded)
        );
        assert_eq!(
            plan_import(
                &entries,
                ArchiveLimits {
                    max_entry_bytes: Some(600),
                    ..ArchiveLimits::default()
                },
                &ArchivePathPolicy::default(),
            ),
            Err(ArchivePlanError::EntrySizeExceeded)
        );
        assert_eq!(
            plan_import(
                &entries,
                ArchiveLimits {
                    max_expanded_bytes: Some(1_200),
                    ..ArchiveLimits::default()
                },
                &ArchivePathPolicy::default(),
            ),
            Err(ArchivePlanError::ExpandedSizeExceeded)
        );
    }

    #[test]
    fn ignored_roots_are_validated_as_an_explicit_policy() {
        let plan = plan_import(
            &[file(0, ".collab/runtime", 100), file(1, "Note.md", 5)],
            ArchiveLimits::default(),
            &ArchivePathPolicy {
                ignored_roots: vec![".collab".into()],
                ..ArchivePathPolicy::default()
            },
        )
        .unwrap();
        assert_eq!(plan.ignored_source_indices, [0]);
        assert_eq!(plan.expanded_bytes, 5);
    }

    #[test]
    fn export_plan_rebases_a_folder_and_is_deterministic() {
        let sources = vec![
            ExportSource {
                source_id: "file".into(),
                relative_path: "Root/Notes/a.md".into(),
                kind: EntryKind::File,
                size_bytes: 5,
            },
            ExportSource {
                source_id: "root".into(),
                relative_path: "Root/Notes".into(),
                kind: EntryKind::Folder,
                size_bytes: 0,
            },
            ExportSource {
                source_id: "other".into(),
                relative_path: "Root/Other.md".into(),
                kind: EntryKind::File,
                size_bytes: 1,
            },
        ];
        let plan = plan_export(
            &sources,
            Some("Root/Notes"),
            ArchiveLimits::default(),
            &ArchivePathPolicy::default(),
        )
        .unwrap();
        assert_eq!(
            plan.entries
                .iter()
                .map(|entry| entry.archive_path.as_str())
                .collect::<Vec<_>>(),
            ["Notes", "Notes/a.md"]
        );
    }

    #[test]
    fn backup_root_and_manifest_are_portably_validated() {
        let metadata = vec![
            ArchiveEntryMetadata {
                source_index: 0,
                raw_path: "collab-backup-1/".into(),
                kind: ArchiveEntryKind::Directory,
                declared_size: 0,
            },
            file(1, "collab-backup-1/postgres.dump", 10),
        ];
        let root = validate_single_root(
            &metadata,
            ArchiveLimits::default(),
            &ArchivePathPolicy {
                separators: SeparatorPolicy::RejectBackslashes,
                ..ArchivePathPolicy::default()
            },
            |root| root.starts_with("collab-backup-"),
        )
        .unwrap();
        assert_eq!(root, "collab-backup-1");
        assert!(validate_manifest_version(
            "collab_backup_version=1\n",
            "collab_backup_version=",
            "1"
        )
        .is_ok());
        assert_eq!(
            validate_manifest_version("collab_backup_version=2\n", "collab_backup_version=", "1"),
            Err(ArchivePlanError::ManifestVersionUnsupported)
        );
    }
}
