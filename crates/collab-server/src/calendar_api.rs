use crate::{
    app::AppState,
    auth::{authenticate_native_access_token, AuthenticatedUser},
};
use axum::{
    extract::{Extension, Path, Query, State},
    http::{header, HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use chrono::{DateTime, NaiveDate, Utc};
use collab_calendar::{
    CalendarDefinition, CalendarItem, CalendarMutation, CalendarOperation, CalendarTimeValue,
};
use collab_protocol::{ApiError, DataResponse, ErrorCode, ErrorResponse};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sqlx::{Postgres, Row, Transaction};
use uuid::Uuid;

const MAX_QUERY_ITEMS: i64 = 5_000;
const MAX_CHANGE_ITEMS: i64 = 1_000;
const MAX_OPERATION_ITEMS: usize = 500;

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

    fn authentication(request_id: &str) -> Self {
        Self::new(
            StatusCode::UNAUTHORIZED,
            ErrorCode::AuthenticationRequired,
            "Connect to the Collab server before accessing calendars.",
            request_id,
        )
    }

    fn validation(message: impl Into<String>, request_id: &str) -> Self {
        Self::new(
            StatusCode::BAD_REQUEST,
            ErrorCode::ValidationFailed,
            message,
            request_id,
        )
    }

    fn not_found(request_id: &str) -> Self {
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

    fn server(request_id: &str) -> Self {
        Self::new(
            StatusCode::INTERNAL_SERVER_ERROR,
            ErrorCode::ServerUnavailable,
            "The calendar request could not be completed.",
            request_id,
        )
    }
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

async fn require_native_user(
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

fn owner_id(user: &AuthenticatedUser, request_id: &str) -> Result<Uuid, CalendarApiError> {
    Uuid::parse_str(&user.user.id).map_err(|_| CalendarApiError::server(request_id))
}

fn parse_uuid(value: &str, label: &str, request_id: &str) -> Result<Uuid, CalendarApiError> {
    Uuid::parse_str(value)
        .map_err(|_| CalendarApiError::validation(format!("{label} must be a UUID."), request_id))
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
    let mut tx = state
        .database
        .begin()
        .await
        .map_err(|_| CalendarApiError::server(&request_id))?;
    sqlx::query(
        r#"INSERT INTO calendars
           (id, owner_id, global_id, name, color, default_time_zone, archived, read_only, revision, payload)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,1,$9)"#,
    )
    .bind(id).bind(owner).bind(global_id).bind(&canonical.name).bind(&canonical.color)
    .bind(&canonical.default_time_zone).bind(canonical.archived).bind(canonical.read_only).bind(&payload)
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
        "SELECT revision, created_at FROM calendars WHERE owner_id = $1 AND id = $2 AND deleted_at IS NULL",
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
    let mut tx = state
        .database
        .begin()
        .await
        .map_err(|_| CalendarApiError::server(&request_id))?;
    sqlx::query(
        r#"UPDATE calendars SET name=$1,color=$2,default_time_zone=$3,archived=$4,read_only=$5,
           revision=$6,payload=$7,updated_at=now() WHERE owner_id=$8 AND id=$9"#,
    )
    .bind(&canonical.name)
    .bind(&canonical.color)
    .bind(&canonical.default_time_zone)
    .bind(canonical.archived)
    .bind(canonical.read_only)
    .bind(canonical.revision)
    .bind(&payload)
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
    insert_change(&mut tx, owner, "calendar", calendar_id, "delete", None)
        .await
        .map_err(|_| CalendarApiError::server(&request_id))?;
    tx.commit()
        .await
        .map_err(|_| CalendarApiError::server(&request_id))?;
    Ok(StatusCode::NO_CONTENT)
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

async fn apply_operation(
    tx: &mut Transaction<'_, Postgres>,
    owner: Uuid,
    operation: &CalendarOperation,
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
            let calendar_id = parse_uuid(&item.calendar_id, "Calendar ID", request_id)?;
            let item_id = parse_uuid(&item.id, "Item ID", request_id)?;
            let owns_calendar = sqlx::query_scalar::<_, bool>(
                "SELECT EXISTS(SELECT 1 FROM calendars WHERE owner_id=$1 AND id=$2 AND deleted_at IS NULL AND read_only=FALSE)",
            ).bind(owner).bind(calendar_id).fetch_one(&mut **tx).await
              .map_err(|_| CalendarApiError::server(request_id))?;
            if !owns_calendar {
                return Err(CalendarApiError::not_found(request_id));
            }
            let actual_revision = sqlx::query_scalar::<_, i64>(
                "SELECT revision FROM calendar_items WHERE owner_id=$1 AND id=$2",
            )
            .bind(owner)
            .bind(item_id)
            .fetch_optional(&mut **tx)
            .await
            .map_err(|_| CalendarApiError::server(request_id))?;
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
            let (start_at, end_at, start_date, end_date) = item_range(&canonical);
            sqlx::query(
                r#"INSERT INTO calendar_items
                   (id,owner_id,calendar_id,uid,kind,start_at,end_at,start_date,end_date,recurrence_rule,revision,payload,deleted_at)
                   VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,NULL)
                   ON CONFLICT (id) DO UPDATE SET calendar_id=EXCLUDED.calendar_id,uid=EXCLUDED.uid,
                     kind=EXCLUDED.kind,start_at=EXCLUDED.start_at,end_at=EXCLUDED.end_at,
                     start_date=EXCLUDED.start_date,end_date=EXCLUDED.end_date,
                     recurrence_rule=EXCLUDED.recurrence_rule,revision=EXCLUDED.revision,
                     payload=EXCLUDED.payload,deleted_at=NULL,updated_at=now()"#,
            ).bind(item_id).bind(owner).bind(calendar_id).bind(&canonical.uid)
              .bind(canonical.kind.as_str()).bind(start_at).bind(end_at).bind(start_date).bind(end_date)
              .bind(canonical.recurrence.as_ref().map(|value| value.rrule.as_str()))
              .bind(canonical.revision).bind(&payload).execute(&mut **tx).await
              .map_err(|error| {
                  if error.as_database_error().is_some_and(|value| value.is_unique_violation()) {
                      CalendarApiError::conflict("An item with that UID already exists in the calendar.", request_id)
                  } else { CalendarApiError::server(request_id) }
              })?;
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
        results.push(apply_operation(&mut tx, owner, operation, &request_id).await?);
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
        r#"SELECT payload FROM calendar_items WHERE owner_id=$1 AND ($2 OR deleted_at IS NULL)
           AND (recurrence_rule IS NOT NULL
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
}
