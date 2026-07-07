use crate::{
    app::AppState,
    auth::{
        administrator_exists, authenticate_native_access_token, authenticate_session,
        generate_secret, hash_password, hash_secret, normalize_username, user_from_row,
        validate_password, verify_password, AuthenticatedUser, CSRF_COOKIE, SESSION_COOKIE,
    },
};
use axum::{
    body::Body,
    extract::{Extension, Path, Query, State},
    http::{header, HeaderMap, HeaderValue, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use base64::{engine::general_purpose::STANDARD, Engine};
use collab_protocol::GrantSubjectType;
use collab_protocol::{
    capabilities_for_role, AdminBackupArtifactVerification, AdminBackupCommandResult,
    AdminBackupExportTarget, AdminBackupOverview, AdminBackupSchedule, AdminBackupSettings,
    AdminBackupSettingsLocks, AdminBackupSummary, AdminBackupVerification, AdminMaintenanceMode,
    AdminOverview, AdminRuntimeSetting, AdminRuntimeSettings, AdminServerSettings, ApiError,
    AuditEvent, BootstrapStatus, BrowserSession, Capability, CreatedInvitation, DataResponse,
    ErrorCode, ErrorResponse, HealthState, HostedChatMessage, HostedDocumentType, HostedFileEntry,
    HostedFileKind, HostedFileReference, HostedFileRevision, HostedFileState, HostedPdfAnnotations,
    HostedPresenceEntry, HostedReferenceImpact, HostedRevisionContent, HostedSearchResult,
    HostedSnapshot, HostedStructuralOperationPreview, HostedStructuralOperationResult,
    HostedStructuralOperationType, HostedTextDocument, HostedVault, HostedVaultActivityEvent,
    HostedVaultAdminDetail, HostedVaultImportResult, HostedVaultManifest, HostedVaultManifestDelta,
    HostedVaultMember, HostedVaultRole, HostedVaultStatus, HostedVaultStorage, HostedVaultSummary,
    Invitation, LiveCollaborationMetrics, MaintenanceReport, NativeSession, OperationalWarning,
    PermissionTemplate, ServerUser, ServerUserRole, StorageSummary, UserDirectoryEntry, UserGroup,
    UserGroupMember, VaultGrant, WritePdfAnnotationsRequest, WsTicket, WsTicketRequest,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use sqlx::{PgPool, Postgres, Row, Transaction};
use std::{
    collections::{HashMap, HashSet},
    fs,
    io::{Cursor, Read, Write},
    path::{Path as FsPath, PathBuf},
    process::Stdio,
    time::{Duration, SystemTime},
};
use tokio::{process::Command, time::timeout};
use uuid::Uuid;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateUserRequest {
    pub username: String,
    pub display_name: String,
    pub password: String,
    #[serde(default)]
    pub admin: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LoginRequest {
    pub username: String,
    pub password: String,
}

const BACKUP_FAILURE_LOOKBACK_HOURS: i64 = 24;
const CRDT_PENDING_UPDATE_WARNING_COUNT: i64 = 10_000;
const CRDT_PENDING_UPDATE_WARNING_BYTES: i64 = 64 * 1024 * 1024;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateUserRequest {
    pub display_name: Option<String>,
    pub username: Option<String>,
    pub disabled: Option<bool>,
    pub password: Option<String>,
    pub role: Option<ServerUserRole>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateInvitationRequest {
    pub username: String,
    pub display_name: String,
    #[serde(default)]
    pub admin: bool,
    #[serde(default = "default_invitation_hours")]
    pub expires_in_hours: i64,
}

fn default_invitation_hours() -> i64 {
    72
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AcceptInvitationRequest {
    pub password: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeLoginRequest {
    pub username: String,
    pub password: String,
    #[serde(default = "default_client_name")]
    pub client_name: String,
}

fn default_client_name() -> String {
    "Collab desktop".into()
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RefreshRequest {
    pub refresh_token: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChangePasswordRequest {
    pub current_password: String,
    pub new_password: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateSelfRequest {
    pub display_name: Option<String>,
    pub username: Option<String>,
    pub preferences: Option<Value>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UploadAvatarRequest {
    pub media_type: String,
    pub content_base64: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResetPasswordRequest {
    pub new_password: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateVaultRequest {
    pub name: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateVaultRequest {
    pub name: Option<String>,
    pub status: Option<HostedVaultStatus>,
    pub require_offline_copy: Option<bool>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AddVaultMemberRequest {
    pub user_id: Uuid,
    pub role: HostedVaultRole,
}

/// Updates a hosted-vault membership. Exactly one intent is applied per request,
/// checked in priority order:
/// - `reset_to_role_default` clears any override so the role default applies
///   (requires `vault.managePermissions`).
/// - `capabilities` sets an explicit fine-grained override (requires
///   `vault.managePermissions`).
/// - `template_id` assigns a permission template (requires
///   `vault.managePermissions`).
/// - `role` changes the legacy role and clears any override (requires
///   `vault.manageMembers`).
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateVaultMemberRequest {
    #[serde(default)]
    pub role: Option<HostedVaultRole>,
    #[serde(default)]
    pub capabilities: Option<Vec<String>>,
    #[serde(default)]
    pub template_id: Option<Uuid>,
    #[serde(default)]
    pub reset_to_role_default: Option<bool>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateGroupRequest {
    pub name: String,
    #[serde(default)]
    pub description: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateGroupRequest {
    pub name: Option<String>,
    pub description: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateTemplateRequest {
    pub name: String,
    #[serde(default)]
    pub description: Option<String>,
    pub capabilities: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateTemplateRequest {
    pub name: Option<String>,
    pub description: Option<String>,
    pub capabilities: Option<Vec<String>>,
}

/// Sets a fine-grained capability override on a vault grant. A grant resolves
/// from its explicit `capabilities` if present, else its `template_id`, else
/// (for direct user memberships only) the membership role. Supplying neither
/// for a group grant leaves the group with an empty capability set.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PutVaultGrantRequest {
    #[serde(default)]
    pub template_id: Option<Uuid>,
    #[serde(default)]
    pub capabilities: Option<Vec<String>>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateVaultFileRequest {
    pub parent_id: Option<Uuid>,
    pub name: String,
    pub kind: HostedFileKind,
    pub document_type: Option<HostedDocumentType>,
    #[serde(default)]
    pub content: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WriteTextRevisionRequest {
    pub expected_revision_sequence: i64,
    pub content: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateSnapshotRequest {
    pub revision_id: Option<Uuid>,
    pub label: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RestoreSnapshotRequest {
    pub expected_revision_sequence: i64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UploadBinaryAssetRequest {
    pub parent_id: Option<Uuid>,
    pub name: String,
    pub media_type: String,
    pub content_base64: String,
    pub expected_hash: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StructuralOperationRequest {
    pub client_operation_id: Uuid,
    pub base_manifest_sequence: i64,
    pub operation_type: HostedStructuralOperationType,
    pub target_file_id: Uuid,
    pub name: Option<String>,
    pub parent_id: Option<Uuid>,
    #[serde(default)]
    pub remove_references: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StructuralOperationPreviewRequest {
    pub operation_type: HostedStructuralOperationType,
    pub target_file_id: Uuid,
    pub name: Option<String>,
    pub parent_id: Option<Uuid>,
}

#[derive(Debug, Deserialize)]
pub struct VaultSearchQuery {
    pub q: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatQuery {
    pub limit: Option<i64>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SendChatMessageRequest {
    pub id: Uuid,
    pub content: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WritePresenceRequest {
    pub active_file: Option<String>,
    pub cursor_line: Option<i32>,
    pub chat_typing_until: Option<u64>,
    pub app_version: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ManifestDeltaQuery {
    pub since: i64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportVaultZipRequest {
    pub archive_base64: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportBackupArchiveRequest {
    pub archive_base64: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RestoreBackupRequest {
    pub confirmation: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateBackupSettingsRequest {
    pub schedule_enabled: bool,
    pub interval_seconds: u64,
    pub retention_days: u64,
    pub export_dir: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateRuntimeSettingsRequest {
    pub browser_secure_cookies: Option<bool>,
    pub session_ttl_hours: Option<i64>,
    pub native_access_ttl_minutes: Option<i64>,
    pub native_refresh_ttl_days: Option<i64>,
    pub ws_ticket_ttl_seconds: Option<i64>,
    #[serde(default, deserialize_with = "deserialize_opt_byte_size")]
    pub max_file_bytes: Option<u64>,
    #[serde(default, deserialize_with = "deserialize_opt_byte_size")]
    pub max_import_bytes: Option<u64>,
    #[serde(default, deserialize_with = "deserialize_opt_byte_size")]
    pub max_import_expanded_bytes: Option<u64>,
    #[serde(default, deserialize_with = "deserialize_opt_byte_size")]
    pub storage_warning_bytes: Option<u64>,
    #[serde(default, deserialize_with = "deserialize_opt_byte_size")]
    pub storage_quota_bytes: Option<u64>,
    pub revision_history_limit: Option<u64>,
    #[serde(default, deserialize_with = "deserialize_opt_byte_size")]
    pub revision_storage_target_bytes: Option<u64>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateMaintenanceModeRequest {
    pub enabled: bool,
    pub message: Option<String>,
}

/// Accepts a byte-size value from JSON as either a number (`268435456`) or a
/// human-readable string (`"256 MiB"`), parsed by [`crate::config::parse_byte_size`].
fn deserialize_opt_byte_size<'de, D>(deserializer: D) -> Result<Option<u64>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    #[derive(Deserialize)]
    #[serde(untagged)]
    enum ByteSizeInput {
        Int(u64),
        Str(String),
    }
    match Option::<ByteSizeInput>::deserialize(deserializer)? {
        None => Ok(None),
        Some(ByteSizeInput::Int(value)) => Ok(Some(value)),
        Some(ByteSizeInput::Str(raw)) => crate::config::parse_byte_size(&raw)
            .map(Some)
            .map_err(|_| serde::de::Error::custom(format!("invalid byte size: {raw}"))),
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateServerSettingsRequest {
    pub runtime: Option<UpdateRuntimeSettingsRequest>,
    pub backup: Option<UpdateBackupSettingsRequest>,
    pub maintenance: Option<UpdateMaintenanceModeRequest>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteFileRevisionsRequest {
    #[serde(default)]
    pub revision_ids: Vec<Uuid>,
    #[serde(default)]
    pub all: bool,
}

pub async fn bootstrap_status(
    State(state): State<AppState>,
    Extension(request_id): Extension<String>,
) -> Result<Response, ApiFailure> {
    let required = !administrator_exists(&state.database)
        .await
        .map_err(|_| ApiFailure::server(request_id))?;
    let mut response = Json(DataResponse::new(BootstrapStatus { required })).into_response();
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    Ok(response)
}

pub async fn bootstrap(
    State(state): State<AppState>,
    Extension(request_id): Extension<String>,
    headers: HeaderMap,
    Json(payload): Json<CreateUserRequest>,
) -> Result<Response, ApiFailure> {
    let mut transaction = state
        .database
        .begin()
        .await
        .map_err(|_| ApiFailure::server(request_id.clone()))?;
    sqlx::query("SELECT pg_advisory_xact_lock(7302026)")
        .execute(&mut *transaction)
        .await
        .map_err(|_| ApiFailure::server(request_id.clone()))?;
    if administrator_exists_transaction(&mut transaction)
        .await
        .map_err(|_| ApiFailure::server(request_id.clone()))?
    {
        return Err(ApiFailure::new(
            StatusCode::CONFLICT,
            ErrorCode::BootstrapAlreadyCompleted,
            "The first administrator has already been created.",
            request_id,
        ));
    }
    let mut user = insert_user(&mut transaction, &payload, true, &request_id).await?;
    sqlx::query("UPDATE users SET is_primary_admin = TRUE WHERE id = $1")
        .bind(Uuid::parse_str(&user.id).expect("database UUID is valid"))
        .execute(&mut *transaction)
        .await
        .map_err(|_| ApiFailure::server(request_id.clone()))?;
    user.is_primary_admin = true;
    audit(
        &mut transaction,
        Some(&user.id),
        "admin.bootstrap",
        Some("user"),
        Some(&user.id),
        "success",
        &request_id,
        json!({}),
    )
    .await?;
    transaction
        .commit()
        .await
        .map_err(|_| ApiFailure::server(request_id.clone()))?;
    create_browser_session(&state, &headers, user, &request_id).await
}

pub async fn login(
    State(state): State<AppState>,
    Extension(request_id): Extension<String>,
    headers: HeaderMap,
    Json(payload): Json<LoginRequest>,
) -> Result<Response, ApiFailure> {
    let normalized = normalize_username(&payload.username).map_err(|error| {
        ApiFailure::new(
            StatusCode::UNAUTHORIZED,
            ErrorCode::AuthenticationInvalid,
            error.to_string(),
            request_id.clone(),
        )
    })?;
    if !state.login_limiter.allow(&normalized).await {
        return Err(ApiFailure::new(
            StatusCode::TOO_MANY_REQUESTS,
            ErrorCode::RateLimited,
            "Too many login attempts. Try again shortly.",
            request_id,
        ));
    }

    let row = sqlx::query(
        r#"
        SELECT u.id, u.username, u.display_name, u.role::text AS role, u.status::text AS status,
               u.created_at, u.last_login_at, u.is_primary_admin, c.password_hash,
               (SELECT COUNT(*) FROM sessions active
                WHERE active.user_id = u.id AND active.revoked_at IS NULL AND active.expires_at > NOW())
                AS active_sessions
        FROM users u JOIN credentials c ON c.user_id = u.id
        WHERE u.normalized_username = $1
        "#,
    )
    .bind(&normalized)
    .fetch_optional(&state.database)
    .await
    .map_err(|_| ApiFailure::server(request_id.clone()))?;

    let valid = row
        .as_ref()
        .map(|row| {
            row.get::<String, _>("status") == "active"
                && verify_password(
                    &payload.password,
                    row.get::<String, _>("password_hash").as_str(),
                )
        })
        .unwrap_or(false);
    if !valid {
        record_audit(
            &state.database,
            None,
            "auth.login",
            None,
            None,
            "failure",
            &request_id,
            json!({"username": normalized}),
        )
        .await?;
        return Err(ApiFailure::new(
            StatusCode::UNAUTHORIZED,
            ErrorCode::AuthenticationInvalid,
            "The username or password is incorrect.",
            request_id,
        ));
    }

    state.login_limiter.clear(&normalized).await;
    let user = user_from_row(row.as_ref().expect("validated row exists"));
    sqlx::query("UPDATE users SET last_login_at = NOW(), updated_at = NOW() WHERE id = $1")
        .bind(Uuid::parse_str(&user.id).expect("database UUID is valid"))
        .execute(&state.database)
        .await
        .map_err(|_| ApiFailure::server(request_id.clone()))?;
    record_audit(
        &state.database,
        Some(&user.id),
        "auth.login",
        Some("user"),
        Some(&user.id),
        "success",
        &request_id,
        json!({}),
    )
    .await?;
    create_browser_session(&state, &headers, user, &request_id).await
}

pub async fn me(
    State(state): State<AppState>,
    Extension(request_id): Extension<String>,
    headers: HeaderMap,
) -> Result<Json<DataResponse<ServerUser>>, ApiFailure> {
    let authenticated = require_user(&state, &headers, &request_id).await?;
    Ok(Json(DataResponse::new(authenticated.user)))
}

/// Read-only user directory available to any authenticated user. Vault admins use
/// it to resolve a person to a user account when managing hosted-vault membership;
/// it never exposes credentials, status, or roles. Fits the single-trusted-org model.
pub async fn user_directory(
    State(state): State<AppState>,
    Extension(request_id): Extension<String>,
    headers: HeaderMap,
    Query(query): Query<VaultSearchQuery>,
) -> Result<Json<DataResponse<Vec<UserDirectoryEntry>>>, ApiFailure> {
    require_authenticated_user(&state, &headers, &request_id).await?;
    let needle = query.q.trim();
    if needle.chars().count() > 200 {
        return Err(ApiFailure::validation(
            "Directory queries must be at most 200 characters.",
            request_id,
        ));
    }
    let rows = sqlx::query(
        r#"
        SELECT id, username, display_name
        FROM users
        WHERE status = 'active'
          AND ($1 = '' OR username ILIKE $2 OR display_name ILIKE $2)
        ORDER BY display_name ASC
        LIMIT 25
        "#,
    )
    .bind(needle)
    .bind(format!("%{needle}%"))
    .fetch_all(&state.database)
    .await
    .map_err(|_| ApiFailure::server(request_id.clone()))?;
    Ok(Json(DataResponse::new(
        rows.iter()
            .map(|row| UserDirectoryEntry {
                user_id: row.get::<Uuid, _>("id").to_string(),
                username: row.get("username"),
                display_name: row.get("display_name"),
            })
            .collect(),
    )))
}

pub async fn logout(
    State(state): State<AppState>,
    Extension(request_id): Extension<String>,
    headers: HeaderMap,
) -> Result<Response, ApiFailure> {
    let authenticated = require_csrf(&state, &headers, &request_id).await?;
    sqlx::query("UPDATE sessions SET revoked_at = NOW() WHERE id = $1")
        .bind(authenticated.session_id)
        .execute(&state.database)
        .await
        .map_err(|_| ApiFailure::server(request_id.clone()))?;
    record_audit(
        &state.database,
        Some(&authenticated.user.id),
        "auth.logout",
        Some("session"),
        Some(&authenticated.session_id.to_string()),
        "success",
        &request_id,
        json!({}),
    )
    .await?;
    let mut response = StatusCode::NO_CONTENT.into_response();
    let settings = load_effective_runtime_settings(&state.config);
    append_expired_cookie(
        &mut response,
        SESSION_COOKIE,
        settings.browser_secure_cookies,
    );
    append_expired_cookie(&mut response, CSRF_COOKIE, settings.browser_secure_cookies);
    Ok(response)
}

pub async fn native_login(
    State(state): State<AppState>,
    Extension(request_id): Extension<String>,
    Json(payload): Json<NativeLoginRequest>,
) -> Result<Json<DataResponse<NativeSession>>, ApiFailure> {
    let user =
        authenticate_password(&state, &payload.username, &payload.password, &request_id).await?;
    let session = create_native_session(&state, user, &payload.client_name, &request_id).await?;
    Ok(Json(DataResponse::new(session)))
}

pub async fn refresh(
    State(state): State<AppState>,
    Extension(request_id): Extension<String>,
    Json(payload): Json<RefreshRequest>,
) -> Result<Json<DataResponse<NativeSession>>, ApiFailure> {
    let token_hash = hash_secret(&payload.refresh_token);
    let mut transaction = state
        .database
        .begin()
        .await
        .map_err(|_| ApiFailure::server(request_id.clone()))?;
    let row = sqlx::query(
        r#"
        SELECT s.id AS session_id, s.user_id, s.refresh_token_hash, s.previous_refresh_token_hash,
               s.client_name, s.refresh_expires_at, s.revoked_at,
               u.id, u.username, u.display_name, u.role::text AS role, u.status::text AS status,
               u.created_at, u.last_login_at, u.is_primary_admin,
               ((SELECT COUNT(*) FROM sessions active WHERE active.user_id = u.id AND active.revoked_at IS NULL AND active.expires_at > NOW())
                + (SELECT COUNT(*) FROM native_sessions active WHERE active.user_id = u.id AND active.revoked_at IS NULL AND active.refresh_expires_at > NOW()))
                AS active_sessions
        FROM native_sessions s JOIN users u ON u.id = s.user_id
        WHERE s.refresh_token_hash = $1 OR s.previous_refresh_token_hash = $1
        FOR UPDATE OF s
        "#,
    )
    .bind(&token_hash)
    .fetch_optional(&mut *transaction)
    .await
    .map_err(|_| ApiFailure::server(request_id.clone()))?
    .ok_or_else(|| ApiFailure::authentication_required(request_id.clone()))?;

    let session_id: Uuid = row.get("session_id");
    let current_hash: String = row.get("refresh_token_hash");
    let active = row
        .get::<Option<chrono::DateTime<chrono::Utc>>, _>("revoked_at")
        .is_none()
        && row.get::<chrono::DateTime<chrono::Utc>, _>("refresh_expires_at") > chrono::Utc::now()
        && row.get::<String, _>("status") == "active";
    if token_hash != current_hash {
        sqlx::query("UPDATE native_sessions SET revoked_at = NOW() WHERE id = $1")
            .bind(session_id)
            .execute(&mut *transaction)
            .await
            .map_err(|_| ApiFailure::server(request_id.clone()))?;
        transaction
            .commit()
            .await
            .map_err(|_| ApiFailure::server(request_id.clone()))?;
        return Err(ApiFailure::new(
            StatusCode::UNAUTHORIZED,
            ErrorCode::SessionRevoked,
            "The refresh token has already been used.",
            request_id,
        ));
    }
    if !active {
        return Err(ApiFailure::new(
            StatusCode::UNAUTHORIZED,
            ErrorCode::SessionExpired,
            "The session has expired or was revoked.",
            request_id,
        ));
    }

    let user = user_from_row(&row);
    let access_token = generate_secret();
    let refresh_token = generate_secret();
    let settings = load_effective_runtime_settings(&state.config);
    let access_expires_at =
        chrono::Utc::now() + chrono::Duration::minutes(settings.native_access_ttl_minutes);
    let refresh_expires_at =
        chrono::Utc::now() + chrono::Duration::days(settings.native_refresh_ttl_days);
    let rotated = sqlx::query(
        r#"
        UPDATE native_sessions SET access_token_hash = $1, previous_refresh_token_hash = refresh_token_hash,
          refresh_token_hash = $2, access_expires_at = $3, refresh_expires_at = $4, last_seen_at = NOW()
        WHERE id = $5
        "#,
    )
    .bind(hash_secret(&access_token))
    .bind(hash_secret(&refresh_token))
    .bind(access_expires_at)
    .bind(refresh_expires_at)
    .bind(session_id)
    .execute(&mut *transaction)
    .await
    .map_err(|_| ApiFailure::server(request_id.clone()))?;
    if rotated.rows_affected() != 1 {
        return Err(ApiFailure::server(request_id));
    }
    audit(
        &mut transaction,
        Some(&user.id),
        "auth.native.refresh",
        Some("session"),
        Some(&session_id.to_string()),
        "success",
        &request_id,
        json!({}),
    )
    .await?;
    transaction
        .commit()
        .await
        .map_err(|_| ApiFailure::server(request_id.clone()))?;
    Ok(Json(DataResponse::new(NativeSession {
        user,
        access_token,
        refresh_token,
        access_expires_at: access_expires_at.to_rfc3339(),
        refresh_expires_at: refresh_expires_at.to_rfc3339(),
    })))
}

pub async fn native_logout(
    State(state): State<AppState>,
    Extension(request_id): Extension<String>,
    headers: HeaderMap,
) -> Result<StatusCode, ApiFailure> {
    let authenticated = require_native_user(&state, &headers, &request_id).await?;
    sqlx::query("UPDATE native_sessions SET revoked_at = NOW() WHERE id = $1")
        .bind(authenticated.session_id)
        .execute(&state.database)
        .await
        .map_err(|_| ApiFailure::server(request_id.clone()))?;
    record_audit(
        &state.database,
        Some(&authenticated.user.id),
        "auth.native.logout",
        Some("session"),
        Some(&authenticated.session_id.to_string()),
        "success",
        &request_id,
        json!({}),
    )
    .await?;
    Ok(StatusCode::NO_CONTENT)
}

pub async fn change_password(
    State(state): State<AppState>,
    Extension(request_id): Extension<String>,
    headers: HeaderMap,
    Json(payload): Json<ChangePasswordRequest>,
) -> Result<StatusCode, ApiFailure> {
    let authenticated = require_any_user(&state, &headers, &request_id).await?;
    let hash =
        sqlx::query_scalar::<_, String>("SELECT password_hash FROM credentials WHERE user_id = $1")
            .bind(Uuid::parse_str(&authenticated.user.id).expect("database UUID is valid"))
            .fetch_one(&state.database)
            .await
            .map_err(|_| ApiFailure::server(request_id.clone()))?;
    if !verify_password(&payload.current_password, &hash) {
        return Err(ApiFailure::new(
            StatusCode::UNAUTHORIZED,
            ErrorCode::AuthenticationInvalid,
            "The current password is incorrect.",
            request_id,
        ));
    }
    replace_password_and_revoke(
        &state.database,
        Uuid::parse_str(&authenticated.user.id).unwrap(),
        &payload.new_password,
        Some(authenticated.session_id),
        &request_id,
    )
    .await?;
    record_audit(
        &state.database,
        Some(&authenticated.user.id),
        "auth.password.change",
        Some("user"),
        Some(&authenticated.user.id),
        "success",
        &request_id,
        json!({}),
    )
    .await?;
    Ok(StatusCode::NO_CONTENT)
}

/// Re-reads a user's full profile (including preferences and avatar presence)
/// for the response of a profile mutation.
async fn fetch_user_profile(
    pool: &PgPool,
    user_id: Uuid,
    request_id: &str,
) -> Result<ServerUser, ApiFailure> {
    let row = sqlx::query(
        r#"
        SELECT u.id, u.username, u.display_name, u.role::text AS role, u.status::text AS status,
               u.created_at, u.last_login_at, u.is_primary_admin, u.preferences,
               (u.avatar_bytes IS NOT NULL) AS has_avatar, u.avatar_updated_at,
               0::bigint AS active_sessions
        FROM users u WHERE u.id = $1
        "#,
    )
    .bind(user_id)
    .fetch_optional(pool)
    .await
    .map_err(|_| ApiFailure::server(request_id.to_owned()))?
    .ok_or_else(|| ApiFailure::not_found(request_id.to_owned()))?;
    Ok(crate::auth::user_from_row(&row))
}

/// Lets the signed-in user update their own display name, username, and UI
/// preferences. Username changes are uniqueness-checked; password changes stay
/// on the dedicated `/users/me/password` endpoint.
pub async fn update_self(
    State(state): State<AppState>,
    Extension(request_id): Extension<String>,
    headers: HeaderMap,
    Json(payload): Json<UpdateSelfRequest>,
) -> Result<Json<DataResponse<ServerUser>>, ApiFailure> {
    let authenticated = require_csrf(&state, &headers, &request_id).await?;
    let user_id = user_uuid(&authenticated.user);
    if let Some(username) = payload.username.as_deref() {
        let normalized = normalize_username(username)
            .map_err(|error| ApiFailure::validation(error.to_string(), request_id.clone()))?;
        let taken = sqlx::query_scalar::<_, bool>(
            "SELECT EXISTS(SELECT 1 FROM users WHERE normalized_username = $1 AND id <> $2)",
        )
        .bind(&normalized)
        .bind(user_id)
        .fetch_one(&state.database)
        .await
        .map_err(|_| ApiFailure::server(request_id.clone()))?;
        if taken {
            return Err(ApiFailure::validation(
                "That username is already in use.",
                request_id,
            ));
        }
        sqlx::query("UPDATE users SET username = $1, normalized_username = $2, updated_at = NOW() WHERE id = $3")
            .bind(username.trim())
            .bind(&normalized)
            .bind(user_id)
            .execute(&state.database)
            .await
            .map_err(|_| ApiFailure::server(request_id.clone()))?;
    }
    if let Some(display_name) = payload.display_name.as_deref() {
        let trimmed = display_name.trim();
        if trimmed.is_empty() {
            return Err(ApiFailure::validation(
                "A display name is required.",
                request_id,
            ));
        }
        sqlx::query("UPDATE users SET display_name = $1, updated_at = NOW() WHERE id = $2")
            .bind(trimmed)
            .bind(user_id)
            .execute(&state.database)
            .await
            .map_err(|_| ApiFailure::server(request_id.clone()))?;
    }
    if let Some(preferences) = payload.preferences {
        if !preferences.is_object() {
            return Err(ApiFailure::validation(
                "Preferences must be a JSON object.",
                request_id,
            ));
        }
        sqlx::query("UPDATE users SET preferences = $1, updated_at = NOW() WHERE id = $2")
            .bind(preferences)
            .bind(user_id)
            .execute(&state.database)
            .await
            .map_err(|_| ApiFailure::server(request_id.clone()))?;
    }
    let user = fetch_user_profile(&state.database, user_id, &request_id).await?;
    Ok(Json(DataResponse::new(user)))
}

const MAX_AVATAR_BYTES: usize = 1024 * 1024;

/// Stores a small avatar image inline on the user row. Bounded in size and
/// restricted to common web image types; never enters the vault blob store.
pub async fn upload_self_avatar(
    State(state): State<AppState>,
    Extension(request_id): Extension<String>,
    headers: HeaderMap,
    Json(payload): Json<UploadAvatarRequest>,
) -> Result<Json<DataResponse<ServerUser>>, ApiFailure> {
    let authenticated = require_csrf(&state, &headers, &request_id).await?;
    let user_id = user_uuid(&authenticated.user);
    if !matches!(
        payload.media_type.as_str(),
        "image/png" | "image/jpeg" | "image/webp" | "image/gif"
    ) {
        return Err(ApiFailure::validation(
            "Avatars must be a PNG, JPEG, WebP, or GIF image.",
            request_id,
        ));
    }
    let bytes = STANDARD
        .decode(payload.content_base64.trim())
        .map_err(|_| {
            ApiFailure::validation("The avatar image could not be decoded.", request_id.clone())
        })?;
    if bytes.is_empty() || bytes.len() > MAX_AVATAR_BYTES {
        return Err(ApiFailure::validation(
            "Avatars must be between 1 byte and 1 MB.",
            request_id,
        ));
    }
    sqlx::query(
        "UPDATE users SET avatar_bytes = $1, avatar_media_type = $2, avatar_updated_at = NOW(), updated_at = NOW() WHERE id = $3",
    )
    .bind(&bytes)
    .bind(&payload.media_type)
    .bind(user_id)
    .execute(&state.database)
    .await
    .map_err(|_| ApiFailure::server(request_id.clone()))?;
    let user = fetch_user_profile(&state.database, user_id, &request_id).await?;
    Ok(Json(DataResponse::new(user)))
}

pub async fn delete_self_avatar(
    State(state): State<AppState>,
    Extension(request_id): Extension<String>,
    headers: HeaderMap,
) -> Result<Json<DataResponse<ServerUser>>, ApiFailure> {
    let authenticated = require_csrf(&state, &headers, &request_id).await?;
    let user_id = user_uuid(&authenticated.user);
    sqlx::query(
        "UPDATE users SET avatar_bytes = NULL, avatar_media_type = NULL, avatar_updated_at = NULL, updated_at = NOW() WHERE id = $1",
    )
    .bind(user_id)
    .execute(&state.database)
    .await
    .map_err(|_| ApiFailure::server(request_id.clone()))?;
    let user = fetch_user_profile(&state.database, user_id, &request_id).await?;
    Ok(Json(DataResponse::new(user)))
}

/// Serves a user's avatar image. Available to any authenticated user so avatars
/// can be shown across the admin interface.
pub async fn get_user_avatar(
    State(state): State<AppState>,
    Extension(request_id): Extension<String>,
    headers: HeaderMap,
    Path(user_id): Path<Uuid>,
) -> Result<Response, ApiFailure> {
    require_authenticated_user(&state, &headers, &request_id).await?;
    let row = sqlx::query("SELECT avatar_bytes, avatar_media_type FROM users WHERE id = $1")
        .bind(user_id)
        .fetch_optional(&state.database)
        .await
        .map_err(|_| ApiFailure::server(request_id.clone()))?
        .ok_or_else(|| ApiFailure::not_found(request_id.clone()))?;
    let bytes: Option<Vec<u8>> = row.get("avatar_bytes");
    let media_type: Option<String> = row.get("avatar_media_type");
    let bytes = bytes.ok_or_else(|| ApiFailure::not_found(request_id.clone()))?;
    let mut response = Response::new(Body::from(bytes));
    response.headers_mut().insert(
        header::CONTENT_TYPE,
        HeaderValue::from_str(media_type.as_deref().unwrap_or("image/png"))
            .unwrap_or_else(|_| HeaderValue::from_static("image/png")),
    );
    response.headers_mut().insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("private, max-age=300"),
    );
    Ok(response)
}

pub async fn list_vaults(
    State(state): State<AppState>,
    Extension(request_id): Extension<String>,
    headers: HeaderMap,
) -> Result<Json<DataResponse<Vec<HostedVault>>>, ApiFailure> {
    let actor = require_authenticated_user(&state, &headers, &request_id).await?;
    let actor_id = user_uuid(&actor.user);
    let rows = sqlx::query(
        r#"
        SELECT v.id, v.name, v.owner_user_id, owner.display_name AS owner_display_name,
               v.status::text AS status, v.manifest_sequence, v.require_offline_copy,
               v.created_at, v.updated_at,
               (SELECT COUNT(*) FROM hosted_vault_memberships members WHERE members.vault_id = v.id) AS members,
               COALESCE((SELECT SUM(r.size_bytes) FROM hosted_file_revisions r WHERE r.vault_id = v.id), 0)::bigint AS storage_bytes
        FROM hosted_vaults v
        JOIN users actor ON actor.id = $1
        LEFT JOIN hosted_vault_memberships m ON m.vault_id = v.id AND m.user_id = actor.id
        JOIN users owner ON owner.id = v.owner_user_id
        WHERE m.user_id IS NOT NULL
           OR actor.role = 'admin'
           OR EXISTS (
                SELECT 1 FROM hosted_vault_group_grants g
                JOIN user_group_memberships ugm ON ugm.group_id = g.group_id
                WHERE g.vault_id = v.id AND ugm.user_id = actor.id
           )
        ORDER BY v.updated_at DESC
        "#,
    )
    .bind(actor_id)
    .fetch_all(&state.database)
    .await
    .map_err(|_| ApiFailure::server(request_id.clone()))?;
    let mut vaults = Vec::with_capacity(rows.len());
    for row in &rows {
        let mut vault = vault_from_row_without_role(row);
        let vault_uuid: Uuid = row.get("id");
        let access =
            resolve_vault_capabilities(&state.database, vault_uuid, actor_id, &request_id).await?;
        vault.role = access.derived_role();
        vault.capabilities = access.capability_tokens();
        vaults.push(vault);
    }
    Ok(Json(DataResponse::new(vaults)))
}

pub async fn create_vault(
    State(state): State<AppState>,
    Extension(request_id): Extension<String>,
    headers: HeaderMap,
    Json(payload): Json<CreateVaultRequest>,
) -> Result<(StatusCode, Json<DataResponse<HostedVault>>), ApiFailure> {
    let actor = require_any_user(&state, &headers, &request_id).await?;
    let name = validate_vault_name(&payload.name, &request_id)?;
    let vault_id = Uuid::now_v7();
    let actor_id = user_uuid(&actor.user);
    let mut transaction = state
        .database
        .begin()
        .await
        .map_err(|_| ApiFailure::server(request_id.clone()))?;
    sqlx::query("INSERT INTO hosted_vaults (id, name, owner_user_id) VALUES ($1, $2, $3)")
        .bind(vault_id)
        .bind(&name)
        .bind(actor_id)
        .execute(&mut *transaction)
        .await
        .map_err(|_| ApiFailure::server(request_id.clone()))?;
    sqlx::query(
        "INSERT INTO hosted_vault_memberships (vault_id, user_id, role) VALUES ($1, $2, 'admin')",
    )
    .bind(vault_id)
    .bind(actor_id)
    .execute(&mut *transaction)
    .await
    .map_err(|_| ApiFailure::server(request_id.clone()))?;
    vault_activity_event(
        &mut transaction,
        vault_id,
        Some(actor_id),
        "vault.created",
        Some("vault"),
        Some(&vault_id.to_string()),
        json!({}),
        &request_id,
    )
    .await?;
    audit(
        &mut transaction,
        Some(&actor.user.id),
        "vault.create",
        Some("vault"),
        Some(&vault_id.to_string()),
        "success",
        &request_id,
        json!({}),
    )
    .await?;
    transaction
        .commit()
        .await
        .map_err(|_| ApiFailure::server(request_id.clone()))?;
    Ok((
        StatusCode::CREATED,
        Json(DataResponse::new(
            load_vault(&state.database, vault_id, actor_id, &request_id).await?,
        )),
    ))
}

pub async fn get_vault(
    State(state): State<AppState>,
    Extension(request_id): Extension<String>,
    headers: HeaderMap,
    Path(vault_id): Path<Uuid>,
) -> Result<Json<DataResponse<HostedVault>>, ApiFailure> {
    let actor = require_authenticated_user(&state, &headers, &request_id).await?;
    Ok(Json(DataResponse::new(
        load_vault(
            &state.database,
            vault_id,
            user_uuid(&actor.user),
            &request_id,
        )
        .await?,
    )))
}

pub async fn update_vault(
    State(state): State<AppState>,
    Extension(request_id): Extension<String>,
    headers: HeaderMap,
    Path(vault_id): Path<Uuid>,
    Json(payload): Json<UpdateVaultRequest>,
) -> Result<Json<DataResponse<HostedVault>>, ApiFailure> {
    let actor = require_any_user(&state, &headers, &request_id).await?;
    let access = require_vault_access(
        &state.database,
        vault_id,
        user_uuid(&actor.user),
        HostedVaultRole::Admin,
        &request_id,
    )
    .await?;
    let name = payload
        .name
        .as_deref()
        .map(|value| validate_vault_name(value, &request_id))
        .transpose()?;
    if payload.status == Some(HostedVaultStatus::PendingDelete) {
        return Err(ApiFailure::validation(
            "Use DELETE to mark a vault for deletion.",
            request_id,
        ));
    }
    if payload.status.is_some() && !access.owner {
        return Err(ApiFailure::vault_permission_denied(request_id));
    }
    let reactivating = access.status == HostedVaultStatus::Archived
        && payload.status == Some(HostedVaultStatus::Active)
        && name.is_none();
    if access.status != HostedVaultStatus::Active && !reactivating {
        return Err(ApiFailure::vault_archived(request_id));
    }
    let status = payload.status.map(vault_status_name);
    let mut transaction = state
        .database
        .begin()
        .await
        .map_err(|_| ApiFailure::server(request_id.clone()))?;
    sqlx::query(
        r#"
        UPDATE hosted_vaults SET
          name = COALESCE($1, name),
          status = COALESCE($2::hosted_vault_status, status),
          require_offline_copy = COALESCE($3, require_offline_copy),
          archived_at = CASE
            WHEN $2 = 'archived' THEN NOW()
            WHEN $2 = 'active' THEN NULL
            ELSE archived_at
          END,
          updated_at = NOW()
        WHERE id = $4
        "#,
    )
    .bind(name.as_deref())
    .bind(status)
    .bind(payload.require_offline_copy)
    .bind(vault_id)
    .execute(&mut *transaction)
    .await
    .map_err(|_| ApiFailure::server(request_id.clone()))?;
    vault_activity_event(
        &mut transaction,
        vault_id,
        Some(user_uuid(&actor.user)),
        if payload.status.is_some() {
            "vault.status_changed"
        } else if payload.require_offline_copy.is_some() {
            "vault.settings_changed"
        } else {
            "vault.renamed"
        },
        Some("vault"),
        Some(&vault_id.to_string()),
        json!({"status": status, "name": name, "requireOfflineCopy": payload.require_offline_copy}),
        &request_id,
    )
    .await?;
    transaction
        .commit()
        .await
        .map_err(|_| ApiFailure::server(request_id.clone()))?;
    Ok(Json(DataResponse::new(
        load_vault(
            &state.database,
            vault_id,
            user_uuid(&actor.user),
            &request_id,
        )
        .await?,
    )))
}

pub async fn delete_vault(
    State(state): State<AppState>,
    Extension(request_id): Extension<String>,
    headers: HeaderMap,
    Path(vault_id): Path<Uuid>,
) -> Result<StatusCode, ApiFailure> {
    let actor = require_any_user(&state, &headers, &request_id).await?;
    let access = require_vault_access(
        &state.database,
        vault_id,
        user_uuid(&actor.user),
        HostedVaultRole::Admin,
        &request_id,
    )
    .await?;
    if !access.owner {
        return Err(ApiFailure::vault_permission_denied(request_id));
    }
    let mut transaction = state
        .database
        .begin()
        .await
        .map_err(|_| ApiFailure::server(request_id.clone()))?;
    sqlx::query(
        "UPDATE hosted_vaults SET status = 'pending_delete', pending_delete_at = NOW(), updated_at = NOW() WHERE id = $1",
    )
    .bind(vault_id)
    .execute(&mut *transaction)
    .await
    .map_err(|_| ApiFailure::server(request_id.clone()))?;
    vault_activity_event(
        &mut transaction,
        vault_id,
        Some(user_uuid(&actor.user)),
        "vault.pending_delete",
        Some("vault"),
        Some(&vault_id.to_string()),
        json!({}),
        &request_id,
    )
    .await?;
    transaction
        .commit()
        .await
        .map_err(|_| ApiFailure::server(request_id))?;
    Ok(StatusCode::NO_CONTENT)
}

pub async fn list_vault_members(
    State(state): State<AppState>,
    Extension(request_id): Extension<String>,
    headers: HeaderMap,
    Path(vault_id): Path<Uuid>,
) -> Result<Json<DataResponse<Vec<HostedVaultMember>>>, ApiFailure> {
    let actor = require_authenticated_user(&state, &headers, &request_id).await?;
    require_capability(
        &state.database,
        vault_id,
        user_uuid(&actor.user),
        Capability::VaultRead,
        &request_id,
    )
    .await?;
    Ok(Json(DataResponse::new(
        load_vault_members(&state.database, vault_id, &request_id).await?,
    )))
}

/// Lists permission templates for a vault admin so the native member editor can
/// offer template assignment. Authorized by `vault.managePermissions`; template
/// CRUD remains a server-admin-only operation under `/api/v1/admin/templates`.
pub async fn list_vault_templates(
    State(state): State<AppState>,
    Extension(request_id): Extension<String>,
    headers: HeaderMap,
    Path(vault_id): Path<Uuid>,
) -> Result<Json<DataResponse<Vec<PermissionTemplate>>>, ApiFailure> {
    let actor = require_authenticated_user(&state, &headers, &request_id).await?;
    require_capability(
        &state.database,
        vault_id,
        user_uuid(&actor.user),
        Capability::VaultManagePermissions,
        &request_id,
    )
    .await?;
    Ok(Json(DataResponse::new(
        load_templates(&state.database, &request_id).await?,
    )))
}

pub async fn list_chat_messages(
    State(state): State<AppState>,
    Extension(request_id): Extension<String>,
    headers: HeaderMap,
    Path(vault_id): Path<Uuid>,
    Query(query): Query<ChatQuery>,
) -> Result<Json<DataResponse<Vec<HostedChatMessage>>>, ApiFailure> {
    let actor = require_authenticated_user(&state, &headers, &request_id).await?;
    require_capability(
        &state.database,
        vault_id,
        user_uuid(&actor.user),
        Capability::VaultRead,
        &request_id,
    )
    .await?;
    let limit = query.limit.unwrap_or(100).clamp(1, 500);
    Ok(Json(DataResponse::new(
        load_chat_messages(&state.database, vault_id, limit, &request_id).await?,
    )))
}

pub async fn list_presence(
    State(state): State<AppState>,
    Extension(request_id): Extension<String>,
    headers: HeaderMap,
    Path(vault_id): Path<Uuid>,
) -> Result<Json<DataResponse<Vec<HostedPresenceEntry>>>, ApiFailure> {
    let actor = require_authenticated_user(&state, &headers, &request_id).await?;
    require_capability(
        &state.database,
        vault_id,
        user_uuid(&actor.user),
        Capability::VaultRead,
        &request_id,
    )
    .await?;
    Ok(Json(DataResponse::new(
        load_presence(&state.database, vault_id, &request_id).await?,
    )))
}

pub async fn write_presence(
    State(state): State<AppState>,
    Extension(request_id): Extension<String>,
    headers: HeaderMap,
    Path(vault_id): Path<Uuid>,
    Json(payload): Json<WritePresenceRequest>,
) -> Result<StatusCode, ApiFailure> {
    let actor = require_any_user(&state, &headers, &request_id).await?;
    require_active_capability(
        &state.database,
        vault_id,
        &actor.user,
        Capability::VaultRead,
        &request_id,
    )
    .await?;
    let active_file = payload
        .active_file
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty());
    if active_file.as_deref().map(str::len).unwrap_or(0) > 1024 {
        return Err(ApiFailure::validation(
            "Active presence file path is too long.",
            request_id,
        ));
    }
    let app_version = payload.app_version.unwrap_or_default();
    if app_version.len() > 64 {
        return Err(ApiFailure::validation(
            "Presence app version is too long.",
            request_id,
        ));
    }
    sqlx::query(
        r#"
        INSERT INTO hosted_presence (vault_id, user_id, active_file, cursor_line, chat_typing_until, app_version, updated_at)
        VALUES ($1, $2, $3, $4, $5, $6, NOW())
        ON CONFLICT (vault_id, user_id)
        DO UPDATE SET
          active_file = EXCLUDED.active_file,
          cursor_line = EXCLUDED.cursor_line,
          chat_typing_until = EXCLUDED.chat_typing_until,
          app_version = EXCLUDED.app_version,
          updated_at = NOW()
        "#,
    )
    .bind(vault_id)
    .bind(user_uuid(&actor.user))
    .bind(active_file)
    .bind(payload.cursor_line)
    .bind(payload.chat_typing_until.map(|value| value as i64))
    .bind(app_version)
    .execute(&state.database)
    .await
    .map_err(|_| ApiFailure::server(request_id.clone()))?;
    Ok(StatusCode::NO_CONTENT)
}

pub async fn clear_presence(
    State(state): State<AppState>,
    Extension(request_id): Extension<String>,
    headers: HeaderMap,
    Path(vault_id): Path<Uuid>,
) -> Result<StatusCode, ApiFailure> {
    let actor = require_any_user(&state, &headers, &request_id).await?;
    sqlx::query("DELETE FROM hosted_presence WHERE vault_id = $1 AND user_id = $2")
        .bind(vault_id)
        .bind(user_uuid(&actor.user))
        .execute(&state.database)
        .await
        .map_err(|_| ApiFailure::server(request_id.clone()))?;
    Ok(StatusCode::NO_CONTENT)
}

pub async fn send_chat_message(
    State(state): State<AppState>,
    Extension(request_id): Extension<String>,
    headers: HeaderMap,
    Path(vault_id): Path<Uuid>,
    Json(payload): Json<SendChatMessageRequest>,
) -> Result<(StatusCode, Json<DataResponse<HostedChatMessage>>), ApiFailure> {
    let actor = require_any_user(&state, &headers, &request_id).await?;
    require_active_capability(
        &state.database,
        vault_id,
        &actor.user,
        Capability::VaultRead,
        &request_id,
    )
    .await?;
    let content = payload.content.trim();
    if content.is_empty() || content.chars().count() > 4000 {
        return Err(ApiFailure::validation(
            "Chat messages must be between 1 and 4000 characters.",
            request_id,
        ));
    }
    let actor_id = user_uuid(&actor.user);
    sqlx::query(
        r#"
        INSERT INTO hosted_chat_messages (id, vault_id, sender_user_id, content)
        VALUES ($1, $2, $3, $4)
        ON CONFLICT (id) DO NOTHING
        "#,
    )
    .bind(payload.id)
    .bind(vault_id)
    .bind(actor_id)
    .bind(content)
    .execute(&state.database)
    .await
    .map_err(|_| ApiFailure::server(request_id.clone()))?;
    Ok((
        StatusCode::CREATED,
        Json(DataResponse::new(
            load_chat_message(&state.database, vault_id, payload.id, &request_id).await?,
        )),
    ))
}

pub async fn add_vault_member(
    State(state): State<AppState>,
    Extension(request_id): Extension<String>,
    headers: HeaderMap,
    Path(vault_id): Path<Uuid>,
    Json(payload): Json<AddVaultMemberRequest>,
) -> Result<(StatusCode, Json<DataResponse<HostedVaultMember>>), ApiFailure> {
    let actor = require_any_user(&state, &headers, &request_id).await?;
    let access =
        require_active_vault_admin(&state.database, vault_id, &actor.user, &request_id).await?;
    if payload.role == HostedVaultRole::Admin && !access.owner {
        return Err(ApiFailure::vault_permission_denied(request_id));
    }
    let mut transaction = state
        .database
        .begin()
        .await
        .map_err(|_| ApiFailure::server(request_id.clone()))?;
    let inserted = sqlx::query(
        "INSERT INTO hosted_vault_memberships (vault_id, user_id, role) SELECT $1, id, $3::hosted_vault_role FROM users WHERE id = $2 AND status = 'active' ON CONFLICT DO NOTHING",
    )
    .bind(vault_id).bind(payload.user_id).bind(vault_role_name(payload.role))
    .execute(&mut *transaction).await.map_err(|_| ApiFailure::server(request_id.clone()))?;
    if inserted.rows_affected() == 0 {
        return Err(ApiFailure::validation(
            "The user does not exist, is disabled, or is already a member.",
            request_id,
        ));
    }
    vault_activity_event(
        &mut transaction,
        vault_id,
        Some(user_uuid(&actor.user)),
        "member.added",
        Some("user"),
        Some(&payload.user_id.to_string()),
        json!({"role": vault_role_name(payload.role)}),
        &request_id,
    )
    .await?;
    transaction
        .commit()
        .await
        .map_err(|_| ApiFailure::server(request_id.clone()))?;
    Ok((
        StatusCode::CREATED,
        Json(DataResponse::new(
            load_vault_member(&state.database, vault_id, payload.user_id, &request_id).await?,
        )),
    ))
}

/// The membership mutation a single update request resolves to.
enum MemberUpdate {
    /// Set the legacy role and clear any fine-grained override.
    Role(HostedVaultRole),
    /// Set an explicit, validated capability override (template cleared).
    Capabilities(Vec<String>),
    /// Assign a permission template (explicit override cleared).
    Template(Uuid),
    /// Clear any override so the role default applies.
    ResetToRoleDefault,
}

pub async fn update_vault_member(
    State(state): State<AppState>,
    Extension(request_id): Extension<String>,
    headers: HeaderMap,
    Path((vault_id, user_id)): Path<(Uuid, Uuid)>,
    Json(payload): Json<UpdateVaultMemberRequest>,
) -> Result<Json<DataResponse<HostedVaultMember>>, ApiFailure> {
    let actor = require_any_user(&state, &headers, &request_id).await?;
    // Resolve the requested intent in priority order. Capability/template/reset
    // edits require `vault.managePermissions`; a plain role change requires
    // `vault.manageMembers` (the legacy member-management capability).
    let update = if payload.reset_to_role_default == Some(true) {
        MemberUpdate::ResetToRoleDefault
    } else if let Some(tokens) = payload.capabilities.as_deref() {
        MemberUpdate::Capabilities(validate_capability_tokens(tokens, &request_id)?)
    } else if let Some(template_id) = payload.template_id {
        MemberUpdate::Template(template_id)
    } else if let Some(role) = payload.role {
        MemberUpdate::Role(role)
    } else {
        return Err(ApiFailure::validation(
            "A member update must change the role, capabilities, or template.",
            request_id,
        ));
    };
    let required_capability = match update {
        MemberUpdate::Role(_) => Capability::VaultManageMembers,
        _ => Capability::VaultManagePermissions,
    };
    let access = require_active_capability(
        &state.database,
        vault_id,
        &actor.user,
        required_capability,
        &request_id,
    )
    .await?;
    let target = load_vault_member(&state.database, vault_id, user_id, &request_id).await?;
    // The owner membership is immutable; only the owner may promote to or modify
    // an admin membership.
    let touches_admin = matches!(update, MemberUpdate::Role(HostedVaultRole::Admin))
        || target.role == HostedVaultRole::Admin;
    if target.owner || (touches_admin && !access.owner && !access.server_admin) {
        return Err(ApiFailure::vault_permission_denied(request_id));
    }
    // Resolve the resulting membership-level capability set for the self-lockout
    // guard and the template-existence check.
    let template_caps = if let MemberUpdate::Template(template_id) = update {
        Some(
            load_template(&state.database, template_id, &request_id)
                .await?
                .capabilities,
        )
    } else {
        None
    };
    let resulting_capabilities: Vec<String> = match &update {
        MemberUpdate::Role(role) => capabilities_for_role(*role)
            .into_iter()
            .map(|capability| capability.as_token().to_owned())
            .collect(),
        MemberUpdate::Capabilities(tokens) => tokens.clone(),
        MemberUpdate::Template(_) => template_caps.clone().unwrap_or_default(),
        MemberUpdate::ResetToRoleDefault => capabilities_for_role(target.role)
            .into_iter()
            .map(|capability| capability.as_token().to_owned())
            .collect(),
    };
    // Self-lockout guard: a non-owner administrator must not strip their own
    // member/permission-management capabilities (enforced alongside the UI guard).
    let editing_self = user_id == user_uuid(&actor.user);
    if editing_self && !access.owner && !access.server_admin {
        let retains_admin = resulting_capabilities
            .iter()
            .any(|token| token == Capability::VaultManagePermissions.as_token())
            && resulting_capabilities
                .iter()
                .any(|token| token == Capability::VaultManageMembers.as_token());
        if !retains_admin {
            return Err(ApiFailure::validation(
                "You cannot remove your own administrative permissions.",
                request_id,
            ));
        }
    }
    let mut transaction = state
        .database
        .begin()
        .await
        .map_err(|_| ApiFailure::server(request_id.clone()))?;
    let (event_type, event_payload) = match &update {
        MemberUpdate::Role(role) => {
            sqlx::query("UPDATE hosted_vault_memberships SET role = $1::hosted_vault_role, template_id = NULL, capabilities = NULL, updated_at = NOW() WHERE vault_id = $2 AND user_id = $3")
                .bind(vault_role_name(*role)).bind(vault_id).bind(user_id).execute(&mut *transaction).await.map_err(|_| ApiFailure::server(request_id.clone()))?;
            (
                "member.role_changed",
                json!({"role": vault_role_name(*role)}),
            )
        }
        MemberUpdate::Capabilities(tokens) => {
            sqlx::query("UPDATE hosted_vault_memberships SET template_id = NULL, capabilities = $1, updated_at = NOW() WHERE vault_id = $2 AND user_id = $3")
                .bind(tokens).bind(vault_id).bind(user_id).execute(&mut *transaction).await.map_err(|_| ApiFailure::server(request_id.clone()))?;
            (
                "member.permissions_changed",
                json!({"capabilities": tokens}),
            )
        }
        MemberUpdate::Template(template_id) => {
            sqlx::query("UPDATE hosted_vault_memberships SET template_id = $1, capabilities = NULL, updated_at = NOW() WHERE vault_id = $2 AND user_id = $3")
                .bind(template_id).bind(vault_id).bind(user_id).execute(&mut *transaction).await.map_err(|_| ApiFailure::server(request_id.clone()))?;
            (
                "member.permissions_changed",
                json!({"templateId": template_id.to_string()}),
            )
        }
        MemberUpdate::ResetToRoleDefault => {
            sqlx::query("UPDATE hosted_vault_memberships SET template_id = NULL, capabilities = NULL, updated_at = NOW() WHERE vault_id = $1 AND user_id = $2")
                .bind(vault_id).bind(user_id).execute(&mut *transaction).await.map_err(|_| ApiFailure::server(request_id.clone()))?;
            ("member.permissions_changed", json!({"reset": true}))
        }
    };
    vault_activity_event(
        &mut transaction,
        vault_id,
        Some(user_uuid(&actor.user)),
        event_type,
        Some("user"),
        Some(&user_id.to_string()),
        event_payload,
        &request_id,
    )
    .await?;
    transaction
        .commit()
        .await
        .map_err(|_| ApiFailure::server(request_id.clone()))?;
    Ok(Json(DataResponse::new(
        load_vault_member(&state.database, vault_id, user_id, &request_id).await?,
    )))
}

pub async fn remove_vault_member(
    State(state): State<AppState>,
    Extension(request_id): Extension<String>,
    headers: HeaderMap,
    Path((vault_id, user_id)): Path<(Uuid, Uuid)>,
) -> Result<StatusCode, ApiFailure> {
    let actor = require_any_user(&state, &headers, &request_id).await?;
    let access =
        require_active_vault_admin(&state.database, vault_id, &actor.user, &request_id).await?;
    let target = load_vault_member(&state.database, vault_id, user_id, &request_id).await?;
    if target.owner || (target.role == HostedVaultRole::Admin && !access.owner) {
        return Err(ApiFailure::vault_permission_denied(request_id));
    }
    let mut transaction = state
        .database
        .begin()
        .await
        .map_err(|_| ApiFailure::server(request_id.clone()))?;
    sqlx::query("DELETE FROM hosted_vault_memberships WHERE vault_id = $1 AND user_id = $2")
        .bind(vault_id)
        .bind(user_id)
        .execute(&mut *transaction)
        .await
        .map_err(|_| ApiFailure::server(request_id.clone()))?;
    vault_activity_event(
        &mut transaction,
        vault_id,
        Some(user_uuid(&actor.user)),
        "member.removed",
        Some("user"),
        Some(&user_id.to_string()),
        json!({}),
        &request_id,
    )
    .await?;
    transaction
        .commit()
        .await
        .map_err(|_| ApiFailure::server(request_id))?;
    Ok(StatusCode::NO_CONTENT)
}

pub async fn vault_activity(
    State(state): State<AppState>,
    Extension(request_id): Extension<String>,
    headers: HeaderMap,
    Path(vault_id): Path<Uuid>,
) -> Result<Json<DataResponse<Vec<HostedVaultActivityEvent>>>, ApiFailure> {
    let actor = require_authenticated_user(&state, &headers, &request_id).await?;
    require_capability(
        &state.database,
        vault_id,
        user_uuid(&actor.user),
        Capability::VaultViewActivity,
        &request_id,
    )
    .await?;
    let rows = sqlx::query(
        "SELECT a.id, u.display_name AS actor_display_name, a.event_type, a.target_type, a.target_id, a.created_at FROM hosted_vault_activity_events a LEFT JOIN users u ON u.id = a.actor_user_id WHERE a.vault_id = $1 ORDER BY a.created_at DESC LIMIT 100",
    ).bind(vault_id).fetch_all(&state.database).await.map_err(|_| ApiFailure::server(request_id.clone()))?;
    Ok(Json(DataResponse::new(
        rows.iter().map(vault_activity_from_row).collect(),
    )))
}

pub async fn vault_manifest(
    State(state): State<AppState>,
    Extension(request_id): Extension<String>,
    headers: HeaderMap,
    Path(vault_id): Path<Uuid>,
) -> Result<Json<DataResponse<HostedVaultManifest>>, ApiFailure> {
    let actor = require_authenticated_user(&state, &headers, &request_id).await?;
    require_capability(
        &state.database,
        vault_id,
        user_uuid(&actor.user),
        Capability::VaultRead,
        &request_id,
    )
    .await?;
    Ok(Json(DataResponse::new(
        load_vault_manifest(&state.database, vault_id, &request_id).await?,
    )))
}

pub async fn vault_manifest_delta(
    State(state): State<AppState>,
    Extension(request_id): Extension<String>,
    headers: HeaderMap,
    Path(vault_id): Path<Uuid>,
    Query(query): Query<ManifestDeltaQuery>,
) -> Result<Json<DataResponse<HostedVaultManifestDelta>>, ApiFailure> {
    if query.since < 0 {
        return Err(ApiFailure::validation(
            "Manifest delta sequence cannot be negative.",
            request_id,
        ));
    }
    let actor = require_authenticated_user(&state, &headers, &request_id).await?;
    require_capability(
        &state.database,
        vault_id,
        user_uuid(&actor.user),
        Capability::VaultRead,
        &request_id,
    )
    .await?;
    Ok(Json(DataResponse::new(
        load_vault_manifest_delta(&state.database, vault_id, query.since, &request_id).await?,
    )))
}

pub async fn vault_storage(
    State(state): State<AppState>,
    Extension(request_id): Extension<String>,
    headers: HeaderMap,
    Path(vault_id): Path<Uuid>,
) -> Result<Json<DataResponse<HostedVaultStorage>>, ApiFailure> {
    let actor = require_authenticated_user(&state, &headers, &request_id).await?;
    require_capability(
        &state.database,
        vault_id,
        user_uuid(&actor.user),
        Capability::VaultRead,
        &request_id,
    )
    .await?;
    let row = sqlx::query(
        r#"
        SELECT
          COALESCE((
            SELECT SUM(r.size_bytes)
            FROM hosted_file_entries f
            JOIN hosted_file_revisions r ON r.id = f.current_revision_id
            WHERE f.vault_id = $1 AND f.state = 'active'
          ), 0)::bigint AS active_bytes,
          COALESCE((
            SELECT SUM(r.size_bytes)
            FROM hosted_file_entries f
            JOIN hosted_file_revisions r ON r.id = f.current_revision_id
            WHERE f.vault_id = $1 AND f.state = 'trashed'
          ), 0)::bigint AS trash_bytes,
          COALESCE((
            SELECT SUM(r.size_bytes) FROM hosted_file_revisions r WHERE r.vault_id = $1
          ), 0)::bigint AS retained_revision_bytes,
          COALESCE((
            SELECT SUM(blobs.size_bytes)
            FROM (
              SELECT blob_digest, MAX(size_bytes) AS size_bytes
              FROM hosted_file_revisions
              WHERE vault_id = $1
              GROUP BY blob_digest
            ) blobs
          ), 0)::bigint AS unique_blob_bytes,
          (SELECT COUNT(*) FROM hosted_file_entries f WHERE f.vault_id = $1 AND f.state = 'active') AS active_files,
          (SELECT COUNT(*) FROM hosted_file_entries f WHERE f.vault_id = $1 AND f.state = 'trashed') AS trashed_files,
          (SELECT COUNT(*) FROM hosted_file_revisions r WHERE r.vault_id = $1) AS revision_count,
          (SELECT COUNT(*) FROM hosted_snapshots s WHERE s.vault_id = $1) AS snapshot_count
        "#,
    )
    .bind(vault_id)
    .fetch_one(&state.database)
    .await
    .map_err(|_| ApiFailure::server(request_id))?;
    Ok(Json(DataResponse::new(HostedVaultStorage {
        active_bytes: row.get::<i64, _>("active_bytes").max(0) as u64,
        trash_bytes: row.get::<i64, _>("trash_bytes").max(0) as u64,
        retained_revision_bytes: row.get::<i64, _>("retained_revision_bytes").max(0) as u64,
        unique_blob_bytes: row.get::<i64, _>("unique_blob_bytes").max(0) as u64,
        active_files: row.get("active_files"),
        trashed_files: row.get("trashed_files"),
        revision_count: row.get("revision_count"),
        snapshot_count: row.get("snapshot_count"),
    })))
}

pub async fn list_vault_files(
    State(state): State<AppState>,
    Extension(request_id): Extension<String>,
    headers: HeaderMap,
    Path(vault_id): Path<Uuid>,
) -> Result<Json<DataResponse<Vec<HostedFileEntry>>>, ApiFailure> {
    let actor = require_authenticated_user(&state, &headers, &request_id).await?;
    require_capability(
        &state.database,
        vault_id,
        user_uuid(&actor.user),
        Capability::VaultRead,
        &request_id,
    )
    .await?;
    Ok(Json(DataResponse::new(
        load_vault_manifest(&state.database, vault_id, &request_id)
            .await?
            .files,
    )))
}

pub async fn create_vault_file(
    State(state): State<AppState>,
    Extension(request_id): Extension<String>,
    headers: HeaderMap,
    Path(vault_id): Path<Uuid>,
    Json(payload): Json<CreateVaultFileRequest>,
) -> Result<(StatusCode, Json<DataResponse<HostedFileEntry>>), ApiFailure> {
    let actor = require_any_user(&state, &headers, &request_id).await?;
    require_active_capability(
        &state.database,
        vault_id,
        &actor.user,
        Capability::FileCreate,
        &request_id,
    )
    .await?;
    let (name, normalized_name) = collab_core::normalize_hosted_name(&payload.name)
        .map_err(|error| ApiFailure::path_invalid(error.to_string(), request_id.clone()))?;
    validate_file_kind(
        payload.kind,
        payload.document_type,
        &payload.content,
        &request_id,
    )?;
    let parent_path =
        validate_parent_folder(&state.database, vault_id, payload.parent_id, &request_id).await?;
    let relative_path = if parent_path.is_empty() {
        name.clone()
    } else {
        format!("{parent_path}/{name}")
    };
    collab_core::normalize_hosted_path(&relative_path)
        .map_err(|error| ApiFailure::path_invalid(error.to_string(), request_id.clone()))?;

    let content = (payload.kind == HostedFileKind::Document).then(|| payload.content.into_bytes());
    if let Some(content) = content.as_deref() {
        let settings = load_effective_runtime_settings(&state.config);
        enforce_storage_quota(
            &state.database,
            settings.storage_quota_bytes,
            &[(collab_core::sha256_bytes(content), content.len())],
            &request_id,
        )
        .await?;
    }
    let digest = if let Some(content) = content.as_deref() {
        Some(
            state
                .blobs
                .put(content)
                .await
                .map_err(|_| ApiFailure::server(request_id.clone()))?,
        )
    } else {
        None
    };
    let file_id = Uuid::now_v7();
    let revision_id = digest.as_ref().map(|_| Uuid::now_v7());
    let actor_id = user_uuid(&actor.user);
    let mut transaction = state
        .database
        .begin()
        .await
        .map_err(|_| ApiFailure::server(request_id.clone()))?;
    lock_active_vault(&mut transaction, vault_id, &request_id).await?;
    let inserted = sqlx::query(
        r#"
        INSERT INTO hosted_file_entries
          (id, vault_id, parent_id, name, normalized_name, kind, document_type, created_by)
        VALUES ($1, $2, $3, $4, $5, $6::hosted_file_kind, $7::hosted_document_type, $8)
        "#,
    )
    .bind(file_id)
    .bind(vault_id)
    .bind(payload.parent_id)
    .bind(&name)
    .bind(&normalized_name)
    .bind(file_kind_name(payload.kind))
    .bind(payload.document_type.map(document_type_name))
    .bind(actor_id)
    .execute(&mut *transaction)
    .await;
    if let Err(error) = inserted {
        return Err(map_path_database_error(error, request_id));
    }
    if let (Some(content), Some(digest), Some(revision_id)) =
        (content.as_deref(), digest.as_deref(), revision_id)
    {
        insert_blob_record(
            &mut transaction,
            digest,
            content.len(),
            "text/plain",
            &request_id,
        )
        .await?;
        sqlx::query(
            "INSERT INTO hosted_file_revisions (id, vault_id, file_id, sequence, blob_digest, content_hash, size_bytes, created_by) VALUES ($1, $2, $3, 1, $4, $4, $5, $6)",
        )
        .bind(revision_id)
        .bind(vault_id)
        .bind(file_id)
        .bind(digest)
        .bind(content.len() as i64)
        .bind(actor_id)
        .execute(&mut *transaction)
        .await
        .map_err(|_| ApiFailure::server(request_id.clone()))?;
        sqlx::query("UPDATE hosted_file_entries SET current_revision_id = $1 WHERE id = $2")
            .bind(revision_id)
            .bind(file_id)
            .execute(&mut *transaction)
            .await
            .map_err(|_| ApiFailure::server(request_id.clone()))?;
    }
    let result_manifest = increment_manifest(&mut transaction, vault_id, &request_id).await?;
    mark_manifest_file_changed(
        &mut transaction,
        vault_id,
        file_id,
        result_manifest,
        &request_id,
    )
    .await?;
    vault_activity_event(
        &mut transaction,
        vault_id,
        Some(actor_id),
        "file.created",
        Some("file"),
        Some(&file_id.to_string()),
        json!({"path": relative_path, "kind": file_kind_name(payload.kind)}),
        &request_id,
    )
    .await?;
    transaction
        .commit()
        .await
        .map_err(|_| ApiFailure::server(request_id.clone()))?;
    Ok((
        StatusCode::CREATED,
        Json(DataResponse::new(
            load_vault_file_entry(&state.database, vault_id, file_id, &request_id).await?,
        )),
    ))
}

pub async fn get_vault_file(
    State(state): State<AppState>,
    Extension(request_id): Extension<String>,
    headers: HeaderMap,
    Path((vault_id, file_id)): Path<(Uuid, Uuid)>,
) -> Result<Json<DataResponse<HostedTextDocument>>, ApiFailure> {
    let actor = require_authenticated_user(&state, &headers, &request_id).await?;
    require_capability(
        &state.database,
        vault_id,
        user_uuid(&actor.user),
        Capability::VaultRead,
        &request_id,
    )
    .await?;
    let file = load_vault_file_entry(&state.database, vault_id, file_id, &request_id).await?;
    if file.kind != HostedFileKind::Document || file.state != HostedFileState::Active {
        return Err(ApiFailure::validation(
            "Only active text documents can be read through this endpoint.",
            request_id,
        ));
    }
    let digest = file
        .current_revision
        .as_ref()
        .map(|revision| revision.content_hash.as_str())
        .ok_or_else(|| ApiFailure::not_found(request_id.clone()))?;
    let bytes = state
        .blobs
        .get(digest)
        .await
        .map_err(|_| ApiFailure::server(request_id.clone()))?
        .ok_or_else(|| ApiFailure::server(request_id.clone()))?;
    let content = String::from_utf8(bytes).map_err(|_| ApiFailure::server(request_id.clone()))?;
    Ok(Json(DataResponse::new(HostedTextDocument {
        file,
        content,
    })))
}

pub async fn list_file_revisions(
    State(state): State<AppState>,
    Extension(request_id): Extension<String>,
    headers: HeaderMap,
    Path((vault_id, file_id)): Path<(Uuid, Uuid)>,
) -> Result<Json<DataResponse<Vec<HostedFileRevision>>>, ApiFailure> {
    let actor = require_authenticated_user(&state, &headers, &request_id).await?;
    require_capability(
        &state.database,
        vault_id,
        user_uuid(&actor.user),
        Capability::VaultViewHistory,
        &request_id,
    )
    .await?;
    Ok(Json(DataResponse::new(
        load_file_revisions(&state.database, vault_id, file_id, &request_id).await?,
    )))
}

pub async fn get_text_revision(
    State(state): State<AppState>,
    Extension(request_id): Extension<String>,
    headers: HeaderMap,
    Path((vault_id, file_id, revision_id)): Path<(Uuid, Uuid, Uuid)>,
) -> Result<Json<DataResponse<HostedRevisionContent>>, ApiFailure> {
    let actor = require_authenticated_user(&state, &headers, &request_id).await?;
    require_capability(
        &state.database,
        vault_id,
        user_uuid(&actor.user),
        Capability::VaultViewHistory,
        &request_id,
    )
    .await?;
    Ok(Json(DataResponse::new(
        load_text_revision_content(&state, vault_id, file_id, revision_id, &request_id).await?,
    )))
}

pub async fn delete_file_revision(
    State(state): State<AppState>,
    Extension(request_id): Extension<String>,
    headers: HeaderMap,
    Path((vault_id, file_id, revision_id)): Path<(Uuid, Uuid, Uuid)>,
) -> Result<Json<DataResponse<Vec<HostedFileRevision>>>, ApiFailure> {
    let actor = require_any_user(&state, &headers, &request_id).await?;
    delete_file_revisions_inner(
        &state,
        &actor.user,
        vault_id,
        file_id,
        vec![revision_id],
        false,
        &request_id,
    )
    .await
}

pub async fn delete_file_revisions(
    State(state): State<AppState>,
    Extension(request_id): Extension<String>,
    headers: HeaderMap,
    Path((vault_id, file_id)): Path<(Uuid, Uuid)>,
    Json(payload): Json<DeleteFileRevisionsRequest>,
) -> Result<Json<DataResponse<Vec<HostedFileRevision>>>, ApiFailure> {
    let actor = require_any_user(&state, &headers, &request_id).await?;
    delete_file_revisions_inner(
        &state,
        &actor.user,
        vault_id,
        file_id,
        payload.revision_ids,
        payload.all,
        &request_id,
    )
    .await
}

async fn delete_file_revisions_inner(
    state: &AppState,
    actor: &ServerUser,
    vault_id: Uuid,
    file_id: Uuid,
    mut revision_ids: Vec<Uuid>,
    delete_all: bool,
    request_id: &str,
) -> Result<Json<DataResponse<Vec<HostedFileRevision>>>, ApiFailure> {
    require_active_capability(
        &state.database,
        vault_id,
        actor,
        Capability::VaultManageSnapshots,
        request_id,
    )
    .await?;
    if !delete_all && revision_ids.is_empty() {
        return Err(ApiFailure::validation(
            "Select at least one revision to delete.",
            request_id.to_owned(),
        ));
    }
    revision_ids.sort_unstable();
    revision_ids.dedup();
    let file_exists = sqlx::query_scalar::<_, bool>(
        "SELECT EXISTS(SELECT 1 FROM hosted_file_entries WHERE vault_id = $1 AND id = $2)",
    )
    .bind(vault_id)
    .bind(file_id)
    .fetch_one(&state.database)
    .await
    .map_err(|_| ApiFailure::server(request_id.to_owned()))?;
    if !file_exists {
        return Err(ApiFailure::not_found(request_id.to_owned()));
    }

    let rows = if delete_all {
        sqlx::query(
            r#"
            DELETE FROM hosted_file_revisions r
            WHERE r.vault_id = $1
              AND r.file_id = $2
              AND r.id NOT IN (
                  SELECT current_revision_id FROM hosted_file_entries
                  WHERE current_revision_id IS NOT NULL
              )
              AND NOT EXISTS (SELECT 1 FROM hosted_snapshots s WHERE s.revision_id = r.id)
            RETURNING r.id
            "#,
        )
        .bind(vault_id)
        .bind(file_id)
        .fetch_all(&state.database)
        .await
        .map_err(|_| ApiFailure::server(request_id.to_owned()))?
    } else {
        let deletable = sqlx::query_scalar::<_, i64>(
            r#"
            SELECT COUNT(*)
            FROM hosted_file_revisions r
            WHERE r.vault_id = $1
              AND r.file_id = $2
              AND r.id = ANY($3)
              AND r.id NOT IN (
                  SELECT current_revision_id FROM hosted_file_entries
                  WHERE current_revision_id IS NOT NULL
              )
              AND NOT EXISTS (SELECT 1 FROM hosted_snapshots s WHERE s.revision_id = r.id)
            "#,
        )
        .bind(vault_id)
        .bind(file_id)
        .bind(&revision_ids)
        .fetch_one(&state.database)
        .await
        .map_err(|_| ApiFailure::server(request_id.to_owned()))?;
        if deletable != revision_ids.len() as i64 {
            return Err(ApiFailure::validation(
                "Current, missing, or snapshot-pinned revisions cannot be deleted.",
                request_id.to_owned(),
            ));
        }
        sqlx::query(
            r#"
            DELETE FROM hosted_file_revisions r
            WHERE r.vault_id = $1
              AND r.file_id = $2
              AND r.id = ANY($3)
              AND r.id NOT IN (
                  SELECT current_revision_id FROM hosted_file_entries
                  WHERE current_revision_id IS NOT NULL
              )
              AND NOT EXISTS (SELECT 1 FROM hosted_snapshots s WHERE s.revision_id = r.id)
            RETURNING r.id
            "#,
        )
        .bind(vault_id)
        .bind(file_id)
        .bind(&revision_ids)
        .fetch_all(&state.database)
        .await
        .map_err(|_| ApiFailure::server(request_id.to_owned()))?
    };

    let deleted = rows.len() as u64;
    record_audit(
        &state.database,
        Some(&actor.id),
        "vault.file.revisions.delete",
        Some("file"),
        Some(&file_id.to_string()),
        "success",
        request_id,
        json!({
            "vaultId": vault_id,
            "fileId": file_id,
            "deletedRevisions": deleted,
            "all": delete_all,
        }),
    )
    .await?;
    Ok(Json(DataResponse::new(
        load_file_revisions(&state.database, vault_id, file_id, request_id).await?,
    )))
}

pub async fn restore_file_revision(
    State(state): State<AppState>,
    Extension(request_id): Extension<String>,
    headers: HeaderMap,
    Path((vault_id, file_id, source_revision_id)): Path<(Uuid, Uuid, Uuid)>,
    Json(payload): Json<RestoreSnapshotRequest>,
) -> Result<(StatusCode, Json<DataResponse<HostedTextDocument>>), ApiFailure> {
    let actor = require_any_user(&state, &headers, &request_id).await?;
    require_active_capability(
        &state.database,
        vault_id,
        &actor.user,
        Capability::FileWrite,
        &request_id,
    )
    .await?;
    let actor_id = user_uuid(&actor.user);
    let revision_id = Uuid::now_v7();
    let mut transaction = state
        .database
        .begin()
        .await
        .map_err(|_| ApiFailure::server(request_id.clone()))?;
    lock_active_vault(&mut transaction, vault_id, &request_id).await?;
    let current = sqlx::query(
        r#"
        SELECT f.kind::text AS kind, f.state::text AS state, current.sequence,
               source.blob_digest, source.content_hash, source.size_bytes
        FROM hosted_file_entries f
        LEFT JOIN hosted_file_revisions current ON current.id = f.current_revision_id
        JOIN hosted_file_revisions source
          ON source.vault_id = f.vault_id AND source.file_id = f.id AND source.id = $3
        WHERE f.vault_id = $1 AND f.id = $2
        FOR UPDATE OF f
        "#,
    )
    .bind(vault_id)
    .bind(file_id)
    .bind(source_revision_id)
    .fetch_optional(&mut *transaction)
    .await
    .map_err(|_| ApiFailure::server(request_id.clone()))?
    .ok_or_else(|| ApiFailure::not_found(request_id.clone()))?;
    if current.get::<String, _>("kind") != "document"
        || current.get::<String, _>("state") != "active"
    {
        return Err(ApiFailure::validation(
            "Only active text documents can restore previous revisions.",
            request_id,
        ));
    }
    let current_sequence = current.get::<Option<i64>, _>("sequence").unwrap_or(0);
    if current_sequence != payload.expected_revision_sequence {
        return Err(ApiFailure::revision_conflict(request_id));
    }
    let next_sequence = current_sequence + 1;
    sqlx::query(
        "INSERT INTO hosted_file_revisions (id, vault_id, file_id, sequence, blob_digest, content_hash, size_bytes, created_by) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)",
    )
    .bind(revision_id)
    .bind(vault_id)
    .bind(file_id)
    .bind(next_sequence)
    .bind(current.get::<String, _>("blob_digest"))
    .bind(current.get::<String, _>("content_hash"))
    .bind(current.get::<i64, _>("size_bytes"))
    .bind(actor_id)
    .execute(&mut *transaction)
    .await
    .map_err(|_| ApiFailure::server(request_id.clone()))?;
    sqlx::query(
        "UPDATE hosted_file_entries SET current_revision_id = $1, updated_at = NOW() WHERE id = $2",
    )
    .bind(revision_id)
    .bind(file_id)
    .execute(&mut *transaction)
    .await
    .map_err(|_| ApiFailure::server(request_id.clone()))?;
    let result_manifest = increment_manifest(&mut transaction, vault_id, &request_id).await?;
    mark_manifest_file_changed(
        &mut transaction,
        vault_id,
        file_id,
        result_manifest,
        &request_id,
    )
    .await?;
    vault_activity_event(
        &mut transaction,
        vault_id,
        Some(actor_id),
        "file.revision_restored",
        Some("file"),
        Some(&file_id.to_string()),
        json!({"sourceRevisionId": source_revision_id, "revisionSequence": next_sequence}),
        &request_id,
    )
    .await?;
    transaction
        .commit()
        .await
        .map_err(|_| ApiFailure::server(request_id.clone()))?;
    let file = load_vault_file_entry(&state.database, vault_id, file_id, &request_id).await?;
    let content = load_blob_text(
        &state,
        file.current_revision
            .as_ref()
            .map(|revision| revision.content_hash.as_str())
            .ok_or_else(|| ApiFailure::not_found(request_id.clone()))?,
        &request_id,
    )
    .await?;
    Ok((
        StatusCode::CREATED,
        Json(DataResponse::new(HostedTextDocument { file, content })),
    ))
}

pub async fn list_file_snapshots(
    State(state): State<AppState>,
    Extension(request_id): Extension<String>,
    headers: HeaderMap,
    Path((vault_id, file_id)): Path<(Uuid, Uuid)>,
) -> Result<Json<DataResponse<Vec<HostedSnapshot>>>, ApiFailure> {
    let actor = require_authenticated_user(&state, &headers, &request_id).await?;
    require_capability(
        &state.database,
        vault_id,
        user_uuid(&actor.user),
        Capability::VaultViewHistory,
        &request_id,
    )
    .await?;
    Ok(Json(DataResponse::new(
        load_file_snapshots(&state.database, vault_id, file_id, &request_id).await?,
    )))
}

pub async fn create_file_snapshot(
    State(state): State<AppState>,
    Extension(request_id): Extension<String>,
    headers: HeaderMap,
    Path((vault_id, file_id)): Path<(Uuid, Uuid)>,
    Json(payload): Json<CreateSnapshotRequest>,
) -> Result<(StatusCode, Json<DataResponse<HostedSnapshot>>), ApiFailure> {
    let actor = require_any_user(&state, &headers, &request_id).await?;
    require_active_capability(
        &state.database,
        vault_id,
        &actor.user,
        Capability::FileWrite,
        &request_id,
    )
    .await?;
    let label = normalize_snapshot_label(payload.label, &request_id)?;
    let actor_id = user_uuid(&actor.user);
    let snapshot_id = Uuid::now_v7();
    let mut transaction = state
        .database
        .begin()
        .await
        .map_err(|_| ApiFailure::server(request_id.clone()))?;
    lock_active_vault(&mut transaction, vault_id, &request_id).await?;
    let file = sqlx::query(
        "SELECT kind::text AS kind, state::text AS state, current_revision_id FROM hosted_file_entries WHERE vault_id = $1 AND id = $2 FOR UPDATE",
    )
    .bind(vault_id)
    .bind(file_id)
    .fetch_optional(&mut *transaction)
    .await
    .map_err(|_| ApiFailure::server(request_id.clone()))?
    .ok_or_else(|| ApiFailure::not_found(request_id.clone()))?;
    if file.get::<String, _>("kind") != "document" || file.get::<String, _>("state") != "active" {
        return Err(ApiFailure::validation(
            "Only active text documents can be snapshotted.",
            request_id,
        ));
    }
    let revision_id = payload
        .revision_id
        .or_else(|| file.get::<Option<Uuid>, _>("current_revision_id"))
        .ok_or_else(|| ApiFailure::not_found(request_id.clone()))?;
    let revision_exists = sqlx::query_scalar::<_, bool>(
        "SELECT EXISTS(SELECT 1 FROM hosted_file_revisions WHERE vault_id = $1 AND file_id = $2 AND id = $3)",
    )
    .bind(vault_id)
    .bind(file_id)
    .bind(revision_id)
    .fetch_one(&mut *transaction)
    .await
    .map_err(|_| ApiFailure::server(request_id.clone()))?;
    if !revision_exists {
        return Err(ApiFailure::not_found(request_id));
    }
    sqlx::query(
        "INSERT INTO hosted_snapshots (id, vault_id, file_id, revision_id, label, created_by) VALUES ($1, $2, $3, $4, $5, $6)",
    )
    .bind(snapshot_id)
    .bind(vault_id)
    .bind(file_id)
    .bind(revision_id)
    .bind(&label)
    .bind(actor_id)
    .execute(&mut *transaction)
    .await
    .map_err(|_| ApiFailure::server(request_id.clone()))?;
    vault_activity_event(
        &mut transaction,
        vault_id,
        Some(actor_id),
        "snapshot.created",
        Some("file"),
        Some(&file_id.to_string()),
        json!({"snapshotId": snapshot_id, "revisionId": revision_id}),
        &request_id,
    )
    .await?;
    transaction
        .commit()
        .await
        .map_err(|_| ApiFailure::server(request_id.clone()))?;
    let snapshot =
        load_file_snapshot(&state.database, vault_id, file_id, snapshot_id, &request_id).await?;
    Ok((StatusCode::CREATED, Json(DataResponse::new(snapshot))))
}

pub async fn restore_file_snapshot(
    State(state): State<AppState>,
    Extension(request_id): Extension<String>,
    headers: HeaderMap,
    Path((vault_id, file_id, snapshot_id)): Path<(Uuid, Uuid, Uuid)>,
    Json(payload): Json<RestoreSnapshotRequest>,
) -> Result<(StatusCode, Json<DataResponse<HostedTextDocument>>), ApiFailure> {
    let actor = require_any_user(&state, &headers, &request_id).await?;
    require_active_capability(
        &state.database,
        vault_id,
        &actor.user,
        Capability::FileWrite,
        &request_id,
    )
    .await?;
    let actor_id = user_uuid(&actor.user);
    let revision_id = Uuid::now_v7();
    let mut transaction = state
        .database
        .begin()
        .await
        .map_err(|_| ApiFailure::server(request_id.clone()))?;
    lock_active_vault(&mut transaction, vault_id, &request_id).await?;
    let current = sqlx::query(
        r#"
        SELECT f.kind::text AS kind, f.state::text AS state, current.sequence,
               snapshot_revision.blob_digest, snapshot_revision.content_hash,
               snapshot_revision.size_bytes
        FROM hosted_file_entries f
        LEFT JOIN hosted_file_revisions current ON current.id = f.current_revision_id
        JOIN hosted_snapshots snapshot ON snapshot.vault_id = f.vault_id AND snapshot.file_id = f.id
        JOIN hosted_file_revisions snapshot_revision ON snapshot_revision.id = snapshot.revision_id
        WHERE f.vault_id = $1 AND f.id = $2 AND snapshot.id = $3
        FOR UPDATE OF f
        "#,
    )
    .bind(vault_id)
    .bind(file_id)
    .bind(snapshot_id)
    .fetch_optional(&mut *transaction)
    .await
    .map_err(|_| ApiFailure::server(request_id.clone()))?
    .ok_or_else(|| ApiFailure::not_found(request_id.clone()))?;
    if current.get::<String, _>("kind") != "document"
        || current.get::<String, _>("state") != "active"
    {
        return Err(ApiFailure::validation(
            "Only active text documents can be restored.",
            request_id,
        ));
    }
    let current_sequence = current.get::<Option<i64>, _>("sequence").unwrap_or(0);
    if current_sequence != payload.expected_revision_sequence {
        return Err(ApiFailure::revision_conflict(request_id));
    }
    let next_sequence = current_sequence + 1;
    sqlx::query(
        "INSERT INTO hosted_file_revisions (id, vault_id, file_id, sequence, blob_digest, content_hash, size_bytes, created_by) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)",
    )
    .bind(revision_id)
    .bind(vault_id)
    .bind(file_id)
    .bind(next_sequence)
    .bind(current.get::<String, _>("blob_digest"))
    .bind(current.get::<String, _>("content_hash"))
    .bind(current.get::<i64, _>("size_bytes"))
    .bind(actor_id)
    .execute(&mut *transaction)
    .await
    .map_err(|_| ApiFailure::server(request_id.clone()))?;
    sqlx::query(
        "UPDATE hosted_file_entries SET current_revision_id = $1, updated_at = NOW() WHERE id = $2",
    )
    .bind(revision_id)
    .bind(file_id)
    .execute(&mut *transaction)
    .await
    .map_err(|_| ApiFailure::server(request_id.clone()))?;
    let result_manifest = increment_manifest(&mut transaction, vault_id, &request_id).await?;
    mark_manifest_file_changed(
        &mut transaction,
        vault_id,
        file_id,
        result_manifest,
        &request_id,
    )
    .await?;
    vault_activity_event(
        &mut transaction,
        vault_id,
        Some(actor_id),
        "snapshot.restored",
        Some("file"),
        Some(&file_id.to_string()),
        json!({"snapshotId": snapshot_id, "revisionSequence": next_sequence}),
        &request_id,
    )
    .await?;
    transaction
        .commit()
        .await
        .map_err(|_| ApiFailure::server(request_id.clone()))?;
    let file = load_vault_file_entry(&state.database, vault_id, file_id, &request_id).await?;
    let content = load_blob_text(
        &state,
        file.current_revision
            .as_ref()
            .map(|revision| revision.content_hash.as_str())
            .ok_or_else(|| ApiFailure::not_found(request_id.clone()))?,
        &request_id,
    )
    .await?;
    Ok((
        StatusCode::CREATED,
        Json(DataResponse::new(HostedTextDocument { file, content })),
    ))
}

/// Materializes live CRDT document content (note text, or serialized Kanban /
/// canvas JSON) into a normal text revision so REST reads, history, search, and
/// export stay valid while a document is being co-edited. Called by the
/// live-collaboration layer after edits settle.
///
/// Returns `Ok(true)` when a new revision was written, `Ok(false)` when nothing
/// changed (identical content) or the target is not an active document in an
/// active vault. The write reuses the same revision/manifest/activity path as
/// `write_text_revision` but is authoritative: it carries no optimistic
/// expected-sequence check because the CRDT room is the source of truth.
pub(crate) async fn persist_materialized_document(
    database: &PgPool,
    blobs: &dyn crate::storage::BlobStorage,
    vault_id: Uuid,
    file_id: Uuid,
    content: &str,
    author: Option<Uuid>,
) -> Result<bool, ApiFailure> {
    let request_id = Uuid::new_v4().to_string();
    let bytes = content.as_bytes();
    let digest = blobs
        .put(bytes)
        .await
        .map_err(|_| ApiFailure::server(request_id.clone()))?;
    let mut transaction = database
        .begin()
        .await
        .map_err(|_| ApiFailure::server(request_id.clone()))?;
    // Only materialize into active vaults; archived/pending-delete vaults are
    // skipped rather than erroring.
    let vault =
        sqlx::query("SELECT status::text AS status FROM hosted_vaults WHERE id = $1 FOR UPDATE")
            .bind(vault_id)
            .fetch_optional(&mut *transaction)
            .await
            .map_err(|_| ApiFailure::server(request_id.clone()))?;
    let Some(vault) = vault else { return Ok(false) };
    if vault.get::<String, _>("status") != "active" {
        return Ok(false);
    }
    let current = sqlx::query(
        r#"
        SELECT f.kind::text AS kind, f.state::text AS state, r.sequence, r.blob_digest
        FROM hosted_file_entries f
        LEFT JOIN hosted_file_revisions r ON r.id = f.current_revision_id
        WHERE f.vault_id = $1 AND f.id = $2
        FOR UPDATE OF f
        "#,
    )
    .bind(vault_id)
    .bind(file_id)
    .fetch_optional(&mut *transaction)
    .await
    .map_err(|_| ApiFailure::server(request_id.clone()))?;
    let Some(current) = current else {
        return Ok(false);
    };
    if current.get::<String, _>("kind") != "document"
        || current.get::<String, _>("state") != "active"
    {
        return Ok(false);
    }
    // Skip when the live content already matches the current revision.
    if current.get::<Option<String>, _>("blob_digest").as_deref() == Some(digest.as_str()) {
        return Ok(false);
    }
    let next_sequence = current.get::<Option<i64>, _>("sequence").unwrap_or(0) + 1;
    let revision_id = Uuid::now_v7();
    insert_blob_record(
        &mut transaction,
        &digest,
        bytes.len(),
        "text/plain",
        &request_id,
    )
    .await?;
    sqlx::query(
        "INSERT INTO hosted_file_revisions (id, vault_id, file_id, sequence, blob_digest, content_hash, size_bytes, created_by) VALUES ($1, $2, $3, $4, $5, $5, $6, $7)",
    )
    .bind(revision_id)
    .bind(vault_id)
    .bind(file_id)
    .bind(next_sequence)
    .bind(&digest)
    .bind(bytes.len() as i64)
    .bind(author)
    .execute(&mut *transaction)
    .await
    .map_err(|_| ApiFailure::server(request_id.clone()))?;
    sqlx::query(
        "UPDATE hosted_file_entries SET current_revision_id = $1, updated_at = NOW() WHERE id = $2",
    )
    .bind(revision_id)
    .bind(file_id)
    .execute(&mut *transaction)
    .await
    .map_err(|_| ApiFailure::server(request_id.clone()))?;
    let result_manifest = increment_manifest(&mut transaction, vault_id, &request_id).await?;
    mark_manifest_file_changed(
        &mut transaction,
        vault_id,
        file_id,
        result_manifest,
        &request_id,
    )
    .await?;
    vault_activity_event(
        &mut transaction,
        vault_id,
        author,
        "file.revision_created",
        Some("file"),
        Some(&file_id.to_string()),
        json!({"revisionSequence": next_sequence, "source": "live"}),
        &request_id,
    )
    .await?;
    transaction
        .commit()
        .await
        .map_err(|_| ApiFailure::server(request_id.clone()))?;
    Ok(true)
}

/// Loads the current materialized text content of a document, used to seed a new
/// live CRDT room from existing REST content. Returns `None` when the file has
/// no current text revision.
pub(crate) async fn load_current_document_text(
    database: &PgPool,
    blobs: &dyn crate::storage::BlobStorage,
    vault_id: Uuid,
    file_id: Uuid,
) -> Option<String> {
    let digest: Option<String> = sqlx::query_scalar(
        r#"
        SELECT r.blob_digest
        FROM hosted_file_entries f
        JOIN hosted_file_revisions r ON r.id = f.current_revision_id
        WHERE f.vault_id = $1 AND f.id = $2 AND f.kind = 'document' AND f.state = 'active'
        "#,
    )
    .bind(vault_id)
    .bind(file_id)
    .fetch_optional(database)
    .await
    .ok()
    .flatten();
    let digest = digest?;
    let bytes = blobs.get(&digest).await.ok().flatten()?;
    String::from_utf8(bytes).ok()
}

/// Issues a single-use, short-lived ticket for opening a live-collaboration
/// WebSocket session on a vault. The caller authenticates with their normal
/// browser session or native access token and must already hold read access to
/// the vault. The ticket is stored hashed and presented in the WebSocket
/// `authenticate` frame, so bearer tokens never travel in the WebSocket URL.
pub async fn issue_ws_ticket(
    State(state): State<AppState>,
    Extension(request_id): Extension<String>,
    headers: HeaderMap,
    Json(payload): Json<WsTicketRequest>,
) -> Result<Json<DataResponse<WsTicket>>, ApiFailure> {
    let actor = require_any_user(&state, &headers, &request_id).await?;
    let vault_id = Uuid::parse_str(payload.vault_id.trim())
        .map_err(|_| ApiFailure::validation("The vault id is not valid.", request_id.clone()))?;
    // Only users who can already read the vault may obtain a session ticket.
    require_capability(
        &state.database,
        vault_id,
        user_uuid(&actor.user),
        Capability::VaultRead,
        &request_id,
    )
    .await?;
    let ticket = generate_secret();
    let ticket_hash = hash_secret(&ticket);
    let settings = load_effective_runtime_settings(&state.config);
    let expires_at = chrono::Utc::now() + chrono::Duration::seconds(settings.ws_ticket_ttl_seconds);
    sqlx::query(
        "INSERT INTO ws_tickets (id, ticket_hash, user_id, vault_id, expires_at) VALUES ($1, $2, $3, $4, $5)",
    )
    .bind(Uuid::now_v7())
    .bind(&ticket_hash)
    .bind(user_uuid(&actor.user))
    .bind(vault_id)
    .bind(expires_at)
    .execute(&state.database)
    .await
    .map_err(|_| ApiFailure::server(request_id.clone()))?;
    Ok(Json(DataResponse::new(WsTicket {
        ticket,
        vault_id: vault_id.to_string(),
        websocket_path: format!("/ws/v1/vaults/{vault_id}"),
        expires_at: expires_at.to_rfc3339(),
        protocol_version: collab_protocol::PROTOCOL_VERSION,
    })))
}

pub async fn write_text_revision(
    State(state): State<AppState>,
    Extension(request_id): Extension<String>,
    headers: HeaderMap,
    Path((vault_id, file_id)): Path<(Uuid, Uuid)>,
    Json(payload): Json<WriteTextRevisionRequest>,
) -> Result<(StatusCode, Json<DataResponse<HostedTextDocument>>), ApiFailure> {
    let actor = require_any_user(&state, &headers, &request_id).await?;
    let access = require_active_capability(
        &state.database,
        vault_id,
        &actor.user,
        Capability::FileWrite,
        &request_id,
    )
    .await?;
    let content = payload.content.into_bytes();
    let settings = load_effective_runtime_settings(&state.config);
    enforce_storage_quota(
        &state.database,
        settings.storage_quota_bytes,
        &[(collab_core::sha256_bytes(&content), content.len())],
        &request_id,
    )
    .await?;
    let digest = state
        .blobs
        .put(&content)
        .await
        .map_err(|_| ApiFailure::server(request_id.clone()))?;
    let actor_id = user_uuid(&actor.user);
    let revision_id = Uuid::now_v7();
    let mut transaction = state
        .database
        .begin()
        .await
        .map_err(|_| ApiFailure::server(request_id.clone()))?;
    lock_active_vault(&mut transaction, vault_id, &request_id).await?;
    let current = sqlx::query(
        r#"
        SELECT f.kind::text AS kind, f.state::text AS state, f.name, r.sequence,
               r.blob_digest
        FROM hosted_file_entries f
        LEFT JOIN hosted_file_revisions r ON r.id = f.current_revision_id
        WHERE f.vault_id = $1 AND f.id = $2
        FOR UPDATE OF f
        "#,
    )
    .bind(vault_id)
    .bind(file_id)
    .fetch_optional(&mut *transaction)
    .await
    .map_err(|_| ApiFailure::server(request_id.clone()))?
    .ok_or_else(|| ApiFailure::not_found(request_id.clone()))?;
    if current.get::<String, _>("kind") != "document"
        || current.get::<String, _>("state") != "active"
    {
        return Err(ApiFailure::validation(
            "Only active text documents can be written.",
            request_id,
        ));
    }
    let current_sequence = current.get::<Option<i64>, _>("sequence").unwrap_or(0);
    if current_sequence != payload.expected_revision_sequence {
        return Err(ApiFailure::revision_conflict(request_id));
    }
    // Kanban boards are semantically enforced: a `.kanban` write must hold the
    // specific kanban capabilities for the changes it makes (move, comment,
    // edit content, etc.), not just the baseline `file.write`.
    if current
        .get::<String, _>("name")
        .to_lowercase()
        .ends_with(".kanban")
    {
        let prior_content = match current.get::<Option<String>, _>("blob_digest") {
            Some(prior_digest) => state
                .blobs
                .get(&prior_digest)
                .await
                .map_err(|_| ApiFailure::server(request_id.clone()))?,
            None => None,
        };
        enforce_kanban_write(&access, prior_content.as_deref(), &content, &request_id)?;
    }
    let next_sequence = current_sequence + 1;
    insert_blob_record(
        &mut transaction,
        &digest,
        content.len(),
        "text/plain",
        &request_id,
    )
    .await?;
    sqlx::query(
        "INSERT INTO hosted_file_revisions (id, vault_id, file_id, sequence, blob_digest, content_hash, size_bytes, created_by) VALUES ($1, $2, $3, $4, $5, $5, $6, $7)",
    )
    .bind(revision_id)
    .bind(vault_id)
    .bind(file_id)
    .bind(next_sequence)
    .bind(&digest)
    .bind(content.len() as i64)
    .bind(actor_id)
    .execute(&mut *transaction)
    .await
    .map_err(|_| ApiFailure::server(request_id.clone()))?;
    sqlx::query(
        "UPDATE hosted_file_entries SET current_revision_id = $1, updated_at = NOW() WHERE id = $2",
    )
    .bind(revision_id)
    .bind(file_id)
    .execute(&mut *transaction)
    .await
    .map_err(|_| ApiFailure::server(request_id.clone()))?;
    let result_manifest = increment_manifest(&mut transaction, vault_id, &request_id).await?;
    mark_manifest_file_changed(
        &mut transaction,
        vault_id,
        file_id,
        result_manifest,
        &request_id,
    )
    .await?;
    vault_activity_event(
        &mut transaction,
        vault_id,
        Some(actor_id),
        "file.revision_created",
        Some("file"),
        Some(&file_id.to_string()),
        json!({"revisionSequence": next_sequence}),
        &request_id,
    )
    .await?;
    transaction
        .commit()
        .await
        .map_err(|_| ApiFailure::server(request_id.clone()))?;
    let file = load_vault_file_entry(&state.database, vault_id, file_id, &request_id).await?;
    Ok((
        StatusCode::CREATED,
        Json(DataResponse::new(HostedTextDocument {
            file,
            content: String::from_utf8(content).expect("request JSON strings are UTF-8"),
        })),
    ))
}

/// Returns the shared annotation state for a hosted PDF. Readable by anyone who
/// can read the vault; a PDF with no annotations yet resolves to an empty state
/// at sequence 0.
pub async fn get_pdf_annotations(
    State(state): State<AppState>,
    Extension(request_id): Extension<String>,
    headers: HeaderMap,
    Path((vault_id, file_id)): Path<(Uuid, Uuid)>,
) -> Result<Json<DataResponse<HostedPdfAnnotations>>, ApiFailure> {
    let actor = require_authenticated_user(&state, &headers, &request_id).await?;
    require_capability(
        &state.database,
        vault_id,
        user_uuid(&actor.user),
        Capability::VaultRead,
        &request_id,
    )
    .await?;
    let row = sqlx::query(
        "SELECT state, sequence FROM hosted_pdf_annotations WHERE vault_id = $1 AND file_id = $2",
    )
    .bind(vault_id)
    .bind(file_id)
    .fetch_optional(&state.database)
    .await
    .map_err(|_| ApiFailure::server(request_id.clone()))?;
    let annotations = match row {
        Some(row) => HostedPdfAnnotations {
            state: row.get::<Value, _>("state"),
            sequence: row.get::<i64, _>("sequence"),
        },
        None => HostedPdfAnnotations {
            state: json!({}),
            sequence: 0,
        },
    };
    Ok(Json(DataResponse::new(annotations)))
}

/// Replaces the shared annotation state for a hosted PDF. Annotations are
/// sidecar metadata, so this intentionally does not create a file revision or
/// advance the vault manifest; it uses its own per-file `sequence` for
/// optimistic concurrency. Enforcement is semantic: page-comment changes require
/// `pdf.comment`, and bookmark/highlight/text-annotation changes require
/// `pdf.annotate`. Owners and server admins hold every capability and bypass the
/// per-field check.
pub async fn write_pdf_annotations(
    State(state): State<AppState>,
    Extension(request_id): Extension<String>,
    headers: HeaderMap,
    Path((vault_id, file_id)): Path<(Uuid, Uuid)>,
    Json(payload): Json<WritePdfAnnotationsRequest>,
) -> Result<(StatusCode, Json<DataResponse<HostedPdfAnnotations>>), ApiFailure> {
    let actor = require_any_user(&state, &headers, &request_id).await?;
    let actor_id = user_uuid(&actor.user);
    let access =
        resolve_vault_capabilities(&state.database, vault_id, actor_id, &request_id).await?;
    if access.status != HostedVaultStatus::Active {
        return Err(ApiFailure::vault_archived(request_id));
    }
    // A caller with no PDF write capability at all (e.g. a pure viewer) cannot
    // use this endpoint regardless of the specific change.
    if !access.has(Capability::PdfComment) && !access.has(Capability::PdfAnnotate) {
        return Err(ApiFailure::vault_permission_denied(request_id));
    }
    let mut transaction = state
        .database
        .begin()
        .await
        .map_err(|_| ApiFailure::server(request_id.clone()))?;
    lock_active_vault(&mut transaction, vault_id, &request_id).await?;
    let file = sqlx::query(
        "SELECT name, state::text AS state FROM hosted_file_entries WHERE vault_id = $1 AND id = $2 FOR UPDATE",
    )
    .bind(vault_id)
    .bind(file_id)
    .fetch_optional(&mut *transaction)
    .await
    .map_err(|_| ApiFailure::server(request_id.clone()))?
    .ok_or_else(|| ApiFailure::not_found(request_id.clone()))?;
    if file.get::<String, _>("state") != "active"
        || !file
            .get::<String, _>("name")
            .to_lowercase()
            .ends_with(".pdf")
    {
        return Err(ApiFailure::validation(
            "Only active PDF files can carry annotations.",
            request_id,
        ));
    }
    let existing = sqlx::query(
        "SELECT state, sequence FROM hosted_pdf_annotations WHERE vault_id = $1 AND file_id = $2 FOR UPDATE",
    )
    .bind(vault_id)
    .bind(file_id)
    .fetch_optional(&mut *transaction)
    .await
    .map_err(|_| ApiFailure::server(request_id.clone()))?;
    let (old_state, current_sequence) = match &existing {
        Some(row) => (row.get::<Value, _>("state"), row.get::<i64, _>("sequence")),
        None => (json!({}), 0),
    };
    if current_sequence != payload.expected_sequence {
        return Err(ApiFailure::revision_conflict(request_id));
    }
    for required in collab_core::pdf::classify_changes(&old_state, &payload.state) {
        let capability = Capability::from_token(required.as_token())
            .expect("pdf capability tokens map to a Capability");
        if !access.has(capability) {
            return Err(ApiFailure::vault_permission_denied(request_id));
        }
    }
    let next_sequence = current_sequence + 1;
    sqlx::query(
        r#"
        INSERT INTO hosted_pdf_annotations (vault_id, file_id, state, sequence, updated_by, updated_at)
        VALUES ($1, $2, $3, $4, $5, NOW())
        ON CONFLICT (vault_id, file_id)
        DO UPDATE SET state = EXCLUDED.state, sequence = EXCLUDED.sequence,
                      updated_by = EXCLUDED.updated_by, updated_at = NOW()
        "#,
    )
    .bind(vault_id)
    .bind(file_id)
    .bind(&payload.state)
    .bind(next_sequence)
    .bind(actor_id)
    .execute(&mut *transaction)
    .await
    .map_err(|_| ApiFailure::server(request_id.clone()))?;
    vault_activity_event(
        &mut transaction,
        vault_id,
        Some(actor_id),
        "pdf.annotations_updated",
        Some("file"),
        Some(&file_id.to_string()),
        json!({"sequence": next_sequence}),
        &request_id,
    )
    .await?;
    transaction
        .commit()
        .await
        .map_err(|_| ApiFailure::server(request_id.clone()))?;
    Ok((
        StatusCode::OK,
        Json(DataResponse::new(HostedPdfAnnotations {
            state: payload.state,
            sequence: next_sequence,
        })),
    ))
}

pub async fn upload_binary_asset(
    State(state): State<AppState>,
    Extension(request_id): Extension<String>,
    headers: HeaderMap,
    Path(vault_id): Path<Uuid>,
    Json(payload): Json<UploadBinaryAssetRequest>,
) -> Result<(StatusCode, Json<DataResponse<HostedFileEntry>>), ApiFailure> {
    let actor = require_any_user(&state, &headers, &request_id).await?;
    require_active_capability(
        &state.database,
        vault_id,
        &actor.user,
        Capability::FileUploadAsset,
        &request_id,
    )
    .await?;
    let (name, normalized_name) = collab_core::normalize_hosted_name(&payload.name)
        .map_err(|error| ApiFailure::path_invalid(error.to_string(), request_id.clone()))?;
    let parent_path =
        validate_parent_folder(&state.database, vault_id, payload.parent_id, &request_id).await?;
    let relative_path = if parent_path.is_empty() {
        name.clone()
    } else {
        format!("{parent_path}/{name}")
    };
    collab_core::normalize_hosted_path(&relative_path)
        .map_err(|error| ApiFailure::path_invalid(error.to_string(), request_id.clone()))?;
    if payload.media_type.trim().is_empty() || payload.media_type.len() > 255 {
        return Err(ApiFailure::validation(
            "Media type must be between 1 and 255 characters.",
            request_id,
        ));
    }
    let content = STANDARD.decode(&payload.content_base64).map_err(|_| {
        ApiFailure::validation("Asset content is not valid base64.", request_id.clone())
    })?;
    let settings = load_effective_runtime_settings(&state.config);
    if content.len() > settings.max_file_bytes {
        return Err(ApiFailure::quota_exceeded(request_id));
    }
    let digest = collab_core::sha256_bytes(&content);
    if digest != payload.expected_hash.to_ascii_lowercase() {
        return Err(ApiFailure::upload_hash_mismatch(request_id));
    }
    enforce_storage_quota(
        &state.database,
        settings.storage_quota_bytes,
        &[(digest.clone(), content.len())],
        &request_id,
    )
    .await?;
    let stored_digest = state
        .blobs
        .put(&content)
        .await
        .map_err(|_| ApiFailure::server(request_id.clone()))?;
    if stored_digest != digest {
        return Err(ApiFailure::upload_hash_mismatch(request_id));
    }

    let actor_id = user_uuid(&actor.user);
    let file_id = Uuid::now_v7();
    let revision_id = Uuid::now_v7();
    let mut transaction = state
        .database
        .begin()
        .await
        .map_err(|_| ApiFailure::server(request_id.clone()))?;
    lock_active_vault(&mut transaction, vault_id, &request_id).await?;
    let inserted = sqlx::query(
        "INSERT INTO hosted_file_entries (id, vault_id, parent_id, name, normalized_name, kind, created_by) VALUES ($1, $2, $3, $4, $5, 'asset', $6)",
    )
    .bind(file_id)
    .bind(vault_id)
    .bind(payload.parent_id)
    .bind(&name)
    .bind(&normalized_name)
    .bind(actor_id)
    .execute(&mut *transaction)
    .await;
    if let Err(error) = inserted {
        return Err(map_path_database_error(error, request_id));
    }
    insert_blob_record(
        &mut transaction,
        &digest,
        content.len(),
        payload.media_type.trim(),
        &request_id,
    )
    .await?;
    sqlx::query(
        "INSERT INTO hosted_file_revisions (id, vault_id, file_id, sequence, blob_digest, content_hash, size_bytes, created_by) VALUES ($1, $2, $3, 1, $4, $4, $5, $6)",
    )
    .bind(revision_id)
    .bind(vault_id)
    .bind(file_id)
    .bind(&digest)
    .bind(content.len() as i64)
    .bind(actor_id)
    .execute(&mut *transaction)
    .await
    .map_err(|_| ApiFailure::server(request_id.clone()))?;
    sqlx::query("UPDATE hosted_file_entries SET current_revision_id = $1 WHERE id = $2")
        .bind(revision_id)
        .bind(file_id)
        .execute(&mut *transaction)
        .await
        .map_err(|_| ApiFailure::server(request_id.clone()))?;
    let result_manifest = increment_manifest(&mut transaction, vault_id, &request_id).await?;
    mark_manifest_file_changed(
        &mut transaction,
        vault_id,
        file_id,
        result_manifest,
        &request_id,
    )
    .await?;
    vault_activity_event(
        &mut transaction,
        vault_id,
        Some(actor_id),
        "asset.uploaded",
        Some("file"),
        Some(&file_id.to_string()),
        json!({"path": relative_path, "sizeBytes": content.len(), "contentHash": digest}),
        &request_id,
    )
    .await?;
    transaction
        .commit()
        .await
        .map_err(|_| ApiFailure::server(request_id.clone()))?;
    Ok((
        StatusCode::CREATED,
        Json(DataResponse::new(
            load_vault_file_entry(&state.database, vault_id, file_id, &request_id).await?,
        )),
    ))
}

pub async fn download_vault_file(
    State(state): State<AppState>,
    Extension(request_id): Extension<String>,
    headers: HeaderMap,
    Path((vault_id, file_id)): Path<(Uuid, Uuid)>,
) -> Result<Response, ApiFailure> {
    let actor = require_authenticated_user(&state, &headers, &request_id).await?;
    require_capability(
        &state.database,
        vault_id,
        user_uuid(&actor.user),
        Capability::VaultRead,
        &request_id,
    )
    .await?;
    let row = sqlx::query(
        r#"
        SELECT f.name, f.state::text AS state, r.blob_digest, b.media_type
        FROM hosted_file_entries f
        JOIN hosted_file_revisions r ON r.id = f.current_revision_id
        JOIN hosted_blobs b ON b.digest = r.blob_digest
        WHERE f.vault_id = $1 AND f.id = $2
        "#,
    )
    .bind(vault_id)
    .bind(file_id)
    .fetch_optional(&state.database)
    .await
    .map_err(|_| ApiFailure::server(request_id.clone()))?
    .ok_or_else(|| ApiFailure::not_found(request_id.clone()))?;
    if row.get::<String, _>("state") != "active" {
        return Err(ApiFailure::not_found(request_id));
    }
    let digest: String = row.get("blob_digest");
    let bytes = state
        .blobs
        .get(&digest)
        .await
        .map_err(|_| ApiFailure::server(request_id.clone()))?
        .ok_or_else(|| ApiFailure::server(request_id.clone()))?;
    if collab_core::sha256_bytes(&bytes) != digest {
        return Err(ApiFailure::upload_hash_mismatch(request_id));
    }
    let mut response = Response::new(Body::from(bytes));
    response.headers_mut().insert(
        header::CONTENT_TYPE,
        HeaderValue::from_str(row.get::<String, _>("media_type").as_str())
            .unwrap_or_else(|_| HeaderValue::from_static("application/octet-stream")),
    );
    response.headers_mut().insert(
        header::ETAG,
        HeaderValue::from_str(&format!("\"{digest}\"")).expect("digest ETag is valid"),
    );
    response.headers_mut().insert(
        header::CONTENT_DISPOSITION,
        HeaderValue::from_static("attachment"),
    );
    Ok(response)
}

pub async fn apply_structural_operation(
    State(state): State<AppState>,
    Extension(request_id): Extension<String>,
    headers: HeaderMap,
    Path(vault_id): Path<Uuid>,
    Json(payload): Json<StructuralOperationRequest>,
) -> Result<Json<DataResponse<HostedStructuralOperationResult>>, ApiFailure> {
    let actor = require_any_user(&state, &headers, &request_id).await?;
    // Each structural operation maps to a specific capability; purge stays
    // admin-only to preserve the existing destructive-operation boundary.
    match payload.operation_type {
        HostedStructuralOperationType::Purge => {
            require_active_vault_admin(&state.database, vault_id, &actor.user, &request_id).await?;
        }
        operation_type => {
            require_active_capability(
                &state.database,
                vault_id,
                &actor.user,
                structural_operation_capability(operation_type),
                &request_id,
            )
            .await?;
        }
    }
    if let Some(existing) = load_structural_operation(
        &state.database,
        vault_id,
        payload.client_operation_id,
        true,
        &request_id,
    )
    .await?
    {
        return Ok(Json(DataResponse::new(existing)));
    }

    let manifest = load_vault_manifest(&state.database, vault_id, &request_id).await?;
    if manifest.sequence != payload.base_manifest_sequence {
        return Err(ApiFailure::manifest_conflict(request_id));
    }
    let target = manifest
        .files
        .iter()
        .find(|file| file.id == payload.target_file_id.to_string())
        .ok_or_else(|| ApiFailure::not_found(request_id.clone()))?;
    let new_prefix = validate_structural_operation(&manifest, target, &payload, &request_id)?;

    let rewrite_destination = match payload.operation_type {
        HostedStructuralOperationType::Rename | HostedStructuralOperationType::Move => {
            Some(new_prefix.as_deref())
        }
        HostedStructuralOperationType::Trash if payload.remove_references => Some(None),
        _ => None,
    };
    let rewrites = if let Some(new_path) = rewrite_destination {
        compute_reference_rewrites(
            &state,
            &manifest,
            &target.relative_path,
            new_path,
            &request_id,
        )
        .await?
    } else {
        Vec::new()
    };
    let mut planned_revisions = Vec::with_capacity(rewrites.len());
    for rewrite in rewrites {
        let bytes = rewrite.content.into_bytes();
        let digest = state
            .blobs
            .put(&bytes)
            .await
            .map_err(|_| ApiFailure::server(request_id.clone()))?;
        planned_revisions.push((
            rewrite.file_id,
            rewrite.revision_sequence,
            digest,
            bytes.len(),
        ));
    }

    let actor_id = user_uuid(&actor.user);
    let operation_id = Uuid::now_v7();
    let mut transaction = state
        .database
        .begin()
        .await
        .map_err(|_| ApiFailure::server(request_id.clone()))?;
    let current_manifest = lock_active_vault(&mut transaction, vault_id, &request_id).await?;
    if current_manifest != payload.base_manifest_sequence {
        return Err(ApiFailure::manifest_conflict(request_id));
    }
    match payload.operation_type {
        HostedStructuralOperationType::Rename => {
            let (name, normalized_name) = collab_core::normalize_hosted_name(
                payload.name.as_deref().unwrap(),
            )
            .map_err(|error| ApiFailure::path_invalid(error.to_string(), request_id.clone()))?;
            sqlx::query(
                "UPDATE hosted_file_entries SET name = $1, normalized_name = $2, updated_at = NOW() WHERE vault_id = $3 AND id = $4 AND state = 'active'",
            )
            .bind(name)
            .bind(normalized_name)
            .bind(vault_id)
            .bind(payload.target_file_id)
            .execute(&mut *transaction)
            .await
            .map_err(|error| map_path_database_error(error, request_id.clone()))?;
        }
        HostedStructuralOperationType::Move => {
            sqlx::query(
                "UPDATE hosted_file_entries SET parent_id = $1, updated_at = NOW() WHERE vault_id = $2 AND id = $3 AND state = 'active'",
            )
            .bind(payload.parent_id)
            .bind(vault_id)
            .bind(payload.target_file_id)
            .execute(&mut *transaction)
            .await
            .map_err(|error| map_path_database_error(error, request_id.clone()))?;
        }
        HostedStructuralOperationType::Trash => {
            sqlx::query(
                r#"
                WITH RECURSIVE affected AS (
                  SELECT id, parent_id, name FROM hosted_file_entries
                  WHERE vault_id = $1 AND id = $2 AND state = 'active'
                  UNION ALL
                  SELECT child.id, child.parent_id, child.name
                  FROM hosted_file_entries child JOIN affected parent ON child.parent_id = parent.id
                  WHERE child.vault_id = $1 AND child.state = 'active'
                )
                INSERT INTO hosted_trash_records (file_id, vault_id, original_parent_id, original_name, trashed_by)
                SELECT id, $1, parent_id, name, $3 FROM affected
                ON CONFLICT (file_id) DO NOTHING
                "#,
            )
            .bind(vault_id)
            .bind(payload.target_file_id)
            .bind(actor_id)
            .execute(&mut *transaction)
            .await
            .map_err(|_| ApiFailure::server(request_id.clone()))?;
            update_subtree_state(
                &mut transaction,
                vault_id,
                payload.target_file_id,
                "trashed",
                &request_id,
            )
            .await?;
        }
        HostedStructuralOperationType::Restore => {
            let root = sqlx::query(
                "SELECT original_parent_id, original_name FROM hosted_trash_records WHERE vault_id = $1 AND file_id = $2",
            )
            .bind(vault_id)
            .bind(payload.target_file_id)
            .fetch_optional(&mut *transaction)
            .await
            .map_err(|_| ApiFailure::server(request_id.clone()))?
            .ok_or_else(|| ApiFailure::not_found(request_id.clone()))?;
            let original_name: String = root.get("original_name");
            let (_, normalized_name) = collab_core::normalize_hosted_name(&original_name)
                .map_err(|error| ApiFailure::path_invalid(error.to_string(), request_id.clone()))?;
            sqlx::query(
                "UPDATE hosted_file_entries SET parent_id = $1, name = $2, normalized_name = $3 WHERE vault_id = $4 AND id = $5",
            )
            .bind(root.get::<Option<Uuid>, _>("original_parent_id"))
            .bind(original_name)
            .bind(normalized_name)
            .bind(vault_id)
            .bind(payload.target_file_id)
            .execute(&mut *transaction)
            .await
            .map_err(|error| map_path_database_error(error, request_id.clone()))?;
            update_subtree_state(
                &mut transaction,
                vault_id,
                payload.target_file_id,
                "active",
                &request_id,
            )
            .await?;
            delete_subtree_trash_records(
                &mut transaction,
                vault_id,
                payload.target_file_id,
                &request_id,
            )
            .await?;
        }
        HostedStructuralOperationType::Purge => {
            update_subtree_state(
                &mut transaction,
                vault_id,
                payload.target_file_id,
                "tombstoned",
                &request_id,
            )
            .await?;
            delete_subtree_trash_records(
                &mut transaction,
                vault_id,
                payload.target_file_id,
                &request_id,
            )
            .await?;
        }
    }
    let mut rewritten_document_ids = Vec::with_capacity(planned_revisions.len());
    for (file_id, revision_sequence, digest, size) in &planned_revisions {
        insert_blob_record(&mut transaction, digest, *size, "text/plain", &request_id).await?;
        let revision_id = Uuid::now_v7();
        sqlx::query(
            "INSERT INTO hosted_file_revisions (id, vault_id, file_id, sequence, blob_digest, content_hash, size_bytes, created_by) VALUES ($1, $2, $3, $4, $5, $5, $6, $7)",
        )
        .bind(revision_id)
        .bind(vault_id)
        .bind(file_id)
        .bind(revision_sequence + 1)
        .bind(digest)
        .bind(*size as i64)
        .bind(actor_id)
        .execute(&mut *transaction)
        .await
        .map_err(|_| ApiFailure::server(request_id.clone()))?;
        sqlx::query(
            "UPDATE hosted_file_entries SET current_revision_id = $1, updated_at = NOW() WHERE vault_id = $2 AND id = $3",
        )
        .bind(revision_id)
        .bind(vault_id)
        .bind(file_id)
        .execute(&mut *transaction)
        .await
        .map_err(|_| ApiFailure::server(request_id.clone()))?;
        rewritten_document_ids.push(file_id.to_string());
    }
    let result_manifest = increment_manifest(&mut transaction, vault_id, &request_id).await?;
    mark_manifest_subtree_changed(
        &mut transaction,
        vault_id,
        payload.target_file_id,
        result_manifest,
        &request_id,
    )
    .await?;
    let rewritten_file_ids = planned_revisions
        .iter()
        .map(|(file_id, _, _, _)| *file_id)
        .collect::<Vec<_>>();
    mark_manifest_files_changed(
        &mut transaction,
        vault_id,
        &rewritten_file_ids,
        result_manifest,
        &request_id,
    )
    .await?;
    sqlx::query(
        "INSERT INTO hosted_structural_operations (id, client_operation_id, vault_id, actor_user_id, base_manifest_sequence, result_manifest_sequence, operation_type, payload) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)",
    )
    .bind(operation_id)
    .bind(payload.client_operation_id)
    .bind(vault_id)
    .bind(actor_id)
    .bind(payload.base_manifest_sequence)
    .bind(result_manifest)
    .bind(structural_operation_name(payload.operation_type))
    .bind(json!({
        "targetFileId": payload.target_file_id,
        "name": payload.name,
        "parentId": payload.parent_id,
        "rewrittenDocumentIds": rewritten_document_ids,
    }))
    .execute(&mut *transaction)
    .await
    .map_err(|_| ApiFailure::server(request_id.clone()))?;
    vault_activity_event(
        &mut transaction,
        vault_id,
        Some(actor_id),
        structural_activity_name(payload.operation_type),
        Some("file"),
        Some(&payload.target_file_id.to_string()),
        json!({"manifestSequence": result_manifest}),
        &request_id,
    )
    .await?;
    if !rewritten_document_ids.is_empty() {
        vault_activity_event(
            &mut transaction,
            vault_id,
            Some(actor_id),
            "file.references_rewritten",
            Some("file"),
            Some(&payload.target_file_id.to_string()),
            json!({"documents": rewritten_document_ids}),
            &request_id,
        )
        .await?;
    }
    transaction
        .commit()
        .await
        .map_err(|_| ApiFailure::server(request_id.clone()))?;
    Ok(Json(DataResponse::new(HostedStructuralOperationResult {
        operation_id: operation_id.to_string(),
        client_operation_id: payload.client_operation_id.to_string(),
        operation_type: payload.operation_type,
        target_file_id: payload.target_file_id.to_string(),
        result_manifest_sequence: result_manifest,
        already_applied: false,
        rewritten_document_ids,
    })))
}

pub async fn preview_structural_operation(
    State(state): State<AppState>,
    Extension(request_id): Extension<String>,
    headers: HeaderMap,
    Path(vault_id): Path<Uuid>,
    Json(payload): Json<StructuralOperationPreviewRequest>,
) -> Result<Json<DataResponse<HostedStructuralOperationPreview>>, ApiFailure> {
    let actor = require_any_user(&state, &headers, &request_id).await?;
    // The preview requires the same capability as the operation it describes.
    match payload.operation_type {
        HostedStructuralOperationType::Purge => {
            require_active_vault_admin(&state.database, vault_id, &actor.user, &request_id).await?;
        }
        operation_type => {
            require_active_capability(
                &state.database,
                vault_id,
                &actor.user,
                structural_operation_capability(operation_type),
                &request_id,
            )
            .await?;
        }
    }
    let manifest = load_vault_manifest(&state.database, vault_id, &request_id).await?;
    let target = manifest
        .files
        .iter()
        .find(|file| file.id == payload.target_file_id.to_string())
        .ok_or_else(|| ApiFailure::not_found(request_id.clone()))?;
    let validation = StructuralOperationRequest {
        client_operation_id: Uuid::nil(),
        base_manifest_sequence: manifest.sequence,
        operation_type: payload.operation_type,
        target_file_id: payload.target_file_id,
        name: payload.name.clone(),
        parent_id: payload.parent_id,
        remove_references: false,
    };
    let mut new_relative_path = None;
    let mut blocked_reason = None;
    match validate_structural_operation(&manifest, target, &validation, &request_id) {
        Ok(prefix) => new_relative_path = prefix,
        Err(failure) => blocked_reason = Some(failure.message().to_owned()),
    }
    if blocked_reason.is_none() {
        if let Some(next_path) = new_relative_path.as_deref() {
            if next_path == target.relative_path {
                blocked_reason = Some("The destination matches the current path.".into());
            } else if manifest.files.iter().any(|file| {
                file.id != target.id
                    && file.state == HostedFileState::Active
                    && file.relative_path.to_lowercase() == next_path.to_lowercase()
            }) {
                blocked_reason = Some("The destination path already exists.".into());
            }
        }
    }
    let rewrite_destination = if blocked_reason.is_some() {
        None
    } else {
        match payload.operation_type {
            HostedStructuralOperationType::Rename | HostedStructuralOperationType::Move => {
                Some(new_relative_path.as_deref())
            }
            HostedStructuralOperationType::Trash => Some(None),
            _ => None,
        }
    };
    let affected_documents = if let Some(new_path) = rewrite_destination {
        compute_reference_rewrites(
            &state,
            &manifest,
            &target.relative_path,
            new_path,
            &request_id,
        )
        .await?
        .into_iter()
        .map(|rewrite| HostedReferenceImpact {
            file_id: rewrite.file_id.to_string(),
            relative_path: rewrite.relative_path,
        })
        .collect()
    } else {
        Vec::new()
    };
    let nested_item_count = manifest
        .files
        .iter()
        .filter(|file| {
            file.state == HostedFileState::Active
                && file
                    .relative_path
                    .starts_with(&format!("{}/", target.relative_path))
        })
        .count() as i64;
    Ok(Json(DataResponse::new(HostedStructuralOperationPreview {
        operation_type: payload.operation_type,
        target_file_id: target.id.clone(),
        item_kind: target.kind,
        old_relative_path: target.relative_path.clone(),
        new_relative_path,
        nested_item_count,
        affected_documents,
        blocked_reason,
    })))
}

pub async fn list_file_references(
    State(state): State<AppState>,
    Extension(request_id): Extension<String>,
    headers: HeaderMap,
    Path((vault_id, file_id)): Path<(Uuid, Uuid)>,
) -> Result<Json<DataResponse<Vec<HostedFileReference>>>, ApiFailure> {
    let actor = require_authenticated_user(&state, &headers, &request_id).await?;
    require_capability(
        &state.database,
        vault_id,
        user_uuid(&actor.user),
        Capability::VaultRead,
        &request_id,
    )
    .await?;
    let manifest = load_vault_manifest(&state.database, vault_id, &request_id).await?;
    let target = manifest
        .files
        .iter()
        .find(|file| file.id == file_id.to_string())
        .ok_or_else(|| ApiFailure::not_found(request_id.clone()))?;
    if target.state != HostedFileState::Active {
        return Err(ApiFailure::validation(
            "Only active files can be inspected for references.",
            request_id,
        ));
    }
    let target_path = target.relative_path.clone();
    let lookup = collab_core::references::build_reference_lookup(
        manifest
            .files
            .iter()
            .filter(|file| {
                file.kind != HostedFileKind::Folder && file.state == HostedFileState::Active
            })
            .map(|file| file.relative_path.as_str()),
    );
    let path_ids = manifest
        .files
        .iter()
        .filter(|file| file.state == HostedFileState::Active)
        .map(|file| (file.relative_path.as_str(), file.id.as_str()))
        .collect::<HashMap<_, _>>();
    let mut references = Vec::new();
    for file in &manifest.files {
        if file.kind != HostedFileKind::Document
            || file.state != HostedFileState::Active
            || file.id == target.id
            || collab_core::references::path_matches_or_descends(&file.relative_path, &target_path)
        {
            continue;
        }
        let Some(revision) = file.current_revision.as_ref() else {
            continue;
        };
        let content = load_blob_text(&state, &revision.content_hash, &request_id).await?;
        let collected = match file.document_type.unwrap_or(HostedDocumentType::Note) {
            HostedDocumentType::Note => collab_core::references::collect_note_references(
                &content,
                &file.relative_path,
                &lookup,
                &target_path,
            ),
            HostedDocumentType::Kanban => collab_core::references::collect_kanban_references(
                &content,
                &file.relative_path,
                &target_path,
            )
            .unwrap_or_default(),
            HostedDocumentType::Canvas => collab_core::references::collect_canvas_references(
                &content,
                &file.relative_path,
                &target_path,
            )
            .unwrap_or_default(),
        };
        for reference in collected {
            let referenced_file_id = path_ids
                .get(reference.referenced_relative_path.as_str())
                .map(|id| (*id).to_owned());
            references.push(HostedFileReference {
                source_file_id: file.id.clone(),
                source_relative_path: reference.source_relative_path,
                source_document_type: reference.source_document_type,
                reference_kind: reference.reference_kind,
                referenced_file_id,
                referenced_relative_path: reference.referenced_relative_path,
                display_label: reference.display_label,
                context: reference.context,
            });
        }
    }
    references.sort_by(|a, b| {
        a.source_relative_path
            .cmp(&b.source_relative_path)
            .then(a.reference_kind.cmp(&b.reference_kind))
            .then(a.display_label.cmp(&b.display_label))
    });
    Ok(Json(DataResponse::new(references)))
}

pub async fn search_vault(
    State(state): State<AppState>,
    Extension(request_id): Extension<String>,
    headers: HeaderMap,
    Path(vault_id): Path<Uuid>,
    Query(query): Query<VaultSearchQuery>,
) -> Result<Json<DataResponse<Vec<HostedSearchResult>>>, ApiFailure> {
    let actor = require_authenticated_user(&state, &headers, &request_id).await?;
    require_capability(
        &state.database,
        vault_id,
        user_uuid(&actor.user),
        Capability::VaultSearch,
        &request_id,
    )
    .await?;
    let query = query.q.trim();
    if query.is_empty() {
        return Ok(Json(DataResponse::new(Vec::new())));
    }
    if query.chars().count() > 200 {
        return Err(ApiFailure::validation(
            "Search queries must be at most 200 characters.",
            request_id,
        ));
    }
    let manifest = load_vault_manifest(&state.database, vault_id, &request_id).await?;
    ensure_hosted_note_index(&state, &manifest, &request_id).await?;
    let rows = sqlx::query(
        r#"
        SELECT file_id, title, content, tags,
               (
                 ts_rank(search_vector, plainto_tsquery('simple', $2))
                 + CASE WHEN title ILIKE $3 THEN 0.5 ELSE 0 END
               )::REAL AS rank
        FROM hosted_note_index
        WHERE vault_id = $1
          AND (
            search_vector @@ plainto_tsquery('simple', $2)
            OR title ILIKE $3
            OR content ILIKE $3
            OR EXISTS (SELECT 1 FROM unnest(tags) tag WHERE tag ILIKE $3)
          )
        ORDER BY rank DESC, indexed_at DESC
        LIMIT 50
        "#,
    )
    .bind(vault_id)
    .bind(query)
    .bind(format!("%{query}%"))
    .fetch_all(&state.database)
    .await
    .map_err(|_| ApiFailure::server(request_id.clone()))?;
    let paths = manifest
        .files
        .iter()
        .map(|file| (file.id.as_str(), file.relative_path.as_str()))
        .collect::<HashMap<_, _>>();
    Ok(Json(DataResponse::new(
        rows.iter()
            .filter_map(|row| {
                let file_id = row.get::<Uuid, _>("file_id").to_string();
                Some(HostedSearchResult {
                    relative_path: paths.get(file_id.as_str())?.to_string(),
                    file_id,
                    title: row.get("title"),
                    excerpt: search_excerpt(row.get::<String, _>("content").as_str(), query, 180),
                    tags: row.get("tags"),
                    rank: row.get("rank"),
                })
            })
            .collect(),
    )))
}

struct VaultImportEntry {
    relative_path: String,
    name: String,
    parent_path: Option<String>,
    kind: HostedFileKind,
    document_type: Option<HostedDocumentType>,
    content: Option<Vec<u8>>,
    digest: Option<String>,
}

pub async fn import_vault_zip(
    State(state): State<AppState>,
    Extension(request_id): Extension<String>,
    headers: HeaderMap,
    Path(vault_id): Path<Uuid>,
    Json(payload): Json<ImportVaultZipRequest>,
) -> Result<(StatusCode, Json<DataResponse<HostedVaultImportResult>>), ApiFailure> {
    let actor = require_any_user(&state, &headers, &request_id).await?;
    require_active_capability(
        &state.database,
        vault_id,
        &actor.user,
        Capability::VaultImport,
        &request_id,
    )
    .await?;
    let archive_bytes = STANDARD.decode(payload.archive_base64).map_err(|_| {
        ApiFailure::validation("Vault import is not valid base64.", request_id.clone())
    })?;
    let settings = load_effective_runtime_settings(&state.config);
    if archive_bytes.len() > settings.max_import_bytes {
        return Err(ApiFailure::quota_exceeded(request_id));
    }
    let manifest = load_vault_manifest(&state.database, vault_id, &request_id).await?;
    if manifest
        .files
        .iter()
        .any(|file| file.state == HostedFileState::Active)
    {
        return Err(ApiFailure::validation(
            "ZIP import currently requires an empty hosted vault.",
            request_id,
        ));
    }
    let mut entries = parse_vault_zip(
        &archive_bytes,
        settings.max_file_bytes,
        settings.max_import_expanded_bytes,
        &request_id,
    )?;
    let quota_incoming: Vec<(String, usize)> = entries
        .iter()
        .filter_map(|entry| {
            entry
                .content
                .as_deref()
                .map(|content| (collab_core::sha256_bytes(content), content.len()))
        })
        .collect();
    enforce_storage_quota(
        &state.database,
        settings.storage_quota_bytes,
        &quota_incoming,
        &request_id,
    )
    .await?;
    let mut imported_bytes = 0usize;
    for entry in &mut entries {
        if let Some(content) = entry.content.as_deref() {
            imported_bytes += content.len();
            entry.digest = Some(
                state
                    .blobs
                    .put(content)
                    .await
                    .map_err(|_| ApiFailure::server(request_id.clone()))?,
            );
        }
    }
    let actor_id = user_uuid(&actor.user);
    let mut transaction = state
        .database
        .begin()
        .await
        .map_err(|_| ApiFailure::server(request_id.clone()))?;
    lock_active_vault(&mut transaction, vault_id, &request_id).await?;
    let mut path_ids = HashMap::<String, Uuid>::new();
    for entry in &entries {
        let file_id = Uuid::now_v7();
        let parent_id = entry
            .parent_path
            .as_ref()
            .and_then(|path| path_ids.get(path))
            .copied();
        let (_, normalized_name) = collab_core::normalize_hosted_name(&entry.name)
            .map_err(|error| ApiFailure::path_invalid(error.to_string(), request_id.clone()))?;
        sqlx::query(
            "INSERT INTO hosted_file_entries (id, vault_id, parent_id, name, normalized_name, kind, document_type, created_by) VALUES ($1, $2, $3, $4, $5, $6::hosted_file_kind, $7::hosted_document_type, $8)",
        )
        .bind(file_id)
        .bind(vault_id)
        .bind(parent_id)
        .bind(&entry.name)
        .bind(normalized_name)
        .bind(file_kind_name(entry.kind))
        .bind(entry.document_type.map(document_type_name))
        .bind(actor_id)
        .execute(&mut *transaction)
        .await
        .map_err(|error| map_path_database_error(error, request_id.clone()))?;
        if let (Some(content), Some(digest)) = (entry.content.as_deref(), entry.digest.as_deref()) {
            let revision_id = Uuid::now_v7();
            let media_type = if entry.kind == HostedFileKind::Document {
                "text/plain"
            } else {
                "application/octet-stream"
            };
            insert_blob_record(
                &mut transaction,
                digest,
                content.len(),
                media_type,
                &request_id,
            )
            .await?;
            sqlx::query(
                "INSERT INTO hosted_file_revisions (id, vault_id, file_id, sequence, blob_digest, content_hash, size_bytes, created_by) VALUES ($1, $2, $3, 1, $4, $4, $5, $6)",
            )
            .bind(revision_id)
            .bind(vault_id)
            .bind(file_id)
            .bind(digest)
            .bind(content.len() as i64)
            .bind(actor_id)
            .execute(&mut *transaction)
            .await
            .map_err(|_| ApiFailure::server(request_id.clone()))?;
            sqlx::query("UPDATE hosted_file_entries SET current_revision_id = $1 WHERE id = $2")
                .bind(revision_id)
                .bind(file_id)
                .execute(&mut *transaction)
                .await
                .map_err(|_| ApiFailure::server(request_id.clone()))?;
        }
        path_ids.insert(entry.relative_path.clone(), file_id);
    }
    let result_manifest_sequence =
        increment_manifest(&mut transaction, vault_id, &request_id).await?;
    let imported_file_ids = path_ids.values().copied().collect::<Vec<_>>();
    mark_manifest_files_changed(
        &mut transaction,
        vault_id,
        &imported_file_ids,
        result_manifest_sequence,
        &request_id,
    )
    .await?;
    let imported_folders = entries
        .iter()
        .filter(|entry| entry.kind == HostedFileKind::Folder)
        .count() as u64;
    let imported_files = entries.len() as u64 - imported_folders;
    vault_activity_event(
        &mut transaction,
        vault_id,
        Some(actor_id),
        "vault.imported",
        Some("vault"),
        Some(&vault_id.to_string()),
        json!({"files": imported_files, "folders": imported_folders, "bytes": imported_bytes}),
        &request_id,
    )
    .await?;
    transaction
        .commit()
        .await
        .map_err(|_| ApiFailure::server(request_id.clone()))?;
    Ok((
        StatusCode::CREATED,
        Json(DataResponse::new(HostedVaultImportResult {
            imported_files,
            imported_folders,
            imported_bytes: imported_bytes as u64,
            result_manifest_sequence,
        })),
    ))
}

pub async fn export_vault_zip(
    State(state): State<AppState>,
    Extension(request_id): Extension<String>,
    headers: HeaderMap,
    Path(vault_id): Path<Uuid>,
) -> Result<Response, ApiFailure> {
    let actor = require_authenticated_user(&state, &headers, &request_id).await?;
    require_capability(
        &state.database,
        vault_id,
        user_uuid(&actor.user),
        Capability::VaultExport,
        &request_id,
    )
    .await?;
    let manifest = load_vault_manifest(&state.database, vault_id, &request_id).await?;
    let mut archive = zip::ZipWriter::new(Cursor::new(Vec::new()));
    let options = zip::write::SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated);
    for file in manifest
        .files
        .iter()
        .filter(|file| file.state == HostedFileState::Active)
    {
        if file.kind == HostedFileKind::Folder {
            archive
                .add_directory(format!("{}/", file.relative_path), options)
                .map_err(|_| ApiFailure::server(request_id.clone()))?;
            continue;
        }
        let digest = file
            .current_revision
            .as_ref()
            .map(|revision| revision.content_hash.as_str())
            .ok_or_else(|| ApiFailure::server(request_id.clone()))?;
        let bytes = state
            .blobs
            .get(digest)
            .await
            .map_err(|_| ApiFailure::server(request_id.clone()))?
            .ok_or_else(|| ApiFailure::server(request_id.clone()))?;
        archive
            .start_file(&file.relative_path, options)
            .map_err(|_| ApiFailure::server(request_id.clone()))?;
        archive
            .write_all(&bytes)
            .map_err(|_| ApiFailure::server(request_id.clone()))?;
    }
    let bytes = archive
        .finish()
        .map_err(|_| ApiFailure::server(request_id.clone()))?
        .into_inner();
    let mut response = Response::new(Body::from(bytes));
    response.headers_mut().insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("application/zip"),
    );
    response.headers_mut().insert(
        header::CONTENT_DISPOSITION,
        HeaderValue::from_static("attachment; filename=\"collab-vault.zip\""),
    );
    Ok(response)
}

/// Downloads a single vault folder and all of its active descendants as a ZIP
/// archive, with entry paths made relative to the folder's parent so the folder
/// itself is the archive root.
pub async fn download_vault_folder_archive(
    State(state): State<AppState>,
    Extension(request_id): Extension<String>,
    headers: HeaderMap,
    Path((vault_id, file_id)): Path<(Uuid, Uuid)>,
) -> Result<Response, ApiFailure> {
    let actor = require_authenticated_user(&state, &headers, &request_id).await?;
    require_capability(
        &state.database,
        vault_id,
        user_uuid(&actor.user),
        Capability::VaultRead,
        &request_id,
    )
    .await?;
    let manifest = load_vault_manifest(&state.database, vault_id, &request_id).await?;
    let file_id_string = file_id.to_string();
    let folder = manifest
        .files
        .iter()
        .find(|file| {
            file.id == file_id_string
                && file.kind == HostedFileKind::Folder
                && file.state == HostedFileState::Active
        })
        .ok_or_else(|| ApiFailure::not_found(request_id.clone()))?;
    let folder_path = folder.relative_path.clone();
    let descendant_prefix = format!("{folder_path}/");
    // Keep the folder name (but not its ancestors) as the archive root.
    let parent_prefix = match folder_path.rfind('/') {
        Some(index) => folder_path[..=index].to_owned(),
        None => String::new(),
    };
    let mut archive = zip::ZipWriter::new(Cursor::new(Vec::new()));
    let options = zip::write::SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated);
    for file in manifest
        .files
        .iter()
        .filter(|file| file.state == HostedFileState::Active)
    {
        if file.relative_path != folder_path && !file.relative_path.starts_with(&descendant_prefix)
        {
            continue;
        }
        let entry_path = file
            .relative_path
            .strip_prefix(&parent_prefix)
            .unwrap_or(&file.relative_path);
        if file.kind == HostedFileKind::Folder {
            archive
                .add_directory(format!("{entry_path}/"), options)
                .map_err(|_| ApiFailure::server(request_id.clone()))?;
            continue;
        }
        let digest = file
            .current_revision
            .as_ref()
            .map(|revision| revision.content_hash.as_str())
            .ok_or_else(|| ApiFailure::server(request_id.clone()))?;
        let bytes = state
            .blobs
            .get(digest)
            .await
            .map_err(|_| ApiFailure::server(request_id.clone()))?
            .ok_or_else(|| ApiFailure::server(request_id.clone()))?;
        archive
            .start_file(entry_path, options)
            .map_err(|_| ApiFailure::server(request_id.clone()))?;
        archive
            .write_all(&bytes)
            .map_err(|_| ApiFailure::server(request_id.clone()))?;
    }
    let bytes = archive
        .finish()
        .map_err(|_| ApiFailure::server(request_id.clone()))?
        .into_inner();
    let safe_name: String = folder
        .name
        .chars()
        .map(|character| {
            if matches!(character, ' ' | '-' | '_' | '.') || character.is_ascii_alphanumeric() {
                character
            } else {
                '_'
            }
        })
        .collect();
    let safe_name = if safe_name.trim().is_empty() {
        "folder".to_owned()
    } else {
        safe_name
    };
    let mut response = Response::new(Body::from(bytes));
    response.headers_mut().insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("application/zip"),
    );
    response.headers_mut().insert(
        header::CONTENT_DISPOSITION,
        HeaderValue::from_str(&format!("attachment; filename=\"{safe_name}.zip\""))
            .unwrap_or_else(|_| HeaderValue::from_static("attachment; filename=\"folder.zip\"")),
    );
    Ok(response)
}

struct ReferenceRewrite {
    file_id: Uuid,
    relative_path: String,
    revision_sequence: i64,
    content: String,
}

async fn compute_reference_rewrites(
    state: &AppState,
    manifest: &HostedVaultManifest,
    old_path: &str,
    new_path: Option<&str>,
    request_id: &str,
) -> Result<Vec<ReferenceRewrite>, ApiFailure> {
    let mut rewrites = Vec::new();
    for file in &manifest.files {
        if file.kind != HostedFileKind::Document
            || file.state != HostedFileState::Active
            || collab_core::references::path_matches_or_descends(&file.relative_path, old_path)
        {
            continue;
        }
        let Some(revision) = file.current_revision.as_ref() else {
            continue;
        };
        let content = load_blob_text(state, &revision.content_hash, request_id).await?;
        // Unparseable board/canvas documents are skipped rather than blocking
        // the structural operation; they cannot hold resolvable references.
        let rewritten = match file.document_type.unwrap_or(HostedDocumentType::Note) {
            HostedDocumentType::Note => Some(collab_core::references::rewrite_note_references(
                &content,
                &file.relative_path,
                old_path,
                new_path,
            )),
            HostedDocumentType::Kanban => {
                collab_core::references::rewrite_kanban_references(&content, old_path, new_path)
                    .ok()
            }
            HostedDocumentType::Canvas => {
                collab_core::references::rewrite_canvas_references(&content, old_path, new_path)
                    .ok()
            }
        };
        let Some(rewritten) = rewritten else {
            continue;
        };
        if rewritten == content {
            continue;
        }
        rewrites.push(ReferenceRewrite {
            file_id: Uuid::parse_str(&file.id).expect("stored file IDs are valid UUIDs"),
            relative_path: file.relative_path.clone(),
            revision_sequence: revision.sequence,
            content: rewritten,
        });
    }
    Ok(rewrites)
}

pub async fn overview(
    State(state): State<AppState>,
    Extension(request_id): Extension<String>,
    headers: HeaderMap,
) -> Result<Json<DataResponse<AdminOverview>>, ApiFailure> {
    require_admin(&state, &headers, &request_id).await?;
    let counts = sqlx::query(
        r#"
        SELECT
          (SELECT COUNT(*) FROM users) AS users,
          (SELECT COUNT(*) FROM users WHERE status = 'active') AS active_users,
          ((SELECT COUNT(*) FROM sessions WHERE revoked_at IS NULL AND expires_at > NOW())
           + (SELECT COUNT(*) FROM native_sessions WHERE revoked_at IS NULL AND refresh_expires_at > NOW())) AS active_sessions,
          (SELECT COUNT(*) FROM invitations WHERE accepted_at IS NULL AND revoked_at IS NULL AND expires_at > NOW()) AS pending_invitations,
          (SELECT COUNT(*) FROM hosted_vaults WHERE status <> 'pending_delete') AS hosted_vaults
        "#,
    )
    .fetch_one(&state.database)
    .await
    .map_err(|_| ApiFailure::server(request_id.clone()))?;
    let events = list_audit_events(&state.database, 8, &request_id).await?;
    let runtime_live_metrics = state.hub.runtime_metrics().await;
    let persisted_live_metrics = sqlx::query(
        r#"
        SELECT
          (SELECT COUNT(*) FROM crdt_updates) AS pending_update_count,
          (SELECT COALESCE(SUM(octet_length(update_bytes)), 0) FROM crdt_updates) AS pending_update_bytes,
          (SELECT COUNT(*) FROM crdt_updates WHERE created_at >= NOW() - INTERVAL '60 seconds') AS updates_last_minute,
          (SELECT COUNT(*) FROM crdt_documents) AS compacted_documents,
          (SELECT COALESCE(SUM(octet_length(doc_state)), 0) FROM crdt_documents) AS compacted_state_bytes,
          (SELECT MAX(updated_at) FROM crdt_documents) AS last_compaction_at,
          (SELECT COUNT(*)
             FROM hosted_presence p
             JOIN users u ON u.id = p.user_id
            WHERE p.updated_at >= NOW() - INTERVAL '30 seconds'
              AND u.status = 'active') AS active_presence_users
        "#,
    )
    .fetch_one(&state.database)
    .await
    .map_err(|_| ApiFailure::server(request_id.clone()))?;
    let database_bytes =
        sqlx::query_scalar::<_, i64>("SELECT pg_database_size(current_database())")
            .fetch_one(&state.database)
            .await
            .map_err(|_| ApiFailure::server(request_id.clone()))?;
    let blob_bytes = state
        .blobs
        .total_bytes()
        .await
        .map_err(|_| ApiFailure::server(request_id.clone()))?;
    let stored_content_bytes = stored_content_bytes(&state.database)
        .await
        .map_err(|_| ApiFailure::server(request_id.clone()))?;
    let blob_health_ok = state.blobs.health_check().await.is_ok();
    let settings = load_effective_runtime_settings(&state.config);
    let maintenance = load_maintenance_mode(&state.config);
    let pending_update_count: i64 = persisted_live_metrics.get("pending_update_count");
    let pending_update_bytes: i64 = persisted_live_metrics.get("pending_update_bytes");
    let backup_overview = load_backup_overview(&state);
    let backup_failure_count = sqlx::query_scalar::<_, i64>(
        r#"
        SELECT COUNT(*)
          FROM audit_events
         WHERE action IN ('admin.backup.run', 'admin.backup.restore')
           AND result = 'failure'
           AND created_at >= NOW() - INTERVAL '24 hours'
        "#,
    )
    .fetch_one(&state.database)
    .await
    .map_err(|_| ApiFailure::server(request_id.clone()))?;
    let mut warnings = Vec::new();
    if !blob_health_ok {
        warnings.push(OperationalWarning {
            code: "blob_storage_unavailable".into(),
            message: "Blob storage health check failed. File reads, uploads, and backups may be incomplete."
                .into(),
            severity: "critical".into(),
        });
    }
    if maintenance.enabled {
        warnings.push(OperationalWarning {
            code: "maintenance_mode".into(),
            message: maintenance
                .message
                .clone()
                .unwrap_or_else(|| "Maintenance mode is enabled. Mutating API requests and live WebSocket sessions are paused.".into()),
            severity: "warning".into(),
        });
    }
    if !settings.browser_secure_cookies {
        warnings.push(OperationalWarning {
            code: "insecure_browser_cookies".into(),
            message: "Secure browser cookies are disabled. Enable them behind TLS for production."
                .into(),
            severity: "warning".into(),
        });
    }
    let expired_invitations = sqlx::query_scalar::<_, i64>(
        "SELECT COUNT(*) FROM invitations WHERE accepted_at IS NULL AND revoked_at IS NULL AND expires_at <= NOW()",
    ).fetch_one(&state.database).await.map_err(|_| ApiFailure::server(request_id.clone()))?;
    if expired_invitations > 0 {
        warnings.push(OperationalWarning {
            code: "expired_invitations".into(),
            message: format!("{expired_invitations} expired invitation(s) can be cleaned up."),
            severity: "info".into(),
        });
    }
    if state.config.backup_command.is_some() {
        if backup_overview.backups.is_empty() {
            warnings.push(OperationalWarning {
                code: "backup_missing".into(),
                message:
                    "No verified backup artifacts were found in the configured backup directory."
                        .into(),
                severity: "warning".into(),
            });
        } else if let Some(latest_backup_age) = latest_backup_age(&backup_overview.backups) {
            let stale_after =
                Duration::from_secs(backup_overview.settings.interval_seconds.saturating_mul(2))
                    .max(Duration::from_secs(24 * 60 * 60));
            if latest_backup_age > stale_after {
                warnings.push(OperationalWarning {
                    code: "backup_stale".into(),
                    message: format!(
                        "Latest backup is older than {} hours.",
                        stale_after.as_secs() / 3600
                    ),
                    severity: "warning".into(),
                });
            }
        }
    }
    if backup_failure_count > 0 {
        warnings.push(OperationalWarning {
            code: "backup_failures".into(),
            message: format!(
                "{backup_failure_count} backup or restore failure(s) were recorded in the last {BACKUP_FAILURE_LOOKBACK_HOURS} hours."
            ),
            severity: "critical".into(),
        });
    }
    let storage_total_bytes = database_bytes.max(0) as u64 + blob_bytes;
    if settings.storage_warning_bytes > 0 && storage_total_bytes >= settings.storage_warning_bytes {
        warnings.push(OperationalWarning {
            code: "storage_pressure".into(),
            message: format!(
                "Database and blob storage total {} and crossed the configured warning threshold of {}.",
                format_bytes(storage_total_bytes),
                format_bytes(settings.storage_warning_bytes)
            ),
            severity: "warning".into(),
        });
    }
    if settings.storage_quota_bytes > 0 {
        if stored_content_bytes >= settings.storage_quota_bytes {
            warnings.push(OperationalWarning {
                code: "storage_quota_exceeded".into(),
                message: format!(
                    "Stored content totals {} and has reached the storage quota of {}. New uploads are blocked until content is removed.",
                    format_bytes(stored_content_bytes),
                    format_bytes(settings.storage_quota_bytes)
                ),
                severity: "critical".into(),
            });
        } else if stored_content_bytes * 10 >= settings.storage_quota_bytes * 9 {
            warnings.push(OperationalWarning {
                code: "storage_quota_pressure".into(),
                message: format!(
                    "Stored content totals {} and is within 10% of the storage quota of {}.",
                    format_bytes(stored_content_bytes),
                    format_bytes(settings.storage_quota_bytes)
                ),
                severity: "warning".into(),
            });
        }
    }
    if pending_update_count >= CRDT_PENDING_UPDATE_WARNING_COUNT
        || pending_update_bytes >= CRDT_PENDING_UPDATE_WARNING_BYTES
    {
        warnings.push(OperationalWarning {
            code: "crdt_compaction_backlog".into(),
            message: format!(
                "The live collaboration update log has {pending_update_count} pending update(s), totalling {}.",
                format_bytes(pending_update_bytes.max(0) as u64)
            ),
            severity: "warning".into(),
        });
    }
    Ok(Json(DataResponse::new(AdminOverview {
        health: if blob_health_ok {
            HealthState::Ok
        } else {
            HealthState::Degraded
        },
        server_version: env!("CARGO_PKG_VERSION").into(),
        protocol_version: collab_protocol::PROTOCOL_VERSION,
        uptime_seconds: state.started_at.elapsed().as_secs(),
        users: counts.get("users"),
        active_users: counts.get("active_users"),
        active_sessions: counts.get("active_sessions"),
        pending_invitations: counts.get("pending_invitations"),
        hosted_vaults: counts.get("hosted_vaults"),
        storage: StorageSummary {
            database_bytes,
            blob_bytes,
            warning_threshold_bytes: settings.storage_warning_bytes,
            stored_content_bytes,
            quota_bytes: settings.storage_quota_bytes,
        },
        live_collaboration: LiveCollaborationMetrics {
            active_connections: runtime_live_metrics.active_connections,
            loaded_rooms: runtime_live_metrics.loaded_rooms,
            active_awareness_states: runtime_live_metrics.active_awareness_states,
            active_presence_users: persisted_live_metrics.get("active_presence_users"),
            pending_update_count,
            pending_update_bytes,
            updates_last_minute: persisted_live_metrics.get("updates_last_minute"),
            compacted_documents: persisted_live_metrics.get("compacted_documents"),
            compacted_state_bytes: persisted_live_metrics.get("compacted_state_bytes"),
            last_compaction_at: persisted_live_metrics
                .get::<Option<chrono::DateTime<chrono::Utc>>, _>("last_compaction_at")
                .map(|value| value.to_rfc3339()),
        },
        operational_warnings: warnings,
        recent_audit_events: events,
    })))
}

pub async fn admin_backups(
    State(state): State<AppState>,
    Extension(request_id): Extension<String>,
    headers: HeaderMap,
) -> Result<Json<DataResponse<AdminBackupOverview>>, ApiFailure> {
    require_admin(&state, &headers, &request_id).await?;
    Ok(Json(DataResponse::new(load_backup_overview(&state))))
}

pub async fn admin_settings(
    State(state): State<AppState>,
    Extension(request_id): Extension<String>,
    headers: HeaderMap,
) -> Result<Json<DataResponse<AdminServerSettings>>, ApiFailure> {
    require_admin(&state, &headers, &request_id).await?;
    Ok(Json(DataResponse::new(load_server_settings(&state.config))))
}

/// Runs a retention/compaction maintenance pass on demand (the same work the
/// scheduled worker performs) and returns the reclaimed-record counts.
pub async fn admin_run_maintenance(
    State(state): State<AppState>,
    Extension(request_id): Extension<String>,
    headers: HeaderMap,
) -> Result<Json<DataResponse<MaintenanceReport>>, ApiFailure> {
    let actor = require_admin_csrf(&state, &headers, &request_id).await?;
    let policy = maintenance_policy_from_settings(&state.config);
    let report =
        crate::retention::run_maintenance(&state.database, state.blobs.as_ref(), policy).await;
    record_audit(
        &state.database,
        Some(&actor.user.id),
        "admin.maintenance.run",
        Some("maintenance"),
        None,
        "success",
        &request_id,
        json!({
            "prunedRevisions": report.pruned_revisions,
            "reclaimedBlobs": report.reclaimed_blobs,
            "reclaimedBlobBytes": report.reclaimed_blob_bytes,
            "prunedAuditEvents": report.pruned_audit_events,
        }),
    )
    .await?;
    Ok(Json(DataResponse::new(report)))
}

/// Current state of the runtime live-collaboration debug tracing toggle.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LiveDebugState {
    pub enabled: bool,
}

/// Request body for toggling live-collaboration debug tracing.
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetLiveDebugRequest {
    pub enabled: bool,
}

/// Reads whether verbose live-collaboration WS tracing is currently on.
pub async fn admin_get_live_debug(
    State(state): State<AppState>,
    Extension(request_id): Extension<String>,
    headers: HeaderMap,
) -> Result<Json<DataResponse<LiveDebugState>>, ApiFailure> {
    require_admin(&state, &headers, &request_id).await?;
    Ok(Json(DataResponse::new(LiveDebugState {
        enabled: state.hub.live_debug(),
    })))
}

/// Toggles verbose live-collaboration WS tracing at runtime (process-local, not
/// persisted). When enabled the relay emits `info!` traces of subscribe / apply /
/// broadcast / forward events so a live co-editing fault can be localized without
/// an env var or restart.
pub async fn admin_set_live_debug(
    State(state): State<AppState>,
    Extension(request_id): Extension<String>,
    headers: HeaderMap,
    Json(payload): Json<SetLiveDebugRequest>,
) -> Result<Json<DataResponse<LiveDebugState>>, ApiFailure> {
    let actor = require_admin_csrf(&state, &headers, &request_id).await?;
    state.hub.set_live_debug(payload.enabled);
    record_audit(
        &state.database,
        Some(&actor.user.id),
        "admin.live_debug.set",
        Some("live_debug"),
        None,
        "success",
        &request_id,
        json!({ "enabled": payload.enabled }),
    )
    .await?;
    Ok(Json(DataResponse::new(LiveDebugState {
        enabled: payload.enabled,
    })))
}

pub async fn admin_update_settings(
    State(state): State<AppState>,
    Extension(request_id): Extension<String>,
    headers: HeaderMap,
    Json(payload): Json<UpdateServerSettingsRequest>,
) -> Result<Json<DataResponse<AdminServerSettings>>, ApiFailure> {
    let actor = require_admin_csrf(&state, &headers, &request_id).await?;
    if let Some(runtime) = payload.runtime {
        let stored = apply_runtime_update(&state.config, runtime, &request_id)?;
        save_stored_runtime_settings(&state.config.backup_dir, &stored, &request_id)?;
    }
    if let Some(backup) = payload.backup {
        let settings = BackupRuntimeSettings::from_request(&state.config, backup, &request_id)?;
        save_backup_runtime_settings(&state.config.backup_dir, &settings, &request_id)?;
    }
    if let Some(maintenance) = payload.maintenance {
        let message = maintenance
            .message
            .map(|value| value.trim().to_owned())
            .filter(|value| !value.is_empty());
        if message
            .as_ref()
            .is_some_and(|value| value.chars().count() > 500)
        {
            return Err(ApiFailure::validation(
                "Maintenance message must be at most 500 characters.",
                request_id.clone(),
            ));
        }
        save_maintenance_mode(
            &state.config.backup_dir,
            &StoredMaintenanceMode {
                enabled: maintenance.enabled,
                message,
                updated_at: Some(chrono::Utc::now().to_rfc3339()),
            },
            &request_id,
        )?;
    }
    record_audit(
        &state.database,
        Some(&actor.user.id),
        "admin.settings.update",
        Some("settings"),
        Some("server"),
        "success",
        &request_id,
        json!({ "updated": true }),
    )
    .await?;
    Ok(Json(DataResponse::new(load_server_settings(&state.config))))
}

pub async fn admin_update_backup_settings(
    State(state): State<AppState>,
    Extension(request_id): Extension<String>,
    headers: HeaderMap,
    Json(payload): Json<UpdateBackupSettingsRequest>,
) -> Result<Json<DataResponse<AdminBackupOverview>>, ApiFailure> {
    let actor = require_admin_csrf(&state, &headers, &request_id).await?;
    let settings = BackupRuntimeSettings::from_request(&state.config, payload, &request_id)?;
    save_backup_runtime_settings(&state.config.backup_dir, &settings, &request_id)?;
    record_audit(
        &state.database,
        Some(&actor.user.id),
        "admin.backup.settings.update",
        Some("backup"),
        None,
        "success",
        &request_id,
        json!({
            "scheduleEnabled": settings.schedule_enabled,
            "intervalSeconds": settings.interval_seconds,
            "retentionDays": settings.retention_days,
            "exportConfigured": settings.export_dir.is_some()
        }),
    )
    .await?;
    Ok(Json(DataResponse::new(load_backup_overview(&state))))
}

pub async fn admin_verify_backup(
    State(state): State<AppState>,
    Extension(request_id): Extension<String>,
    headers: HeaderMap,
    Path(backup_name): Path<String>,
) -> Result<Json<DataResponse<AdminBackupVerification>>, ApiFailure> {
    require_admin(&state, &headers, &request_id).await?;
    let backup_dir = resolve_backup_dir(&state.config.backup_dir, &backup_name, &request_id)?;
    Ok(Json(DataResponse::new(verify_backup(
        &backup_name,
        &backup_dir,
        &request_id,
    )?)))
}

pub async fn admin_run_backup(
    State(state): State<AppState>,
    Extension(request_id): Extension<String>,
    headers: HeaderMap,
) -> Result<Json<DataResponse<AdminBackupCommandResult>>, ApiFailure> {
    let actor = require_admin_csrf(&state, &headers, &request_id).await?;
    let Some(command) = state.config.backup_command.clone() else {
        return Err(ApiFailure::validation(
            "Backup execution is not configured on this server.",
            request_id,
        ));
    };
    let settings = load_backup_runtime_settings(&state.config);
    let result = run_operator_command(
        &command,
        &state.config.backup_dir,
        None,
        &settings,
        Duration::from_secs(30 * 60),
        &request_id,
    )
    .await;
    let audit_result = if result.is_ok() { "success" } else { "failure" };
    record_audit(
        &state.database,
        Some(&actor.user.id),
        "admin.backup.run",
        Some("backup"),
        None,
        audit_result,
        &request_id,
        json!({"configured": true}),
    )
    .await?;
    Ok(Json(DataResponse::new(result?)))
}

pub async fn admin_restore_backup(
    State(state): State<AppState>,
    Extension(request_id): Extension<String>,
    headers: HeaderMap,
    Path(backup_name): Path<String>,
    Json(payload): Json<RestoreBackupRequest>,
) -> Result<Json<DataResponse<AdminBackupCommandResult>>, ApiFailure> {
    let actor = require_admin_csrf(&state, &headers, &request_id).await?;
    if payload.confirmation != "restore" {
        return Err(ApiFailure::validation(
            "Type restore to confirm this destructive operation.",
            request_id,
        ));
    }
    let Some(command) = state.config.restore_command.clone() else {
        return Err(ApiFailure::validation(
            "Backup restore is not configured on this server.",
            request_id,
        ));
    };
    let backup_dir = resolve_backup_dir(&state.config.backup_dir, &backup_name, &request_id)?;
    let verification = verify_backup(&backup_name, &backup_dir, &request_id)?;
    if !verification.ok {
        return Err(ApiFailure::validation(
            "Backup checksum verification failed; refusing restore.",
            request_id,
        ));
    }
    let result = run_operator_command(
        &command,
        &state.config.backup_dir,
        Some(&backup_name),
        &load_backup_runtime_settings(&state.config),
        Duration::from_secs(60 * 60),
        &request_id,
    )
    .await;
    let audit_result = if result.is_ok() { "success" } else { "failure" };
    record_audit(
        &state.database,
        Some(&actor.user.id),
        "admin.backup.restore",
        Some("backup"),
        Some(&backup_name),
        audit_result,
        &request_id,
        json!({"configured": true}),
    )
    .await?;
    Ok(Json(DataResponse::new(result?)))
}

pub async fn admin_export_backup_archive(
    State(state): State<AppState>,
    Extension(request_id): Extension<String>,
    headers: HeaderMap,
    Path(backup_name): Path<String>,
) -> Result<Response, ApiFailure> {
    require_admin(&state, &headers, &request_id).await?;
    let backup_dir = resolve_backup_dir(&state.config.backup_dir, &backup_name, &request_id)?;
    let verification = verify_backup(&backup_name, &backup_dir, &request_id)?;
    if !verification.ok {
        return Err(ApiFailure::validation(
            "Backup checksum verification failed; refusing export.",
            request_id,
        ));
    }
    validate_backup_manifest_version(&backup_dir, &request_id)?;
    let temp = tempfile::NamedTempFile::new_in(&state.config.backup_dir)
        .map_err(|_| ApiFailure::server(request_id.clone()))?;
    let output = Command::new("tar")
        .arg("-C")
        .arg(&state.config.backup_dir)
        .arg("-czf")
        .arg(temp.path())
        .arg(&backup_name)
        .output()
        .await
        .map_err(|_| ApiFailure::server(request_id.clone()))?;
    if !output.status.success() {
        return Err(ApiFailure::validation(
            format!(
                "Backup export failed: {}{}",
                String::from_utf8_lossy(&output.stdout),
                String::from_utf8_lossy(&output.stderr)
            )
            .trim()
            .to_owned(),
            request_id,
        ));
    }
    let bytes = fs::read(temp.path()).map_err(|_| ApiFailure::server(request_id.clone()))?;
    let mut response = Response::new(Body::from(bytes));
    response.headers_mut().insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("application/gzip"),
    );
    response.headers_mut().insert(
        header::CONTENT_DISPOSITION,
        HeaderValue::from_str(&format!("attachment; filename=\"{backup_name}.tar.gz\""))
            .unwrap_or_else(|_| {
                HeaderValue::from_static("attachment; filename=\"collab-backup.tar.gz\"")
            }),
    );
    Ok(response)
}

pub async fn admin_import_backup_archive(
    State(state): State<AppState>,
    Extension(request_id): Extension<String>,
    headers: HeaderMap,
    Json(payload): Json<ImportBackupArchiveRequest>,
) -> Result<Json<DataResponse<AdminBackupOverview>>, ApiFailure> {
    let actor = require_admin_csrf(&state, &headers, &request_id).await?;
    let archive = STANDARD
        .decode(payload.archive_base64.as_bytes())
        .map_err(|_| {
            ApiFailure::validation("Backup archive is not valid base64.", request_id.clone())
        })?;
    let max_backup_archive_bytes = state.config.max_import_bytes as u64;
    if archive.is_empty() || archive.len() as u64 > max_backup_archive_bytes {
        return Err(ApiFailure::validation(
            format!(
                "Backup archive must be between 1 byte and {}.",
                format_bytes(max_backup_archive_bytes)
            ),
            request_id,
        ));
    }
    fs::create_dir_all(&state.config.backup_dir)
        .map_err(|_| ApiFailure::server(request_id.clone()))?;
    let import_root = tempfile::Builder::new()
        .prefix(".import-")
        .tempdir_in(&state.config.backup_dir)
        .map_err(|_| ApiFailure::server(request_id.clone()))?;
    let archive_path = import_root.path().join("backup.tar.gz");
    fs::write(&archive_path, archive).map_err(|_| ApiFailure::server(request_id.clone()))?;
    let listed = list_backup_archive_entries(&archive_path, &request_id)?;
    let archive_root = validate_backup_archive_entries(&listed, &request_id)?;
    extract_backup_archive(&archive_path, import_root.path(), &request_id)?;
    let extracted_dir = import_root.path().join(&archive_root);
    validate_imported_backup_dir(&archive_root, &extracted_dir, &request_id)?;
    let target_dir = state.config.backup_dir.join(&archive_root);
    if target_dir.exists() {
        return Err(ApiFailure::validation(
            "A backup with that name already exists.",
            request_id,
        ));
    }
    fs::rename(&extracted_dir, &target_dir).map_err(|_| ApiFailure::server(request_id.clone()))?;
    record_audit(
        &state.database,
        Some(&actor.user.id),
        "admin.backup.import",
        Some("backup"),
        Some(&archive_root),
        "success",
        &request_id,
        json!({"bytes": payload.archive_base64.len()}),
    )
    .await?;
    Ok(Json(DataResponse::new(load_backup_overview(&state))))
}

pub async fn admin_delete_backup(
    State(state): State<AppState>,
    Extension(request_id): Extension<String>,
    headers: HeaderMap,
    Path(backup_name): Path<String>,
) -> Result<StatusCode, ApiFailure> {
    let actor = require_admin_csrf(&state, &headers, &request_id).await?;
    let backup_dir = resolve_backup_dir(&state.config.backup_dir, &backup_name, &request_id)?;
    let delete_mode = delete_or_quarantine_backup_dir(
        &state.config.backup_dir,
        &backup_name,
        &backup_dir,
        &request_id,
    )?;
    record_audit(
        &state.database,
        Some(&actor.user.id),
        "admin.backup.delete",
        Some("backup"),
        Some(&backup_name),
        "success",
        &request_id,
        json!({"mode": delete_mode}),
    )
    .await?;
    Ok(StatusCode::NO_CONTENT)
}

pub async fn list_users(
    State(state): State<AppState>,
    Extension(request_id): Extension<String>,
    headers: HeaderMap,
) -> Result<Json<DataResponse<Vec<ServerUser>>>, ApiFailure> {
    require_admin(&state, &headers, &request_id).await?;
    let rows = sqlx::query(
        r#"
        SELECT u.id, u.username, u.display_name, u.role::text AS role, u.status::text AS status,
               u.created_at, u.last_login_at, u.is_primary_admin, u.preferences,
               (u.avatar_bytes IS NOT NULL) AS has_avatar, u.avatar_updated_at,
               ((SELECT COUNT(*) FROM sessions active
                 WHERE active.user_id = u.id AND active.revoked_at IS NULL AND active.expires_at > NOW())
                + (SELECT COUNT(*) FROM native_sessions active
                   WHERE active.user_id = u.id AND active.revoked_at IS NULL AND active.refresh_expires_at > NOW()))
                AS active_sessions
        FROM users u ORDER BY u.created_at ASC
        "#,
    )
    .fetch_all(&state.database)
    .await
    .map_err(|_| ApiFailure::server(request_id.clone()))?;
    Ok(Json(DataResponse::new(
        rows.iter().map(user_from_row).collect(),
    )))
}

pub async fn create_user(
    State(state): State<AppState>,
    Extension(request_id): Extension<String>,
    headers: HeaderMap,
    Json(payload): Json<CreateUserRequest>,
) -> Result<(StatusCode, Json<DataResponse<ServerUser>>), ApiFailure> {
    let actor = require_admin_csrf(&state, &headers, &request_id).await?;
    let mut transaction = state
        .database
        .begin()
        .await
        .map_err(|_| ApiFailure::server(request_id.clone()))?;
    let user = insert_user(&mut transaction, &payload, payload.admin, &request_id).await?;
    audit(
        &mut transaction,
        Some(&actor.user.id),
        "admin.user.create",
        Some("user"),
        Some(&user.id),
        "success",
        &request_id,
        json!({"role": if payload.admin { "admin" } else { "member" }}),
    )
    .await?;
    transaction
        .commit()
        .await
        .map_err(|_| ApiFailure::server(request_id))?;
    Ok((StatusCode::CREATED, Json(DataResponse::new(user))))
}

pub async fn update_user(
    State(state): State<AppState>,
    Extension(request_id): Extension<String>,
    headers: HeaderMap,
    Path(user_id): Path<Uuid>,
    Json(payload): Json<UpdateUserRequest>,
) -> Result<Json<DataResponse<ServerUser>>, ApiFailure> {
    let actor = require_admin_csrf(&state, &headers, &request_id).await?;
    if payload.disabled == Some(true)
        && is_primary_admin(&state.database, user_id, &request_id).await?
    {
        return Err(ApiFailure::validation(
            "The primary administrator account cannot be disabled.",
            request_id,
        ));
    }
    if payload.disabled == Some(true) && actor.user.id == user_id.to_string() {
        return Err(ApiFailure::validation(
            "Administrators cannot disable their own account.",
            request_id,
        ));
    }
    if let Some(role) = payload.role {
        if actor.user.id == user_id.to_string() {
            return Err(ApiFailure::validation(
                "Administrators cannot change their own role.",
                request_id,
            ));
        }
        if role == ServerUserRole::Member
            && is_primary_admin(&state.database, user_id, &request_id).await?
        {
            return Err(ApiFailure::validation(
                "The primary administrator must remain an administrator.",
                request_id,
            ));
        }
        let role_sql = match role {
            ServerUserRole::Admin => "admin",
            ServerUserRole::Member => "member",
        };
        sqlx::query(
            "UPDATE users SET role = $1::server_user_role, updated_at = NOW() WHERE id = $2",
        )
        .bind(role_sql)
        .bind(user_id)
        .execute(&state.database)
        .await
        .map_err(|_| ApiFailure::server(request_id.clone()))?;
    }
    if let Some(password) = payload.password.as_deref() {
        validate_password(password)
            .map_err(|error| ApiFailure::validation(error.to_string(), request_id.clone()))?;
        let password_hash = hash_password(password)
            .map_err(|error| ApiFailure::validation(error.to_string(), request_id.clone()))?;
        sqlx::query(
            "UPDATE credentials SET password_hash = $1, password_changed_at = NOW() WHERE user_id = $2",
        )
        .bind(password_hash)
        .bind(user_id)
        .execute(&state.database)
        .await
        .map_err(|_| ApiFailure::server(request_id.clone()))?;
        sqlx::query("UPDATE sessions SET revoked_at = NOW() WHERE user_id = $1")
            .bind(user_id)
            .execute(&state.database)
            .await
            .map_err(|_| ApiFailure::server(request_id.clone()))?;
        sqlx::query("UPDATE native_sessions SET revoked_at = NOW() WHERE user_id = $1")
            .bind(user_id)
            .execute(&state.database)
            .await
            .map_err(|_| ApiFailure::server(request_id.clone()))?;
    }
    if let Some(username) = payload.username.as_deref() {
        let normalized = normalize_username(username)
            .map_err(|error| ApiFailure::validation(error.to_string(), request_id.clone()))?;
        let taken = sqlx::query_scalar::<_, bool>(
            "SELECT EXISTS(SELECT 1 FROM users WHERE normalized_username = $1 AND id <> $2)",
        )
        .bind(&normalized)
        .bind(user_id)
        .fetch_one(&state.database)
        .await
        .map_err(|_| ApiFailure::server(request_id.clone()))?;
        if taken {
            return Err(ApiFailure::validation(
                "That username is already in use.",
                request_id,
            ));
        }
        sqlx::query("UPDATE users SET username = $1, normalized_username = $2, updated_at = NOW() WHERE id = $3")
            .bind(username.trim())
            .bind(&normalized)
            .bind(user_id)
            .execute(&state.database)
            .await
            .map_err(|_| ApiFailure::server(request_id.clone()))?;
    }
    let disabled = payload.disabled;
    let row = sqlx::query(
        r#"
        UPDATE users SET
          display_name = COALESCE($1, display_name),
          status = CASE
            WHEN $2::boolean IS NULL THEN status
            WHEN $2 THEN 'disabled'::server_user_status
            ELSE 'active'::server_user_status
          END,
          updated_at = NOW()
        WHERE id = $3
        RETURNING id, username, display_name, role::text AS role, status::text AS status,
                  created_at, last_login_at, is_primary_admin, preferences,
                  (avatar_bytes IS NOT NULL) AS has_avatar, avatar_updated_at,
                  0::bigint AS active_sessions
        "#,
    )
    .bind(payload.display_name)
    .bind(disabled)
    .bind(user_id)
    .fetch_optional(&state.database)
    .await
    .map_err(|_| ApiFailure::server(request_id.clone()))?
    .ok_or_else(|| ApiFailure::not_found(request_id.clone()))?;
    if disabled == Some(true) {
        sqlx::query("UPDATE sessions SET revoked_at = NOW() WHERE user_id = $1")
            .bind(user_id)
            .execute(&state.database)
            .await
            .map_err(|_| ApiFailure::server(request_id.clone()))?;
        sqlx::query("UPDATE native_sessions SET revoked_at = NOW() WHERE user_id = $1")
            .bind(user_id)
            .execute(&state.database)
            .await
            .map_err(|_| ApiFailure::server(request_id.clone()))?;
    }
    let user = user_from_row(&row);
    record_audit(
        &state.database,
        Some(&actor.user.id),
        "admin.user.update",
        Some("user"),
        Some(&user.id),
        "success",
        &request_id,
        json!({
            "disabled": disabled,
            "passwordReset": payload.password.is_some(),
            "role": payload.role.map(|role| match role {
                ServerUserRole::Admin => "admin",
                ServerUserRole::Member => "member",
            }),
        }),
    )
    .await?;
    Ok(Json(DataResponse::new(user)))
}

pub async fn delete_user(
    State(state): State<AppState>,
    Extension(request_id): Extension<String>,
    headers: HeaderMap,
    Path(user_id): Path<Uuid>,
) -> Result<StatusCode, ApiFailure> {
    let actor = require_admin_csrf(&state, &headers, &request_id).await?;
    if actor.user.id == user_id.to_string() {
        return Err(ApiFailure::validation(
            "Administrators cannot delete their own account.",
            request_id,
        ));
    }
    if is_primary_admin(&state.database, user_id, &request_id).await? {
        return Err(ApiFailure::validation(
            "The primary administrator account cannot be deleted.",
            request_id,
        ));
    }
    let owns_vault = sqlx::query_scalar::<_, bool>(
        "SELECT EXISTS(SELECT 1 FROM hosted_vaults WHERE owner_user_id = $1)",
    )
    .bind(user_id)
    .fetch_one(&state.database)
    .await
    .map_err(|_| ApiFailure::server(request_id.clone()))?;
    if owns_vault {
        return Err(ApiFailure::validation(
            "Transfer or delete this user's hosted vaults before deleting the account.",
            request_id,
        ));
    }

    let mut transaction = state
        .database
        .begin()
        .await
        .map_err(|_| ApiFailure::server(request_id.clone()))?;
    let exists = sqlx::query_scalar::<_, bool>("SELECT EXISTS(SELECT 1 FROM users WHERE id = $1)")
        .bind(user_id)
        .fetch_one(&mut *transaction)
        .await
        .map_err(|_| ApiFailure::server(request_id.clone()))?;
    if !exists {
        return Err(ApiFailure::not_found(request_id));
    }
    audit(
        &mut transaction,
        Some(&actor.user.id),
        "admin.user.delete",
        Some("user"),
        Some(&user_id.to_string()),
        "success",
        &request_id,
        json!({}),
    )
    .await?;
    sqlx::query("DELETE FROM users WHERE id = $1")
        .bind(user_id)
        .execute(&mut *transaction)
        .await
        .map_err(|_| ApiFailure::server(request_id.clone()))?;
    transaction
        .commit()
        .await
        .map_err(|_| ApiFailure::server(request_id))?;
    Ok(StatusCode::NO_CONTENT)
}

pub async fn revoke_user_sessions(
    State(state): State<AppState>,
    Extension(request_id): Extension<String>,
    headers: HeaderMap,
    Path(user_id): Path<Uuid>,
) -> Result<StatusCode, ApiFailure> {
    let actor = require_admin_csrf(&state, &headers, &request_id).await?;
    sqlx::query("UPDATE sessions SET revoked_at = NOW() WHERE user_id = $1 AND revoked_at IS NULL")
        .bind(user_id)
        .execute(&state.database)
        .await
        .map_err(|_| ApiFailure::server(request_id.clone()))?;
    sqlx::query(
        "UPDATE native_sessions SET revoked_at = NOW() WHERE user_id = $1 AND revoked_at IS NULL",
    )
    .bind(user_id)
    .execute(&state.database)
    .await
    .map_err(|_| ApiFailure::server(request_id.clone()))?;
    record_audit(
        &state.database,
        Some(&actor.user.id),
        "admin.user.sessions.revoke",
        Some("user"),
        Some(&user_id.to_string()),
        "success",
        &request_id,
        json!({}),
    )
    .await?;
    Ok(StatusCode::NO_CONTENT)
}

pub async fn reset_user_password(
    State(state): State<AppState>,
    Extension(request_id): Extension<String>,
    headers: HeaderMap,
    Path(user_id): Path<Uuid>,
    Json(payload): Json<ResetPasswordRequest>,
) -> Result<StatusCode, ApiFailure> {
    let actor = require_admin_csrf(&state, &headers, &request_id).await?;
    replace_password_and_revoke(
        &state.database,
        user_id,
        &payload.new_password,
        None,
        &request_id,
    )
    .await?;
    record_audit(
        &state.database,
        Some(&actor.user.id),
        "admin.user.password.reset",
        Some("user"),
        Some(&user_id.to_string()),
        "success",
        &request_id,
        json!({}),
    )
    .await?;
    Ok(StatusCode::NO_CONTENT)
}

pub async fn create_invitation(
    State(state): State<AppState>,
    Extension(request_id): Extension<String>,
    headers: HeaderMap,
    Json(payload): Json<CreateInvitationRequest>,
) -> Result<(StatusCode, Json<DataResponse<CreatedInvitation>>), ApiFailure> {
    let actor = require_admin_csrf(&state, &headers, &request_id).await?;
    let normalized = normalize_username(&payload.username)
        .map_err(|error| ApiFailure::validation(error.to_string(), request_id.clone()))?;
    if payload.display_name.trim().is_empty()
        || payload.display_name.len() > 128
        || !(1..=24 * 30).contains(&payload.expires_in_hours)
    {
        return Err(ApiFailure::validation(
            "Invitation display name or expiry is invalid.",
            request_id,
        ));
    }
    let exists = sqlx::query_scalar::<_, bool>(
        "SELECT EXISTS(SELECT 1 FROM users WHERE normalized_username = $1)",
    )
    .bind(&normalized)
    .fetch_one(&state.database)
    .await
    .map_err(|_| ApiFailure::server(request_id.clone()))?;
    if exists {
        return Err(ApiFailure::validation(
            "That username already exists.",
            request_id,
        ));
    }
    sqlx::query(
        "UPDATE invitations SET revoked_at = NOW() WHERE normalized_username = $1 AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at <= NOW()",
    )
    .bind(&normalized)
    .execute(&state.database)
    .await
    .map_err(|_| ApiFailure::server(request_id.clone()))?;
    let raw_token = generate_secret();
    let row = sqlx::query(
        r#"
        INSERT INTO invitations (id, token_hash, username, normalized_username, display_name, role, created_by, expires_at)
        VALUES ($1, $2, $3, $4, $5, CASE WHEN $6 THEN 'admin'::server_user_role ELSE 'member'::server_user_role END,
                $7, NOW() + ($8 || ' hours')::interval)
        RETURNING id, username, display_name, role::text AS role, created_at, expires_at, accepted_at, revoked_at
        "#,
    )
    .bind(Uuid::now_v7()).bind(hash_secret(&raw_token)).bind(payload.username.trim()).bind(normalized)
    .bind(payload.display_name.trim()).bind(payload.admin).bind(Uuid::parse_str(&actor.user.id).unwrap())
    .bind(payload.expires_in_hours.to_string())
    .fetch_one(&state.database).await.map_err(|error| {
        if error.as_database_error().and_then(|value| value.code()).as_deref() == Some("23505") {
            ApiFailure::validation("A pending invitation already exists for that username.", request_id.clone())
        } else { ApiFailure::server(request_id.clone()) }
    })?;
    let invitation = invitation_from_row(&row);
    record_audit(
        &state.database,
        Some(&actor.user.id),
        "admin.invitation.create",
        Some("invitation"),
        Some(&invitation.id),
        "success",
        &request_id,
        json!({"role": if payload.admin { "admin" } else { "member" }}),
    )
    .await?;
    Ok((
        StatusCode::CREATED,
        Json(DataResponse::new(CreatedInvitation {
            invitation,
            token: raw_token,
        })),
    ))
}

pub async fn list_invitations(
    State(state): State<AppState>,
    Extension(request_id): Extension<String>,
    headers: HeaderMap,
) -> Result<Json<DataResponse<Vec<Invitation>>>, ApiFailure> {
    require_admin(&state, &headers, &request_id).await?;
    let rows = sqlx::query("SELECT id, username, display_name, role::text AS role, created_at, expires_at, accepted_at, revoked_at FROM invitations ORDER BY created_at DESC")
        .fetch_all(&state.database).await.map_err(|_| ApiFailure::server(request_id.clone()))?;
    Ok(Json(DataResponse::new(
        rows.iter().map(invitation_from_row).collect(),
    )))
}

pub async fn revoke_invitation(
    State(state): State<AppState>,
    Extension(request_id): Extension<String>,
    headers: HeaderMap,
    Path(invitation_id): Path<Uuid>,
) -> Result<StatusCode, ApiFailure> {
    let actor = require_admin_csrf(&state, &headers, &request_id).await?;
    let result = sqlx::query(
        r#"
        UPDATE invitations
        SET revoked_at = NOW()
        WHERE id = $1
          AND accepted_at IS NULL
          AND revoked_at IS NULL
          AND expires_at > NOW()
        "#,
    )
    .bind(invitation_id)
    .execute(&state.database)
    .await
    .map_err(|_| ApiFailure::server(request_id.clone()))?;

    if result.rows_affected() == 0 {
        return Err(ApiFailure::new(
            StatusCode::NOT_FOUND,
            ErrorCode::ResourceNotFound,
            "The invitation is not pending or does not exist.",
            request_id,
        ));
    }

    record_audit(
        &state.database,
        Some(&actor.user.id),
        "admin.invitation.revoke",
        Some("invitation"),
        Some(&invitation_id.to_string()),
        "success",
        &request_id,
        json!({}),
    )
    .await?;

    Ok(StatusCode::NO_CONTENT)
}

pub async fn accept_invitation(
    State(state): State<AppState>,
    Extension(request_id): Extension<String>,
    headers: HeaderMap,
    Path(token): Path<String>,
    Json(payload): Json<AcceptInvitationRequest>,
) -> Result<Response, ApiFailure> {
    validate_password(&payload.password)
        .map_err(|error| ApiFailure::validation(error.to_string(), request_id.clone()))?;
    let mut transaction = state
        .database
        .begin()
        .await
        .map_err(|_| ApiFailure::server(request_id.clone()))?;
    let row = sqlx::query(
        "SELECT id, username, display_name, role::text AS role FROM invitations WHERE token_hash = $1 AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > NOW() FOR UPDATE",
    ).bind(hash_secret(&token)).fetch_optional(&mut *transaction).await
        .map_err(|_| ApiFailure::server(request_id.clone()))?
        .ok_or_else(|| ApiFailure::new(StatusCode::GONE, ErrorCode::ResourceNotFound, "The invitation is invalid or expired.", request_id.clone()))?;
    let create = CreateUserRequest {
        username: row.get("username"),
        display_name: row.get("display_name"),
        password: payload.password,
        admin: row.get::<String, _>("role") == "admin",
    };
    let user = insert_user(&mut transaction, &create, create.admin, &request_id).await?;
    let invitation_id: Uuid = row.get("id");
    sqlx::query("UPDATE invitations SET accepted_at = NOW() WHERE id = $1")
        .bind(invitation_id)
        .execute(&mut *transaction)
        .await
        .map_err(|_| ApiFailure::server(request_id.clone()))?;
    audit(
        &mut transaction,
        Some(&user.id),
        "auth.invitation.accept",
        Some("invitation"),
        Some(&invitation_id.to_string()),
        "success",
        &request_id,
        json!({}),
    )
    .await?;
    transaction
        .commit()
        .await
        .map_err(|_| ApiFailure::server(request_id.clone()))?;
    create_browser_session(&state, &headers, user, &request_id).await
}

pub async fn user_activity(
    State(state): State<AppState>,
    Extension(request_id): Extension<String>,
    headers: HeaderMap,
    Path(user_id): Path<Uuid>,
) -> Result<Json<DataResponse<Vec<AuditEvent>>>, ApiFailure> {
    require_admin(&state, &headers, &request_id).await?;
    Ok(Json(DataResponse::new(
        list_user_audit_events(&state.database, user_id, 100, &request_id).await?,
    )))
}

pub async fn hosted_vaults(
    State(state): State<AppState>,
    Extension(request_id): Extension<String>,
    headers: HeaderMap,
) -> Result<Json<DataResponse<Vec<HostedVaultSummary>>>, ApiFailure> {
    require_admin(&state, &headers, &request_id).await?;
    let rows = sqlx::query(
        r#"
        SELECT v.id, v.name, owner.display_name AS owner_display_name, v.status::text AS status,
               v.updated_at, v.require_offline_copy,
               (SELECT COUNT(*) FROM hosted_vault_memberships members WHERE members.vault_id = v.id) AS members,
               COALESCE((SELECT SUM(r.size_bytes) FROM hosted_file_revisions r WHERE r.vault_id = v.id), 0)::bigint AS storage_bytes
        FROM hosted_vaults v
        JOIN users owner ON owner.id = v.owner_user_id
        ORDER BY v.updated_at DESC
        "#,
    )
    .fetch_all(&state.database)
    .await
    .map_err(|_| ApiFailure::server(request_id.clone()))?;
    Ok(Json(DataResponse::new(
        rows.iter().map(vault_summary_from_row).collect(),
    )))
}

pub async fn audit_events(
    State(state): State<AppState>,
    Extension(request_id): Extension<String>,
    headers: HeaderMap,
) -> Result<Json<DataResponse<Vec<AuditEvent>>>, ApiFailure> {
    require_admin(&state, &headers, &request_id).await?;
    Ok(Json(DataResponse::new(
        list_audit_events(&state.database, 100, &request_id).await?,
    )))
}

// ---------------------------------------------------------------------------
// Fine-grained permissions: user groups, permission templates, vault grants.
// All endpoints are server-admin only and record audit events; grant mutations
// additionally record `byServerAdmin` vault activity for the affected vault.
// ---------------------------------------------------------------------------

pub async fn list_groups(
    State(state): State<AppState>,
    Extension(request_id): Extension<String>,
    headers: HeaderMap,
) -> Result<Json<DataResponse<Vec<UserGroup>>>, ApiFailure> {
    require_admin(&state, &headers, &request_id).await?;
    Ok(Json(DataResponse::new(
        load_groups(&state.database, &request_id).await?,
    )))
}

pub async fn create_group(
    State(state): State<AppState>,
    Extension(request_id): Extension<String>,
    headers: HeaderMap,
    Json(payload): Json<CreateGroupRequest>,
) -> Result<(StatusCode, Json<DataResponse<UserGroup>>), ApiFailure> {
    let actor = require_admin_csrf(&state, &headers, &request_id).await?;
    let name = validate_entity_name(&payload.name, "Group name", &request_id)?;
    let description = normalize_optional_text(payload.description);
    let id = Uuid::now_v7();
    let mut transaction = state
        .database
        .begin()
        .await
        .map_err(|_| ApiFailure::server(request_id.clone()))?;
    sqlx::query(
        "INSERT INTO user_groups (id, name, description, created_by) VALUES ($1, $2, $3, $4)",
    )
    .bind(id)
    .bind(&name)
    .bind(description.as_deref())
    .bind(user_uuid(&actor.user))
    .execute(&mut *transaction)
    .await
    .map_err(|error| {
        unique_violation_or_server(error, "A group with that name already exists.", &request_id)
    })?;
    audit(
        &mut transaction,
        Some(&actor.user.id),
        "admin.group.create",
        Some("group"),
        Some(&id.to_string()),
        "success",
        &request_id,
        json!({"name": name}),
    )
    .await?;
    transaction
        .commit()
        .await
        .map_err(|_| ApiFailure::server(request_id.clone()))?;
    Ok((
        StatusCode::CREATED,
        Json(DataResponse::new(
            load_group(&state.database, id, &request_id).await?,
        )),
    ))
}

pub async fn update_group(
    State(state): State<AppState>,
    Extension(request_id): Extension<String>,
    headers: HeaderMap,
    Path(group_id): Path<Uuid>,
    Json(payload): Json<UpdateGroupRequest>,
) -> Result<Json<DataResponse<UserGroup>>, ApiFailure> {
    let actor = require_admin_csrf(&state, &headers, &request_id).await?;
    let name = payload
        .name
        .as_deref()
        .map(|value| validate_entity_name(value, "Group name", &request_id))
        .transpose()?;
    let description = payload
        .description
        .map(|value| normalize_optional_text(Some(value)));
    let mut transaction = state
        .database
        .begin()
        .await
        .map_err(|_| ApiFailure::server(request_id.clone()))?;
    let updated = sqlx::query(
        r#"
        UPDATE user_groups SET
          name = COALESCE($1, name),
          description = CASE WHEN $2 THEN $3 ELSE description END
        WHERE id = $4
        "#,
    )
    .bind(name.as_deref())
    .bind(description.is_some())
    .bind(description.flatten().as_deref())
    .bind(group_id)
    .execute(&mut *transaction)
    .await
    .map_err(|error| {
        unique_violation_or_server(error, "A group with that name already exists.", &request_id)
    })?;
    if updated.rows_affected() == 0 {
        return Err(ApiFailure::not_found(request_id));
    }
    audit(
        &mut transaction,
        Some(&actor.user.id),
        "admin.group.update",
        Some("group"),
        Some(&group_id.to_string()),
        "success",
        &request_id,
        json!({}),
    )
    .await?;
    transaction
        .commit()
        .await
        .map_err(|_| ApiFailure::server(request_id.clone()))?;
    Ok(Json(DataResponse::new(
        load_group(&state.database, group_id, &request_id).await?,
    )))
}

pub async fn delete_group(
    State(state): State<AppState>,
    Extension(request_id): Extension<String>,
    headers: HeaderMap,
    Path(group_id): Path<Uuid>,
) -> Result<StatusCode, ApiFailure> {
    let actor = require_admin_csrf(&state, &headers, &request_id).await?;
    let mut transaction = state
        .database
        .begin()
        .await
        .map_err(|_| ApiFailure::server(request_id.clone()))?;
    // Group memberships and vault grants cascade via foreign keys.
    let deleted = sqlx::query("DELETE FROM user_groups WHERE id = $1")
        .bind(group_id)
        .execute(&mut *transaction)
        .await
        .map_err(|_| ApiFailure::server(request_id.clone()))?;
    if deleted.rows_affected() == 0 {
        return Err(ApiFailure::not_found(request_id));
    }
    audit(
        &mut transaction,
        Some(&actor.user.id),
        "admin.group.delete",
        Some("group"),
        Some(&group_id.to_string()),
        "success",
        &request_id,
        json!({}),
    )
    .await?;
    transaction
        .commit()
        .await
        .map_err(|_| ApiFailure::server(request_id.clone()))?;
    Ok(StatusCode::NO_CONTENT)
}

pub async fn list_group_members(
    State(state): State<AppState>,
    Extension(request_id): Extension<String>,
    headers: HeaderMap,
    Path(group_id): Path<Uuid>,
) -> Result<Json<DataResponse<Vec<UserGroupMember>>>, ApiFailure> {
    require_admin(&state, &headers, &request_id).await?;
    require_group_exists(&state.database, group_id, &request_id).await?;
    Ok(Json(DataResponse::new(
        load_group_members(&state.database, group_id, &request_id).await?,
    )))
}

pub async fn add_group_member(
    State(state): State<AppState>,
    Extension(request_id): Extension<String>,
    headers: HeaderMap,
    Path((group_id, user_id)): Path<(Uuid, Uuid)>,
) -> Result<StatusCode, ApiFailure> {
    let actor = require_admin_csrf(&state, &headers, &request_id).await?;
    require_group_exists(&state.database, group_id, &request_id).await?;
    let mut transaction = state
        .database
        .begin()
        .await
        .map_err(|_| ApiFailure::server(request_id.clone()))?;
    let inserted = sqlx::query(
        "INSERT INTO user_group_memberships (group_id, user_id) SELECT $1, id FROM users WHERE id = $2 AND status = 'active' ON CONFLICT DO NOTHING",
    )
    .bind(group_id)
    .bind(user_id)
    .execute(&mut *transaction)
    .await
    .map_err(|_| ApiFailure::server(request_id.clone()))?;
    if inserted.rows_affected() == 0 {
        return Err(ApiFailure::validation(
            "The user does not exist, is disabled, or is already a member of the group.",
            request_id,
        ));
    }
    audit(
        &mut transaction,
        Some(&actor.user.id),
        "admin.group.member.add",
        Some("group"),
        Some(&group_id.to_string()),
        "success",
        &request_id,
        json!({"userId": user_id}),
    )
    .await?;
    transaction
        .commit()
        .await
        .map_err(|_| ApiFailure::server(request_id.clone()))?;
    Ok(StatusCode::CREATED)
}

pub async fn remove_group_member(
    State(state): State<AppState>,
    Extension(request_id): Extension<String>,
    headers: HeaderMap,
    Path((group_id, user_id)): Path<(Uuid, Uuid)>,
) -> Result<StatusCode, ApiFailure> {
    let actor = require_admin_csrf(&state, &headers, &request_id).await?;
    let mut transaction = state
        .database
        .begin()
        .await
        .map_err(|_| ApiFailure::server(request_id.clone()))?;
    let deleted =
        sqlx::query("DELETE FROM user_group_memberships WHERE group_id = $1 AND user_id = $2")
            .bind(group_id)
            .bind(user_id)
            .execute(&mut *transaction)
            .await
            .map_err(|_| ApiFailure::server(request_id.clone()))?;
    if deleted.rows_affected() == 0 {
        return Err(ApiFailure::not_found(request_id));
    }
    audit(
        &mut transaction,
        Some(&actor.user.id),
        "admin.group.member.remove",
        Some("group"),
        Some(&group_id.to_string()),
        "success",
        &request_id,
        json!({"userId": user_id}),
    )
    .await?;
    transaction
        .commit()
        .await
        .map_err(|_| ApiFailure::server(request_id.clone()))?;
    Ok(StatusCode::NO_CONTENT)
}

pub async fn list_templates(
    State(state): State<AppState>,
    Extension(request_id): Extension<String>,
    headers: HeaderMap,
) -> Result<Json<DataResponse<Vec<PermissionTemplate>>>, ApiFailure> {
    require_admin(&state, &headers, &request_id).await?;
    Ok(Json(DataResponse::new(
        load_templates(&state.database, &request_id).await?,
    )))
}

pub async fn create_template(
    State(state): State<AppState>,
    Extension(request_id): Extension<String>,
    headers: HeaderMap,
    Json(payload): Json<CreateTemplateRequest>,
) -> Result<(StatusCode, Json<DataResponse<PermissionTemplate>>), ApiFailure> {
    let actor = require_admin_csrf(&state, &headers, &request_id).await?;
    let name = validate_entity_name(&payload.name, "Template name", &request_id)?;
    let description = normalize_optional_text(payload.description);
    let capabilities = validate_capability_tokens(&payload.capabilities, &request_id)?;
    let id = Uuid::now_v7();
    let mut transaction = state
        .database
        .begin()
        .await
        .map_err(|_| ApiFailure::server(request_id.clone()))?;
    sqlx::query(
        "INSERT INTO permission_templates (id, name, description, is_builtin, capabilities, created_by) VALUES ($1, $2, $3, FALSE, $4, $5)",
    )
    .bind(id)
    .bind(&name)
    .bind(description.as_deref())
    .bind(&capabilities)
    .bind(user_uuid(&actor.user))
    .execute(&mut *transaction)
    .await
    .map_err(|error| unique_violation_or_server(error, "A template with that name already exists.", &request_id))?;
    audit(
        &mut transaction,
        Some(&actor.user.id),
        "admin.template.create",
        Some("template"),
        Some(&id.to_string()),
        "success",
        &request_id,
        json!({"name": name, "capabilities": capabilities}),
    )
    .await?;
    transaction
        .commit()
        .await
        .map_err(|_| ApiFailure::server(request_id.clone()))?;
    Ok((
        StatusCode::CREATED,
        Json(DataResponse::new(
            load_template(&state.database, id, &request_id).await?,
        )),
    ))
}

pub async fn update_template(
    State(state): State<AppState>,
    Extension(request_id): Extension<String>,
    headers: HeaderMap,
    Path(template_id): Path<Uuid>,
    Json(payload): Json<UpdateTemplateRequest>,
) -> Result<Json<DataResponse<PermissionTemplate>>, ApiFailure> {
    let actor = require_admin_csrf(&state, &headers, &request_id).await?;
    require_template_editable(&state.database, template_id, &request_id).await?;
    let name = payload
        .name
        .as_deref()
        .map(|value| validate_entity_name(value, "Template name", &request_id))
        .transpose()?;
    let description = payload
        .description
        .map(|value| normalize_optional_text(Some(value)));
    let capabilities = payload
        .capabilities
        .as_deref()
        .map(|tokens| validate_capability_tokens(tokens, &request_id))
        .transpose()?;
    let mut transaction = state
        .database
        .begin()
        .await
        .map_err(|_| ApiFailure::server(request_id.clone()))?;
    sqlx::query(
        r#"
        UPDATE permission_templates SET
          name = COALESCE($1, name),
          description = CASE WHEN $2 THEN $3 ELSE description END,
          capabilities = COALESCE($4, capabilities),
          updated_at = NOW()
        WHERE id = $5
        "#,
    )
    .bind(name.as_deref())
    .bind(description.is_some())
    .bind(description.flatten().as_deref())
    .bind(capabilities.as_deref())
    .bind(template_id)
    .execute(&mut *transaction)
    .await
    .map_err(|error| {
        unique_violation_or_server(
            error,
            "A template with that name already exists.",
            &request_id,
        )
    })?;
    audit(
        &mut transaction,
        Some(&actor.user.id),
        "admin.template.update",
        Some("template"),
        Some(&template_id.to_string()),
        "success",
        &request_id,
        json!({}),
    )
    .await?;
    transaction
        .commit()
        .await
        .map_err(|_| ApiFailure::server(request_id.clone()))?;
    Ok(Json(DataResponse::new(
        load_template(&state.database, template_id, &request_id).await?,
    )))
}

pub async fn delete_template(
    State(state): State<AppState>,
    Extension(request_id): Extension<String>,
    headers: HeaderMap,
    Path(template_id): Path<Uuid>,
) -> Result<StatusCode, ApiFailure> {
    let actor = require_admin_csrf(&state, &headers, &request_id).await?;
    require_template_editable(&state.database, template_id, &request_id).await?;
    let mut transaction = state
        .database
        .begin()
        .await
        .map_err(|_| ApiFailure::server(request_id.clone()))?;
    // Grants referencing this template have template_id set to NULL (ON DELETE
    // SET NULL); such grants then resolve from their explicit capabilities, if any.
    sqlx::query("DELETE FROM permission_templates WHERE id = $1")
        .bind(template_id)
        .execute(&mut *transaction)
        .await
        .map_err(|_| ApiFailure::server(request_id.clone()))?;
    audit(
        &mut transaction,
        Some(&actor.user.id),
        "admin.template.delete",
        Some("template"),
        Some(&template_id.to_string()),
        "success",
        &request_id,
        json!({}),
    )
    .await?;
    transaction
        .commit()
        .await
        .map_err(|_| ApiFailure::server(request_id.clone()))?;
    Ok(StatusCode::NO_CONTENT)
}

pub async fn list_vault_grants(
    State(state): State<AppState>,
    Extension(request_id): Extension<String>,
    headers: HeaderMap,
    Path(vault_id): Path<Uuid>,
) -> Result<Json<DataResponse<Vec<VaultGrant>>>, ApiFailure> {
    require_admin(&state, &headers, &request_id).await?;
    require_vault_exists(&state.database, vault_id, &request_id).await?;
    Ok(Json(DataResponse::new(
        load_vault_grants(&state.database, vault_id, &request_id).await?,
    )))
}

pub async fn put_vault_grant(
    State(state): State<AppState>,
    Extension(request_id): Extension<String>,
    headers: HeaderMap,
    Path((vault_id, subject_type, subject_id)): Path<(Uuid, String, Uuid)>,
    Json(payload): Json<PutVaultGrantRequest>,
) -> Result<Json<DataResponse<VaultGrant>>, ApiFailure> {
    let actor = require_admin_csrf(&state, &headers, &request_id).await?;
    let subject = parse_grant_subject_type(&subject_type, &request_id)?;
    require_vault_not_pending_delete(&state.database, vault_id, &request_id).await?;
    let capabilities = payload
        .capabilities
        .as_deref()
        .map(|tokens| validate_capability_tokens(tokens, &request_id))
        .transpose()?;
    if let Some(template_id) = payload.template_id {
        require_template_exists(&state.database, template_id, &request_id).await?;
    }
    let mut transaction = state
        .database
        .begin()
        .await
        .map_err(|_| ApiFailure::server(request_id.clone()))?;
    match subject {
        GrantSubjectType::Group => {
            // The group must exist; the grant row is upserted.
            let upserted = sqlx::query(
                r#"
                INSERT INTO hosted_vault_group_grants (vault_id, group_id, template_id, capabilities)
                SELECT $1, id, $3, $4 FROM user_groups WHERE id = $2
                ON CONFLICT (vault_id, group_id)
                DO UPDATE SET template_id = EXCLUDED.template_id, capabilities = EXCLUDED.capabilities
                "#,
            )
            .bind(vault_id)
            .bind(subject_id)
            .bind(payload.template_id)
            .bind(capabilities.as_deref())
            .execute(&mut *transaction)
            .await
            .map_err(|_| ApiFailure::server(request_id.clone()))?;
            if upserted.rows_affected() == 0 {
                return Err(ApiFailure::validation(
                    "The group does not exist.",
                    request_id,
                ));
            }
        }
        GrantSubjectType::User => {
            // User grants set the capability override on an existing membership;
            // membership lifecycle stays in the vault member endpoints, and the
            // owner membership is never altered.
            let target =
                load_vault_member(&state.database, vault_id, subject_id, &request_id).await?;
            if target.owner {
                return Err(ApiFailure::validation(
                    "The owner already holds every capability and cannot be granted a template.",
                    request_id,
                ));
            }
            sqlx::query(
                "UPDATE hosted_vault_memberships SET template_id = $1, capabilities = $2, updated_at = NOW() WHERE vault_id = $3 AND user_id = $4",
            )
            .bind(payload.template_id)
            .bind(capabilities.as_deref())
            .bind(vault_id)
            .bind(subject_id)
            .execute(&mut *transaction)
            .await
            .map_err(|_| ApiFailure::server(request_id.clone()))?;
        }
    }
    vault_activity_event(
        &mut transaction,
        vault_id,
        Some(user_uuid(&actor.user)),
        "grant.set",
        Some(grant_subject_target_type(subject)),
        Some(&subject_id.to_string()),
        json!({
            "subjectType": subject_type,
            "templateId": payload.template_id,
            "capabilities": capabilities,
            "byServerAdmin": true
        }),
        &request_id,
    )
    .await?;
    audit(
        &mut transaction,
        Some(&actor.user.id),
        "admin.vault.grant.set",
        Some("vault"),
        Some(&vault_id.to_string()),
        "success",
        &request_id,
        json!({"subjectType": subject_type, "subjectId": subject_id, "templateId": payload.template_id}),
    )
    .await?;
    transaction
        .commit()
        .await
        .map_err(|_| ApiFailure::server(request_id.clone()))?;
    Ok(Json(DataResponse::new(
        load_vault_grant(&state.database, vault_id, subject, subject_id, &request_id).await?,
    )))
}

pub async fn delete_vault_grant(
    State(state): State<AppState>,
    Extension(request_id): Extension<String>,
    headers: HeaderMap,
    Path((vault_id, subject_type, subject_id)): Path<(Uuid, String, Uuid)>,
) -> Result<StatusCode, ApiFailure> {
    let actor = require_admin_csrf(&state, &headers, &request_id).await?;
    let subject = parse_grant_subject_type(&subject_type, &request_id)?;
    require_vault_not_pending_delete(&state.database, vault_id, &request_id).await?;
    let mut transaction = state
        .database
        .begin()
        .await
        .map_err(|_| ApiFailure::server(request_id.clone()))?;
    match subject {
        GrantSubjectType::Group => {
            let deleted = sqlx::query(
                "DELETE FROM hosted_vault_group_grants WHERE vault_id = $1 AND group_id = $2",
            )
            .bind(vault_id)
            .bind(subject_id)
            .execute(&mut *transaction)
            .await
            .map_err(|_| ApiFailure::server(request_id.clone()))?;
            if deleted.rows_affected() == 0 {
                return Err(ApiFailure::not_found(request_id));
            }
        }
        GrantSubjectType::User => {
            // Clearing a user grant reverts the membership to its role default
            // rather than removing the membership.
            let cleared = sqlx::query(
                "UPDATE hosted_vault_memberships SET template_id = NULL, capabilities = NULL, updated_at = NOW() WHERE vault_id = $1 AND user_id = $2",
            )
            .bind(vault_id)
            .bind(subject_id)
            .execute(&mut *transaction)
            .await
            .map_err(|_| ApiFailure::server(request_id.clone()))?;
            if cleared.rows_affected() == 0 {
                return Err(ApiFailure::not_found(request_id));
            }
        }
    }
    vault_activity_event(
        &mut transaction,
        vault_id,
        Some(user_uuid(&actor.user)),
        "grant.removed",
        Some(grant_subject_target_type(subject)),
        Some(&subject_id.to_string()),
        json!({"subjectType": subject_type, "byServerAdmin": true}),
        &request_id,
    )
    .await?;
    audit(
        &mut transaction,
        Some(&actor.user.id),
        "admin.vault.grant.remove",
        Some("vault"),
        Some(&vault_id.to_string()),
        "success",
        &request_id,
        json!({"subjectType": subject_type, "subjectId": subject_id}),
    )
    .await?;
    transaction
        .commit()
        .await
        .map_err(|_| ApiFailure::server(request_id.clone()))?;
    Ok(StatusCode::NO_CONTENT)
}

pub async fn admin_vault_detail(
    State(state): State<AppState>,
    Extension(request_id): Extension<String>,
    headers: HeaderMap,
    Path(vault_id): Path<Uuid>,
) -> Result<Json<DataResponse<HostedVaultAdminDetail>>, ApiFailure> {
    require_admin(&state, &headers, &request_id).await?;
    Ok(Json(DataResponse::new(
        load_admin_vault_detail(&state.database, vault_id, &request_id).await?,
    )))
}

pub async fn admin_update_vault(
    State(state): State<AppState>,
    Extension(request_id): Extension<String>,
    headers: HeaderMap,
    Path(vault_id): Path<Uuid>,
    Json(payload): Json<UpdateVaultRequest>,
) -> Result<Json<DataResponse<HostedVaultAdminDetail>>, ApiFailure> {
    let actor = require_admin_csrf(&state, &headers, &request_id).await?;
    let name = payload
        .name
        .as_deref()
        .map(|value| validate_vault_name(value, &request_id))
        .transpose()?;
    if payload.status == Some(HostedVaultStatus::PendingDelete) {
        return Err(ApiFailure::validation(
            "Use DELETE to mark a vault for deletion.",
            request_id,
        ));
    }
    let status = payload.status.map(vault_status_name);
    let mut transaction = state
        .database
        .begin()
        .await
        .map_err(|_| ApiFailure::server(request_id.clone()))?;
    let updated = sqlx::query(
        r#"
        UPDATE hosted_vaults SET
          name = COALESCE($1, name),
          status = COALESCE($2::hosted_vault_status, status),
          require_offline_copy = COALESCE($3, require_offline_copy),
          archived_at = CASE
            WHEN $2 = 'archived' THEN NOW()
            WHEN $2 = 'active' THEN NULL
            ELSE archived_at
          END,
          pending_delete_at = CASE WHEN $2 IS NOT NULL THEN NULL ELSE pending_delete_at END,
          updated_at = NOW()
        WHERE id = $4
        "#,
    )
    .bind(name.as_deref())
    .bind(status)
    .bind(payload.require_offline_copy)
    .bind(vault_id)
    .execute(&mut *transaction)
    .await
    .map_err(|_| ApiFailure::server(request_id.clone()))?;
    if updated.rows_affected() == 0 {
        return Err(ApiFailure::not_found(request_id));
    }
    vault_activity_event(
        &mut transaction,
        vault_id,
        Some(user_uuid(&actor.user)),
        if payload.status.is_some() {
            "vault.status_changed"
        } else if payload.require_offline_copy.is_some() {
            "vault.settings_changed"
        } else {
            "vault.renamed"
        },
        Some("vault"),
        Some(&vault_id.to_string()),
        json!({"status": status, "name": name, "requireOfflineCopy": payload.require_offline_copy, "byServerAdmin": true}),
        &request_id,
    )
    .await?;
    audit(
        &mut transaction,
        Some(&actor.user.id),
        "admin.vault.update",
        Some("vault"),
        Some(&vault_id.to_string()),
        "success",
        &request_id,
        json!({"status": status, "renamed": name.is_some(), "requireOfflineCopy": payload.require_offline_copy}),
    )
    .await?;
    transaction
        .commit()
        .await
        .map_err(|_| ApiFailure::server(request_id.clone()))?;
    Ok(Json(DataResponse::new(
        load_admin_vault_detail(&state.database, vault_id, &request_id).await?,
    )))
}

pub async fn admin_delete_vault(
    State(state): State<AppState>,
    Extension(request_id): Extension<String>,
    headers: HeaderMap,
    Path(vault_id): Path<Uuid>,
) -> Result<StatusCode, ApiFailure> {
    let actor = require_admin_csrf(&state, &headers, &request_id).await?;
    let mut transaction = state
        .database
        .begin()
        .await
        .map_err(|_| ApiFailure::server(request_id.clone()))?;
    let updated = sqlx::query(
        "UPDATE hosted_vaults SET status = 'pending_delete', pending_delete_at = NOW(), updated_at = NOW() WHERE id = $1",
    )
    .bind(vault_id)
    .execute(&mut *transaction)
    .await
    .map_err(|_| ApiFailure::server(request_id.clone()))?;
    if updated.rows_affected() == 0 {
        return Err(ApiFailure::not_found(request_id));
    }
    vault_activity_event(
        &mut transaction,
        vault_id,
        Some(user_uuid(&actor.user)),
        "vault.pending_delete",
        Some("vault"),
        Some(&vault_id.to_string()),
        json!({"byServerAdmin": true}),
        &request_id,
    )
    .await?;
    audit(
        &mut transaction,
        Some(&actor.user.id),
        "admin.vault.delete",
        Some("vault"),
        Some(&vault_id.to_string()),
        "success",
        &request_id,
        json!({}),
    )
    .await?;
    transaction
        .commit()
        .await
        .map_err(|_| ApiFailure::server(request_id))?;
    Ok(StatusCode::NO_CONTENT)
}

/// Permanently and irrecoverably removes a hosted vault. Only a vault already
/// marked for deletion (`pending_delete`) can be force-deleted, so a single
/// destructive click can never skip the soft-delete step. Cascading foreign
/// keys remove the vault's memberships, file entries, revisions, grants,
/// note index, PDF annotations, and CRDT documents in the same statement.
/// Deduplicated blobs are intentionally left untouched for later garbage
/// collection because they may be shared across vaults.
pub async fn admin_force_delete_vault(
    State(state): State<AppState>,
    Extension(request_id): Extension<String>,
    headers: HeaderMap,
    Path(vault_id): Path<Uuid>,
) -> Result<StatusCode, ApiFailure> {
    let actor = require_admin_csrf(&state, &headers, &request_id).await?;
    if require_vault_exists(&state.database, vault_id, &request_id).await?
        != HostedVaultStatus::PendingDelete
    {
        return Err(ApiFailure::validation(
            "A vault must be marked for deletion before it can be force-deleted.",
            request_id,
        ));
    }
    let mut transaction = state
        .database
        .begin()
        .await
        .map_err(|_| ApiFailure::server(request_id.clone()))?;
    let deleted = sqlx::query("DELETE FROM hosted_vaults WHERE id = $1")
        .bind(vault_id)
        .execute(&mut *transaction)
        .await
        .map_err(|_| ApiFailure::server(request_id.clone()))?;
    if deleted.rows_affected() == 0 {
        return Err(ApiFailure::not_found(request_id));
    }
    audit(
        &mut transaction,
        Some(&actor.user.id),
        "admin.vault.force_delete",
        Some("vault"),
        Some(&vault_id.to_string()),
        "success",
        &request_id,
        json!({}),
    )
    .await?;
    transaction
        .commit()
        .await
        .map_err(|_| ApiFailure::server(request_id))?;
    Ok(StatusCode::NO_CONTENT)
}

pub async fn admin_vault_members(
    State(state): State<AppState>,
    Extension(request_id): Extension<String>,
    headers: HeaderMap,
    Path(vault_id): Path<Uuid>,
) -> Result<Json<DataResponse<Vec<HostedVaultMember>>>, ApiFailure> {
    require_admin(&state, &headers, &request_id).await?;
    require_vault_exists(&state.database, vault_id, &request_id).await?;
    Ok(Json(DataResponse::new(
        load_vault_members(&state.database, vault_id, &request_id).await?,
    )))
}

pub async fn admin_add_vault_member(
    State(state): State<AppState>,
    Extension(request_id): Extension<String>,
    headers: HeaderMap,
    Path(vault_id): Path<Uuid>,
    Json(payload): Json<AddVaultMemberRequest>,
) -> Result<(StatusCode, Json<DataResponse<HostedVaultMember>>), ApiFailure> {
    let actor = require_admin_csrf(&state, &headers, &request_id).await?;
    require_vault_not_pending_delete(&state.database, vault_id, &request_id).await?;
    let mut transaction = state
        .database
        .begin()
        .await
        .map_err(|_| ApiFailure::server(request_id.clone()))?;
    let inserted = sqlx::query(
        "INSERT INTO hosted_vault_memberships (vault_id, user_id, role) SELECT $1, id, $3::hosted_vault_role FROM users WHERE id = $2 AND status = 'active' ON CONFLICT DO NOTHING",
    )
    .bind(vault_id)
    .bind(payload.user_id)
    .bind(vault_role_name(payload.role))
    .execute(&mut *transaction)
    .await
    .map_err(|_| ApiFailure::server(request_id.clone()))?;
    if inserted.rows_affected() == 0 {
        return Err(ApiFailure::validation(
            "The user does not exist, is disabled, or is already a member.",
            request_id,
        ));
    }
    vault_activity_event(
        &mut transaction,
        vault_id,
        Some(user_uuid(&actor.user)),
        "member.added",
        Some("user"),
        Some(&payload.user_id.to_string()),
        json!({"role": vault_role_name(payload.role), "byServerAdmin": true}),
        &request_id,
    )
    .await?;
    audit(
        &mut transaction,
        Some(&actor.user.id),
        "admin.vault.member.add",
        Some("vault"),
        Some(&vault_id.to_string()),
        "success",
        &request_id,
        json!({"userId": payload.user_id, "role": vault_role_name(payload.role)}),
    )
    .await?;
    transaction
        .commit()
        .await
        .map_err(|_| ApiFailure::server(request_id.clone()))?;
    Ok((
        StatusCode::CREATED,
        Json(DataResponse::new(
            load_vault_member(&state.database, vault_id, payload.user_id, &request_id).await?,
        )),
    ))
}

pub async fn admin_update_vault_member(
    State(state): State<AppState>,
    Extension(request_id): Extension<String>,
    headers: HeaderMap,
    Path((vault_id, user_id)): Path<(Uuid, Uuid)>,
    Json(payload): Json<UpdateVaultMemberRequest>,
) -> Result<Json<DataResponse<HostedVaultMember>>, ApiFailure> {
    let actor = require_admin_csrf(&state, &headers, &request_id).await?;
    // The server-admin member endpoint only changes the legacy role; fine-grained
    // capability/template assignment goes through the admin grant endpoints.
    let role = payload
        .role
        .ok_or_else(|| ApiFailure::validation("A member role is required.", request_id.clone()))?;
    require_vault_not_pending_delete(&state.database, vault_id, &request_id).await?;
    let target = load_vault_member(&state.database, vault_id, user_id, &request_id).await?;
    if target.owner {
        return Err(ApiFailure::validation(
            "The owner membership cannot be changed.",
            request_id,
        ));
    }
    let mut transaction = state
        .database
        .begin()
        .await
        .map_err(|_| ApiFailure::server(request_id.clone()))?;
    sqlx::query("UPDATE hosted_vault_memberships SET role = $1::hosted_vault_role, updated_at = NOW() WHERE vault_id = $2 AND user_id = $3")
        .bind(vault_role_name(role))
        .bind(vault_id)
        .bind(user_id)
        .execute(&mut *transaction)
        .await
        .map_err(|_| ApiFailure::server(request_id.clone()))?;
    vault_activity_event(
        &mut transaction,
        vault_id,
        Some(user_uuid(&actor.user)),
        "member.role_changed",
        Some("user"),
        Some(&user_id.to_string()),
        json!({"role": vault_role_name(role), "byServerAdmin": true}),
        &request_id,
    )
    .await?;
    audit(
        &mut transaction,
        Some(&actor.user.id),
        "admin.vault.member.update",
        Some("vault"),
        Some(&vault_id.to_string()),
        "success",
        &request_id,
        json!({"userId": user_id, "role": vault_role_name(role)}),
    )
    .await?;
    transaction
        .commit()
        .await
        .map_err(|_| ApiFailure::server(request_id.clone()))?;
    Ok(Json(DataResponse::new(
        load_vault_member(&state.database, vault_id, user_id, &request_id).await?,
    )))
}

pub async fn admin_remove_vault_member(
    State(state): State<AppState>,
    Extension(request_id): Extension<String>,
    headers: HeaderMap,
    Path((vault_id, user_id)): Path<(Uuid, Uuid)>,
) -> Result<StatusCode, ApiFailure> {
    let actor = require_admin_csrf(&state, &headers, &request_id).await?;
    require_vault_not_pending_delete(&state.database, vault_id, &request_id).await?;
    let target = load_vault_member(&state.database, vault_id, user_id, &request_id).await?;
    if target.owner {
        return Err(ApiFailure::validation(
            "The owner membership cannot be removed.",
            request_id,
        ));
    }
    let mut transaction = state
        .database
        .begin()
        .await
        .map_err(|_| ApiFailure::server(request_id.clone()))?;
    sqlx::query("DELETE FROM hosted_vault_memberships WHERE vault_id = $1 AND user_id = $2")
        .bind(vault_id)
        .bind(user_id)
        .execute(&mut *transaction)
        .await
        .map_err(|_| ApiFailure::server(request_id.clone()))?;
    vault_activity_event(
        &mut transaction,
        vault_id,
        Some(user_uuid(&actor.user)),
        "member.removed",
        Some("user"),
        Some(&user_id.to_string()),
        json!({"byServerAdmin": true}),
        &request_id,
    )
    .await?;
    audit(
        &mut transaction,
        Some(&actor.user.id),
        "admin.vault.member.remove",
        Some("vault"),
        Some(&vault_id.to_string()),
        "success",
        &request_id,
        json!({"userId": user_id}),
    )
    .await?;
    transaction
        .commit()
        .await
        .map_err(|_| ApiFailure::server(request_id))?;
    Ok(StatusCode::NO_CONTENT)
}

pub async fn admin_vault_activity(
    State(state): State<AppState>,
    Extension(request_id): Extension<String>,
    headers: HeaderMap,
    Path(vault_id): Path<Uuid>,
) -> Result<Json<DataResponse<Vec<HostedVaultActivityEvent>>>, ApiFailure> {
    require_admin(&state, &headers, &request_id).await?;
    require_vault_exists(&state.database, vault_id, &request_id).await?;
    let rows = sqlx::query(
        "SELECT a.id, u.display_name AS actor_display_name, a.event_type, a.target_type, a.target_id, a.created_at FROM hosted_vault_activity_events a LEFT JOIN users u ON u.id = a.actor_user_id WHERE a.vault_id = $1 ORDER BY a.created_at DESC LIMIT 100",
    )
    .bind(vault_id)
    .fetch_all(&state.database)
    .await
    .map_err(|_| ApiFailure::server(request_id.clone()))?;
    Ok(Json(DataResponse::new(
        rows.iter().map(vault_activity_from_row).collect(),
    )))
}

async fn require_vault_exists(
    pool: &PgPool,
    vault_id: Uuid,
    request_id: &str,
) -> Result<HostedVaultStatus, ApiFailure> {
    let status =
        sqlx::query_scalar::<_, String>("SELECT status::text FROM hosted_vaults WHERE id = $1")
            .bind(vault_id)
            .fetch_optional(pool)
            .await
            .map_err(|_| ApiFailure::server(request_id.to_owned()))?
            .ok_or_else(|| ApiFailure::not_found(request_id.to_owned()))?;
    Ok(parse_vault_status(&status))
}

async fn require_vault_not_pending_delete(
    pool: &PgPool,
    vault_id: Uuid,
    request_id: &str,
) -> Result<(), ApiFailure> {
    if require_vault_exists(pool, vault_id, request_id).await? == HostedVaultStatus::PendingDelete {
        return Err(ApiFailure::vault_archived(request_id.to_owned()));
    }
    Ok(())
}

async fn load_admin_vault_detail(
    pool: &PgPool,
    vault_id: Uuid,
    request_id: &str,
) -> Result<HostedVaultAdminDetail, ApiFailure> {
    let row = sqlx::query(
        r#"
        SELECT v.id, v.name, v.owner_user_id, owner.username AS owner_username,
               owner.display_name AS owner_display_name, v.status::text AS status,
               v.manifest_sequence, v.require_offline_copy, v.created_at, v.updated_at,
               (SELECT COUNT(*) FROM hosted_vault_memberships m WHERE m.vault_id = v.id) AS members,
               (SELECT COUNT(*) FROM hosted_file_entries f WHERE f.vault_id = v.id AND f.state = 'active') AS active_files,
               (SELECT COUNT(*) FROM hosted_file_entries f WHERE f.vault_id = v.id AND f.state = 'trashed') AS trashed_files,
               COALESCE((SELECT SUM(r.size_bytes) FROM hosted_file_revisions r WHERE r.vault_id = v.id), 0)::bigint AS storage_bytes
        FROM hosted_vaults v
        JOIN users owner ON owner.id = v.owner_user_id
        WHERE v.id = $1
        "#,
    )
    .bind(vault_id)
    .fetch_optional(pool)
    .await
    .map_err(|_| ApiFailure::server(request_id.to_owned()))?
    .ok_or_else(|| ApiFailure::not_found(request_id.to_owned()))?;
    Ok(HostedVaultAdminDetail {
        id: row.get::<Uuid, _>("id").to_string(),
        name: row.get("name"),
        owner_user_id: row.get::<Uuid, _>("owner_user_id").to_string(),
        owner_username: row.get("owner_username"),
        owner_display_name: row.get("owner_display_name"),
        status: parse_vault_status(row.get::<String, _>("status").as_str()),
        manifest_sequence: row.get("manifest_sequence"),
        members: row.get("members"),
        active_files: row.get("active_files"),
        trashed_files: row.get("trashed_files"),
        storage_bytes: row.get::<i64, _>("storage_bytes").max(0) as u64,
        require_offline_copy: row.get("require_offline_copy"),
        created_at: row
            .get::<chrono::DateTime<chrono::Utc>, _>("created_at")
            .to_rfc3339(),
        updated_at: row
            .get::<chrono::DateTime<chrono::Utc>, _>("updated_at")
            .to_rfc3339(),
        // Populated by the caller from the capability resolver.
        capabilities: Vec::new(),
    })
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BackupRuntimeSettings {
    pub schedule_enabled: bool,
    pub interval_seconds: u64,
    pub retention_days: u64,
    pub export_dir: Option<PathBuf>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredRuntimeSettings {
    browser_secure_cookies: Option<bool>,
    session_ttl_hours: Option<i64>,
    native_access_ttl_minutes: Option<i64>,
    native_refresh_ttl_days: Option<i64>,
    ws_ticket_ttl_seconds: Option<i64>,
    max_file_bytes: Option<u64>,
    max_import_bytes: Option<u64>,
    max_import_expanded_bytes: Option<u64>,
    storage_warning_bytes: Option<u64>,
    storage_quota_bytes: Option<u64>,
    revision_history_limit: Option<u64>,
    revision_storage_target_bytes: Option<u64>,
}

#[derive(Debug, Clone)]
pub(crate) struct EffectiveRuntimeSettings {
    browser_secure_cookies: bool,
    session_ttl_hours: i64,
    native_access_ttl_minutes: i64,
    native_refresh_ttl_days: i64,
    ws_ticket_ttl_seconds: i64,
    max_file_bytes: usize,
    max_import_bytes: usize,
    max_import_expanded_bytes: usize,
    storage_warning_bytes: u64,
    storage_quota_bytes: u64,
    revision_history_limit: u64,
    revision_storage_target_bytes: u64,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct StoredMaintenanceMode {
    pub enabled: bool,
    pub message: Option<String>,
    pub updated_at: Option<String>,
}

impl BackupRuntimeSettings {
    fn from_config(config: &crate::config::ServerConfig) -> Self {
        Self {
            schedule_enabled: config.backup_schedule_enabled,
            interval_seconds: config.backup_interval_seconds,
            retention_days: config.backup_retention_days,
            export_dir: config.backup_export_dir.clone(),
        }
    }

    fn from_request(
        config: &crate::config::ServerConfig,
        payload: UpdateBackupSettingsRequest,
        request_id: &str,
    ) -> Result<Self, ApiFailure> {
        if payload.schedule_enabled && payload.interval_seconds == 0 {
            return Err(ApiFailure::validation(
                "Backup interval must be greater than zero.",
                request_id.to_owned(),
            ));
        }
        let export_dir = payload.export_dir.and_then(|value| {
            let trimmed = value.trim();
            (!trimmed.is_empty()).then(|| PathBuf::from(trimmed))
        });
        Ok(Self {
            schedule_enabled: if env_locked("COLLAB_BACKUP_SCHEDULE_ENABLED") {
                config.backup_schedule_enabled
            } else {
                payload.schedule_enabled
            },
            interval_seconds: if env_locked("COLLAB_BACKUP_INTERVAL_SECONDS") {
                config.backup_interval_seconds
            } else {
                payload.interval_seconds.max(60)
            },
            retention_days: if env_locked("COLLAB_BACKUP_RETENTION_DAYS") {
                config.backup_retention_days
            } else {
                payload.retention_days
            },
            export_dir: if env_locked("COLLAB_BACKUP_EXPORT_DIR") {
                config.backup_export_dir.clone()
            } else {
                export_dir
            },
        })
    }

    fn to_protocol(&self) -> AdminBackupSettings {
        let locks = AdminBackupSettingsLocks {
            schedule_enabled: env_locked("COLLAB_BACKUP_SCHEDULE_ENABLED"),
            interval_seconds: env_locked("COLLAB_BACKUP_INTERVAL_SECONDS"),
            retention_days: env_locked("COLLAB_BACKUP_RETENTION_DAYS"),
            export_dir: env_locked("COLLAB_BACKUP_EXPORT_DIR"),
        };
        AdminBackupSettings {
            schedule_enabled: self.schedule_enabled,
            interval_seconds: self.interval_seconds,
            retention_days: self.retention_days,
            export_dir: self
                .export_dir
                .as_ref()
                .map(|path| path.display().to_string()),
            locks,
        }
    }
}

fn runtime_settings_path(backup_dir: &FsPath) -> PathBuf {
    backup_dir.join("server-settings.json")
}

fn maintenance_mode_path(backup_dir: &FsPath) -> PathBuf {
    backup_dir.join("maintenance-mode.json")
}

pub(crate) fn load_maintenance_mode(config: &crate::config::ServerConfig) -> StoredMaintenanceMode {
    fs::read_to_string(maintenance_mode_path(&config.backup_dir))
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default()
}

fn save_maintenance_mode(
    backup_dir: &FsPath,
    mode: &StoredMaintenanceMode,
    request_id: &str,
) -> Result<(), ApiFailure> {
    fs::create_dir_all(backup_dir).map_err(|_| ApiFailure::server(request_id.to_owned()))?;
    let raw = serde_json::to_string_pretty(mode)
        .map_err(|_| ApiFailure::server(request_id.to_owned()))?;
    fs::write(maintenance_mode_path(backup_dir), raw)
        .map_err(|_| ApiFailure::server(request_id.to_owned()))
}

fn maintenance_mode_to_protocol(mode: StoredMaintenanceMode) -> AdminMaintenanceMode {
    AdminMaintenanceMode {
        enabled: mode.enabled,
        message: mode.message,
        updated_at: mode.updated_at,
    }
}

fn env_locked(name: &str) -> bool {
    std::env::var_os(name).is_some()
}

fn setting_source(locked: bool, gui_value_present: bool) -> String {
    if locked {
        "env".into()
    } else if gui_value_present {
        "gui".into()
    } else {
        "default".into()
    }
}

fn load_stored_runtime_settings(config: &crate::config::ServerConfig) -> StoredRuntimeSettings {
    fs::read_to_string(runtime_settings_path(&config.backup_dir))
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default()
}

fn save_stored_runtime_settings(
    backup_dir: &FsPath,
    settings: &StoredRuntimeSettings,
    request_id: &str,
) -> Result<(), ApiFailure> {
    fs::create_dir_all(backup_dir).map_err(|_| ApiFailure::server(request_id.to_owned()))?;
    let raw = serde_json::to_string_pretty(settings)
        .map_err(|_| ApiFailure::server(request_id.to_owned()))?;
    fs::write(runtime_settings_path(backup_dir), raw)
        .map_err(|_| ApiFailure::server(request_id.to_owned()))
}

pub(crate) fn load_effective_runtime_settings(
    config: &crate::config::ServerConfig,
) -> EffectiveRuntimeSettings {
    let stored = load_stored_runtime_settings(config);
    EffectiveRuntimeSettings {
        browser_secure_cookies: if env_locked("COLLAB_BROWSER_SECURE_COOKIES") {
            config.browser_secure_cookies
        } else {
            stored
                .browser_secure_cookies
                .unwrap_or(config.browser_secure_cookies)
        },
        session_ttl_hours: if env_locked("COLLAB_SESSION_TTL_HOURS") {
            config.session_ttl_hours
        } else {
            stored.session_ttl_hours.unwrap_or(config.session_ttl_hours)
        },
        native_access_ttl_minutes: if env_locked("COLLAB_NATIVE_ACCESS_TTL_MINUTES") {
            config.native_access_ttl_minutes
        } else {
            stored
                .native_access_ttl_minutes
                .unwrap_or(config.native_access_ttl_minutes)
        },
        native_refresh_ttl_days: if env_locked("COLLAB_NATIVE_REFRESH_TTL_DAYS") {
            config.native_refresh_ttl_days
        } else {
            stored
                .native_refresh_ttl_days
                .unwrap_or(config.native_refresh_ttl_days)
        },
        ws_ticket_ttl_seconds: if env_locked("COLLAB_WS_TICKET_TTL_SECONDS") {
            config.ws_ticket_ttl_seconds
        } else {
            stored
                .ws_ticket_ttl_seconds
                .unwrap_or(config.ws_ticket_ttl_seconds)
        },
        max_file_bytes: if env_locked("COLLAB_MAX_FILE_BYTES") {
            config.max_file_bytes
        } else {
            stored
                .max_file_bytes
                .unwrap_or(config.max_file_bytes as u64) as usize
        },
        max_import_bytes: if env_locked("COLLAB_MAX_IMPORT_BYTES") {
            config.max_import_bytes
        } else {
            stored
                .max_import_bytes
                .unwrap_or(config.max_import_bytes as u64) as usize
        },
        max_import_expanded_bytes: if env_locked("COLLAB_MAX_IMPORT_EXPANDED_BYTES") {
            config.max_import_expanded_bytes
        } else {
            stored
                .max_import_expanded_bytes
                .unwrap_or(config.max_import_expanded_bytes as u64) as usize
        },
        storage_warning_bytes: if env_locked("COLLAB_STORAGE_WARNING_BYTES") {
            config.storage_warning_bytes
        } else {
            stored
                .storage_warning_bytes
                .unwrap_or(config.storage_warning_bytes)
        },
        storage_quota_bytes: if env_locked("COLLAB_STORAGE_QUOTA_BYTES") {
            config.storage_quota_bytes
        } else {
            stored
                .storage_quota_bytes
                .unwrap_or(config.storage_quota_bytes)
        },
        revision_history_limit: if env_locked("COLLAB_REVISION_HISTORY_LIMIT") {
            config.revision_history_limit as u64
        } else {
            stored
                .revision_history_limit
                .unwrap_or(config.revision_history_limit as u64)
        },
        revision_storage_target_bytes: if env_locked("COLLAB_REVISION_STORAGE_TARGET_BYTES") {
            config.revision_storage_target_bytes
        } else {
            stored
                .revision_storage_target_bytes
                .unwrap_or(config.revision_storage_target_bytes)
        },
    }
}

fn runtime_settings_to_protocol(
    config: &crate::config::ServerConfig,
    effective: &EffectiveRuntimeSettings,
) -> AdminRuntimeSettings {
    let stored = load_stored_runtime_settings(config);
    AdminRuntimeSettings {
        browser_secure_cookies: setting_bool(
            effective.browser_secure_cookies,
            "COLLAB_BROWSER_SECURE_COOKIES",
            stored.browser_secure_cookies.is_some(),
        ),
        session_ttl_hours: setting_i64(
            effective.session_ttl_hours,
            "COLLAB_SESSION_TTL_HOURS",
            stored.session_ttl_hours.is_some(),
        ),
        native_access_ttl_minutes: setting_i64(
            effective.native_access_ttl_minutes,
            "COLLAB_NATIVE_ACCESS_TTL_MINUTES",
            stored.native_access_ttl_minutes.is_some(),
        ),
        native_refresh_ttl_days: setting_i64(
            effective.native_refresh_ttl_days,
            "COLLAB_NATIVE_REFRESH_TTL_DAYS",
            stored.native_refresh_ttl_days.is_some(),
        ),
        ws_ticket_ttl_seconds: setting_i64(
            effective.ws_ticket_ttl_seconds,
            "COLLAB_WS_TICKET_TTL_SECONDS",
            stored.ws_ticket_ttl_seconds.is_some(),
        ),
        max_file_bytes: setting_u64(
            effective.max_file_bytes as u64,
            "COLLAB_MAX_FILE_BYTES",
            stored.max_file_bytes.is_some(),
        ),
        max_import_bytes: setting_u64(
            effective.max_import_bytes as u64,
            "COLLAB_MAX_IMPORT_BYTES",
            stored.max_import_bytes.is_some(),
        ),
        max_import_expanded_bytes: setting_u64(
            effective.max_import_expanded_bytes as u64,
            "COLLAB_MAX_IMPORT_EXPANDED_BYTES",
            stored.max_import_expanded_bytes.is_some(),
        ),
        storage_warning_bytes: setting_u64(
            effective.storage_warning_bytes,
            "COLLAB_STORAGE_WARNING_BYTES",
            stored.storage_warning_bytes.is_some(),
        ),
        storage_quota_bytes: setting_u64(
            effective.storage_quota_bytes,
            "COLLAB_STORAGE_QUOTA_BYTES",
            stored.storage_quota_bytes.is_some(),
        ),
        revision_history_limit: setting_u64(
            effective.revision_history_limit,
            "COLLAB_REVISION_HISTORY_LIMIT",
            stored.revision_history_limit.is_some(),
        ),
        revision_storage_target_bytes: setting_u64(
            effective.revision_storage_target_bytes,
            "COLLAB_REVISION_STORAGE_TARGET_BYTES",
            stored.revision_storage_target_bytes.is_some(),
        ),
    }
}

fn setting_bool(value: bool, env_var: &str, gui_value_present: bool) -> AdminRuntimeSetting<bool> {
    let locked = env_locked(env_var);
    AdminRuntimeSetting {
        value,
        env_var: env_var.into(),
        locked,
        source: setting_source(locked, gui_value_present),
    }
}

fn setting_i64(value: i64, env_var: &str, gui_value_present: bool) -> AdminRuntimeSetting<i64> {
    let locked = env_locked(env_var);
    AdminRuntimeSetting {
        value,
        env_var: env_var.into(),
        locked,
        source: setting_source(locked, gui_value_present),
    }
}

fn setting_u64(value: u64, env_var: &str, gui_value_present: bool) -> AdminRuntimeSetting<u64> {
    let locked = env_locked(env_var);
    AdminRuntimeSetting {
        value,
        env_var: env_var.into(),
        locked,
        source: setting_source(locked, gui_value_present),
    }
}

fn load_server_settings(config: &crate::config::ServerConfig) -> AdminServerSettings {
    let effective = load_effective_runtime_settings(config);
    AdminServerSettings {
        runtime: runtime_settings_to_protocol(config, &effective),
        backup: load_backup_runtime_settings(config).to_protocol(),
        maintenance: maintenance_mode_to_protocol(load_maintenance_mode(config)),
    }
}

pub(crate) fn maintenance_policy_from_settings(
    config: &crate::config::ServerConfig,
) -> crate::retention::MaintenancePolicy {
    let effective = load_effective_runtime_settings(config);
    crate::retention::MaintenancePolicy {
        audit_retention_days: config.audit_retention_days,
        revision_history_limit: effective.revision_history_limit.min(1_000_000) as u32,
        revision_storage_target_bytes: effective.revision_storage_target_bytes,
    }
}

fn apply_runtime_update(
    config: &crate::config::ServerConfig,
    payload: UpdateRuntimeSettingsRequest,
    request_id: &str,
) -> Result<StoredRuntimeSettings, ApiFailure> {
    let mut stored = load_stored_runtime_settings(config);
    if let Some(value) = payload.browser_secure_cookies {
        set_if_unlocked_bool(
            &mut stored.browser_secure_cookies,
            value,
            "COLLAB_BROWSER_SECURE_COOKIES",
            request_id,
        )?;
    }
    if let Some(value) = payload.session_ttl_hours {
        validate_range_i64(value, 1, 24 * 30, "Session TTL hours", request_id)?;
        set_if_unlocked_i64(
            &mut stored.session_ttl_hours,
            value,
            "COLLAB_SESSION_TTL_HOURS",
            request_id,
        )?;
    }
    if let Some(value) = payload.native_access_ttl_minutes {
        validate_range_i64(value, 1, 24 * 60, "Native access TTL minutes", request_id)?;
        set_if_unlocked_i64(
            &mut stored.native_access_ttl_minutes,
            value,
            "COLLAB_NATIVE_ACCESS_TTL_MINUTES",
            request_id,
        )?;
    }
    if let Some(value) = payload.native_refresh_ttl_days {
        validate_range_i64(value, 1, 365, "Native refresh TTL days", request_id)?;
        set_if_unlocked_i64(
            &mut stored.native_refresh_ttl_days,
            value,
            "COLLAB_NATIVE_REFRESH_TTL_DAYS",
            request_id,
        )?;
    }
    if let Some(value) = payload.ws_ticket_ttl_seconds {
        validate_range_i64(value, 1, 600, "WebSocket ticket TTL seconds", request_id)?;
        set_if_unlocked_i64(
            &mut stored.ws_ticket_ttl_seconds,
            value,
            "COLLAB_WS_TICKET_TTL_SECONDS",
            request_id,
        )?;
    }
    if let Some(value) = payload.max_file_bytes {
        validate_range_u64(
            value,
            1,
            8 * 1024 * 1024 * 1024,
            "Max file bytes",
            request_id,
        )?;
        set_if_unlocked_u64(
            &mut stored.max_file_bytes,
            value,
            "COLLAB_MAX_FILE_BYTES",
            request_id,
        )?;
    }
    if let Some(value) = payload.max_import_bytes {
        validate_range_u64(
            value,
            1,
            8 * 1024 * 1024 * 1024,
            "Max import bytes",
            request_id,
        )?;
        set_if_unlocked_u64(
            &mut stored.max_import_bytes,
            value,
            "COLLAB_MAX_IMPORT_BYTES",
            request_id,
        )?;
    }
    if let Some(value) = payload.max_import_expanded_bytes {
        validate_range_u64(
            value,
            1,
            32 * 1024 * 1024 * 1024,
            "Max expanded import bytes",
            request_id,
        )?;
        set_if_unlocked_u64(
            &mut stored.max_import_expanded_bytes,
            value,
            "COLLAB_MAX_IMPORT_EXPANDED_BYTES",
            request_id,
        )?;
    }
    if let Some(value) = payload.storage_warning_bytes {
        validate_range_u64(
            value,
            0,
            1024 * 1024 * 1024 * 1024,
            "Storage warning bytes",
            request_id,
        )?;
        set_if_unlocked_u64(
            &mut stored.storage_warning_bytes,
            value,
            "COLLAB_STORAGE_WARNING_BYTES",
            request_id,
        )?;
    }
    if let Some(value) = payload.storage_quota_bytes {
        validate_range_u64(
            value,
            0,
            64 * 1024 * 1024 * 1024 * 1024,
            "Storage quota bytes",
            request_id,
        )?;
        set_if_unlocked_u64(
            &mut stored.storage_quota_bytes,
            value,
            "COLLAB_STORAGE_QUOTA_BYTES",
            request_id,
        )?;
    }
    if let Some(value) = payload.revision_history_limit {
        validate_range_u64(value, 0, 1_000_000, "Revision history limit", request_id)?;
        set_if_unlocked_u64(
            &mut stored.revision_history_limit,
            value,
            "COLLAB_REVISION_HISTORY_LIMIT",
            request_id,
        )?;
    }
    if let Some(value) = payload.revision_storage_target_bytes {
        validate_range_u64(
            value,
            0,
            64 * 1024 * 1024 * 1024 * 1024,
            "Revision storage target bytes",
            request_id,
        )?;
        set_if_unlocked_u64(
            &mut stored.revision_storage_target_bytes,
            value,
            "COLLAB_REVISION_STORAGE_TARGET_BYTES",
            request_id,
        )?;
    }
    let max_import = if env_locked("COLLAB_MAX_IMPORT_BYTES") {
        config.max_import_bytes as u64
    } else {
        stored
            .max_import_bytes
            .unwrap_or(config.max_import_bytes as u64)
    };
    let max_expanded = if env_locked("COLLAB_MAX_IMPORT_EXPANDED_BYTES") {
        config.max_import_expanded_bytes as u64
    } else {
        stored
            .max_import_expanded_bytes
            .unwrap_or(config.max_import_expanded_bytes as u64)
    };
    if max_expanded < max_import {
        return Err(ApiFailure::validation(
            "Expanded import limit must be at least the compressed import limit.",
            request_id.to_owned(),
        ));
    }
    Ok(stored)
}

fn validate_range_i64(
    value: i64,
    min: i64,
    max: i64,
    label: &str,
    request_id: &str,
) -> Result<(), ApiFailure> {
    if value < min || value > max {
        return Err(ApiFailure::validation(
            format!("{label} must be between {min} and {max}."),
            request_id.to_owned(),
        ));
    }
    Ok(())
}

fn validate_range_u64(
    value: u64,
    min: u64,
    max: u64,
    label: &str,
    request_id: &str,
) -> Result<(), ApiFailure> {
    if value < min || value > max {
        return Err(ApiFailure::validation(
            format!("{label} must be between {min} and {max}."),
            request_id.to_owned(),
        ));
    }
    Ok(())
}

fn locked_failure(env_var: &str, request_id: &str) -> ApiFailure {
    ApiFailure::validation(
        format!(
            "{env_var} is configured by the environment and cannot be changed in the admin UI."
        ),
        request_id.to_owned(),
    )
}

fn set_if_unlocked_bool(
    target: &mut Option<bool>,
    value: bool,
    env_var: &str,
    request_id: &str,
) -> Result<(), ApiFailure> {
    if env_locked(env_var) {
        return Err(locked_failure(env_var, request_id));
    }
    *target = Some(value);
    Ok(())
}

fn set_if_unlocked_i64(
    target: &mut Option<i64>,
    value: i64,
    env_var: &str,
    request_id: &str,
) -> Result<(), ApiFailure> {
    if env_locked(env_var) {
        return Err(locked_failure(env_var, request_id));
    }
    *target = Some(value);
    Ok(())
}

fn set_if_unlocked_u64(
    target: &mut Option<u64>,
    value: u64,
    env_var: &str,
    request_id: &str,
) -> Result<(), ApiFailure> {
    if env_locked(env_var) {
        return Err(locked_failure(env_var, request_id));
    }
    *target = Some(value);
    Ok(())
}

pub(crate) fn load_backup_runtime_settings(
    config: &crate::config::ServerConfig,
) -> BackupRuntimeSettings {
    let path = backup_settings_path(&config.backup_dir);
    fs::read_to_string(path)
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_else(|| BackupRuntimeSettings::from_config(config))
}

fn save_backup_runtime_settings(
    backup_dir: &FsPath,
    settings: &BackupRuntimeSettings,
    request_id: &str,
) -> Result<(), ApiFailure> {
    fs::create_dir_all(backup_dir).map_err(|_| ApiFailure::server(request_id.to_owned()))?;
    let raw = serde_json::to_string_pretty(settings)
        .map_err(|_| ApiFailure::server(request_id.to_owned()))?;
    fs::write(backup_settings_path(backup_dir), raw)
        .map_err(|_| ApiFailure::server(request_id.to_owned()))
}

fn backup_settings_path(backup_dir: &FsPath) -> PathBuf {
    backup_dir.join("backup-settings.json")
}

fn load_backup_overview(state: &AppState) -> AdminBackupOverview {
    let settings = load_backup_runtime_settings(&state.config);
    let mut backups = Vec::new();
    if let Ok(entries) = fs::read_dir(&state.config.backup_dir) {
        for entry in entries.flatten() {
            let Ok(file_type) = entry.file_type() else {
                continue;
            };
            if !file_type.is_dir() {
                continue;
            }
            let name = entry.file_name().to_string_lossy().to_string();
            if !is_safe_backup_name(&name) {
                continue;
            }
            backups.push(backup_summary(&name, &entry.path()));
        }
    }
    backups.sort_by(|left, right| right.name.cmp(&left.name));
    AdminBackupOverview {
        backup_dir: state.config.backup_dir.display().to_string(),
        backup_command_configured: state.config.backup_command.is_some(),
        restore_command_configured: state.config.restore_command.is_some(),
        schedule: AdminBackupSchedule {
            enabled: settings.schedule_enabled,
            interval_seconds: settings.interval_seconds,
            retention_days: settings.retention_days,
            mode: if settings.schedule_enabled {
                "server-scheduler"
            } else {
                "manual"
            }
            .into(),
        },
        export_target: backup_export_target(&settings.export_dir),
        settings: settings.to_protocol(),
        backups,
    }
}

fn backup_export_target(path: &Option<PathBuf>) -> AdminBackupExportTarget {
    let Some(path) = path else {
        return AdminBackupExportTarget {
            configured: false,
            path: None,
            writable: false,
            message: "No external export target configured.".into(),
        };
    };
    let writable = path.is_dir()
        && path
            .metadata()
            .map(|metadata| !metadata.permissions().readonly())
            .unwrap_or(false);
    AdminBackupExportTarget {
        configured: true,
        path: Some(path.display().to_string()),
        writable,
        message: if writable {
            "Backups are copied to this mounted export target after creation.".into()
        } else {
            "Export target is configured but is not writable by the server container.".into()
        },
    }
}

fn backup_summary(name: &str, dir: &FsPath) -> AdminBackupSummary {
    AdminBackupSummary {
        name: name.to_owned(),
        created_at: read_backup_created_at(dir).or_else(|| {
            dir.metadata()
                .ok()?
                .modified()
                .ok()
                .map(system_time_to_rfc3339)
        }),
        size_bytes: directory_size(dir),
        has_postgres_dump: dir.join("postgres.dump").is_file(),
        has_blob_archive: dir.join("blobs.tar.gz").is_file(),
        has_manifest: dir.join("manifest.txt").is_file(),
        has_config: dir.join("config.env").is_file(),
        has_checksums: dir.join("checksums.sha256").is_file(),
    }
}

fn read_backup_created_at(dir: &FsPath) -> Option<String> {
    let manifest = fs::read_to_string(dir.join("manifest.txt")).ok()?;
    manifest.lines().find_map(|line| {
        line.strip_prefix("created_at=")
            .filter(|value| !value.trim().is_empty())
            .map(|value| value.trim().to_owned())
    })
}

fn directory_size(path: &FsPath) -> u64 {
    let Ok(metadata) = path.metadata() else {
        return 0;
    };
    if metadata.is_file() {
        return metadata.len();
    }
    let Ok(entries) = fs::read_dir(path) else {
        return 0;
    };
    entries
        .flatten()
        .map(|entry| directory_size(&entry.path()))
        .sum()
}

fn system_time_to_rfc3339(value: std::time::SystemTime) -> String {
    chrono::DateTime::<chrono::Utc>::from(value).to_rfc3339()
}

fn latest_backup_age(backups: &[AdminBackupSummary]) -> Option<Duration> {
    let newest = backups
        .iter()
        .filter_map(|backup| backup.created_at.as_deref())
        .filter_map(parse_backup_created_at)
        .max()?;
    let newest_system_time: SystemTime = newest.into();
    SystemTime::now().duration_since(newest_system_time).ok()
}

fn parse_backup_created_at(value: &str) -> Option<chrono::DateTime<chrono::Utc>> {
    chrono::DateTime::parse_from_rfc3339(value)
        .ok()
        .map(|value| value.with_timezone(&chrono::Utc))
        .or_else(|| {
            chrono::NaiveDateTime::parse_from_str(value, "%Y%m%dT%H%M%SZ")
                .ok()
                .map(|value| value.and_utc())
        })
}

fn format_bytes(bytes: u64) -> String {
    const UNITS: [&str; 5] = ["B", "KiB", "MiB", "GiB", "TiB"];
    let mut value = bytes as f64;
    let mut unit = UNITS[0];
    for candidate in UNITS.iter().skip(1) {
        if value < 1024.0 {
            break;
        }
        value /= 1024.0;
        unit = candidate;
    }
    if unit == "B" {
        format!("{bytes} {unit}")
    } else {
        format!("{value:.1} {unit}")
    }
}

fn resolve_backup_dir(root: &FsPath, name: &str, request_id: &str) -> Result<PathBuf, ApiFailure> {
    if !is_safe_backup_name(name) {
        return Err(ApiFailure::validation(
            "Backup name is not valid.",
            request_id.to_owned(),
        ));
    }
    let dir = root.join(name);
    if !dir.is_dir() {
        return Err(ApiFailure::not_found(request_id.to_owned()));
    }
    Ok(dir)
}

fn delete_or_quarantine_backup_dir(
    root: &FsPath,
    name: &str,
    dir: &FsPath,
    request_id: &str,
) -> Result<&'static str, ApiFailure> {
    match fs::remove_dir_all(dir) {
        Ok(()) => return Ok("deleted"),
        Err(remove_error) => {
            let quarantine = root.join(format!(".deleted-{name}-{request_id}"));
            match fs::rename(dir, &quarantine) {
                Ok(()) => Ok("quarantined"),
                Err(rename_error) => Err(ApiFailure::validation(
                    format!(
                        "Backup could not be deleted. Remove failed with: {remove_error}. Quarantine failed with: {rename_error}."
                    ),
                    request_id.to_owned(),
                )),
            }
        }
    }
}

fn list_backup_archive_entries(
    archive_path: &FsPath,
    request_id: &str,
) -> Result<Vec<String>, ApiFailure> {
    let output = std::process::Command::new("tar")
        .arg("-tzf")
        .arg(archive_path)
        .output()
        .map_err(|_| ApiFailure::server(request_id.to_owned()))?;
    if !output.status.success() {
        return Err(ApiFailure::validation(
            format!(
                "Backup archive could not be listed: {}{}",
                String::from_utf8_lossy(&output.stdout),
                String::from_utf8_lossy(&output.stderr)
            )
            .trim()
            .to_owned(),
            request_id.to_owned(),
        ));
    }
    Ok(String::from_utf8_lossy(&output.stdout)
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .map(str::to_owned)
        .collect())
}

fn validate_backup_archive_entries(
    entries: &[String],
    request_id: &str,
) -> Result<String, ApiFailure> {
    if entries.is_empty() {
        return Err(ApiFailure::validation(
            "Backup archive is empty.",
            request_id.to_owned(),
        ));
    }
    let mut root: Option<String> = None;
    for entry in entries {
        if entry.starts_with('/') || entry.contains('\\') {
            return Err(ApiFailure::validation(
                "Backup archive contains an unsafe path.",
                request_id.to_owned(),
            ));
        }
        let mut parts = entry.split('/').filter(|part| !part.is_empty());
        let Some(first) = parts.next() else {
            return Err(ApiFailure::validation(
                "Backup archive contains an empty path.",
                request_id.to_owned(),
            ));
        };
        if first == "." || first == ".." || entry.split('/').any(|part| part == "..") {
            return Err(ApiFailure::validation(
                "Backup archive contains a path traversal entry.",
                request_id.to_owned(),
            ));
        }
        if !is_safe_backup_name(first) {
            return Err(ApiFailure::validation(
                "Backup archive root is not a valid Collab backup name.",
                request_id.to_owned(),
            ));
        }
        match root.as_deref() {
            Some(existing) if existing != first => {
                return Err(ApiFailure::validation(
                    "Backup archive must contain exactly one backup directory.",
                    request_id.to_owned(),
                ));
            }
            None => root = Some(first.to_owned()),
            _ => {}
        }
    }
    root.ok_or_else(|| ApiFailure::validation("Backup archive is empty.", request_id.to_owned()))
}

fn extract_backup_archive(
    archive_path: &FsPath,
    destination: &FsPath,
    request_id: &str,
) -> Result<(), ApiFailure> {
    let output = std::process::Command::new("tar")
        .arg("-xzf")
        .arg(archive_path)
        .arg("-C")
        .arg(destination)
        .output()
        .map_err(|_| ApiFailure::server(request_id.to_owned()))?;
    if output.status.success() {
        return Ok(());
    }
    Err(ApiFailure::validation(
        format!(
            "Backup archive could not be extracted: {}{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        )
        .trim()
        .to_owned(),
        request_id.to_owned(),
    ))
}

fn validate_backup_manifest_version(dir: &FsPath, request_id: &str) -> Result<(), ApiFailure> {
    let manifest = fs::read_to_string(dir.join("manifest.txt")).map_err(|_| {
        ApiFailure::validation("Backup manifest is missing.", request_id.to_owned())
    })?;
    let version = manifest
        .lines()
        .find_map(|line| line.strip_prefix("collab_backup_version="))
        .map(str::trim)
        .ok_or_else(|| {
            ApiFailure::validation(
                "Backup manifest does not declare a version.",
                request_id.to_owned(),
            )
        })?;
    if version != "1" {
        return Err(ApiFailure::validation(
            format!("Backup version {version} is not compatible with this server."),
            request_id.to_owned(),
        ));
    }
    Ok(())
}

fn validate_imported_backup_dir(
    name: &str,
    dir: &FsPath,
    request_id: &str,
) -> Result<(), ApiFailure> {
    if !dir.is_dir() {
        return Err(ApiFailure::validation(
            "Backup archive did not contain the expected backup directory.",
            request_id.to_owned(),
        ));
    }
    for artifact in [
        "postgres.dump",
        "blobs.tar.gz",
        "manifest.txt",
        "config.env",
        "checksums.sha256",
    ] {
        if !dir.join(artifact).is_file() {
            return Err(ApiFailure::validation(
                format!("Backup archive is missing {artifact}."),
                request_id.to_owned(),
            ));
        }
    }
    validate_backup_manifest_version(dir, request_id)?;
    let verification = verify_backup(name, dir, request_id)?;
    if !verification.ok {
        return Err(ApiFailure::validation(
            "Backup checksum verification failed; refusing import.",
            request_id.to_owned(),
        ));
    }
    Ok(())
}

fn is_safe_backup_name(name: &str) -> bool {
    name.starts_with("collab-backup-")
        && name.len() <= 96
        && name
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
}

fn verify_backup(
    name: &str,
    dir: &FsPath,
    request_id: &str,
) -> Result<AdminBackupVerification, ApiFailure> {
    let checksum_path = dir.join("checksums.sha256");
    let checksums = fs::read_to_string(&checksum_path).map_err(|_| {
        ApiFailure::validation("Backup checksums are missing.", request_id.to_owned())
    })?;
    let mut artifacts = Vec::new();
    for line in checksums.lines().filter(|line| !line.trim().is_empty()) {
        let Some((expected, path)) = parse_checksum_line(line) else {
            artifacts.push(AdminBackupArtifactVerification {
                path: line.to_owned(),
                expected_sha256: String::new(),
                actual_sha256: None,
                ok: false,
                error: Some("Malformed checksum line.".into()),
            });
            continue;
        };
        let artifact_path = dir.join(&path);
        if path.contains('/') || path.contains('\\') || path == "." || path.contains("..") {
            artifacts.push(AdminBackupArtifactVerification {
                path,
                expected_sha256: expected,
                actual_sha256: None,
                ok: false,
                error: Some("Unsafe artifact path.".into()),
            });
            continue;
        }
        match sha256_file(&artifact_path) {
            Ok(actual) => {
                let ok = actual.eq_ignore_ascii_case(&expected);
                artifacts.push(AdminBackupArtifactVerification {
                    path,
                    expected_sha256: expected,
                    actual_sha256: Some(actual),
                    ok,
                    error: (!ok).then(|| "Checksum mismatch.".into()),
                });
            }
            Err(_) => artifacts.push(AdminBackupArtifactVerification {
                path,
                expected_sha256: expected,
                actual_sha256: None,
                ok: false,
                error: Some("Artifact could not be read.".into()),
            }),
        }
    }
    let ok = !artifacts.is_empty() && artifacts.iter().all(|artifact| artifact.ok);
    Ok(AdminBackupVerification {
        name: name.to_owned(),
        ok,
        checked_at: chrono::Utc::now().to_rfc3339(),
        artifacts,
    })
}

fn parse_checksum_line(line: &str) -> Option<(String, String)> {
    let trimmed = line.trim();
    let (expected, rest) = trimmed.split_once(char::is_whitespace)?;
    if expected.len() != 64 || !expected.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return None;
    }
    let path = rest.trim().trim_start_matches('*').trim();
    if path.is_empty() {
        return None;
    }
    Some((expected.to_ascii_lowercase(), path.to_owned()))
}

fn sha256_file(path: &FsPath) -> std::io::Result<String> {
    let bytes = fs::read(path)?;
    let digest = Sha256::digest(&bytes);
    Ok(format!("{digest:x}"))
}

pub(crate) async fn run_operator_command(
    command: &str,
    backup_dir: &FsPath,
    backup_name: Option<&str>,
    settings: &BackupRuntimeSettings,
    max_duration: Duration,
    request_id: &str,
) -> Result<AdminBackupCommandResult, ApiFailure> {
    let mut process = Command::new("/bin/sh");
    process
        .arg("-c")
        .arg(command)
        .env("COLLAB_BACKUP_DIR", backup_dir)
        .env(
            "COLLAB_BACKUP_INTERVAL_SECONDS",
            settings.interval_seconds.to_string(),
        )
        .env(
            "COLLAB_BACKUP_RETENTION_DAYS",
            settings.retention_days.to_string(),
        )
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if let Some(export_dir) = &settings.export_dir {
        process.env("COLLAB_BACKUP_EXPORT_DIR", export_dir);
    } else {
        process.env_remove("COLLAB_BACKUP_EXPORT_DIR");
    }
    if let Some(backup_name) = backup_name {
        process.env("COLLAB_RESTORE_BACKUP", backup_name);
    }
    let output = timeout(max_duration, process.output())
        .await
        .map_err(|_| {
            ApiFailure::validation("The backup command timed out.", request_id.to_owned())
        })?
        .map_err(|_| ApiFailure::server(request_id.to_owned()))?;
    let combined = truncate_command_output(&format!(
        "{}{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    ));
    if !output.status.success() {
        let code = output
            .status
            .code()
            .map(|code| code.to_string())
            .unwrap_or_else(|| "signal".into());
        let message = if combined.trim().is_empty() {
            format!("The backup command failed with exit status {code}.")
        } else {
            format!(
                "The backup command failed with exit status {code}: {}",
                combined.trim()
            )
        };
        return Err(ApiFailure::validation(message, request_id.to_owned()));
    }
    Ok(AdminBackupCommandResult {
        status: "ok".into(),
        message: "Command completed successfully.".into(),
        output: (!combined.trim().is_empty()).then_some(combined),
    })
}

fn truncate_command_output(value: &str) -> String {
    const MAX_OUTPUT: usize = 8 * 1024;
    if value.len() <= MAX_OUTPUT {
        return value.to_owned();
    }
    format!("{}…", &value[..MAX_OUTPUT])
}

async fn authenticate_password(
    state: &AppState,
    username: &str,
    password: &str,
    request_id: &str,
) -> Result<ServerUser, ApiFailure> {
    let normalized = normalize_username(username).map_err(|_| {
        ApiFailure::new(
            StatusCode::UNAUTHORIZED,
            ErrorCode::AuthenticationInvalid,
            "The username or password is incorrect.",
            request_id.to_owned(),
        )
    })?;
    if !state.login_limiter.allow(&normalized).await {
        return Err(ApiFailure::new(
            StatusCode::TOO_MANY_REQUESTS,
            ErrorCode::RateLimited,
            "Too many login attempts. Try again shortly.",
            request_id.to_owned(),
        ));
    }
    let row = sqlx::query(
        r#"
        SELECT u.id, u.username, u.display_name, u.role::text AS role, u.status::text AS status,
          u.created_at, u.last_login_at, u.is_primary_admin, c.password_hash,
          ((SELECT COUNT(*) FROM sessions active WHERE active.user_id = u.id AND active.revoked_at IS NULL AND active.expires_at > NOW())
           + (SELECT COUNT(*) FROM native_sessions active WHERE active.user_id = u.id AND active.revoked_at IS NULL AND active.refresh_expires_at > NOW()))
           AS active_sessions
        FROM users u JOIN credentials c ON c.user_id = u.id WHERE u.normalized_username = $1
        "#,
    ).bind(&normalized).fetch_optional(&state.database).await.map_err(|_| ApiFailure::server(request_id.to_owned()))?;
    let valid = row
        .as_ref()
        .map(|row| {
            row.get::<String, _>("status") == "active"
                && verify_password(password, row.get::<String, _>("password_hash").as_str())
        })
        .unwrap_or(false);
    if !valid {
        record_audit(
            &state.database,
            None,
            "auth.native.login",
            None,
            None,
            "failure",
            request_id,
            json!({"username": normalized}),
        )
        .await?;
        return Err(ApiFailure::new(
            StatusCode::UNAUTHORIZED,
            ErrorCode::AuthenticationInvalid,
            "The username or password is incorrect.",
            request_id.to_owned(),
        ));
    }
    state.login_limiter.clear(&normalized).await;
    let user = user_from_row(row.as_ref().expect("validated row exists"));
    sqlx::query("UPDATE users SET last_login_at = NOW(), updated_at = NOW() WHERE id = $1")
        .bind(Uuid::parse_str(&user.id).unwrap())
        .execute(&state.database)
        .await
        .map_err(|_| ApiFailure::server(request_id.to_owned()))?;
    record_audit(
        &state.database,
        Some(&user.id),
        "auth.native.login",
        Some("user"),
        Some(&user.id),
        "success",
        request_id,
        json!({}),
    )
    .await?;
    Ok(user)
}

async fn create_native_session(
    state: &AppState,
    user: ServerUser,
    client_name: &str,
    request_id: &str,
) -> Result<NativeSession, ApiFailure> {
    if client_name.trim().is_empty() || client_name.len() > 128 {
        return Err(ApiFailure::validation(
            "Client name must be between 1 and 128 characters.",
            request_id.to_owned(),
        ));
    }
    let access_token = generate_secret();
    let refresh_token = generate_secret();
    let settings = load_effective_runtime_settings(&state.config);
    let access_expires_at =
        chrono::Utc::now() + chrono::Duration::minutes(settings.native_access_ttl_minutes);
    let refresh_expires_at =
        chrono::Utc::now() + chrono::Duration::days(settings.native_refresh_ttl_days);
    sqlx::query(
        "INSERT INTO native_sessions (id, user_id, access_token_hash, refresh_token_hash, client_name, access_expires_at, refresh_expires_at) VALUES ($1, $2, $3, $4, $5, $6, $7)",
    ).bind(Uuid::now_v7()).bind(Uuid::parse_str(&user.id).unwrap()).bind(hash_secret(&access_token))
        .bind(hash_secret(&refresh_token)).bind(client_name.trim()).bind(access_expires_at).bind(refresh_expires_at)
        .execute(&state.database).await.map_err(|_| ApiFailure::server(request_id.to_owned()))?;
    Ok(NativeSession {
        user,
        access_token,
        refresh_token,
        access_expires_at: access_expires_at.to_rfc3339(),
        refresh_expires_at: refresh_expires_at.to_rfc3339(),
    })
}

async fn replace_password_and_revoke(
    pool: &PgPool,
    user_id: Uuid,
    password: &str,
    keep_session: Option<Uuid>,
    request_id: &str,
) -> Result<(), ApiFailure> {
    let password_hash = hash_password(password)
        .map_err(|error| ApiFailure::validation(error.to_string(), request_id.to_owned()))?;
    let result = sqlx::query(
        "UPDATE credentials SET password_hash = $1, password_changed_at = NOW() WHERE user_id = $2",
    )
    .bind(password_hash)
    .bind(user_id)
    .execute(pool)
    .await
    .map_err(|_| ApiFailure::server(request_id.to_owned()))?;
    if result.rows_affected() == 0 {
        return Err(ApiFailure::not_found(request_id.to_owned()));
    }
    sqlx::query("UPDATE sessions SET revoked_at = NOW() WHERE user_id = $1 AND ($2::uuid IS NULL OR id <> $2)")
        .bind(user_id).bind(keep_session).execute(pool).await.map_err(|_| ApiFailure::server(request_id.to_owned()))?;
    sqlx::query("UPDATE native_sessions SET revoked_at = NOW() WHERE user_id = $1 AND ($2::uuid IS NULL OR id <> $2)")
        .bind(user_id).bind(keep_session).execute(pool).await.map_err(|_| ApiFailure::server(request_id.to_owned()))?;
    Ok(())
}

async fn is_primary_admin(
    pool: &PgPool,
    user_id: Uuid,
    request_id: &str,
) -> Result<bool, ApiFailure> {
    sqlx::query_scalar::<_, bool>("SELECT is_primary_admin FROM users WHERE id = $1")
        .bind(user_id)
        .fetch_optional(pool)
        .await
        .map_err(|_| ApiFailure::server(request_id.to_owned()))?
        .ok_or_else(|| ApiFailure::not_found(request_id.to_owned()))
}

#[derive(Debug)]
struct VaultAccess {
    owner: bool,
    status: HostedVaultStatus,
}

fn user_uuid(user: &ServerUser) -> Uuid {
    Uuid::parse_str(&user.id).expect("database UUID is valid")
}

fn validate_vault_name(name: &str, request_id: &str) -> Result<String, ApiFailure> {
    let name = name.trim();
    if name.is_empty() || name.len() > 128 || name.chars().any(char::is_control) {
        return Err(ApiFailure::validation(
            "Vault name must be between 1 and 128 printable characters.",
            request_id.to_owned(),
        ));
    }
    Ok(name.to_owned())
}

fn vault_role_name(role: HostedVaultRole) -> &'static str {
    match role {
        HostedVaultRole::Viewer => "viewer",
        HostedVaultRole::Editor => "editor",
        HostedVaultRole::Admin => "admin",
    }
}

fn parse_vault_role(role: &str) -> HostedVaultRole {
    match role {
        "admin" => HostedVaultRole::Admin,
        "editor" => HostedVaultRole::Editor,
        _ => HostedVaultRole::Viewer,
    }
}

fn vault_status_name(status: HostedVaultStatus) -> &'static str {
    match status {
        HostedVaultStatus::Active => "active",
        HostedVaultStatus::Archived => "archived",
        HostedVaultStatus::PendingDelete => "pending_delete",
    }
}

fn parse_vault_status(status: &str) -> HostedVaultStatus {
    match status {
        "archived" => HostedVaultStatus::Archived,
        "pending_delete" => HostedVaultStatus::PendingDelete,
        _ => HostedVaultStatus::Active,
    }
}

/// The fully resolved capability set for a (user, vault) pair, plus the
/// owner/server-admin flags and vault status that several handlers branch on.
pub(crate) struct EffectiveAccess {
    owner: bool,
    server_admin: bool,
    status: HostedVaultStatus,
    capabilities: HashSet<Capability>,
}

impl EffectiveAccess {
    /// Whether the user effectively holds a capability. Owners and active server
    /// administrators implicitly hold every capability.
    pub(crate) fn has(&self, capability: Capability) -> bool {
        self.owner || self.server_admin || self.capabilities.contains(&capability)
    }

    /// Whether the vault is active (not archived or pending deletion).
    pub(crate) fn status(&self) -> HostedVaultStatus {
        self.status
    }

    /// A coarse role derived from the effective capabilities, used to keep the
    /// legacy `VaultAccess { role }` contract working for unmigrated call sites.
    pub(crate) fn derived_role(&self) -> HostedVaultRole {
        if self.owner || self.server_admin || self.has(Capability::VaultManageMembers) {
            HostedVaultRole::Admin
        } else if self.has(Capability::FileWrite) {
            HostedVaultRole::Editor
        } else {
            HostedVaultRole::Viewer
        }
    }

    fn capability_tokens(&self) -> Vec<String> {
        // Emit in canonical order for stable client behavior.
        Capability::ALL
            .into_iter()
            .filter(|capability| self.has(*capability))
            .map(|capability| capability.as_token().to_owned())
            .collect()
    }
}

fn tokens_to_capabilities(tokens: &[String]) -> HashSet<Capability> {
    tokens
        .iter()
        .filter_map(|token| Capability::from_token(token))
        .collect()
}

/// Resolves the effective capabilities a user has on a vault by intersecting
/// every applicable grant source (the user's direct membership and each group
/// they belong to that has a grant on the vault). Owners and active server
/// administrators bypass resolution with the full capability set. Returns
/// `not_found` when the vault does not exist or the user has no grant source —
/// matching the pre-existing membership-or-admin visibility rule.
pub(crate) async fn resolve_vault_capabilities(
    pool: &PgPool,
    vault_id: Uuid,
    user_id: Uuid,
    request_id: &str,
) -> Result<EffectiveAccess, ApiFailure> {
    let meta = sqlx::query(
        r#"
        SELECT v.status::text AS status,
               (v.owner_user_id = $2) AS owner,
               (u.role = 'admin') AS server_admin,
               (m.user_id IS NOT NULL) AS has_membership,
               m.role::text AS member_role,
               COALESCE(m.capabilities, mt.capabilities) AS member_caps
        FROM hosted_vaults v
        JOIN users u ON u.id = $2
        LEFT JOIN hosted_vault_memberships m ON m.vault_id = v.id AND m.user_id = u.id
        LEFT JOIN permission_templates mt ON mt.id = m.template_id
        WHERE v.id = $1
        "#,
    )
    .bind(vault_id)
    .bind(user_id)
    .fetch_optional(pool)
    .await
    .map_err(|_| ApiFailure::server(request_id.to_owned()))?
    .ok_or_else(|| ApiFailure::not_found(request_id.to_owned()))?;

    let status = parse_vault_status(meta.get::<String, _>("status").as_str());
    let owner: bool = meta.get("owner");
    let server_admin: bool = meta.get("server_admin");

    if owner || server_admin {
        return Ok(EffectiveAccess {
            owner,
            server_admin,
            status,
            capabilities: Capability::ALL.into_iter().collect(),
        });
    }

    // Gather one capability set per applicable grant source.
    let mut sources: Vec<HashSet<Capability>> = Vec::new();
    if meta.get::<bool, _>("has_membership") {
        let explicit: Option<Vec<String>> = meta.get("member_caps");
        sources.push(match explicit {
            Some(tokens) => tokens_to_capabilities(&tokens),
            None => capabilities_for_role(parse_vault_role(
                meta.get::<String, _>("member_role").as_str(),
            ))
            .into_iter()
            .collect(),
        });
    }

    let group_rows = sqlx::query(
        r#"
        SELECT COALESCE(g.capabilities, gt.capabilities) AS caps
        FROM hosted_vault_group_grants g
        JOIN user_group_memberships ugm
            ON ugm.group_id = g.group_id AND ugm.user_id = $2
        LEFT JOIN permission_templates gt ON gt.id = g.template_id
        WHERE g.vault_id = $1
        "#,
    )
    .bind(vault_id)
    .bind(user_id)
    .fetch_all(pool)
    .await
    .map_err(|_| ApiFailure::server(request_id.to_owned()))?;
    for row in &group_rows {
        let tokens: Option<Vec<String>> = row.get("caps");
        sources.push(tokens_to_capabilities(&tokens.unwrap_or_default()));
    }

    if sources.is_empty() {
        // No membership and no group grant: the vault is not visible to this user.
        return Err(ApiFailure::not_found(request_id.to_owned()));
    }

    // Most-restrictive composition: intersect every applicable source.
    let mut capabilities = sources[0].clone();
    for source in &sources[1..] {
        capabilities.retain(|capability| source.contains(capability));
    }

    Ok(EffectiveAccess {
        owner,
        server_admin,
        status,
        capabilities,
    })
}

/// The full set of kanban capabilities. An actor holding all of them edits
/// kanban boards with no semantic restriction (equivalent to the legacy editor
/// role), so the semantic diff can be skipped entirely for them.
const KANBAN_CAPABILITIES: [Capability; 7] = [
    Capability::KanbanCardCreate,
    Capability::KanbanCardEditContent,
    Capability::KanbanCardMove,
    Capability::KanbanCardComment,
    Capability::KanbanCardDelete,
    Capability::KanbanCardArchive,
    Capability::KanbanColumnManage,
];

/// Semantically enforces fine-grained kanban capabilities for a `.kanban`
/// durable write. The caller has already passed the baseline `file.write`
/// check; this narrows that to the specific kanban actions the diff between the
/// prior and new board content requires.
///
/// Actors holding every kanban capability (including owners and server admins,
/// who hold all capabilities) bypass diffing. For partially-capable actors, the
/// prior and new content are classified through `collab_core::kanban`; if any
/// required capability is absent the write is rejected. An unparseable new board
/// is rejected for partially-capable actors so malformed JSON cannot smuggle
/// changes past the classifier.
fn enforce_kanban_write(
    access: &EffectiveAccess,
    old_content: Option<&[u8]>,
    new_content: &[u8],
    request_id: &str,
) -> Result<(), ApiFailure> {
    if KANBAN_CAPABILITIES
        .iter()
        .all(|capability| access.has(*capability))
    {
        return Ok(());
    }

    let new_board = collab_core::kanban::Board::parse(new_content)
        .map_err(|_| ApiFailure::vault_permission_denied(request_id.to_owned()))?;
    let old_board = old_content
        .and_then(|bytes| collab_core::kanban::Board::parse(bytes).ok())
        .unwrap_or_else(collab_core::kanban::Board::empty);

    for required in collab_core::kanban::classify_changes(&old_board, &new_board) {
        let capability = Capability::from_token(required.as_token())
            .expect("kanban capability tokens map to a Capability");
        if !access.has(capability) {
            return Err(ApiFailure::vault_permission_denied(request_id.to_owned()));
        }
    }

    Ok(())
}

/// The capability required to apply (or preview) a non-purge structural
/// operation. Purge is handled separately as an admin-only action.
fn structural_operation_capability(operation_type: HostedStructuralOperationType) -> Capability {
    match operation_type {
        HostedStructuralOperationType::Rename | HostedStructuralOperationType::Move => {
            Capability::FileMove
        }
        HostedStructuralOperationType::Trash | HostedStructuralOperationType::Restore => {
            Capability::FileDelete
        }
        // Purge authorizes as admin and never reaches this mapping.
        HostedStructuralOperationType::Purge => Capability::FileDelete,
    }
}

/// Resolves access and enforces that the user holds a specific capability.
async fn require_capability(
    pool: &PgPool,
    vault_id: Uuid,
    user_id: Uuid,
    capability: Capability,
    request_id: &str,
) -> Result<EffectiveAccess, ApiFailure> {
    let access = resolve_vault_capabilities(pool, vault_id, user_id, request_id).await?;
    if !access.has(capability) {
        return Err(ApiFailure::vault_permission_denied(request_id.to_owned()));
    }
    Ok(access)
}

async fn require_vault_access(
    pool: &PgPool,
    vault_id: Uuid,
    user_id: Uuid,
    minimum_role: HostedVaultRole,
    request_id: &str,
) -> Result<VaultAccess, ApiFailure> {
    // Map the legacy minimum role onto a representative capability so existing
    // call sites authorize through the same resolver as fine-grained checks.
    let required = match minimum_role {
        HostedVaultRole::Viewer => Capability::VaultRead,
        HostedVaultRole::Editor => Capability::FileWrite,
        HostedVaultRole::Admin => Capability::VaultManageMembers,
    };
    let access = require_capability(pool, vault_id, user_id, required, request_id).await?;
    Ok(VaultAccess {
        owner: access.owner,
        status: access.status,
    })
}

/// Like `require_capability` but also rejects archived/pending-delete vaults,
/// for mutating endpoints. Mirrors `require_active_vault_role`.
async fn require_active_capability(
    pool: &PgPool,
    vault_id: Uuid,
    user: &ServerUser,
    capability: Capability,
    request_id: &str,
) -> Result<EffectiveAccess, ApiFailure> {
    let access =
        require_capability(pool, vault_id, user_uuid(user), capability, request_id).await?;
    if access.status != HostedVaultStatus::Active {
        return Err(ApiFailure::vault_archived(request_id.to_owned()));
    }
    Ok(access)
}

async fn require_active_vault_admin(
    pool: &PgPool,
    vault_id: Uuid,
    user: &ServerUser,
    request_id: &str,
) -> Result<VaultAccess, ApiFailure> {
    let access = require_vault_access(
        pool,
        vault_id,
        user_uuid(user),
        HostedVaultRole::Admin,
        request_id,
    )
    .await?;
    if access.status != HostedVaultStatus::Active {
        return Err(ApiFailure::vault_archived(request_id.to_owned()));
    }
    Ok(access)
}

async fn load_vault(
    pool: &PgPool,
    vault_id: Uuid,
    user_id: Uuid,
    request_id: &str,
) -> Result<HostedVault, ApiFailure> {
    // Resolve effective access first (handles owner, server admin, direct
    // membership, and group grants, and returns not_found when none apply).
    let access = resolve_vault_capabilities(pool, vault_id, user_id, request_id).await?;
    let row = sqlx::query(
        r#"
        SELECT v.id, v.name, v.owner_user_id, owner.display_name AS owner_display_name,
               v.status::text AS status, v.manifest_sequence, v.require_offline_copy,
               v.created_at, v.updated_at,
               (SELECT COUNT(*) FROM hosted_vault_memberships members WHERE members.vault_id = v.id) AS members,
               COALESCE((SELECT SUM(r.size_bytes) FROM hosted_file_revisions r WHERE r.vault_id = v.id), 0)::bigint AS storage_bytes
        FROM hosted_vaults v
        JOIN users owner ON owner.id = v.owner_user_id
        WHERE v.id = $1
        "#,
    )
    .bind(vault_id)
    .fetch_optional(pool)
    .await
    .map_err(|_| ApiFailure::server(request_id.to_owned()))?
    .ok_or_else(|| ApiFailure::not_found(request_id.to_owned()))?;
    let mut vault = vault_from_row_without_role(&row);
    vault.role = access.derived_role();
    vault.capabilities = access.capability_tokens();
    Ok(vault)
}

/// Builds a vault DTO from a row that does not select a membership `role`; the
/// caller is expected to overwrite `role` and `capabilities` from the resolver.
fn vault_from_row_without_role(row: &sqlx::postgres::PgRow) -> HostedVault {
    HostedVault {
        id: row.get::<Uuid, _>("id").to_string(),
        name: row.get("name"),
        owner_user_id: row.get::<Uuid, _>("owner_user_id").to_string(),
        owner_display_name: row.get("owner_display_name"),
        role: HostedVaultRole::Viewer,
        status: parse_vault_status(row.get::<String, _>("status").as_str()),
        manifest_sequence: row.get("manifest_sequence"),
        members: row.get("members"),
        storage_bytes: row.get::<i64, _>("storage_bytes").max(0) as u64,
        require_offline_copy: row.get("require_offline_copy"),
        created_at: row
            .get::<chrono::DateTime<chrono::Utc>, _>("created_at")
            .to_rfc3339(),
        updated_at: row
            .get::<chrono::DateTime<chrono::Utc>, _>("updated_at")
            .to_rfc3339(),
        capabilities: Vec::new(),
    }
}

fn vault_summary_from_row(row: &sqlx::postgres::PgRow) -> HostedVaultSummary {
    HostedVaultSummary {
        id: row.get::<Uuid, _>("id").to_string(),
        name: row.get("name"),
        owner_display_name: row.get("owner_display_name"),
        status: parse_vault_status(row.get::<String, _>("status").as_str()),
        members: row.get("members"),
        storage_bytes: row.get::<i64, _>("storage_bytes").max(0) as u64,
        require_offline_copy: row.get("require_offline_copy"),
        updated_at: row
            .get::<chrono::DateTime<chrono::Utc>, _>("updated_at")
            .to_rfc3339(),
        // Populated by the caller from the capability resolver.
        capabilities: Vec::new(),
    }
}

async fn load_vault_members(
    pool: &PgPool,
    vault_id: Uuid,
    request_id: &str,
) -> Result<Vec<HostedVaultMember>, ApiFailure> {
    let rows = sqlx::query(
        r#"
        SELECT u.id AS user_id, u.username, u.display_name, m.role::text AS role,
               v.owner_user_id = u.id AS owner, m.created_at,
               m.template_id, t.name AS template_name,
               m.capabilities AS explicit_caps, t.capabilities AS template_caps
        FROM hosted_vault_memberships m
        JOIN users u ON u.id = m.user_id
        JOIN hosted_vaults v ON v.id = m.vault_id
        LEFT JOIN permission_templates t ON t.id = m.template_id
        WHERE m.vault_id = $1
        ORDER BY owner DESC, u.display_name ASC
        "#,
    )
    .bind(vault_id)
    .fetch_all(pool)
    .await
    .map_err(|_| ApiFailure::server(request_id.to_owned()))?;
    Ok(rows.iter().map(vault_member_from_row).collect())
}

async fn load_vault_member(
    pool: &PgPool,
    vault_id: Uuid,
    user_id: Uuid,
    request_id: &str,
) -> Result<HostedVaultMember, ApiFailure> {
    let row = sqlx::query(
        r#"
        SELECT u.id AS user_id, u.username, u.display_name, m.role::text AS role,
               v.owner_user_id = u.id AS owner, m.created_at,
               m.template_id, t.name AS template_name,
               m.capabilities AS explicit_caps, t.capabilities AS template_caps
        FROM hosted_vault_memberships m
        JOIN users u ON u.id = m.user_id
        JOIN hosted_vaults v ON v.id = m.vault_id
        LEFT JOIN permission_templates t ON t.id = m.template_id
        WHERE m.vault_id = $1 AND m.user_id = $2
        "#,
    )
    .bind(vault_id)
    .bind(user_id)
    .fetch_optional(pool)
    .await
    .map_err(|_| ApiFailure::server(request_id.to_owned()))?
    .ok_or_else(|| ApiFailure::not_found(request_id.to_owned()))?;
    Ok(vault_member_from_row(&row))
}

fn vault_member_from_row(row: &sqlx::postgres::PgRow) -> HostedVaultMember {
    let owner: bool = row.get("owner");
    let role = parse_vault_role(row.get::<String, _>("role").as_str());
    let explicit_caps: Option<Vec<String>> = row.get("explicit_caps");
    let template_caps: Option<Vec<String>> = row.get("template_caps");
    let template_id = row
        .get::<Option<Uuid>, _>("template_id")
        .map(|id| id.to_string());
    let template_name: Option<String> = row.get("template_name");
    // The owner implicitly holds every capability; otherwise resolve the
    // membership-level effective set (explicit override, else template, else role
    // default). Group grants further restrict at runtime and are not surfaced
    // per-member here.
    let capabilities = if owner {
        Capability::ALL
            .into_iter()
            .map(|capability| capability.as_token().to_owned())
            .collect()
    } else {
        resolve_grant_tokens(explicit_caps.clone(), template_caps, Some(role))
    };
    HostedVaultMember {
        user_id: row.get::<Uuid, _>("user_id").to_string(),
        username: row.get("username"),
        display_name: row.get("display_name"),
        role,
        owner,
        created_at: row
            .get::<chrono::DateTime<chrono::Utc>, _>("created_at")
            .to_rfc3339(),
        capabilities,
        custom_capabilities: if owner { None } else { explicit_caps },
        template_id: if owner { None } else { template_id },
        template_name: if owner { None } else { template_name },
    }
}

async fn load_chat_messages(
    pool: &PgPool,
    vault_id: Uuid,
    limit: i64,
    request_id: &str,
) -> Result<Vec<HostedChatMessage>, ApiFailure> {
    let rows = sqlx::query(
        r#"
        SELECT m.id, m.content, m.created_at,
               u.id AS user_id, COALESCE(u.display_name, 'Deleted user') AS user_name
        FROM hosted_chat_messages m
        LEFT JOIN users u ON u.id = m.sender_user_id
        WHERE m.vault_id = $1
        ORDER BY m.created_at DESC, m.id DESC
        LIMIT $2
        "#,
    )
    .bind(vault_id)
    .bind(limit)
    .fetch_all(pool)
    .await
    .map_err(|_| ApiFailure::server(request_id.to_owned()))?;
    let mut messages = rows.iter().map(chat_message_from_row).collect::<Vec<_>>();
    messages.reverse();
    Ok(messages)
}

async fn load_presence(
    pool: &PgPool,
    vault_id: Uuid,
    request_id: &str,
) -> Result<Vec<HostedPresenceEntry>, ApiFailure> {
    let rows = sqlx::query(
        r#"
        SELECT p.active_file, p.cursor_line, p.chat_typing_until, p.app_version, p.updated_at,
               u.id AS user_id, u.display_name AS user_name
        FROM hosted_presence p
        JOIN users u ON u.id = p.user_id
        WHERE p.vault_id = $1
          AND u.status = 'active'
          AND p.updated_at >= NOW() - INTERVAL '30 seconds'
        ORDER BY p.updated_at DESC
        "#,
    )
    .bind(vault_id)
    .fetch_all(pool)
    .await
    .map_err(|_| ApiFailure::server(request_id.to_owned()))?;
    Ok(rows.iter().map(presence_from_row).collect())
}

fn presence_from_row(row: &sqlx::postgres::PgRow) -> HostedPresenceEntry {
    let user_id = row.get::<Uuid, _>("user_id").to_string();
    let last_seen = row
        .get::<chrono::DateTime<chrono::Utc>, _>("updated_at")
        .timestamp_millis()
        .max(0) as u64;
    HostedPresenceEntry {
        user_color: user_color_for_id(&user_id),
        user_id,
        user_name: row.get("user_name"),
        active_file: row.get("active_file"),
        cursor_line: row.get("cursor_line"),
        chat_typing_until: row
            .get::<Option<i64>, _>("chat_typing_until")
            .map(|value| value.max(0) as u64),
        last_seen,
        app_version: row.get("app_version"),
    }
}

async fn load_chat_message(
    pool: &PgPool,
    vault_id: Uuid,
    message_id: Uuid,
    request_id: &str,
) -> Result<HostedChatMessage, ApiFailure> {
    let row = sqlx::query(
        r#"
        SELECT m.id, m.content, m.created_at,
               u.id AS user_id, COALESCE(u.display_name, 'Deleted user') AS user_name
        FROM hosted_chat_messages m
        LEFT JOIN users u ON u.id = m.sender_user_id
        WHERE m.vault_id = $1 AND m.id = $2
        "#,
    )
    .bind(vault_id)
    .bind(message_id)
    .fetch_optional(pool)
    .await
    .map_err(|_| ApiFailure::server(request_id.to_owned()))?
    .ok_or_else(|| ApiFailure::not_found(request_id.to_owned()))?;
    Ok(chat_message_from_row(&row))
}

fn chat_message_from_row(row: &sqlx::postgres::PgRow) -> HostedChatMessage {
    let user_id = row
        .get::<Option<Uuid>, _>("user_id")
        .map(|id| id.to_string())
        .unwrap_or_else(|| "deleted-user".to_owned());
    let timestamp = row
        .get::<chrono::DateTime<chrono::Utc>, _>("created_at")
        .timestamp_millis()
        .max(0) as u64;
    HostedChatMessage {
        id: row.get::<Uuid, _>("id").to_string(),
        user_color: user_color_for_id(&user_id),
        user_id,
        user_name: row.get("user_name"),
        content: row.get("content"),
        timestamp,
    }
}

fn user_color_for_id(seed: &str) -> String {
    const COLORS: [&str; 8] = [
        "#ef4444", "#f97316", "#eab308", "#22c55e", "#14b8a6", "#3b82f6", "#8b5cf6", "#ec4899",
    ];
    let mut hash: i32 = 0;
    for codepoint in seed.chars().map(|value| value as i32) {
        hash = codepoint.wrapping_add((hash << 5).wrapping_sub(hash));
    }
    COLORS[(hash.unsigned_abs() as usize) % COLORS.len()].to_owned()
}

/// Validates and trims a group/template display name (1–128 characters).
fn validate_entity_name(value: &str, label: &str, request_id: &str) -> Result<String, ApiFailure> {
    let trimmed = value.trim();
    if trimmed.is_empty() || trimmed.chars().count() > 128 {
        return Err(ApiFailure::validation(
            format!("{label} must be between 1 and 128 characters."),
            request_id.to_owned(),
        ));
    }
    Ok(trimmed.to_owned())
}

/// Trims an optional free-text field, collapsing empty/whitespace-only input to
/// `None` so a cleared description stores SQL NULL.
fn normalize_optional_text(value: Option<String>) -> Option<String> {
    value
        .map(|text| text.trim().to_owned())
        .filter(|text| !text.is_empty())
}

/// Maps a unique-constraint violation to a friendly validation error and any
/// other database failure to a generic server error.
fn unique_violation_or_server(error: sqlx::Error, message: &str, request_id: &str) -> ApiFailure {
    if error
        .as_database_error()
        .and_then(|value| value.code())
        .as_deref()
        == Some("23505")
    {
        ApiFailure::validation(message.to_owned(), request_id.to_owned())
    } else {
        ApiFailure::server(request_id.to_owned())
    }
}

/// Validates that every token is a known capability and returns the canonical,
/// de-duplicated token list in canonical order.
fn validate_capability_tokens(
    tokens: &[String],
    request_id: &str,
) -> Result<Vec<String>, ApiFailure> {
    let mut set: HashSet<Capability> = HashSet::new();
    for token in tokens {
        let capability = Capability::from_token(token).ok_or_else(|| {
            ApiFailure::validation(
                format!("Unknown capability token: {token}"),
                request_id.to_owned(),
            )
        })?;
        set.insert(capability);
    }
    Ok(Capability::ALL
        .into_iter()
        .filter(|capability| set.contains(capability))
        .map(|capability| capability.as_token().to_owned())
        .collect())
}

fn parse_grant_subject_type(value: &str, request_id: &str) -> Result<GrantSubjectType, ApiFailure> {
    match value {
        "user" => Ok(GrantSubjectType::User),
        "group" => Ok(GrantSubjectType::Group),
        _ => Err(ApiFailure::validation(
            "Grant subject must be 'user' or 'group'.",
            request_id.to_owned(),
        )),
    }
}

fn grant_subject_target_type(subject: GrantSubjectType) -> &'static str {
    match subject {
        GrantSubjectType::User => "user",
        GrantSubjectType::Group => "group",
    }
}

/// Resolves a grant's effective capability tokens: explicit override wins, else
/// the template's capabilities, else (direct user memberships only) the role
/// default; group grants with neither resolve to an empty set.
fn resolve_grant_tokens(
    explicit: Option<Vec<String>>,
    template_caps: Option<Vec<String>>,
    role_fallback: Option<HostedVaultRole>,
) -> Vec<String> {
    let tokens = if let Some(tokens) = explicit {
        tokens
    } else if let Some(tokens) = template_caps {
        tokens
    } else if let Some(role) = role_fallback {
        return capabilities_for_role(role)
            .into_iter()
            .map(|capability| capability.as_token().to_owned())
            .collect();
    } else {
        Vec::new()
    };
    // Normalize to canonical order, dropping any unknown tokens defensively.
    let set = tokens_to_capabilities(&tokens);
    Capability::ALL
        .into_iter()
        .filter(|capability| set.contains(capability))
        .map(|capability| capability.as_token().to_owned())
        .collect()
}

async fn require_group_exists(
    pool: &PgPool,
    group_id: Uuid,
    request_id: &str,
) -> Result<(), ApiFailure> {
    let exists =
        sqlx::query_scalar::<_, bool>("SELECT EXISTS(SELECT 1 FROM user_groups WHERE id = $1)")
            .bind(group_id)
            .fetch_one(pool)
            .await
            .map_err(|_| ApiFailure::server(request_id.to_owned()))?;
    if !exists {
        return Err(ApiFailure::not_found(request_id.to_owned()));
    }
    Ok(())
}

async fn require_template_exists(
    pool: &PgPool,
    template_id: Uuid,
    request_id: &str,
) -> Result<(), ApiFailure> {
    let exists = sqlx::query_scalar::<_, bool>(
        "SELECT EXISTS(SELECT 1 FROM permission_templates WHERE id = $1)",
    )
    .bind(template_id)
    .fetch_one(pool)
    .await
    .map_err(|_| ApiFailure::server(request_id.to_owned()))?;
    if !exists {
        return Err(ApiFailure::validation(
            "The referenced template does not exist.",
            request_id.to_owned(),
        ));
    }
    Ok(())
}

/// Ensures a template exists and is not a read-only built-in before mutation.
async fn require_template_editable(
    pool: &PgPool,
    template_id: Uuid,
    request_id: &str,
) -> Result<(), ApiFailure> {
    let is_builtin =
        sqlx::query_scalar::<_, bool>("SELECT is_builtin FROM permission_templates WHERE id = $1")
            .bind(template_id)
            .fetch_optional(pool)
            .await
            .map_err(|_| ApiFailure::server(request_id.to_owned()))?
            .ok_or_else(|| ApiFailure::not_found(request_id.to_owned()))?;
    if is_builtin {
        return Err(ApiFailure::validation(
            "Built-in templates cannot be modified or deleted.",
            request_id.to_owned(),
        ));
    }
    Ok(())
}

fn group_from_row(row: &sqlx::postgres::PgRow) -> UserGroup {
    UserGroup {
        id: row.get::<Uuid, _>("id").to_string(),
        name: row.get("name"),
        description: row.get("description"),
        member_count: row.get("member_count"),
        created_at: row
            .get::<chrono::DateTime<chrono::Utc>, _>("created_at")
            .to_rfc3339(),
    }
}

async fn load_groups(pool: &PgPool, request_id: &str) -> Result<Vec<UserGroup>, ApiFailure> {
    let rows = sqlx::query(
        r#"
        SELECT g.id, g.name, g.description, g.created_at,
               (SELECT COUNT(*) FROM user_group_memberships m WHERE m.group_id = g.id) AS member_count
        FROM user_groups g
        ORDER BY g.name ASC
        "#,
    )
    .fetch_all(pool)
    .await
    .map_err(|_| ApiFailure::server(request_id.to_owned()))?;
    Ok(rows.iter().map(group_from_row).collect())
}

async fn load_group(
    pool: &PgPool,
    group_id: Uuid,
    request_id: &str,
) -> Result<UserGroup, ApiFailure> {
    let row = sqlx::query(
        r#"
        SELECT g.id, g.name, g.description, g.created_at,
               (SELECT COUNT(*) FROM user_group_memberships m WHERE m.group_id = g.id) AS member_count
        FROM user_groups g
        WHERE g.id = $1
        "#,
    )
    .bind(group_id)
    .fetch_optional(pool)
    .await
    .map_err(|_| ApiFailure::server(request_id.to_owned()))?
    .ok_or_else(|| ApiFailure::not_found(request_id.to_owned()))?;
    Ok(group_from_row(&row))
}

async fn load_group_members(
    pool: &PgPool,
    group_id: Uuid,
    request_id: &str,
) -> Result<Vec<UserGroupMember>, ApiFailure> {
    let rows = sqlx::query(
        r#"
        SELECT u.id AS user_id, u.username, u.display_name, m.added_at
        FROM user_group_memberships m
        JOIN users u ON u.id = m.user_id
        WHERE m.group_id = $1
        ORDER BY u.display_name ASC
        "#,
    )
    .bind(group_id)
    .fetch_all(pool)
    .await
    .map_err(|_| ApiFailure::server(request_id.to_owned()))?;
    Ok(rows
        .iter()
        .map(|row| UserGroupMember {
            user_id: row.get::<Uuid, _>("user_id").to_string(),
            username: row.get("username"),
            display_name: row.get("display_name"),
            added_at: row
                .get::<chrono::DateTime<chrono::Utc>, _>("added_at")
                .to_rfc3339(),
        })
        .collect())
}

fn template_from_row(row: &sqlx::postgres::PgRow) -> PermissionTemplate {
    PermissionTemplate {
        id: row.get::<Uuid, _>("id").to_string(),
        name: row.get("name"),
        description: row.get("description"),
        is_builtin: row.get("is_builtin"),
        capabilities: row.get("capabilities"),
        created_at: row
            .get::<chrono::DateTime<chrono::Utc>, _>("created_at")
            .to_rfc3339(),
        updated_at: row
            .get::<chrono::DateTime<chrono::Utc>, _>("updated_at")
            .to_rfc3339(),
    }
}

async fn load_templates(
    pool: &PgPool,
    request_id: &str,
) -> Result<Vec<PermissionTemplate>, ApiFailure> {
    let rows = sqlx::query(
        r#"
        SELECT id, name, description, is_builtin, capabilities, created_at, updated_at
        FROM permission_templates
        ORDER BY is_builtin DESC, name ASC
        "#,
    )
    .fetch_all(pool)
    .await
    .map_err(|_| ApiFailure::server(request_id.to_owned()))?;
    Ok(rows.iter().map(template_from_row).collect())
}

async fn load_template(
    pool: &PgPool,
    template_id: Uuid,
    request_id: &str,
) -> Result<PermissionTemplate, ApiFailure> {
    let row = sqlx::query(
        r#"
        SELECT id, name, description, is_builtin, capabilities, created_at, updated_at
        FROM permission_templates
        WHERE id = $1
        "#,
    )
    .bind(template_id)
    .fetch_optional(pool)
    .await
    .map_err(|_| ApiFailure::server(request_id.to_owned()))?
    .ok_or_else(|| ApiFailure::not_found(request_id.to_owned()))?;
    Ok(template_from_row(&row))
}

async fn load_vault_grants(
    pool: &PgPool,
    vault_id: Uuid,
    request_id: &str,
) -> Result<Vec<VaultGrant>, ApiFailure> {
    let member_rows = sqlx::query(
        r#"
        SELECT u.id AS subject_id, u.display_name AS subject_name, m.role::text AS role,
               m.template_id, t.name AS template_name,
               m.capabilities AS explicit_caps, t.capabilities AS template_caps,
               v.owner_user_id = u.id AS owner, m.created_at
        FROM hosted_vault_memberships m
        JOIN users u ON u.id = m.user_id
        JOIN hosted_vaults v ON v.id = m.vault_id
        LEFT JOIN permission_templates t ON t.id = m.template_id
        WHERE m.vault_id = $1
        ORDER BY owner DESC, u.display_name ASC
        "#,
    )
    .bind(vault_id)
    .fetch_all(pool)
    .await
    .map_err(|_| ApiFailure::server(request_id.to_owned()))?;
    let group_rows = sqlx::query(
        r#"
        SELECT gr.id AS subject_id, gr.name AS subject_name,
               g.template_id, t.name AS template_name,
               g.capabilities AS explicit_caps, t.capabilities AS template_caps,
               g.created_at
        FROM hosted_vault_group_grants g
        JOIN user_groups gr ON gr.id = g.group_id
        LEFT JOIN permission_templates t ON t.id = g.template_id
        WHERE g.vault_id = $1
        ORDER BY gr.name ASC
        "#,
    )
    .bind(vault_id)
    .fetch_all(pool)
    .await
    .map_err(|_| ApiFailure::server(request_id.to_owned()))?;

    let mut grants = Vec::with_capacity(member_rows.len() + group_rows.len());
    for row in &member_rows {
        let owner: bool = row.get("owner");
        // Owners implicitly hold every capability regardless of their stored row.
        let role_fallback = if owner {
            Some(HostedVaultRole::Admin)
        } else {
            Some(parse_vault_role(row.get::<String, _>("role").as_str()))
        };
        let capabilities = if owner {
            Capability::ALL
                .into_iter()
                .map(|capability| capability.as_token().to_owned())
                .collect()
        } else {
            resolve_grant_tokens(
                row.get("explicit_caps"),
                row.get("template_caps"),
                role_fallback,
            )
        };
        grants.push(VaultGrant {
            subject_type: GrantSubjectType::User,
            subject_id: row.get::<Uuid, _>("subject_id").to_string(),
            subject_name: row.get("subject_name"),
            template_id: row
                .get::<Option<Uuid>, _>("template_id")
                .map(|id| id.to_string()),
            template_name: row.get("template_name"),
            capabilities,
            created_at: row
                .get::<chrono::DateTime<chrono::Utc>, _>("created_at")
                .to_rfc3339(),
        });
    }
    for row in &group_rows {
        grants.push(VaultGrant {
            subject_type: GrantSubjectType::Group,
            subject_id: row.get::<Uuid, _>("subject_id").to_string(),
            subject_name: row.get("subject_name"),
            template_id: row
                .get::<Option<Uuid>, _>("template_id")
                .map(|id| id.to_string()),
            template_name: row.get("template_name"),
            capabilities: resolve_grant_tokens(
                row.get("explicit_caps"),
                row.get("template_caps"),
                None,
            ),
            created_at: row
                .get::<chrono::DateTime<chrono::Utc>, _>("created_at")
                .to_rfc3339(),
        });
    }
    Ok(grants)
}

async fn load_vault_grant(
    pool: &PgPool,
    vault_id: Uuid,
    subject: GrantSubjectType,
    subject_id: Uuid,
    request_id: &str,
) -> Result<VaultGrant, ApiFailure> {
    load_vault_grants(pool, vault_id, request_id)
        .await?
        .into_iter()
        .find(|grant| grant.subject_type == subject && grant.subject_id == subject_id.to_string())
        .ok_or_else(|| ApiFailure::not_found(request_id.to_owned()))
}

async fn vault_activity_event(
    transaction: &mut Transaction<'_, Postgres>,
    vault_id: Uuid,
    actor_user_id: Option<Uuid>,
    event_type: &str,
    target_type: Option<&str>,
    target_id: Option<&str>,
    metadata: Value,
    request_id: &str,
) -> Result<(), ApiFailure> {
    sqlx::query(
        "INSERT INTO hosted_vault_activity_events (id, vault_id, actor_user_id, event_type, target_type, target_id, metadata) VALUES ($1, $2, $3, $4, $5, $6, $7)",
    )
    .bind(Uuid::now_v7())
    .bind(vault_id)
    .bind(actor_user_id)
    .bind(event_type)
    .bind(target_type)
    .bind(target_id)
    .bind(metadata)
    .execute(&mut **transaction)
    .await
    .map_err(|_| ApiFailure::server(request_id.to_owned()))?;
    Ok(())
}

fn vault_activity_from_row(row: &sqlx::postgres::PgRow) -> HostedVaultActivityEvent {
    HostedVaultActivityEvent {
        id: row.get::<Uuid, _>("id").to_string(),
        actor_display_name: row.get("actor_display_name"),
        event_type: row.get("event_type"),
        target_type: row.get("target_type"),
        target_id: row.get("target_id"),
        created_at: row
            .get::<chrono::DateTime<chrono::Utc>, _>("created_at")
            .to_rfc3339(),
    }
}

fn file_kind_name(kind: HostedFileKind) -> &'static str {
    match kind {
        HostedFileKind::Folder => "folder",
        HostedFileKind::Document => "document",
        HostedFileKind::Asset => "asset",
    }
}

fn parse_file_kind(kind: &str) -> HostedFileKind {
    match kind {
        "folder" => HostedFileKind::Folder,
        "asset" => HostedFileKind::Asset,
        _ => HostedFileKind::Document,
    }
}

fn document_type_name(document_type: HostedDocumentType) -> &'static str {
    match document_type {
        HostedDocumentType::Note => "note",
        HostedDocumentType::Kanban => "kanban",
        HostedDocumentType::Canvas => "canvas",
    }
}

fn parse_document_type(document_type: Option<String>) -> Option<HostedDocumentType> {
    document_type.map(|value| match value.as_str() {
        "kanban" => HostedDocumentType::Kanban,
        "canvas" => HostedDocumentType::Canvas,
        _ => HostedDocumentType::Note,
    })
}

fn parse_file_state(state: &str) -> HostedFileState {
    match state {
        "trashed" => HostedFileState::Trashed,
        "tombstoned" => HostedFileState::Tombstoned,
        _ => HostedFileState::Active,
    }
}

fn structural_operation_name(operation: HostedStructuralOperationType) -> &'static str {
    match operation {
        HostedStructuralOperationType::Rename => "rename",
        HostedStructuralOperationType::Move => "move",
        HostedStructuralOperationType::Trash => "trash",
        HostedStructuralOperationType::Restore => "restore",
        HostedStructuralOperationType::Purge => "purge",
    }
}

fn parse_structural_operation(value: &str) -> HostedStructuralOperationType {
    match value {
        "move" => HostedStructuralOperationType::Move,
        "trash" => HostedStructuralOperationType::Trash,
        "restore" => HostedStructuralOperationType::Restore,
        "purge" => HostedStructuralOperationType::Purge,
        _ => HostedStructuralOperationType::Rename,
    }
}

fn structural_activity_name(operation: HostedStructuralOperationType) -> &'static str {
    match operation {
        HostedStructuralOperationType::Rename => "file.renamed",
        HostedStructuralOperationType::Move => "file.moved",
        HostedStructuralOperationType::Trash => "file.trashed",
        HostedStructuralOperationType::Restore => "file.restored",
        HostedStructuralOperationType::Purge => "file.purged",
    }
}

fn validate_structural_operation(
    manifest: &HostedVaultManifest,
    target: &HostedFileEntry,
    payload: &StructuralOperationRequest,
    request_id: &str,
) -> Result<Option<String>, ApiFailure> {
    if payload.base_manifest_sequence < 0 {
        return Err(ApiFailure::validation(
            "Base manifest sequence cannot be negative.",
            request_id.to_owned(),
        ));
    }
    match payload.operation_type {
        HostedStructuralOperationType::Rename | HostedStructuralOperationType::Move => {
            if target.state != HostedFileState::Active {
                return Err(ApiFailure::validation(
                    "Only active files can be renamed or moved.",
                    request_id.to_owned(),
                ));
            }
            let new_name = if payload.operation_type == HostedStructuralOperationType::Rename {
                payload.name.as_deref().ok_or_else(|| {
                    ApiFailure::validation("Rename requires a name.", request_id.to_owned())
                })?
            } else {
                &target.name
            };
            let (new_name, _) = collab_core::normalize_hosted_name(new_name).map_err(|error| {
                ApiFailure::path_invalid(error.to_string(), request_id.to_owned())
            })?;
            let parent_id = if payload.operation_type == HostedStructuralOperationType::Move {
                payload.parent_id
            } else {
                target
                    .parent_id
                    .as_deref()
                    .map(Uuid::parse_str)
                    .transpose()
                    .expect("stored file IDs are valid UUIDs")
            };
            let parent_path = if let Some(parent_id) = parent_id {
                let parent = manifest
                    .files
                    .iter()
                    .find(|file| file.id == parent_id.to_string())
                    .ok_or_else(|| ApiFailure::not_found(request_id.to_owned()))?;
                if parent.kind != HostedFileKind::Folder || parent.state != HostedFileState::Active
                {
                    return Err(ApiFailure::path_invalid(
                        "The destination must be an active folder.",
                        request_id.to_owned(),
                    ));
                }
                if parent.id == target.id
                    || parent
                        .relative_path
                        .starts_with(&format!("{}/", target.relative_path))
                {
                    return Err(ApiFailure::path_invalid(
                        "A folder cannot be moved inside itself.",
                        request_id.to_owned(),
                    ));
                }
                parent.relative_path.as_str()
            } else {
                ""
            };
            let new_prefix = if parent_path.is_empty() {
                new_name
            } else {
                format!("{parent_path}/{new_name}")
            };
            collab_core::normalize_hosted_path(&new_prefix).map_err(|error| {
                ApiFailure::path_invalid(error.to_string(), request_id.to_owned())
            })?;
            for child in manifest.files.iter().filter(|file| {
                file.relative_path
                    .starts_with(&format!("{}/", target.relative_path))
            }) {
                let suffix = child
                    .relative_path
                    .strip_prefix(&target.relative_path)
                    .expect("prefix was checked");
                collab_core::normalize_hosted_path(&format!("{new_prefix}{suffix}")).map_err(
                    |error| ApiFailure::path_invalid(error.to_string(), request_id.to_owned()),
                )?;
            }
            return Ok(Some(new_prefix));
        }
        HostedStructuralOperationType::Trash if target.state != HostedFileState::Active => {
            return Err(ApiFailure::validation(
                "Only active files can be trashed.",
                request_id.to_owned(),
            ));
        }
        HostedStructuralOperationType::Restore | HostedStructuralOperationType::Purge
            if target.state != HostedFileState::Trashed =>
        {
            return Err(ApiFailure::validation(
                "Only trashed files can be restored or purged.",
                request_id.to_owned(),
            ));
        }
        _ => {}
    }
    Ok(None)
}

async fn load_structural_operation(
    pool: &PgPool,
    vault_id: Uuid,
    client_operation_id: Uuid,
    already_applied: bool,
    request_id: &str,
) -> Result<Option<HostedStructuralOperationResult>, ApiFailure> {
    let row = sqlx::query(
        "SELECT id, client_operation_id, operation_type, result_manifest_sequence, payload->>'targetFileId' AS target_file_id, payload->'rewrittenDocumentIds' AS rewritten_document_ids FROM hosted_structural_operations WHERE vault_id = $1 AND client_operation_id = $2",
    )
    .bind(vault_id)
    .bind(client_operation_id)
    .fetch_optional(pool)
    .await
    .map_err(|_| ApiFailure::server(request_id.to_owned()))?;
    Ok(row.map(|row| HostedStructuralOperationResult {
        operation_id: row.get::<Uuid, _>("id").to_string(),
        client_operation_id: row.get::<Uuid, _>("client_operation_id").to_string(),
        operation_type: parse_structural_operation(row.get::<String, _>("operation_type").as_str()),
        target_file_id: row.get("target_file_id"),
        result_manifest_sequence: row.get("result_manifest_sequence"),
        already_applied,
        rewritten_document_ids: row
            .get::<Option<Value>, _>("rewritten_document_ids")
            .and_then(|value| serde_json::from_value(value).ok())
            .unwrap_or_default(),
    }))
}

async fn update_subtree_state(
    transaction: &mut Transaction<'_, Postgres>,
    vault_id: Uuid,
    target_file_id: Uuid,
    state: &str,
    request_id: &str,
) -> Result<(), ApiFailure> {
    sqlx::query(
        r#"
        WITH RECURSIVE affected AS (
          SELECT id FROM hosted_file_entries WHERE vault_id = $1 AND id = $2
          UNION ALL
          SELECT child.id FROM hosted_file_entries child
          JOIN affected parent ON child.parent_id = parent.id
          WHERE child.vault_id = $1
        )
        UPDATE hosted_file_entries SET state = $3::hosted_file_state, updated_at = NOW()
        WHERE id IN (SELECT id FROM affected)
        "#,
    )
    .bind(vault_id)
    .bind(target_file_id)
    .bind(state)
    .execute(&mut **transaction)
    .await
    .map_err(|error| map_path_database_error(error, request_id.to_owned()))?;
    Ok(())
}

async fn delete_subtree_trash_records(
    transaction: &mut Transaction<'_, Postgres>,
    vault_id: Uuid,
    target_file_id: Uuid,
    request_id: &str,
) -> Result<(), ApiFailure> {
    sqlx::query(
        r#"
        WITH RECURSIVE affected AS (
          SELECT id FROM hosted_file_entries WHERE vault_id = $1 AND id = $2
          UNION ALL
          SELECT child.id FROM hosted_file_entries child
          JOIN affected parent ON child.parent_id = parent.id
          WHERE child.vault_id = $1
        )
        DELETE FROM hosted_trash_records WHERE file_id IN (SELECT id FROM affected)
        "#,
    )
    .bind(vault_id)
    .bind(target_file_id)
    .execute(&mut **transaction)
    .await
    .map_err(|_| ApiFailure::server(request_id.to_owned()))?;
    Ok(())
}

fn validate_file_kind(
    kind: HostedFileKind,
    document_type: Option<HostedDocumentType>,
    content: &str,
    request_id: &str,
) -> Result<(), ApiFailure> {
    match kind {
        HostedFileKind::Folder if document_type.is_none() && content.is_empty() => Ok(()),
        HostedFileKind::Document if document_type.is_some() => Ok(()),
        HostedFileKind::Asset => Err(ApiFailure::validation(
            "Binary assets must use the upload API.",
            request_id.to_owned(),
        )),
        _ => Err(ApiFailure::validation(
            "Folders cannot have document content, and documents require a document type.",
            request_id.to_owned(),
        )),
    }
}

async fn validate_parent_folder(
    pool: &PgPool,
    vault_id: Uuid,
    parent_id: Option<Uuid>,
    request_id: &str,
) -> Result<String, ApiFailure> {
    let Some(parent_id) = parent_id else {
        return Ok(String::new());
    };
    let manifest = load_vault_manifest(pool, vault_id, request_id).await?;
    let parent = manifest
        .files
        .into_iter()
        .find(|file| file.id == parent_id.to_string())
        .ok_or_else(|| ApiFailure::not_found(request_id.to_owned()))?;
    if parent.kind != HostedFileKind::Folder || parent.state != HostedFileState::Active {
        return Err(ApiFailure::path_invalid(
            "The parent must be an active folder.",
            request_id.to_owned(),
        ));
    }
    Ok(parent.relative_path)
}

async fn lock_active_vault(
    transaction: &mut Transaction<'_, Postgres>,
    vault_id: Uuid,
    request_id: &str,
) -> Result<i64, ApiFailure> {
    let row = sqlx::query(
        "SELECT status::text AS status, manifest_sequence FROM hosted_vaults WHERE id = $1 FOR UPDATE",
    )
    .bind(vault_id)
    .fetch_optional(&mut **transaction)
    .await
    .map_err(|_| ApiFailure::server(request_id.to_owned()))?
    .ok_or_else(|| ApiFailure::not_found(request_id.to_owned()))?;
    if row.get::<String, _>("status") != "active" {
        return Err(ApiFailure::vault_archived(request_id.to_owned()));
    }
    Ok(row.get("manifest_sequence"))
}

async fn increment_manifest(
    transaction: &mut Transaction<'_, Postgres>,
    vault_id: Uuid,
    request_id: &str,
) -> Result<i64, ApiFailure> {
    sqlx::query_scalar(
        "UPDATE hosted_vaults SET manifest_sequence = manifest_sequence + 1, updated_at = NOW() WHERE id = $1 RETURNING manifest_sequence",
    )
    .bind(vault_id)
    .fetch_one(&mut **transaction)
    .await
    .map_err(|_| ApiFailure::server(request_id.to_owned()))
}

async fn mark_manifest_file_changed(
    transaction: &mut Transaction<'_, Postgres>,
    vault_id: Uuid,
    file_id: Uuid,
    manifest_sequence: i64,
    request_id: &str,
) -> Result<(), ApiFailure> {
    sqlx::query(
        "UPDATE hosted_file_entries SET manifest_sequence = $1 WHERE vault_id = $2 AND id = $3",
    )
    .bind(manifest_sequence)
    .bind(vault_id)
    .bind(file_id)
    .execute(&mut **transaction)
    .await
    .map_err(|_| ApiFailure::server(request_id.to_owned()))?;
    Ok(())
}

async fn mark_manifest_files_changed(
    transaction: &mut Transaction<'_, Postgres>,
    vault_id: Uuid,
    file_ids: &[Uuid],
    manifest_sequence: i64,
    request_id: &str,
) -> Result<(), ApiFailure> {
    if file_ids.is_empty() {
        return Ok(());
    }
    sqlx::query(
        "UPDATE hosted_file_entries SET manifest_sequence = $1 WHERE vault_id = $2 AND id = ANY($3)",
    )
    .bind(manifest_sequence)
    .bind(vault_id)
    .bind(file_ids)
    .execute(&mut **transaction)
    .await
    .map_err(|_| ApiFailure::server(request_id.to_owned()))?;
    Ok(())
}

async fn mark_manifest_subtree_changed(
    transaction: &mut Transaction<'_, Postgres>,
    vault_id: Uuid,
    root_file_id: Uuid,
    manifest_sequence: i64,
    request_id: &str,
) -> Result<(), ApiFailure> {
    sqlx::query(
        r#"
        WITH RECURSIVE affected AS (
          SELECT id FROM hosted_file_entries WHERE vault_id = $1 AND id = $2
          UNION ALL
          SELECT child.id
          FROM hosted_file_entries child
          JOIN affected parent ON child.parent_id = parent.id
          WHERE child.vault_id = $1
        )
        UPDATE hosted_file_entries
        SET manifest_sequence = $3
        WHERE vault_id = $1 AND id IN (SELECT id FROM affected)
        "#,
    )
    .bind(vault_id)
    .bind(root_file_id)
    .bind(manifest_sequence)
    .execute(&mut **transaction)
    .await
    .map_err(|_| ApiFailure::server(request_id.to_owned()))?;
    Ok(())
}

async fn insert_blob_record(
    transaction: &mut Transaction<'_, Postgres>,
    digest: &str,
    size: usize,
    media_type: &str,
    request_id: &str,
) -> Result<(), ApiFailure> {
    sqlx::query(
        "INSERT INTO hosted_blobs (digest, size_bytes, media_type, storage_key) VALUES ($1, $2, $3, $1) ON CONFLICT (digest) DO NOTHING",
    )
    .bind(digest)
    .bind(size as i64)
    .bind(media_type)
    .execute(&mut **transaction)
    .await
    .map_err(|_| ApiFailure::server(request_id.to_owned()))?;
    Ok(())
}

/// Total deduplicated stored content across the server, measured as the sum of
/// unique blob sizes. This is the metric the storage quota is enforced against.
async fn stored_content_bytes(db: &PgPool) -> Result<u64, sqlx::Error> {
    let bytes: i64 =
        sqlx::query_scalar("SELECT COALESCE(SUM(size_bytes), 0)::bigint FROM hosted_blobs")
            .fetch_one(db)
            .await?;
    Ok(bytes.max(0) as u64)
}

/// Rejects content-growing operations that would push the server's deduplicated
/// stored content past the configured storage quota. `quota_bytes == 0` disables
/// the quota. `incoming` is the set of `(digest, size)` pairs the operation would
/// add; digests already stored (or duplicated within `incoming`) add nothing,
/// matching content-addressed blob deduplication so re-uploading existing content
/// is never falsely rejected.
async fn enforce_storage_quota(
    db: &PgPool,
    quota_bytes: u64,
    incoming: &[(String, usize)],
    request_id: &str,
) -> Result<(), ApiFailure> {
    if quota_bytes == 0 || incoming.is_empty() {
        return Ok(());
    }
    let digests: Vec<String> = incoming.iter().map(|(digest, _)| digest.clone()).collect();
    let existing: Vec<String> =
        sqlx::query_scalar("SELECT digest FROM hosted_blobs WHERE digest = ANY($1)")
            .bind(&digests)
            .fetch_all(db)
            .await
            .map_err(|_| ApiFailure::server(request_id.to_owned()))?;
    let existing: HashSet<String> = existing.into_iter().collect();
    let added = quota_added_bytes(incoming, &existing);
    if added == 0 {
        return Ok(());
    }
    let current = stored_content_bytes(db)
        .await
        .map_err(|_| ApiFailure::server(request_id.to_owned()))?;
    if quota_would_exceed(current, added, quota_bytes) {
        return Err(ApiFailure::storage_quota_exceeded(request_id.to_owned()));
    }
    Ok(())
}

/// Bytes a content-addressed write would newly store: sums the size of each
/// incoming digest that is neither already stored (`existing`) nor a duplicate
/// of an earlier entry in `incoming`.
fn quota_added_bytes(incoming: &[(String, usize)], existing: &HashSet<String>) -> u64 {
    let mut counted: HashSet<&str> = existing.iter().map(String::as_str).collect();
    let mut added: u64 = 0;
    for (digest, size) in incoming {
        if counted.insert(digest.as_str()) {
            added = added.saturating_add(*size as u64);
        }
    }
    added
}

/// Whether storing `added` more bytes over the current `current` total would
/// cross `quota`. A `quota` of `0` means unlimited.
fn quota_would_exceed(current: u64, added: u64, quota: u64) -> bool {
    quota > 0 && current.saturating_add(added) > quota
}

fn map_path_database_error(error: sqlx::Error, request_id: String) -> ApiFailure {
    if error
        .as_database_error()
        .and_then(|value| value.code())
        .as_deref()
        == Some("23505")
    {
        ApiFailure::new(
            StatusCode::CONFLICT,
            ErrorCode::PathConflict,
            "A file with that name already exists in the folder.",
            request_id,
        )
    } else {
        ApiFailure::server(request_id)
    }
}

async fn load_vault_manifest(
    pool: &PgPool,
    vault_id: Uuid,
    request_id: &str,
) -> Result<HostedVaultManifest, ApiFailure> {
    let sequence =
        sqlx::query_scalar::<_, i64>("SELECT manifest_sequence FROM hosted_vaults WHERE id = $1")
            .bind(vault_id)
            .fetch_optional(pool)
            .await
            .map_err(|_| ApiFailure::server(request_id.to_owned()))?
            .ok_or_else(|| ApiFailure::not_found(request_id.to_owned()))?;
    let rows = sqlx::query(
        r#"
        SELECT f.id, f.parent_id, f.name, f.kind::text AS kind,
               f.document_type::text AS document_type, f.state::text AS state,
               f.created_at, f.updated_at,
               trash.trashed_at, trasher.display_name AS trashed_by_display_name,
               r.id AS revision_id, r.sequence AS revision_sequence,
               r.content_hash, r.size_bytes, r.created_at AS revision_created_at,
               creator.display_name AS revision_creator_display_name
        FROM hosted_file_entries f
        LEFT JOIN hosted_file_revisions r ON r.id = f.current_revision_id
        LEFT JOIN users creator ON creator.id = r.created_by
        LEFT JOIN hosted_trash_records trash ON trash.file_id = f.id
        LEFT JOIN users trasher ON trasher.id = trash.trashed_by
        WHERE f.vault_id = $1
        ORDER BY f.created_at ASC
        "#,
    )
    .bind(vault_id)
    .fetch_all(pool)
    .await
    .map_err(|_| ApiFailure::server(request_id.to_owned()))?;
    let paths = rows
        .iter()
        .map(|row| {
            (
                row.get::<Uuid, _>("id"),
                (
                    row.get::<Option<Uuid>, _>("parent_id"),
                    row.get::<String, _>("name"),
                ),
            )
        })
        .collect::<HashMap<_, _>>();
    let files = rows
        .iter()
        .map(|row| file_entry_from_row(row, &paths))
        .collect::<Result<Vec<_>, _>>()
        .map_err(|_| ApiFailure::server(request_id.to_owned()))?;
    Ok(HostedVaultManifest {
        vault_id: vault_id.to_string(),
        sequence,
        files,
    })
}

async fn load_vault_manifest_delta(
    pool: &PgPool,
    vault_id: Uuid,
    since: i64,
    request_id: &str,
) -> Result<HostedVaultManifestDelta, ApiFailure> {
    let sequence =
        sqlx::query_scalar::<_, i64>("SELECT manifest_sequence FROM hosted_vaults WHERE id = $1")
            .bind(vault_id)
            .fetch_optional(pool)
            .await
            .map_err(|_| ApiFailure::server(request_id.to_owned()))?
            .ok_or_else(|| ApiFailure::not_found(request_id.to_owned()))?;
    let rows = sqlx::query(
        r#"
        WITH RECURSIVE changed AS (
          SELECT id
          FROM hosted_file_entries
          WHERE vault_id = $1 AND manifest_sequence > $2
        ),
        ancestors AS (
          SELECT f.id AS target_id, f.id, f.parent_id, f.name, 0 AS depth
          FROM hosted_file_entries f
          JOIN changed c ON c.id = f.id
          WHERE f.vault_id = $1
          UNION ALL
          SELECT child.target_id, parent.id, parent.parent_id, parent.name, child.depth + 1
          FROM hosted_file_entries parent
          JOIN ancestors child ON child.parent_id = parent.id
          WHERE parent.vault_id = $1
        ),
        paths AS (
          SELECT target_id, string_agg(name, '/' ORDER BY depth DESC) AS relative_path
          FROM ancestors
          GROUP BY target_id
        )
        SELECT f.id, f.parent_id, f.name, f.kind::text AS kind,
               f.document_type::text AS document_type, f.state::text AS state,
               f.created_at, f.updated_at, paths.relative_path,
               trash.trashed_at, trasher.display_name AS trashed_by_display_name,
               r.id AS revision_id, r.sequence AS revision_sequence,
               r.content_hash, r.size_bytes, r.created_at AS revision_created_at,
               creator.display_name AS revision_creator_display_name
        FROM hosted_file_entries f
        JOIN changed c ON c.id = f.id
        JOIN paths ON paths.target_id = f.id
        LEFT JOIN hosted_file_revisions r ON r.id = f.current_revision_id
        LEFT JOIN users creator ON creator.id = r.created_by
        LEFT JOIN hosted_trash_records trash ON trash.file_id = f.id
        LEFT JOIN users trasher ON trasher.id = trash.trashed_by
        WHERE f.vault_id = $1
        ORDER BY f.created_at ASC
        "#,
    )
    .bind(vault_id)
    .bind(since)
    .fetch_all(pool)
    .await
    .map_err(|_| ApiFailure::server(request_id.to_owned()))?;
    let changed_files = rows
        .iter()
        .map(file_entry_from_single_row)
        .collect();
    Ok(HostedVaultManifestDelta {
        vault_id: vault_id.to_string(),
        base_sequence: since,
        sequence,
        changed_files,
    })
}

fn file_entry_from_row(
    row: &sqlx::postgres::PgRow,
    paths: &HashMap<Uuid, (Option<Uuid>, String)>,
) -> Result<HostedFileEntry, ()> {
    let id: Uuid = row.get("id");
    let mut current = Some(id);
    let mut names = Vec::new();
    for _ in 0..=paths.len() {
        let Some(file_id) = current else {
            names.reverse();
            return Ok(HostedFileEntry {
                id: id.to_string(),
                parent_id: row
                    .get::<Option<Uuid>, _>("parent_id")
                    .map(|value| value.to_string()),
                name: row.get("name"),
                relative_path: names.join("/"),
                kind: parse_file_kind(row.get::<String, _>("kind").as_str()),
                document_type: parse_document_type(row.get("document_type")),
                state: parse_file_state(row.get::<String, _>("state").as_str()),
                current_revision: revision_from_current_row(row),
                trashed_by_display_name: row.get("trashed_by_display_name"),
                trashed_at: row
                    .get::<Option<chrono::DateTime<chrono::Utc>>, _>("trashed_at")
                    .map(|value| value.to_rfc3339()),
                created_at: row
                    .get::<chrono::DateTime<chrono::Utc>, _>("created_at")
                    .to_rfc3339(),
                updated_at: row
                    .get::<chrono::DateTime<chrono::Utc>, _>("updated_at")
                    .to_rfc3339(),
            });
        };
        let (parent_id, name) = paths.get(&file_id).ok_or(())?;
        names.push(name.clone());
        current = *parent_id;
    }
    Err(())
}

fn revision_from_current_row(row: &sqlx::postgres::PgRow) -> Option<HostedFileRevision> {
    Some(HostedFileRevision {
        id: row.get::<Option<Uuid>, _>("revision_id")?.to_string(),
        sequence: row.get("revision_sequence"),
        content_hash: row.get("content_hash"),
        size_bytes: row.get::<i64, _>("size_bytes").max(0) as u64,
        created_by_display_name: row.get("revision_creator_display_name"),
        created_at: row
            .get::<chrono::DateTime<chrono::Utc>, _>("revision_created_at")
            .to_rfc3339(),
    })
}

fn file_entry_from_single_row(row: &sqlx::postgres::PgRow) -> HostedFileEntry {
    HostedFileEntry {
        id: row.get::<Uuid, _>("id").to_string(),
        parent_id: row
            .get::<Option<Uuid>, _>("parent_id")
            .map(|value| value.to_string()),
        name: row.get("name"),
        relative_path: row.get("relative_path"),
        kind: parse_file_kind(row.get::<String, _>("kind").as_str()),
        document_type: parse_document_type(row.get("document_type")),
        state: parse_file_state(row.get::<String, _>("state").as_str()),
        current_revision: revision_from_current_row(row),
        trashed_by_display_name: row.get("trashed_by_display_name"),
        trashed_at: row
            .get::<Option<chrono::DateTime<chrono::Utc>>, _>("trashed_at")
            .map(|value| value.to_rfc3339()),
        created_at: row
            .get::<chrono::DateTime<chrono::Utc>, _>("created_at")
            .to_rfc3339(),
        updated_at: row
            .get::<chrono::DateTime<chrono::Utc>, _>("updated_at")
            .to_rfc3339(),
    }
}

async fn load_vault_file_entry(
    pool: &PgPool,
    vault_id: Uuid,
    file_id: Uuid,
    request_id: &str,
) -> Result<HostedFileEntry, ApiFailure> {
    let row = sqlx::query(
        r#"
        WITH RECURSIVE ancestors AS (
          SELECT f.id, f.parent_id, f.name, 0 AS depth
          FROM hosted_file_entries f
          WHERE f.vault_id = $1 AND f.id = $2
          UNION ALL
          SELECT parent.id, parent.parent_id, parent.name, child.depth + 1
          FROM hosted_file_entries parent
          JOIN ancestors child ON child.parent_id = parent.id
          WHERE parent.vault_id = $1
        )
        SELECT f.id, f.parent_id, f.name, f.kind::text AS kind,
               f.document_type::text AS document_type, f.state::text AS state,
               f.created_at, f.updated_at,
               (
                 SELECT string_agg(name, '/' ORDER BY depth DESC)
                 FROM ancestors
               ) AS relative_path,
               trash.trashed_at, trasher.display_name AS trashed_by_display_name,
               r.id AS revision_id, r.sequence AS revision_sequence,
               r.content_hash, r.size_bytes, r.created_at AS revision_created_at,
               creator.display_name AS revision_creator_display_name
        FROM hosted_file_entries f
        LEFT JOIN hosted_file_revisions r ON r.id = f.current_revision_id
        LEFT JOIN users creator ON creator.id = r.created_by
        LEFT JOIN hosted_trash_records trash ON trash.file_id = f.id
        LEFT JOIN users trasher ON trasher.id = trash.trashed_by
        WHERE f.vault_id = $1 AND f.id = $2
        "#,
    )
    .bind(vault_id)
    .bind(file_id)
    .fetch_optional(pool)
    .await
    .map_err(|_| ApiFailure::server(request_id.to_owned()))?
    .ok_or_else(|| ApiFailure::not_found(request_id.to_owned()))?;
    Ok(file_entry_from_single_row(&row))
}

async fn load_file_revisions(
    pool: &PgPool,
    vault_id: Uuid,
    file_id: Uuid,
    request_id: &str,
) -> Result<Vec<HostedFileRevision>, ApiFailure> {
    let rows = sqlx::query(
        r#"
        SELECT r.id, r.sequence, r.content_hash, r.size_bytes, r.created_at,
               creator.display_name AS created_by_display_name
        FROM hosted_file_revisions r
        LEFT JOIN users creator ON creator.id = r.created_by
        WHERE r.vault_id = $1 AND r.file_id = $2
        ORDER BY r.sequence DESC
        "#,
    )
    .bind(vault_id)
    .bind(file_id)
    .fetch_all(pool)
    .await
    .map_err(|_| ApiFailure::server(request_id.to_owned()))?;
    if rows.is_empty() {
        return Err(ApiFailure::not_found(request_id.to_owned()));
    }
    Ok(rows
        .iter()
        .map(|row| HostedFileRevision {
            id: row.get::<Uuid, _>("id").to_string(),
            sequence: row.get("sequence"),
            content_hash: row.get("content_hash"),
            size_bytes: row.get::<i64, _>("size_bytes").max(0) as u64,
            created_by_display_name: row.get("created_by_display_name"),
            created_at: row
                .get::<chrono::DateTime<chrono::Utc>, _>("created_at")
                .to_rfc3339(),
        })
        .collect())
}

fn normalize_snapshot_label(
    label: Option<String>,
    request_id: &str,
) -> Result<Option<String>, ApiFailure> {
    let label = label
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty());
    if label
        .as_ref()
        .is_some_and(|value| value.chars().count() > 200)
    {
        return Err(ApiFailure::validation(
            "Snapshot labels must be at most 200 characters.",
            request_id.to_owned(),
        ));
    }
    Ok(label)
}

fn revision_from_row(row: &sqlx::postgres::PgRow) -> HostedFileRevision {
    HostedFileRevision {
        id: row.get::<Uuid, _>("revision_id").to_string(),
        sequence: row.get("revision_sequence"),
        content_hash: row.get("content_hash"),
        size_bytes: row.get::<i64, _>("size_bytes").max(0) as u64,
        created_by_display_name: row.get("revision_creator_display_name"),
        created_at: row
            .get::<chrono::DateTime<chrono::Utc>, _>("revision_created_at")
            .to_rfc3339(),
    }
}

fn snapshot_from_row(row: &sqlx::postgres::PgRow) -> HostedSnapshot {
    HostedSnapshot {
        id: row.get::<Uuid, _>("snapshot_id").to_string(),
        label: row.get("label"),
        revision: revision_from_row(row),
        created_by_display_name: row.get("snapshot_creator_display_name"),
        created_at: row
            .get::<chrono::DateTime<chrono::Utc>, _>("snapshot_created_at")
            .to_rfc3339(),
    }
}

async fn load_file_snapshots(
    pool: &PgPool,
    vault_id: Uuid,
    file_id: Uuid,
    request_id: &str,
) -> Result<Vec<HostedSnapshot>, ApiFailure> {
    let rows = sqlx::query(
        r#"
        SELECT snapshot.id AS snapshot_id, snapshot.label,
               snapshot.created_at AS snapshot_created_at,
               snapshot_creator.display_name AS snapshot_creator_display_name,
               revision.id AS revision_id, revision.sequence AS revision_sequence,
               revision.content_hash, revision.size_bytes,
               revision.created_at AS revision_created_at,
               revision_creator.display_name AS revision_creator_display_name
        FROM hosted_snapshots snapshot
        JOIN hosted_file_revisions revision ON revision.id = snapshot.revision_id
        LEFT JOIN users snapshot_creator ON snapshot_creator.id = snapshot.created_by
        LEFT JOIN users revision_creator ON revision_creator.id = revision.created_by
        WHERE snapshot.vault_id = $1 AND snapshot.file_id = $2
        ORDER BY snapshot.created_at DESC
        "#,
    )
    .bind(vault_id)
    .bind(file_id)
    .fetch_all(pool)
    .await
    .map_err(|_| ApiFailure::server(request_id.to_owned()))?;
    Ok(rows.iter().map(snapshot_from_row).collect())
}

async fn load_file_snapshot(
    pool: &PgPool,
    vault_id: Uuid,
    file_id: Uuid,
    snapshot_id: Uuid,
    request_id: &str,
) -> Result<HostedSnapshot, ApiFailure> {
    let rows = load_file_snapshots(pool, vault_id, file_id, request_id).await?;
    rows.into_iter()
        .find(|snapshot| snapshot.id == snapshot_id.to_string())
        .ok_or_else(|| ApiFailure::not_found(request_id.to_owned()))
}

async fn load_blob_text(
    state: &AppState,
    digest: &str,
    request_id: &str,
) -> Result<String, ApiFailure> {
    let bytes = state
        .blobs
        .get(digest)
        .await
        .map_err(|_| ApiFailure::server(request_id.to_owned()))?
        .ok_or_else(|| ApiFailure::server(request_id.to_owned()))?;
    if collab_core::sha256_bytes(&bytes) != digest {
        return Err(ApiFailure::upload_hash_mismatch(request_id.to_owned()));
    }
    String::from_utf8(bytes).map_err(|_| ApiFailure::server(request_id.to_owned()))
}

async fn load_text_revision_content(
    state: &AppState,
    vault_id: Uuid,
    file_id: Uuid,
    revision_id: Uuid,
    request_id: &str,
) -> Result<HostedRevisionContent, ApiFailure> {
    let row = sqlx::query(
        r#"
        SELECT file.kind::text AS kind, revision.blob_digest,
               revision.id AS revision_id, revision.sequence AS revision_sequence,
               revision.content_hash, revision.size_bytes,
               revision.created_at AS revision_created_at,
               creator.display_name AS revision_creator_display_name
        FROM hosted_file_entries file
        JOIN hosted_file_revisions revision
          ON revision.vault_id = file.vault_id AND revision.file_id = file.id
        LEFT JOIN users creator ON creator.id = revision.created_by
        WHERE file.vault_id = $1 AND file.id = $2 AND revision.id = $3
        "#,
    )
    .bind(vault_id)
    .bind(file_id)
    .bind(revision_id)
    .fetch_optional(&state.database)
    .await
    .map_err(|_| ApiFailure::server(request_id.to_owned()))?
    .ok_or_else(|| ApiFailure::not_found(request_id.to_owned()))?;
    if row.get::<String, _>("kind") != "document" {
        return Err(ApiFailure::validation(
            "Only text revision content can be read through this endpoint.",
            request_id.to_owned(),
        ));
    }
    Ok(HostedRevisionContent {
        revision: revision_from_row(&row),
        content: load_blob_text(
            state,
            row.get::<String, _>("blob_digest").as_str(),
            request_id,
        )
        .await?,
    })
}

fn indexed_note_title(content: &str, filename: &str) -> String {
    if content.starts_with("---") {
        if let Some(end) = content[3..].find("---") {
            for line in content[3..end + 3].lines() {
                if let Some(title) = line.strip_prefix("title:") {
                    let title = title.trim().trim_matches(['"', '\'']);
                    if !title.is_empty() {
                        return title.to_owned();
                    }
                }
            }
        }
    }
    content
        .lines()
        .find_map(|line| line.strip_prefix("# ").map(str::trim))
        .filter(|title| !title.is_empty())
        .unwrap_or_else(|| filename.trim_end_matches(".md"))
        .to_owned()
}

fn indexed_note_tags(content: &str) -> Vec<String> {
    if !content.starts_with("---") {
        return Vec::new();
    }
    let Some(end) = content[3..].find("---") else {
        return Vec::new();
    };
    let mut tags = Vec::new();
    let mut in_tags = false;
    for line in content[3..end + 3].lines() {
        if let Some(value) = line.trim_start().strip_prefix("tags:") {
            let value = value.trim();
            if value.starts_with('[') {
                tags.extend(
                    value
                        .trim_matches(['[', ']'])
                        .split(',')
                        .map(|tag| tag.trim().trim_matches(['"', '\'']).to_owned())
                        .filter(|tag| !tag.is_empty()),
                );
            } else {
                in_tags = true;
            }
        } else if in_tags {
            if let Some(tag) = line.trim().strip_prefix("- ") {
                let tag = tag.trim().trim_matches(['"', '\'']);
                if !tag.is_empty() {
                    tags.push(tag.to_owned());
                }
            } else {
                break;
            }
        }
    }
    tags
}

fn search_excerpt(content: &str, query: &str, max_chars: usize) -> String {
    let lower_content = content.to_lowercase();
    let lower_query = query.to_lowercase();
    let match_char = lower_content
        .find(&lower_query)
        .map(|position| lower_content[..position].chars().count())
        .unwrap_or(0);
    let start_char = match_char.saturating_sub(max_chars / 3);
    let excerpt = content
        .chars()
        .skip(start_char)
        .take(max_chars)
        .collect::<String>();
    let excerpt = excerpt.split_whitespace().collect::<Vec<_>>().join(" ");
    if content.chars().skip(start_char).count() > max_chars {
        format!("{excerpt}...")
    } else {
        excerpt
    }
}

async fn ensure_hosted_note_index(
    state: &AppState,
    manifest: &HostedVaultManifest,
    request_id: &str,
) -> Result<(), ApiFailure> {
    let vault_id = Uuid::parse_str(&manifest.vault_id).expect("stored vault IDs are valid UUIDs");
    sqlx::query(
        r#"
        DELETE FROM hosted_note_index index_row
        WHERE index_row.vault_id = $1
          AND NOT EXISTS (
            SELECT 1 FROM hosted_file_entries file
            WHERE file.id = index_row.file_id
              AND file.vault_id = index_row.vault_id
              AND file.state = 'active'
              AND file.kind = 'document'
              AND file.document_type = 'note'
              AND file.current_revision_id = index_row.revision_id
          )
        "#,
    )
    .bind(vault_id)
    .execute(&state.database)
    .await
    .map_err(|_| ApiFailure::server(request_id.to_owned()))?;
    for file in manifest.files.iter().filter(|file| {
        file.state == HostedFileState::Active
            && file.kind == HostedFileKind::Document
            && file.document_type == Some(HostedDocumentType::Note)
    }) {
        let Some(revision) = file.current_revision.as_ref() else {
            continue;
        };
        let file_id = Uuid::parse_str(&file.id).expect("stored file IDs are valid UUIDs");
        let revision_id =
            Uuid::parse_str(&revision.id).expect("stored revision IDs are valid UUIDs");
        let indexed_revision = sqlx::query_scalar::<_, Uuid>(
            "SELECT revision_id FROM hosted_note_index WHERE file_id = $1",
        )
        .bind(file_id)
        .fetch_optional(&state.database)
        .await
        .map_err(|_| ApiFailure::server(request_id.to_owned()))?;
        if indexed_revision == Some(revision_id) {
            continue;
        }
        let content = load_blob_text(state, &revision.content_hash, request_id).await?;
        let title = indexed_note_title(&content, &file.name);
        let tags = indexed_note_tags(&content);
        let search_text = format!("{title} {} {content}", tags.join(" "));
        sqlx::query(
            r#"
            INSERT INTO hosted_note_index
              (file_id, vault_id, revision_id, title, content, tags, search_vector)
            VALUES ($1, $2, $3, $4, $5, $6, to_tsvector('simple', $7))
            ON CONFLICT (file_id) DO UPDATE SET
              revision_id = EXCLUDED.revision_id,
              title = EXCLUDED.title,
              content = EXCLUDED.content,
              tags = EXCLUDED.tags,
              search_vector = EXCLUDED.search_vector,
              indexed_at = NOW()
            "#,
        )
        .bind(file_id)
        .bind(vault_id)
        .bind(revision_id)
        .bind(title)
        .bind(content)
        .bind(tags)
        .bind(search_text)
        .execute(&state.database)
        .await
        .map_err(|_| ApiFailure::server(request_id.to_owned()))?;
    }
    Ok(())
}

fn parse_vault_zip(
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
        // Some Windows ZIP tools emit backslash path separators even though the
        // ZIP spec mandates forward slashes; treat them as separators so vaults
        // exported from a Windows client import cleanly.
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
        let comparison = path.to_lowercase();
        if !comparison_paths.insert(comparison) {
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
    let lower = path.to_ascii_lowercase();
    if lower.ends_with(".md") {
        (HostedFileKind::Document, Some(HostedDocumentType::Note))
    } else if lower.ends_with(".kanban") {
        (HostedFileKind::Document, Some(HostedDocumentType::Kanban))
    } else if lower.ends_with(".canvas") {
        (HostedFileKind::Document, Some(HostedDocumentType::Canvas))
    } else {
        (HostedFileKind::Asset, None)
    }
}

fn invitation_from_row(row: &sqlx::postgres::PgRow) -> Invitation {
    Invitation {
        id: row.get::<Uuid, _>("id").to_string(),
        username: row.get("username"),
        display_name: row.get("display_name"),
        role: if row.get::<String, _>("role") == "admin" {
            ServerUserRole::Admin
        } else {
            ServerUserRole::Member
        },
        created_at: row
            .get::<chrono::DateTime<chrono::Utc>, _>("created_at")
            .to_rfc3339(),
        expires_at: row
            .get::<chrono::DateTime<chrono::Utc>, _>("expires_at")
            .to_rfc3339(),
        accepted_at: row
            .get::<Option<chrono::DateTime<chrono::Utc>>, _>("accepted_at")
            .map(|value| value.to_rfc3339()),
        revoked_at: row
            .get::<Option<chrono::DateTime<chrono::Utc>>, _>("revoked_at")
            .map(|value| value.to_rfc3339()),
    }
}

async fn create_browser_session(
    state: &AppState,
    headers: &HeaderMap,
    user: ServerUser,
    request_id: &str,
) -> Result<Response, ApiFailure> {
    let token = generate_secret();
    let csrf = generate_secret();
    let session_id = Uuid::now_v7();
    let settings = load_effective_runtime_settings(&state.config);
    sqlx::query(
        r#"
        INSERT INTO sessions (id, user_id, token_hash, csrf_hash, user_agent, expires_at)
        VALUES ($1, $2, $3, $4, $5, NOW() + ($6 || ' hours')::interval)
        "#,
    )
    .bind(session_id)
    .bind(Uuid::parse_str(&user.id).expect("database UUID is valid"))
    .bind(hash_secret(&token))
    .bind(hash_secret(&csrf))
    .bind(
        headers
            .get(header::USER_AGENT)
            .and_then(|value| value.to_str().ok())
            .map(|value| value.chars().take(512).collect::<String>()),
    )
    .bind(settings.session_ttl_hours.to_string())
    .execute(&state.database)
    .await
    .map_err(|_| ApiFailure::server(request_id.to_owned()))?;

    let mut response = Json(DataResponse::new(BrowserSession {
        user,
        csrf_token: csrf.clone(),
    }))
    .into_response();
    append_cookie(
        &mut response,
        SESSION_COOKIE,
        &token,
        true,
        settings.browser_secure_cookies,
        settings.session_ttl_hours,
    );
    append_cookie(
        &mut response,
        CSRF_COOKIE,
        &csrf,
        false,
        settings.browser_secure_cookies,
        settings.session_ttl_hours,
    );
    Ok(response)
}

async fn require_native_user(
    state: &AppState,
    headers: &HeaderMap,
    request_id: &str,
) -> Result<AuthenticatedUser, ApiFailure> {
    let token = headers
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "))
        .ok_or_else(|| ApiFailure::authentication_required(request_id.to_owned()))?;
    authenticate_native_access_token(&state.database, token)
        .await
        .map_err(|_| ApiFailure::server(request_id.to_owned()))?
        .ok_or_else(|| ApiFailure::authentication_required(request_id.to_owned()))
}

async fn require_authenticated_user(
    state: &AppState,
    headers: &HeaderMap,
    request_id: &str,
) -> Result<AuthenticatedUser, ApiFailure> {
    if headers.contains_key(header::AUTHORIZATION) {
        require_native_user(state, headers, request_id).await
    } else {
        require_user(state, headers, request_id).await
    }
}

async fn require_any_user(
    state: &AppState,
    headers: &HeaderMap,
    request_id: &str,
) -> Result<AuthenticatedUser, ApiFailure> {
    if headers.contains_key(header::AUTHORIZATION) {
        require_native_user(state, headers, request_id).await
    } else {
        require_csrf(state, headers, request_id).await
    }
}

async fn require_user(
    state: &AppState,
    headers: &HeaderMap,
    request_id: &str,
) -> Result<AuthenticatedUser, ApiFailure> {
    let token = cookie(headers, SESSION_COOKIE)
        .ok_or_else(|| ApiFailure::authentication_required(request_id.to_owned()))?;
    authenticate_session(&state.database, token)
        .await
        .map_err(|_| ApiFailure::server(request_id.to_owned()))?
        .ok_or_else(|| ApiFailure::authentication_required(request_id.to_owned()))
}

async fn require_admin(
    state: &AppState,
    headers: &HeaderMap,
    request_id: &str,
) -> Result<AuthenticatedUser, ApiFailure> {
    let authenticated = require_user(state, headers, request_id).await?;
    if authenticated.user.role != ServerUserRole::Admin {
        return Err(ApiFailure::new(
            StatusCode::FORBIDDEN,
            ErrorCode::AdminRequired,
            "Administrator access is required.",
            request_id.to_owned(),
        ));
    }
    Ok(authenticated)
}

async fn require_csrf(
    state: &AppState,
    headers: &HeaderMap,
    request_id: &str,
) -> Result<AuthenticatedUser, ApiFailure> {
    let authenticated = require_user(state, headers, request_id).await?;
    let cookie_value = cookie(headers, CSRF_COOKIE);
    let header_value = headers
        .get("x-collab-csrf")
        .and_then(|value| value.to_str().ok());
    if cookie_value.is_none()
        || cookie_value != header_value
        || hash_secret(cookie_value.unwrap_or_default()) != authenticated.csrf_hash
    {
        return Err(ApiFailure::new(
            StatusCode::FORBIDDEN,
            ErrorCode::CsrfInvalid,
            "The request could not be verified.",
            request_id.to_owned(),
        ));
    }
    Ok(authenticated)
}

async fn require_admin_csrf(
    state: &AppState,
    headers: &HeaderMap,
    request_id: &str,
) -> Result<AuthenticatedUser, ApiFailure> {
    let authenticated = require_csrf(state, headers, request_id).await?;
    if authenticated.user.role != ServerUserRole::Admin {
        return Err(ApiFailure::new(
            StatusCode::FORBIDDEN,
            ErrorCode::AdminRequired,
            "Administrator access is required.",
            request_id.to_owned(),
        ));
    }
    Ok(authenticated)
}

async fn insert_user(
    transaction: &mut Transaction<'_, Postgres>,
    payload: &CreateUserRequest,
    admin: bool,
    request_id: &str,
) -> Result<ServerUser, ApiFailure> {
    let normalized = normalize_username(&payload.username)
        .map_err(|error| ApiFailure::validation(error.to_string(), request_id.to_owned()))?;
    if payload.display_name.trim().is_empty() || payload.display_name.len() > 128 {
        return Err(ApiFailure::validation(
            "Display name must be between 1 and 128 characters.",
            request_id.to_owned(),
        ));
    }
    let password_hash = hash_password(&payload.password)
        .map_err(|error| ApiFailure::validation(error.to_string(), request_id.to_owned()))?;
    let id = Uuid::now_v7();
    let row = sqlx::query(
        r#"
        INSERT INTO users (id, username, normalized_username, display_name, role)
        VALUES ($1, $2, $3, $4, CASE WHEN $5 THEN 'admin'::server_user_role ELSE 'member'::server_user_role END)
        RETURNING id, username, display_name, role::text AS role, status::text AS status,
                  created_at, last_login_at, is_primary_admin, 0::bigint AS active_sessions
        "#,
    )
    .bind(id)
    .bind(payload.username.trim())
    .bind(normalized)
    .bind(payload.display_name.trim())
    .bind(admin)
    .fetch_one(&mut **transaction)
    .await
    .map_err(|error| {
        if error.as_database_error().and_then(|value| value.code()).as_deref() == Some("23505") {
            ApiFailure::validation("That username already exists.", request_id.to_owned())
        } else {
            ApiFailure::server(request_id.to_owned())
        }
    })?;
    sqlx::query("INSERT INTO credentials (user_id, password_hash) VALUES ($1, $2)")
        .bind(id)
        .bind(password_hash)
        .execute(&mut **transaction)
        .await
        .map_err(|_| ApiFailure::server(request_id.to_owned()))?;
    Ok(user_from_row(&row))
}

async fn administrator_exists_transaction(
    transaction: &mut Transaction<'_, Postgres>,
) -> Result<bool, sqlx::Error> {
    sqlx::query_scalar::<_, bool>(
        "SELECT EXISTS(SELECT 1 FROM users WHERE role = 'admin' AND status = 'active')",
    )
    .fetch_one(&mut **transaction)
    .await
}

async fn audit(
    transaction: &mut Transaction<'_, Postgres>,
    actor: Option<&str>,
    action: &str,
    target_type: Option<&str>,
    target_id: Option<&str>,
    result: &str,
    request_id: &str,
    metadata: Value,
) -> Result<(), ApiFailure> {
    sqlx::query(
        "INSERT INTO audit_events (id, actor_user_id, action, target_type, target_id, result, request_id, metadata) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)",
    )
    .bind(Uuid::now_v7())
    .bind(actor.map(|value| Uuid::parse_str(value).expect("database UUID is valid")))
    .bind(action)
    .bind(target_type)
    .bind(target_id)
    .bind(result)
    .bind(request_id)
    .bind(metadata)
    .execute(&mut **transaction)
    .await
    .map_err(|_| ApiFailure::server(request_id.to_owned()))?;
    Ok(())
}

async fn record_audit(
    pool: &PgPool,
    actor: Option<&str>,
    action: &str,
    target_type: Option<&str>,
    target_id: Option<&str>,
    result: &str,
    request_id: &str,
    metadata: Value,
) -> Result<(), ApiFailure> {
    let mut transaction = pool
        .begin()
        .await
        .map_err(|_| ApiFailure::server(request_id.to_owned()))?;
    audit(
        &mut transaction,
        actor,
        action,
        target_type,
        target_id,
        result,
        request_id,
        metadata,
    )
    .await?;
    transaction
        .commit()
        .await
        .map_err(|_| ApiFailure::server(request_id.to_owned()))
}

async fn list_audit_events(
    pool: &PgPool,
    limit: i64,
    request_id: &str,
) -> Result<Vec<AuditEvent>, ApiFailure> {
    let rows = sqlx::query(
        r#"
        SELECT a.id, u.display_name AS actor_display_name, a.action, a.target_type,
               a.target_id, a.result, a.created_at
        FROM audit_events a LEFT JOIN users u ON u.id = a.actor_user_id
        ORDER BY a.created_at DESC LIMIT $1
        "#,
    )
    .bind(limit)
    .fetch_all(pool)
    .await
    .map_err(|_| ApiFailure::server(request_id.to_owned()))?;
    Ok(rows
        .iter()
        .map(|row| AuditEvent {
            id: row.get::<Uuid, _>("id").to_string(),
            actor_display_name: row.get("actor_display_name"),
            action: row.get("action"),
            target_type: row.get("target_type"),
            target_id: row.get("target_id"),
            result: row.get("result"),
            created_at: row
                .get::<chrono::DateTime<chrono::Utc>, _>("created_at")
                .to_rfc3339(),
        })
        .collect())
}

async fn list_user_audit_events(
    pool: &PgPool,
    user_id: Uuid,
    limit: i64,
    request_id: &str,
) -> Result<Vec<AuditEvent>, ApiFailure> {
    let rows = sqlx::query(
        r#"
        SELECT a.id, u.display_name AS actor_display_name, a.action, a.target_type,
               a.target_id, a.result, a.created_at
        FROM audit_events a LEFT JOIN users u ON u.id = a.actor_user_id
        WHERE a.actor_user_id = $1 OR (a.target_type = 'user' AND a.target_id = $2)
        ORDER BY a.created_at DESC LIMIT $3
        "#,
    )
    .bind(user_id)
    .bind(user_id.to_string())
    .bind(limit)
    .fetch_all(pool)
    .await
    .map_err(|_| ApiFailure::server(request_id.to_owned()))?;
    Ok(rows
        .iter()
        .map(|row| AuditEvent {
            id: row.get::<Uuid, _>("id").to_string(),
            actor_display_name: row.get("actor_display_name"),
            action: row.get("action"),
            target_type: row.get("target_type"),
            target_id: row.get("target_id"),
            result: row.get("result"),
            created_at: row
                .get::<chrono::DateTime<chrono::Utc>, _>("created_at")
                .to_rfc3339(),
        })
        .collect())
}

fn cookie<'a>(headers: &'a HeaderMap, name: &str) -> Option<&'a str> {
    headers
        .get(header::COOKIE)?
        .to_str()
        .ok()?
        .split(';')
        .filter_map(|value| value.trim().split_once('='))
        .find_map(|(key, value)| (key == name).then_some(value))
}

fn append_cookie(
    response: &mut Response,
    name: &str,
    value: &str,
    http_only: bool,
    secure: bool,
    ttl_hours: i64,
) {
    let mut cookie = format!(
        "{name}={value}; Path=/; SameSite=Strict; Max-Age={}",
        ttl_hours * 60 * 60
    );
    if http_only {
        cookie.push_str("; HttpOnly");
    }
    if secure {
        cookie.push_str("; Secure");
    }
    response.headers_mut().append(
        header::SET_COOKIE,
        HeaderValue::from_str(&cookie).expect("generated cookie is valid"),
    );
}

fn append_expired_cookie(response: &mut Response, name: &str, secure: bool) {
    let mut cookie = format!("{name}=; Path=/; SameSite=Strict; Max-Age=0; HttpOnly");
    if secure {
        cookie.push_str("; Secure");
    }
    response.headers_mut().append(
        header::SET_COOKIE,
        HeaderValue::from_str(&cookie).expect("generated cookie is valid"),
    );
}

#[derive(Debug)]
pub struct ApiFailure {
    status: StatusCode,
    error: ApiError,
}

impl ApiFailure {
    fn new(
        status: StatusCode,
        code: ErrorCode,
        message: impl Into<String>,
        request_id: String,
    ) -> Self {
        Self {
            status,
            error: ApiError {
                code,
                message: message.into(),
                request_id,
                details: Value::Null,
            },
        }
    }

    fn message(&self) -> &str {
        &self.error.message
    }

    fn server(request_id: String) -> Self {
        Self::new(
            StatusCode::INTERNAL_SERVER_ERROR,
            ErrorCode::ServerUnavailable,
            "The server could not complete the request.",
            request_id,
        )
    }

    fn validation(message: impl Into<String>, request_id: String) -> Self {
        Self::new(
            StatusCode::BAD_REQUEST,
            ErrorCode::ValidationFailed,
            message,
            request_id,
        )
    }

    fn authentication_required(request_id: String) -> Self {
        Self::new(
            StatusCode::UNAUTHORIZED,
            ErrorCode::AuthenticationRequired,
            "Authentication is required.",
            request_id,
        )
    }

    fn not_found(request_id: String) -> Self {
        Self::new(
            StatusCode::NOT_FOUND,
            ErrorCode::ResourceNotFound,
            "The requested resource was not found.",
            request_id,
        )
    }

    fn vault_permission_denied(request_id: String) -> Self {
        Self::new(
            StatusCode::FORBIDDEN,
            ErrorCode::VaultPermissionDenied,
            "You do not have permission to perform this vault operation.",
            request_id,
        )
    }

    fn vault_archived(request_id: String) -> Self {
        Self::new(
            StatusCode::CONFLICT,
            ErrorCode::VaultArchived,
            "The vault is archived or pending deletion.",
            request_id,
        )
    }

    fn path_invalid(message: impl Into<String>, request_id: String) -> Self {
        Self::new(
            StatusCode::BAD_REQUEST,
            ErrorCode::PathInvalid,
            message,
            request_id,
        )
    }

    fn revision_conflict(request_id: String) -> Self {
        Self::new(
            StatusCode::CONFLICT,
            ErrorCode::RevisionConflict,
            "The document has changed since the supplied revision.",
            request_id,
        )
    }

    fn manifest_conflict(request_id: String) -> Self {
        Self::new(
            StatusCode::CONFLICT,
            ErrorCode::ManifestConflict,
            "The vault manifest has changed since the supplied sequence.",
            request_id,
        )
    }

    fn upload_hash_mismatch(request_id: String) -> Self {
        Self::new(
            StatusCode::UNPROCESSABLE_ENTITY,
            ErrorCode::UploadHashMismatch,
            "The uploaded content does not match the expected SHA-256 hash.",
            request_id,
        )
    }

    fn quota_exceeded(request_id: String) -> Self {
        Self::new(
            StatusCode::PAYLOAD_TOO_LARGE,
            ErrorCode::QuotaExceeded,
            "The file exceeds the configured upload limit.",
            request_id,
        )
    }

    fn storage_quota_exceeded(request_id: String) -> Self {
        Self::new(
            StatusCode::INSUFFICIENT_STORAGE,
            ErrorCode::QuotaExceeded,
            "This upload would exceed the server storage quota.",
            request_id,
        )
    }
}

impl IntoResponse for ApiFailure {
    fn into_response(self) -> Response {
        (self.status, Json(ErrorResponse { error: self.error })).into_response()
    }
}

#[cfg(test)]
mod tests {
    use super::{
        cookie, delete_or_quarantine_backup_dir, indexed_note_tags, indexed_note_title,
        is_safe_backup_name, parse_backup_created_at, parse_vault_zip, quota_added_bytes,
        quota_would_exceed, run_operator_command, search_excerpt, sha256_file,
        validate_backup_archive_entries, validate_backup_manifest_version, verify_backup,
        BackupRuntimeSettings, Capability, STANDARD,
    };
    use crate::auth::hash_secret;
    use crate::{
        app::{build_router, AppState},
        config::ServerConfig,
        database,
        storage::FileSystemBlobStorage,
    };
    use axum::{
        body::Body,
        http::{header, HeaderMap, HeaderValue, Request, StatusCode},
        Router,
    };
    use base64::Engine;
    use http_body_util::BodyExt;
    use serde_json::{json, Value};
    use sqlx::{postgres::PgPoolOptions, Row};
    use std::collections::HashSet;
    use std::{
        io::{Cursor, Read, Write},
        sync::Arc,
        time::Duration,
    };
    use tower::ServiceExt;
    use uuid::Uuid;

    #[test]
    fn quota_added_bytes_ignores_existing_and_duplicate_digests() {
        let mut existing = HashSet::new();
        existing.insert("a".to_string());
        // "a" already stored (0), "b" new (10), "b" again duplicate (0), "c" new (5).
        let incoming = vec![
            ("a".to_string(), 100),
            ("b".to_string(), 10),
            ("b".to_string(), 10),
            ("c".to_string(), 5),
        ];
        assert_eq!(quota_added_bytes(&incoming, &existing), 15);
    }

    #[test]
    fn quota_added_bytes_is_zero_when_all_content_is_already_stored() {
        let mut existing = HashSet::new();
        existing.insert("a".to_string());
        let incoming = vec![("a".to_string(), 100)];
        assert_eq!(quota_added_bytes(&incoming, &existing), 0);
    }

    #[test]
    fn runtime_settings_request_accepts_byte_strings_and_numbers() {
        let request: super::UpdateRuntimeSettingsRequest =
            serde_json::from_value(serde_json::json!({
                "maxFileBytes": "256 MiB",
                "maxImportBytes": 536_870_912u64,
                "storageQuotaBytes": "12 GiB",
            }))
            .unwrap();
        assert_eq!(request.max_file_bytes, Some(256 * 1024 * 1024));
        assert_eq!(request.max_import_bytes, Some(536_870_912));
        assert_eq!(request.storage_quota_bytes, Some(12 * 1024 * 1024 * 1024));
        // Omitted byte fields stay absent.
        assert_eq!(request.max_import_expanded_bytes, None);
        assert_eq!(request.storage_warning_bytes, None);
    }

    #[test]
    fn runtime_settings_request_rejects_unparseable_byte_strings() {
        let result: Result<super::UpdateRuntimeSettingsRequest, _> =
            serde_json::from_value(serde_json::json!({ "maxFileBytes": "not a size" }));
        assert!(result.is_err());
    }

    #[test]
    fn quota_would_exceed_respects_unlimited_and_threshold() {
        // Unlimited quota never trips.
        assert!(!quota_would_exceed(1_000, 1_000, 0));
        // Exactly at the quota is allowed; one byte over is rejected.
        assert!(!quota_would_exceed(900, 100, 1_000));
        assert!(quota_would_exceed(901, 100, 1_000));
        // Saturating addition cannot wrap around the limit.
        assert!(quota_would_exceed(u64::MAX, 1, 1_000));
    }

    #[test]
    fn cookie_parser_matches_exact_names() {
        let mut headers = HeaderMap::new();
        headers.insert(
            header::COOKIE,
            HeaderValue::from_static("other=x; collab_session=secret; collab_csrf=token"),
        );
        assert_eq!(cookie(&headers, "collab_session"), Some("secret"));
        assert_eq!(cookie(&headers, "session"), None);
    }

    #[test]
    fn backup_verifier_checks_artifact_hashes_and_rejects_unsafe_names() {
        assert!(is_safe_backup_name("collab-backup-20260618T111501Z"));
        assert!(!is_safe_backup_name("../collab-backup-20260618T111501Z"));
        let temp = tempfile::tempdir().unwrap();
        let backup_dir = temp.path().join("collab-backup-20260618T111501Z");
        std::fs::create_dir(&backup_dir).unwrap();
        std::fs::write(backup_dir.join("postgres.dump"), b"database").unwrap();
        std::fs::write(backup_dir.join("blobs.tar.gz"), b"blobs").unwrap();
        std::fs::write(
            backup_dir.join("manifest.txt"),
            b"created_at=20260618T111501Z\n",
        )
        .unwrap();
        let pg_hash = sha256_file(&backup_dir.join("postgres.dump")).unwrap();
        let blob_hash = sha256_file(&backup_dir.join("blobs.tar.gz")).unwrap();
        let manifest_hash = sha256_file(&backup_dir.join("manifest.txt")).unwrap();
        std::fs::write(
            backup_dir.join("checksums.sha256"),
            format!(
                "{pg_hash}  postgres.dump\n{blob_hash}  blobs.tar.gz\n{manifest_hash}  manifest.txt\n"
            ),
        )
        .unwrap();

        let ok = verify_backup("collab-backup-20260618T111501Z", &backup_dir, "request").unwrap();
        assert!(ok.ok);
        assert_eq!(ok.artifacts.len(), 3);

        std::fs::write(backup_dir.join("blobs.tar.gz"), b"changed").unwrap();
        let failed =
            verify_backup("collab-backup-20260618T111501Z", &backup_dir, "request").unwrap();
        assert!(!failed.ok);
        assert!(failed
            .artifacts
            .iter()
            .any(|artifact| artifact.path == "blobs.tar.gz" && !artifact.ok));
    }

    #[test]
    fn backup_created_at_parser_accepts_manifest_and_rfc3339_timestamps() {
        assert!(parse_backup_created_at("20260618T111501Z").is_some());
        assert!(parse_backup_created_at("2026-06-18T11:15:01Z").is_some());
        assert!(parse_backup_created_at("not-a-timestamp").is_none());
    }

    #[test]
    fn backup_import_validation_rejects_unsafe_archives_and_versions() {
        let root = validate_backup_archive_entries(
            &[
                "collab-backup-20260618T111501Z/".into(),
                "collab-backup-20260618T111501Z/postgres.dump".into(),
                "collab-backup-20260618T111501Z/blobs.tar.gz".into(),
            ],
            "request",
        )
        .unwrap();
        assert_eq!(root, "collab-backup-20260618T111501Z");

        assert!(validate_backup_archive_entries(
            &["collab-backup-20260618T111501Z/../evil".into()],
            "request",
        )
        .is_err());
        assert!(validate_backup_archive_entries(
            &[
                "collab-backup-20260618T111501Z/postgres.dump".into(),
                "collab-backup-20260618T111502Z/postgres.dump".into(),
            ],
            "request",
        )
        .is_err());

        let temp = tempfile::tempdir().unwrap();
        let backup_dir = temp.path().join("collab-backup-20260618T111501Z");
        std::fs::create_dir(&backup_dir).unwrap();
        std::fs::write(
            backup_dir.join("manifest.txt"),
            b"collab_backup_version=1\n",
        )
        .unwrap();
        validate_backup_manifest_version(&backup_dir, "request").unwrap();
        std::fs::write(
            backup_dir.join("manifest.txt"),
            b"collab_backup_version=2\n",
        )
        .unwrap();
        assert!(validate_backup_manifest_version(&backup_dir, "request").is_err());
    }

    #[test]
    fn backup_delete_helper_removes_backup_directories() {
        let temp = tempfile::tempdir().unwrap();
        let backup_dir = temp.path().join("collab-backup-20260618T111501Z");
        std::fs::create_dir(&backup_dir).unwrap();
        std::fs::write(
            backup_dir.join("manifest.txt"),
            b"created_at=20260618T111501Z\n",
        )
        .unwrap();

        let mode = delete_or_quarantine_backup_dir(
            temp.path(),
            "collab-backup-20260618T111501Z",
            &backup_dir,
            "request",
        )
        .unwrap();

        assert_eq!(mode, "deleted");
        assert!(!backup_dir.exists());
    }

    #[tokio::test]
    async fn operator_command_failure_includes_captured_output() {
        let temp = tempfile::tempdir().unwrap();
        let settings = BackupRuntimeSettings {
            schedule_enabled: false,
            interval_seconds: 60,
            retention_days: 0,
            export_dir: None,
        };
        let failure = run_operator_command(
            "echo backup stdout; echo backup stderr >&2; exit 7",
            temp.path(),
            None,
            &settings,
            Duration::from_secs(5),
            "request",
        )
        .await
        .expect_err("command should fail");

        assert!(failure.message().contains("exit status 7"));
        assert!(failure.message().contains("backup stdout"));
        assert!(failure.message().contains("backup stderr"));
    }

    #[test]
    fn hosted_note_index_extracts_metadata_and_unicode_safe_excerpts() {
        let content = "---\ntitle: \"Search title\"\ntags: [alpha, beta]\n---\n# Ignored\nA café search term appears here.";
        assert_eq!(indexed_note_title(content, "Fallback.md"), "Search title");
        assert_eq!(indexed_note_tags(content), vec!["alpha", "beta"]);
        assert!(search_excerpt(content, "café", 30).contains("café"));
    }

    #[test]
    fn vault_zip_parser_rejects_traversal_and_builds_implicit_folders() {
        let valid = STANDARD
            .decode(zip_base64(&[("Notes/Test.md", b"# Test")]))
            .unwrap();
        let entries = parse_vault_zip(&valid, 1024, 4096, "request").unwrap();
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].relative_path, "Notes");
        assert_eq!(entries[1].relative_path, "Notes/Test.md");

        let invalid = STANDARD
            .decode(zip_base64(&[("../escape.md", b"no")]))
            .unwrap();
        assert!(parse_vault_zip(&invalid, 1024, 4096, "request").is_err());
    }

    #[test]
    fn vault_zip_parser_accepts_windows_backslash_separators() {
        let archive = STANDARD
            .decode(zip_base64(&[("Notes\\Sub\\Test.md", b"# Test")]))
            .unwrap();
        let entries = parse_vault_zip(&archive, 1024, 4096, "request").unwrap();
        let paths = entries
            .iter()
            .map(|entry| entry.relative_path.as_str())
            .collect::<Vec<_>>();
        assert!(paths.contains(&"Notes"));
        assert!(paths.contains(&"Notes/Sub"));
        assert!(paths.contains(&"Notes/Sub/Test.md"));
    }

    #[test]
    fn vault_zip_parser_enforces_total_expanded_limit_separately() {
        let archive = STANDARD
            .decode(zip_base64(&[
                ("one.bin", &[1; 700]),
                ("two.bin", &[2; 700]),
            ]))
            .unwrap();

        assert!(parse_vault_zip(&archive, 1024, 1200, "request").is_err());
        assert!(parse_vault_zip(&archive, 1024, 1600, "request").is_ok());
    }

    async fn request(
        app: &Router,
        method: &str,
        uri: &str,
        body: Value,
        cookie: Option<&str>,
        csrf: Option<&str>,
    ) -> axum::response::Response {
        let mut builder = Request::builder()
            .method(method)
            .uri(uri)
            .header(header::CONTENT_TYPE, "application/json");
        if let Some(cookie) = cookie {
            builder = builder.header(header::COOKIE, cookie);
        }
        if let Some(csrf) = csrf {
            builder = builder.header("x-collab-csrf", csrf);
        }
        app.clone()
            .oneshot(builder.body(Body::from(body.to_string())).unwrap())
            .await
            .unwrap()
    }

    async fn bearer_request(
        app: &Router,
        method: &str,
        uri: &str,
        body: Value,
        token: &str,
    ) -> axum::response::Response {
        app.clone()
            .oneshot(
                Request::builder()
                    .method(method)
                    .uri(uri)
                    .header(header::CONTENT_TYPE, "application/json")
                    .header(header::AUTHORIZATION, format!("Bearer {token}"))
                    .body(Body::from(body.to_string()))
                    .unwrap(),
            )
            .await
            .unwrap()
    }

    /// Re-inserts the three built-in permission templates that migration 0008
    /// seeds, after a CASCADE truncate removes them. Capability sets mirror the
    /// migration and `collab_protocol::capabilities_for_role`.
    async fn reseed_builtin_templates(pool: &sqlx::PgPool) {
        for role in [
            super::HostedVaultRole::Viewer,
            super::HostedVaultRole::Editor,
            super::HostedVaultRole::Admin,
        ] {
            let (id, name) = match role {
                super::HostedVaultRole::Viewer => {
                    ("a0000000-0000-4000-8000-000000000001", "viewer")
                }
                super::HostedVaultRole::Editor => {
                    ("a0000000-0000-4000-8000-000000000002", "editor")
                }
                super::HostedVaultRole::Admin => ("a0000000-0000-4000-8000-000000000003", "admin"),
            };
            let capabilities: Vec<String> = super::capabilities_for_role(role)
                .into_iter()
                .map(|capability| capability.as_token().to_owned())
                .collect();
            sqlx::query(
                "INSERT INTO permission_templates (id, name, is_builtin, capabilities) VALUES ($1::uuid, $2, TRUE, $3) ON CONFLICT (id) DO NOTHING",
            )
            .bind(id)
            .bind(name)
            .bind(&capabilities)
            .execute(pool)
            .await
            .unwrap();
        }
    }

    /// Extracts the `capabilities` token array from a vault DTO JSON value.
    fn capability_tokens(vault: &Value) -> Vec<String> {
        vault["capabilities"]
            .as_array()
            .unwrap()
            .iter()
            .map(|token| token.as_str().unwrap().to_owned())
            .collect()
    }

    async fn json_body(response: axum::response::Response) -> Value {
        let bytes = response.into_body().collect().await.unwrap().to_bytes();
        serde_json::from_slice(&bytes).unwrap()
    }

    async fn response_bytes(response: axum::response::Response) -> Vec<u8> {
        response
            .into_body()
            .collect()
            .await
            .unwrap()
            .to_bytes()
            .to_vec()
    }

    fn zip_base64(entries: &[(&str, &[u8])]) -> String {
        let mut writer = zip::ZipWriter::new(Cursor::new(Vec::new()));
        let options = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Deflated);
        for (name, content) in entries {
            writer.start_file(*name, options).unwrap();
            writer.write_all(content).unwrap();
        }
        STANDARD.encode(writer.finish().unwrap().into_inner())
    }

    fn session_cookies(response: &axum::response::Response) -> (String, String) {
        let values = response.headers().get_all(header::SET_COOKIE);
        let mut session = String::new();
        let mut csrf = String::new();
        for value in values {
            let pair = value.to_str().unwrap().split(';').next().unwrap();
            if pair.starts_with("collab_session=") {
                session = pair.to_owned();
            } else if pair.starts_with("collab_csrf=") {
                csrf = pair.to_owned();
            }
        }
        let csrf_value = csrf.split_once('=').unwrap().1.to_owned();
        (format!("{session}; {csrf}"), csrf_value)
    }

    #[tokio::test]
    async fn browser_admin_lifecycle_is_authorized_and_csrf_protected() {
        let Ok(url) = std::env::var("COLLAB_TEST_DATABASE_URL") else {
            return;
        };
        // Serialize with other live-PostgreSQL tests that share and truncate the
        // same database.
        let _db_guard = crate::database::db_test_guard().lock().await;
        let pool = PgPoolOptions::new()
            .max_connections(5)
            .connect(&url)
            .await
            .unwrap();
        database::migrate(&pool).await.unwrap();
        sqlx::query(
            "TRUNCATE audit_events, invitations, native_sessions, sessions, credentials, users, hosted_blobs RESTART IDENTITY CASCADE",
        )
        .execute(&pool)
        .await
        .unwrap();
        // The TRUNCATE above cascades through the `created_by` FK and wipes the
        // built-in permission templates seeded by migration 0008. Re-seed them so
        // the test environment matches production, where they always exist.
        reseed_builtin_templates(&pool).await;
        let blobs = Arc::new(
            FileSystemBlobStorage::new(tempfile::tempdir().unwrap().keep())
                .await
                .unwrap(),
        );
        let app = build_router(AppState::new(
            ServerConfig::default(),
            pool.clone(),
            blobs.clone(),
        ));

        let status = request(
            &app,
            "GET",
            "/api/v1/auth/bootstrap-status",
            json!({}),
            None,
            None,
        )
        .await;
        assert_eq!(status.status(), StatusCode::OK);
        assert_eq!(status.headers()[header::CACHE_CONTROL], "no-store");
        assert_eq!(json_body(status).await["data"]["required"], true);

        let bootstrap = request(
            &app,
            "POST",
            "/api/v1/auth/bootstrap",
            json!({
                "username": "admin",
                "displayName": "First Admin",
                "password": "correct horse battery staple"
            }),
            None,
            None,
        )
        .await;
        assert_eq!(bootstrap.status(), StatusCode::OK);
        let (admin_cookie, admin_csrf) = session_cookies(&bootstrap);
        let admin_id =
            sqlx::query_scalar::<_, Uuid>("SELECT id FROM users WHERE is_primary_admin = TRUE")
                .fetch_one(&pool)
                .await
                .unwrap();

        let restarted_app =
            build_router(AppState::new(ServerConfig::default(), pool.clone(), blobs));
        let restarted_status = request(
            &restarted_app,
            "GET",
            "/api/v1/auth/bootstrap-status",
            json!({}),
            None,
            None,
        )
        .await;
        assert_eq!(restarted_status.status(), StatusCode::OK);
        assert_eq!(
            restarted_status.headers()[header::CACHE_CONTROL],
            "no-store"
        );
        assert_eq!(json_body(restarted_status).await["data"]["required"], false);

        let duplicate_bootstrap = request(
            &app,
            "POST",
            "/api/v1/auth/bootstrap",
            json!({
                "username": "other-admin",
                "displayName": "Other",
                "password": "correct horse battery staple"
            }),
            None,
            None,
        )
        .await;
        assert_eq!(duplicate_bootstrap.status(), StatusCode::CONFLICT);

        let without_csrf = request(
            &app,
            "POST",
            "/api/v1/admin/users",
            json!({
                "username": "member",
                "displayName": "Member",
                "password": "member password is long enough"
            }),
            Some(&admin_cookie),
            None,
        )
        .await;
        assert_eq!(without_csrf.status(), StatusCode::FORBIDDEN);

        let member = request(
            &app,
            "POST",
            "/api/v1/admin/users",
            json!({
                "username": "member",
                "displayName": "Member",
                "password": "member password is long enough"
            }),
            Some(&admin_cookie),
            Some(&admin_csrf),
        )
        .await;
        assert_eq!(member.status(), StatusCode::CREATED);
        let member_id = json_body(member).await["data"]["id"]
            .as_str()
            .unwrap()
            .to_owned();

        let invitation = request(
            &app,
            "POST",
            "/api/v1/admin/invitations",
            json!({"username": "invited", "displayName": "Invited User", "expiresInHours": 24}),
            Some(&admin_cookie),
            Some(&admin_csrf),
        )
        .await;
        assert_eq!(invitation.status(), StatusCode::CREATED);
        let invitation_body = json_body(invitation).await;
        let invitation_token = invitation_body["data"]["token"].as_str().unwrap();
        assert!(!invitation_body
            .to_string()
            .contains("invited password is long enough"));
        let accepted = request(
            &app,
            "POST",
            &format!("/api/v1/auth/invitations/{invitation_token}/accept"),
            json!({"password": "invited password is long enough"}),
            None,
            None,
        )
        .await;
        assert_eq!(accepted.status(), StatusCode::OK);
        let invited_id = json_body(accepted).await["data"]["user"]["id"]
            .as_str()
            .unwrap()
            .to_owned();
        let reset = request(
            &app,
            "POST",
            &format!("/api/v1/admin/users/{invited_id}/reset-password"),
            json!({"newPassword": "replacement password is long enough"}),
            Some(&admin_cookie),
            Some(&admin_csrf),
        )
        .await;
        assert_eq!(reset.status(), StatusCode::NO_CONTENT);
        let old_password = request(
            &app,
            "POST",
            "/api/v1/auth/login",
            json!({"username": "invited", "password": "invited password is long enough"}),
            None,
            None,
        )
        .await;
        assert_eq!(old_password.status(), StatusCode::UNAUTHORIZED);
        let new_password = request(
            &app,
            "POST",
            "/api/v1/auth/login",
            json!({"username": "invited", "password": "replacement password is long enough"}),
            None,
            None,
        )
        .await;
        assert_eq!(new_password.status(), StatusCode::OK);
        let (invited_cookie, invited_csrf) = session_cookies(&new_password);

        let native_login = request(
            &app,
            "POST",
            "/api/v1/auth/native/login",
            json!({"username": "member", "password": "member password is long enough", "clientName": "Integration test"}),
            None,
            None,
        ).await;
        assert_eq!(native_login.status(), StatusCode::OK);
        let native_body = json_body(native_login).await;
        let access = native_body["data"]["accessToken"]
            .as_str()
            .unwrap()
            .to_owned();
        let refresh_token = native_body["data"]["refreshToken"]
            .as_str()
            .unwrap()
            .to_owned();
        assert_ne!(access, refresh_token);

        // Any authenticated user can resolve the user directory (used by hosted
        // vault admins to add members), and it matches on username/display name.
        let directory = bearer_request(
            &app,
            "GET",
            "/api/v1/users/directory?q=member",
            json!({}),
            &access,
        )
        .await;
        assert_eq!(directory.status(), StatusCode::OK);
        let directory_entries = json_body(directory).await;
        let usernames: Vec<&str> = directory_entries["data"]
            .as_array()
            .unwrap()
            .iter()
            .map(|entry| entry["username"].as_str().unwrap())
            .collect();
        assert!(usernames.contains(&"member"));
        assert!(!usernames.contains(&"invited"));

        let refreshed = request(
            &app,
            "POST",
            "/api/v1/auth/refresh",
            json!({"refreshToken": refresh_token.clone()}),
            None,
            None,
        )
        .await;
        assert_eq!(refreshed.status(), StatusCode::OK);
        let refreshed_body = json_body(refreshed).await;
        let next_access = refreshed_body["data"]["accessToken"]
            .as_str()
            .unwrap()
            .to_owned();
        let next_refresh = refreshed_body["data"]["refreshToken"]
            .as_str()
            .unwrap()
            .to_owned();
        assert_ne!(refresh_token, next_refresh);
        let hashes = sqlx::query("SELECT refresh_token_hash, previous_refresh_token_hash FROM native_sessions WHERE access_token_hash = $1")
            .bind(hash_secret(&next_access)).fetch_one(&pool).await.unwrap();
        assert_eq!(
            hashes.get::<String, _>("refresh_token_hash"),
            hash_secret(&next_refresh)
        );
        assert_eq!(
            hashes.get::<Option<String>, _>("previous_refresh_token_hash"),
            Some(hash_secret(&refresh_token))
        );
        let reused = request(
            &app,
            "POST",
            "/api/v1/auth/refresh",
            json!({"refreshToken": refresh_token}),
            None,
            None,
        )
        .await;
        assert_eq!(reused.status(), StatusCode::UNAUTHORIZED);
        let revoked_native = bearer_request(
            &app,
            "POST",
            "/api/v1/auth/native/logout",
            json!({}),
            &next_access,
        )
        .await;
        assert_eq!(revoked_native.status(), StatusCode::UNAUTHORIZED);
        let forged_native = bearer_request(
            &app,
            "POST",
            "/api/v1/auth/native/logout",
            json!({}),
            "forged-token",
        )
        .await;
        assert_eq!(forged_native.status(), StatusCode::UNAUTHORIZED);
        let expired_login = request(
            &app,
            "POST",
            "/api/v1/auth/native/login",
            json!({"username": "member", "password": "member password is long enough"}),
            None,
            None,
        )
        .await;
        let expired_body = json_body(expired_login).await;
        sqlx::query("UPDATE native_sessions SET refresh_expires_at = NOW() - INTERVAL '1 minute' WHERE refresh_token_hash = $1")
            .bind(hash_secret(expired_body["data"]["refreshToken"].as_str().unwrap()))
            .execute(&pool).await.unwrap();
        let expired_refresh = request(
            &app,
            "POST",
            "/api/v1/auth/refresh",
            json!({"refreshToken": expired_body["data"]["refreshToken"]}),
            None,
            None,
        )
        .await;
        assert_eq!(expired_refresh.status(), StatusCode::UNAUTHORIZED);

        let member_login = request(
            &app,
            "POST",
            "/api/v1/auth/login",
            json!({"username": "member", "password": "member password is long enough"}),
            None,
            None,
        )
        .await;
        assert_eq!(member_login.status(), StatusCode::OK);
        let (member_cookie, member_csrf) = session_cookies(&member_login);
        let forbidden_overview = request(
            &app,
            "GET",
            "/api/v1/admin/overview",
            json!({}),
            Some(&member_cookie),
            None,
        )
        .await;
        assert_eq!(forbidden_overview.status(), StatusCode::FORBIDDEN);

        let member_owned_vault = request(
            &app,
            "POST",
            "/api/v1/vaults",
            json!({"name": "Member Owned Vault"}),
            Some(&invited_cookie),
            Some(&invited_csrf),
        )
        .await;
        assert_eq!(member_owned_vault.status(), StatusCode::CREATED);
        let member_owned_vault_id = json_body(member_owned_vault).await["data"]["id"]
            .as_str()
            .unwrap()
            .to_owned();
        let operator_document = request(
            &app,
            "POST",
            &format!("/api/v1/vaults/{member_owned_vault_id}/files"),
            json!({
                "name": "Operator.md",
                "kind": "document",
                "documentType": "note",
                "content": "original"
            }),
            Some(&admin_cookie),
            Some(&admin_csrf),
        )
        .await;
        assert_eq!(operator_document.status(), StatusCode::CREATED);
        let operator_document_body = json_body(operator_document).await;
        let operator_document_id = operator_document_body["data"]["id"].as_str().unwrap();
        let original_operator_revision_id = operator_document_body["data"]["currentRevision"]["id"]
            .as_str()
            .unwrap();
        let operator_write = request(
            &app,
            "POST",
            &format!(
                "/api/v1/vaults/{member_owned_vault_id}/files/{operator_document_id}/revisions"
            ),
            json!({"expectedRevisionSequence": 1, "content": "updated"}),
            Some(&admin_cookie),
            Some(&admin_csrf),
        )
        .await;
        assert_eq!(operator_write.status(), StatusCode::CREATED);
        let operator_restore = request(
            &app,
            "POST",
            &format!(
                "/api/v1/vaults/{member_owned_vault_id}/files/{operator_document_id}/revisions/{original_operator_revision_id}"
            ),
            json!({"expectedRevisionSequence": 2}),
            Some(&admin_cookie),
            Some(&admin_csrf),
        )
        .await;
        assert_eq!(operator_restore.status(), StatusCode::CREATED);
        let operator_restore_body = json_body(operator_restore).await;
        assert_eq!(operator_restore_body["data"]["content"], "original");
        assert_eq!(
            operator_restore_body["data"]["file"]["currentRevision"]["sequence"],
            3
        );
        let member_owned_manifest = request(
            &app,
            "GET",
            &format!("/api/v1/vaults/{member_owned_vault_id}/manifest"),
            json!({}),
            Some(&admin_cookie),
            None,
        )
        .await;
        assert_eq!(member_owned_manifest.status(), StatusCode::OK);
        let operator_folder = request(
            &app,
            "POST",
            &format!("/api/v1/vaults/{member_owned_vault_id}/files"),
            json!({"name": "Moved", "kind": "folder", "content": ""}),
            Some(&admin_cookie),
            Some(&admin_csrf),
        )
        .await;
        assert_eq!(operator_folder.status(), StatusCode::CREATED);
        let operator_folder_id = json_body(operator_folder).await["data"]["id"]
            .as_str()
            .unwrap()
            .to_owned();
        let operator_move = request(
            &app,
            "POST",
            &format!("/api/v1/vaults/{member_owned_vault_id}/operations"),
            json!({
                "clientOperationId": Uuid::now_v7(),
                "baseManifestSequence": 4,
                "operationType": "move",
                "targetFileId": operator_document_id,
                "parentId": operator_folder_id
            }),
            Some(&admin_cookie),
            Some(&admin_csrf),
        )
        .await;
        assert_eq!(operator_move.status(), StatusCode::OK);
        let operator_download = request(
            &app,
            "GET",
            &format!("/api/v1/vaults/{member_owned_vault_id}/files/{operator_document_id}/content"),
            json!({}),
            Some(&admin_cookie),
            None,
        )
        .await;
        assert_eq!(operator_download.status(), StatusCode::OK);
        assert_eq!(response_bytes(operator_download).await, b"original");
        let admin_all_vaults = request(
            &app,
            "GET",
            "/api/v1/vaults",
            json!({}),
            Some(&admin_cookie),
            None,
        )
        .await;
        assert!(json_body(admin_all_vaults).await["data"]
            .as_array()
            .unwrap()
            .iter()
            .any(|vault| vault["id"] == member_owned_vault_id));

        let vault = request(
            &app,
            "POST",
            "/api/v1/vaults",
            json!({"name": "Team Vault"}),
            Some(&admin_cookie),
            Some(&admin_csrf),
        )
        .await;
        assert_eq!(vault.status(), StatusCode::CREATED);
        let vault_body = json_body(vault).await;
        let vault_id = vault_body["data"]["id"].as_str().unwrap();
        assert_eq!(vault_body["data"]["role"], "admin");
        assert_eq!(vault_body["data"]["status"], "active");
        // The owner resolves to the full capability set, matching the legacy
        // implicit-admin behavior now expressed as fine-grained capabilities.
        let owner_caps = capability_tokens(&vault_body["data"]);
        assert_eq!(owner_caps.len(), Capability::ALL.len());
        assert!(owner_caps.contains(&"file.write".to_owned()));
        assert!(owner_caps.contains(&"vault.managePermissions".to_owned()));

        let member_vaults_before = request(
            &app,
            "GET",
            "/api/v1/vaults",
            json!({}),
            Some(&member_cookie),
            None,
        )
        .await;
        assert_eq!(json_body(member_vaults_before).await["data"], json!([]));

        let added_member = request(
            &app,
            "POST",
            &format!("/api/v1/vaults/{vault_id}/members"),
            json!({"userId": member_id, "role": "viewer"}),
            Some(&admin_cookie),
            Some(&admin_csrf),
        )
        .await;
        assert_eq!(added_member.status(), StatusCode::CREATED);
        assert_eq!(json_body(added_member).await["data"]["role"], "viewer");

        let member_vaults = request(
            &app,
            "GET",
            "/api/v1/vaults",
            json!({}),
            Some(&member_cookie),
            None,
        )
        .await;
        let member_vaults_body = json_body(member_vaults).await;
        assert_eq!(member_vaults_body["data"][0]["id"], vault_id);
        // A direct viewer membership with no template/capability override resolves
        // from its legacy role to the built-in viewer capability set.
        let viewer_caps = capability_tokens(&member_vaults_body["data"][0]);
        assert_eq!(
            viewer_caps,
            vec![
                "vault.read".to_owned(),
                "vault.search".to_owned(),
                "vault.viewHistory".to_owned(),
                "vault.viewActivity".to_owned(),
            ]
        );
        assert!(!viewer_caps.contains(&"vault.offlineCopy".to_owned()));

        let viewer_rename = request(
            &app,
            "PATCH",
            &format!("/api/v1/vaults/{vault_id}"),
            json!({"name": "Denied Rename"}),
            Some(&member_cookie),
            Some(&member_csrf),
        )
        .await;
        assert_eq!(viewer_rename.status(), StatusCode::FORBIDDEN);
        assert_eq!(
            json_body(viewer_rename).await["error"]["code"],
            "vault_permission_denied"
        );

        let viewer_create_file = request(
            &app,
            "POST",
            &format!("/api/v1/vaults/{vault_id}/files"),
            json!({"name": "Denied", "kind": "folder", "content": ""}),
            Some(&member_cookie),
            Some(&member_csrf),
        )
        .await;
        assert_eq!(viewer_create_file.status(), StatusCode::FORBIDDEN);
        assert_eq!(
            json_body(viewer_create_file).await["error"]["code"],
            "vault_permission_denied"
        );

        let owner_removal = request(
            &app,
            "DELETE",
            &format!("/api/v1/vaults/{vault_id}/members/{admin_id}"),
            json!({}),
            Some(&admin_cookie),
            Some(&admin_csrf),
        )
        .await;
        assert_eq!(owner_removal.status(), StatusCode::FORBIDDEN);

        let promoted_member = request(
            &app,
            "PATCH",
            &format!("/api/v1/vaults/{vault_id}/members/{member_id}"),
            json!({"role": "editor"}),
            Some(&admin_cookie),
            Some(&admin_csrf),
        )
        .await;
        assert_eq!(promoted_member.status(), StatusCode::OK);
        assert_eq!(json_body(promoted_member).await["data"]["role"], "editor");

        // After promotion the resolver reflects the editor capability set: full
        // file/content editing, but no vault-management capabilities.
        let editor_vaults = request(
            &app,
            "GET",
            "/api/v1/vaults",
            json!({}),
            Some(&member_cookie),
            None,
        )
        .await;
        let editor_vaults_body = json_body(editor_vaults).await;
        let editor_caps = capability_tokens(&editor_vaults_body["data"][0]);
        assert!(editor_caps.contains(&"file.write".to_owned()));
        assert!(editor_caps.contains(&"kanban.card.move".to_owned()));
        assert!(editor_caps.contains(&"vault.offlineCopy".to_owned()));
        assert!(!editor_caps.contains(&"vault.managePermissions".to_owned()));
        assert!(!editor_caps.contains(&"vault.manageMembers".to_owned()));

        // --- Phase 3: permission templates, user groups, and vault grants ---

        // Create a custom template granting only read + one kanban capability.
        let template = request(
            &app,
            "POST",
            "/api/v1/admin/templates",
            json!({
                "name": "reviewer",
                "description": "Read and move only",
                "capabilities": ["vault.read", "kanban.card.move"]
            }),
            Some(&admin_cookie),
            Some(&admin_csrf),
        )
        .await;
        assert_eq!(template.status(), StatusCode::CREATED);
        let template_body = json_body(template).await;
        let reviewer_template_id = template_body["data"]["id"].as_str().unwrap().to_owned();
        assert_eq!(template_body["data"]["isBuiltin"], false);
        assert_eq!(
            capability_tokens(&template_body["data"]),
            vec!["vault.read".to_owned(), "kanban.card.move".to_owned()]
        );

        // Unknown capability tokens are rejected.
        let bad_template = request(
            &app,
            "POST",
            "/api/v1/admin/templates",
            json!({"name": "broken", "capabilities": ["vault.read", "not.a.capability"]}),
            Some(&admin_cookie),
            Some(&admin_csrf),
        )
        .await;
        assert_eq!(bad_template.status(), StatusCode::BAD_REQUEST);

        // Built-in templates are read-only.
        let templates = request(
            &app,
            "GET",
            "/api/v1/admin/templates",
            json!({}),
            Some(&admin_cookie),
            None,
        )
        .await;
        let templates_body = json_body(templates).await;
        let builtin_id = templates_body["data"]
            .as_array()
            .unwrap()
            .iter()
            .find(|template| template["isBuiltin"] == json!(true))
            .unwrap()["id"]
            .as_str()
            .unwrap()
            .to_owned();
        let builtin_edit = request(
            &app,
            "PATCH",
            &format!("/api/v1/admin/templates/{builtin_id}"),
            json!({"capabilities": ["vault.read"]}),
            Some(&admin_cookie),
            Some(&admin_csrf),
        )
        .await;
        assert_eq!(builtin_edit.status(), StatusCode::BAD_REQUEST);

        // Create a group and add the invited user to it.
        let group = request(
            &app,
            "POST",
            "/api/v1/admin/groups",
            json!({"name": "Reviewers", "description": "Reviewers group"}),
            Some(&admin_cookie),
            Some(&admin_csrf),
        )
        .await;
        assert_eq!(group.status(), StatusCode::CREATED);
        let group_body = json_body(group).await;
        let group_id = group_body["data"]["id"].as_str().unwrap().to_owned();
        assert_eq!(group_body["data"]["memberCount"], 0);

        let add_to_group = request(
            &app,
            "POST",
            &format!("/api/v1/admin/groups/{group_id}/members/{invited_id}"),
            json!({}),
            Some(&admin_cookie),
            Some(&admin_csrf),
        )
        .await;
        assert_eq!(add_to_group.status(), StatusCode::CREATED);

        let group_members = request(
            &app,
            "GET",
            &format!("/api/v1/admin/groups/{group_id}/members"),
            json!({}),
            Some(&admin_cookie),
            None,
        )
        .await;
        let group_members_body = json_body(group_members).await;
        assert_eq!(group_members_body["data"].as_array().unwrap().len(), 1);
        assert_eq!(group_members_body["data"][0]["userId"], invited_id);

        // Before any grant, the invited user cannot see the admin-owned team vault.
        let invited_before = request(
            &app,
            "GET",
            "/api/v1/vaults",
            json!({}),
            Some(&invited_cookie),
            None,
        )
        .await;
        let invited_before_body = json_body(invited_before).await;
        assert!(invited_before_body["data"]
            .as_array()
            .unwrap()
            .iter()
            .all(|vault| vault["id"] != json!(vault_id)));

        // Grant the group the reviewer template on the team vault.
        let group_grant = request(
            &app,
            "PUT",
            &format!("/api/v1/admin/vaults/{vault_id}/grants/group/{group_id}"),
            json!({"templateId": reviewer_template_id}),
            Some(&admin_cookie),
            Some(&admin_csrf),
        )
        .await;
        assert_eq!(group_grant.status(), StatusCode::OK);
        let group_grant_body = json_body(group_grant).await;
        assert_eq!(group_grant_body["data"]["subjectType"], "group");
        assert_eq!(
            capability_tokens(&group_grant_body["data"]),
            vec!["vault.read".to_owned(), "kanban.card.move".to_owned()]
        );

        // The group grant alone grants access with exactly the template's caps.
        let invited_granted = request(
            &app,
            "GET",
            "/api/v1/vaults",
            json!({}),
            Some(&invited_cookie),
            None,
        )
        .await;
        let invited_granted_body = json_body(invited_granted).await;
        let granted_team = invited_granted_body["data"]
            .as_array()
            .unwrap()
            .iter()
            .find(|vault| vault["id"] == json!(vault_id))
            .cloned()
            .unwrap();
        assert_eq!(
            capability_tokens(&granted_team),
            vec!["vault.read".to_owned(), "kanban.card.move".to_owned()]
        );

        // Adding a direct viewer membership for the same user makes effective
        // access the most-restrictive intersection of the viewer role and the
        // group template, narrowing below both sources to just vault.read.
        let direct_member = request(
            &app,
            "POST",
            &format!("/api/v1/vaults/{vault_id}/members"),
            json!({"userId": invited_id, "role": "viewer"}),
            Some(&admin_cookie),
            Some(&admin_csrf),
        )
        .await;
        assert_eq!(direct_member.status(), StatusCode::CREATED);
        let intersected = request(
            &app,
            "GET",
            "/api/v1/vaults",
            json!({}),
            Some(&invited_cookie),
            None,
        )
        .await;
        let intersected_body = json_body(intersected).await;
        let intersected_team = intersected_body["data"]
            .as_array()
            .unwrap()
            .iter()
            .find(|vault| vault["id"] == json!(vault_id))
            .cloned()
            .unwrap();
        assert_eq!(
            capability_tokens(&intersected_team),
            vec!["vault.read".to_owned()]
        );

        // Listing grants surfaces both the direct user grant and the group grant.
        let grants = request(
            &app,
            "GET",
            &format!("/api/v1/admin/vaults/{vault_id}/grants"),
            json!({}),
            Some(&admin_cookie),
            None,
        )
        .await;
        let grants_body = json_body(grants).await;
        let grant_subjects: Vec<&str> = grants_body["data"]
            .as_array()
            .unwrap()
            .iter()
            .map(|grant| grant["subjectType"].as_str().unwrap())
            .collect();
        assert!(grant_subjects.contains(&"group"));
        assert!(grant_subjects.contains(&"user"));

        // Removing the group grant reverts the user to the viewer-role default.
        let remove_grant = request(
            &app,
            "DELETE",
            &format!("/api/v1/admin/vaults/{vault_id}/grants/group/{group_id}"),
            json!({}),
            Some(&admin_cookie),
            Some(&admin_csrf),
        )
        .await;
        assert_eq!(remove_grant.status(), StatusCode::NO_CONTENT);
        let reverted = request(
            &app,
            "GET",
            "/api/v1/vaults",
            json!({}),
            Some(&invited_cookie),
            None,
        )
        .await;
        let reverted_body = json_body(reverted).await;
        let reverted_team = reverted_body["data"]
            .as_array()
            .unwrap()
            .iter()
            .find(|vault| vault["id"] == json!(vault_id))
            .cloned()
            .unwrap();
        assert_eq!(
            capability_tokens(&reverted_team),
            vec![
                "vault.read".to_owned(),
                "vault.search".to_owned(),
                "vault.viewHistory".to_owned(),
                "vault.viewActivity".to_owned(),
            ]
        );

        // Restore the original team-vault membership set for later assertions.
        let cleanup_member = request(
            &app,
            "DELETE",
            &format!("/api/v1/vaults/{vault_id}/members/{invited_id}"),
            json!({}),
            Some(&admin_cookie),
            Some(&admin_csrf),
        )
        .await;
        assert_eq!(cleanup_member.status(), StatusCode::NO_CONTENT);

        let invalid_path = request(
            &app,
            "POST",
            &format!("/api/v1/vaults/{vault_id}/files"),
            json!({"name": ".collab", "kind": "folder", "content": ""}),
            Some(&admin_cookie),
            Some(&admin_csrf),
        )
        .await;
        assert_eq!(invalid_path.status(), StatusCode::BAD_REQUEST);
        assert_eq!(
            json_body(invalid_path).await["error"]["code"],
            "path_invalid"
        );

        let folder = request(
            &app,
            "POST",
            &format!("/api/v1/vaults/{vault_id}/files"),
            json!({"name": "Notes", "kind": "folder", "content": ""}),
            Some(&member_cookie),
            Some(&member_csrf),
        )
        .await;
        assert_eq!(folder.status(), StatusCode::CREATED);
        let folder_id = json_body(folder).await["data"]["id"]
            .as_str()
            .unwrap()
            .to_owned();

        let document = request(
            &app,
            "POST",
            &format!("/api/v1/vaults/{vault_id}/files"),
            json!({
                "parentId": folder_id,
                "name": "Welcome.md",
                "kind": "document",
                "documentType": "note",
                "content": "# Welcome"
            }),
            Some(&member_cookie),
            Some(&member_csrf),
        )
        .await;
        assert_eq!(document.status(), StatusCode::CREATED);
        let document_body = json_body(document).await;
        let document_id = document_body["data"]["id"].as_str().unwrap().to_owned();
        assert_eq!(document_body["data"]["relativePath"], "Notes/Welcome.md");
        assert_eq!(document_body["data"]["currentRevision"]["sequence"], 1);

        let duplicate_name = request(
            &app,
            "POST",
            &format!("/api/v1/vaults/{vault_id}/files"),
            json!({
                "parentId": folder_id,
                "name": "welcome.md",
                "kind": "document",
                "documentType": "note",
                "content": "duplicate"
            }),
            Some(&member_cookie),
            Some(&member_csrf),
        )
        .await;
        assert_eq!(duplicate_name.status(), StatusCode::CONFLICT);
        assert_eq!(
            json_body(duplicate_name).await["error"]["code"],
            "path_conflict"
        );

        let read_document = request(
            &app,
            "GET",
            &format!("/api/v1/vaults/{vault_id}/files/{document_id}"),
            json!({}),
            Some(&admin_cookie),
            None,
        )
        .await;
        assert_eq!(read_document.status(), StatusCode::OK);
        assert_eq!(
            json_body(read_document).await["data"]["content"],
            "# Welcome"
        );

        let stale_write = request(
            &app,
            "POST",
            &format!("/api/v1/vaults/{vault_id}/files/{document_id}/revisions"),
            json!({"expectedRevisionSequence": 0, "content": "# Stale"}),
            Some(&member_cookie),
            Some(&member_csrf),
        )
        .await;
        assert_eq!(stale_write.status(), StatusCode::CONFLICT);
        assert_eq!(
            json_body(stale_write).await["error"]["code"],
            "revision_conflict"
        );

        let written = request(
            &app,
            "POST",
            &format!("/api/v1/vaults/{vault_id}/files/{document_id}/revisions"),
            json!({"expectedRevisionSequence": 1, "content": "# Updated"}),
            Some(&member_cookie),
            Some(&member_csrf),
        )
        .await;
        assert_eq!(written.status(), StatusCode::CREATED);
        assert_eq!(
            json_body(written).await["data"]["file"]["currentRevision"]["sequence"],
            2
        );

        let manifest = request(
            &app,
            "GET",
            &format!("/api/v1/vaults/{vault_id}/manifest"),
            json!({}),
            Some(&admin_cookie),
            None,
        )
        .await;
        assert_eq!(manifest.status(), StatusCode::OK);
        let manifest_body = json_body(manifest).await;
        assert_eq!(manifest_body["data"]["sequence"], 3);
        assert_eq!(manifest_body["data"]["files"].as_array().unwrap().len(), 2);

        let unchanged_delta = request(
            &app,
            "GET",
            &format!("/api/v1/vaults/{vault_id}/manifest/delta?since=3"),
            json!({}),
            Some(&admin_cookie),
            None,
        )
        .await;
        assert_eq!(unchanged_delta.status(), StatusCode::OK);
        let unchanged_delta_body = json_body(unchanged_delta).await;
        assert_eq!(unchanged_delta_body["data"]["sequence"], 3);
        assert_eq!(
            unchanged_delta_body["data"]["changedFiles"]
                .as_array()
                .unwrap()
                .len(),
            0
        );

        let initial_delta = request(
            &app,
            "GET",
            &format!("/api/v1/vaults/{vault_id}/manifest/delta?since=0"),
            json!({}),
            Some(&admin_cookie),
            None,
        )
        .await;
        assert_eq!(initial_delta.status(), StatusCode::OK);
        let initial_delta_body = json_body(initial_delta).await;
        assert_eq!(initial_delta_body["data"]["sequence"], 3);
        assert_eq!(
            initial_delta_body["data"]["changedFiles"]
                .as_array()
                .unwrap()
                .len(),
            2
        );

        let revisions = request(
            &app,
            "GET",
            &format!("/api/v1/vaults/{vault_id}/files/{document_id}/revisions"),
            json!({}),
            Some(&admin_cookie),
            None,
        )
        .await;
        assert_eq!(revisions.status(), StatusCode::OK);
        let revisions_body = json_body(revisions).await;
        assert_eq!(revisions_body["data"].as_array().unwrap().len(), 2);
        let original_revision_id = revisions_body["data"][1]["id"].as_str().unwrap().to_owned();

        let original_revision = request(
            &app,
            "GET",
            &format!(
                "/api/v1/vaults/{vault_id}/files/{document_id}/revisions/{original_revision_id}"
            ),
            json!({}),
            Some(&admin_cookie),
            None,
        )
        .await;
        assert_eq!(original_revision.status(), StatusCode::OK);
        assert_eq!(
            json_body(original_revision).await["data"]["content"],
            "# Welcome"
        );

        let snapshot = request(
            &app,
            "POST",
            &format!("/api/v1/vaults/{vault_id}/files/{document_id}/snapshots"),
            json!({"revisionId": original_revision_id, "label": "Before update"}),
            Some(&member_cookie),
            Some(&member_csrf),
        )
        .await;
        assert_eq!(snapshot.status(), StatusCode::CREATED);
        let snapshot_body = json_body(snapshot).await;
        let snapshot_id = snapshot_body["data"]["id"].as_str().unwrap().to_owned();
        assert_eq!(snapshot_body["data"]["label"], "Before update");
        assert_eq!(snapshot_body["data"]["revision"]["sequence"], 1);

        let snapshots = request(
            &app,
            "GET",
            &format!("/api/v1/vaults/{vault_id}/files/{document_id}/snapshots"),
            json!({}),
            Some(&admin_cookie),
            None,
        )
        .await;
        assert_eq!(snapshots.status(), StatusCode::OK);
        assert_eq!(
            json_body(snapshots).await["data"].as_array().unwrap().len(),
            1
        );

        let stale_restore = request(
            &app,
            "POST",
            &format!(
                "/api/v1/vaults/{vault_id}/files/{document_id}/snapshots/{snapshot_id}/restore"
            ),
            json!({"expectedRevisionSequence": 1}),
            Some(&member_cookie),
            Some(&member_csrf),
        )
        .await;
        assert_eq!(stale_restore.status(), StatusCode::CONFLICT);
        assert_eq!(
            json_body(stale_restore).await["error"]["code"],
            "revision_conflict"
        );

        let restored = request(
            &app,
            "POST",
            &format!(
                "/api/v1/vaults/{vault_id}/files/{document_id}/snapshots/{snapshot_id}/restore"
            ),
            json!({"expectedRevisionSequence": 2}),
            Some(&member_cookie),
            Some(&member_csrf),
        )
        .await;
        assert_eq!(restored.status(), StatusCode::CREATED);
        let restored_body = json_body(restored).await;
        assert_eq!(restored_body["data"]["content"], "# Welcome");
        assert_eq!(
            restored_body["data"]["file"]["currentRevision"]["sequence"],
            3
        );

        let demoted_member = request(
            &app,
            "PATCH",
            &format!("/api/v1/vaults/{vault_id}/members/{member_id}"),
            json!({"role": "viewer"}),
            Some(&admin_cookie),
            Some(&admin_csrf),
        )
        .await;
        assert_eq!(demoted_member.status(), StatusCode::OK);

        let viewer_storage = request(
            &app,
            "GET",
            &format!("/api/v1/vaults/{vault_id}/storage"),
            json!({}),
            Some(&member_cookie),
            None,
        )
        .await;
        assert_eq!(viewer_storage.status(), StatusCode::OK);
        let viewer_storage_body = json_body(viewer_storage).await;
        assert!(viewer_storage_body["data"]["activeBytes"].as_u64().unwrap() > 0);
        assert!(
            viewer_storage_body["data"]["retainedRevisionBytes"]
                .as_u64()
                .unwrap()
                >= viewer_storage_body["data"]["uniqueBlobBytes"]
                    .as_u64()
                    .unwrap()
        );
        assert_eq!(viewer_storage_body["data"]["snapshotCount"], 1);

        let viewer_mutation_cases = [
            (
                "PATCH",
                format!("/api/v1/vaults/{vault_id}"),
                json!({"name": "Denied"}),
            ),
            ("DELETE", format!("/api/v1/vaults/{vault_id}"), json!({})),
            (
                "POST",
                format!("/api/v1/vaults/{vault_id}/members"),
                json!({"userId": admin_id, "role": "viewer"}),
            ),
            (
                "PATCH",
                format!("/api/v1/vaults/{vault_id}/members/{member_id}"),
                json!({"role": "editor"}),
            ),
            (
                "DELETE",
                format!("/api/v1/vaults/{vault_id}/members/{member_id}"),
                json!({}),
            ),
            (
                "POST",
                format!("/api/v1/vaults/{vault_id}/files"),
                json!({"name": "Denied", "kind": "folder", "content": ""}),
            ),
            (
                "POST",
                format!("/api/v1/vaults/{vault_id}/files/{document_id}/revisions"),
                json!({"expectedRevisionSequence": 3, "content": "Denied"}),
            ),
            (
                "POST",
                format!("/api/v1/vaults/{vault_id}/files/{document_id}/snapshots"),
                json!({"label": "Denied"}),
            ),
            (
                "POST",
                format!(
                    "/api/v1/vaults/{vault_id}/files/{document_id}/snapshots/{snapshot_id}/restore"
                ),
                json!({"expectedRevisionSequence": 3}),
            ),
            (
                "POST",
                format!("/api/v1/vaults/{vault_id}/uploads"),
                json!({
                    "name": "denied.bin",
                    "mediaType": "application/octet-stream",
                    "contentBase64": "",
                    "expectedHash": "0".repeat(64)
                }),
            ),
            (
                "POST",
                format!("/api/v1/vaults/{vault_id}/operations"),
                json!({
                    "clientOperationId": Uuid::now_v7(),
                    "baseManifestSequence": 0,
                    "operationType": "trash",
                    "targetFileId": document_id
                }),
            ),
            (
                "POST",
                format!("/api/v1/vaults/{vault_id}/operations/preview"),
                json!({"operationType": "trash", "targetFileId": document_id}),
            ),
            (
                "POST",
                format!("/api/v1/vaults/{vault_id}/import"),
                json!({"archiveBase64": ""}),
            ),
            (
                "GET",
                format!("/api/v1/vaults/{vault_id}/export"),
                json!({}),
            ),
        ];
        for (method, uri, body) in viewer_mutation_cases {
            let denied = request(
                &app,
                method,
                &uri,
                body,
                Some(&member_cookie),
                Some(&member_csrf),
            )
            .await;
            assert_eq!(
                denied.status(),
                StatusCode::FORBIDDEN,
                "viewer unexpectedly accessed {method} {uri}"
            );
            assert_eq!(
                json_body(denied).await["error"]["code"],
                "vault_permission_denied"
            );
        }

        let re_promoted_member = request(
            &app,
            "PATCH",
            &format!("/api/v1/vaults/{vault_id}/members/{member_id}"),
            json!({"role": "editor"}),
            Some(&admin_cookie),
            Some(&admin_csrf),
        )
        .await;
        assert_eq!(re_promoted_member.status(), StatusCode::OK);

        for (method, uri, body) in [
            (
                "PATCH",
                format!("/api/v1/vaults/{vault_id}"),
                json!({"name": "Denied editor rename"}),
            ),
            ("DELETE", format!("/api/v1/vaults/{vault_id}"), json!({})),
            (
                "POST",
                format!("/api/v1/vaults/{vault_id}/members"),
                json!({"userId": admin_id, "role": "viewer"}),
            ),
        ] {
            let denied = request(
                &app,
                method,
                &uri,
                body,
                Some(&member_cookie),
                Some(&member_csrf),
            )
            .await;
            assert_eq!(
                denied.status(),
                StatusCode::FORBIDDEN,
                "editor unexpectedly accessed admin/owner operation {method} {uri}"
            );
        }

        let bad_asset = request(
            &app,
            "POST",
            &format!("/api/v1/vaults/{vault_id}/uploads"),
            json!({
                "name": "bad.bin",
                "mediaType": "application/octet-stream",
                "contentBase64": "YXNzZXQgYnl0ZXM=",
                "expectedHash": "0".repeat(64)
            }),
            Some(&member_cookie),
            Some(&member_csrf),
        )
        .await;
        assert_eq!(bad_asset.status(), StatusCode::UNPROCESSABLE_ENTITY);
        assert_eq!(
            json_body(bad_asset).await["error"]["code"],
            "upload_hash_mismatch"
        );

        let asset_hash = hash_secret("asset bytes");
        let asset = request(
            &app,
            "POST",
            &format!("/api/v1/vaults/{vault_id}/uploads"),
            json!({
                "parentId": folder_id,
                "name": "diagram.bin",
                "mediaType": "application/octet-stream",
                "contentBase64": "YXNzZXQgYnl0ZXM=",
                "expectedHash": asset_hash
            }),
            Some(&member_cookie),
            Some(&member_csrf),
        )
        .await;
        assert_eq!(asset.status(), StatusCode::CREATED);
        let asset_body = json_body(asset).await;
        let asset_id = asset_body["data"]["id"].as_str().unwrap().to_owned();
        assert_eq!(asset_body["data"]["kind"], "asset");
        assert_eq!(
            asset_body["data"]["currentRevision"]["contentHash"],
            asset_hash
        );

        let duplicate_asset = request(
            &app,
            "POST",
            &format!("/api/v1/vaults/{vault_id}/uploads"),
            json!({
                "parentId": folder_id,
                "name": "diagram-copy.bin",
                "mediaType": "application/octet-stream",
                "contentBase64": "YXNzZXQgYnl0ZXM=",
                "expectedHash": asset_hash
            }),
            Some(&member_cookie),
            Some(&member_csrf),
        )
        .await;
        assert_eq!(duplicate_asset.status(), StatusCode::CREATED);
        let blob_count = sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM hosted_blobs")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(blob_count, 5);

        let downloaded = request(
            &app,
            "GET",
            &format!("/api/v1/vaults/{vault_id}/files/{asset_id}/content"),
            json!({}),
            Some(&admin_cookie),
            None,
        )
        .await;
        assert_eq!(downloaded.status(), StatusCode::OK);
        assert_eq!(
            downloaded.headers()[header::CONTENT_TYPE],
            "application/octet-stream"
        );
        assert_eq!(response_bytes(downloaded).await, b"asset bytes");

        let index_note = request(
            &app,
            "POST",
            &format!("/api/v1/vaults/{vault_id}/files"),
            json!({
                "name": "Index.md",
                "kind": "document",
                "documentType": "note",
                "content": "Link: [welcome](Notes/Welcome.md) and ![[diagram.bin]]"
            }),
            Some(&member_cookie),
            Some(&member_csrf),
        )
        .await;
        assert_eq!(index_note.status(), StatusCode::CREATED);
        let index_id = json_body(index_note).await["data"]["id"]
            .as_str()
            .unwrap()
            .to_owned();

        let hosted_search = request(
            &app,
            "GET",
            &format!("/api/v1/vaults/{vault_id}/search?q=Link"),
            json!({}),
            Some(&member_cookie),
            None,
        )
        .await;
        assert_eq!(hosted_search.status(), StatusCode::OK);
        let hosted_search_body = json_body(hosted_search).await;
        assert_eq!(hosted_search_body["data"].as_array().unwrap().len(), 1);
        assert_eq!(hosted_search_body["data"][0]["fileId"], index_id);
        assert_eq!(hosted_search_body["data"][0]["relativePath"], "Index.md");
        assert_eq!(hosted_search_body["data"][0]["title"], "Index");
        assert!(hosted_search_body["data"][0]["excerpt"]
            .as_str()
            .unwrap()
            .contains("Link"));

        let asset_references = request(
            &app,
            "GET",
            &format!("/api/v1/vaults/{vault_id}/files/{asset_id}/references"),
            json!({}),
            Some(&admin_cookie),
            None,
        )
        .await;
        assert_eq!(asset_references.status(), StatusCode::OK);
        let asset_references_body = json_body(asset_references).await;
        let asset_reference_list = asset_references_body["data"].as_array().unwrap();
        assert_eq!(asset_reference_list.len(), 1);
        assert_eq!(asset_reference_list[0]["sourceRelativePath"], "Index.md");
        assert_eq!(asset_reference_list[0]["referencedFileId"], asset_id);
        assert_eq!(
            asset_reference_list[0]["referencedRelativePath"],
            "Notes/diagram.bin"
        );

        let demoted_for_preview = request(
            &app,
            "PATCH",
            &format!("/api/v1/vaults/{vault_id}/members/{member_id}"),
            json!({"role": "viewer"}),
            Some(&admin_cookie),
            Some(&admin_csrf),
        )
        .await;
        assert_eq!(demoted_for_preview.status(), StatusCode::OK);
        let viewer_preview = request(
            &app,
            "POST",
            &format!("/api/v1/vaults/{vault_id}/operations/preview"),
            json!({
                "operationType": "rename",
                "targetFileId": document_id,
                "name": "Renamed.md"
            }),
            Some(&member_cookie),
            Some(&member_csrf),
        )
        .await;
        assert_eq!(viewer_preview.status(), StatusCode::FORBIDDEN);
        assert_eq!(
            json_body(viewer_preview).await["error"]["code"],
            "vault_permission_denied"
        );
        let viewer_references = request(
            &app,
            "GET",
            &format!("/api/v1/vaults/{vault_id}/files/{asset_id}/references"),
            json!({}),
            Some(&member_cookie),
            None,
        )
        .await;
        assert_eq!(viewer_references.status(), StatusCode::OK);
        let promoted_after_preview = request(
            &app,
            "PATCH",
            &format!("/api/v1/vaults/{vault_id}/members/{member_id}"),
            json!({"role": "editor"}),
            Some(&admin_cookie),
            Some(&admin_csrf),
        )
        .await;
        assert_eq!(promoted_after_preview.status(), StatusCode::OK);

        let rename_preview = request(
            &app,
            "POST",
            &format!("/api/v1/vaults/{vault_id}/operations/preview"),
            json!({
                "operationType": "rename",
                "targetFileId": document_id,
                "name": "Renamed.md"
            }),
            Some(&member_cookie),
            Some(&member_csrf),
        )
        .await;
        assert_eq!(rename_preview.status(), StatusCode::OK);
        let rename_preview_body = json_body(rename_preview).await;
        assert_eq!(
            rename_preview_body["data"]["oldRelativePath"],
            "Notes/Welcome.md"
        );
        assert_eq!(
            rename_preview_body["data"]["newRelativePath"],
            "Notes/Renamed.md"
        );
        assert_eq!(rename_preview_body["data"]["blockedReason"], Value::Null);
        assert_eq!(rename_preview_body["data"]["nestedItemCount"], 0);
        let preview_affected = rename_preview_body["data"]["affectedDocuments"]
            .as_array()
            .unwrap();
        assert_eq!(preview_affected.len(), 1);
        assert_eq!(preview_affected[0]["fileId"], index_id);
        assert_eq!(preview_affected[0]["relativePath"], "Index.md");

        let blocked_preview = request(
            &app,
            "POST",
            &format!("/api/v1/vaults/{vault_id}/operations/preview"),
            json!({
                "operationType": "rename",
                "targetFileId": document_id,
                "name": "diagram.bin"
            }),
            Some(&member_cookie),
            Some(&member_csrf),
        )
        .await;
        assert_eq!(blocked_preview.status(), StatusCode::OK);
        let blocked_preview_body = json_body(blocked_preview).await;
        assert_eq!(
            blocked_preview_body["data"]["blockedReason"],
            "The destination path already exists."
        );
        assert_eq!(blocked_preview_body["data"]["affectedDocuments"], json!([]));

        let rename_operation_id = Uuid::now_v7();
        let rename_payload = json!({
            "clientOperationId": rename_operation_id,
            "baseManifestSequence": 7,
            "operationType": "rename",
            "targetFileId": document_id,
            "name": "Renamed.md"
        });
        let renamed = request(
            &app,
            "POST",
            &format!("/api/v1/vaults/{vault_id}/operations"),
            rename_payload.clone(),
            Some(&member_cookie),
            Some(&member_csrf),
        )
        .await;
        assert_eq!(renamed.status(), StatusCode::OK);
        let renamed_body = json_body(renamed).await;
        assert_eq!(renamed_body["data"]["resultManifestSequence"], 8);
        assert_eq!(
            renamed_body["data"]["rewrittenDocumentIds"],
            json!([index_id])
        );

        let rewritten_index = request(
            &app,
            "GET",
            &format!("/api/v1/vaults/{vault_id}/files/{index_id}"),
            json!({}),
            Some(&admin_cookie),
            None,
        )
        .await;
        let rewritten_index_body = json_body(rewritten_index).await;
        assert_eq!(
            rewritten_index_body["data"]["content"],
            "Link: [welcome](Notes/Renamed.md) and ![[diagram.bin]]"
        );
        assert_eq!(
            rewritten_index_body["data"]["file"]["currentRevision"]["sequence"],
            2
        );

        let rewritten_search = request(
            &app,
            "GET",
            &format!("/api/v1/vaults/{vault_id}/search?q=Renamed.md"),
            json!({}),
            Some(&admin_cookie),
            None,
        )
        .await;
        assert_eq!(rewritten_search.status(), StatusCode::OK);
        let rewritten_search_body = json_body(rewritten_search).await;
        assert_eq!(rewritten_search_body["data"].as_array().unwrap().len(), 1);
        assert_eq!(rewritten_search_body["data"][0]["fileId"], index_id);

        let repeated_rename = request(
            &app,
            "POST",
            &format!("/api/v1/vaults/{vault_id}/operations"),
            rename_payload,
            Some(&member_cookie),
            Some(&member_csrf),
        )
        .await;
        assert_eq!(repeated_rename.status(), StatusCode::OK);
        let repeated_rename_body = json_body(repeated_rename).await;
        assert_eq!(repeated_rename_body["data"]["alreadyApplied"], true);
        assert_eq!(
            repeated_rename_body["data"]["rewrittenDocumentIds"],
            json!([index_id])
        );

        let stale_move = request(
            &app,
            "POST",
            &format!("/api/v1/vaults/{vault_id}/operations"),
            json!({
                "clientOperationId": Uuid::now_v7(),
                "baseManifestSequence": 6,
                "operationType": "move",
                "targetFileId": document_id,
                "parentId": null
            }),
            Some(&member_cookie),
            Some(&member_csrf),
        )
        .await;
        assert_eq!(stale_move.status(), StatusCode::CONFLICT);
        assert_eq!(
            json_body(stale_move).await["error"]["code"],
            "manifest_conflict"
        );

        let moved = request(
            &app,
            "POST",
            &format!("/api/v1/vaults/{vault_id}/operations"),
            json!({
                "clientOperationId": Uuid::now_v7(),
                "baseManifestSequence": 8,
                "operationType": "move",
                "targetFileId": document_id,
                "parentId": null
            }),
            Some(&member_cookie),
            Some(&member_csrf),
        )
        .await;
        assert_eq!(moved.status(), StatusCode::OK);
        assert_eq!(
            json_body(moved).await["data"]["rewrittenDocumentIds"],
            json!([index_id])
        );

        let moved_manifest = request(
            &app,
            "GET",
            &format!("/api/v1/vaults/{vault_id}/manifest"),
            json!({}),
            Some(&admin_cookie),
            None,
        )
        .await;
        let moved_manifest_body = json_body(moved_manifest).await;
        let moved_document = moved_manifest_body["data"]["files"]
            .as_array()
            .unwrap()
            .iter()
            .find(|file| file["id"] == document_id)
            .unwrap();
        assert_eq!(moved_document["relativePath"], "Renamed.md");

        let moved_delta = request(
            &app,
            "GET",
            &format!("/api/v1/vaults/{vault_id}/manifest/delta?since=8"),
            json!({}),
            Some(&admin_cookie),
            None,
        )
        .await;
        assert_eq!(moved_delta.status(), StatusCode::OK);
        let moved_delta_body = json_body(moved_delta).await;
        let moved_delta_files = moved_delta_body["data"]["changedFiles"].as_array().unwrap();
        assert!(moved_delta_files
            .iter()
            .any(|file| file["id"] == document_id && file["relativePath"] == "Renamed.md"));

        for (operation_type, sequence) in [("trash", 9), ("restore", 10)] {
            let response = request(
                &app,
                "POST",
                &format!("/api/v1/vaults/{vault_id}/operations"),
                json!({
                    "clientOperationId": Uuid::now_v7(),
                    "baseManifestSequence": sequence,
                    "operationType": operation_type,
                    "targetFileId": document_id
                }),
                Some(&member_cookie),
                Some(&member_csrf),
            )
            .await;
            assert_eq!(response.status(), StatusCode::OK);
        }

        let trash_with_reference_removal = request(
            &app,
            "POST",
            &format!("/api/v1/vaults/{vault_id}/operations"),
            json!({
                "clientOperationId": Uuid::now_v7(),
                "baseManifestSequence": 11,
                "operationType": "trash",
                "targetFileId": document_id,
                "removeReferences": true
            }),
            Some(&member_cookie),
            Some(&member_csrf),
        )
        .await;
        assert_eq!(trash_with_reference_removal.status(), StatusCode::OK);
        assert_eq!(
            json_body(trash_with_reference_removal).await["data"]["rewrittenDocumentIds"],
            json!([index_id])
        );
        let trashed_manifest = request(
            &app,
            "GET",
            &format!("/api/v1/vaults/{vault_id}/manifest"),
            json!({}),
            Some(&admin_cookie),
            None,
        )
        .await;
        let trashed_manifest_body = json_body(trashed_manifest).await;
        let trashed_document = trashed_manifest_body["data"]["files"]
            .as_array()
            .unwrap()
            .iter()
            .find(|file| file["id"] == document_id)
            .unwrap();
        assert_eq!(trashed_document["state"], "trashed");
        assert!(trashed_document["trashedByDisplayName"].is_string());
        assert!(trashed_document["trashedAt"].is_string());
        let scrubbed_index = request(
            &app,
            "GET",
            &format!("/api/v1/vaults/{vault_id}/files/{index_id}"),
            json!({}),
            Some(&admin_cookie),
            None,
        )
        .await;
        let scrubbed_index_body = json_body(scrubbed_index).await;
        assert_eq!(
            scrubbed_index_body["data"]["content"],
            "Link: welcome and ![[diagram.bin]]"
        );
        assert_eq!(
            scrubbed_index_body["data"]["file"]["currentRevision"]["sequence"],
            4
        );

        let editor_purge = request(
            &app,
            "POST",
            &format!("/api/v1/vaults/{vault_id}/operations"),
            json!({
                "clientOperationId": Uuid::now_v7(),
                "baseManifestSequence": 12,
                "operationType": "purge",
                "targetFileId": document_id
            }),
            Some(&member_cookie),
            Some(&member_csrf),
        )
        .await;
        assert_eq!(editor_purge.status(), StatusCode::FORBIDDEN);

        let admin_purge = request(
            &app,
            "POST",
            &format!("/api/v1/vaults/{vault_id}/operations"),
            json!({
                "clientOperationId": Uuid::now_v7(),
                "baseManifestSequence": 12,
                "operationType": "purge",
                "targetFileId": document_id
            }),
            Some(&admin_cookie),
            Some(&admin_csrf),
        )
        .await;
        assert_eq!(admin_purge.status(), StatusCode::OK);
        assert_eq!(
            json_body(admin_purge).await["data"]["resultManifestSequence"],
            13
        );

        let import_vault = request(
            &app,
            "POST",
            "/api/v1/vaults",
            json!({"name": "Imported Vault"}),
            Some(&admin_cookie),
            Some(&admin_csrf),
        )
        .await;
        assert_eq!(import_vault.status(), StatusCode::CREATED);
        let import_vault_id = json_body(import_vault).await["data"]["id"]
            .as_str()
            .unwrap()
            .to_owned();
        let import_member = request(
            &app,
            "POST",
            &format!("/api/v1/vaults/{import_vault_id}/members"),
            json!({"userId": member_id, "role": "editor"}),
            Some(&admin_cookie),
            Some(&admin_csrf),
        )
        .await;
        assert_eq!(import_member.status(), StatusCode::CREATED);
        let denied_import = request(
            &app,
            "POST",
            &format!("/api/v1/vaults/{import_vault_id}/import"),
            json!({"archiveBase64": zip_base64(&[("Denied.md", b"denied")])}),
            Some(&member_cookie),
            Some(&member_csrf),
        )
        .await;
        assert_eq!(denied_import.status(), StatusCode::FORBIDDEN);
        let imported = request(
            &app,
            "POST",
            &format!("/api/v1/vaults/{import_vault_id}/import"),
            json!({"archiveBase64": zip_base64(&[
                ("Notes/Imported.md", b"# Imported\nsearchable archive"),
                ("Pictures/image.bin", b"asset")
            ])}),
            Some(&admin_cookie),
            Some(&admin_csrf),
        )
        .await;
        assert_eq!(imported.status(), StatusCode::CREATED);
        let imported_body = json_body(imported).await;
        assert_eq!(imported_body["data"]["importedFiles"], 2);
        assert_eq!(imported_body["data"]["importedFolders"], 2);

        let imported_search = request(
            &app,
            "GET",
            &format!("/api/v1/vaults/{import_vault_id}/search?q=searchable"),
            json!({}),
            Some(&admin_cookie),
            None,
        )
        .await;
        assert_eq!(imported_search.status(), StatusCode::OK);
        assert_eq!(
            json_body(imported_search).await["data"][0]["relativePath"],
            "Notes/Imported.md"
        );

        let exported = request(
            &app,
            "GET",
            &format!("/api/v1/vaults/{import_vault_id}/export"),
            json!({}),
            Some(&admin_cookie),
            None,
        )
        .await;
        assert_eq!(exported.status(), StatusCode::OK);
        assert_eq!(exported.headers()[header::CONTENT_TYPE], "application/zip");
        let exported_bytes = response_bytes(exported).await;
        let mut exported_zip = zip::ZipArchive::new(Cursor::new(exported_bytes)).unwrap();
        let mut imported_note = String::new();
        exported_zip
            .by_name("Notes/Imported.md")
            .unwrap()
            .read_to_string(&mut imported_note)
            .unwrap();
        assert_eq!(imported_note, "# Imported\nsearchable archive");
        let denied_export = request(
            &app,
            "GET",
            &format!("/api/v1/vaults/{import_vault_id}/export"),
            json!({}),
            Some(&member_cookie),
            None,
        )
        .await;
        assert_eq!(denied_export.status(), StatusCode::FORBIDDEN);

        // Downloading a single folder yields a ZIP rooted at that folder.
        let manifest = request(
            &app,
            "GET",
            &format!("/api/v1/vaults/{import_vault_id}/manifest"),
            json!({}),
            Some(&admin_cookie),
            None,
        )
        .await;
        assert_eq!(manifest.status(), StatusCode::OK);
        let manifest_body = json_body(manifest).await;
        let notes_folder_id = manifest_body["data"]["files"]
            .as_array()
            .unwrap()
            .iter()
            .find(|file| file["relativePath"] == "Notes" && file["kind"] == "folder")
            .and_then(|file| file["id"].as_str())
            .unwrap()
            .to_owned();
        let folder_archive = request(
            &app,
            "GET",
            &format!("/api/v1/vaults/{import_vault_id}/files/{notes_folder_id}/archive"),
            json!({}),
            Some(&admin_cookie),
            None,
        )
        .await;
        assert_eq!(folder_archive.status(), StatusCode::OK);
        assert_eq!(
            folder_archive.headers()[header::CONTENT_TYPE],
            "application/zip"
        );
        let folder_bytes = response_bytes(folder_archive).await;
        let mut folder_zip = zip::ZipArchive::new(Cursor::new(folder_bytes)).unwrap();
        let mut folder_note = String::new();
        folder_zip
            .by_name("Notes/Imported.md")
            .unwrap()
            .read_to_string(&mut folder_note)
            .unwrap();
        assert_eq!(folder_note, "# Imported\nsearchable archive");
        // The unrelated Pictures asset must not leak into a Notes-only archive.
        assert!(folder_zip.by_name("Pictures/image.bin").is_err());

        let chat_message_id = Uuid::now_v7();
        let sent_chat = request(
            &app,
            "POST",
            &format!("/api/v1/vaults/{vault_id}/chat"),
            json!({
                "id": chat_message_id,
                "content": "Hello from hosted chat"
            }),
            Some(&member_cookie),
            Some(&member_csrf),
        )
        .await;
        assert_eq!(sent_chat.status(), StatusCode::CREATED);
        let sent_chat_body = json_body(sent_chat).await;
        assert_eq!(sent_chat_body["data"]["id"], chat_message_id.to_string());
        assert_eq!(sent_chat_body["data"]["userId"], member_id);
        assert_eq!(sent_chat_body["data"]["userName"], "Member");
        assert_eq!(sent_chat_body["data"]["content"], "Hello from hosted chat");
        assert!(sent_chat_body["data"]["timestamp"].as_u64().unwrap() > 0);

        let listed_chat = request(
            &app,
            "GET",
            &format!("/api/v1/vaults/{vault_id}/chat?limit=10"),
            json!({}),
            Some(&admin_cookie),
            None,
        )
        .await;
        assert_eq!(listed_chat.status(), StatusCode::OK);
        let listed_chat_body = json_body(listed_chat).await;
        assert_eq!(
            listed_chat_body["data"][0]["id"],
            chat_message_id.to_string()
        );
        assert_eq!(listed_chat_body["data"][0]["userId"], member_id);

        let wrote_presence = request(
            &app,
            "PUT",
            &format!("/api/v1/vaults/{vault_id}/presence"),
            json!({
                "activeFile": "Notes/Imported.md",
                "cursorLine": 7,
                "chatTypingUntil": 123456,
                "appVersion": "1.2.3"
            }),
            Some(&member_cookie),
            Some(&member_csrf),
        )
        .await;
        assert_eq!(wrote_presence.status(), StatusCode::NO_CONTENT);

        let listed_presence = request(
            &app,
            "GET",
            &format!("/api/v1/vaults/{vault_id}/presence"),
            json!({}),
            Some(&admin_cookie),
            None,
        )
        .await;
        assert_eq!(listed_presence.status(), StatusCode::OK);
        let listed_presence_body = json_body(listed_presence).await;
        let presence = listed_presence_body["data"].as_array().unwrap();
        assert_eq!(presence.len(), 1);
        assert_eq!(presence[0]["userId"], member_id);
        assert_eq!(presence[0]["userName"], "Member");
        assert_eq!(presence[0]["activeFile"], "Notes/Imported.md");
        assert_eq!(presence[0]["cursorLine"], 7);
        assert_eq!(presence[0]["chatTypingUntil"], 123456);
        assert_eq!(presence[0]["appVersion"], "1.2.3");
        assert!(presence[0]["lastSeen"].as_u64().unwrap() > 0);

        let presence_overview = request(
            &app,
            "GET",
            "/api/v1/admin/overview",
            json!({}),
            Some(&admin_cookie),
            None,
        )
        .await;
        assert_eq!(presence_overview.status(), StatusCode::OK);
        assert_eq!(
            json_body(presence_overview).await["data"]["liveCollaboration"]["activePresenceUsers"],
            1
        );

        let empty_chat = request(
            &app,
            "POST",
            &format!("/api/v1/vaults/{vault_id}/chat"),
            json!({
                "id": Uuid::now_v7(),
                "content": "   "
            }),
            Some(&member_cookie),
            Some(&member_csrf),
        )
        .await;
        assert_eq!(empty_chat.status(), StatusCode::BAD_REQUEST);

        let archived = request(
            &app,
            "PATCH",
            &format!("/api/v1/vaults/{vault_id}"),
            json!({"status": "archived"}),
            Some(&admin_cookie),
            Some(&admin_csrf),
        )
        .await;
        assert_eq!(archived.status(), StatusCode::OK);
        assert_eq!(json_body(archived).await["data"]["status"], "archived");

        let archived_member_mutation = request(
            &app,
            "PATCH",
            &format!("/api/v1/vaults/{vault_id}/members/{member_id}"),
            json!({"role": "viewer"}),
            Some(&admin_cookie),
            Some(&admin_csrf),
        )
        .await;
        assert_eq!(archived_member_mutation.status(), StatusCode::CONFLICT);
        assert_eq!(
            json_body(archived_member_mutation).await["error"]["code"],
            "vault_archived"
        );

        let archived_write = request(
            &app,
            "POST",
            &format!("/api/v1/vaults/{vault_id}/files/{document_id}/revisions"),
            json!({"expectedRevisionSequence": 2, "content": "# Archived"}),
            Some(&member_cookie),
            Some(&member_csrf),
        )
        .await;
        assert_eq!(archived_write.status(), StatusCode::CONFLICT);
        assert_eq!(
            json_body(archived_write).await["error"]["code"],
            "vault_archived"
        );

        let activity = request(
            &app,
            "GET",
            &format!("/api/v1/vaults/{vault_id}/activity"),
            json!({}),
            Some(&member_cookie),
            None,
        )
        .await;
        assert_eq!(activity.status(), StatusCode::OK);
        assert!(json_body(activity).await["data"].as_array().unwrap().len() >= 4);

        let pending_delete = request(
            &app,
            "DELETE",
            &format!("/api/v1/vaults/{vault_id}"),
            json!({}),
            Some(&admin_cookie),
            Some(&admin_csrf),
        )
        .await;
        assert_eq!(pending_delete.status(), StatusCode::NO_CONTENT);
        let pending_detail = request(
            &app,
            "GET",
            &format!("/api/v1/vaults/{vault_id}"),
            json!({}),
            Some(&admin_cookie),
            None,
        )
        .await;
        assert_eq!(
            json_body(pending_detail).await["data"]["status"],
            "pending_delete"
        );

        let member_admin_vault = request(
            &app,
            "GET",
            &format!("/api/v1/admin/vaults/{vault_id}"),
            json!({}),
            Some(&member_cookie),
            None,
        )
        .await;
        assert_eq!(member_admin_vault.status(), StatusCode::FORBIDDEN);

        let admin_detail = request(
            &app,
            "GET",
            &format!("/api/v1/admin/vaults/{vault_id}"),
            json!({}),
            Some(&admin_cookie),
            None,
        )
        .await;
        assert_eq!(admin_detail.status(), StatusCode::OK);
        let admin_detail_body = json_body(admin_detail).await;
        assert_eq!(admin_detail_body["data"]["name"], "Team Vault");
        assert_eq!(admin_detail_body["data"]["status"], "pending_delete");
        assert_eq!(admin_detail_body["data"]["members"], 2);
        assert_eq!(admin_detail_body["data"]["activeFiles"], 4);
        assert_eq!(admin_detail_body["data"]["ownerUsername"], "admin");
        assert!(admin_detail_body["data"]["storageBytes"].as_u64().unwrap() > 0);

        let pending_member_change = request(
            &app,
            "PATCH",
            &format!("/api/v1/admin/vaults/{vault_id}/members/{member_id}"),
            json!({"role": "viewer"}),
            Some(&admin_cookie),
            Some(&admin_csrf),
        )
        .await;
        assert_eq!(pending_member_change.status(), StatusCode::CONFLICT);
        assert_eq!(
            json_body(pending_member_change).await["error"]["code"],
            "vault_archived"
        );

        let admin_restore = request(
            &app,
            "PATCH",
            &format!("/api/v1/admin/vaults/{vault_id}"),
            json!({"status": "active"}),
            Some(&admin_cookie),
            Some(&admin_csrf),
        )
        .await;
        assert_eq!(admin_restore.status(), StatusCode::OK);
        assert_eq!(json_body(admin_restore).await["data"]["status"], "active");

        let owner_role_change = request(
            &app,
            "PATCH",
            &format!("/api/v1/admin/vaults/{vault_id}/members/{admin_id}"),
            json!({"role": "viewer"}),
            Some(&admin_cookie),
            Some(&admin_csrf),
        )
        .await;
        assert_eq!(owner_role_change.status(), StatusCode::BAD_REQUEST);

        let admin_role_change = request(
            &app,
            "PATCH",
            &format!("/api/v1/admin/vaults/{vault_id}/members/{member_id}"),
            json!({"role": "viewer"}),
            Some(&admin_cookie),
            Some(&admin_csrf),
        )
        .await;
        assert_eq!(admin_role_change.status(), StatusCode::OK);
        assert_eq!(json_body(admin_role_change).await["data"]["role"], "viewer");

        let admin_member_removal = request(
            &app,
            "DELETE",
            &format!("/api/v1/admin/vaults/{vault_id}/members/{member_id}"),
            json!({}),
            Some(&admin_cookie),
            Some(&admin_csrf),
        )
        .await;
        assert_eq!(admin_member_removal.status(), StatusCode::NO_CONTENT);

        let admin_member_add = request(
            &app,
            "POST",
            &format!("/api/v1/admin/vaults/{vault_id}/members"),
            json!({"userId": member_id, "role": "editor"}),
            Some(&admin_cookie),
            Some(&admin_csrf),
        )
        .await;
        assert_eq!(admin_member_add.status(), StatusCode::CREATED);
        let admin_members = request(
            &app,
            "GET",
            &format!("/api/v1/admin/vaults/{vault_id}/members"),
            json!({}),
            Some(&admin_cookie),
            None,
        )
        .await;
        assert_eq!(admin_members.status(), StatusCode::OK);
        assert_eq!(
            json_body(admin_members).await["data"]
                .as_array()
                .unwrap()
                .len(),
            2
        );

        let admin_archive = request(
            &app,
            "PATCH",
            &format!("/api/v1/admin/vaults/{vault_id}"),
            json!({"status": "archived"}),
            Some(&admin_cookie),
            Some(&admin_csrf),
        )
        .await;
        assert_eq!(admin_archive.status(), StatusCode::OK);
        assert_eq!(json_body(admin_archive).await["data"]["status"], "archived");

        let admin_vault_activity = request(
            &app,
            "GET",
            &format!("/api/v1/admin/vaults/{vault_id}/activity"),
            json!({}),
            Some(&admin_cookie),
            None,
        )
        .await;
        assert_eq!(admin_vault_activity.status(), StatusCode::OK);
        assert!(
            json_body(admin_vault_activity).await["data"]
                .as_array()
                .unwrap()
                .len()
                >= 6
        );

        let admin_redelete = request(
            &app,
            "DELETE",
            &format!("/api/v1/admin/vaults/{vault_id}"),
            json!({}),
            Some(&admin_cookie),
            Some(&admin_csrf),
        )
        .await;
        assert_eq!(admin_redelete.status(), StatusCode::NO_CONTENT);
        let redeleted_detail = request(
            &app,
            "GET",
            &format!("/api/v1/admin/vaults/{vault_id}"),
            json!({}),
            Some(&admin_cookie),
            None,
        )
        .await;
        assert_eq!(
            json_body(redeleted_detail).await["data"]["status"],
            "pending_delete"
        );

        let disabled = request(
            &app,
            "PATCH",
            &format!("/api/v1/admin/users/{member_id}"),
            json!({"disabled": true}),
            Some(&admin_cookie),
            Some(&admin_csrf),
        )
        .await;
        assert_eq!(disabled.status(), StatusCode::OK);
        let revoked_me = request(
            &app,
            "GET",
            "/api/v1/users/me",
            json!({}),
            Some(&member_cookie),
            None,
        )
        .await;
        assert_eq!(revoked_me.status(), StatusCode::UNAUTHORIZED);

        let primary_disable = request(
            &app,
            "PATCH",
            &format!("/api/v1/admin/users/{admin_id}"),
            json!({"disabled": true}),
            Some(&admin_cookie),
            Some(&admin_csrf),
        )
        .await;
        assert_eq!(primary_disable.status(), StatusCode::BAD_REQUEST);
        let primary_delete = request(
            &app,
            "DELETE",
            &format!("/api/v1/admin/users/{admin_id}"),
            json!({}),
            Some(&admin_cookie),
            Some(&admin_csrf),
        )
        .await;
        assert_eq!(primary_delete.status(), StatusCode::BAD_REQUEST);

        let reenabled = request(
            &app,
            "PATCH",
            &format!("/api/v1/admin/users/{member_id}"),
            json!({"disabled": false}),
            Some(&admin_cookie),
            Some(&admin_csrf),
        )
        .await;
        assert_eq!(reenabled.status(), StatusCode::OK);
        assert_eq!(json_body(reenabled).await["data"]["status"], "active");
        let reenabled_login = request(
            &app,
            "POST",
            "/api/v1/auth/login",
            json!({"username": "member", "password": "member password is long enough"}),
            None,
            None,
        )
        .await;
        assert_eq!(reenabled_login.status(), StatusCode::OK);

        // An administrator can retrofit a member's role to admin and back.
        let promoted = request(
            &app,
            "PATCH",
            &format!("/api/v1/admin/users/{member_id}"),
            json!({"role": "admin"}),
            Some(&admin_cookie),
            Some(&admin_csrf),
        )
        .await;
        assert_eq!(promoted.status(), StatusCode::OK);
        assert_eq!(json_body(promoted).await["data"]["role"], "admin");
        let demoted = request(
            &app,
            "PATCH",
            &format!("/api/v1/admin/users/{member_id}"),
            json!({"role": "member"}),
            Some(&admin_cookie),
            Some(&admin_csrf),
        )
        .await;
        assert_eq!(demoted.status(), StatusCode::OK);
        assert_eq!(json_body(demoted).await["data"]["role"], "member");
        // The primary administrator must remain an administrator.
        let primary_demote = request(
            &app,
            "PATCH",
            &format!("/api/v1/admin/users/{admin_id}"),
            json!({"role": "member"}),
            Some(&admin_cookie),
            Some(&admin_csrf),
        )
        .await;
        assert_eq!(primary_demote.status(), StatusCode::BAD_REQUEST);

        let deleted = request(
            &app,
            "DELETE",
            &format!("/api/v1/admin/users/{member_id}"),
            json!({}),
            Some(&admin_cookie),
            Some(&admin_csrf),
        )
        .await;
        assert_eq!(deleted.status(), StatusCode::NO_CONTENT);
        let deleted_login = request(
            &app,
            "POST",
            "/api/v1/auth/login",
            json!({"username": "member", "password": "member password is long enough"}),
            None,
            None,
        )
        .await;
        assert_eq!(deleted_login.status(), StatusCode::UNAUTHORIZED);

        let overview = request(
            &app,
            "GET",
            "/api/v1/admin/overview",
            json!({}),
            Some(&admin_cookie),
            None,
        )
        .await;
        assert_eq!(overview.status(), StatusCode::OK);
        let overview_body = json_body(overview).await;
        assert_eq!(overview_body["data"]["users"], 2);
        assert!(overview_body["data"]["liveCollaboration"]["loadedRooms"]
            .as_u64()
            .is_some());
        assert!(
            overview_body["data"]["liveCollaboration"]["updatesLastMinute"]
                .as_i64()
                .is_some()
        );
        assert!(
            overview_body["data"]["liveCollaboration"]["activePresenceUsers"]
                .as_i64()
                .is_some()
        );
        assert!(
            overview_body["data"]["recentAuditEvents"]
                .as_array()
                .unwrap()
                .len()
                >= 3
        );

        // --- Phase 4: semantic kanban enforcement ---
        //
        // Placed last so its dedicated vault, extra files, and blobs do not
        // perturb the global manifest/file/blob-count assertions above.

        let kanban_vault = request(
            &app,
            "POST",
            "/api/v1/vaults",
            json!({"name": "Kanban Vault"}),
            Some(&admin_cookie),
            Some(&admin_csrf),
        )
        .await;
        assert_eq!(kanban_vault.status(), StatusCode::CREATED);
        let kanban_vault_id = json_body(kanban_vault).await["data"]["id"]
            .as_str()
            .unwrap()
            .to_owned();

        // A template that can write files and move kanban cards, but cannot edit
        // card content. Granted to the reviewer group (which still contains the
        // invited user) on the kanban vault.
        let mover_template = request(
            &app,
            "POST",
            "/api/v1/admin/templates",
            json!({
                "name": "kanban-mover",
                "capabilities": ["vault.read", "file.write", "kanban.card.move"]
            }),
            Some(&admin_cookie),
            Some(&admin_csrf),
        )
        .await;
        assert_eq!(mover_template.status(), StatusCode::CREATED);
        let mover_template_id = json_body(mover_template).await["data"]["id"]
            .as_str()
            .unwrap()
            .to_owned();
        let mover_grant = request(
            &app,
            "PUT",
            &format!("/api/v1/admin/vaults/{kanban_vault_id}/grants/group/{group_id}"),
            json!({"templateId": mover_template_id}),
            Some(&admin_cookie),
            Some(&admin_csrf),
        )
        .await;
        assert_eq!(mover_grant.status(), StatusCode::OK);

        // The owner (admin) creates a kanban board with two cards in one column.
        let board_v1 = json!({
            "columns": [{
                "id": "c1",
                "title": "Todo",
                "cards": [
                    {"id": "a", "title": "A", "comments": []},
                    {"id": "b", "title": "B", "comments": []}
                ]
            }]
        });
        let kanban_file = request(
            &app,
            "POST",
            &format!("/api/v1/vaults/{kanban_vault_id}/files"),
            json!({
                "name": "Board.kanban",
                "kind": "document",
                "documentType": "kanban",
                "content": board_v1.to_string()
            }),
            Some(&admin_cookie),
            Some(&admin_csrf),
        )
        .await;
        assert_eq!(kanban_file.status(), StatusCode::CREATED);
        let kanban_file_id = json_body(kanban_file).await["data"]["id"]
            .as_str()
            .unwrap()
            .to_owned();

        // The move-only group member may reorder cards (kanban.card.move).
        let board_reordered = json!({
            "columns": [{
                "id": "c1",
                "title": "Todo",
                "cards": [
                    {"id": "b", "title": "B", "comments": []},
                    {"id": "a", "title": "A", "comments": []}
                ]
            }]
        });
        let allowed_move = request(
            &app,
            "POST",
            &format!("/api/v1/vaults/{kanban_vault_id}/files/{kanban_file_id}/revisions"),
            json!({"expectedRevisionSequence": 1, "content": board_reordered.to_string()}),
            Some(&invited_cookie),
            Some(&invited_csrf),
        )
        .await;
        assert_eq!(allowed_move.status(), StatusCode::CREATED);

        // ...but may not edit card content (kanban.card.editContent), even though
        // the same baseline file.write succeeded for the reorder above.
        let board_edited = json!({
            "columns": [{
                "id": "c1",
                "title": "Todo",
                "cards": [
                    {"id": "b", "title": "B", "comments": []},
                    {"id": "a", "title": "A renamed", "comments": []}
                ]
            }]
        });
        let denied_edit = request(
            &app,
            "POST",
            &format!("/api/v1/vaults/{kanban_vault_id}/files/{kanban_file_id}/revisions"),
            json!({"expectedRevisionSequence": 2, "content": board_edited.to_string()}),
            Some(&invited_cookie),
            Some(&invited_csrf),
        )
        .await;
        assert_eq!(denied_edit.status(), StatusCode::FORBIDDEN);
        assert_eq!(
            json_body(denied_edit).await["error"]["code"],
            "vault_permission_denied"
        );

        // The owner holds every capability and bypasses semantic kanban diffing,
        // so the same content edit succeeds for them.
        let owner_edit = request(
            &app,
            "POST",
            &format!("/api/v1/vaults/{kanban_vault_id}/files/{kanban_file_id}/revisions"),
            json!({"expectedRevisionSequence": 2, "content": board_edited.to_string()}),
            Some(&admin_cookie),
            Some(&admin_csrf),
        )
        .await;
        assert_eq!(owner_edit.status(), StatusCode::CREATED);

        // --- PDF annotation permissions (pdf.comment vs pdf.annotate) ---
        //
        // Reuses the kanban vault and reviewer group. Re-grants the group a
        // comment-only template, then verifies a commenter can add page comments
        // but not highlights/bookmarks, while the owner can do both.

        let commenter_template = request(
            &app,
            "POST",
            "/api/v1/admin/templates",
            json!({
                "name": "pdf-commenter",
                "capabilities": ["vault.read", "pdf.comment"]
            }),
            Some(&admin_cookie),
            Some(&admin_csrf),
        )
        .await;
        assert_eq!(commenter_template.status(), StatusCode::CREATED);
        let commenter_template_id = json_body(commenter_template).await["data"]["id"]
            .as_str()
            .unwrap()
            .to_owned();
        let commenter_grant = request(
            &app,
            "PUT",
            &format!("/api/v1/admin/vaults/{kanban_vault_id}/grants/group/{group_id}"),
            json!({"templateId": commenter_template_id}),
            Some(&admin_cookie),
            Some(&admin_csrf),
        )
        .await;
        assert_eq!(commenter_grant.status(), StatusCode::OK);

        // The owner uploads a PDF asset to annotate.
        let pdf_text = "%PDF-1.4 test document";
        let pdf_upload = request(
            &app,
            "POST",
            &format!("/api/v1/vaults/{kanban_vault_id}/uploads"),
            json!({
                "name": "doc.pdf",
                "mediaType": "application/pdf",
                "contentBase64": STANDARD.encode(pdf_text.as_bytes()),
                "expectedHash": hash_secret(pdf_text)
            }),
            Some(&admin_cookie),
            Some(&admin_csrf),
        )
        .await;
        assert_eq!(pdf_upload.status(), StatusCode::CREATED);
        let pdf_id = json_body(pdf_upload).await["data"]["id"]
            .as_str()
            .unwrap()
            .to_owned();

        // A fresh PDF has empty annotations at sequence 0.
        let initial_annotations = request(
            &app,
            "GET",
            &format!("/api/v1/vaults/{kanban_vault_id}/files/{pdf_id}/pdf-annotations"),
            json!({}),
            Some(&invited_cookie),
            None,
        )
        .await;
        assert_eq!(initial_annotations.status(), StatusCode::OK);
        assert_eq!(json_body(initial_annotations).await["data"]["sequence"], 0);

        // The commenter may add a page comment (pdf.comment).
        let comment_state = json!({
            "pageComments": [{"id": "k", "page": 1, "content": "hi", "createdAt": 1, "updatedAt": 1}]
        });
        let allowed_comment = request(
            &app,
            "PUT",
            &format!("/api/v1/vaults/{kanban_vault_id}/files/{pdf_id}/pdf-annotations"),
            json!({"expectedSequence": 0, "state": comment_state}),
            Some(&invited_cookie),
            Some(&invited_csrf),
        )
        .await;
        assert_eq!(allowed_comment.status(), StatusCode::OK);
        assert_eq!(json_body(allowed_comment).await["data"]["sequence"], 1);

        // ...but may not add a bookmark/highlight (pdf.annotate).
        let annotate_state = json!({
            "pageComments": [{"id": "k", "page": 1, "content": "hi", "createdAt": 1, "updatedAt": 1}],
            "bookmarks": [{"id": "b", "page": 1, "createdAt": 1, "updatedAt": 1}]
        });
        let denied_annotate = request(
            &app,
            "PUT",
            &format!("/api/v1/vaults/{kanban_vault_id}/files/{pdf_id}/pdf-annotations"),
            json!({"expectedSequence": 1, "state": annotate_state}),
            Some(&invited_cookie),
            Some(&invited_csrf),
        )
        .await;
        assert_eq!(denied_annotate.status(), StatusCode::FORBIDDEN);
        assert_eq!(
            json_body(denied_annotate).await["error"]["code"],
            "vault_permission_denied"
        );

        // The owner holds every capability, so the same bookmark write succeeds.
        let owner_annotate = request(
            &app,
            "PUT",
            &format!("/api/v1/vaults/{kanban_vault_id}/files/{pdf_id}/pdf-annotations"),
            json!({"expectedSequence": 1, "state": annotate_state}),
            Some(&admin_cookie),
            Some(&admin_csrf),
        )
        .await;
        assert_eq!(owner_annotate.status(), StatusCode::OK);
        assert_eq!(json_body(owner_annotate).await["data"]["sequence"], 2);

        // --- User profile: admin username edit, self profile, avatar ---

        // An administrator can rename a user and change their username.
        let renamed = request(
            &app,
            "PATCH",
            &format!("/api/v1/admin/users/{invited_id}"),
            json!({"displayName": "Renamed Invited", "username": "invited-renamed"}),
            Some(&admin_cookie),
            Some(&admin_csrf),
        )
        .await;
        assert_eq!(renamed.status(), StatusCode::OK);
        let renamed_body = json_body(renamed).await;
        assert_eq!(renamed_body["data"]["displayName"], "Renamed Invited");
        assert_eq!(renamed_body["data"]["username"], "invited-renamed");

        // Duplicate usernames are rejected.
        let dup_username = request(
            &app,
            "PATCH",
            &format!("/api/v1/admin/users/{invited_id}"),
            json!({"username": "admin"}),
            Some(&admin_cookie),
            Some(&admin_csrf),
        )
        .await;
        assert_eq!(dup_username.status(), StatusCode::BAD_REQUEST);

        // The signed-in admin can update their own profile and UI preferences.
        let self_update = request(
            &app,
            "PATCH",
            "/api/v1/users/me",
            json!({"displayName": "Primary Admin", "preferences": {"theme": "midnight"}}),
            Some(&admin_cookie),
            Some(&admin_csrf),
        )
        .await;
        assert_eq!(self_update.status(), StatusCode::OK);
        let self_body = json_body(self_update).await;
        assert_eq!(self_body["data"]["displayName"], "Primary Admin");
        assert_eq!(self_body["data"]["preferences"]["theme"], "midnight");
        assert_eq!(self_body["data"]["hasAvatar"], false);

        // Avatar upload, fetch, and the me-projection of avatar presence.
        let avatar = request(
            &app,
            "PUT",
            "/api/v1/users/me/avatar",
            json!({"mediaType": "image/png", "contentBase64": STANDARD.encode([1u8, 2, 3, 4])}),
            Some(&admin_cookie),
            Some(&admin_csrf),
        )
        .await;
        assert_eq!(avatar.status(), StatusCode::OK);
        assert_eq!(json_body(avatar).await["data"]["hasAvatar"], true);
        let avatar_fetch = request(
            &app,
            "GET",
            &format!("/api/v1/users/{admin_id}/avatar"),
            json!({}),
            Some(&admin_cookie),
            None,
        )
        .await;
        assert_eq!(avatar_fetch.status(), StatusCode::OK);
        assert_eq!(avatar_fetch.headers()[header::CONTENT_TYPE], "image/png");
        assert_eq!(response_bytes(avatar_fetch).await, vec![1u8, 2, 3, 4]);
        let me_after = request(
            &app,
            "GET",
            "/api/v1/users/me",
            json!({}),
            Some(&admin_cookie),
            None,
        )
        .await;
        assert_eq!(json_body(me_after).await["data"]["hasAvatar"], true);

        // Rejects oversized payloads via an unsupported media type guard first.
        let bad_avatar = request(
            &app,
            "PUT",
            "/api/v1/users/me/avatar",
            json!({"mediaType": "text/plain", "contentBase64": STANDARD.encode([0u8])}),
            Some(&admin_cookie),
            Some(&admin_csrf),
        )
        .await;
        assert_eq!(bad_avatar.status(), StatusCode::BAD_REQUEST);

        // Force-deleting is only allowed once a vault is marked for deletion, so a
        // single destructive request can never skip the soft-delete step.
        // Reactivate the vault (it was left pending_delete by the redelete step
        // above) so the force-delete guard is exercised against an active vault.
        let reactivate_before_force = request(
            &app,
            "PATCH",
            &format!("/api/v1/admin/vaults/{vault_id}"),
            json!({"status": "active"}),
            Some(&admin_cookie),
            Some(&admin_csrf),
        )
        .await;
        assert_eq!(reactivate_before_force.status(), StatusCode::OK);
        assert_eq!(
            json_body(reactivate_before_force).await["data"]["status"],
            "active"
        );

        // Force-delete must be rejected while the vault is still active: a vault
        // has to be marked for deletion first.
        let force_too_early = request(
            &app,
            "POST",
            &format!("/api/v1/admin/vaults/{vault_id}/force-delete"),
            json!({}),
            Some(&admin_cookie),
            Some(&admin_csrf),
        )
        .await;
        assert_eq!(force_too_early.status(), StatusCode::BAD_REQUEST);

        let mark_for_deletion = request(
            &app,
            "DELETE",
            &format!("/api/v1/admin/vaults/{vault_id}"),
            json!({}),
            Some(&admin_cookie),
            Some(&admin_csrf),
        )
        .await;
        assert_eq!(mark_for_deletion.status(), StatusCode::NO_CONTENT);

        let force_delete = request(
            &app,
            "POST",
            &format!("/api/v1/admin/vaults/{vault_id}/force-delete"),
            json!({}),
            Some(&admin_cookie),
            Some(&admin_csrf),
        )
        .await;
        assert_eq!(force_delete.status(), StatusCode::NO_CONTENT);

        // The vault and its cascaded content are permanently gone.
        let gone = request(
            &app,
            "GET",
            &format!("/api/v1/admin/vaults/{vault_id}"),
            json!({}),
            Some(&admin_cookie),
            None,
        )
        .await;
        assert_eq!(gone.status(), StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn native_vault_admin_manages_fine_grained_permissions() {
        let Ok(url) = std::env::var("COLLAB_TEST_DATABASE_URL") else {
            return;
        };
        let _db_guard = crate::database::db_test_guard().lock().await;
        let pool = PgPoolOptions::new()
            .max_connections(5)
            .connect(&url)
            .await
            .unwrap();
        database::migrate(&pool).await.unwrap();
        sqlx::query(
            "TRUNCATE audit_events, invitations, native_sessions, sessions, credentials, users, hosted_blobs RESTART IDENTITY CASCADE",
        )
        .execute(&pool)
        .await
        .unwrap();
        reseed_builtin_templates(&pool).await;
        let blobs = Arc::new(
            FileSystemBlobStorage::new(tempfile::tempdir().unwrap().keep())
                .await
                .unwrap(),
        );
        let app = build_router(AppState::new(ServerConfig::default(), pool.clone(), blobs));

        // Bootstrap the primary server admin; they will also own the test vault.
        let bootstrap = request(
            &app,
            "POST",
            "/api/v1/auth/bootstrap",
            json!({"username": "owner", "displayName": "Owner", "password": "correct horse battery staple"}),
            None,
            None,
        )
        .await;
        assert_eq!(bootstrap.status(), StatusCode::OK);
        let (owner_cookie, owner_csrf) = session_cookies(&bootstrap);

        // Create alice (a fine-grained permissions manager) and bob (a target).
        let mut user_ids = std::collections::HashMap::new();
        for (username, display) in [("alice", "Alice"), ("bob", "Bob")] {
            let created = request(
                &app,
                "POST",
                "/api/v1/admin/users",
                json!({"username": username, "displayName": display, "password": "a password long enough to pass"}),
                Some(&owner_cookie),
                Some(&owner_csrf),
            )
            .await;
            assert_eq!(created.status(), StatusCode::CREATED);
            user_ids.insert(
                username,
                json_body(created).await["data"]["id"]
                    .as_str()
                    .unwrap()
                    .to_owned(),
            );
        }
        let alice_id = user_ids["alice"].clone();
        let bob_id = user_ids["bob"].clone();

        let alice_login = request(
            &app,
            "POST",
            "/api/v1/auth/login",
            json!({"username": "alice", "password": "a password long enough to pass"}),
            None,
            None,
        )
        .await;
        let (alice_cookie, alice_csrf) = session_cookies(&alice_login);
        let bob_login = request(
            &app,
            "POST",
            "/api/v1/auth/login",
            json!({"username": "bob", "password": "a password long enough to pass"}),
            None,
            None,
        )
        .await;
        let (bob_cookie, bob_csrf) = session_cookies(&bob_login);

        let vault = request(
            &app,
            "POST",
            "/api/v1/vaults",
            json!({"name": "Perm Vault"}),
            Some(&owner_cookie),
            Some(&owner_csrf),
        )
        .await;
        let vault_id = json_body(vault).await["data"]["id"]
            .as_str()
            .unwrap()
            .to_owned();

        // Add bob as an editor member.
        for (user, role) in [(&bob_id, "editor"), (&alice_id, "editor")] {
            let added = request(
                &app,
                "POST",
                &format!("/api/v1/vaults/{vault_id}/members"),
                json!({"userId": user, "role": role}),
                Some(&owner_cookie),
                Some(&owner_csrf),
            )
            .await;
            assert_eq!(added.status(), StatusCode::CREATED);
        }
        // The owner grants alice the management capabilities directly (so she can
        // manage permissions without being a full "admin" role member).
        let alice_grant = request(
            &app,
            "PATCH",
            &format!("/api/v1/vaults/{vault_id}/members/{alice_id}"),
            json!({"capabilities": ["vault.read", "vault.search", "vault.manageMembers", "vault.managePermissions"]}),
            Some(&owner_cookie),
            Some(&owner_csrf),
        )
        .await;
        assert_eq!(alice_grant.status(), StatusCode::OK);

        // Alice can read the vault's permission templates (vault.managePermissions).
        let templates = request(
            &app,
            "GET",
            &format!("/api/v1/vaults/{vault_id}/templates"),
            json!({}),
            Some(&alice_cookie),
            None,
        )
        .await;
        assert_eq!(templates.status(), StatusCode::OK);
        let templates_body = json_body(templates).await;
        let template_array = templates_body["data"].as_array().unwrap();
        assert!(template_array
            .iter()
            .any(|t| t["name"] == "viewer" && t["isBuiltin"] == true));
        let editor_template_id = template_array
            .iter()
            .find(|t| t["name"] == "editor")
            .unwrap()["id"]
            .as_str()
            .unwrap()
            .to_owned();

        // Alice sets a fine-grained capability override on bob → persisted and
        // reflected in the returned member DTO.
        let set_caps = request(
            &app,
            "PATCH",
            &format!("/api/v1/vaults/{vault_id}/members/{bob_id}"),
            json!({"capabilities": ["vault.read", "note.edit"]}),
            Some(&alice_cookie),
            Some(&alice_csrf),
        )
        .await;
        assert_eq!(set_caps.status(), StatusCode::OK);
        let bob_member = json_body(set_caps).await;
        assert_eq!(
            capability_tokens(&bob_member["data"]),
            vec!["vault.read".to_owned(), "note.edit".to_owned()]
        );
        assert_eq!(
            bob_member["data"]["customCapabilities"],
            json!(["vault.read", "note.edit"])
        );

        // Alice assigns bob a template instead → override cleared, template set.
        let set_template = request(
            &app,
            "PATCH",
            &format!("/api/v1/vaults/{vault_id}/members/{bob_id}"),
            json!({"templateId": editor_template_id}),
            Some(&alice_cookie),
            Some(&alice_csrf),
        )
        .await;
        assert_eq!(set_template.status(), StatusCode::OK);
        let templated_bob = json_body(set_template).await;
        assert_eq!(templated_bob["data"]["templateId"], editor_template_id);
        assert!(templated_bob["data"]["customCapabilities"].is_null());

        // Reset bob to the role default → both override fields cleared.
        let reset = request(
            &app,
            "PATCH",
            &format!("/api/v1/vaults/{vault_id}/members/{bob_id}"),
            json!({"resetToRoleDefault": true}),
            Some(&alice_cookie),
            Some(&alice_csrf),
        )
        .await;
        assert_eq!(reset.status(), StatusCode::OK);
        let reset_bob = json_body(reset).await;
        assert!(reset_bob["data"]["templateId"].is_null());
        assert!(reset_bob["data"]["customCapabilities"].is_null());
        assert!(capability_tokens(&reset_bob["data"]).contains(&"file.write".to_owned()));

        // Self-lockout guard: alice cannot drop her own management capabilities.
        let self_lock = request(
            &app,
            "PATCH",
            &format!("/api/v1/vaults/{vault_id}/members/{alice_id}"),
            json!({"capabilities": ["vault.read"]}),
            Some(&alice_cookie),
            Some(&alice_csrf),
        )
        .await;
        assert_eq!(self_lock.status(), StatusCode::BAD_REQUEST);
        // But she may edit her own permissions while retaining the management caps.
        let self_ok = request(
            &app,
            "PATCH",
            &format!("/api/v1/vaults/{vault_id}/members/{alice_id}"),
            json!({"capabilities": ["vault.read", "vault.search", "vault.manageMembers", "vault.managePermissions", "note.edit"]}),
            Some(&alice_cookie),
            Some(&alice_csrf),
        )
        .await;
        assert_eq!(self_ok.status(), StatusCode::OK);

        // Bob (an editor without vault.managePermissions) cannot read templates or
        // change anyone's permissions.
        let bob_templates = request(
            &app,
            "GET",
            &format!("/api/v1/vaults/{vault_id}/templates"),
            json!({}),
            Some(&bob_cookie),
            None,
        )
        .await;
        assert_eq!(bob_templates.status(), StatusCode::FORBIDDEN);
        let bob_edit = request(
            &app,
            "PATCH",
            &format!("/api/v1/vaults/{vault_id}/members/{alice_id}"),
            json!({"capabilities": ["vault.read"]}),
            Some(&bob_cookie),
            Some(&bob_csrf),
        )
        .await;
        assert_eq!(bob_edit.status(), StatusCode::FORBIDDEN);
    }

    #[tokio::test]
    async fn revoked_member_cannot_upload_operations_after_removal() {
        let Ok(url) = std::env::var("COLLAB_TEST_DATABASE_URL") else {
            return;
        };
        let _db_guard = crate::database::db_test_guard().lock().await;
        let pool = PgPoolOptions::new()
            .max_connections(5)
            .connect(&url)
            .await
            .unwrap();
        database::migrate(&pool).await.unwrap();
        sqlx::query(
            "TRUNCATE audit_events, invitations, native_sessions, sessions, credentials, users, hosted_blobs RESTART IDENTITY CASCADE",
        )
        .execute(&pool)
        .await
        .unwrap();
        reseed_builtin_templates(&pool).await;
        let blobs = Arc::new(
            FileSystemBlobStorage::new(tempfile::tempdir().unwrap().keep())
                .await
                .unwrap(),
        );
        let app = build_router(AppState::new(ServerConfig::default(), pool.clone(), blobs));

        let bootstrap = request(
            &app,
            "POST",
            "/api/v1/auth/bootstrap",
            json!({"username": "owner", "displayName": "Owner", "password": "correct horse battery staple"}),
            None,
            None,
        )
        .await;
        let (owner_cookie, owner_csrf) = session_cookies(&bootstrap);

        let member = request(
            &app,
            "POST",
            "/api/v1/admin/users",
            json!({"username": "mallory", "displayName": "Mallory", "password": "a password long enough to pass"}),
            Some(&owner_cookie),
            Some(&owner_csrf),
        )
        .await;
        let member_id = json_body(member).await["data"]["id"]
            .as_str()
            .unwrap()
            .to_owned();
        let member_login = request(
            &app,
            "POST",
            "/api/v1/auth/login",
            json!({"username": "mallory", "password": "a password long enough to pass"}),
            None,
            None,
        )
        .await;
        let (member_cookie, member_csrf) = session_cookies(&member_login);

        let vault = request(
            &app,
            "POST",
            "/api/v1/vaults",
            json!({"name": "Shared Vault"}),
            Some(&owner_cookie),
            Some(&owner_csrf),
        )
        .await;
        let vault_id = json_body(vault).await["data"]["id"]
            .as_str()
            .unwrap()
            .to_owned();
        let added = request(
            &app,
            "POST",
            &format!("/api/v1/vaults/{vault_id}/members"),
            json!({"userId": member_id, "role": "editor"}),
            Some(&owner_cookie),
            Some(&owner_csrf),
        )
        .await;
        assert_eq!(added.status(), StatusCode::CREATED);

        // While a member, the editor can upload (create a file).
        let create_while_member = request(
            &app,
            "POST",
            &format!("/api/v1/vaults/{vault_id}/files"),
            json!({"name": "Note.md", "kind": "document", "documentType": "note", "content": "hi"}),
            Some(&member_cookie),
            Some(&member_csrf),
        )
        .await;
        assert_eq!(create_while_member.status(), StatusCode::CREATED);

        // The owner revokes access.
        let removed = request(
            &app,
            "DELETE",
            &format!("/api/v1/vaults/{vault_id}/members/{member_id}"),
            json!({}),
            Some(&owner_cookie),
            Some(&owner_csrf),
        )
        .await;
        assert_eq!(removed.status(), StatusCode::NO_CONTENT);

        // After revocation the client cannot upload new content; the vault is no
        // longer visible to them at all (not_found), so queued offline operations
        // are rejected on reconnect rather than silently accepted.
        let create_after_revoke = request(
            &app,
            "POST",
            &format!("/api/v1/vaults/{vault_id}/files"),
            json!({"name": "Sneaky.md", "kind": "document", "documentType": "note", "content": "no"}),
            Some(&member_cookie),
            Some(&member_csrf),
        )
        .await;
        assert_eq!(create_after_revoke.status(), StatusCode::NOT_FOUND);

        // A structural operation is likewise rejected.
        let operation_after_revoke = request(
            &app,
            "POST",
            &format!("/api/v1/vaults/{vault_id}/operations"),
            json!({
                "clientOperationId": Uuid::now_v7(),
                "baseManifestSequence": 1,
                "operationType": "trash",
                "targetFileId": Uuid::now_v7(),
            }),
            Some(&member_cookie),
            Some(&member_csrf),
        )
        .await;
        assert_eq!(operation_after_revoke.status(), StatusCode::NOT_FOUND);
    }
}
