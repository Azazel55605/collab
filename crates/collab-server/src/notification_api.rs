use crate::{
    app::AppState,
    auth::{authenticate_native_access_token, generate_secret, hash_secret},
};
use axum::{
    extract::{Extension, Query, State},
    http::{HeaderMap, StatusCode},
    Json,
};
use chrono::{Duration, Utc};
use collab_protocol::DataResponse;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sqlx::{Postgres, Row, Transaction};
use uuid::Uuid;

const MAX_DEVICE_TOKEN_LENGTH: usize = 4_096;
const MAX_INSTALLATION_ID_LENGTH: usize = 160;
const MAX_APP_VERSION_LENGTH: usize = 80;
const MAX_PAGE_SIZE: i64 = 200;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RegisterDeviceRequest {
    installation_id: String,
    platform: String,
    provider: String,
    token: String,
    app_version: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RegisteredDevice {
    id: Uuid,
    installation_id: String,
    platform: String,
    provider: String,
    account_key: String,
    created_at: String,
    updated_at: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteDeviceRequest {
    installation_id: String,
    provider: String,
}

#[derive(Debug, Deserialize)]
pub struct NotificationChangesQuery {
    cursor: Option<i64>,
    limit: Option<i64>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NotificationChangePage {
    cursor: i64,
    changes: Vec<Value>,
    has_more: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PushInvalidation {
    pub(crate) schema_version: u32,
    pub(crate) invalidation_id: String,
    pub(crate) account_key: String,
    pub(crate) category: String,
    pub(crate) cursor: String,
    pub(crate) created_at: String,
}

pub async fn register_device(
    State(state): State<AppState>,
    Extension(request_id): Extension<String>,
    headers: HeaderMap,
    Json(request): Json<RegisterDeviceRequest>,
) -> Result<Json<DataResponse<RegisteredDevice>>, NotificationApiError> {
    validate_device_request(&request, &request_id)?;
    let user = authenticate_native_access_token(&state.database, bearer(&headers, &request_id)?)
        .await
        .map_err(|_| NotificationApiError::authentication(&request_id))?
        .ok_or_else(|| NotificationApiError::authentication(&request_id))?;
    let user_id =
        Uuid::parse_str(&user.user.id).map_err(|_| NotificationApiError::server(&request_id))?;
    let token_hash = hash_secret(request.token.trim());
    let existing = sqlx::query(
        "SELECT id,account_key,created_at FROM notification_devices
         WHERE user_id=$1 AND installation_id=$2 AND provider=$3",
    )
    .bind(user_id)
    .bind(request.installation_id.trim())
    .bind(request.provider.as_str())
    .fetch_optional(&state.database)
    .await
    .map_err(|_| NotificationApiError::server(&request_id))?;
    let id = existing
        .as_ref()
        .map(|row| row.get("id"))
        .unwrap_or_else(Uuid::now_v7);
    let account_key = existing
        .as_ref()
        .map(|row| row.get("account_key"))
        .unwrap_or_else(|| hash_secret(&generate_secret()));
    let row = sqlx::query(
        r#"INSERT INTO notification_devices
           (id,user_id,installation_id,platform,provider,token,token_hash,account_key,app_version)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
           ON CONFLICT (user_id,installation_id,provider) DO UPDATE SET
             platform=EXCLUDED.platform,token=EXCLUDED.token,token_hash=EXCLUDED.token_hash,
             app_version=EXCLUDED.app_version,active=TRUE,last_seen_at=now(),updated_at=now()
           RETURNING id,installation_id,platform,provider,account_key,created_at,updated_at"#,
    )
    .bind(id)
    .bind(user_id)
    .bind(request.installation_id.trim())
    .bind(&request.platform)
    .bind(&request.provider)
    .bind(request.token.trim())
    .bind(token_hash)
    .bind(account_key)
    .bind(request.app_version.as_deref())
    .fetch_one(&state.database)
    .await
    .map_err(|error| {
        if error
            .as_database_error()
            .is_some_and(|database| database.is_unique_violation())
        {
            NotificationApiError::validation(
                "This push token is already registered to another installation.",
                &request_id,
            )
        } else {
            NotificationApiError::server(&request_id)
        }
    })?;
    Ok(Json(DataResponse::new(device_from_row(&row))))
}

pub async fn delete_device(
    State(state): State<AppState>,
    Extension(request_id): Extension<String>,
    headers: HeaderMap,
    Json(request): Json<DeleteDeviceRequest>,
) -> Result<StatusCode, NotificationApiError> {
    if request.installation_id.trim().is_empty()
        || request.installation_id.len() > MAX_INSTALLATION_ID_LENGTH
        || request.provider != "fcm"
    {
        return Err(NotificationApiError::validation(
            "Notification device identity is invalid.",
            &request_id,
        ));
    }
    let user = authenticate_native_access_token(&state.database, bearer(&headers, &request_id)?)
        .await
        .map_err(|_| NotificationApiError::authentication(&request_id))?
        .ok_or_else(|| NotificationApiError::authentication(&request_id))?;
    let user_id =
        Uuid::parse_str(&user.user.id).map_err(|_| NotificationApiError::server(&request_id))?;
    sqlx::query(
        "UPDATE notification_devices SET active=FALSE,token='',updated_at=now()
         WHERE user_id=$1 AND installation_id=$2 AND provider=$3",
    )
    .bind(user_id)
    .bind(request.installation_id.trim())
    .bind(request.provider)
    .execute(&state.database)
    .await
    .map_err(|_| NotificationApiError::server(&request_id))?;
    Ok(StatusCode::NO_CONTENT)
}

pub async fn list_changes(
    State(state): State<AppState>,
    Extension(request_id): Extension<String>,
    headers: HeaderMap,
    Query(query): Query<NotificationChangesQuery>,
) -> Result<Json<DataResponse<NotificationChangePage>>, NotificationApiError> {
    let cursor = query.cursor.unwrap_or(0);
    let limit = query.limit.unwrap_or(100);
    if cursor < 0 || !(1..=MAX_PAGE_SIZE).contains(&limit) {
        return Err(NotificationApiError::validation(
            "Notification cursor or page size is invalid.",
            &request_id,
        ));
    }
    let user = authenticate_native_access_token(&state.database, bearer(&headers, &request_id)?)
        .await
        .map_err(|_| NotificationApiError::authentication(&request_id))?
        .ok_or_else(|| NotificationApiError::authentication(&request_id))?;
    let user_id =
        Uuid::parse_str(&user.user.id).map_err(|_| NotificationApiError::server(&request_id))?;
    let rows = sqlx::query(
        r#"SELECT sequence,envelope FROM notification_events
           WHERE user_id=$1 AND sequence>$2 AND expires_at>now()
           ORDER BY sequence LIMIT $3"#,
    )
    .bind(user_id)
    .bind(cursor)
    .bind(limit + 1)
    .fetch_all(&state.database)
    .await
    .map_err(|_| NotificationApiError::server(&request_id))?;
    let has_more = rows.len() as i64 > limit;
    let selected = rows.into_iter().take(limit as usize).collect::<Vec<_>>();
    let next_cursor = selected
        .last()
        .map(|row| row.get("sequence"))
        .unwrap_or(cursor);
    Ok(Json(DataResponse::new(NotificationChangePage {
        cursor: next_cursor,
        changes: selected
            .into_iter()
            .map(|row| row.get("envelope"))
            .collect(),
        has_more,
    })))
}

pub async fn insert_event(
    tx: &mut Transaction<'_, Postgres>,
    user_id: Uuid,
    category: &str,
    dedupe_key: &str,
    envelope: &Value,
) -> Result<Option<Uuid>, sqlx::Error> {
    let event_id = Uuid::now_v7();
    let row = sqlx::query(
        r#"INSERT INTO notification_events(id,user_id,category,dedupe_key,envelope)
           VALUES ($1,$2,$3,$4,$5)
           ON CONFLICT (user_id,dedupe_key) DO NOTHING
           RETURNING sequence"#,
    )
    .bind(event_id)
    .bind(user_id)
    .bind(category)
    .bind(dedupe_key)
    .bind(envelope)
    .fetch_optional(&mut **tx)
    .await?;
    let Some(row) = row else {
        return Ok(None);
    };
    let sequence: i64 = row.get("sequence");
    sqlx::query(
        r#"INSERT INTO notification_push_deliveries(event_id,device_id)
           SELECT $1,id FROM notification_devices WHERE user_id=$2 AND active=TRUE
           ON CONFLICT DO NOTHING"#,
    )
    .bind(event_id)
    .bind(user_id)
    .execute(&mut **tx)
    .await?;
    let _ = sequence;
    Ok(Some(event_id))
}

pub fn envelope_id(
    category: &str,
    account_key: &str,
    source_id: &str,
    delivery_key: &str,
) -> String {
    format!(
        "notification:v1:{}:{}:{}:-:{}",
        encode_component(category),
        encode_component(account_key),
        encode_component(source_id),
        encode_component(delivery_key),
    )
}

pub fn account_key(user_id: Uuid) -> String {
    hash_secret(&format!("collab-notification-account:{user_id}"))
}

pub fn expires_at(days: i64) -> String {
    (Utc::now() + Duration::days(days)).to_rfc3339()
}

fn encode_component(value: &str) -> String {
    let mut encoded = String::new();
    for byte in value.bytes() {
        if byte.is_ascii_alphanumeric()
            || matches!(
                byte,
                b'-' | b'_' | b'.' | b'!' | b'~' | b'*' | b'\'' | b'(' | b')'
            )
        {
            encoded.push(char::from(byte));
        } else {
            encoded.push_str(&format!("%{byte:02X}"));
        }
    }
    encoded
}

fn validate_device_request(
    request: &RegisterDeviceRequest,
    request_id: &str,
) -> Result<(), NotificationApiError> {
    if request.installation_id.trim().is_empty()
        || request.installation_id.len() > MAX_INSTALLATION_ID_LENGTH
        || request.token.trim().is_empty()
        || request.token.len() > MAX_DEVICE_TOKEN_LENGTH
        || request.platform != "android"
        || request.provider != "fcm"
        || request
            .app_version
            .as_ref()
            .is_some_and(|value| value.len() > MAX_APP_VERSION_LENGTH)
    {
        return Err(NotificationApiError::validation(
            "Notification device registration is invalid.",
            request_id,
        ));
    }
    Ok(())
}

fn bearer<'a>(headers: &'a HeaderMap, request_id: &str) -> Result<&'a str, NotificationApiError> {
    headers
        .get("authorization")
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "))
        .ok_or_else(|| NotificationApiError::authentication(request_id))
}

fn device_from_row(row: &sqlx::postgres::PgRow) -> RegisteredDevice {
    RegisteredDevice {
        id: row.get("id"),
        installation_id: row.get("installation_id"),
        platform: row.get("platform"),
        provider: row.get("provider"),
        account_key: row.get("account_key"),
        created_at: row
            .get::<chrono::DateTime<Utc>, _>("created_at")
            .to_rfc3339(),
        updated_at: row
            .get::<chrono::DateTime<Utc>, _>("updated_at")
            .to_rfc3339(),
    }
}

#[derive(Debug)]
pub struct NotificationApiError {
    status: StatusCode,
    message: String,
    request_id: String,
}

impl NotificationApiError {
    fn validation(message: impl Into<String>, request_id: &str) -> Self {
        Self {
            status: StatusCode::BAD_REQUEST,
            message: message.into(),
            request_id: request_id.to_string(),
        }
    }

    fn authentication(request_id: &str) -> Self {
        Self {
            status: StatusCode::UNAUTHORIZED,
            message: "Native authentication is required.".to_string(),
            request_id: request_id.to_string(),
        }
    }

    fn server(request_id: &str) -> Self {
        Self {
            status: StatusCode::INTERNAL_SERVER_ERROR,
            message: "The notification operation failed.".to_string(),
            request_id: request_id.to_string(),
        }
    }
}

impl axum::response::IntoResponse for NotificationApiError {
    fn into_response(self) -> axum::response::Response {
        axum::response::IntoResponse::into_response((
            self.status,
            Json(json!({
                "error": {
                    "code": if self.status == StatusCode::UNAUTHORIZED {
                        "authentication_required"
                    } else if self.status == StatusCode::BAD_REQUEST {
                        "validation_failed"
                    } else {
                        "server_unavailable"
                    },
                    "message": self.message,
                    "requestId": self.request_id,
                    "details": {}
                }
            })),
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::{envelope_id, validate_device_request, RegisterDeviceRequest};

    #[test]
    fn notification_identity_matches_the_client_contract() {
        assert_eq!(
            envelope_id(
                "collaboration.mention",
                "0123456789abcdef",
                "message id",
                "mention-user"
            ),
            "notification:v1:collaboration.mention:0123456789abcdef:message%20id:-:mention-user"
        );
    }

    #[test]
    fn device_registration_accepts_only_bounded_android_fcm_values() {
        let request = RegisterDeviceRequest {
            installation_id: "installation-1".to_string(),
            platform: "android".to_string(),
            provider: "fcm".to_string(),
            token: "opaque-token".to_string(),
            app_version: Some("0.6.7".to_string()),
        };
        assert!(validate_device_request(&request, "request").is_ok());
        let invalid = RegisterDeviceRequest {
            token: String::new(),
            ..request
        };
        assert!(validate_device_request(&invalid, "request").is_err());
    }
}
