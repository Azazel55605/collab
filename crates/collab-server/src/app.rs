use crate::{api, config::ServerConfig, database, storage::BlobStorage};
use axum::{
    extract::{ConnectInfo, DefaultBodyLimit, Request, State},
    http::{HeaderName, HeaderValue, Method, StatusCode},
    middleware::{self, Next},
    response::{IntoResponse, Redirect, Response},
    routing::{delete, get, patch, post, put},
    Json, Router,
};
use collab_protocol::{
    ApiError, DataResponse, ErrorCode, ErrorResponse, HealthState, HealthStatus, PROTOCOL_VERSION,
};
use sqlx::PgPool;
use std::{
    collections::HashMap,
    net::SocketAddr,
    sync::Arc,
    time::{Duration, Instant},
};
use tokio::{sync::Mutex, time::sleep};
use tower_http::{
    services::{ServeDir, ServeFile},
    set_header::SetResponseHeaderLayer,
    trace::TraceLayer,
};
use uuid::Uuid;

const REQUEST_ID_HEADER: &str = "x-request-id";
const CONTENT_SECURITY_POLICY: &str =
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'";
const PERMISSIONS_POLICY: &str =
    "accelerometer=(), camera=(), geolocation=(), gyroscope=(), magnetometer=(), microphone=(), payment=(), usb=()";

#[derive(Clone)]
pub struct AppState {
    pub config: ServerConfig,
    pub database: PgPool,
    pub blobs: Arc<dyn BlobStorage>,
    pub login_limiter: LoginRateLimiter,
    pub rate_limiter: RateLimiter,
    pub hub: Arc<crate::ws::Hub>,
    pub started_at: Instant,
}

impl AppState {
    pub fn new(config: ServerConfig, database: PgPool, blobs: Arc<dyn BlobStorage>) -> Self {
        let hub = Arc::new(crate::ws::Hub::new(database.clone(), blobs.clone()));
        Self {
            config,
            database,
            blobs,
            login_limiter: LoginRateLimiter::default(),
            rate_limiter: RateLimiter::new(Duration::from_secs(60)),
            hub,
            started_at: Instant::now(),
        }
    }
}

pub fn build_router(state: AppState) -> Router {
    let admin_index = state.config.admin_web_dir.join("index.html");
    let max_json_body_bytes = state.config.max_json_body_bytes();
    let admin_assets =
        ServeDir::new(&state.config.admin_web_dir).fallback(ServeFile::new(admin_index));
    Router::new()
        .route("/", get(|| async { Redirect::permanent("/admin/") }))
        .route("/health/live", get(liveness))
        .route("/health/ready", get(readiness))
        .route("/api/v1/auth/bootstrap-status", get(api::bootstrap_status))
        .route("/api/v1/auth/bootstrap", post(api::bootstrap))
        .route("/api/v1/auth/login", post(api::login))
        .route("/api/v1/auth/native/login", post(api::native_login))
        .route("/api/v1/auth/refresh", post(api::refresh))
        .route("/api/v1/auth/native/logout", post(api::native_logout))
        .route(
            "/api/v1/auth/invitations/{token}/accept",
            post(api::accept_invitation),
        )
        .route("/api/v1/auth/ws-ticket", post(api::issue_ws_ticket))
        .route("/api/v1/auth/logout", post(api::logout))
        .route("/ws/v1/vaults/{vault_id}", get(crate::ws::vault_ws))
        .route("/api/v1/users/me", get(api::me).patch(api::update_self))
        .route("/api/v1/users/me/password", post(api::change_password))
        .route(
            "/api/v1/users/me/avatar",
            put(api::upload_self_avatar).delete(api::delete_self_avatar),
        )
        .route("/api/v1/users/{user_id}/avatar", get(api::get_user_avatar))
        .route("/api/v1/users/directory", get(api::user_directory))
        .route(
            "/api/v1/vaults",
            get(api::list_vaults).post(api::create_vault),
        )
        .route(
            "/api/v1/vaults/{vault_id}",
            get(api::get_vault)
                .patch(api::update_vault)
                .delete(api::delete_vault),
        )
        .route(
            "/api/v1/vaults/{vault_id}/members",
            get(api::list_vault_members).post(api::add_vault_member),
        )
        .route(
            "/api/v1/vaults/{vault_id}/members/{user_id}",
            patch(api::update_vault_member).delete(api::remove_vault_member),
        )
        .route(
            "/api/v1/vaults/{vault_id}/templates",
            get(api::list_vault_templates),
        )
        .route(
            "/api/v1/vaults/{vault_id}/activity",
            get(api::vault_activity),
        )
        .route(
            "/api/v1/vaults/{vault_id}/manifest",
            get(api::vault_manifest),
        )
        .route(
            "/api/v1/vaults/{vault_id}/manifest/delta",
            get(api::vault_manifest_delta),
        )
        .route("/api/v1/vaults/{vault_id}/storage", get(api::vault_storage))
        .route(
            "/api/v1/vaults/{vault_id}/files",
            get(api::list_vault_files).post(api::create_vault_file),
        )
        .route(
            "/api/v1/vaults/{vault_id}/files/{file_id}",
            get(api::get_vault_file),
        )
        .route(
            "/api/v1/vaults/{vault_id}/files/{file_id}/content",
            get(api::download_vault_file),
        )
        .route(
            "/api/v1/vaults/{vault_id}/files/{file_id}/archive",
            get(api::download_vault_folder_archive),
        )
        .route(
            "/api/v1/vaults/{vault_id}/files/{file_id}/references",
            get(api::list_file_references),
        )
        .route(
            "/api/v1/vaults/{vault_id}/files/{file_id}/pdf-annotations",
            get(api::get_pdf_annotations).put(api::write_pdf_annotations),
        )
        .route(
            "/api/v1/vaults/{vault_id}/files/{file_id}/revisions",
            get(api::list_file_revisions)
                .post(api::write_text_revision)
                .delete(api::delete_file_revisions),
        )
        .route(
            "/api/v1/vaults/{vault_id}/files/{file_id}/revisions/{revision_id}",
            get(api::get_text_revision)
                .post(api::restore_file_revision)
                .delete(api::delete_file_revision),
        )
        .route(
            "/api/v1/vaults/{vault_id}/files/{file_id}/snapshots",
            get(api::list_file_snapshots).post(api::create_file_snapshot),
        )
        .route(
            "/api/v1/vaults/{vault_id}/files/{file_id}/snapshots/{snapshot_id}/restore",
            post(api::restore_file_snapshot),
        )
        .route(
            "/api/v1/vaults/{vault_id}/uploads",
            post(api::upload_binary_asset),
        )
        .route(
            "/api/v1/vaults/{vault_id}/operations",
            post(api::apply_structural_operation),
        )
        .route(
            "/api/v1/vaults/{vault_id}/operations/preview",
            post(api::preview_structural_operation),
        )
        .route("/api/v1/vaults/{vault_id}/search", get(api::search_vault))
        .route(
            "/api/v1/vaults/{vault_id}/import",
            post(api::import_vault_zip),
        )
        .route(
            "/api/v1/vaults/{vault_id}/export",
            get(api::export_vault_zip),
        )
        .route(
            "/api/v1/vaults/{vault_id}/chat",
            get(api::list_chat_messages).post(api::send_chat_message),
        )
        .route(
            "/api/v1/vaults/{vault_id}/presence",
            get(api::list_presence)
                .put(api::write_presence)
                .delete(api::clear_presence),
        )
        .route("/api/v1/admin/overview", get(api::overview))
        .route(
            "/api/v1/admin/settings",
            get(api::admin_settings).patch(api::admin_update_settings),
        )
        .route(
            "/api/v1/admin/maintenance",
            post(api::admin_run_maintenance),
        )
        .route(
            "/api/v1/admin/live-debug",
            get(api::admin_get_live_debug).put(api::admin_set_live_debug),
        )
        .route(
            "/api/v1/admin/backups",
            get(api::admin_backups).post(api::admin_run_backup),
        )
        .route(
            "/api/v1/admin/backups/settings",
            patch(api::admin_update_backup_settings),
        )
        .route(
            "/api/v1/admin/backups/{backup_name}/verify",
            post(api::admin_verify_backup),
        )
        .route(
            "/api/v1/admin/backups/import",
            post(api::admin_import_backup_archive),
        )
        .route(
            "/api/v1/admin/backups/{backup_name}/archive",
            get(api::admin_export_backup_archive),
        )
        .route(
            "/api/v1/admin/backups/{backup_name}/restore",
            post(api::admin_restore_backup),
        )
        .route(
            "/api/v1/admin/backups/{backup_name}",
            axum::routing::delete(api::admin_delete_backup),
        )
        .route(
            "/api/v1/admin/users",
            get(api::list_users).post(api::create_user),
        )
        .route(
            "/api/v1/admin/users/{user_id}",
            patch(api::update_user).delete(api::delete_user),
        )
        .route(
            "/api/v1/admin/users/{user_id}/revoke-sessions",
            post(api::revoke_user_sessions),
        )
        .route(
            "/api/v1/admin/users/{user_id}/reset-password",
            post(api::reset_user_password),
        )
        .route(
            "/api/v1/admin/users/{user_id}/activity",
            get(api::user_activity),
        )
        .route(
            "/api/v1/admin/invitations",
            get(api::list_invitations).post(api::create_invitation),
        )
        .route(
            "/api/v1/admin/invitations/{invitation_id}",
            delete(api::revoke_invitation),
        )
        .route("/api/v1/admin/vaults", get(api::hosted_vaults))
        .route(
            "/api/v1/admin/vaults/{vault_id}",
            get(api::admin_vault_detail)
                .patch(api::admin_update_vault)
                .delete(api::admin_delete_vault),
        )
        .route(
            "/api/v1/admin/vaults/{vault_id}/force-delete",
            post(api::admin_force_delete_vault),
        )
        .route(
            "/api/v1/admin/vaults/{vault_id}/members",
            get(api::admin_vault_members).post(api::admin_add_vault_member),
        )
        .route(
            "/api/v1/admin/vaults/{vault_id}/members/{user_id}",
            patch(api::admin_update_vault_member).delete(api::admin_remove_vault_member),
        )
        .route(
            "/api/v1/admin/vaults/{vault_id}/activity",
            get(api::admin_vault_activity),
        )
        .route(
            "/api/v1/admin/vaults/{vault_id}/grants",
            get(api::list_vault_grants),
        )
        .route(
            "/api/v1/admin/vaults/{vault_id}/grants/{subject_type}/{subject_id}",
            put(api::put_vault_grant).delete(api::delete_vault_grant),
        )
        .route(
            "/api/v1/admin/groups",
            get(api::list_groups).post(api::create_group),
        )
        .route(
            "/api/v1/admin/groups/{group_id}",
            patch(api::update_group).delete(api::delete_group),
        )
        .route(
            "/api/v1/admin/groups/{group_id}/members",
            get(api::list_group_members),
        )
        .route(
            "/api/v1/admin/groups/{group_id}/members/{user_id}",
            post(api::add_group_member).delete(api::remove_group_member),
        )
        .route(
            "/api/v1/admin/templates",
            get(api::list_templates).post(api::create_template),
        )
        .route(
            "/api/v1/admin/templates/{template_id}",
            patch(api::update_template).delete(api::delete_template),
        )
        .route("/api/v1/admin/audit-events", get(api::audit_events))
        .nest_service("/admin", admin_assets)
        .layer(SetResponseHeaderLayer::if_not_present(
            HeaderName::from_static("content-security-policy"),
            HeaderValue::from_static(CONTENT_SECURITY_POLICY),
        ))
        .layer(SetResponseHeaderLayer::if_not_present(
            HeaderName::from_static("x-content-type-options"),
            HeaderValue::from_static("nosniff"),
        ))
        .layer(SetResponseHeaderLayer::if_not_present(
            HeaderName::from_static("referrer-policy"),
            HeaderValue::from_static("no-referrer"),
        ))
        .layer(SetResponseHeaderLayer::if_not_present(
            HeaderName::from_static("permissions-policy"),
            HeaderValue::from_static(PERMISSIONS_POLICY),
        ))
        .layer(SetResponseHeaderLayer::if_not_present(
            HeaderName::from_static("cross-origin-opener-policy"),
            HeaderValue::from_static("same-origin"),
        ))
        .layer(SetResponseHeaderLayer::if_not_present(
            HeaderName::from_static("x-frame-options"),
            HeaderValue::from_static("DENY"),
        ))
        .layer(DefaultBodyLimit::max(max_json_body_bytes))
        .layer(middleware::from_fn_with_state(
            state.clone(),
            maintenance_mode,
        ))
        .layer(middleware::from_fn_with_state(state.clone(), rate_limit))
        .layer(middleware::from_fn(request_id))
        .layer(TraceLayer::new_for_http())
        .with_state(state)
}

pub fn spawn_backup_scheduler(state: AppState) {
    let Some(command) = state.config.backup_command.clone() else {
        tracing::warn!("backup schedule is enabled but no backup command is configured");
        return;
    };
    let backup_dir = state.config.backup_dir.clone();
    tokio::spawn(async move {
        loop {
            let settings = crate::api::load_backup_runtime_settings(&state.config);
            if !settings.schedule_enabled {
                sleep(Duration::from_secs(60)).await;
                continue;
            }
            let interval = Duration::from_secs(settings.interval_seconds.max(60));
            tracing::debug!(
                interval_seconds = settings.interval_seconds,
                retention_days = settings.retention_days,
                export_dir = ?settings.export_dir,
                "backup scheduler sleeping"
            );
            sleep(interval).await;
            let settings = crate::api::load_backup_runtime_settings(&state.config);
            if !settings.schedule_enabled {
                continue;
            }
            let request_id = format!("scheduled-backup-{}", chrono::Utc::now().timestamp());
            match crate::api::run_operator_command(
                &command,
                &backup_dir,
                None,
                &settings,
                Duration::from_secs(30 * 60),
                &request_id,
            )
            .await
            {
                Ok(result) => tracing::info!(output = ?result.output, "scheduled backup completed"),
                Err(error) => tracing::warn!(?error, "scheduled backup failed"),
            }
        }
    });
}

/// Spawns the periodic retention/compaction maintenance worker. It runs an
/// initial pass shortly after startup and then once per configured interval.
pub fn spawn_maintenance_worker(state: AppState) {
    let interval = Duration::from_secs(state.config.maintenance_interval_seconds.max(60));
    tokio::spawn(async move {
        // A short initial delay lets startup settle before the first sweep.
        sleep(Duration::from_secs(30)).await;
        loop {
            let policy = crate::api::maintenance_policy_from_settings(&state.config);
            let report =
                crate::retention::run_maintenance(&state.database, state.blobs.as_ref(), policy)
                    .await;
            tracing::info!(
                expired_ws_tickets = report.expired_ws_tickets,
                expired_sessions = report.expired_sessions,
                stale_presence = report.stale_presence,
                pruned_audit_events = report.pruned_audit_events,
                pruned_activity_events = report.pruned_activity_events,
                pruned_revisions = report.pruned_revisions,
                reclaimed_blobs = report.reclaimed_blobs,
                reclaimed_blob_bytes = report.reclaimed_blob_bytes,
                "maintenance pass complete"
            );
            sleep(interval).await;
        }
    });
}

#[derive(Debug, Clone, Default)]
pub struct LoginRateLimiter {
    attempts: Arc<Mutex<HashMap<String, Vec<Instant>>>>,
}

impl LoginRateLimiter {
    pub async fn allow(&self, key: &str) -> bool {
        let now = Instant::now();
        let mut attempts = self.attempts.lock().await;
        let entries = attempts.entry(key.to_owned()).or_default();
        entries.retain(|attempt| now.duration_since(*attempt) < Duration::from_secs(60));
        if entries.len() >= 5 {
            return false;
        }
        entries.push(now);
        true
    }

    pub async fn clear(&self, key: &str) {
        self.attempts.lock().await.remove(key);
    }
}

/// Stop sweeping idle buckets out of the rate-limiter map only once it has grown
/// past this many distinct keys, so the common small-deployment case never pays
/// for the sweep.
const RATE_LIMIT_SWEEP_THRESHOLD: usize = 4096;

/// A generic fixed-window per-key rate limiter (used for coarse per-client-IP
/// REST and WebSocket limits). Counts hits in a sliding window and reports how
/// long a blocked caller should wait before retrying.
#[derive(Debug, Clone)]
pub struct RateLimiter {
    hits: Arc<Mutex<HashMap<String, Vec<Instant>>>>,
    window: Duration,
}

impl RateLimiter {
    pub fn new(window: Duration) -> Self {
        Self {
            hits: Arc::new(Mutex::new(HashMap::new())),
            window,
        }
    }

    /// Records a hit for `key`. Returns `None` when the request is allowed, or
    /// `Some(retry_after_seconds)` when `limit` hits in the current window have
    /// already been used. A `limit` of `0` disables the limiter.
    pub async fn check(&self, key: &str, limit: u32) -> Option<u64> {
        if limit == 0 {
            return None;
        }
        let now = Instant::now();
        let mut hits = self.hits.lock().await;
        if hits.len() > RATE_LIMIT_SWEEP_THRESHOLD {
            hits.retain(|_, timestamps| {
                timestamps.retain(|hit| now.duration_since(*hit) < self.window);
                !timestamps.is_empty()
            });
        }
        let entries = hits.entry(key.to_owned()).or_default();
        entries.retain(|hit| now.duration_since(*hit) < self.window);
        if entries.len() as u32 >= limit {
            let oldest = entries.first().copied().unwrap_or(now);
            let retry = self.window.saturating_sub(now.duration_since(oldest));
            return Some(retry.as_secs().max(1));
        }
        entries.push(now);
        None
    }
}

/// Coarse per-client-IP rate limiting for `/api/v1/*` (REST) and `/ws/v1/*`
/// (WebSocket upgrade) traffic. Other paths (health checks, the admin SPA, the
/// root redirect) are never limited. Limits are operator-controlled and a value
/// of `0` disables the corresponding limiter.
async fn rate_limit(State(state): State<AppState>, request: Request, next: Next) -> Response {
    let path = request.uri().path();
    let (scope, limit) = if path.starts_with("/api/v1/") {
        ("rest", state.config.rest_rate_limit_per_minute)
    } else if path.starts_with("/ws/v1/") {
        ("ws", state.config.ws_rate_limit_per_minute)
    } else {
        return next.run(request).await;
    };
    if limit == 0 {
        return next.run(request).await;
    }
    let bucket = format!("{scope}:{}", client_key(&request));
    if let Some(retry_after) = state.rate_limiter.check(&bucket, limit).await {
        let request_id = request
            .extensions()
            .get::<String>()
            .cloned()
            .unwrap_or_else(|| Uuid::now_v7().to_string());
        return rate_limited_response(retry_after, request_id);
    }
    next.run(request).await
}

/// Derives a stable per-client key for rate limiting. Behind the deployment's
/// trusted reverse proxy the real client address is the last hop appended to
/// `X-Forwarded-For`; falls back to `X-Real-IP` and then the direct socket peer.
fn client_key(request: &Request) -> String {
    let headers = request.headers();
    if let Some(forwarded) = headers
        .get("x-forwarded-for")
        .and_then(|value| value.to_str().ok())
    {
        if let Some(last) = forwarded
            .split(',')
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .next_back()
        {
            return last.to_owned();
        }
    }
    if let Some(real_ip) = headers
        .get("x-real-ip")
        .and_then(|value| value.to_str().ok())
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        return real_ip.to_owned();
    }
    if let Some(ConnectInfo(addr)) = request.extensions().get::<ConnectInfo<SocketAddr>>() {
        return addr.ip().to_string();
    }
    "unknown".to_owned()
}

fn rate_limited_response(retry_after_seconds: u64, request_id: String) -> Response {
    let body = ErrorResponse {
        error: ApiError {
            code: ErrorCode::RateLimited,
            message: "Too many requests. Slow down and try again shortly.".into(),
            request_id,
            details: serde_json::Value::Null,
        },
    };
    let mut response = (StatusCode::TOO_MANY_REQUESTS, Json(body)).into_response();
    if let Ok(value) = HeaderValue::from_str(&retry_after_seconds.to_string()) {
        response
            .headers_mut()
            .insert(HeaderName::from_static("retry-after"), value);
    }
    response
}

/// Graceful maintenance mode leaves health checks, auth, admin operations, and
/// read-only REST requests available while rejecting hosted-vault mutations and
/// live WebSocket entry points. The state is persisted in the backup/server-data
/// volume and can be toggled from the admin settings page.
async fn maintenance_mode(State(state): State<AppState>, request: Request, next: Next) -> Response {
    let mode = api::load_maintenance_mode(&state.config);
    if !mode.enabled || maintenance_allowed(&request) {
        return next.run(request).await;
    }
    let request_id = request
        .extensions()
        .get::<String>()
        .cloned()
        .unwrap_or_else(|| Uuid::now_v7().to_string());
    maintenance_mode_response(request_id, mode.message)
}

fn maintenance_allowed(request: &Request) -> bool {
    let path = request.uri().path();
    let method = request.method();
    if path == "/" || path.starts_with("/admin") || path.starts_with("/health/") {
        return true;
    }
    if path == "/api/v1/auth/ws-ticket" {
        return false;
    }
    if path.starts_with("/api/v1/admin/") || path.starts_with("/api/v1/auth/") {
        return true;
    }
    if path == "/api/v1/users/me"
        || path.starts_with("/api/v1/users/")
        || path == "/api/v1/users/directory"
    {
        return matches!(method, &Method::GET);
    }
    if path.starts_with("/ws/v1/") {
        return false;
    }
    matches!(method, &Method::GET | &Method::HEAD | &Method::OPTIONS)
}

fn maintenance_mode_response(request_id: String, message: Option<String>) -> Response {
    let body = ErrorResponse {
        error: ApiError {
            code: ErrorCode::MaintenanceMode,
            message: message.unwrap_or_else(|| {
                "The Collab server is in maintenance mode. Mutating requests are temporarily paused."
                    .into()
            }),
            request_id,
            details: serde_json::Value::Null,
        },
    };
    let mut response = (StatusCode::SERVICE_UNAVAILABLE, Json(body)).into_response();
    response.headers_mut().insert(
        HeaderName::from_static("retry-after"),
        HeaderValue::from_static("60"),
    );
    response
}

async fn liveness() -> Json<DataResponse<HealthStatus>> {
    Json(DataResponse::new(health_status(HealthState::Ok)))
}

async fn readiness(State(state): State<AppState>) -> Response {
    let database_ready = database::is_ready(&state.database).await;
    let storage_ready = state.blobs.health_check().await.is_ok();
    let status = if database_ready && storage_ready {
        HealthState::Ok
    } else {
        HealthState::Degraded
    };
    let code = if status == HealthState::Ok {
        StatusCode::OK
    } else {
        StatusCode::SERVICE_UNAVAILABLE
    };
    (code, Json(DataResponse::new(health_status(status)))).into_response()
}

fn health_status(status: HealthState) -> HealthStatus {
    HealthStatus {
        status,
        service: "collab-server".into(),
        version: env!("CARGO_PKG_VERSION").into(),
        protocol_version: PROTOCOL_VERSION,
    }
}

async fn request_id(mut request: Request, next: Next) -> Response {
    let header_name = HeaderName::from_static(REQUEST_ID_HEADER);
    let request_id = request
        .headers()
        .get(&header_name)
        .and_then(|value| value.to_str().ok())
        .filter(|value| !value.is_empty() && value.len() <= 128)
        .map(ToOwned::to_owned)
        .unwrap_or_else(|| Uuid::now_v7().to_string());

    request.extensions_mut().insert(request_id.clone());
    let mut response = next.run(request).await;
    if let Ok(value) = HeaderValue::from_str(&request_id) {
        response.headers_mut().insert(header_name, value);
    }
    response
}

#[cfg(test)]
mod tests {
    use super::{build_router, client_key, AppState, LoginRateLimiter, RateLimiter};
    use crate::api::StoredMaintenanceMode;
    use crate::{config::ServerConfig, storage::FileSystemBlobStorage};
    use axum::{
        body::Body,
        http::{Request, StatusCode},
    };
    use http_body_util::BodyExt;
    use sqlx::postgres::PgPoolOptions;
    use std::{sync::Arc, time::Duration};
    use tower::ServiceExt;

    async fn test_state() -> AppState {
        test_state_with(ServerConfig::default()).await
    }

    async fn test_state_with(mut config: ServerConfig) -> AppState {
        let database = PgPoolOptions::new()
            .acquire_timeout(Duration::from_millis(50))
            .connect_lazy("postgres://collab:collab@127.0.0.1:1/unavailable")
            .unwrap();
        let dir = tempfile::tempdir().unwrap().keep();
        config.backup_dir = dir.join("backups");
        let blobs = Arc::new(FileSystemBlobStorage::new(dir).await.unwrap());
        AppState::new(config, database, blobs)
    }

    #[tokio::test]
    async fn liveness_does_not_depend_on_external_services() {
        let response = build_router(test_state().await)
            .oneshot(
                Request::builder()
                    .uri("/health/live")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::OK);
        assert!(response.headers().contains_key("x-request-id"));
        let body = response.into_body().collect().await.unwrap().to_bytes();
        assert!(std::str::from_utf8(&body)
            .unwrap()
            .contains("\"status\":\"ok\""));
    }

    #[tokio::test]
    async fn responses_include_security_headers() {
        let response = build_router(test_state().await)
            .oneshot(
                Request::builder()
                    .uri("/health/live")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        let headers = response.headers();
        assert_eq!(
            headers["content-security-policy"],
            super::CONTENT_SECURITY_POLICY
        );
        assert_eq!(headers["x-content-type-options"], "nosniff");
        assert_eq!(headers["referrer-policy"], "no-referrer");
        assert_eq!(headers["permissions-policy"], super::PERMISSIONS_POLICY);
        assert_eq!(headers["cross-origin-opener-policy"], "same-origin");
        assert_eq!(headers["x-frame-options"], "DENY");
    }

    #[tokio::test]
    async fn root_redirects_to_admin_dashboard() {
        let state = test_state().await;
        let response = build_router(state)
            .oneshot(
                Request::builder()
                    .uri("/")
                    .body(Body::empty())
                    .expect("request should build"),
            )
            .await
            .expect("router should respond");

        assert_eq!(response.status(), StatusCode::PERMANENT_REDIRECT);
        assert_eq!(response.headers()["location"], "/admin/");
    }

    #[tokio::test]
    async fn configured_json_body_limit_accepts_base64_import_over_default_limit() {
        let payload = serde_json::json!({
            "archiveBase64": "a".repeat(3 * 1024 * 1024)
        });
        let response = build_router(test_state().await)
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/v1/vaults/019eb16e-2a85-7070-bbe7-8cf09911c2c1/import")
                    .header("content-type", "application/json")
                    .body(Body::from(payload.to_string()))
                    .expect("request should build"),
            )
            .await
            .expect("router should respond");

        // Reaching authentication proves the JSON extractor accepted the body.
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn readiness_fails_when_database_is_unavailable() {
        let response = build_router(test_state().await)
            .oneshot(
                Request::builder()
                    .uri("/health/ready")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
    }

    #[tokio::test]
    async fn request_id_is_preserved_when_valid() {
        let response = build_router(test_state().await)
            .oneshot(
                Request::builder()
                    .uri("/health/live")
                    .header("x-request-id", "caller-request")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.headers()["x-request-id"], "caller-request");
    }

    #[tokio::test]
    async fn login_rate_limiter_blocks_the_sixth_attempt_and_can_reset() {
        let limiter = LoginRateLimiter::default();
        for _ in 0..5 {
            assert!(limiter.allow("alice").await);
        }
        assert!(!limiter.allow("alice").await);
        limiter.clear("alice").await;
        assert!(limiter.allow("alice").await);
    }

    #[tokio::test]
    async fn rate_limiter_allows_up_to_limit_then_reports_retry_after() {
        let limiter = RateLimiter::new(Duration::from_secs(60));
        assert_eq!(limiter.check("client", 2).await, None);
        assert_eq!(limiter.check("client", 2).await, None);
        // The third hit in the window is blocked with a positive retry hint.
        let retry = limiter.check("client", 2).await.expect("third hit blocked");
        assert!(retry >= 1 && retry <= 60);
        // A different key has its own independent budget.
        assert_eq!(limiter.check("other", 2).await, None);
        // A limit of zero disables the limiter entirely.
        for _ in 0..10 {
            assert_eq!(limiter.check("client", 0).await, None);
        }
    }

    #[test]
    fn client_key_prefers_the_last_forwarded_hop_then_real_ip() {
        // The trusted proxy appends the real client as the last X-Forwarded-For hop.
        let forwarded = Request::builder()
            .header("x-forwarded-for", "9.9.9.9, 203.0.113.7")
            .body(Body::empty())
            .unwrap();
        assert_eq!(client_key(&forwarded), "203.0.113.7");

        let real_ip = Request::builder()
            .header("x-real-ip", "198.51.100.4")
            .body(Body::empty())
            .unwrap();
        assert_eq!(client_key(&real_ip), "198.51.100.4");

        // With neither header (and no socket peer in tests) it degrades to a shared key.
        let bare = Request::builder().body(Body::empty()).unwrap();
        assert_eq!(client_key(&bare), "unknown");
    }

    #[tokio::test]
    async fn rest_requests_are_rate_limited_per_client_after_the_burst() {
        let state = test_state_with(ServerConfig {
            rest_rate_limit_per_minute: 2,
            ..ServerConfig::default()
        })
        .await;
        let send = |state: AppState| async move {
            build_router(state)
                .oneshot(
                    Request::builder()
                        .uri("/api/v1/users/directory")
                        .body(Body::empty())
                        .unwrap(),
                )
                .await
                .unwrap()
        };
        // The first two requests pass the limiter (and fail later for other reasons).
        for _ in 0..2 {
            let response = send(state.clone()).await;
            assert_ne!(response.status(), StatusCode::TOO_MANY_REQUESTS);
        }
        let blocked = send(state.clone()).await;
        assert_eq!(blocked.status(), StatusCode::TOO_MANY_REQUESTS);
        assert!(blocked.headers().contains_key("retry-after"));

        // Health checks are never rate limited.
        let health = build_router(state.clone())
            .oneshot(
                Request::builder()
                    .uri("/health/live")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(health.status(), StatusCode::OK);
    }

    #[tokio::test]
    async fn rest_rate_limit_of_zero_disables_limiting() {
        let state = test_state_with(ServerConfig {
            rest_rate_limit_per_minute: 0,
            ..ServerConfig::default()
        })
        .await;
        for _ in 0..20 {
            let response = build_router(state.clone())
                .oneshot(
                    Request::builder()
                        .uri("/api/v1/users/directory")
                        .body(Body::empty())
                        .unwrap(),
                )
                .await
                .unwrap();
            assert_ne!(response.status(), StatusCode::TOO_MANY_REQUESTS);
        }
    }

    #[tokio::test]
    async fn maintenance_mode_blocks_mutations_and_websockets_but_allows_reads() {
        let state = test_state().await;
        std::fs::create_dir_all(&state.config.backup_dir).unwrap();
        std::fs::write(
            state.config.backup_dir.join("maintenance-mode.json"),
            serde_json::to_string(&StoredMaintenanceMode {
                enabled: true,
                message: Some("Short upgrade window".into()),
                updated_at: Some("2026-06-19T09:00:00Z".into()),
            })
            .unwrap(),
        )
        .unwrap();

        let health = build_router(state.clone())
            .oneshot(
                Request::builder()
                    .uri("/health/live")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(health.status(), StatusCode::OK);

        let read = build_router(state.clone())
            .oneshot(
                Request::builder()
                    .uri("/api/v1/vaults")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(read.status(), StatusCode::UNAUTHORIZED);

        let write = build_router(state.clone())
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/v1/vaults")
                    .header("content-type", "application/json")
                    .body(Body::from("{}"))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(write.status(), StatusCode::SERVICE_UNAVAILABLE);
        assert_eq!(write.headers()["retry-after"], "60");
        let body = write.into_body().collect().await.unwrap().to_bytes();
        let raw = std::str::from_utf8(&body).unwrap();
        assert!(raw.contains("\"code\":\"maintenance_mode\""));
        assert!(raw.contains("Short upgrade window"));

        let ticket = build_router(state.clone())
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/v1/auth/ws-ticket")
                    .header("content-type", "application/json")
                    .body(Body::from("{}"))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(ticket.status(), StatusCode::SERVICE_UNAVAILABLE);

        let ws = build_router(state)
            .oneshot(
                Request::builder()
                    .uri("/ws/v1/vaults/019eb16e-2a85-7070-bbe7-8cf09911c2c1")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(ws.status(), StatusCode::SERVICE_UNAVAILABLE);
    }
}
