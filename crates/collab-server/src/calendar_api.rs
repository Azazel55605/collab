use crate::{
    app::AppState,
    auth::{authenticate_native_access_token, generate_secret, hash_secret, AuthenticatedUser},
    calendar_feeds::fetch_calendar_feed,
};
use axum::{
    extract::{Extension, Path, Query, State},
    http::{header, HeaderMap, HeaderValue, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use base64::Engine as _;
use chrono::{DateTime, NaiveDate, TimeZone, Utc};
use collab_calendar::{
    export_ics, parse_ics, CalendarAttachment, CalendarAttendee, CalendarDefinition, CalendarItem,
    CalendarLocation, CalendarMutation, CalendarOperation, CalendarSubscription, CalendarTimeValue,
};
use collab_protocol::{ApiError, DataResponse, ErrorCode, ErrorResponse};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use sqlx::{Postgres, Row, Transaction};
use std::collections::{HashMap, HashSet};
use uuid::Uuid;

const MAX_QUERY_ITEMS: i64 = 5_000;
const MAX_CHANGE_ITEMS: i64 = 1_000;
const MAX_OPERATION_ITEMS: usize = 500;
const MAX_PUBLISHED_FEED_ITEMS: i64 = 5_000;
const MAX_PUBLISHED_FEED_BYTES: usize = 5 * 1024 * 1024;

#[derive(Debug)]
pub struct CalendarApiError {
    status: StatusCode,
    error: ApiError,
}

impl CalendarApiError {
    fn new(
        status: StatusCode,
        code: ErrorCode,
        message: impl Into<String>,
        request_id: &str,
    ) -> Self {
        Self {
            status,
            error: ApiError {
                code,
                message: message.into(),
                request_id: request_id.to_owned(),
                details: Value::Null,
            },
        }
    }

    pub(crate) fn authentication(request_id: &str) -> Self {
        Self::new(
            StatusCode::UNAUTHORIZED,
            ErrorCode::AuthenticationRequired,
            "Connect to the Collab server before accessing calendars.",
            request_id,
        )
    }

    pub(crate) fn validation(message: impl Into<String>, request_id: &str) -> Self {
        Self::new(
            StatusCode::BAD_REQUEST,
            ErrorCode::ValidationFailed,
            message,
            request_id,
        )
    }

    pub(crate) fn not_found(request_id: &str) -> Self {
        Self::new(
            StatusCode::NOT_FOUND,
            ErrorCode::ResourceNotFound,
            "Calendar resource not found.",
            request_id,
        )
    }

    fn conflict(message: impl Into<String>, request_id: &str) -> Self {
        Self::new(
            StatusCode::CONFLICT,
            ErrorCode::RevisionConflict,
            message,
            request_id,
        )
    }

    pub(crate) fn server(request_id: &str) -> Self {
        Self::new(
            StatusCode::INTERNAL_SERVER_ERROR,
            ErrorCode::ServerUnavailable,
            "The calendar request could not be completed.",
            request_id,
        )
    }

    fn quota(request_id: &str) -> Self {
        Self::new(
            StatusCode::PAYLOAD_TOO_LARGE,
            ErrorCode::QuotaExceeded,
            "The hosted calendar storage quota would be exceeded.",
            request_id,
        )
    }
}

fn logical_size(payload: &Value) -> i64 {
    serde_json::to_vec(payload)
        .map(|value| value.len() as i64)
        .unwrap_or(i64::MAX)
}

async fn ensure_calendar_quota(
    tx: &mut Transaction<'_, Postgres>,
    owner: Uuid,
    quota_bytes: u64,
    replaced_bytes: i64,
    proposed_bytes: i64,
    request_id: &str,
) -> Result<(), CalendarApiError> {
    if quota_bytes == 0 {
        return Ok(());
    }
    let current = sqlx::query_scalar::<_, i64>(
        r#"SELECT (
             COALESCE((SELECT SUM(logical_size_bytes) FROM calendars WHERE owner_id=$1 AND deleted_at IS NULL),0) +
             COALESCE((SELECT SUM(logical_size_bytes) FROM calendar_items WHERE owner_id=$1 AND deleted_at IS NULL),0) +
             COALESCE((SELECT SUM(size_bytes) FROM calendar_attachment_uploads WHERE owner_id=$1),0) +
             COALESCE((SELECT SUM(logical_size_bytes) FROM calendar_subscriptions WHERE owner_id=$1),0)
           )::bigint"#,
    )
    .bind(owner)
    .fetch_one(&mut **tx)
    .await
    .map_err(|_| CalendarApiError::server(request_id))?;
    let next = current
        .saturating_sub(replaced_bytes)
        .saturating_add(proposed_bytes);
    if next < 0 || next as u64 > quota_bytes {
        return Err(CalendarApiError::quota(request_id));
    }
    Ok(())
}

async fn replace_item_relations(
    tx: &mut Transaction<'_, Postgres>,
    owner: Uuid,
    item_id: Uuid,
    calendar_id: Uuid,
    item: &CalendarItem,
    request_id: &str,
) -> Result<(), CalendarApiError> {
    let calendar_row = sqlx::query(
        "SELECT payload #>> '{location,kind}' AS location_kind, payload #>> '{location,serverUrl}' AS server_url FROM calendars WHERE id=$1 AND owner_id=$2 AND deleted_at IS NULL",
    )
    .bind(calendar_id)
    .bind(owner)
    .fetch_one(&mut **tx)
    .await
    .map_err(|_| CalendarApiError::server(request_id))?;
    let calendar_location_kind: Option<String> = calendar_row.get("location_kind");
    let calendar_server_url: Option<String> = calendar_row.get("server_url");
    sqlx::query("DELETE FROM calendar_attendees WHERE owner_id=$1 AND item_id=$2")
        .bind(owner)
        .bind(item_id)
        .execute(&mut **tx)
        .await
        .map_err(|_| CalendarApiError::server(request_id))?;
    for attendee in &item.attendees {
        let payload =
            serde_json::to_value(attendee).map_err(|_| CalendarApiError::server(request_id))?;
        let (id, kind, collab_user_id, email, response, role) = match attendee {
            CalendarAttendee::CollabUser {
                id,
                server_url,
                user_id,
                response,
                role,
                ..
            } => {
                if calendar_server_url.as_deref() != Some(server_url.as_str()) {
                    return Err(CalendarApiError::validation(
                        "Calendar attendees must belong to the calendar's server.",
                        request_id,
                    ));
                }
                let attendee_user_id = parse_uuid(user_id, "Attendee user ID", request_id)?;
                let active_user = sqlx::query_scalar::<_, bool>(
                    "SELECT EXISTS(SELECT 1 FROM users WHERE id=$1 AND status='active')",
                )
                .bind(attendee_user_id)
                .fetch_one(&mut **tx)
                .await
                .map_err(|_| CalendarApiError::server(request_id))?;
                if !active_user {
                    return Err(CalendarApiError::validation(
                        "Calendar attendee is not an active user on this server.",
                        request_id,
                    ));
                }
                (
                    id,
                    "collabUser",
                    Some(attendee_user_id),
                    None::<&str>,
                    response,
                    role,
                )
            }
            CalendarAttendee::Email {
                id,
                email,
                response,
                role,
                ..
            } if calendar_location_kind.as_deref() == Some("subscription") => {
                (id, "email", None, Some(email.as_str()), response, role)
            }
            CalendarAttendee::Email { .. } => {
                return Err(CalendarApiError::validation(
                    "Hosted calendars currently support same-server Collab users only.",
                    request_id,
                ));
            }
        };
        sqlx::query(
            "INSERT INTO calendar_attendees (owner_id,item_id,attendee_id,kind,collab_user_id,email,response,role,payload) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)",
        ).bind(owner).bind(item_id).bind(id).bind(kind).bind(collab_user_id).bind(email)
          .bind(response).bind(role).bind(payload).execute(&mut **tx).await
          .map_err(|_| CalendarApiError::server(request_id))?;
    }

    let invited_user_ids = item
        .attendees
        .iter()
        .filter_map(|attendee| match attendee {
            CalendarAttendee::CollabUser { user_id, .. } => Uuid::parse_str(user_id).ok(),
            CalendarAttendee::Email { .. } => None,
        })
        .filter(|user_id| user_id != &owner)
        .collect::<Vec<_>>();
    sqlx::query(
        "DELETE FROM calendar_invitations WHERE organizer_owner_id=$1 AND item_id=$2 AND NOT (attendee_user_id = ANY($3))",
    )
    .bind(owner)
    .bind(item_id)
    .bind(&invited_user_ids)
    .execute(&mut **tx)
    .await
    .map_err(|_| CalendarApiError::server(request_id))?;
    for attendee in &item.attendees {
        let CalendarAttendee::CollabUser {
            id,
            user_id,
            response,
            ..
        } = attendee
        else {
            continue;
        };
        let attendee_user_id = parse_uuid(user_id, "Attendee user ID", request_id)?;
        if attendee_user_id == owner {
            continue;
        }
        let invitation_id = sqlx::query_scalar::<_, Uuid>(
            "SELECT id FROM calendar_invitations WHERE item_id=$1 AND attendee_user_id=$2",
        )
        .bind(item_id)
        .bind(attendee_user_id)
        .fetch_optional(&mut **tx)
        .await
        .map_err(|_| CalendarApiError::server(request_id))?
        .unwrap_or_else(Uuid::now_v7);
        let invitation_payload = serde_json::json!({
            "id": invitation_id,
            "organizerUserId": owner,
            "attendeeUserId": attendee_user_id,
            "attendeeId": id,
            "response": response,
            "item": item,
        });
        sqlx::query(
            r#"INSERT INTO calendar_invitations
               (id,organizer_owner_id,attendee_user_id,item_id,attendee_id,response,payload)
               VALUES ($1,$2,$3,$4,$5,$6,$7)
               ON CONFLICT (item_id,attendee_user_id) DO UPDATE SET
                 attendee_id=EXCLUDED.attendee_id,response=EXCLUDED.response,
                 payload=EXCLUDED.payload,updated_at=now()"#,
        )
        .bind(invitation_id)
        .bind(owner)
        .bind(attendee_user_id)
        .bind(item_id)
        .bind(id)
        .bind(response)
        .bind(invitation_payload)
        .execute(&mut **tx)
        .await
        .map_err(|_| CalendarApiError::server(request_id))?;
    }

    sqlx::query("DELETE FROM calendar_attachments WHERE owner_id=$1 AND item_id=$2")
        .bind(owner)
        .bind(item_id)
        .execute(&mut **tx)
        .await
        .map_err(|_| CalendarApiError::server(request_id))?;
    for attachment in &item.attachments {
        let payload =
            serde_json::to_value(attachment).map_err(|_| CalendarApiError::server(request_id))?;
        let (id, kind, upload_id) = match attachment {
            CalendarAttachment::VaultFile { id, .. } => (id, "vaultFile", None),
            CalendarAttachment::KanbanTask { id, .. } => (id, "kanbanTask", None),
            CalendarAttachment::ExternalUrl { id, .. } => (id, "externalUrl", None),
            CalendarAttachment::Uploaded {
                id, attachment_id, ..
            } => {
                let upload_id = parse_uuid(attachment_id, "Uploaded attachment ID", request_id)?;
                let exists = sqlx::query_scalar::<_, bool>(
                    "SELECT EXISTS(SELECT 1 FROM calendar_attachment_uploads WHERE id=$1 AND owner_id=$2 AND calendar_id=$3)",
                ).bind(upload_id).bind(owner).bind(calendar_id).fetch_one(&mut **tx).await
                  .map_err(|_| CalendarApiError::server(request_id))?;
                if !exists {
                    return Err(CalendarApiError::not_found(request_id));
                }
                (id, "uploaded", Some(upload_id))
            }
        };
        sqlx::query(
            "INSERT INTO calendar_attachments (owner_id,item_id,attachment_id,kind,upload_id,payload) VALUES ($1,$2,$3,$4,$5,$6)",
        ).bind(owner).bind(item_id).bind(id).bind(kind).bind(upload_id).bind(payload)
          .execute(&mut **tx).await.map_err(|_| CalendarApiError::server(request_id))?;
    }
    Ok(())
}

impl IntoResponse for CalendarApiError {
    fn into_response(self) -> Response {
        (self.status, Json(ErrorResponse { error: self.error })).into_response()
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CalendarQuery {
    from: String,
    to: String,
    limit: Option<i64>,
    #[serde(default)]
    include_deleted: bool,
}

#[derive(Debug, Deserialize)]
pub struct ChangesQuery {
    cursor: Option<i64>,
    limit: Option<i64>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CalendarChanges {
    changes: Vec<CalendarChange>,
    cursor: i64,
    has_more: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CalendarChange {
    sequence: i64,
    entity_type: String,
    entity_id: String,
    operation: String,
    payload: Option<Value>,
    changed_at: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OperationsRequest {
    operations: Vec<CalendarOperation>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OperationResult {
    client_operation_id: String,
    applied: bool,
    change_sequence: Option<i64>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CalendarAttachmentUploadRequest {
    name: String,
    media_type: String,
    content_base64: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CalendarAttachmentUpload {
    id: String,
    name: String,
    media_type: String,
    size_bytes: i64,
    sha256: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    content_base64: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InvitationResponseRequest {
    response: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CalendarPublishedFeed {
    id: String,
    calendar_id: String,
    created_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    last_accessed_at: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CreatedCalendarPublishedFeed {
    #[serde(flatten)]
    feed: CalendarPublishedFeed,
    feed_path: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateCalendarSubscriptionRequest {
    name: String,
    color: String,
    default_time_zone: String,
    feed_url: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CreatedCalendarSubscription {
    calendar: CalendarDefinition,
    subscription: CalendarSubscription,
    warnings: Vec<String>,
}

pub(crate) async fn require_native_user(
    state: &AppState,
    headers: &HeaderMap,
    request_id: &str,
) -> Result<AuthenticatedUser, CalendarApiError> {
    let token = headers
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "))
        .ok_or_else(|| CalendarApiError::authentication(request_id))?;
    authenticate_native_access_token(&state.database, token)
        .await
        .map_err(|_| CalendarApiError::server(request_id))?
        .ok_or_else(|| CalendarApiError::authentication(request_id))
}

pub(crate) fn owner_id(
    user: &AuthenticatedUser,
    request_id: &str,
) -> Result<Uuid, CalendarApiError> {
    Uuid::parse_str(&user.user.id).map_err(|_| CalendarApiError::server(request_id))
}

fn parse_uuid(value: &str, label: &str, request_id: &str) -> Result<Uuid, CalendarApiError> {
    Uuid::parse_str(value)
        .map_err(|_| CalendarApiError::validation(format!("{label} must be a UUID."), request_id))
}

fn validate_time_value(
    value: &CalendarTimeValue,
    label: &str,
    request_id: &str,
) -> Result<(), CalendarApiError> {
    let valid = match value {
        CalendarTimeValue::DateTime {
            date_time,
            time_zone,
        } => !time_zone.trim().is_empty() && DateTime::parse_from_rfc3339(date_time).is_ok(),
        CalendarTimeValue::Date { date } => NaiveDate::parse_from_str(date, "%Y-%m-%d").is_ok(),
    };
    if !valid {
        return Err(CalendarApiError::validation(
            format!("{label} is invalid."),
            request_id,
        ));
    }
    Ok(())
}

fn validate_recurrence_rule(value: &str, request_id: &str) -> Result<(), CalendarApiError> {
    if value.is_empty() || value.len() > 4_096 || value.starts_with("RRULE:") {
        return Err(CalendarApiError::validation(
            "Recurrence rule is invalid.",
            request_id,
        ));
    }
    let mut frequency = None;
    let mut keys = std::collections::HashSet::new();
    for segment in value.split(';') {
        let Some((key, part)) = segment.split_once('=') else {
            return Err(CalendarApiError::validation(
                "Recurrence rule is invalid.",
                request_id,
            ));
        };
        if key.is_empty()
            || part.is_empty()
            || !key.chars().all(|character| character.is_ascii_uppercase())
            || !keys.insert(key)
        {
            return Err(CalendarApiError::validation(
                "Recurrence rule is invalid.",
                request_id,
            ));
        }
        if key == "FREQ" {
            frequency = Some(part);
        }
        if matches!(key, "COUNT" | "INTERVAL")
            && part
                .parse::<u32>()
                .ok()
                .filter(|value| *value > 0)
                .is_none()
        {
            return Err(CalendarApiError::validation(
                "Recurrence rule is invalid.",
                request_id,
            ));
        }
    }
    if !matches!(
        frequency,
        Some("SECONDLY" | "MINUTELY" | "HOURLY" | "DAILY" | "WEEKLY" | "MONTHLY" | "YEARLY")
    ) {
        return Err(CalendarApiError::validation(
            "Recurrence rule must include a supported FREQ value.",
            request_id,
        ));
    }
    Ok(())
}

fn validate_item(item: &CalendarItem, request_id: &str) -> Result<(), CalendarApiError> {
    parse_uuid(&item.id, "Item ID", request_id)?;
    parse_uuid(&item.calendar_id, "Calendar ID", request_id)?;
    if item.uid.trim().is_empty()
        || item.title.trim().is_empty()
        || item.title.chars().count() > 500
        || item
            .description
            .as_ref()
            .is_some_and(|value| value.len() > 100_000)
        || item.attendees.len() > 100
        || item.attachments.len() > 50
    {
        return Err(CalendarApiError::validation(
            "Calendar item content exceeds its supported limits.",
            request_id,
        ));
    }
    for (value, label) in [
        (item.start.as_ref(), "Item start"),
        (item.end.as_ref(), "Item end"),
        (item.due.as_ref(), "Item deadline"),
        (item.recurrence_id.as_ref(), "Recurrence ID"),
    ] {
        if let Some(value) = value {
            validate_time_value(value, label, request_id)?;
        }
    }
    match item.kind {
        collab_calendar::CalendarItemKind::Event if item.start.is_none() || item.end.is_none() => {
            return Err(CalendarApiError::validation(
                "Events require valid start and end values.",
                request_id,
            ));
        }
        collab_calendar::CalendarItemKind::Birthday => {
            let valid = item
                .date
                .as_deref()
                .is_some_and(|value| NaiveDate::parse_from_str(value, "%Y-%m-%d").is_ok());
            if !valid {
                return Err(CalendarApiError::validation(
                    "Birthdays require a valid date.",
                    request_id,
                ));
            }
        }
        _ => {}
    }
    if let Some(recurrence) = &item.recurrence {
        validate_recurrence_rule(&recurrence.rrule, request_id)?;
        for value in recurrence.rdates.iter().chain(&recurrence.exdates) {
            validate_time_value(value, "Recurrence date", request_id)?;
        }
    }
    for value in [&item.created_at, &item.updated_at] {
        if DateTime::parse_from_rfc3339(value).is_err() {
            return Err(CalendarApiError::validation(
                "Calendar item timestamps must be RFC 3339 values.",
                request_id,
            ));
        }
    }
    Ok(())
}

fn validate_calendar(
    calendar: &CalendarDefinition,
    owner: Uuid,
    request_id: &str,
) -> Result<(), CalendarApiError> {
    parse_uuid(&calendar.id, "Calendar ID", request_id)?;
    parse_uuid(&calendar.global_id, "Calendar global ID", request_id)?;
    if calendar.name.trim().is_empty() || calendar.name.chars().count() > 120 {
        return Err(CalendarApiError::validation(
            "Calendar name must be between 1 and 120 characters.",
            request_id,
        ));
    }
    match &calendar.location {
        collab_calendar::CalendarLocation::Hosted { user_id, .. }
            if user_id == &owner.to_string() => {}
        _ => {
            return Err(CalendarApiError::validation(
                "Hosted calendars must target the authenticated user.",
                request_id,
            ))
        }
    }
    Ok(())
}

fn canonical_calendar(
    mut calendar: CalendarDefinition,
    revision: i64,
    created_at: DateTime<Utc>,
) -> CalendarDefinition {
    let now = Utc::now().to_rfc3339();
    calendar.schema_version = collab_calendar::CALENDAR_SCHEMA_VERSION;
    calendar.name = calendar.name.trim().to_owned();
    calendar.revision = revision;
    calendar.created_at = created_at.to_rfc3339();
    calendar.updated_at = now;
    calendar
}

async fn insert_change(
    tx: &mut Transaction<'_, Postgres>,
    owner: Uuid,
    entity_type: &str,
    entity_id: Uuid,
    operation: &str,
    payload: Option<&Value>,
) -> Result<i64, sqlx::Error> {
    sqlx::query_scalar(
        r#"INSERT INTO calendar_change_log (owner_id, entity_type, entity_id, operation, payload)
           VALUES ($1, $2, $3, $4, $5) RETURNING sequence"#,
    )
    .bind(owner)
    .bind(entity_type)
    .bind(entity_id)
    .bind(operation)
    .bind(payload)
    .fetch_one(&mut **tx)
    .await
}

#[derive(Clone, Debug)]
struct ProjectedKanbanCard {
    card_id: String,
    title: String,
    description: Option<String>,
    assignees: Vec<Uuid>,
    start_date: Option<String>,
    due_date: Option<String>,
    completed: bool,
    completed_at: Option<String>,
    created_at: String,
    recurrence: Option<Value>,
}

fn stable_projection_uuid(namespace: &str, parts: &[&str]) -> Uuid {
    let mut digest = Sha256::new();
    digest.update(namespace.as_bytes());
    for part in parts {
        digest.update([0]);
        digest.update(part.as_bytes());
    }
    let hash = digest.finalize();
    let mut bytes = [0_u8; 16];
    bytes.copy_from_slice(&hash[..16]);
    bytes[6] = (bytes[6] & 0x0f) | 0x50;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    Uuid::from_bytes(bytes)
}

fn valid_date(value: Option<&Value>) -> Option<String> {
    value
        .and_then(Value::as_str)
        .filter(|value| NaiveDate::parse_from_str(value, "%Y-%m-%d").is_ok())
        .map(str::to_owned)
}

fn timestamp_millis(value: Option<&Value>, fallback: &str) -> String {
    value
        .and_then(Value::as_i64)
        .and_then(|millis| Utc.timestamp_millis_opt(millis).single())
        .map(|value| value.to_rfc3339())
        .unwrap_or_else(|| fallback.to_owned())
}

fn projected_recurrence(value: Option<&Value>) -> Option<Value> {
    let rule = value?.as_object()?;
    if !rule
        .get("enabled")
        .and_then(Value::as_bool)
        .unwrap_or(false)
    {
        return None;
    }
    let interval = rule
        .get("interval")
        .and_then(Value::as_i64)
        .unwrap_or(1)
        .clamp(1, 365);
    let mode = rule.get("mode").and_then(Value::as_str).unwrap_or("daily");
    let rrule = match mode {
        "weekly" => {
            const DAYS: [&str; 7] = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];
            let byday = rule
                .get("weekdays")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter_map(Value::as_u64)
                .filter_map(|day| DAYS.get(day as usize))
                .copied()
                .collect::<Vec<_>>();
            format!(
                "FREQ=WEEKLY;INTERVAL={interval}{}",
                if byday.is_empty() {
                    String::new()
                } else {
                    format!(";BYDAY={}", byday.join(","))
                }
            )
        }
        "monthly" => format!("FREQ=MONTHLY;INTERVAL={interval}"),
        _ => format!("FREQ=DAILY;INTERVAL={interval}"),
    };
    Some(serde_json::json!({ "rrule": rrule }))
}

fn projected_kanban_cards(content: &str, now: &str) -> Option<Vec<ProjectedKanbanCard>> {
    let board: Value = serde_json::from_str(content).ok()?;
    let columns = board.get("columns")?.as_array()?;
    let mut cards = Vec::new();
    for column in columns {
        let Some(column_cards) = column.get("cards").and_then(Value::as_array) else {
            continue;
        };
        for card in column_cards {
            let Some(card_id) = card
                .get("id")
                .and_then(Value::as_str)
                .filter(|id| !id.is_empty())
            else {
                continue;
            };
            if card
                .get("archived")
                .and_then(Value::as_bool)
                .unwrap_or(false)
            {
                continue;
            }
            let assignees = card
                .get("assignees")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter_map(Value::as_str)
                .filter_map(|value| Uuid::parse_str(value).ok())
                .collect::<Vec<_>>();
            if assignees.is_empty() {
                continue;
            }
            cards.push(ProjectedKanbanCard {
                card_id: card_id.to_owned(),
                title: card
                    .get("title")
                    .and_then(Value::as_str)
                    .filter(|title| !title.trim().is_empty())
                    .unwrap_or("Untitled task")
                    .chars()
                    .take(500)
                    .collect(),
                description: card
                    .get("description")
                    .and_then(Value::as_str)
                    .filter(|description| !description.is_empty())
                    .map(|description| description.chars().take(100_000).collect()),
                assignees,
                start_date: valid_date(card.get("startDate")),
                due_date: valid_date(card.get("dueDate")),
                completed: card.get("isDone").and_then(Value::as_bool).unwrap_or(false),
                completed_at: card
                    .get("completedAt")
                    .filter(|value| !value.is_null())
                    .map(|value| timestamp_millis(Some(value), now)),
                created_at: timestamp_millis(card.get("createdAt"), now),
                recurrence: projected_recurrence(card.get("recurrence")),
            });
        }
    }
    Some(cards)
}

/// Reconciles the read-only generated task calendars for one hosted Kanban
/// document. This runs in the same transaction as the canonical document
/// revision so assignment and calendar change streams cannot diverge.
pub(crate) async fn project_kanban_assignments(
    tx: &mut Transaction<'_, Postgres>,
    vault_id: Uuid,
    file_id: Uuid,
    source_revision: i64,
    content: &str,
) -> Result<(), sqlx::Error> {
    let now = Utc::now().to_rfc3339();
    let Some(cards) = projected_kanban_cards(content, &now) else {
        return Ok(());
    };
    let requested_users = cards
        .iter()
        .flat_map(|card| card.assignees.iter().copied())
        .collect::<HashSet<_>>()
        .into_iter()
        .collect::<Vec<_>>();
    let allowed_users = if requested_users.is_empty() {
        HashSet::new()
    } else {
        sqlx::query_scalar::<_, Uuid>(
            r#"SELECT user_account.id
               FROM users user_account
               JOIN hosted_vaults vault ON vault.id=$1
               WHERE user_account.id=ANY($2)
                 AND user_account.status='active'
                 AND (vault.owner_user_id=user_account.id OR EXISTS (
                   SELECT 1 FROM hosted_vault_memberships membership
                   WHERE membership.vault_id=vault.id AND membership.user_id=user_account.id
                 ))"#,
        )
        .bind(vault_id)
        .bind(&requested_users)
        .fetch_all(&mut **tx)
        .await?
        .into_iter()
        .collect::<HashSet<_>>()
    };
    let vault_name = sqlx::query_scalar::<_, String>("SELECT name FROM hosted_vaults WHERE id=$1")
        .bind(vault_id)
        .fetch_one(&mut **tx)
        .await?;
    let desired = cards
        .iter()
        .flat_map(|card| {
            card.assignees
                .iter()
                .filter(|owner| allowed_users.contains(owner))
                .map(move |owner| ((*owner, card.card_id.clone()), card.clone()))
        })
        .collect::<HashMap<_, _>>();

    let existing = sqlx::query(
        r#"SELECT owner_id,card_id,item_id,calendar_id
           FROM kanban_calendar_projections
           WHERE vault_id=$1 AND file_id=$2 FOR UPDATE"#,
    )
    .bind(vault_id)
    .bind(file_id)
    .fetch_all(&mut **tx)
    .await?;
    for row in existing {
        let owner: Uuid = row.get("owner_id");
        let card_id: String = row.get("card_id");
        if desired.contains_key(&(owner, card_id.clone())) {
            continue;
        }
        let item_id: Uuid = row.get("item_id");
        sqlx::query(
            "UPDATE calendar_items SET deleted_at=now(),updated_at=now() WHERE owner_id=$1 AND id=$2 AND deleted_at IS NULL",
        )
        .bind(owner)
        .bind(item_id)
        .execute(&mut **tx)
        .await?;
        insert_change(tx, owner, "item", item_id, "delete", None).await?;
        sqlx::query(
            "DELETE FROM kanban_calendar_projections WHERE owner_id=$1 AND vault_id=$2 AND file_id=$3 AND card_id=$4",
        )
        .bind(owner)
        .bind(vault_id)
        .bind(file_id)
        .bind(card_id)
        .execute(&mut **tx)
        .await?;
    }

    for ((owner, card_id), card) in desired {
        let owner_text = owner.to_string();
        let vault_text = vault_id.to_string();
        let file_text = file_id.to_string();
        let calendar_id =
            stable_projection_uuid("collab-kanban-calendar", &[&owner_text, &vault_text]);
        let item_id = stable_projection_uuid(
            "collab-kanban-task",
            &[&owner_text, &vault_text, &file_text, &card_id],
        );
        let calendar_payload = serde_json::json!({
            "schemaVersion": collab_calendar::CALENDAR_SCHEMA_VERSION,
            "id": calendar_id.to_string(),
            "globalId": calendar_id.to_string(),
            "location": {
                "kind": "kanban",
                "originKey": format!("hosted-vault:{vault_id}"),
            },
            "name": format!("Assigned tasks · {vault_name}"),
            "color": "#a78bfa",
            "defaultTimeZone": "UTC",
            "archived": false,
            "readOnly": true,
            "revision": 1,
            "createdAt": now,
            "updatedAt": now,
        });
        let inserted_calendar = sqlx::query(
            r#"INSERT INTO calendars
               (id,owner_id,global_id,name,color,default_time_zone,archived,read_only,revision,payload,logical_size_bytes)
               VALUES ($1,$2,$1,$3,'#a78bfa','UTC',FALSE,TRUE,1,$4,$5)
               ON CONFLICT (id) DO NOTHING"#,
        )
        .bind(calendar_id)
        .bind(owner)
        .bind(format!("Assigned tasks · {vault_name}"))
        .bind(&calendar_payload)
        .bind(logical_size(&calendar_payload))
        .execute(&mut **tx)
        .await?
        .rows_affected()
            > 0;
        if inserted_calendar {
            insert_change(
                tx,
                owner,
                "calendar",
                calendar_id,
                "upsert",
                Some(&calendar_payload),
            )
            .await?;
        }

        let existing_revision = sqlx::query_scalar::<_, i64>(
            "SELECT revision FROM calendar_items WHERE owner_id=$1 AND id=$2",
        )
        .bind(owner)
        .bind(item_id)
        .fetch_optional(&mut **tx)
        .await?;
        let revision = existing_revision.map_or(1, |value| value + 1);
        let item_payload = serde_json::json!({
            "id": item_id.to_string(),
            "uid": format!("kanban:{vault_id}:{file_id}:{card_id}"),
            "calendarId": calendar_id.to_string(),
            "kind": "task",
            "title": card.title,
            "description": card.description,
            "reminders": [],
            "attendees": [],
            "attachments": [{
                "id": format!("kanban:{file_id}:{card_id}"),
                "kind": "kanbanTask",
                "name": "Open Kanban task",
                "vaultId": vault_text,
                "fileId": file_text,
                "cardId": card_id,
            }],
            "sourceBinding": {
                "kind": "kanban",
                "vaultId": vault_id.to_string(),
                "fileId": file_id.to_string(),
                "cardId": card_id,
                "sourceRevision": source_revision,
            },
            "recurrence": card.recurrence,
            "start": card.start_date.map(|date| serde_json::json!({ "kind": "date", "date": date })),
            "due": card.due_date.map(|date| serde_json::json!({ "kind": "date", "date": date })),
            "status": if card.completed { "completed" } else { "needs-action" },
            "completedAt": card.completed_at,
            "revision": revision,
            "createdAt": card.created_at,
            "updatedAt": now,
        });
        let start_date = item_payload
            .pointer("/start/date")
            .and_then(Value::as_str)
            .and_then(|value| NaiveDate::parse_from_str(value, "%Y-%m-%d").ok());
        let due_date = item_payload
            .pointer("/due/date")
            .and_then(Value::as_str)
            .and_then(|value| NaiveDate::parse_from_str(value, "%Y-%m-%d").ok());
        let recurrence_rule = item_payload
            .pointer("/recurrence/rrule")
            .and_then(Value::as_str);
        sqlx::query(
            r#"INSERT INTO calendar_items
               (id,owner_id,calendar_id,uid,kind,start_date,end_date,recurrence_rule,revision,payload,logical_size_bytes,deleted_at)
               VALUES ($1,$2,$3,$4,'task',$5,$6,$7,$8,$9,$10,NULL)
               ON CONFLICT (id) DO UPDATE SET start_date=EXCLUDED.start_date,
                 end_date=EXCLUDED.end_date,recurrence_rule=EXCLUDED.recurrence_rule,
                 revision=EXCLUDED.revision,payload=EXCLUDED.payload,
                 logical_size_bytes=EXCLUDED.logical_size_bytes,deleted_at=NULL,updated_at=now()"#,
        )
        .bind(item_id)
        .bind(owner)
        .bind(calendar_id)
        .bind(format!("kanban:{vault_id}:{file_id}:{card_id}"))
        .bind(start_date)
        .bind(due_date.or(start_date))
        .bind(recurrence_rule)
        .bind(revision)
        .bind(&item_payload)
        .bind(logical_size(&item_payload))
        .execute(&mut **tx)
        .await?;
        sqlx::query(
            r#"INSERT INTO kanban_calendar_projections
               (owner_id,vault_id,file_id,card_id,calendar_id,item_id,source_revision)
               VALUES ($1,$2,$3,$4,$5,$6,$7)
               ON CONFLICT (owner_id,vault_id,file_id,card_id) DO UPDATE SET
                 calendar_id=EXCLUDED.calendar_id,item_id=EXCLUDED.item_id,
                 source_revision=EXCLUDED.source_revision,updated_at=now()"#,
        )
        .bind(owner)
        .bind(vault_id)
        .bind(file_id)
        .bind(&card_id)
        .bind(calendar_id)
        .bind(item_id)
        .bind(source_revision)
        .execute(&mut **tx)
        .await?;
        insert_change(tx, owner, "item", item_id, "upsert", Some(&item_payload)).await?;
    }
    Ok(())
}

/// Removes every generated Kanban calendar projection for a user who no longer
/// has access to its source vault. Historical upsert payloads are removed before
/// tombstones are appended so a fresh sync cannot recover private card details.
pub(crate) async fn remove_kanban_access_projections(
    tx: &mut Transaction<'_, Postgres>,
    vault_id: Uuid,
    owner: Uuid,
) -> Result<(), sqlx::Error> {
    let rows = sqlx::query(
        r#"SELECT calendar_id,item_id
           FROM kanban_calendar_projections
           WHERE vault_id=$1 AND owner_id=$2 FOR UPDATE"#,
    )
    .bind(vault_id)
    .bind(owner)
    .fetch_all(&mut **tx)
    .await?;
    let owner_text = owner.to_string();
    let vault_text = vault_id.to_string();
    let generated_calendar_id =
        stable_projection_uuid("collab-kanban-calendar", &[&owner_text, &vault_text]);
    let generated_calendar_exists = sqlx::query_scalar::<_, bool>(
        "SELECT EXISTS(SELECT 1 FROM calendars WHERE owner_id=$1 AND id=$2)",
    )
    .bind(owner)
    .bind(generated_calendar_id)
    .fetch_one(&mut **tx)
    .await?;
    if rows.is_empty() && !generated_calendar_exists {
        return Ok(());
    }
    let mut item_ids = rows
        .iter()
        .map(|row| row.get::<Uuid, _>("item_id"))
        .collect::<HashSet<_>>();
    let mut calendar_ids = rows
        .iter()
        .map(|row| row.get::<Uuid, _>("calendar_id"))
        .collect::<HashSet<_>>();
    if generated_calendar_exists {
        calendar_ids.insert(generated_calendar_id);
        item_ids.extend(
            sqlx::query_scalar::<_, Uuid>(
                "SELECT id FROM calendar_items WHERE owner_id=$1 AND calendar_id=$2",
            )
            .bind(owner)
            .bind(generated_calendar_id)
            .fetch_all(&mut **tx)
            .await?,
        );
    }
    let item_ids = item_ids.into_iter().collect::<Vec<_>>();
    let calendar_ids = calendar_ids.into_iter().collect::<Vec<_>>();
    let mut entity_ids = item_ids.clone();
    entity_ids.extend(calendar_ids.iter().copied());
    sqlx::query("DELETE FROM calendar_change_log WHERE owner_id=$1 AND entity_id=ANY($2)")
        .bind(owner)
        .bind(&entity_ids)
        .execute(&mut **tx)
        .await?;
    sqlx::query(
        "UPDATE calendar_items SET deleted_at=now(),updated_at=now() WHERE owner_id=$1 AND id=ANY($2)",
    )
    .bind(owner)
    .bind(&item_ids)
    .execute(&mut **tx)
    .await?;
    sqlx::query(
        "UPDATE calendars SET deleted_at=now(),updated_at=now() WHERE owner_id=$1 AND id=ANY($2)",
    )
    .bind(owner)
    .bind(&calendar_ids)
    .execute(&mut **tx)
    .await?;
    sqlx::query("DELETE FROM kanban_calendar_projections WHERE vault_id=$1 AND owner_id=$2")
        .bind(vault_id)
        .bind(owner)
        .execute(&mut **tx)
        .await?;
    for item_id in item_ids {
        insert_change(tx, owner, "item", item_id, "delete", None).await?;
    }
    for calendar_id in calendar_ids {
        insert_change(tx, owner, "calendar", calendar_id, "delete", None).await?;
    }
    Ok(())
}

pub(crate) async fn remove_kanban_subtree_projections(
    tx: &mut Transaction<'_, Postgres>,
    vault_id: Uuid,
    root_file_id: Uuid,
) -> Result<(), sqlx::Error> {
    let rows = sqlx::query(
        r#"WITH RECURSIVE affected AS (
             SELECT id FROM hosted_file_entries WHERE vault_id=$1 AND id=$2
             UNION ALL
             SELECT child.id FROM hosted_file_entries child
             JOIN affected parent ON child.parent_id=parent.id
             WHERE child.vault_id=$1
           )
           SELECT projection.owner_id,projection.file_id,projection.card_id,projection.item_id
           FROM kanban_calendar_projections projection
           JOIN affected ON affected.id=projection.file_id
           WHERE projection.vault_id=$1 FOR UPDATE"#,
    )
    .bind(vault_id)
    .bind(root_file_id)
    .fetch_all(&mut **tx)
    .await?;
    for row in rows {
        let owner: Uuid = row.get("owner_id");
        let file_id: Uuid = row.get("file_id");
        let card_id: String = row.get("card_id");
        let item_id: Uuid = row.get("item_id");
        sqlx::query(
            "UPDATE calendar_items SET deleted_at=now(),updated_at=now() WHERE owner_id=$1 AND id=$2 AND deleted_at IS NULL",
        )
        .bind(owner)
        .bind(item_id)
        .execute(&mut **tx)
        .await?;
        insert_change(tx, owner, "item", item_id, "delete", None).await?;
        sqlx::query(
            "DELETE FROM kanban_calendar_projections WHERE owner_id=$1 AND vault_id=$2 AND file_id=$3 AND card_id=$4",
        )
        .bind(owner)
        .bind(vault_id)
        .bind(file_id)
        .bind(card_id)
        .execute(&mut **tx)
        .await?;
    }
    Ok(())
}

pub async fn list_calendars(
    State(state): State<AppState>,
    Extension(request_id): Extension<String>,
    headers: HeaderMap,
) -> Result<Json<DataResponse<Vec<Value>>>, CalendarApiError> {
    let user = require_native_user(&state, &headers, &request_id).await?;
    let rows = sqlx::query(
        "SELECT payload FROM calendars WHERE owner_id = $1 AND deleted_at IS NULL ORDER BY archived, lower(name), id",
    )
    .bind(owner_id(&user, &request_id)?)
    .fetch_all(&state.database)
    .await
    .map_err(|_| CalendarApiError::server(&request_id))?;
    Ok(Json(DataResponse::new(
        rows.into_iter().map(|row| row.get("payload")).collect(),
    )))
}

pub async fn get_calendar(
    State(state): State<AppState>,
    Extension(request_id): Extension<String>,
    headers: HeaderMap,
    Path(calendar_id): Path<Uuid>,
) -> Result<Json<DataResponse<Value>>, CalendarApiError> {
    let user = require_native_user(&state, &headers, &request_id).await?;
    let payload = sqlx::query_scalar::<_, Value>(
        "SELECT payload FROM calendars WHERE owner_id = $1 AND id = $2 AND deleted_at IS NULL",
    )
    .bind(owner_id(&user, &request_id)?)
    .bind(calendar_id)
    .fetch_optional(&state.database)
    .await
    .map_err(|_| CalendarApiError::server(&request_id))?
    .ok_or_else(|| CalendarApiError::not_found(&request_id))?;
    Ok(Json(DataResponse::new(payload)))
}

fn subscription_from_row(row: &sqlx::postgres::PgRow) -> CalendarSubscription {
    CalendarSubscription {
        id: row.get::<Uuid, _>("id").to_string(),
        calendar_id: row.get::<Uuid, _>("calendar_id").to_string(),
        feed_url: row.get("feed_url"),
        etag: row.get("etag"),
        last_modified: row.get("last_modified"),
        last_refreshed_at: row
            .get::<Option<DateTime<Utc>>, _>("last_refreshed_at")
            .map(|value| value.to_rfc3339()),
        last_error: row.get("last_error"),
        created_at: row.get::<DateTime<Utc>, _>("created_at").to_rfc3339(),
        updated_at: row.get::<DateTime<Utc>, _>("updated_at").to_rfc3339(),
        server_url: None,
        user_id: None,
    }
}

fn semantic_item_value(item: &CalendarItem) -> Value {
    let mut value = serde_json::to_value(item).unwrap_or(Value::Null);
    if let Some(object) = value.as_object_mut() {
        for key in ["revision", "createdAt", "updatedAt", "deletedAt"] {
            object.remove(key);
        }
    }
    value
}

fn canonical_subscription_items(
    parsed: Vec<CalendarItem>,
    existing: &HashMap<Uuid, (CalendarItem, i64)>,
    now: &str,
) -> Vec<CalendarItem> {
    parsed
        .into_iter()
        .map(|mut item| {
            let Ok(id) = Uuid::parse_str(&item.id) else {
                return item;
            };
            let Some((stored, _)) = existing.get(&id) else {
                return item;
            };
            if semantic_item_value(stored) == semantic_item_value(&item) {
                return stored.clone();
            }
            item.revision = stored.revision + 1;
            item.created_at = stored.created_at.clone();
            item.updated_at = now.to_owned();
            item
        })
        .collect()
}

async fn upsert_subscription_item(
    tx: &mut Transaction<'_, Postgres>,
    owner: Uuid,
    item: &CalendarItem,
    request_id: &str,
) -> Result<(), CalendarApiError> {
    validate_item(item, request_id)?;
    let item_id = parse_uuid(&item.id, "Item ID", request_id)?;
    let calendar_id = parse_uuid(&item.calendar_id, "Calendar ID", request_id)?;
    let payload = serde_json::to_value(item).map_err(|_| CalendarApiError::server(request_id))?;
    let (start_at, end_at, start_date, end_date) = item_range(item);
    let recurrence_id = item
        .recurrence_id
        .as_ref()
        .map(|value| serde_json::to_value(value).unwrap_or(Value::Null));
    let (recurrence_at, recurrence_date) = match item.recurrence_id.as_ref() {
        Some(CalendarTimeValue::DateTime { date_time, .. }) => (
            DateTime::parse_from_rfc3339(date_time)
                .ok()
                .map(|value| value.with_timezone(&Utc)),
            None,
        ),
        Some(CalendarTimeValue::Date { date }) => {
            (None, NaiveDate::parse_from_str(date, "%Y-%m-%d").ok())
        }
        None => (None, None),
    };
    let recurrence_series_id = item
        .recurrence_series_id
        .as_deref()
        .map(|value| parse_uuid(value, "Recurrence series ID", request_id))
        .transpose()?;
    sqlx::query(
        r#"INSERT INTO calendar_items
           (id,owner_id,calendar_id,uid,kind,start_at,end_at,start_date,end_date,recurrence_rule,
            recurrence_id,recurrence_at,recurrence_date,recurrence_series_id,revision,payload,
            logical_size_bytes,deleted_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,NULL)
           ON CONFLICT (id) DO UPDATE SET
             uid=EXCLUDED.uid,kind=EXCLUDED.kind,start_at=EXCLUDED.start_at,end_at=EXCLUDED.end_at,
             start_date=EXCLUDED.start_date,end_date=EXCLUDED.end_date,
             recurrence_rule=EXCLUDED.recurrence_rule,recurrence_id=EXCLUDED.recurrence_id,
             recurrence_at=EXCLUDED.recurrence_at,recurrence_date=EXCLUDED.recurrence_date,
             recurrence_series_id=EXCLUDED.recurrence_series_id,revision=EXCLUDED.revision,
             payload=EXCLUDED.payload,logical_size_bytes=EXCLUDED.logical_size_bytes,
             deleted_at=NULL,updated_at=now()"#,
    )
    .bind(item_id)
    .bind(owner)
    .bind(calendar_id)
    .bind(&item.uid)
    .bind(item.kind.as_str())
    .bind(start_at)
    .bind(end_at)
    .bind(start_date)
    .bind(end_date)
    .bind(item.recurrence.as_ref().map(|value| value.rrule.as_str()))
    .bind(recurrence_id)
    .bind(recurrence_at)
    .bind(recurrence_date)
    .bind(recurrence_series_id)
    .bind(item.revision)
    .bind(&payload)
    .bind(logical_size(&payload))
    .execute(&mut **tx)
    .await
    .map_err(|error| {
        if error
            .as_database_error()
            .is_some_and(|value| value.is_unique_violation())
        {
            CalendarApiError::conflict(
                "The subscription contains duplicate item identities.",
                request_id,
            )
        } else {
            CalendarApiError::server(request_id)
        }
    })?;
    replace_item_relations(tx, owner, item_id, calendar_id, item, request_id).await?;
    insert_change(tx, owner, "item", item_id, "upsert", Some(&payload))
        .await
        .map_err(|_| CalendarApiError::server(request_id))?;
    Ok(())
}

async fn replace_subscription_items(
    state: &AppState,
    owner: Uuid,
    calendar: &CalendarDefinition,
    subscription: &CalendarSubscription,
    parsed_items: Vec<CalendarItem>,
    request_id: &str,
) -> Result<Vec<CalendarItem>, CalendarApiError> {
    let calendar_id = parse_uuid(&calendar.id, "Calendar ID", request_id)?;
    let existing_rows = sqlx::query(
        "SELECT id,payload,logical_size_bytes FROM calendar_items WHERE owner_id=$1 AND calendar_id=$2",
    )
    .bind(owner)
    .bind(calendar_id)
    .fetch_all(&state.database)
    .await
    .map_err(|_| CalendarApiError::server(request_id))?;
    let mut existing = HashMap::new();
    let mut replaced_bytes = 0_i64;
    for row in existing_rows {
        let id: Uuid = row.get("id");
        let item = serde_json::from_value::<CalendarItem>(row.get("payload"))
            .map_err(|_| CalendarApiError::server(request_id))?;
        let size: i64 = row.get("logical_size_bytes");
        replaced_bytes = replaced_bytes.saturating_add(size);
        existing.insert(id, (item, size));
    }
    let subscription_bytes = sqlx::query_scalar::<_, i64>(
        "SELECT logical_size_bytes FROM calendar_subscriptions WHERE id=$1 AND owner_id=$2",
    )
    .bind(parse_uuid(&subscription.id, "Subscription ID", request_id)?)
    .bind(owner)
    .fetch_optional(&state.database)
    .await
    .map_err(|_| CalendarApiError::server(request_id))?
    .unwrap_or(0);
    replaced_bytes = replaced_bytes.saturating_add(subscription_bytes);
    let now = Utc::now().to_rfc3339();
    let items = canonical_subscription_items(parsed_items, &existing, &now);
    let subscription_payload =
        serde_json::to_value(subscription).map_err(|_| CalendarApiError::server(request_id))?;
    let proposed_bytes = items
        .iter()
        .filter_map(|item| serde_json::to_value(item).ok())
        .fold(logical_size(&subscription_payload), |total, value| {
            total.saturating_add(logical_size(&value))
        });
    let mut tx = state
        .database
        .begin()
        .await
        .map_err(|_| CalendarApiError::server(request_id))?;
    ensure_calendar_quota(
        &mut tx,
        owner,
        state.config.calendar_quota_bytes,
        replaced_bytes,
        proposed_bytes,
        request_id,
    )
    .await?;
    let next_ids = items
        .iter()
        .filter_map(|item| Uuid::parse_str(&item.id).ok())
        .collect::<HashSet<_>>();
    for (item_id, _) in existing.iter().filter(|(id, _)| !next_ids.contains(id)) {
        insert_change(&mut tx, owner, "item", *item_id, "delete", None)
            .await
            .map_err(|_| CalendarApiError::server(request_id))?;
        sqlx::query("DELETE FROM calendar_items WHERE owner_id=$1 AND id=$2")
            .bind(owner)
            .bind(item_id)
            .execute(&mut *tx)
            .await
            .map_err(|_| CalendarApiError::server(request_id))?;
    }
    for item in &items {
        let id = parse_uuid(&item.id, "Item ID", request_id)?;
        let unchanged = existing.get(&id).is_some_and(|(stored, _)| stored == item);
        if !unchanged {
            upsert_subscription_item(&mut tx, owner, item, request_id).await?;
        }
    }
    sqlx::query(
        r#"UPDATE calendar_subscriptions SET feed_url=$1,etag=$2,last_modified=$3,
           last_refreshed_at=$4,last_error=$5,logical_size_bytes=$6,updated_at=now()
           WHERE id=$7 AND owner_id=$8"#,
    )
    .bind(&subscription.feed_url)
    .bind(&subscription.etag)
    .bind(&subscription.last_modified)
    .bind(
        subscription
            .last_refreshed_at
            .as_deref()
            .and_then(|value| DateTime::parse_from_rfc3339(value).ok())
            .map(|value| value.with_timezone(&Utc)),
    )
    .bind(&subscription.last_error)
    .bind(logical_size(&subscription_payload))
    .bind(parse_uuid(&subscription.id, "Subscription ID", request_id)?)
    .bind(owner)
    .execute(&mut *tx)
    .await
    .map_err(|_| CalendarApiError::server(request_id))?;
    tx.commit()
        .await
        .map_err(|_| CalendarApiError::server(request_id))?;
    Ok(items)
}

async fn subscription_record(
    state: &AppState,
    owner: Uuid,
    subscription_id: Uuid,
    request_id: &str,
) -> Result<(CalendarDefinition, CalendarSubscription), CalendarApiError> {
    let row = sqlx::query(
        r#"SELECT subscription.id,subscription.calendar_id,subscription.feed_url,
                  subscription.etag,subscription.last_modified,subscription.last_refreshed_at,
                  subscription.last_error,subscription.created_at,subscription.updated_at,
                  calendar.payload AS calendar_payload
           FROM calendar_subscriptions subscription
           JOIN calendars calendar
             ON calendar.id=subscription.calendar_id AND calendar.owner_id=subscription.owner_id
           WHERE subscription.id=$1 AND subscription.owner_id=$2 AND calendar.deleted_at IS NULL"#,
    )
    .bind(subscription_id)
    .bind(owner)
    .fetch_optional(&state.database)
    .await
    .map_err(|_| CalendarApiError::server(request_id))?
    .ok_or_else(|| CalendarApiError::not_found(request_id))?;
    let calendar = serde_json::from_value(row.get("calendar_payload"))
        .map_err(|_| CalendarApiError::server(request_id))?;
    Ok((calendar, subscription_from_row(&row)))
}

async fn release_subscription_refresh(
    state: &AppState,
    owner: Uuid,
    subscription_id: Uuid,
    lease: &str,
    error: Option<&str>,
) {
    let _ = sqlx::query(
        r#"UPDATE calendar_subscriptions
           SET refresh_cursor=NULL,last_error=COALESCE($1,last_error),updated_at=now()
           WHERE id=$2 AND owner_id=$3 AND refresh_cursor=$4"#,
    )
    .bind(error)
    .bind(subscription_id)
    .bind(owner)
    .bind(lease)
    .execute(&state.database)
    .await;
}

async fn refresh_subscription_record(
    state: &AppState,
    owner: Uuid,
    subscription_id: Uuid,
    request_id: &str,
) -> Result<Option<CreatedCalendarSubscription>, CalendarApiError> {
    let lease = Uuid::now_v7().to_string();
    let acquired = sqlx::query_scalar::<_, bool>(
        r#"UPDATE calendar_subscriptions
           SET refresh_cursor=$1,updated_at=now()
           WHERE id=$2 AND owner_id=$3
             AND (refresh_cursor IS NULL OR updated_at < now() - interval '30 minutes')
           RETURNING true"#,
    )
    .bind(&lease)
    .bind(subscription_id)
    .bind(owner)
    .fetch_optional(&state.database)
    .await
    .map_err(|_| CalendarApiError::server(request_id))?
    .unwrap_or(false);
    if !acquired {
        return Ok(None);
    }

    let result: Result<CreatedCalendarSubscription, CalendarApiError> = async {
        let (calendar, mut subscription) =
            subscription_record(state, owner, subscription_id, request_id).await?;
        let response = fetch_calendar_feed(
            &subscription.feed_url,
            subscription.etag.as_deref(),
            subscription.last_modified.as_deref(),
        )
        .await
        .map_err(|message| {
            CalendarApiError::new(
                StatusCode::BAD_GATEWAY,
                ErrorCode::ServerUnavailable,
                message,
                request_id,
            )
        })?;
        let refreshed_at = Utc::now().to_rfc3339();
        subscription.feed_url = response.resolved_url;
        subscription.etag = response.etag;
        subscription.last_modified = response.last_modified;
        subscription.last_refreshed_at = Some(refreshed_at.clone());
        subscription.last_error = None;
        subscription.updated_at = refreshed_at.clone();
        let warnings = if let Some(content) = response.content {
            let parsed = parse_ics(&content, &calendar, &subscription.id, &refreshed_at).map_err(
                |error| {
                    CalendarApiError::validation(
                        format!("The calendar feed could not be parsed: {error}."),
                        request_id,
                    )
                },
            )?;
            let warnings = parsed.warnings;
            replace_subscription_items(
                state,
                owner,
                &calendar,
                &subscription,
                parsed.items,
                request_id,
            )
            .await?;
            warnings
        } else {
            let payload = serde_json::to_value(&subscription)
                .map_err(|_| CalendarApiError::server(request_id))?;
            sqlx::query(
                r#"UPDATE calendar_subscriptions
                   SET etag=$1,last_modified=$2,last_refreshed_at=$3,last_error=NULL,
                       logical_size_bytes=$4,updated_at=now()
                   WHERE id=$5 AND owner_id=$6"#,
            )
            .bind(&subscription.etag)
            .bind(&subscription.last_modified)
            .bind(
                DateTime::parse_from_rfc3339(&refreshed_at)
                    .ok()
                    .map(|value| value.with_timezone(&Utc)),
            )
            .bind(logical_size(&payload))
            .bind(subscription_id)
            .bind(owner)
            .execute(&state.database)
            .await
            .map_err(|_| CalendarApiError::server(request_id))?;
            Vec::new()
        };
        Ok(CreatedCalendarSubscription {
            calendar,
            subscription,
            warnings,
        })
    }
    .await;

    match &result {
        Ok(_) => release_subscription_refresh(state, owner, subscription_id, &lease, None).await,
        Err(error) => {
            release_subscription_refresh(
                state,
                owner,
                subscription_id,
                &lease,
                Some(&error.error.message),
            )
            .await
        }
    }
    result.map(Some)
}

pub async fn list_subscriptions(
    State(state): State<AppState>,
    Extension(request_id): Extension<String>,
    headers: HeaderMap,
) -> Result<Json<DataResponse<Vec<CalendarSubscription>>>, CalendarApiError> {
    let user = require_native_user(&state, &headers, &request_id).await?;
    let rows = sqlx::query(
        r#"SELECT id,calendar_id,feed_url,etag,last_modified,last_refreshed_at,last_error,
                  created_at,updated_at
           FROM calendar_subscriptions WHERE owner_id=$1 ORDER BY updated_at DESC,id"#,
    )
    .bind(owner_id(&user, &request_id)?)
    .fetch_all(&state.database)
    .await
    .map_err(|_| CalendarApiError::server(&request_id))?;
    Ok(Json(DataResponse::new(
        rows.iter().map(subscription_from_row).collect(),
    )))
}

pub async fn create_subscription(
    State(state): State<AppState>,
    Extension(request_id): Extension<String>,
    headers: HeaderMap,
    Json(request): Json<CreateCalendarSubscriptionRequest>,
) -> Result<(StatusCode, Json<DataResponse<CreatedCalendarSubscription>>), CalendarApiError> {
    let user = require_native_user(&state, &headers, &request_id).await?;
    let owner = owner_id(&user, &request_id)?;
    if request.name.trim().is_empty() || request.name.chars().count() > 120 {
        return Err(CalendarApiError::validation(
            "Calendar name must be between 1 and 120 characters.",
            &request_id,
        ));
    }
    if !request.color.starts_with('#')
        || request.color.len() != 7
        || !request.color[1..]
            .chars()
            .all(|value| value.is_ascii_hexdigit())
    {
        return Err(CalendarApiError::validation(
            "Calendar color must be a six-digit hex color.",
            &request_id,
        ));
    }
    if request.default_time_zone.parse::<chrono_tz::Tz>().is_err() {
        return Err(CalendarApiError::validation(
            "Calendar time zone is invalid.",
            &request_id,
        ));
    }
    let response = fetch_calendar_feed(&request.feed_url, None, None)
        .await
        .map_err(|message| {
            CalendarApiError::new(
                StatusCode::BAD_GATEWAY,
                ErrorCode::ServerUnavailable,
                message,
                &request_id,
            )
        })?;
    let subscription_id = Uuid::now_v7();
    let calendar_id = Uuid::now_v7();
    let now = Utc::now();
    let now_text = now.to_rfc3339();
    let calendar = CalendarDefinition {
        schema_version: collab_calendar::CALENDAR_SCHEMA_VERSION,
        id: calendar_id.to_string(),
        global_id: Uuid::now_v7().to_string(),
        location: CalendarLocation::Subscription {
            subscription_id: subscription_id.to_string(),
            server_url: None,
            user_id: None,
        },
        name: request.name.trim().to_owned(),
        color: request.color,
        default_time_zone: request.default_time_zone,
        archived: false,
        read_only: true,
        revision: 1,
        created_at: now_text.clone(),
        updated_at: now_text.clone(),
        deleted_at: None,
    };
    let parsed = parse_ics(
        response
            .content
            .as_deref()
            .unwrap_or("BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n"),
        &calendar,
        &subscription_id.to_string(),
        &now_text,
    )
    .map_err(|error| {
        CalendarApiError::validation(
            format!("The calendar feed could not be parsed: {error}."),
            &request_id,
        )
    })?;
    let subscription = CalendarSubscription {
        id: subscription_id.to_string(),
        calendar_id: calendar_id.to_string(),
        feed_url: response.resolved_url,
        etag: response.etag,
        last_modified: response.last_modified,
        last_refreshed_at: Some(now_text.clone()),
        last_error: None,
        created_at: now_text.clone(),
        updated_at: now_text,
        server_url: None,
        user_id: None,
    };
    let calendar_payload =
        serde_json::to_value(&calendar).map_err(|_| CalendarApiError::server(&request_id))?;
    let subscription_payload =
        serde_json::to_value(&subscription).map_err(|_| CalendarApiError::server(&request_id))?;
    let initial_bytes = logical_size(&calendar_payload) + logical_size(&subscription_payload);
    let mut tx = state
        .database
        .begin()
        .await
        .map_err(|_| CalendarApiError::server(&request_id))?;
    ensure_calendar_quota(
        &mut tx,
        owner,
        state.config.calendar_quota_bytes,
        0,
        initial_bytes,
        &request_id,
    )
    .await?;
    sqlx::query(
        r#"INSERT INTO calendars
           (id,owner_id,global_id,name,color,default_time_zone,archived,read_only,revision,payload,
            logical_size_bytes)
           VALUES ($1,$2,$3,$4,$5,$6,false,true,1,$7,$8)"#,
    )
    .bind(calendar_id)
    .bind(owner)
    .bind(parse_uuid(
        &calendar.global_id,
        "Calendar global ID",
        &request_id,
    )?)
    .bind(&calendar.name)
    .bind(&calendar.color)
    .bind(&calendar.default_time_zone)
    .bind(&calendar_payload)
    .bind(logical_size(&calendar_payload))
    .execute(&mut *tx)
    .await
    .map_err(|error| {
        if error
            .as_database_error()
            .is_some_and(|value| value.is_unique_violation())
        {
            CalendarApiError::conflict("That calendar subscription already exists.", &request_id)
        } else {
            CalendarApiError::server(&request_id)
        }
    })?;
    sqlx::query(
        r#"INSERT INTO calendar_subscriptions
           (id,owner_id,calendar_id,feed_url,etag,last_modified,last_refreshed_at,last_error,
            logical_size_bytes)
           VALUES ($1,$2,$3,$4,$5,$6,$7,NULL,$8)"#,
    )
    .bind(subscription_id)
    .bind(owner)
    .bind(calendar_id)
    .bind(&subscription.feed_url)
    .bind(&subscription.etag)
    .bind(&subscription.last_modified)
    .bind(now)
    .bind(logical_size(&subscription_payload))
    .execute(&mut *tx)
    .await
    .map_err(|error| {
        if error
            .as_database_error()
            .is_some_and(|value| value.is_unique_violation())
        {
            CalendarApiError::conflict("That feed is already subscribed.", &request_id)
        } else {
            CalendarApiError::server(&request_id)
        }
    })?;
    insert_change(
        &mut tx,
        owner,
        "calendar",
        calendar_id,
        "upsert",
        Some(&calendar_payload),
    )
    .await
    .map_err(|_| CalendarApiError::server(&request_id))?;
    tx.commit()
        .await
        .map_err(|_| CalendarApiError::server(&request_id))?;
    if let Err(error) = replace_subscription_items(
        &state,
        owner,
        &calendar,
        &subscription,
        parsed.items,
        &request_id,
    )
    .await
    {
        let _ = sqlx::query("DELETE FROM calendars WHERE id=$1 AND owner_id=$2")
            .bind(calendar_id)
            .bind(owner)
            .execute(&state.database)
            .await;
        return Err(error);
    }
    Ok((
        StatusCode::CREATED,
        Json(DataResponse::new(CreatedCalendarSubscription {
            calendar,
            subscription,
            warnings: parsed.warnings,
        })),
    ))
}

pub async fn refresh_subscription(
    State(state): State<AppState>,
    Extension(request_id): Extension<String>,
    headers: HeaderMap,
    Path(subscription_id): Path<Uuid>,
) -> Result<Json<DataResponse<CreatedCalendarSubscription>>, CalendarApiError> {
    let user = require_native_user(&state, &headers, &request_id).await?;
    let owner = owner_id(&user, &request_id)?;
    let result = refresh_subscription_record(&state, owner, subscription_id, &request_id)
        .await?
        .ok_or_else(|| {
            CalendarApiError::conflict("That subscription is already refreshing.", &request_id)
        })?;
    Ok(Json(DataResponse::new(result)))
}

pub async fn delete_subscription(
    State(state): State<AppState>,
    Extension(request_id): Extension<String>,
    headers: HeaderMap,
    Path(subscription_id): Path<Uuid>,
) -> Result<StatusCode, CalendarApiError> {
    let user = require_native_user(&state, &headers, &request_id).await?;
    let owner = owner_id(&user, &request_id)?;
    let mut tx = state
        .database
        .begin()
        .await
        .map_err(|_| CalendarApiError::server(&request_id))?;
    let calendar_id = sqlx::query_scalar::<_, Uuid>(
        "SELECT calendar_id FROM calendar_subscriptions WHERE id=$1 AND owner_id=$2 FOR UPDATE",
    )
    .bind(subscription_id)
    .bind(owner)
    .fetch_optional(&mut *tx)
    .await
    .map_err(|_| CalendarApiError::server(&request_id))?
    .ok_or_else(|| CalendarApiError::not_found(&request_id))?;
    let item_ids = sqlx::query_scalar::<_, Uuid>(
        "SELECT id FROM calendar_items WHERE owner_id=$1 AND calendar_id=$2",
    )
    .bind(owner)
    .bind(calendar_id)
    .fetch_all(&mut *tx)
    .await
    .map_err(|_| CalendarApiError::server(&request_id))?;
    for item_id in item_ids {
        insert_change(&mut tx, owner, "item", item_id, "delete", None)
            .await
            .map_err(|_| CalendarApiError::server(&request_id))?;
    }
    insert_change(&mut tx, owner, "calendar", calendar_id, "delete", None)
        .await
        .map_err(|_| CalendarApiError::server(&request_id))?;
    sqlx::query("DELETE FROM calendars WHERE id=$1 AND owner_id=$2")
        .bind(calendar_id)
        .bind(owner)
        .execute(&mut *tx)
        .await
        .map_err(|_| CalendarApiError::server(&request_id))?;
    tx.commit()
        .await
        .map_err(|_| CalendarApiError::server(&request_id))?;
    Ok(StatusCode::NO_CONTENT)
}

pub async fn refresh_due_subscriptions(state: &AppState) {
    let rows = match sqlx::query(
        r#"SELECT id,owner_id FROM calendar_subscriptions
           WHERE (refresh_cursor IS NULL OR updated_at < now() - interval '30 minutes')
             AND (last_refreshed_at IS NULL OR last_refreshed_at < now() - interval '15 minutes')
           ORDER BY last_refreshed_at NULLS FIRST,id LIMIT 25"#,
    )
    .fetch_all(&state.database)
    .await
    {
        Ok(rows) => rows,
        Err(error) => {
            tracing::warn!(?error, "could not scan due calendar subscriptions");
            return;
        }
    };
    for row in rows {
        let subscription_id: Uuid = row.get("id");
        let owner: Uuid = row.get("owner_id");
        let request_id = format!("calendar-refresh-{subscription_id}");
        if let Err(error) =
            refresh_subscription_record(state, owner, subscription_id, &request_id).await
        {
            tracing::warn!(
                subscription_id = %subscription_id,
                message = %error.error.message,
                "calendar subscription refresh failed"
            );
        }
    }
}

pub async fn list_published_feeds(
    State(state): State<AppState>,
    Extension(request_id): Extension<String>,
    headers: HeaderMap,
    Path(calendar_id): Path<Uuid>,
) -> Result<Json<DataResponse<Vec<CalendarPublishedFeed>>>, CalendarApiError> {
    let user = require_native_user(&state, &headers, &request_id).await?;
    let owner = owner_id(&user, &request_id)?;
    let calendar_exists = sqlx::query_scalar::<_, bool>(
        "SELECT EXISTS(SELECT 1 FROM calendars WHERE owner_id=$1 AND id=$2 AND deleted_at IS NULL)",
    )
    .bind(owner)
    .bind(calendar_id)
    .fetch_one(&state.database)
    .await
    .map_err(|_| CalendarApiError::server(&request_id))?;
    if !calendar_exists {
        return Err(CalendarApiError::not_found(&request_id));
    }
    let rows = sqlx::query(
        r#"SELECT id,calendar_id,created_at,last_accessed_at
           FROM calendar_published_feeds
           WHERE owner_id=$1 AND calendar_id=$2
           ORDER BY created_at DESC,id"#,
    )
    .bind(owner)
    .bind(calendar_id)
    .fetch_all(&state.database)
    .await
    .map_err(|_| CalendarApiError::server(&request_id))?;
    Ok(Json(DataResponse::new(
        rows.into_iter()
            .map(|row| CalendarPublishedFeed {
                id: row.get::<Uuid, _>("id").to_string(),
                calendar_id: row.get::<Uuid, _>("calendar_id").to_string(),
                created_at: row.get::<DateTime<Utc>, _>("created_at").to_rfc3339(),
                last_accessed_at: row
                    .get::<Option<DateTime<Utc>>, _>("last_accessed_at")
                    .map(|value| value.to_rfc3339()),
            })
            .collect(),
    )))
}

pub async fn create_published_feed(
    State(state): State<AppState>,
    Extension(request_id): Extension<String>,
    headers: HeaderMap,
    Path(calendar_id): Path<Uuid>,
) -> Result<(StatusCode, Json<DataResponse<CreatedCalendarPublishedFeed>>), CalendarApiError> {
    let user = require_native_user(&state, &headers, &request_id).await?;
    let owner = owner_id(&user, &request_id)?;
    let calendar_exists = sqlx::query_scalar::<_, bool>(
        "SELECT EXISTS(SELECT 1 FROM calendars WHERE owner_id=$1 AND id=$2 AND deleted_at IS NULL)",
    )
    .bind(owner)
    .bind(calendar_id)
    .fetch_one(&state.database)
    .await
    .map_err(|_| CalendarApiError::server(&request_id))?;
    if !calendar_exists {
        return Err(CalendarApiError::not_found(&request_id));
    }
    let id = Uuid::now_v7();
    let token = generate_secret();
    let created_at = sqlx::query_scalar::<_, DateTime<Utc>>(
        r#"INSERT INTO calendar_published_feeds (id,owner_id,calendar_id,token_hash)
           VALUES ($1,$2,$3,$4) RETURNING created_at"#,
    )
    .bind(id)
    .bind(owner)
    .bind(calendar_id)
    .bind(hash_secret(&token))
    .fetch_one(&state.database)
    .await
    .map_err(|_| CalendarApiError::server(&request_id))?;
    Ok((
        StatusCode::CREATED,
        Json(DataResponse::new(CreatedCalendarPublishedFeed {
            feed: CalendarPublishedFeed {
                id: id.to_string(),
                calendar_id: calendar_id.to_string(),
                created_at: created_at.to_rfc3339(),
                last_accessed_at: None,
            },
            feed_path: format!("/api/v1/calendar-feeds/{token}"),
        })),
    ))
}

pub async fn revoke_published_feed(
    State(state): State<AppState>,
    Extension(request_id): Extension<String>,
    headers: HeaderMap,
    Path((calendar_id, feed_id)): Path<(Uuid, Uuid)>,
) -> Result<StatusCode, CalendarApiError> {
    let user = require_native_user(&state, &headers, &request_id).await?;
    let owner = owner_id(&user, &request_id)?;
    let result = sqlx::query(
        "DELETE FROM calendar_published_feeds WHERE id=$1 AND calendar_id=$2 AND owner_id=$3",
    )
    .bind(feed_id)
    .bind(calendar_id)
    .bind(owner)
    .execute(&state.database)
    .await
    .map_err(|_| CalendarApiError::server(&request_id))?;
    if result.rows_affected() == 0 {
        return Err(CalendarApiError::not_found(&request_id));
    }
    Ok(StatusCode::NO_CONTENT)
}

pub async fn read_published_feed(
    State(state): State<AppState>,
    Extension(request_id): Extension<String>,
    headers: HeaderMap,
    Path(token): Path<String>,
) -> Result<Response, CalendarApiError> {
    if token.len() < 32
        || token.len() > 128
        || !token
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || matches!(character, '-' | '_'))
    {
        return Err(CalendarApiError::not_found(&request_id));
    }
    let row = sqlx::query(
        r#"SELECT feed.id,feed.owner_id,feed.calendar_id,calendar.payload
           FROM calendar_published_feeds feed
           JOIN calendars calendar
             ON calendar.id=feed.calendar_id AND calendar.owner_id=feed.owner_id
           WHERE feed.token_hash=$1 AND calendar.deleted_at IS NULL"#,
    )
    .bind(hash_secret(&token))
    .fetch_optional(&state.database)
    .await
    .map_err(|_| CalendarApiError::server(&request_id))?
    .ok_or_else(|| CalendarApiError::not_found(&request_id))?;
    let feed_id: Uuid = row.get("id");
    let owner: Uuid = row.get("owner_id");
    let calendar_id: Uuid = row.get("calendar_id");
    let database = state.database.clone();
    tokio::spawn(async move {
        let _ =
            sqlx::query("UPDATE calendar_published_feeds SET last_accessed_at=now() WHERE id=$1")
                .bind(feed_id)
                .execute(&database)
                .await;
    });
    let calendar = serde_json::from_value::<CalendarDefinition>(row.get("payload"))
        .map_err(|_| CalendarApiError::server(&request_id))?;
    let item_rows = sqlx::query(
        r#"SELECT payload FROM calendar_items
           WHERE owner_id=$1 AND calendar_id=$2 AND deleted_at IS NULL
           ORDER BY uid,id LIMIT $3"#,
    )
    .bind(owner)
    .bind(calendar_id)
    .bind(MAX_PUBLISHED_FEED_ITEMS + 1)
    .fetch_all(&state.database)
    .await
    .map_err(|_| CalendarApiError::server(&request_id))?;
    if item_rows.len() as i64 > MAX_PUBLISHED_FEED_ITEMS {
        return Err(CalendarApiError::new(
            StatusCode::PAYLOAD_TOO_LARGE,
            ErrorCode::QuotaExceeded,
            "The published calendar contains too many items.",
            &request_id,
        ));
    }
    let items = item_rows
        .into_iter()
        .map(|row| serde_json::from_value::<CalendarItem>(row.get("payload")))
        .collect::<Result<Vec<_>, _>>()
        .map_err(|_| CalendarApiError::server(&request_id))?;
    let body = export_ics(&calendar, &items);
    if body.len() > MAX_PUBLISHED_FEED_BYTES {
        return Err(CalendarApiError::new(
            StatusCode::PAYLOAD_TOO_LARGE,
            ErrorCode::QuotaExceeded,
            "The published calendar feed is too large.",
            &request_id,
        ));
    }
    let etag = format!("\"{}\"", hex::encode(Sha256::digest(body.as_bytes())));
    if headers
        .get(header::IF_NONE_MATCH)
        .and_then(|value| value.to_str().ok())
        == Some(etag.as_str())
    {
        let mut response = StatusCode::NOT_MODIFIED.into_response();
        response.headers_mut().insert(
            header::CACHE_CONTROL,
            HeaderValue::from_static("private, max-age=300"),
        );
        response.headers_mut().insert(
            header::ETAG,
            HeaderValue::from_str(&etag).map_err(|_| CalendarApiError::server(&request_id))?,
        );
        return Ok(response);
    }
    let mut response = body.into_response();
    response.headers_mut().insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("text/calendar; charset=utf-8"),
    );
    response.headers_mut().insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("private, max-age=300"),
    );
    response.headers_mut().insert(
        header::CONTENT_DISPOSITION,
        HeaderValue::from_static("inline; filename=\"calendar.ics\""),
    );
    response.headers_mut().insert(
        header::ETAG,
        HeaderValue::from_str(&etag).map_err(|_| CalendarApiError::server(&request_id))?,
    );
    Ok(response)
}

pub async fn create_calendar(
    State(state): State<AppState>,
    Extension(request_id): Extension<String>,
    headers: HeaderMap,
    Json(calendar): Json<CalendarDefinition>,
) -> Result<(StatusCode, Json<DataResponse<Value>>), CalendarApiError> {
    let user = require_native_user(&state, &headers, &request_id).await?;
    let owner = owner_id(&user, &request_id)?;
    validate_calendar(&calendar, owner, &request_id)?;
    let id = parse_uuid(&calendar.id, "Calendar ID", &request_id)?;
    let global_id = parse_uuid(&calendar.global_id, "Calendar global ID", &request_id)?;
    let canonical = canonical_calendar(calendar, 1, Utc::now());
    let payload =
        serde_json::to_value(&canonical).map_err(|_| CalendarApiError::server(&request_id))?;
    let logical_size_bytes = logical_size(&payload);
    let mut tx = state
        .database
        .begin()
        .await
        .map_err(|_| CalendarApiError::server(&request_id))?;
    ensure_calendar_quota(
        &mut tx,
        owner,
        state.config.calendar_quota_bytes,
        0,
        logical_size_bytes,
        &request_id,
    )
    .await?;
    sqlx::query(
        r#"INSERT INTO calendars
           (id, owner_id, global_id, name, color, default_time_zone, archived, read_only, revision, payload, logical_size_bytes)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,1,$9,$10)"#,
    )
    .bind(id).bind(owner).bind(global_id).bind(&canonical.name).bind(&canonical.color)
    .bind(&canonical.default_time_zone).bind(canonical.archived).bind(canonical.read_only).bind(&payload).bind(logical_size_bytes)
    .execute(&mut *tx).await.map_err(|error| {
        if error.as_database_error().is_some_and(|value| value.is_unique_violation()) {
            CalendarApiError::conflict("That calendar already exists.", &request_id)
        } else { CalendarApiError::server(&request_id) }
    })?;
    insert_change(&mut tx, owner, "calendar", id, "upsert", Some(&payload))
        .await
        .map_err(|_| CalendarApiError::server(&request_id))?;
    tx.commit()
        .await
        .map_err(|_| CalendarApiError::server(&request_id))?;
    Ok((StatusCode::CREATED, Json(DataResponse::new(payload))))
}

pub async fn update_calendar(
    State(state): State<AppState>,
    Extension(request_id): Extension<String>,
    headers: HeaderMap,
    Path(calendar_id): Path<Uuid>,
    Json(calendar): Json<CalendarDefinition>,
) -> Result<Json<DataResponse<Value>>, CalendarApiError> {
    let user = require_native_user(&state, &headers, &request_id).await?;
    let owner = owner_id(&user, &request_id)?;
    validate_calendar(&calendar, owner, &request_id)?;
    if parse_uuid(&calendar.id, "Calendar ID", &request_id)? != calendar_id {
        return Err(CalendarApiError::validation(
            "Calendar ID does not match the route.",
            &request_id,
        ));
    }
    let existing = sqlx::query(
        "SELECT revision, created_at, logical_size_bytes FROM calendars WHERE owner_id = $1 AND id = $2 AND deleted_at IS NULL",
    ).bind(owner).bind(calendar_id).fetch_optional(&state.database).await
        .map_err(|_| CalendarApiError::server(&request_id))?
        .ok_or_else(|| CalendarApiError::not_found(&request_id))?;
    let actual_revision: i64 = existing.get("revision");
    if calendar.revision != actual_revision {
        return Err(CalendarApiError::conflict(
            format!(
                "Calendar revision conflict: expected {}, actual {actual_revision}.",
                calendar.revision
            ),
            &request_id,
        ));
    }
    let canonical = canonical_calendar(calendar, actual_revision + 1, existing.get("created_at"));
    let payload =
        serde_json::to_value(&canonical).map_err(|_| CalendarApiError::server(&request_id))?;
    let logical_size_bytes = logical_size(&payload);
    let mut tx = state
        .database
        .begin()
        .await
        .map_err(|_| CalendarApiError::server(&request_id))?;
    ensure_calendar_quota(
        &mut tx,
        owner,
        state.config.calendar_quota_bytes,
        existing.get("logical_size_bytes"),
        logical_size_bytes,
        &request_id,
    )
    .await?;
    sqlx::query(
        r#"UPDATE calendars SET name=$1,color=$2,default_time_zone=$3,archived=$4,read_only=$5,
           revision=$6,payload=$7,logical_size_bytes=$8,updated_at=now() WHERE owner_id=$9 AND id=$10"#,
    )
    .bind(&canonical.name)
    .bind(&canonical.color)
    .bind(&canonical.default_time_zone)
    .bind(canonical.archived)
    .bind(canonical.read_only)
    .bind(canonical.revision)
    .bind(&payload)
    .bind(logical_size_bytes)
    .bind(owner)
    .bind(calendar_id)
    .execute(&mut *tx)
    .await
    .map_err(|_| CalendarApiError::server(&request_id))?;
    insert_change(
        &mut tx,
        owner,
        "calendar",
        calendar_id,
        "upsert",
        Some(&payload),
    )
    .await
    .map_err(|_| CalendarApiError::server(&request_id))?;
    tx.commit()
        .await
        .map_err(|_| CalendarApiError::server(&request_id))?;
    Ok(Json(DataResponse::new(payload)))
}

pub async fn delete_calendar(
    State(state): State<AppState>,
    Extension(request_id): Extension<String>,
    headers: HeaderMap,
    Path(calendar_id): Path<Uuid>,
) -> Result<StatusCode, CalendarApiError> {
    let user = require_native_user(&state, &headers, &request_id).await?;
    let owner = owner_id(&user, &request_id)?;
    let mut tx = state
        .database
        .begin()
        .await
        .map_err(|_| CalendarApiError::server(&request_id))?;
    let result = sqlx::query(
        "UPDATE calendars SET deleted_at=now(),updated_at=now() WHERE owner_id=$1 AND id=$2 AND deleted_at IS NULL",
    ).bind(owner).bind(calendar_id).execute(&mut *tx).await
      .map_err(|_| CalendarApiError::server(&request_id))?;
    if result.rows_affected() == 0 {
        return Err(CalendarApiError::not_found(&request_id));
    }
    sqlx::query(
        "DELETE FROM calendar_invitations WHERE organizer_owner_id=$1 AND item_id IN (SELECT id FROM calendar_items WHERE calendar_id=$2 AND owner_id=$1)",
    )
    .bind(owner)
    .bind(calendar_id)
    .execute(&mut *tx)
    .await
    .map_err(|_| CalendarApiError::server(&request_id))?;
    for table in ["calendar_attendees", "calendar_attachments"] {
        let statement = format!(
            "DELETE FROM {table} WHERE owner_id=$1 AND item_id IN (SELECT id FROM calendar_items WHERE calendar_id=$2 AND owner_id=$1)"
        );
        sqlx::query(&statement)
            .bind(owner)
            .bind(calendar_id)
            .execute(&mut *tx)
            .await
            .map_err(|_| CalendarApiError::server(&request_id))?;
    }
    sqlx::query(
        "UPDATE calendar_items SET deleted_at=now(),updated_at=now() WHERE owner_id=$1 AND calendar_id=$2 AND deleted_at IS NULL",
    )
    .bind(owner)
    .bind(calendar_id)
    .execute(&mut *tx)
    .await
    .map_err(|_| CalendarApiError::server(&request_id))?;
    insert_change(&mut tx, owner, "calendar", calendar_id, "delete", None)
        .await
        .map_err(|_| CalendarApiError::server(&request_id))?;
    tx.commit()
        .await
        .map_err(|_| CalendarApiError::server(&request_id))?;
    Ok(StatusCode::NO_CONTENT)
}

pub async fn upload_attachment(
    State(state): State<AppState>,
    Extension(request_id): Extension<String>,
    headers: HeaderMap,
    Path(calendar_id): Path<Uuid>,
    Json(request): Json<CalendarAttachmentUploadRequest>,
) -> Result<(StatusCode, Json<DataResponse<CalendarAttachmentUpload>>), CalendarApiError> {
    let user = require_native_user(&state, &headers, &request_id).await?;
    let owner = owner_id(&user, &request_id)?;
    let name = request.name.trim();
    if name.is_empty() || name.chars().count() > 255 || request.media_type.len() > 255 {
        return Err(CalendarApiError::validation(
            "Attachment name or media type is invalid.",
            &request_id,
        ));
    }
    let content = base64::engine::general_purpose::STANDARD
        .decode(request.content_base64)
        .map_err(|_| {
            CalendarApiError::validation("Attachment content is not valid base64.", &request_id)
        })?;
    if content.is_empty() || content.len() > state.config.max_file_bytes {
        return Err(CalendarApiError::validation(
            "Attachment size is outside the configured limit.",
            &request_id,
        ));
    }
    let mut tx = state
        .database
        .begin()
        .await
        .map_err(|_| CalendarApiError::server(&request_id))?;
    let owns_calendar = sqlx::query_scalar::<_, bool>(
        "SELECT EXISTS(SELECT 1 FROM calendars WHERE id=$1 AND owner_id=$2 AND deleted_at IS NULL AND read_only=FALSE)",
    ).bind(calendar_id).bind(owner).fetch_one(&mut *tx).await
      .map_err(|_| CalendarApiError::server(&request_id))?;
    if !owns_calendar {
        return Err(CalendarApiError::not_found(&request_id));
    }
    ensure_calendar_quota(
        &mut tx,
        owner,
        state.config.calendar_quota_bytes,
        0,
        content.len() as i64,
        &request_id,
    )
    .await?;
    let id = Uuid::now_v7();
    let sha256 = format!("{:x}", Sha256::digest(&content));
    sqlx::query(
        "INSERT INTO calendar_attachment_uploads (id,owner_id,calendar_id,name,media_type,sha256,size_bytes,content) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)",
    ).bind(id).bind(owner).bind(calendar_id).bind(name).bind(&request.media_type).bind(&sha256)
      .bind(content.len() as i64).bind(&content).execute(&mut *tx).await
      .map_err(|_| CalendarApiError::server(&request_id))?;
    tx.commit()
        .await
        .map_err(|_| CalendarApiError::server(&request_id))?;
    Ok((
        StatusCode::CREATED,
        Json(DataResponse::new(CalendarAttachmentUpload {
            id: id.to_string(),
            name: name.to_owned(),
            media_type: request.media_type,
            size_bytes: content.len() as i64,
            sha256,
            content_base64: None,
        })),
    ))
}

pub async fn download_attachment(
    State(state): State<AppState>,
    Extension(request_id): Extension<String>,
    headers: HeaderMap,
    Path(attachment_id): Path<Uuid>,
) -> Result<Json<DataResponse<CalendarAttachmentUpload>>, CalendarApiError> {
    let user = require_native_user(&state, &headers, &request_id).await?;
    let user_id = owner_id(&user, &request_id)?;
    let row = sqlx::query(
        r#"SELECT upload.name,upload.media_type,upload.sha256,upload.size_bytes,upload.content
           FROM calendar_attachment_uploads upload
           WHERE upload.id=$1 AND (
             upload.owner_id=$2 OR EXISTS (
               SELECT 1 FROM calendar_attachments attachment
               JOIN calendar_invitations invitation ON invitation.item_id=attachment.item_id
               WHERE attachment.upload_id=upload.id AND invitation.attendee_user_id=$2
             )
           )"#,
    )
    .bind(attachment_id)
    .bind(user_id)
    .fetch_optional(&state.database)
    .await
    .map_err(|_| CalendarApiError::server(&request_id))?
    .ok_or_else(|| CalendarApiError::not_found(&request_id))?;
    let content: Vec<u8> = row.get("content");
    Ok(Json(DataResponse::new(CalendarAttachmentUpload {
        id: attachment_id.to_string(),
        name: row.get("name"),
        media_type: row.get("media_type"),
        size_bytes: row.get("size_bytes"),
        sha256: row.get("sha256"),
        content_base64: Some(base64::engine::general_purpose::STANDARD.encode(content)),
    })))
}

pub async fn delete_attachment(
    State(state): State<AppState>,
    Extension(request_id): Extension<String>,
    headers: HeaderMap,
    Path(attachment_id): Path<Uuid>,
) -> Result<StatusCode, CalendarApiError> {
    let user = require_native_user(&state, &headers, &request_id).await?;
    let result = sqlx::query(
        "DELETE FROM calendar_attachment_uploads WHERE id=$1 AND owner_id=$2 AND NOT EXISTS (SELECT 1 FROM calendar_attachments WHERE upload_id=$1)",
    ).bind(attachment_id).bind(owner_id(&user, &request_id)?).execute(&state.database).await
      .map_err(|_| CalendarApiError::server(&request_id))?;
    if result.rows_affected() == 0 {
        return Err(CalendarApiError::conflict(
            "Attachment is missing or still referenced.",
            &request_id,
        ));
    }
    Ok(StatusCode::NO_CONTENT)
}

pub async fn list_invitations(
    State(state): State<AppState>,
    Extension(request_id): Extension<String>,
    headers: HeaderMap,
) -> Result<Json<DataResponse<Vec<Value>>>, CalendarApiError> {
    let user = require_native_user(&state, &headers, &request_id).await?;
    let rows = sqlx::query(
        "SELECT payload FROM calendar_invitations WHERE attendee_user_id=$1 ORDER BY updated_at DESC, id",
    )
    .bind(owner_id(&user, &request_id)?)
    .fetch_all(&state.database)
    .await
    .map_err(|_| CalendarApiError::server(&request_id))?;
    Ok(Json(DataResponse::new(
        rows.into_iter().map(|row| row.get("payload")).collect(),
    )))
}

pub async fn respond_to_invitation(
    State(state): State<AppState>,
    Extension(request_id): Extension<String>,
    headers: HeaderMap,
    Path(invitation_id): Path<Uuid>,
    Json(request): Json<InvitationResponseRequest>,
) -> Result<Json<DataResponse<Value>>, CalendarApiError> {
    if !matches!(
        request.response.as_str(),
        "needs-action" | "accepted" | "declined" | "tentative"
    ) {
        return Err(CalendarApiError::validation(
            "Invitation response is invalid.",
            &request_id,
        ));
    }
    let user = require_native_user(&state, &headers, &request_id).await?;
    let attendee_user_id = owner_id(&user, &request_id)?;
    let mut tx = state
        .database
        .begin()
        .await
        .map_err(|_| CalendarApiError::server(&request_id))?;
    let row = sqlx::query(
        r#"SELECT invitation.organizer_owner_id,invitation.item_id,invitation.attendee_id,
                  item.payload,item.logical_size_bytes
           FROM calendar_invitations invitation
           JOIN calendar_items item ON item.id=invitation.item_id AND item.deleted_at IS NULL
           WHERE invitation.id=$1 AND invitation.attendee_user_id=$2
           FOR UPDATE OF invitation,item"#,
    )
    .bind(invitation_id)
    .bind(attendee_user_id)
    .fetch_optional(&mut *tx)
    .await
    .map_err(|_| CalendarApiError::server(&request_id))?
    .ok_or_else(|| CalendarApiError::not_found(&request_id))?;
    let organizer_owner_id: Uuid = row.get("organizer_owner_id");
    let item_id: Uuid = row.get("item_id");
    let attendee_id: String = row.get("attendee_id");
    let mut item: CalendarItem = serde_json::from_value(row.get("payload"))
        .map_err(|_| CalendarApiError::server(&request_id))?;
    let attendee = item.attendees.iter_mut().find(|attendee| match attendee {
        CalendarAttendee::CollabUser { id, user_id, .. } => {
            id == &attendee_id && user_id == &attendee_user_id.to_string()
        }
        CalendarAttendee::Email { .. } => false,
    });
    let Some(CalendarAttendee::CollabUser { response, .. }) = attendee else {
        return Err(CalendarApiError::not_found(&request_id));
    };
    *response = request.response.clone();
    item.revision += 1;
    item.updated_at = Utc::now().to_rfc3339();
    let payload = serde_json::to_value(&item).map_err(|_| CalendarApiError::server(&request_id))?;
    let logical_size_bytes = logical_size(&payload);
    ensure_calendar_quota(
        &mut tx,
        organizer_owner_id,
        state.config.calendar_quota_bytes,
        row.get("logical_size_bytes"),
        logical_size_bytes,
        &request_id,
    )
    .await?;
    sqlx::query(
        "UPDATE calendar_items SET revision=$1,payload=$2,logical_size_bytes=$3,updated_at=now() WHERE id=$4 AND owner_id=$5",
    )
    .bind(item.revision)
    .bind(&payload)
    .bind(logical_size_bytes)
    .bind(item_id)
    .bind(organizer_owner_id)
    .execute(&mut *tx)
    .await
    .map_err(|_| CalendarApiError::server(&request_id))?;
    sqlx::query(
        "UPDATE calendar_attendees SET response=$1,payload=jsonb_set(payload,'{response}',to_jsonb($1::text)) WHERE item_id=$2 AND attendee_id=$3",
    )
    .bind(&request.response)
    .bind(item_id)
    .bind(&attendee_id)
    .execute(&mut *tx)
    .await
    .map_err(|_| CalendarApiError::server(&request_id))?;
    sqlx::query(
        "UPDATE calendar_invitations SET payload=jsonb_set(payload,'{item}',$1),updated_at=now() WHERE item_id=$2",
    )
    .bind(&payload)
    .bind(item_id)
    .execute(&mut *tx)
    .await
    .map_err(|_| CalendarApiError::server(&request_id))?;
    let invitation_payload = serde_json::json!({
        "id": invitation_id,
        "organizerUserId": organizer_owner_id,
        "attendeeUserId": attendee_user_id,
        "attendeeId": attendee_id,
        "response": request.response,
        "item": item,
    });
    sqlx::query(
        "UPDATE calendar_invitations SET response=$1,payload=$2,updated_at=now() WHERE id=$3",
    )
    .bind(&request.response)
    .bind(&invitation_payload)
    .bind(invitation_id)
    .execute(&mut *tx)
    .await
    .map_err(|_| CalendarApiError::server(&request_id))?;
    insert_change(
        &mut tx,
        organizer_owner_id,
        "item",
        item_id,
        "upsert",
        Some(&payload),
    )
    .await
    .map_err(|_| CalendarApiError::server(&request_id))?;
    tx.commit()
        .await
        .map_err(|_| CalendarApiError::server(&request_id))?;
    Ok(Json(DataResponse::new(invitation_payload)))
}

fn time_value_parts(
    value: Option<&CalendarTimeValue>,
) -> (Option<DateTime<Utc>>, Option<NaiveDate>) {
    match value {
        Some(CalendarTimeValue::DateTime { date_time, .. }) => (
            DateTime::parse_from_rfc3339(date_time)
                .ok()
                .map(|value| value.with_timezone(&Utc)),
            None,
        ),
        Some(CalendarTimeValue::Date { date }) => {
            (None, NaiveDate::parse_from_str(date, "%Y-%m-%d").ok())
        }
        None => (None, None),
    }
}

fn item_range(
    item: &CalendarItem,
) -> (
    Option<DateTime<Utc>>,
    Option<DateTime<Utc>>,
    Option<NaiveDate>,
    Option<NaiveDate>,
) {
    let (start_at, start_date) =
        time_value_parts(item.start.as_ref().or_else(|| item.due.as_ref()));
    let (end_at, end_date) = time_value_parts(item.end.as_ref().or_else(|| item.due.as_ref()));
    let birthday = item
        .date
        .as_deref()
        .and_then(|value| NaiveDate::parse_from_str(value, "%Y-%m-%d").ok());
    (
        start_at,
        end_at.or(start_at),
        start_date.or(birthday),
        end_date.or(start_date).or(birthday),
    )
}

#[derive(Debug, PartialEq, Eq)]
enum ItemRevisionError {
    Conflict(String),
    Invalid(String),
}

fn next_item_revision(
    actual_revision: Option<i64>,
    expected_revision: Option<i64>,
    supplied_revision: i64,
) -> Result<i64, ItemRevisionError> {
    let expected = expected_revision.unwrap_or(0);
    let actual = actual_revision.unwrap_or(0);
    if actual_revision.is_some() && expected != actual {
        return Err(ItemRevisionError::Conflict(format!(
            "Calendar item revision conflict: expected {expected}, actual {actual}."
        )));
    }
    let next = actual_revision.map_or(0, |value| value + 1);
    if supplied_revision != next {
        return Err(ItemRevisionError::Invalid(format!(
            "Calendar item revision must be {next}."
        )));
    }
    Ok(next)
}

pub(crate) async fn apply_operation(
    tx: &mut Transaction<'_, Postgres>,
    owner: Uuid,
    operation: &CalendarOperation,
    quota_bytes: u64,
    request_id: &str,
) -> Result<OperationResult, CalendarApiError> {
    if operation.client_operation_id.trim().is_empty() || operation.client_operation_id.len() > 255
    {
        return Err(CalendarApiError::validation(
            "Client operation ID is invalid.",
            request_id,
        ));
    }
    if let Some(result) = sqlx::query_scalar::<_, Value>(
        "SELECT result FROM calendar_client_operations WHERE owner_id=$1 AND client_operation_id=$2",
    ).bind(owner).bind(&operation.client_operation_id).fetch_optional(&mut **tx).await
      .map_err(|_| CalendarApiError::server(request_id))? {
        return serde_json::from_value(result).map_err(|_| CalendarApiError::server(request_id));
    }

    let (entity_type, entity_id, change_operation, payload) = match &operation.mutation {
        CalendarMutation::UpsertItem { item } => {
            validate_item(item, request_id)?;
            let calendar_id = parse_uuid(&item.calendar_id, "Calendar ID", request_id)?;
            let item_id = parse_uuid(&item.id, "Item ID", request_id)?;
            let owns_calendar = sqlx::query_scalar::<_, bool>(
                "SELECT EXISTS(SELECT 1 FROM calendars WHERE owner_id=$1 AND id=$2 AND deleted_at IS NULL AND read_only=FALSE)",
            ).bind(owner).bind(calendar_id).fetch_one(&mut **tx).await
              .map_err(|_| CalendarApiError::server(request_id))?;
            if !owns_calendar {
                return Err(CalendarApiError::not_found(request_id));
            }
            let existing = sqlx::query(
                "SELECT revision, logical_size_bytes FROM calendar_items WHERE owner_id=$1 AND id=$2",
            )
            .bind(owner)
            .bind(item_id)
            .fetch_optional(&mut **tx)
            .await
            .map_err(|_| CalendarApiError::server(request_id))?;
            let actual_revision = existing.as_ref().map(|row| row.get::<i64, _>("revision"));
            let replaced_bytes = existing
                .as_ref()
                .map(|row| row.get::<i64, _>("logical_size_bytes"))
                .unwrap_or(0);
            let next_revision =
                next_item_revision(actual_revision, operation.expected_revision, item.revision)
                    .map_err(|error| match error {
                        ItemRevisionError::Conflict(message) => {
                            CalendarApiError::conflict(message, request_id)
                        }
                        ItemRevisionError::Invalid(message) => {
                            CalendarApiError::validation(message, request_id)
                        }
                    })?;
            let mut canonical = item.clone();
            canonical.revision = next_revision;
            canonical.updated_at = Utc::now().to_rfc3339();
            if actual_revision.is_none() {
                canonical.created_at = canonical.updated_at.clone();
            }
            let payload = serde_json::to_value(&canonical)
                .map_err(|_| CalendarApiError::server(request_id))?;
            let logical_size_bytes = logical_size(&payload);
            ensure_calendar_quota(
                tx,
                owner,
                quota_bytes,
                replaced_bytes,
                logical_size_bytes,
                request_id,
            )
            .await?;
            let (start_at, end_at, start_date, end_date) = item_range(&canonical);
            let recurrence_id = canonical
                .recurrence_id
                .as_ref()
                .map(serde_json::to_string)
                .transpose()
                .map_err(|_| CalendarApiError::server(request_id))?;
            let (recurrence_at, recurrence_date) = match canonical.recurrence_id.as_ref() {
                Some(CalendarTimeValue::DateTime { date_time, .. }) => (
                    DateTime::parse_from_rfc3339(date_time)
                        .ok()
                        .map(|value| value.with_timezone(&Utc)),
                    None,
                ),
                Some(CalendarTimeValue::Date { date }) => {
                    (None, NaiveDate::parse_from_str(date, "%Y-%m-%d").ok())
                }
                None => (None, None),
            };
            let recurrence_series_id = canonical
                .recurrence_series_id
                .as_deref()
                .map(|value| parse_uuid(value, "Recurrence series ID", request_id))
                .transpose()?;
            sqlx::query(
                r#"INSERT INTO calendar_items
                   (id,owner_id,calendar_id,uid,kind,start_at,end_at,start_date,end_date,recurrence_rule,recurrence_id,recurrence_at,recurrence_date,recurrence_series_id,revision,payload,logical_size_bytes,deleted_at)
                   VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,NULL)
                   ON CONFLICT (id) DO UPDATE SET calendar_id=EXCLUDED.calendar_id,uid=EXCLUDED.uid,
                     kind=EXCLUDED.kind,start_at=EXCLUDED.start_at,end_at=EXCLUDED.end_at,
                     start_date=EXCLUDED.start_date,end_date=EXCLUDED.end_date,
                     recurrence_rule=EXCLUDED.recurrence_rule,recurrence_id=EXCLUDED.recurrence_id,
                     recurrence_at=EXCLUDED.recurrence_at,recurrence_date=EXCLUDED.recurrence_date,
                     recurrence_series_id=EXCLUDED.recurrence_series_id,revision=EXCLUDED.revision,
                     payload=EXCLUDED.payload,logical_size_bytes=EXCLUDED.logical_size_bytes,deleted_at=NULL,updated_at=now()"#,
            ).bind(item_id).bind(owner).bind(calendar_id).bind(&canonical.uid)
              .bind(canonical.kind.as_str()).bind(start_at).bind(end_at).bind(start_date).bind(end_date)
              .bind(canonical.recurrence.as_ref().map(|value| value.rrule.as_str()))
              .bind(recurrence_id).bind(recurrence_at).bind(recurrence_date)
              .bind(recurrence_series_id).bind(canonical.revision).bind(&payload).bind(logical_size_bytes).execute(&mut **tx).await
              .map_err(|error| {
                  if error.as_database_error().is_some_and(|value| value.is_unique_violation()) {
                      CalendarApiError::conflict("An item with that UID already exists in the calendar.", request_id)
                  } else { CalendarApiError::server(request_id) }
              })?;
            replace_item_relations(tx, owner, item_id, calendar_id, &canonical, request_id).await?;
            ("item", item_id, "upsert", Some(payload))
        }
        CalendarMutation::DeleteItem {
            calendar_id,
            item_id,
            deleted_at,
        } => {
            let calendar_id = parse_uuid(calendar_id, "Calendar ID", request_id)?;
            let item_id = parse_uuid(item_id, "Item ID", request_id)?;
            let deleted_at = DateTime::parse_from_rfc3339(deleted_at)
                .map_err(|_| {
                    CalendarApiError::validation("Deleted timestamp is invalid.", request_id)
                })?
                .with_timezone(&Utc);
            let result = sqlx::query(
                "UPDATE calendar_items SET deleted_at=$1,updated_at=now() WHERE owner_id=$2 AND calendar_id=$3 AND id=$4",
            ).bind(deleted_at).bind(owner).bind(calendar_id).bind(item_id).execute(&mut **tx).await
              .map_err(|_| CalendarApiError::server(request_id))?;
            if result.rows_affected() == 0 {
                return Err(CalendarApiError::not_found(request_id));
            }
            sqlx::query(
                "DELETE FROM calendar_invitations WHERE organizer_owner_id=$1 AND item_id=$2",
            )
            .bind(owner)
            .bind(item_id)
            .execute(&mut **tx)
            .await
            .map_err(|_| CalendarApiError::server(request_id))?;
            sqlx::query("DELETE FROM calendar_attendees WHERE owner_id=$1 AND item_id=$2")
                .bind(owner)
                .bind(item_id)
                .execute(&mut **tx)
                .await
                .map_err(|_| CalendarApiError::server(request_id))?;
            sqlx::query("DELETE FROM calendar_attachments WHERE owner_id=$1 AND item_id=$2")
                .bind(owner)
                .bind(item_id)
                .execute(&mut **tx)
                .await
                .map_err(|_| CalendarApiError::server(request_id))?;
            ("item", item_id, "delete", None)
        }
        _ => {
            return Err(CalendarApiError::validation(
                "Calendar definition operations must use the calendar endpoints.",
                request_id,
            ))
        }
    };
    let sequence = insert_change(
        tx,
        owner,
        entity_type,
        entity_id,
        change_operation,
        payload.as_ref(),
    )
    .await
    .map_err(|_| CalendarApiError::server(request_id))?;
    let result = OperationResult {
        client_operation_id: operation.client_operation_id.clone(),
        applied: true,
        change_sequence: Some(sequence),
    };
    sqlx::query(
        "INSERT INTO calendar_client_operations (owner_id,client_operation_id,result) VALUES ($1,$2,$3)",
    ).bind(owner).bind(&operation.client_operation_id)
      .bind(serde_json::to_value(&result).map_err(|_| CalendarApiError::server(request_id))?)
      .execute(&mut **tx).await.map_err(|_| CalendarApiError::server(request_id))?;
    Ok(result)
}

pub async fn apply_operations(
    State(state): State<AppState>,
    Extension(request_id): Extension<String>,
    headers: HeaderMap,
    Json(request): Json<OperationsRequest>,
) -> Result<Json<DataResponse<Vec<OperationResult>>>, CalendarApiError> {
    if request.operations.is_empty() || request.operations.len() > MAX_OPERATION_ITEMS {
        return Err(CalendarApiError::validation(
            format!("Operation batch must contain between 1 and {MAX_OPERATION_ITEMS} entries."),
            &request_id,
        ));
    }
    let user = require_native_user(&state, &headers, &request_id).await?;
    let owner = owner_id(&user, &request_id)?;
    let mut tx = state
        .database
        .begin()
        .await
        .map_err(|_| CalendarApiError::server(&request_id))?;
    let mut results = Vec::with_capacity(request.operations.len());
    for operation in &request.operations {
        results.push(
            apply_operation(
                &mut tx,
                owner,
                operation,
                state.config.calendar_quota_bytes,
                &request_id,
            )
            .await?,
        );
    }
    tx.commit()
        .await
        .map_err(|_| CalendarApiError::server(&request_id))?;
    Ok(Json(DataResponse::new(results)))
}

pub async fn query_items(
    State(state): State<AppState>,
    Extension(request_id): Extension<String>,
    headers: HeaderMap,
    Query(query): Query<CalendarQuery>,
) -> Result<Json<DataResponse<Vec<Value>>>, CalendarApiError> {
    let user = require_native_user(&state, &headers, &request_id).await?;
    let owner = owner_id(&user, &request_id)?;
    let from = DateTime::parse_from_rfc3339(&query.from)
        .map_err(|_| {
            CalendarApiError::validation("Query start must be an offset timestamp.", &request_id)
        })?
        .with_timezone(&Utc);
    let to = DateTime::parse_from_rfc3339(&query.to)
        .map_err(|_| {
            CalendarApiError::validation("Query end must be an offset timestamp.", &request_id)
        })?
        .with_timezone(&Utc);
    if to <= from || to - from > chrono::Duration::days(370) {
        return Err(CalendarApiError::validation(
            "Calendar queries must span between 1 second and 370 days.",
            &request_id,
        ));
    }
    let limit = query.limit.unwrap_or(1_000).clamp(1, MAX_QUERY_ITEMS);
    let from_date = from.date_naive();
    let to_date = to.date_naive();
    let rows = sqlx::query(
        r#"SELECT payload FROM calendar_items item WHERE owner_id=$1 AND ($2 OR deleted_at IS NULL)
           AND (recurrence_series_id IS NULL OR EXISTS (
             SELECT 1 FROM calendar_items master
             WHERE master.owner_id=$1 AND master.id=item.recurrence_series_id
               AND ($2 OR master.deleted_at IS NULL)
           ))
           AND (recurrence_rule IS NOT NULL
             OR (kind='task' AND start_at IS NULL AND start_date IS NULL)
             OR (recurrence_at >= $3 AND recurrence_at < $4)
             OR (recurrence_date >= $5 AND recurrence_date < $6)
             OR (start_at < $4 AND COALESCE(end_at,start_at) >= $3)
             OR (start_date < $6 AND COALESCE(end_date,start_date) >= $5)
             OR kind='birthday')
           ORDER BY COALESCE(start_at, start_date::timestamp AT TIME ZONE 'UTC'), id LIMIT $7"#,
    )
    .bind(owner)
    .bind(query.include_deleted)
    .bind(from)
    .bind(to)
    .bind(from_date)
    .bind(to_date)
    .bind(limit)
    .fetch_all(&state.database)
    .await
    .map_err(|_| CalendarApiError::server(&request_id))?;
    Ok(Json(DataResponse::new(
        rows.into_iter().map(|row| row.get("payload")).collect(),
    )))
}

pub async fn list_changes(
    State(state): State<AppState>,
    Extension(request_id): Extension<String>,
    headers: HeaderMap,
    Query(query): Query<ChangesQuery>,
) -> Result<Json<DataResponse<CalendarChanges>>, CalendarApiError> {
    let user = require_native_user(&state, &headers, &request_id).await?;
    let owner = owner_id(&user, &request_id)?;
    let cursor = query.cursor.unwrap_or(0).max(0);
    let limit = query.limit.unwrap_or(500).clamp(1, MAX_CHANGE_ITEMS);
    let rows = sqlx::query(
        r#"SELECT sequence,entity_type,entity_id,operation,payload,changed_at
           FROM calendar_change_log WHERE owner_id=$1 AND sequence>$2 ORDER BY sequence LIMIT $3"#,
    )
    .bind(owner)
    .bind(cursor)
    .bind(limit + 1)
    .fetch_all(&state.database)
    .await
    .map_err(|_| CalendarApiError::server(&request_id))?;
    let has_more = rows.len() as i64 > limit;
    let changes = rows
        .into_iter()
        .take(limit as usize)
        .map(|row| CalendarChange {
            sequence: row.get("sequence"),
            entity_type: row.get("entity_type"),
            entity_id: row.get::<Uuid, _>("entity_id").to_string(),
            operation: row.get("operation"),
            payload: row.get("payload"),
            changed_at: row.get::<DateTime<Utc>, _>("changed_at").to_rfc3339(),
        })
        .collect::<Vec<_>>();
    let next_cursor = changes
        .last()
        .map(|change| change.sequence)
        .unwrap_or(cursor);
    Ok(Json(DataResponse::new(CalendarChanges {
        changes,
        cursor: next_cursor,
        has_more,
    })))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        app::{build_router, AppState},
        auth::hash_secret,
        config::ServerConfig,
        database,
        storage::FileSystemBlobStorage,
    };
    use axum::{
        body::Body,
        http::{header, Request},
        Router,
    };
    use http_body_util::BodyExt;
    use serde_json::json;
    use sqlx::postgres::PgPoolOptions;
    use std::sync::Arc;
    use tower::ServiceExt;

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

    async fn cookie_request(app: &Router, uri: &str, cookie: &str) -> axum::response::Response {
        app.clone()
            .oneshot(
                Request::builder()
                    .method("GET")
                    .uri(uri)
                    .header(header::COOKIE, cookie)
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap()
    }

    async fn json_body(response: axum::response::Response) -> Value {
        let bytes = response.into_body().collect().await.unwrap().to_bytes();
        serde_json::from_slice(&bytes).unwrap()
    }

    async fn insert_user_with_native_session(
        pool: &sqlx::PgPool,
        username: &str,
    ) -> (Uuid, String) {
        let user_id = Uuid::now_v7();
        sqlx::query(
            "INSERT INTO users (id,username,normalized_username,display_name) VALUES ($1,$2,$2,$2)",
        )
        .bind(user_id)
        .bind(username)
        .execute(pool)
        .await
        .unwrap();
        let token = format!("{username}-calendar-access-token");
        sqlx::query(
            r#"INSERT INTO native_sessions
               (id,user_id,access_token_hash,refresh_token_hash,client_name,access_expires_at,refresh_expires_at)
               VALUES ($1,$2,$3,$4,'calendar-test',now()+interval '1 hour',now()+interval '1 day')"#,
        )
        .bind(Uuid::now_v7())
        .bind(user_id)
        .bind(hash_secret(&token))
        .bind(hash_secret(&format!("{username}-calendar-refresh-token")))
        .execute(pool)
        .await
        .unwrap();
        (user_id, token)
    }

    #[test]
    fn item_range_preserves_date_only_birthdays() {
        let item: CalendarItem = serde_json::from_value(serde_json::json!({
            "id":"0198f9c1-5b21-7000-8000-000000000001",
            "uid":"birthday@example","calendarId":"0198f9c1-5b21-7000-8000-000000000002",
            "kind":"birthday","title":"Ada","reminders":[],"date":"2026-12-10",
            "revision":1,"createdAt":"2026-07-22T08:00:00Z","updatedAt":"2026-07-22T08:00:00Z"
        }))
        .unwrap();
        let (_, _, start, end) = item_range(&item);
        assert_eq!(start, NaiveDate::from_ymd_opt(2026, 12, 10));
        assert_eq!(end, start);
    }

    #[test]
    fn item_revisions_start_at_zero_and_advance_after_updates() {
        assert_eq!(next_item_revision(None, Some(0), 0), Ok(0));
        assert_eq!(next_item_revision(Some(0), Some(0), 1), Ok(1));
        assert!(next_item_revision(Some(1), Some(0), 1).is_err());
        assert!(next_item_revision(Some(1), Some(1), 1).is_err());
    }

    #[test]
    fn recurrence_validation_rejects_malformed_or_unbounded_values() {
        assert!(validate_recurrence_rule("FREQ=WEEKLY;INTERVAL=2", "request").is_ok());
        assert!(validate_recurrence_rule("FREQ=NOPE", "request").is_err());
        assert!(validate_recurrence_rule("FREQ=DAILY;INTERVAL=0", "request").is_err());
        assert!(validate_recurrence_rule("RRULE:FREQ=DAILY", "request").is_err());
        assert!(validate_recurrence_rule("FREQ=DAILY;FREQ=WEEKLY", "request").is_err());
    }

    #[test]
    fn kanban_projection_extracts_only_active_assigned_cards() {
        let assignee = Uuid::now_v7();
        let content = serde_json::json!({
            "columns": [{
                "id": "todo",
                "cards": [
                    {
                        "id": "active",
                        "title": "Ship calendar projection",
                        "description": "Visible to the assignee",
                        "assignees": [assignee.to_string()],
                        "startDate": "2026-07-24",
                        "dueDate": "2026-07-25",
                        "isDone": true,
                        "completedAt": 1784916000000_i64,
                        "recurrence": {
                            "enabled": true,
                            "mode": "weekly",
                            "interval": 2,
                            "weekdays": [1, 4]
                        }
                    },
                    {
                        "id": "unassigned",
                        "title": "Private board detail",
                        "assignees": []
                    },
                    {
                        "id": "archived",
                        "title": "Archived detail",
                        "assignees": [assignee.to_string()],
                        "archived": true
                    }
                ]
            }]
        })
        .to_string();

        let cards = projected_kanban_cards(&content, "2026-07-24T10:00:00Z").unwrap();

        assert_eq!(cards.len(), 1);
        assert_eq!(cards[0].card_id, "active");
        assert_eq!(cards[0].assignees, vec![assignee]);
        assert_eq!(cards[0].start_date.as_deref(), Some("2026-07-24"));
        assert_eq!(cards[0].due_date.as_deref(), Some("2026-07-25"));
        assert!(cards[0].completed);
        assert!(cards[0].completed_at.is_some());
        assert_eq!(
            cards[0]
                .recurrence
                .as_ref()
                .and_then(|value| value["rrule"].as_str()),
            Some("FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,TH")
        );
    }

    #[tokio::test]
    async fn hosted_kanban_projection_reconciles_assignments_and_access_loss() {
        let Ok(url) = std::env::var("COLLAB_TEST_DATABASE_URL") else {
            return;
        };
        let _db_guard = database::db_test_guard().lock().await;
        let pool = PgPoolOptions::new()
            .max_connections(5)
            .connect(&url)
            .await
            .unwrap();
        database::migrate(&pool).await.unwrap();
        sqlx::query("TRUNCATE users RESTART IDENTITY CASCADE")
            .execute(&pool)
            .await
            .unwrap();
        let owner = Uuid::now_v7();
        let assignee = Uuid::now_v7();
        for (id, username) in [
            (owner, "projection-owner"),
            (assignee, "projection-assignee"),
        ] {
            sqlx::query(
                "INSERT INTO users (id,username,normalized_username,display_name) VALUES ($1,$2,$2,$2)",
            )
            .bind(id)
            .bind(username)
            .execute(&pool)
            .await
            .unwrap();
        }
        let vault_id = Uuid::now_v7();
        let file_id = Uuid::now_v7();
        sqlx::query("INSERT INTO hosted_vaults (id,name,owner_user_id) VALUES ($1,'Project',$2)")
            .bind(vault_id)
            .bind(owner)
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query(
            "INSERT INTO hosted_vault_memberships (vault_id,user_id,role) VALUES ($1,$2,'editor')",
        )
        .bind(vault_id)
        .bind(assignee)
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query(
            r#"INSERT INTO hosted_file_entries
               (id,vault_id,name,normalized_name,kind,document_type,created_by)
               VALUES ($1,$2,'Board.kanban','board.kanban','document','kanban',$3)"#,
        )
        .bind(file_id)
        .bind(vault_id)
        .bind(owner)
        .execute(&pool)
        .await
        .unwrap();
        let board = serde_json::json!({
            "columns": [{
                "id": "todo",
                "cards": [{
                    "id": "card-1",
                    "title": "Assigned from Kanban",
                    "assignees": [assignee.to_string()],
                    "dueDate": "2026-07-25"
                }]
            }]
        })
        .to_string();
        let mut tx = pool.begin().await.unwrap();
        project_kanban_assignments(&mut tx, vault_id, file_id, 1, &board)
            .await
            .unwrap();
        tx.commit().await.unwrap();

        let calendar_payload: Value =
            sqlx::query_scalar("SELECT payload FROM calendars WHERE owner_id=$1")
                .bind(assignee)
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(
            calendar_payload.pointer("/location/kind"),
            Some(&Value::String("kanban".into()))
        );
        let item_payload: Value =
            sqlx::query_scalar("SELECT payload FROM calendar_items WHERE owner_id=$1")
                .bind(assignee)
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(
            item_payload.pointer("/sourceBinding/sourceRevision"),
            Some(&Value::Number(1.into()))
        );

        let archived = board.replace(
            r#""dueDate":"2026-07-25""#,
            r#""dueDate":"2026-07-25","archived":true"#,
        );
        let mut tx = pool.begin().await.unwrap();
        project_kanban_assignments(&mut tx, vault_id, file_id, 2, &archived)
            .await
            .unwrap();
        tx.commit().await.unwrap();
        let active_items: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM calendar_items WHERE owner_id=$1 AND deleted_at IS NULL",
        )
        .bind(assignee)
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(active_items, 0);

        let mut tx = pool.begin().await.unwrap();
        project_kanban_assignments(&mut tx, vault_id, file_id, 3, &board)
            .await
            .unwrap();
        let unassigned = board.replace(
            &format!(r#""assignees":["{assignee}"]"#),
            r#""assignees":[] "#,
        );
        project_kanban_assignments(&mut tx, vault_id, file_id, 4, &unassigned)
            .await
            .unwrap();
        let remaining_projections: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM kanban_calendar_projections WHERE owner_id=$1 AND vault_id=$2",
        )
        .bind(assignee)
        .bind(vault_id)
        .fetch_one(&mut *tx)
        .await
        .unwrap();
        assert_eq!(remaining_projections, 0);
        sqlx::query("DELETE FROM hosted_vault_memberships WHERE vault_id=$1 AND user_id=$2")
            .bind(vault_id)
            .bind(assignee)
            .execute(&mut *tx)
            .await
            .unwrap();
        remove_kanban_access_projections(&mut tx, vault_id, assignee)
            .await
            .unwrap();
        tx.commit().await.unwrap();
        let leaked_payloads: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM calendar_change_log WHERE owner_id=$1 AND payload IS NOT NULL",
        )
        .bind(assignee)
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(leaked_payloads, 0);
        let visible_generated_calendars: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM calendars WHERE owner_id=$1 AND deleted_at IS NULL",
        )
        .bind(assignee)
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(visible_generated_calendars, 0);
    }

    #[tokio::test]
    async fn hosted_calendar_domain_enforces_privacy_invitations_attachments_and_quota() {
        let Ok(url) = std::env::var("COLLAB_TEST_DATABASE_URL") else {
            return;
        };
        let _db_guard = database::db_test_guard().lock().await;
        let pool = PgPoolOptions::new()
            .max_connections(5)
            .connect(&url)
            .await
            .unwrap();
        database::migrate(&pool).await.unwrap();
        sqlx::query("TRUNCATE users RESTART IDENTITY CASCADE")
            .execute(&pool)
            .await
            .unwrap();
        let (organizer_id, organizer_token) =
            insert_user_with_native_session(&pool, "organizer").await;
        let (attendee_id, attendee_token) =
            insert_user_with_native_session(&pool, "attendee").await;
        let (_outsider_id, outsider_token) =
            insert_user_with_native_session(&pool, "outsider").await;
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
        let calendar_id = Uuid::now_v7();
        let calendar = json!({
            "schemaVersion": 1,
            "id": calendar_id,
            "globalId": Uuid::now_v7(),
            "location": {"kind":"hosted","serverUrl":"https://calendar.test","userId":organizer_id},
            "name": "Private work",
            "color": "#7c3aed",
            "defaultTimeZone": "Europe/Berlin",
            "archived": false,
            "readOnly": false,
            "revision": 0,
            "createdAt": "2026-07-22T08:00:00Z",
            "updatedAt": "2026-07-22T08:00:00Z"
        });
        let created = bearer_request(
            &app,
            "POST",
            "/api/v1/calendars",
            calendar.clone(),
            &organizer_token,
        )
        .await;
        assert_eq!(created.status(), StatusCode::CREATED);

        let guessed = bearer_request(
            &app,
            "GET",
            &format!("/api/v1/calendars/{calendar_id}"),
            json!({}),
            &attendee_token,
        )
        .await;
        assert_eq!(guessed.status(), StatusCode::NOT_FOUND);

        let uploaded = bearer_request(
            &app,
            "POST",
            &format!("/api/v1/calendars/{calendar_id}/attachments"),
            json!({"name":"agenda.txt","mediaType":"text/plain","contentBase64":"aGVsbG8="}),
            &organizer_token,
        )
        .await;
        assert_eq!(uploaded.status(), StatusCode::CREATED);
        let attachment_id = json_body(uploaded).await["data"]["id"]
            .as_str()
            .unwrap()
            .to_owned();

        let item_id = Uuid::now_v7();
        let operation = json!({
            "operations": [{
                "clientOperationId": "calendar-test-create-event",
                "deviceId": "calendar-test",
                "expectedRevision": 0,
                "mutation": {
                    "type": "upsertItem",
                    "item": {
                        "id": item_id,
                        "uid": "private-event@calendar.test",
                        "calendarId": calendar_id,
                        "kind": "event",
                        "title": "Private planning",
                        "description": "This content must never appear in admin metrics.",
                        "reminders": [],
                        "attendees": [{
                            "kind":"collabUser","id":"attendee-1",
                            "serverUrl":"https://calendar.test","userId":attendee_id,
                            "displayName":"Attendee","response":"needs-action","role":"required"
                        }],
                        "attachments": [{
                            "kind":"uploaded","id":"upload-1","name":"agenda.txt",
                            "attachmentId":attachment_id,"contentType":"text/plain","sizeBytes":5
                        }],
                        "start":{"kind":"dateTime","dateTime":"2026-07-23T08:00:00Z","timeZone":"Europe/Berlin"},
                        "end":{"kind":"dateTime","dateTime":"2026-07-23T09:00:00Z","timeZone":"Europe/Berlin"},
                        "availability":"busy",
                        "revision":0,
                        "createdAt":"2026-07-22T08:00:00Z",
                        "updatedAt":"2026-07-22T08:00:00Z"
                    }
                }
            }]
        });
        let applied = bearer_request(
            &app,
            "POST",
            "/api/v1/calendars/operations",
            operation.clone(),
            &organizer_token,
        )
        .await;
        assert_eq!(
            applied.status(),
            StatusCode::OK,
            "{}",
            json_body(applied).await
        );
        let mut cross_server_operation = operation.clone();
        cross_server_operation["operations"][0]["clientOperationId"] =
            json!("calendar-test-cross-server");
        cross_server_operation["operations"][0]["mutation"]["item"]["id"] = json!(Uuid::now_v7());
        cross_server_operation["operations"][0]["mutation"]["item"]["uid"] =
            json!("cross-server@calendar.test");
        cross_server_operation["operations"][0]["mutation"]["item"]["attendees"][0]["serverUrl"] =
            json!("https://other-calendar.test");
        let rejected_cross_server = bearer_request(
            &app,
            "POST",
            "/api/v1/calendars/operations",
            cross_server_operation,
            &organizer_token,
        )
        .await;
        assert_eq!(rejected_cross_server.status(), StatusCode::BAD_REQUEST);
        let replayed = bearer_request(
            &app,
            "POST",
            "/api/v1/calendars/operations",
            operation,
            &organizer_token,
        )
        .await;
        assert_eq!(replayed.status(), StatusCode::OK);
        assert_eq!(
            sqlx::query_scalar::<_, i64>(
                "SELECT COUNT(*) FROM calendar_client_operations WHERE owner_id=$1",
            )
            .bind(organizer_id)
            .fetch_one(&pool)
            .await
            .unwrap(),
            1
        );

        let published = bearer_request(
            &app,
            "POST",
            &format!("/api/v1/calendars/{calendar_id}/published-feeds"),
            json!({}),
            &organizer_token,
        )
        .await;
        assert_eq!(published.status(), StatusCode::CREATED);
        let published_body = json_body(published).await;
        let feed_id = published_body["data"]["id"].as_str().unwrap().to_owned();
        let feed_path = published_body["data"]["feedPath"]
            .as_str()
            .unwrap()
            .to_owned();
        assert!(!feed_path.contains(&feed_id));
        let feed_response = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri(&feed_path)
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(feed_response.status(), StatusCode::OK);
        assert_eq!(
            feed_response.headers()[header::CONTENT_TYPE],
            "text/calendar; charset=utf-8"
        );
        let etag = feed_response.headers()[header::ETAG].clone();
        let feed_bytes = feed_response
            .into_body()
            .collect()
            .await
            .unwrap()
            .to_bytes();
        let feed_text = String::from_utf8(feed_bytes.to_vec()).unwrap();
        assert!(feed_text.contains("BEGIN:VCALENDAR\r\n"));
        assert!(feed_text.contains("SUMMARY:Private planning\r\n"));
        assert!(!feed_text.contains("access-token"));
        let unchanged_feed = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri(&feed_path)
                    .header(header::IF_NONE_MATCH, etag.clone())
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(unchanged_feed.status(), StatusCode::NOT_MODIFIED);
        assert_eq!(unchanged_feed.headers()[header::ETAG], etag);
        let outsider_feeds = bearer_request(
            &app,
            "GET",
            &format!("/api/v1/calendars/{calendar_id}/published-feeds"),
            json!({}),
            &outsider_token,
        )
        .await;
        assert_eq!(outsider_feeds.status(), StatusCode::NOT_FOUND);
        let revoked = bearer_request(
            &app,
            "DELETE",
            &format!("/api/v1/calendars/{calendar_id}/published-feeds/{feed_id}"),
            json!({}),
            &organizer_token,
        )
        .await;
        assert_eq!(revoked.status(), StatusCode::NO_CONTENT);
        let revoked_feed = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri(&feed_path)
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(revoked_feed.status(), StatusCode::NOT_FOUND);

        let invitations = bearer_request(
            &app,
            "GET",
            "/api/v1/calendars/invitations",
            json!({}),
            &attendee_token,
        )
        .await;
        assert_eq!(invitations.status(), StatusCode::OK);
        let invitation_id = json_body(invitations).await["data"][0]["id"]
            .as_str()
            .unwrap()
            .to_owned();
        let outsider_invitations = bearer_request(
            &app,
            "GET",
            "/api/v1/calendars/invitations",
            json!({}),
            &outsider_token,
        )
        .await;
        assert_eq!(json_body(outsider_invitations).await["data"], json!([]));

        let attendee_download = bearer_request(
            &app,
            "GET",
            &format!("/api/v1/calendars/attachments/{attachment_id}"),
            json!({}),
            &attendee_token,
        )
        .await;
        assert_eq!(attendee_download.status(), StatusCode::OK);
        let outsider_download = bearer_request(
            &app,
            "GET",
            &format!("/api/v1/calendars/attachments/{attachment_id}"),
            json!({}),
            &outsider_token,
        )
        .await;
        assert_eq!(outsider_download.status(), StatusCode::NOT_FOUND);

        let responded = bearer_request(
            &app,
            "POST",
            &format!("/api/v1/calendars/invitations/{invitation_id}/response"),
            json!({"response":"accepted"}),
            &attendee_token,
        )
        .await;
        assert_eq!(responded.status(), StatusCode::OK);
        let response = sqlx::query_scalar::<_, String>(
            "SELECT response FROM calendar_attendees WHERE item_id=$1 AND attendee_id='attendee-1'",
        )
        .bind(item_id)
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(response, "accepted");

        sqlx::query("UPDATE users SET role='admin' WHERE id=$1")
            .bind(organizer_id)
            .execute(&pool)
            .await
            .unwrap();
        let browser_token = "calendar-admin-browser-token";
        sqlx::query(
            "INSERT INTO sessions (id,user_id,token_hash,csrf_hash,expires_at) VALUES ($1,$2,$3,'calendar-csrf',now()+interval '1 hour')",
        )
        .bind(Uuid::now_v7())
        .bind(organizer_id)
        .bind(hash_secret(browser_token))
        .execute(&pool)
        .await
        .unwrap();
        let overview = cookie_request(
            &app,
            "/api/v1/admin/overview",
            &format!("collab_session={browser_token}"),
        )
        .await;
        assert_eq!(overview.status(), StatusCode::OK);
        let overview_body = json_body(overview).await;
        assert_eq!(overview_body["data"]["calendarUsage"]["calendars"], 1);
        let serialized_overview = overview_body.to_string();
        assert!(!serialized_overview.contains("Private work"));
        assert!(!serialized_overview.contains("Private planning"));
        assert!(!serialized_overview.contains("This content must never appear"));

        let deleted = bearer_request(
            &app,
            "POST",
            "/api/v1/calendars/operations",
            json!({"operations":[{
                "clientOperationId":"calendar-test-delete-event",
                "deviceId":"calendar-test",
                "expectedRevision":1,
                "mutation":{
                    "type":"deleteItem","calendarId":calendar_id,"itemId":item_id,
                    "deletedAt":"2026-07-22T12:00:00Z"
                }
            }]}),
            &organizer_token,
        )
        .await;
        assert_eq!(deleted.status(), StatusCode::OK);
        let invitations_after_delete = bearer_request(
            &app,
            "GET",
            "/api/v1/calendars/invitations",
            json!({}),
            &attendee_token,
        )
        .await;
        assert_eq!(json_body(invitations_after_delete).await["data"], json!([]));
        let revoked_download = bearer_request(
            &app,
            "GET",
            &format!("/api/v1/calendars/attachments/{attachment_id}"),
            json!({}),
            &attendee_token,
        )
        .await;
        assert_eq!(revoked_download.status(), StatusCode::NOT_FOUND);
        let removed_upload = bearer_request(
            &app,
            "DELETE",
            &format!("/api/v1/calendars/attachments/{attachment_id}"),
            json!({}),
            &organizer_token,
        )
        .await;
        assert_eq!(removed_upload.status(), StatusCode::NO_CONTENT);

        let mut quota_config = ServerConfig::default();
        quota_config.calendar_quota_bytes = 1;
        let quota_app = build_router(AppState::new(quota_config, pool.clone(), blobs));
        let mut second_calendar = calendar;
        second_calendar["id"] = json!(Uuid::now_v7());
        second_calendar["globalId"] = json!(Uuid::now_v7());
        let quota_failure = bearer_request(
            &quota_app,
            "POST",
            "/api/v1/calendars",
            second_calendar,
            &organizer_token,
        )
        .await;
        let quota_status = quota_failure.status();
        let quota_body = json_body(quota_failure).await;
        assert_eq!(quota_status, StatusCode::PAYLOAD_TOO_LARGE, "{quota_body}");
        assert_eq!(quota_body["error"]["code"], "quota_exceeded");

        let subscription_id = Uuid::now_v7();
        sqlx::query(
            r#"INSERT INTO calendar_subscriptions
               (id,owner_id,calendar_id,feed_url,last_refreshed_at)
               VALUES ($1,$2,$3,'https://calendar.example.test/feed.ics',now())"#,
        )
        .bind(subscription_id)
        .bind(organizer_id)
        .bind(calendar_id)
        .execute(&pool)
        .await
        .unwrap();
        let subscriptions = bearer_request(
            &app,
            "GET",
            "/api/v1/calendars/subscriptions",
            json!({}),
            &organizer_token,
        )
        .await;
        assert_eq!(subscriptions.status(), StatusCode::OK);
        assert_eq!(
            json_body(subscriptions).await["data"][0]["id"],
            subscription_id.to_string()
        );
        let outsider_subscriptions = bearer_request(
            &app,
            "GET",
            "/api/v1/calendars/subscriptions",
            json!({}),
            &outsider_token,
        )
        .await;
        assert_eq!(json_body(outsider_subscriptions).await["data"], json!([]));
        let deleted_subscription = bearer_request(
            &app,
            "DELETE",
            &format!("/api/v1/calendars/subscriptions/{subscription_id}"),
            json!({}),
            &organizer_token,
        )
        .await;
        assert_eq!(deleted_subscription.status(), StatusCode::NO_CONTENT);
        assert_eq!(
            sqlx::query_scalar::<_, i64>(
                "SELECT COUNT(*) FROM calendar_subscriptions WHERE id=$1",
            )
            .bind(subscription_id)
            .fetch_one(&pool)
            .await
            .unwrap(),
            0
        );
    }
}
