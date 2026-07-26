use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const REST_API_VERSION: &str = "v1";
pub const PROTOCOL_VERSION: u32 = 1;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DataResponse<T> {
    pub data: T,
}

impl<T> DataResponse<T> {
    pub fn new(data: T) -> Self {
        Self { data }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ErrorResponse {
    pub error: ApiError,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ApiError {
    pub code: ErrorCode,
    pub message: String,
    pub request_id: String,
    #[serde(default, skip_serializing_if = "Value::is_null")]
    pub details: Value,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ErrorCode {
    BootstrapAlreadyCompleted,
    CsrfInvalid,
    AdminRequired,
    AuthenticationRequired,
    AuthenticationInvalid,
    SessionExpired,
    SessionRevoked,
    UserDisabled,
    RateLimited,
    ResourceNotFound,
    ValidationFailed,
    PathInvalid,
    PathConflict,
    VaultPermissionDenied,
    VaultArchived,
    RevisionConflict,
    ManifestConflict,
    OperationConflict,
    OperationAlreadyApplied,
    UploadIncomplete,
    UploadHashMismatch,
    QuotaExceeded,
    ProtocolVersionUnsupported,
    MaintenanceMode,
    ServerUnavailable,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct HealthStatus {
    pub status: HealthState,
    pub service: String,
    pub version: String,
    pub protocol_version: u32,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum HealthState {
    Ok,
    Degraded,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ServerUserRole {
    Member,
    Admin,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ServerUserStatus {
    Active,
    Disabled,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ServerUser {
    pub id: String,
    pub username: String,
    pub display_name: String,
    pub role: ServerUserRole,
    pub status: ServerUserStatus,
    pub created_at: String,
    pub last_login_at: Option<String>,
    pub active_sessions: i64,
    pub is_primary_admin: bool,
    /// Per-account UI preferences (e.g. theme/accent). Opaque JSON object.
    #[serde(default)]
    pub preferences: serde_json::Value,
    /// Whether the account has an avatar image (served from `/users/{id}/avatar`).
    #[serde(default)]
    pub has_avatar: bool,
    /// When the avatar was last updated, used for cache-busting the avatar URL.
    #[serde(default)]
    pub avatar_updated_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BootstrapStatus {
    pub required: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BrowserSession {
    pub user: ServerUser,
    pub csrf_token: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NativeSession {
    pub user: ServerUser,
    pub access_token: String,
    pub refresh_token: String,
    pub access_expires_at: String,
    pub refresh_expires_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Invitation {
    pub id: String,
    pub username: String,
    pub display_name: String,
    pub role: ServerUserRole,
    pub created_at: String,
    pub expires_at: String,
    pub accepted_at: Option<String>,
    pub revoked_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CreatedInvitation {
    pub invitation: Invitation,
    pub token: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct StorageSummary {
    pub database_bytes: i64,
    pub blob_bytes: u64,
    pub warning_threshold_bytes: u64,
    /// Total deduplicated stored content (sum of unique blob sizes). This is the
    /// metric the storage quota is enforced against, distinct from the physical
    /// `database_bytes`/`blob_bytes` figures used for the pressure warning.
    pub stored_content_bytes: u64,
    /// Hard server-wide storage cap in bytes. `0` means unlimited.
    pub quota_bytes: u64,
}

/// Counts of records reclaimed by a single retention/compaction maintenance run.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MaintenanceReport {
    pub expired_ws_tickets: u64,
    pub expired_sessions: u64,
    pub expired_calendar_operations: u64,
    pub reclaimed_calendar_uploads: u64,
    pub stale_presence: u64,
    pub pruned_audit_events: u64,
    pub pruned_activity_events: u64,
    pub pruned_revisions: u64,
    pub reclaimed_blobs: u64,
    pub reclaimed_blob_bytes: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct OperationalWarning {
    pub code: String,
    pub message: String,
    pub severity: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AdminBackupOverview {
    pub backup_dir: String,
    pub backup_command_configured: bool,
    pub restore_command_configured: bool,
    pub schedule: AdminBackupSchedule,
    pub export_target: AdminBackupExportTarget,
    pub settings: AdminBackupSettings,
    pub backups: Vec<AdminBackupSummary>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AdminBackupSchedule {
    pub enabled: bool,
    pub interval_seconds: u64,
    pub retention_days: u64,
    pub mode: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AdminBackupExportTarget {
    pub configured: bool,
    pub path: Option<String>,
    pub writable: bool,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AdminBackupSettings {
    pub schedule_enabled: bool,
    pub interval_seconds: u64,
    pub retention_days: u64,
    pub export_dir: Option<String>,
    pub locks: AdminBackupSettingsLocks,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AdminBackupSettingsLocks {
    pub schedule_enabled: bool,
    pub interval_seconds: bool,
    pub retention_days: bool,
    pub export_dir: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AdminRuntimeSetting<T> {
    pub value: T,
    pub env_var: String,
    pub locked: bool,
    pub source: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AdminRuntimeSettings {
    pub browser_secure_cookies: AdminRuntimeSetting<bool>,
    pub session_ttl_hours: AdminRuntimeSetting<i64>,
    pub native_access_ttl_minutes: AdminRuntimeSetting<i64>,
    pub native_refresh_ttl_days: AdminRuntimeSetting<i64>,
    pub ws_ticket_ttl_seconds: AdminRuntimeSetting<i64>,
    pub max_file_bytes: AdminRuntimeSetting<u64>,
    pub max_import_bytes: AdminRuntimeSetting<u64>,
    pub max_import_expanded_bytes: AdminRuntimeSetting<u64>,
    pub storage_warning_bytes: AdminRuntimeSetting<u64>,
    pub storage_quota_bytes: AdminRuntimeSetting<u64>,
    pub calendar_quota_bytes: AdminRuntimeSetting<u64>,
    pub calendar_rate_limit_per_minute: AdminRuntimeSetting<u64>,
    pub revision_history_limit: AdminRuntimeSetting<u64>,
    pub revision_storage_target_bytes: AdminRuntimeSetting<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AdminServerSettings {
    pub runtime: AdminRuntimeSettings,
    pub backup: AdminBackupSettings,
    pub maintenance: AdminMaintenanceMode,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AdminMaintenanceMode {
    pub enabled: bool,
    pub message: Option<String>,
    pub updated_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AdminBackupSummary {
    pub name: String,
    pub created_at: Option<String>,
    pub size_bytes: u64,
    pub has_postgres_dump: bool,
    pub has_blob_archive: bool,
    pub has_manifest: bool,
    pub has_config: bool,
    pub has_checksums: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AdminBackupVerification {
    pub name: String,
    pub ok: bool,
    pub checked_at: String,
    pub artifacts: Vec<AdminBackupArtifactVerification>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AdminBackupArtifactVerification {
    pub path: String,
    pub expected_sha256: String,
    pub actual_sha256: Option<String>,
    pub ok: bool,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AdminBackupCommandResult {
    pub status: String,
    pub message: String,
    pub output: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct HostedVaultSummary {
    pub id: String,
    pub name: String,
    pub owner_display_name: String,
    pub status: HostedVaultStatus,
    pub members: i64,
    pub storage_bytes: u64,
    pub require_offline_copy: bool,
    pub updated_at: String,
    /// The requesting user's effective capabilities on this vault.
    #[serde(default)]
    pub capabilities: Vec<String>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "lowercase")]
pub enum HostedVaultRole {
    Viewer,
    Editor,
    Admin,
}

/// A single fine-grained permission. Tokens are stable dotted strings used in the
/// database (`text[]`), protocol DTOs (`Vec<String>`), and capability checks.
///
/// Vault/file capabilities are hard-enforced at the endpoint chokepoint; kanban
/// capabilities are semantically enforced by diffing document revisions on write.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum Capability {
    #[serde(rename = "vault.read")]
    VaultRead,
    #[serde(rename = "vault.search")]
    VaultSearch,
    #[serde(rename = "vault.viewHistory")]
    VaultViewHistory,
    #[serde(rename = "vault.viewActivity")]
    VaultViewActivity,
    #[serde(rename = "vault.export")]
    VaultExport,
    #[serde(rename = "vault.import")]
    VaultImport,
    #[serde(rename = "vault.offlineCopy")]
    VaultOfflineCopy,
    #[serde(rename = "vault.manageMembers")]
    VaultManageMembers,
    #[serde(rename = "vault.managePermissions")]
    VaultManagePermissions,
    #[serde(rename = "vault.manageSnapshots")]
    VaultManageSnapshots,
    #[serde(rename = "file.create")]
    FileCreate,
    #[serde(rename = "file.write")]
    FileWrite,
    #[serde(rename = "file.move")]
    FileMove,
    #[serde(rename = "file.delete")]
    FileDelete,
    #[serde(rename = "file.uploadAsset")]
    FileUploadAsset,
    #[serde(rename = "kanban.card.create")]
    KanbanCardCreate,
    #[serde(rename = "kanban.card.editContent")]
    KanbanCardEditContent,
    #[serde(rename = "kanban.card.move")]
    KanbanCardMove,
    #[serde(rename = "kanban.card.comment")]
    KanbanCardComment,
    #[serde(rename = "kanban.card.delete")]
    KanbanCardDelete,
    #[serde(rename = "kanban.card.archive")]
    KanbanCardArchive,
    #[serde(rename = "kanban.column.manage")]
    KanbanColumnManage,
    #[serde(rename = "pdf.comment")]
    PdfComment,
    #[serde(rename = "pdf.annotate")]
    PdfAnnotate,
    #[serde(rename = "note.edit")]
    NoteEdit,
    #[serde(rename = "canvas.edit")]
    CanvasEdit,
}

impl Capability {
    /// Every capability, in canonical order. Used to seed the admin built-in
    /// template and to resolve tokens back to the typed enum.
    pub const ALL: [Capability; 26] = [
        Capability::VaultRead,
        Capability::VaultSearch,
        Capability::VaultViewHistory,
        Capability::VaultViewActivity,
        Capability::VaultExport,
        Capability::VaultImport,
        Capability::VaultOfflineCopy,
        Capability::VaultManageMembers,
        Capability::VaultManagePermissions,
        Capability::VaultManageSnapshots,
        Capability::FileCreate,
        Capability::FileWrite,
        Capability::FileMove,
        Capability::FileDelete,
        Capability::FileUploadAsset,
        Capability::KanbanCardCreate,
        Capability::KanbanCardEditContent,
        Capability::KanbanCardMove,
        Capability::KanbanCardComment,
        Capability::KanbanCardDelete,
        Capability::KanbanCardArchive,
        Capability::KanbanColumnManage,
        Capability::PdfComment,
        Capability::PdfAnnotate,
        Capability::NoteEdit,
        Capability::CanvasEdit,
    ];

    pub fn as_token(self) -> &'static str {
        match self {
            Capability::VaultRead => "vault.read",
            Capability::VaultSearch => "vault.search",
            Capability::VaultViewHistory => "vault.viewHistory",
            Capability::VaultViewActivity => "vault.viewActivity",
            Capability::VaultExport => "vault.export",
            Capability::VaultImport => "vault.import",
            Capability::VaultOfflineCopy => "vault.offlineCopy",
            Capability::VaultManageMembers => "vault.manageMembers",
            Capability::VaultManagePermissions => "vault.managePermissions",
            Capability::VaultManageSnapshots => "vault.manageSnapshots",
            Capability::FileCreate => "file.create",
            Capability::FileWrite => "file.write",
            Capability::FileMove => "file.move",
            Capability::FileDelete => "file.delete",
            Capability::FileUploadAsset => "file.uploadAsset",
            Capability::KanbanCardCreate => "kanban.card.create",
            Capability::KanbanCardEditContent => "kanban.card.editContent",
            Capability::KanbanCardMove => "kanban.card.move",
            Capability::KanbanCardComment => "kanban.card.comment",
            Capability::KanbanCardDelete => "kanban.card.delete",
            Capability::KanbanCardArchive => "kanban.card.archive",
            Capability::KanbanColumnManage => "kanban.column.manage",
            Capability::PdfComment => "pdf.comment",
            Capability::PdfAnnotate => "pdf.annotate",
            Capability::NoteEdit => "note.edit",
            Capability::CanvasEdit => "canvas.edit",
        }
    }

    pub fn from_token(token: &str) -> Option<Capability> {
        Capability::ALL
            .into_iter()
            .find(|capability| capability.as_token() == token)
    }
}

/// Expands a built-in role into its capability set. The three built-in templates
/// seeded into the database mirror these sets so legacy memberships (which only
/// carry a `role`) resolve to equivalent permissions.
pub fn capabilities_for_role(role: HostedVaultRole) -> Vec<Capability> {
    let viewer = [
        Capability::VaultRead,
        Capability::VaultSearch,
        Capability::VaultViewHistory,
        Capability::VaultViewActivity,
    ];
    let editor_extra = [
        Capability::FileCreate,
        Capability::FileWrite,
        Capability::FileMove,
        Capability::FileDelete,
        Capability::FileUploadAsset,
        Capability::VaultOfflineCopy,
        Capability::KanbanCardCreate,
        Capability::KanbanCardEditContent,
        Capability::KanbanCardMove,
        Capability::KanbanCardComment,
        Capability::KanbanCardDelete,
        Capability::KanbanCardArchive,
        Capability::KanbanColumnManage,
        Capability::PdfComment,
        Capability::PdfAnnotate,
        Capability::NoteEdit,
        Capability::CanvasEdit,
    ];
    let admin_extra = [
        Capability::VaultExport,
        Capability::VaultImport,
        Capability::VaultManageMembers,
        Capability::VaultManagePermissions,
        Capability::VaultManageSnapshots,
    ];
    match role {
        HostedVaultRole::Viewer => viewer.to_vec(),
        HostedVaultRole::Editor => viewer.into_iter().chain(editor_extra).collect(),
        HostedVaultRole::Admin => viewer
            .into_iter()
            .chain(editor_extra)
            .chain(admin_extra)
            .collect(),
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum GrantSubjectType {
    User,
    Group,
}

/// A reusable bundle of capabilities. Built-in templates (`viewer`, `editor`,
/// `admin`) are read-only and reproduce the legacy role ladder.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PermissionTemplate {
    pub id: String,
    pub name: String,
    pub description: Option<String>,
    pub is_builtin: bool,
    pub capabilities: Vec<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct UserGroup {
    pub id: String,
    pub name: String,
    pub description: Option<String>,
    pub member_count: i64,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct UserGroupMember {
    pub user_id: String,
    pub username: String,
    pub display_name: String,
    pub added_at: String,
}

/// A vault access grant for either a user (direct membership) or a group. The
/// resolved `capabilities` are the effective set this grant confers.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct VaultGrant {
    pub subject_type: GrantSubjectType,
    pub subject_id: String,
    pub subject_name: String,
    pub template_id: Option<String>,
    pub template_name: Option<String>,
    pub capabilities: Vec<String>,
    pub created_at: String,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum HostedVaultStatus {
    Active,
    Archived,
    PendingDelete,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct HostedVault {
    pub id: String,
    pub name: String,
    pub owner_user_id: String,
    pub owner_display_name: String,
    pub role: HostedVaultRole,
    pub status: HostedVaultStatus,
    pub manifest_sequence: i64,
    pub members: i64,
    pub storage_bytes: u64,
    pub require_offline_copy: bool,
    pub created_at: String,
    pub updated_at: String,
    /// The requesting user's effective capabilities on this vault.
    #[serde(default)]
    pub capabilities: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct HostedVaultStorage {
    pub active_bytes: u64,
    pub trash_bytes: u64,
    pub retained_revision_bytes: u64,
    pub unique_blob_bytes: u64,
    pub active_files: i64,
    pub trashed_files: i64,
    pub revision_count: i64,
    pub snapshot_count: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct HostedVaultAdminDetail {
    pub id: String,
    pub name: String,
    pub owner_user_id: String,
    pub owner_username: String,
    pub owner_display_name: String,
    pub status: HostedVaultStatus,
    pub manifest_sequence: i64,
    pub members: i64,
    pub active_files: i64,
    pub trashed_files: i64,
    pub storage_bytes: u64,
    pub require_offline_copy: bool,
    pub created_at: String,
    pub updated_at: String,
    /// The requesting user's effective capabilities on this vault.
    #[serde(default)]
    pub capabilities: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct HostedVaultMember {
    pub user_id: String,
    pub username: String,
    pub display_name: String,
    pub role: HostedVaultRole,
    pub owner: bool,
    pub created_at: String,
    /// The member's effective capability tokens at the membership level
    /// (explicit override, else assigned template, else role default; canonical
    /// order). Group grants further restrict at runtime and are not reflected
    /// here.
    #[serde(default)]
    pub capabilities: Vec<String>,
    /// The explicit per-member capability override, if any. `None` when the
    /// member uses a template or the plain role default.
    #[serde(default)]
    pub custom_capabilities: Option<Vec<String>>,
    /// The permission template assigned to this membership, if any.
    #[serde(default)]
    pub template_id: Option<String>,
    #[serde(default)]
    pub template_name: Option<String>,
}

/// Read-only directory entry exposed to any authenticated user so vault admins
/// can resolve a person to a user account when managing hosted-vault membership.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct UserDirectoryEntry {
    pub user_id: String,
    pub username: String,
    pub display_name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct HostedVaultActivityEvent {
    pub id: String,
    pub actor_display_name: Option<String>,
    pub event_type: String,
    pub target_type: Option<String>,
    pub target_id: Option<String>,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct HostedChatMessage {
    pub id: String,
    pub user_id: String,
    pub user_name: String,
    pub user_color: String,
    pub content: String,
    /// Milliseconds since the Unix epoch, matching the native chat DTO.
    pub timestamp: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct HostedPresenceEntry {
    pub user_id: String,
    pub user_name: String,
    pub user_color: String,
    pub active_file: Option<String>,
    pub cursor_line: Option<i32>,
    pub chat_typing_until: Option<u64>,
    /// Milliseconds since the Unix epoch, matching the native presence DTO.
    pub last_seen: u64,
    pub app_version: String,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum HostedFileKind {
    Folder,
    Document,
    Asset,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum HostedDocumentType {
    Note,
    Kanban,
    Canvas,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum HostedFileState {
    Active,
    Trashed,
    Tombstoned,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct HostedFileEntry {
    pub id: String,
    pub parent_id: Option<String>,
    pub name: String,
    pub relative_path: String,
    pub kind: HostedFileKind,
    pub document_type: Option<HostedDocumentType>,
    pub state: HostedFileState,
    pub current_revision: Option<HostedFileRevision>,
    pub trashed_by_display_name: Option<String>,
    pub trashed_at: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct HostedFileRevision {
    pub id: String,
    pub sequence: i64,
    pub content_hash: String,
    pub size_bytes: u64,
    pub created_by_display_name: Option<String>,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct HostedVaultManifest {
    pub vault_id: String,
    pub sequence: i64,
    pub files: Vec<HostedFileEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct HostedVaultManifestDelta {
    pub vault_id: String,
    pub base_sequence: i64,
    pub sequence: i64,
    pub changed_files: Vec<HostedFileEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct HostedTextDocument {
    pub file: HostedFileEntry,
    pub content: String,
}

/// The shared annotation state for a hosted PDF (bookmarks, highlights, text
/// annotations, and page comments), stored as opaque JSON alongside a
/// monotonically increasing `sequence` used for optimistic concurrency. Per-user
/// viewer state (last page, zoom) is intentionally not part of this shared model
/// and stays client-local.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct HostedPdfAnnotations {
    pub state: Value,
    pub sequence: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WritePdfAnnotationsRequest {
    /// The sequence the client last observed; the write is rejected with a
    /// revision conflict when it no longer matches the stored sequence.
    pub expected_sequence: i64,
    pub state: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct HostedRevisionContent {
    pub revision: HostedFileRevision,
    pub content: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct HostedSnapshot {
    pub id: String,
    pub label: Option<String>,
    pub revision: HostedFileRevision,
    pub created_by_display_name: Option<String>,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct HostedSearchResult {
    pub file_id: String,
    pub relative_path: String,
    pub title: String,
    pub excerpt: String,
    pub tags: Vec<String>,
    pub rank: f32,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct HostedVaultImportResult {
    pub imported_files: u64,
    pub imported_folders: u64,
    pub imported_bytes: u64,
    pub result_manifest_sequence: i64,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum HostedStructuralOperationType {
    Rename,
    Move,
    Trash,
    Restore,
    Purge,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct HostedStructuralOperationResult {
    pub operation_id: String,
    pub client_operation_id: String,
    pub operation_type: HostedStructuralOperationType,
    pub target_file_id: String,
    pub result_manifest_sequence: i64,
    pub already_applied: bool,
    #[serde(default)]
    pub rewritten_document_ids: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct HostedFileReference {
    pub source_file_id: String,
    pub source_relative_path: String,
    pub source_document_type: String,
    pub reference_kind: String,
    pub referenced_file_id: Option<String>,
    pub referenced_relative_path: String,
    pub display_label: Option<String>,
    pub context: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct HostedReferenceImpact {
    pub file_id: String,
    pub relative_path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct HostedStructuralOperationPreview {
    pub operation_type: HostedStructuralOperationType,
    pub target_file_id: String,
    pub item_kind: HostedFileKind,
    pub old_relative_path: String,
    pub new_relative_path: Option<String>,
    pub nested_item_count: i64,
    pub affected_documents: Vec<HostedReferenceImpact>,
    pub blocked_reason: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AdminOverview {
    pub health: HealthState,
    pub server_version: String,
    pub protocol_version: u32,
    pub uptime_seconds: u64,
    pub users: i64,
    pub active_users: i64,
    pub active_sessions: i64,
    pub pending_invitations: i64,
    pub hosted_vaults: i64,
    pub storage: StorageSummary,
    pub calendar_usage: CalendarUsageMetrics,
    pub live_collaboration: LiveCollaborationMetrics,
    pub operational_warnings: Vec<OperationalWarning>,
    pub recent_audit_events: Vec<AuditEvent>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CalendarUsageMetrics {
    pub users_with_calendars: i64,
    pub calendars: i64,
    pub items: i64,
    pub uploaded_attachments: i64,
    pub logical_bytes: i64,
    pub quota_bytes_per_user: u64,
    pub max_user_logical_bytes: i64,
    pub users_near_quota: i64,
    pub users_at_quota: i64,
    pub subscription_worker: CalendarSubscriptionWorkerMetrics,
    pub users_by_calendar_count: Vec<CalendarCountBucket>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CalendarSubscriptionWorkerMetrics {
    pub subscriptions: i64,
    pub subscriptions_with_errors: i64,
    pub overdue_subscriptions: i64,
    pub active_refresh_leases: i64,
    pub last_successful_refresh_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CalendarCountBucket {
    pub calendar_count: i64,
    pub users: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LiveCollaborationMetrics {
    pub active_connections: u64,
    pub loaded_rooms: u64,
    pub active_awareness_states: u64,
    pub active_presence_users: i64,
    pub pending_update_count: i64,
    pub pending_update_bytes: i64,
    pub updates_last_minute: i64,
    pub compacted_documents: i64,
    pub compacted_state_bytes: i64,
    pub last_compaction_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AuditEvent {
    pub id: String,
    pub actor_display_name: Option<String>,
    pub action: String,
    pub target_type: Option<String>,
    pub target_id: Option<String>,
    pub result: String,
    pub created_at: String,
}

// ---------------------------------------------------------------------------
// Live collaboration (Phase 5)
// ---------------------------------------------------------------------------

/// Request body for `POST /api/v1/auth/ws-ticket`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WsTicketRequest {
    pub vault_id: String,
}

/// Single-use credential for opening a vault WebSocket session. The ticket is
/// presented in the `authenticate` control frame after the upgrade; bearer
/// tokens never travel in the WebSocket URL.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WsTicket {
    pub ticket: String,
    pub vault_id: String,
    pub websocket_path: String,
    pub expires_at: String,
    pub protocol_version: u32,
}

/// JSON control frames sent by the client over the document WebSocket.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "type")]
pub enum WsClientControl {
    #[serde(rename = "authenticate", rename_all = "camelCase")]
    Authenticate {
        ticket: String,
        #[serde(default)]
        protocol_version: Option<u32>,
    },
    #[serde(rename = "document.subscribe", rename_all = "camelCase")]
    DocumentSubscribe { file_id: String },
    #[serde(rename = "document.unsubscribe", rename_all = "camelCase")]
    DocumentUnsubscribe { file_id: String },
    #[serde(rename = "ping")]
    Ping,
}

/// JSON control frames sent by the server over the document WebSocket.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "type")]
pub enum WsServerControl {
    #[serde(rename = "ready", rename_all = "camelCase")]
    Ready {
        manifest_sequence: i64,
        protocol_version: u32,
        role: HostedVaultRole,
    },
    #[serde(rename = "document.subscribed", rename_all = "camelCase")]
    DocumentSubscribed { file_id: String },
    #[serde(rename = "error", rename_all = "camelCase")]
    Error { code: ErrorCode, message: String },
    #[serde(rename = "pong")]
    Pong,
}

/// Binary document-frame message tags. A binary frame is
/// `[tag: u8][file_id: 16 bytes big-endian UUID][payload]`. Payloads are Yjs v1
/// encoded bytes: a state vector for `SYNC_STEP1`, an update for `SYNC_UPDATE`.
pub mod ws_message {
    pub const SYNC_STEP1: u8 = 1;
    pub const SYNC_UPDATE: u8 = 2;
    pub const AWARENESS: u8 = 3;
    /// Length of the fixed binary header (tag byte + 16-byte file id).
    pub const HEADER_LEN: usize = 1 + 16;
}

#[cfg(test)]
mod tests {
    use super::{
        capabilities_for_role, ApiError, Capability, DataResponse, ErrorCode, ErrorResponse,
        HostedVaultRole,
    };
    use serde_json::{json, Value};

    #[test]
    fn capability_tokens_roundtrip_through_serde_and_from_token() {
        for capability in Capability::ALL {
            let token = capability.as_token();
            assert_eq!(serde_json::to_value(capability).unwrap(), json!(token));
            assert_eq!(Capability::from_token(token), Some(capability));
        }
        assert_eq!(Capability::from_token("nope"), None);
        assert_eq!(
            serde_json::to_value(Capability::KanbanCardMove).unwrap(),
            json!("kanban.card.move")
        );
    }

    #[test]
    fn role_capability_sets_are_nested_and_admin_is_total() {
        let viewer = capabilities_for_role(HostedVaultRole::Viewer);
        let editor = capabilities_for_role(HostedVaultRole::Editor);
        let admin = capabilities_for_role(HostedVaultRole::Admin);
        assert!(viewer.iter().all(|cap| editor.contains(cap)));
        assert!(editor.iter().all(|cap| admin.contains(cap)));
        assert!(viewer.contains(&Capability::VaultRead));
        assert!(!viewer.contains(&Capability::FileWrite));
        assert!(!viewer.contains(&Capability::VaultOfflineCopy));
        assert!(editor.contains(&Capability::KanbanCardComment));
        assert!(editor.contains(&Capability::VaultOfflineCopy));
        assert!(!editor.contains(&Capability::VaultManageMembers));
        assert_eq!(admin.len(), Capability::ALL.len());
    }

    #[test]
    fn responses_use_camel_case_and_stable_snake_case_error_codes() {
        let response = ErrorResponse {
            error: ApiError {
                code: ErrorCode::VaultPermissionDenied,
                message: "denied".into(),
                request_id: "request-1".into(),
                details: Value::Null,
            },
        };

        assert_eq!(
            serde_json::to_value(response).unwrap(),
            json!({
                "error": {
                    "code": "vault_permission_denied",
                    "message": "denied",
                    "requestId": "request-1"
                }
            })
        );
    }

    #[test]
    fn data_response_wraps_payload() {
        assert_eq!(
            serde_json::to_value(DataResponse::new(json!({"ready": true}))).unwrap(),
            json!({"data": {"ready": true}})
        );
    }

    #[test]
    fn ws_control_frames_use_stable_tagged_wire_format() {
        use super::{WsClientControl, WsServerControl};

        // Client frames the browser provider sends.
        assert_eq!(
            serde_json::to_value(WsClientControl::Authenticate {
                ticket: "t".into(),
                protocol_version: Some(1),
            })
            .unwrap(),
            json!({"type": "authenticate", "ticket": "t", "protocolVersion": 1})
        );
        assert_eq!(
            serde_json::to_value(WsClientControl::DocumentSubscribe {
                file_id: "f".into(),
            })
            .unwrap(),
            json!({"type": "document.subscribe", "fileId": "f"})
        );

        // Server frames the browser provider must parse.
        assert_eq!(
            serde_json::to_value(WsServerControl::Ready {
                manifest_sequence: 7,
                protocol_version: 1,
                role: HostedVaultRole::Editor,
            })
            .unwrap(),
            json!({"type": "ready", "manifestSequence": 7, "protocolVersion": 1, "role": "editor"})
        );
        assert_eq!(
            serde_json::to_value(WsServerControl::Error {
                code: ErrorCode::VaultPermissionDenied,
                message: "no".into(),
            })
            .unwrap(),
            json!({"type": "error", "code": "vault_permission_denied", "message": "no"})
        );

        // Round-trips parse back from the wire form.
        let parsed: WsClientControl = serde_json::from_value(json!({"type": "ping"})).unwrap();
        assert_eq!(parsed, WsClientControl::Ping);
    }
}
