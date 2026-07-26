//! Portable vault mutation planning.
//!
//! This crate decides whether a mutation is valid and describes the metadata,
//! reference, revision, manifest, and quota effects an adapter must apply.
//! It deliberately owns no database, filesystem, authorization, or blob IO.

use serde::{Deserialize, Serialize};
use std::collections::{BTreeSet, HashSet};
use thiserror::Error;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum EntryKind {
    File,
    Folder,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum EntryState {
    Active,
    Trashed,
    Tombstoned,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct EntrySnapshot {
    pub id: String,
    pub parent_id: Option<String>,
    pub name: String,
    pub relative_path: String,
    pub kind: EntryKind,
    pub state: EntryState,
    pub current_revision_sequence: Option<i64>,
    pub size_bytes: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct VaultSnapshot {
    pub manifest_sequence: i64,
    pub entries: Vec<EntrySnapshot>,
    #[serde(default)]
    pub applied_operation_ids: BTreeSet<String>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "snake_case")]
pub enum CapabilityRequirement {
    Create,
    Rename,
    Move,
    Trash,
    Restore,
    Purge,
}

pub type CapabilitySet = BTreeSet<CapabilityRequirement>;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MutationContext {
    pub capabilities: CapabilitySet,
    pub operation_id: String,
    pub base_manifest_sequence: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum MutationRequest {
    Create {
        id: String,
        parent_id: Option<String>,
        name: String,
        kind: EntryKind,
        size_bytes: u64,
    },
    Rename {
        target_id: String,
        name: String,
    },
    Move {
        target_id: String,
        parent_id: Option<String>,
    },
    Trash {
        target_id: String,
        remove_references: bool,
    },
    Restore {
        target_id: String,
    },
    Purge {
        target_id: String,
        remove_references: bool,
    },
}

impl MutationRequest {
    pub fn capability(&self) -> CapabilityRequirement {
        match self {
            Self::Create { .. } => CapabilityRequirement::Create,
            Self::Rename { .. } => CapabilityRequirement::Rename,
            Self::Move { .. } => CapabilityRequirement::Move,
            Self::Trash { .. } => CapabilityRequirement::Trash,
            Self::Restore { .. } => CapabilityRequirement::Restore,
            Self::Purge { .. } => CapabilityRequirement::Purge,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Precondition {
    ManifestSequence(i64),
    TargetState(EntryState),
    Capability(CapabilityRequirement),
    OperationNotApplied(String),
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum MetadataChange {
    Create {
        id: String,
        parent_id: Option<String>,
        name: String,
        relative_path: String,
        kind: EntryKind,
    },
    Rename {
        target_id: String,
        name: String,
    },
    Move {
        target_id: String,
        parent_id: Option<String>,
    },
    SetSubtreeState {
        target_id: String,
        state: EntryState,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ReferenceRewritePlan {
    pub old_path: String,
    pub new_path: Option<String>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum PathChangeKind {
    Unchanged,
    Rename,
    Move,
    MoveAndRename,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PathChangePlan {
    pub old_path: String,
    pub new_path: String,
    pub kind: PathChangeKind,
    pub descendant_paths: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MutationPlan {
    pub operation_id: String,
    pub preconditions: Vec<Precondition>,
    pub metadata_changes: Vec<MetadataChange>,
    pub reference_rewrites: Vec<ReferenceRewritePlan>,
    pub path_change: Option<PathChangePlan>,
    pub storage_delta_bytes: i64,
    pub next_manifest_sequence: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MutationResult {
    pub operation_id: String,
    pub result_manifest_sequence: i64,
    pub already_applied: bool,
    pub changed_entry_ids: Vec<String>,
    pub rewritten_document_ids: Vec<String>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Error)]
#[serde(rename_all = "snake_case")]
pub enum VaultDomainError {
    #[error("The vault manifest has changed.")]
    ManifestConflict,
    #[error("The document revision has changed.")]
    RevisionConflict,
    #[error("The destination path already exists.")]
    PathConflict,
    #[error("The operation has already been applied.")]
    OperationAlreadyApplied,
    #[error("The requested entry was not found.")]
    EntryNotFound,
    #[error("The destination folder was not found.")]
    ParentNotFound,
    #[error("The destination must be an active folder.")]
    InvalidParent,
    #[error("The requested state transition is invalid.")]
    InvalidState,
    #[error("A folder cannot be moved inside itself.")]
    MoveIntoDescendant,
    #[error("The destination matches the current path.")]
    UnchangedPath,
    #[error("The supplied path or name is invalid.")]
    InvalidPath,
    #[error("The resolved capability does not allow this mutation.")]
    CapabilityDenied,
    #[error("The sequence cannot be advanced.")]
    SequenceOverflow,
    #[error("This write would exceed the storage quota.")]
    QuotaExceeded,
}

impl VaultDomainError {
    pub const fn code(self) -> &'static str {
        match self {
            Self::ManifestConflict => "manifest_conflict",
            Self::RevisionConflict => "revision_conflict",
            Self::PathConflict => "path_conflict",
            Self::OperationAlreadyApplied => "operation_already_applied",
            Self::EntryNotFound => "resource_not_found",
            Self::ParentNotFound => "resource_not_found",
            Self::InvalidParent | Self::MoveIntoDescendant | Self::InvalidPath => "path_invalid",
            Self::InvalidState | Self::UnchangedPath => "validation_failed",
            Self::CapabilityDenied => "vault_permission_denied",
            Self::SequenceOverflow => "operation_conflict",
            Self::QuotaExceeded => "quota_exceeded",
        }
    }

    pub fn from_code(code: &str) -> Option<Self> {
        match code {
            "manifest_conflict" => Some(Self::ManifestConflict),
            "revision_conflict" => Some(Self::RevisionConflict),
            "path_conflict" => Some(Self::PathConflict),
            "operation_already_applied" => Some(Self::OperationAlreadyApplied),
            "resource_not_found" => Some(Self::EntryNotFound),
            "path_invalid" => Some(Self::InvalidPath),
            "validation_failed" => Some(Self::InvalidState),
            "vault_permission_denied" | "permission_revoked" => Some(Self::CapabilityDenied),
            "operation_conflict" => Some(Self::SequenceOverflow),
            "quota_exceeded" => Some(Self::QuotaExceeded),
            _ => None,
        }
    }
}

pub fn check_manifest_sequence(expected: i64, actual: i64) -> Result<(), VaultDomainError> {
    if expected < 0 || expected != actual {
        Err(VaultDomainError::ManifestConflict)
    } else {
        Ok(())
    }
}

pub fn check_revision_sequence(expected: i64, actual: i64) -> Result<(), VaultDomainError> {
    if expected < 0 || expected != actual {
        Err(VaultDomainError::RevisionConflict)
    } else {
        Ok(())
    }
}

pub fn next_sequence(current: i64) -> Result<i64, VaultDomainError> {
    current
        .checked_add(1)
        .ok_or(VaultDomainError::SequenceOverflow)
}

pub fn plan_state_transition(
    current: EntryState,
    requested: EntryState,
) -> Result<EntryState, VaultDomainError> {
    match (current, requested) {
        (EntryState::Active, EntryState::Trashed)
        | (EntryState::Trashed, EntryState::Active)
        | (EntryState::Trashed, EntryState::Tombstoned) => Ok(requested),
        _ => Err(VaultDomainError::InvalidState),
    }
}

pub fn plan_path_change(
    old_path: &str,
    new_path: &str,
    is_folder: bool,
    destination_exists: bool,
    descendant_paths: impl IntoIterator<Item = String>,
) -> Result<PathChangePlan, VaultDomainError> {
    let old =
        collab_core::normalize_hosted_path(old_path).map_err(|_| VaultDomainError::InvalidPath)?;
    let new =
        collab_core::normalize_hosted_path(new_path).map_err(|_| VaultDomainError::InvalidPath)?;
    let kind = classify_path_change(&old, &new)?;
    if old == new {
        return Err(VaultDomainError::UnchangedPath);
    }
    if is_folder && new.starts_with(&format!("{old}/")) {
        return Err(VaultDomainError::MoveIntoDescendant);
    }
    if destination_exists {
        return Err(VaultDomainError::PathConflict);
    }

    let mut remapped = descendant_paths
        .into_iter()
        .filter_map(|path| collab_documents::references::remap_path(&path, &old, &new))
        .map(|path| {
            collab_core::normalize_hosted_path(&path).map_err(|_| VaultDomainError::InvalidPath)
        })
        .collect::<Result<Vec<_>, _>>()?;
    remapped.sort();
    Ok(PathChangePlan {
        old_path: old,
        new_path: new,
        kind,
        descendant_paths: remapped,
    })
}

pub fn classify_path_change(
    old_path: &str,
    new_path: &str,
) -> Result<PathChangeKind, VaultDomainError> {
    let old =
        collab_core::normalize_hosted_path(old_path).map_err(|_| VaultDomainError::InvalidPath)?;
    let new =
        collab_core::normalize_hosted_path(new_path).map_err(|_| VaultDomainError::InvalidPath)?;
    let old_parent = old.rsplit_once('/').map_or("", |(parent, _)| parent);
    let new_parent = new.rsplit_once('/').map_or("", |(parent, _)| parent);
    let old_name = old.rsplit('/').next().unwrap_or_default();
    let new_name = new.rsplit('/').next().unwrap_or_default();
    Ok(match (old_parent != new_parent, old_name != new_name) {
        (false, false) => PathChangeKind::Unchanged,
        (false, true) => PathChangeKind::Rename,
        (true, false) => PathChangeKind::Move,
        (true, true) => PathChangeKind::MoveAndRename,
    })
}

pub fn added_content_bytes(
    incoming: &[(String, usize)],
    existing_digests: &HashSet<String>,
) -> u64 {
    let mut counted: HashSet<&str> = existing_digests.iter().map(String::as_str).collect();
    incoming.iter().fold(0_u64, |total, (digest, size)| {
        if counted.insert(digest) {
            total.saturating_add(*size as u64)
        } else {
            total
        }
    })
}

pub fn check_storage_quota(current: u64, added: u64, quota: u64) -> Result<(), VaultDomainError> {
    if quota > 0 && current.saturating_add(added) > quota {
        Err(VaultDomainError::QuotaExceeded)
    } else {
        Ok(())
    }
}

pub fn plan_mutation(
    snapshot: &VaultSnapshot,
    context: &MutationContext,
    request: MutationRequest,
) -> Result<MutationPlan, VaultDomainError> {
    check_manifest_sequence(context.base_manifest_sequence, snapshot.manifest_sequence)?;
    if snapshot
        .applied_operation_ids
        .contains(&context.operation_id)
    {
        return Err(VaultDomainError::OperationAlreadyApplied);
    }
    let required = request.capability();
    if !context.capabilities.contains(&required) {
        return Err(VaultDomainError::CapabilityDenied);
    }

    let mut plan = MutationPlan {
        operation_id: context.operation_id.clone(),
        preconditions: vec![
            Precondition::ManifestSequence(context.base_manifest_sequence),
            Precondition::Capability(required),
            Precondition::OperationNotApplied(context.operation_id.clone()),
        ],
        metadata_changes: Vec::new(),
        reference_rewrites: Vec::new(),
        path_change: None,
        storage_delta_bytes: 0,
        next_manifest_sequence: next_sequence(snapshot.manifest_sequence)?,
    };

    match request {
        MutationRequest::Create {
            id,
            parent_id,
            name,
            kind,
            size_bytes,
        } => {
            let path = destination_path(snapshot, parent_id.as_deref(), &name, None)?;
            plan.metadata_changes.push(MetadataChange::Create {
                id,
                parent_id,
                name,
                relative_path: path,
                kind,
            });
            plan.storage_delta_bytes = i64::try_from(size_bytes).unwrap_or(i64::MAX);
        }
        MutationRequest::Rename { target_id, name } => {
            let target = active_target(snapshot, &target_id)?;
            let path = destination_path(
                snapshot,
                target.parent_id.as_deref(),
                &name,
                Some(&target.id),
            )?;
            let descendants = subtree_descendants(snapshot, target);
            plan.path_change = Some(plan_path_change(
                &target.relative_path,
                &path,
                target.kind == EntryKind::Folder,
                false,
                descendants,
            )?);
            plan.preconditions
                .push(Precondition::TargetState(EntryState::Active));
            plan.metadata_changes
                .push(MetadataChange::Rename { target_id, name });
            plan.reference_rewrites.push(ReferenceRewritePlan {
                old_path: target.relative_path.clone(),
                new_path: Some(path),
            });
        }
        MutationRequest::Move {
            target_id,
            parent_id,
        } => {
            let target = active_target(snapshot, &target_id)?;
            let path = destination_path(
                snapshot,
                parent_id.as_deref(),
                &target.name,
                Some(&target.id),
            )?;
            let descendants = subtree_descendants(snapshot, target);
            plan.path_change = Some(plan_path_change(
                &target.relative_path,
                &path,
                target.kind == EntryKind::Folder,
                false,
                descendants,
            )?);
            plan.preconditions
                .push(Precondition::TargetState(EntryState::Active));
            plan.metadata_changes.push(MetadataChange::Move {
                target_id,
                parent_id,
            });
            plan.reference_rewrites.push(ReferenceRewritePlan {
                old_path: target.relative_path.clone(),
                new_path: Some(path),
            });
        }
        MutationRequest::Trash {
            target_id,
            remove_references,
        } => {
            let target = target(snapshot, &target_id)?;
            plan_state_transition(target.state, EntryState::Trashed)?;
            plan.preconditions
                .push(Precondition::TargetState(EntryState::Active));
            plan.metadata_changes.push(MetadataChange::SetSubtreeState {
                target_id,
                state: EntryState::Trashed,
            });
            if remove_references {
                plan.reference_rewrites.push(ReferenceRewritePlan {
                    old_path: target.relative_path.clone(),
                    new_path: None,
                });
            }
        }
        MutationRequest::Restore { target_id } => {
            let target = target(snapshot, &target_id)?;
            plan_state_transition(target.state, EntryState::Active)?;
            plan.preconditions
                .push(Precondition::TargetState(EntryState::Trashed));
            plan.metadata_changes.push(MetadataChange::SetSubtreeState {
                target_id,
                state: EntryState::Active,
            });
        }
        MutationRequest::Purge {
            target_id,
            remove_references,
        } => {
            let target = target(snapshot, &target_id)?;
            plan_state_transition(target.state, EntryState::Tombstoned)?;
            plan.preconditions
                .push(Precondition::TargetState(EntryState::Trashed));
            plan.metadata_changes.push(MetadataChange::SetSubtreeState {
                target_id,
                state: EntryState::Tombstoned,
            });
            if remove_references {
                plan.reference_rewrites.push(ReferenceRewritePlan {
                    old_path: target.relative_path.clone(),
                    new_path: None,
                });
            }
        }
    }
    Ok(plan)
}

fn target<'a>(
    snapshot: &'a VaultSnapshot,
    id: &str,
) -> Result<&'a EntrySnapshot, VaultDomainError> {
    snapshot
        .entries
        .iter()
        .find(|entry| entry.id == id)
        .ok_or(VaultDomainError::EntryNotFound)
}

fn active_target<'a>(
    snapshot: &'a VaultSnapshot,
    id: &str,
) -> Result<&'a EntrySnapshot, VaultDomainError> {
    let entry = target(snapshot, id)?;
    if entry.state != EntryState::Active {
        return Err(VaultDomainError::InvalidState);
    }
    Ok(entry)
}

fn destination_path(
    snapshot: &VaultSnapshot,
    parent_id: Option<&str>,
    name: &str,
    exclude_id: Option<&str>,
) -> Result<String, VaultDomainError> {
    let (name, _) =
        collab_core::normalize_hosted_name(name).map_err(|_| VaultDomainError::InvalidPath)?;
    let path = if let Some(parent_id) = parent_id {
        let parent = target(snapshot, parent_id).map_err(|_| VaultDomainError::ParentNotFound)?;
        if parent.kind != EntryKind::Folder || parent.state != EntryState::Active {
            return Err(VaultDomainError::InvalidParent);
        }
        format!("{}/{name}", parent.relative_path)
    } else {
        name
    };
    let normalized =
        collab_core::normalize_hosted_path(&path).map_err(|_| VaultDomainError::InvalidPath)?;
    if snapshot.entries.iter().any(|entry| {
        entry.state == EntryState::Active
            && Some(entry.id.as_str()) != exclude_id
            && entry.relative_path.eq_ignore_ascii_case(&normalized)
    }) {
        return Err(VaultDomainError::PathConflict);
    }
    Ok(normalized)
}

fn subtree_descendants(snapshot: &VaultSnapshot, target: &EntrySnapshot) -> Vec<String> {
    snapshot
        .entries
        .iter()
        .filter(|entry| {
            entry.id != target.id
                && entry
                    .relative_path
                    .starts_with(&format!("{}/", target.relative_path))
        })
        .map(|entry| entry.relative_path.clone())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(id: &str, parent_id: Option<&str>, path: &str, kind: EntryKind) -> EntrySnapshot {
        EntrySnapshot {
            id: id.into(),
            parent_id: parent_id.map(str::to_owned),
            name: path.rsplit('/').next().unwrap().into(),
            relative_path: path.into(),
            kind,
            state: EntryState::Active,
            current_revision_sequence: None,
            size_bytes: 0,
        }
    }

    fn snapshot() -> VaultSnapshot {
        VaultSnapshot {
            manifest_sequence: 7,
            entries: vec![
                entry("docs", None, "Docs", EntryKind::Folder),
                entry("note", Some("docs"), "Docs/note.md", EntryKind::File),
                entry("archive", None, "Archive", EntryKind::Folder),
            ],
            applied_operation_ids: BTreeSet::new(),
        }
    }

    fn context(capability: CapabilityRequirement) -> MutationContext {
        MutationContext {
            capabilities: [capability].into_iter().collect(),
            operation_id: "op-1".into(),
            base_manifest_sequence: 7,
        }
    }

    #[test]
    fn rename_plan_contains_path_rewrite_and_next_manifest() {
        let plan = plan_mutation(
            &snapshot(),
            &context(CapabilityRequirement::Rename),
            MutationRequest::Rename {
                target_id: "note".into(),
                name: "renamed.md".into(),
            },
        )
        .unwrap();
        assert_eq!(plan.next_manifest_sequence, 8);
        assert_eq!(
            plan.path_change.as_ref().unwrap().kind,
            PathChangeKind::Rename
        );
        assert_eq!(
            plan.reference_rewrites[0].new_path.as_deref(),
            Some("Docs/renamed.md")
        );
    }

    #[test]
    fn move_rejects_descendants_and_existing_paths() {
        let err = plan_mutation(
            &snapshot(),
            &context(CapabilityRequirement::Move),
            MutationRequest::Move {
                target_id: "docs".into(),
                parent_id: Some("docs".into()),
            },
        )
        .unwrap_err();
        assert_eq!(err, VaultDomainError::MoveIntoDescendant);

        let err = plan_mutation(
            &snapshot(),
            &context(CapabilityRequirement::Rename),
            MutationRequest::Rename {
                target_id: "docs".into(),
                name: "Archive".into(),
            },
        )
        .unwrap_err();
        assert_eq!(err, VaultDomainError::PathConflict);
    }

    #[test]
    fn state_transitions_match_local_and_hosted_trash_semantics() {
        assert_eq!(
            plan_state_transition(EntryState::Active, EntryState::Trashed),
            Ok(EntryState::Trashed)
        );
        assert_eq!(
            plan_state_transition(EntryState::Trashed, EntryState::Active),
            Ok(EntryState::Active)
        );
        assert_eq!(
            plan_state_transition(EntryState::Trashed, EntryState::Tombstoned),
            Ok(EntryState::Tombstoned)
        );
        assert_eq!(
            plan_state_transition(EntryState::Active, EntryState::Tombstoned),
            Err(VaultDomainError::InvalidState)
        );
    }

    #[test]
    fn optimistic_and_idempotency_conflicts_are_typed() {
        assert_eq!(
            check_manifest_sequence(6, 7),
            Err(VaultDomainError::ManifestConflict)
        );
        assert_eq!(
            check_revision_sequence(3, 4),
            Err(VaultDomainError::RevisionConflict)
        );
        let mut snapshot = snapshot();
        snapshot.applied_operation_ids.insert("op-1".into());
        assert_eq!(
            plan_mutation(
                &snapshot,
                &context(CapabilityRequirement::Trash),
                MutationRequest::Trash {
                    target_id: "note".into(),
                    remove_references: false,
                },
            ),
            Err(VaultDomainError::OperationAlreadyApplied)
        );
    }

    #[test]
    fn quota_counts_only_new_digests_and_saturates() {
        let existing = HashSet::from(["a".to_string()]);
        let incoming = vec![
            ("a".into(), 100),
            ("b".into(), 10),
            ("b".into(), 10),
            ("c".into(), 5),
        ];
        assert_eq!(added_content_bytes(&incoming, &existing), 15);
        assert!(check_storage_quota(985, 15, 1_000).is_ok());
        assert_eq!(
            check_storage_quota(986, 15, 1_000),
            Err(VaultDomainError::QuotaExceeded)
        );
        assert!(check_storage_quota(u64::MAX, 1, 0).is_ok());
    }

    #[test]
    fn path_plan_remaps_descendants_deterministically() {
        let plan = plan_path_change(
            "Docs",
            "Archive/Docs",
            true,
            false,
            vec!["Docs/z.md".into(), "Docs/a.md".into()],
        )
        .unwrap();
        assert_eq!(plan.kind, PathChangeKind::Move);
        assert_eq!(
            plan.descendant_paths,
            vec!["Archive/Docs/a.md", "Archive/Docs/z.md"]
        );
    }
}
