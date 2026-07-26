use crate::{
    app::AppState,
    auth::{generate_secret, hash_secret},
    calendar_api::{apply_operation, owner_id, require_native_user, CalendarApiError},
};
use axum::{
    body::Bytes,
    extract::{Extension, OriginalUri, Path, State},
    http::{header, HeaderMap, HeaderValue, Method, StatusCode, Uri},
    response::{IntoResponse, Redirect, Response},
    Json,
};
use base64::{engine::general_purpose::STANDARD, Engine as _};
use chrono::{DateTime, NaiveDate, Utc};
use collab_calendar::{
    export_ics, parse_ics, CalendarDefinition, CalendarItem, CalendarMutation, CalendarOperation,
    CalendarTimeValue,
};
use collab_protocol::DataResponse;
use quick_xml::{events::Event, Reader};
use serde::{Deserialize, Serialize};
use sqlx::{Postgres, Row, Transaction};
use std::collections::{HashMap, HashSet};
use uuid::Uuid;

const MAX_DAV_BODY_BYTES: usize = 5 * 1024 * 1024;
const MAX_DAV_RESOURCES: usize = 5_000;
const MAX_DAV_MULTIGET: usize = 500;
const MAX_DAV_SYNC_CHANGES: i64 = 1_000;
const DAV_HEADER: &str = "1, 3, calendar-access, sync-collection";

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CalDavCredential {
    id: String,
    label: String,
    created_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    last_used_at: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CreatedCalDavCredential {
    #[serde(flatten)]
    credential: CalDavCredential,
    username: String,
    password: String,
    caldav_path: String,
}

#[derive(Debug, Deserialize)]
pub struct CreateCredentialRequest {
    label: String,
}

#[derive(Debug)]
struct DavIdentity {
    owner: Uuid,
    username: String,
    credential_id: Uuid,
}

#[derive(Default, Debug)]
struct DavXmlRequest {
    root: String,
    elements: HashSet<String>,
    hrefs: Vec<String>,
    sync_token: Option<String>,
    time_range: Option<(String, String)>,
}

#[derive(Debug)]
struct DavResource {
    name: String,
    uid: String,
    items: Vec<CalendarItem>,
    ics: String,
    etag: String,
}

enum DavPath {
    Root,
    Principal {
        username: String,
    },
    Home {
        username: String,
    },
    Calendar {
        username: String,
        calendar_id: Uuid,
    },
    Item {
        username: String,
        calendar_id: Uuid,
        resource_name: String,
    },
}

pub async fn well_known_caldav() -> Redirect {
    Redirect::temporary("/caldav/")
}

pub async fn list_credentials(
    State(state): State<AppState>,
    Extension(request_id): Extension<String>,
    headers: HeaderMap,
) -> Result<Json<DataResponse<Vec<CalDavCredential>>>, CalendarApiError> {
    let user = require_native_user(&state, &headers, &request_id).await?;
    let owner = owner_id(&user, &request_id)?;
    let rows = sqlx::query(
        r#"SELECT id,label,created_at,last_used_at
           FROM calendar_caldav_credentials
           WHERE owner_id=$1 AND revoked_at IS NULL
           ORDER BY created_at DESC"#,
    )
    .bind(owner)
    .fetch_all(&state.database)
    .await
    .map_err(|_| CalendarApiError::server(&request_id))?;
    Ok(Json(DataResponse::new(
        rows.into_iter()
            .map(|row| CalDavCredential {
                id: row.get::<Uuid, _>("id").to_string(),
                label: row.get("label"),
                created_at: row.get::<DateTime<Utc>, _>("created_at").to_rfc3339(),
                last_used_at: row
                    .get::<Option<DateTime<Utc>>, _>("last_used_at")
                    .map(|value| value.to_rfc3339()),
            })
            .collect(),
    )))
}

pub async fn create_credential(
    State(state): State<AppState>,
    Extension(request_id): Extension<String>,
    headers: HeaderMap,
    Json(request): Json<CreateCredentialRequest>,
) -> Result<(StatusCode, Json<DataResponse<CreatedCalDavCredential>>), CalendarApiError> {
    let user = require_native_user(&state, &headers, &request_id).await?;
    let owner = owner_id(&user, &request_id)?;
    let label = request.label.trim();
    if label.is_empty() || label.chars().count() > 80 {
        return Err(CalendarApiError::validation(
            "CalDAV credential labels must contain between 1 and 80 characters.",
            &request_id,
        ));
    }
    let id = Uuid::now_v7();
    let password = format!("{id}.{}", generate_secret());
    let created_at = sqlx::query_scalar::<_, DateTime<Utc>>(
        r#"INSERT INTO calendar_caldav_credentials (id,owner_id,label,secret_hash)
           VALUES ($1,$2,$3,$4) RETURNING created_at"#,
    )
    .bind(id)
    .bind(owner)
    .bind(label)
    .bind(hash_secret(&password))
    .fetch_one(&state.database)
    .await
    .map_err(|_| CalendarApiError::server(&request_id))?;
    Ok((
        StatusCode::CREATED,
        Json(DataResponse::new(CreatedCalDavCredential {
            credential: CalDavCredential {
                id: id.to_string(),
                label: label.to_owned(),
                created_at: created_at.to_rfc3339(),
                last_used_at: None,
            },
            username: user.user.username.clone(),
            password,
            caldav_path: "/caldav/".into(),
        })),
    ))
}

pub async fn revoke_credential(
    State(state): State<AppState>,
    Extension(request_id): Extension<String>,
    headers: HeaderMap,
    Path(credential_id): Path<Uuid>,
) -> Result<StatusCode, CalendarApiError> {
    let user = require_native_user(&state, &headers, &request_id).await?;
    let owner = owner_id(&user, &request_id)?;
    let result = sqlx::query(
        r#"UPDATE calendar_caldav_credentials SET revoked_at=now()
           WHERE id=$1 AND owner_id=$2 AND revoked_at IS NULL"#,
    )
    .bind(credential_id)
    .bind(owner)
    .execute(&state.database)
    .await
    .map_err(|_| CalendarApiError::server(&request_id))?;
    if result.rows_affected() == 0 {
        return Err(CalendarApiError::not_found(&request_id));
    }
    Ok(StatusCode::NO_CONTENT)
}

pub async fn handle_caldav(
    State(state): State<AppState>,
    Extension(request_id): Extension<String>,
    OriginalUri(uri): OriginalUri,
    method: Method,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    if body.len() > MAX_DAV_BODY_BYTES {
        return dav_error(
            StatusCode::PAYLOAD_TOO_LARGE,
            "calendar-data-too-large",
            "The CalDAV request body exceeds the supported limit.",
        );
    }
    let identity = match authenticate_dav(&state, &headers).await {
        Ok(identity) => identity,
        Err(response) => return response,
    };
    let path = match parse_dav_path(&uri, &identity.username) {
        Ok(path) => path,
        Err(status) => return dav_error(status, "not-found", "The CalDAV resource was not found."),
    };

    match method.as_str() {
        "OPTIONS" => options_response(),
        "PROPFIND" => {
            let request = match parse_xml_request(&body) {
                Ok(request) => request,
                Err(response) => return response,
            };
            propfind(&state, &identity, path, &headers, request).await
        }
        "REPORT" => {
            let request = match parse_xml_request(&body) {
                Ok(request) => request,
                Err(response) => return response,
            };
            report(&state, &identity, path, request).await
        }
        "GET" => get_resource(&state, &identity, path).await,
        "PUT" => put_resource(&state, &identity, path, &headers, &body, &request_id).await,
        "DELETE" => delete_resource(&state, &identity, path, &headers, &request_id).await,
        _ => dav_error(
            StatusCode::METHOD_NOT_ALLOWED,
            "method-not-allowed",
            "This method is not supported by the Collab CalDAV endpoint.",
        ),
    }
}

async fn authenticate_dav(state: &AppState, headers: &HeaderMap) -> Result<DavIdentity, Response> {
    let encoded = headers
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Basic "))
        .ok_or_else(unauthorized)?;
    let decoded = STANDARD
        .decode(encoded)
        .ok()
        .and_then(|bytes| String::from_utf8(bytes).ok())
        .ok_or_else(unauthorized)?;
    let (username, password) = decoded.split_once(':').ok_or_else(unauthorized)?;
    let credential_id = password
        .split_once('.')
        .and_then(|(id, _)| Uuid::parse_str(id).ok())
        .ok_or_else(unauthorized)?;
    let row = sqlx::query(
        r#"SELECT credential.owner_id,user_account.normalized_username
           FROM calendar_caldav_credentials credential
           JOIN users user_account ON user_account.id=credential.owner_id
           WHERE credential.id=$1 AND credential.secret_hash=$2
             AND credential.revoked_at IS NULL AND user_account.status='active'"#,
    )
    .bind(credential_id)
    .bind(hash_secret(password))
    .fetch_optional(&state.database)
    .await
    .map_err(|_| {
        dav_error(
            StatusCode::SERVICE_UNAVAILABLE,
            "server-error",
            "CalDAV is unavailable.",
        )
    })?
    .ok_or_else(unauthorized)?;
    let normalized_username: String = row.get("normalized_username");
    if username.trim().to_lowercase() != normalized_username {
        return Err(unauthorized());
    }
    let owner: Uuid = row.get("owner_id");
    let database = state.database.clone();
    tokio::spawn(async move {
        let _ =
            sqlx::query("UPDATE calendar_caldav_credentials SET last_used_at=now() WHERE id=$1")
                .bind(credential_id)
                .execute(&database)
                .await;
    });
    Ok(DavIdentity {
        owner,
        username: normalized_username,
        credential_id,
    })
}

fn parse_dav_path(uri: &Uri, authenticated_username: &str) -> Result<DavPath, StatusCode> {
    let parts = uri
        .path()
        .trim_matches('/')
        .split('/')
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>();
    let parsed = match parts.as_slice() {
        ["caldav"] | [] => DavPath::Root,
        ["caldav", "principals", username] => DavPath::Principal {
            username: (*username).to_owned(),
        },
        ["caldav", "calendars", username] => DavPath::Home {
            username: (*username).to_owned(),
        },
        ["caldav", "calendars", username, calendar_id] => DavPath::Calendar {
            username: (*username).to_owned(),
            calendar_id: Uuid::parse_str(calendar_id).map_err(|_| StatusCode::NOT_FOUND)?,
        },
        ["caldav", "calendars", username, calendar_id, resource_name] => DavPath::Item {
            username: (*username).to_owned(),
            calendar_id: Uuid::parse_str(calendar_id).map_err(|_| StatusCode::NOT_FOUND)?,
            resource_name: validate_resource_name(resource_name)?,
        },
        _ => return Err(StatusCode::NOT_FOUND),
    };
    let username = match &parsed {
        DavPath::Root => authenticated_username,
        DavPath::Principal { username }
        | DavPath::Home { username }
        | DavPath::Calendar { username, .. }
        | DavPath::Item { username, .. } => username,
    };
    if username != authenticated_username {
        return Err(StatusCode::NOT_FOUND);
    }
    Ok(parsed)
}

fn validate_resource_name(value: &str) -> Result<String, StatusCode> {
    if value.len() > 255
        || !value.ends_with(".ics")
        || !value.chars().all(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '-' | '_' | '.')
        })
    {
        return Err(StatusCode::BAD_REQUEST);
    }
    Ok(value.to_owned())
}

fn unauthorized() -> Response {
    let mut response = dav_error(
        StatusCode::UNAUTHORIZED,
        "authentication-required",
        "Use a revocable Collab CalDAV app password.",
    );
    response.headers_mut().insert(
        header::WWW_AUTHENTICATE,
        HeaderValue::from_static("Basic realm=\"Collab CalDAV\", charset=\"UTF-8\""),
    );
    response
}

fn options_response() -> Response {
    let mut response = StatusCode::NO_CONTENT.into_response();
    response
        .headers_mut()
        .insert("dav", HeaderValue::from_static(DAV_HEADER));
    response.headers_mut().insert(
        header::ALLOW,
        HeaderValue::from_static("OPTIONS, PROPFIND, REPORT, GET, PUT, DELETE"),
    );
    response
        .headers_mut()
        .insert("ms-author-via", HeaderValue::from_static("DAV"));
    response
}

fn dav_error(status: StatusCode, element: &str, message: &str) -> Response {
    let body = format!(
        "<?xml version=\"1.0\" encoding=\"utf-8\"?>\
         <D:error xmlns:D=\"DAV:\" xmlns:C=\"urn:ietf:params:xml:ns:caldav\">\
         <C:{} /><D:responsedescription>{}</D:responsedescription></D:error>",
        xml_escape(element),
        xml_escape(message)
    );
    xml_response(status, body)
}

fn xml_response(status: StatusCode, body: String) -> Response {
    let mut response = (status, body).into_response();
    response.headers_mut().insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("application/xml; charset=utf-8"),
    );
    response
        .headers_mut()
        .insert("dav", HeaderValue::from_static(DAV_HEADER));
    response
}

fn xml_escape(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}

fn local_name(value: &[u8]) -> String {
    let value = value.rsplit(|byte| *byte == b':').next().unwrap_or(value);
    String::from_utf8_lossy(value).to_ascii_lowercase()
}

fn parse_xml_request(body: &[u8]) -> Result<DavXmlRequest, Response> {
    if body.is_empty() {
        return Ok(DavXmlRequest::default());
    }
    let mut reader = Reader::from_reader(body);
    reader.config_mut().trim_text(true);
    let mut output = DavXmlRequest::default();
    let mut current = String::new();
    loop {
        match reader.read_event() {
            Ok(Event::Start(start)) | Ok(Event::Empty(start)) => {
                let name = local_name(start.name().as_ref());
                if output.root.is_empty() {
                    output.root = name.clone();
                }
                output.elements.insert(name.clone());
                if name == "time-range" {
                    let mut start_value = None;
                    let mut end_value = None;
                    for attribute in start.attributes().flatten() {
                        let attribute_name = local_name(attribute.key.as_ref());
                        let value = String::from_utf8_lossy(attribute.value.as_ref()).into_owned();
                        let value = quick_xml::escape::unescape(&value)
                            .map(|value| value.into_owned())
                            .unwrap_or(value);
                        if attribute_name == "start" {
                            start_value = Some(value);
                        } else if attribute_name == "end" {
                            end_value = Some(value);
                        }
                    }
                    if let (Some(start), Some(end)) = (start_value, end_value) {
                        output.time_range = Some((start, end));
                    }
                }
                current = name;
            }
            Ok(Event::Text(text)) => {
                let value = text
                    .decode()
                    .map(|value| value.into_owned())
                    .unwrap_or_default();
                let value = quick_xml::escape::unescape(&value)
                    .map(|value| value.into_owned())
                    .unwrap_or(value);
                if current == "href" && output.hrefs.len() < MAX_DAV_MULTIGET {
                    output.hrefs.push(value);
                } else if current == "sync-token" {
                    output.sync_token = Some(value);
                }
            }
            Ok(Event::End(_)) => current.clear(),
            Ok(Event::Eof) => break,
            Err(_) => {
                return Err(dav_error(
                    StatusCode::BAD_REQUEST,
                    "valid-xml",
                    "The WebDAV XML request body is invalid.",
                ))
            }
            _ => {}
        }
    }
    Ok(output)
}

async fn propfind(
    state: &AppState,
    identity: &DavIdentity,
    path: DavPath,
    headers: &HeaderMap,
    _request: DavXmlRequest,
) -> Response {
    let depth = headers
        .get("depth")
        .and_then(|value| value.to_str().ok())
        .unwrap_or("0");
    let sync_sequence = match latest_sync_sequence(state, identity.owner).await {
        Ok(sequence) => sequence,
        Err(response) => return response,
    };
    let mut responses = Vec::new();
    match path {
        DavPath::Root => responses.push(root_properties(&identity.username)),
        DavPath::Principal { .. } => responses.push(principal_properties(&identity.username)),
        DavPath::Home { .. } => {
            responses.push(home_properties(&identity.username));
            if depth == "1" {
                let calendars = match load_calendars(state, identity.owner).await {
                    Ok(calendars) => calendars,
                    Err(response) => return response,
                };
                responses.extend(calendars.iter().map(|calendar| {
                    calendar_properties(&identity.username, calendar, sync_sequence)
                }));
            }
        }
        DavPath::Calendar { calendar_id, .. } => {
            let calendar = match load_calendar(state, identity.owner, calendar_id).await {
                Ok(calendar) => calendar,
                Err(response) => return response,
            };
            responses.push(calendar_properties(
                &identity.username,
                &calendar,
                sync_sequence,
            ));
            if depth == "1" {
                let resources = match load_resources(state, identity.owner, &calendar).await {
                    Ok(resources) => resources,
                    Err(response) => return response,
                };
                responses.extend(resources.iter().map(|resource| {
                    item_properties(&identity.username, calendar_id, resource, false)
                }));
            }
        }
        DavPath::Item {
            calendar_id,
            resource_name,
            ..
        } => {
            let calendar = match load_calendar(state, identity.owner, calendar_id).await {
                Ok(calendar) => calendar,
                Err(response) => return response,
            };
            let resources = match load_resources(state, identity.owner, &calendar).await {
                Ok(resources) => resources,
                Err(response) => return response,
            };
            let Some(resource) = resources.iter().find(|entry| entry.name == resource_name) else {
                return dav_error(
                    StatusCode::NOT_FOUND,
                    "not-found",
                    "Calendar object not found.",
                );
            };
            responses.push(item_properties(
                &identity.username,
                calendar_id,
                resource,
                false,
            ));
        }
    }
    multistatus(responses, None)
}

fn root_properties(username: &str) -> String {
    property_response(
        "/caldav/",
        &format!(
            "<D:resourcetype><D:collection/></D:resourcetype>\
             <D:current-user-principal><D:href>/caldav/principals/{}/</D:href></D:current-user-principal>\
             <D:principal-URL><D:href>/caldav/principals/{}/</D:href></D:principal-URL>",
            xml_escape(username),
            xml_escape(username)
        ),
    )
}

fn principal_properties(username: &str) -> String {
    property_response(
        &format!("/caldav/principals/{}/", xml_escape(username)),
        &format!(
            "<D:resourcetype><D:principal/></D:resourcetype>\
             <D:displayname>{}</D:displayname>\
             <D:current-user-principal><D:href>/caldav/principals/{}/</D:href></D:current-user-principal>\
             <D:principal-URL><D:href>/caldav/principals/{}/</D:href></D:principal-URL>\
             <C:calendar-home-set><D:href>/caldav/calendars/{}/</D:href></C:calendar-home-set>",
            xml_escape(username),
            xml_escape(username),
            xml_escape(username),
            xml_escape(username)
        ),
    )
}

fn home_properties(username: &str) -> String {
    property_response(
        &format!("/caldav/calendars/{}/", xml_escape(username)),
        "<D:resourcetype><D:collection/></D:resourcetype>",
    )
}

fn calendar_properties(
    username: &str,
    calendar: &CalendarDefinition,
    sync_sequence: i64,
) -> String {
    let token = format!("urn:collab:caldav:sync:{}", sync_sequence.max(0));
    property_response(
        &format!(
            "/caldav/calendars/{}/{}/",
            xml_escape(username),
            xml_escape(&calendar.id)
        ),
        &format!(
            "<D:resourcetype><D:collection/><C:calendar/></D:resourcetype>\
             <D:displayname>{}</D:displayname>\
             <C:calendar-description>{}</C:calendar-description>\
             <C:supported-calendar-component-set><C:comp name=\"VEVENT\"/><C:comp name=\"VTODO\"/></C:supported-calendar-component-set>\
             <D:current-user-privilege-set><D:privilege><D:read/></D:privilege><D:privilege><D:write/></D:privilege></D:current-user-privilege-set>\
             <D:supported-report-set>\
               <D:supported-report><D:report><C:calendar-query/></D:report></D:supported-report>\
               <D:supported-report><D:report><C:calendar-multiget/></D:report></D:supported-report>\
               <D:supported-report><D:report><D:sync-collection/></D:report></D:supported-report>\
             </D:supported-report-set>\
             <D:sync-token>{}</D:sync-token>",
            xml_escape(&calendar.name),
            xml_escape(&calendar.name),
            xml_escape(&token)
        ),
    )
}

fn property_response(href: &str, properties: &str) -> String {
    format!(
        "<D:response><D:href>{}</D:href><D:propstat><D:prop>{}</D:prop>\
         <D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>",
        xml_escape(href),
        properties
    )
}

fn item_properties(
    username: &str,
    calendar_id: Uuid,
    resource: &DavResource,
    include_data: bool,
) -> String {
    let data = if include_data {
        format!(
            "<C:calendar-data>{}</C:calendar-data>",
            xml_escape(&resource.ics)
        )
    } else {
        String::new()
    };
    property_response(
        &format!(
            "/caldav/calendars/{}/{}/{}",
            xml_escape(username),
            calendar_id,
            xml_escape(&resource.name)
        ),
        &format!(
            "<D:getetag>{}</D:getetag><D:getcontenttype>text/calendar; charset=utf-8</D:getcontenttype>{}",
            xml_escape(&resource.etag),
            data
        ),
    )
}

fn deleted_item_response(username: &str, calendar_id: Uuid, resource_name: &str) -> String {
    format!(
        "<D:response><D:href>/caldav/calendars/{}/{}/{}</D:href>\
         <D:status>HTTP/1.1 404 Not Found</D:status></D:response>",
        xml_escape(username),
        calendar_id,
        xml_escape(resource_name)
    )
}

fn multistatus(responses: Vec<String>, sync_token: Option<String>) -> Response {
    let token = sync_token
        .map(|value| format!("<D:sync-token>{}</D:sync-token>", xml_escape(&value)))
        .unwrap_or_default();
    xml_response(
        StatusCode::MULTI_STATUS,
        format!(
            "<?xml version=\"1.0\" encoding=\"utf-8\"?>\
             <D:multistatus xmlns:D=\"DAV:\" xmlns:C=\"urn:ietf:params:xml:ns:caldav\">{}{}</D:multistatus>",
            responses.join(""),
            token
        ),
    )
}

async fn report(
    state: &AppState,
    identity: &DavIdentity,
    path: DavPath,
    request: DavXmlRequest,
) -> Response {
    let DavPath::Calendar { calendar_id, .. } = path else {
        return dav_error(
            StatusCode::FORBIDDEN,
            "supported-report",
            "CalDAV reports must target a calendar collection.",
        );
    };
    let calendar = match load_calendar(state, identity.owner, calendar_id).await {
        Ok(calendar) => calendar,
        Err(response) => return response,
    };
    match request.root.as_str() {
        "calendar-query" => {
            let mut resources = match load_resources(state, identity.owner, &calendar).await {
                Ok(resources) => resources,
                Err(response) => return response,
            };
            if let Some((start, end)) = request.time_range {
                resources.retain(|resource| resource_in_time_range(resource, &start, &end));
            }
            multistatus(
                resources
                    .iter()
                    .map(|resource| {
                        item_properties(
                            &identity.username,
                            calendar_id,
                            resource,
                            request.elements.contains("calendar-data"),
                        )
                    })
                    .collect(),
                None,
            )
        }
        "calendar-multiget" => {
            if request.hrefs.len() >= MAX_DAV_MULTIGET {
                return dav_error(
                    StatusCode::INSUFFICIENT_STORAGE,
                    "number-of-matches-within-limits",
                    "The CalDAV multiget request is too large.",
                );
            }
            let resources = match load_resources(state, identity.owner, &calendar).await {
                Ok(resources) => resources,
                Err(response) => return response,
            };
            let mut responses = Vec::new();
            for href in request.hrefs {
                let name = href.rsplit('/').next().unwrap_or_default();
                if let Some(resource) = resources.iter().find(|entry| entry.name == name) {
                    responses.push(item_properties(
                        &identity.username,
                        calendar_id,
                        resource,
                        request.elements.contains("calendar-data"),
                    ));
                } else if validate_resource_name(name).is_ok() {
                    responses.push(deleted_item_response(&identity.username, calendar_id, name));
                }
            }
            multistatus(responses, None)
        }
        "sync-collection" => sync_collection(state, identity, &calendar, request.sync_token).await,
        _ => dav_error(
            StatusCode::FORBIDDEN,
            "supported-report",
            "This CalDAV report is not supported.",
        ),
    }
}

async fn sync_collection(
    state: &AppState,
    identity: &DavIdentity,
    calendar: &CalendarDefinition,
    token: Option<String>,
) -> Response {
    let calendar_id = match Uuid::parse_str(&calendar.id) {
        Ok(value) => value,
        Err(_) => {
            return dav_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "server-error",
                "Invalid calendar.",
            )
        }
    };
    let latest = match latest_sync_sequence(state, identity.owner).await {
        Ok(sequence) => sequence,
        Err(response) => return response,
    };
    let next_token = format!("urn:collab:caldav:sync:{latest}");
    let cursor = match token
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        None => {
            let resources = match load_resources(state, identity.owner, calendar).await {
                Ok(resources) => resources,
                Err(response) => return response,
            };
            return multistatus(
                resources
                    .iter()
                    .map(|resource| {
                        item_properties(&identity.username, calendar_id, resource, false)
                    })
                    .collect(),
                Some(next_token),
            );
        }
        Some(value) => match value
            .strip_prefix("urn:collab:caldav:sync:")
            .and_then(|value| value.parse::<i64>().ok())
        {
            Some(value) if value >= 0 && value <= latest => value,
            _ => {
                return dav_error(
                    StatusCode::FORBIDDEN,
                    "valid-sync-token",
                    "The supplied synchronization token is invalid.",
                )
            }
        },
    };
    let rows = match sqlx::query(
        r#"SELECT DISTINCT item.uid
           FROM calendar_change_log change
           JOIN calendar_items item
             ON item.owner_id=change.owner_id AND item.id=change.entity_id
           WHERE change.owner_id=$1 AND change.entity_type='item'
             AND change.sequence>$2 AND item.calendar_id=$3
           ORDER BY item.uid LIMIT $4"#,
    )
    .bind(identity.owner)
    .bind(cursor)
    .bind(calendar_id)
    .bind(MAX_DAV_SYNC_CHANGES + 1)
    .fetch_all(&state.database)
    .await
    {
        Ok(rows) => rows,
        Err(_) => {
            return dav_error(
                StatusCode::SERVICE_UNAVAILABLE,
                "server-error",
                "CalDAV sync failed.",
            )
        }
    };
    if rows.len() as i64 > MAX_DAV_SYNC_CHANGES {
        return dav_error(
            StatusCode::INSUFFICIENT_STORAGE,
            "number-of-matches-within-limits",
            "Too many calendar changes were requested at once.",
        );
    }
    let changed_uids = rows
        .iter()
        .map(|row| row.get::<String, _>("uid"))
        .collect::<HashSet<_>>();
    let resources = match load_resources(state, identity.owner, calendar).await {
        Ok(resources) => resources,
        Err(response) => return response,
    };
    let active = resources
        .iter()
        .map(|resource| (resource.uid.clone(), resource))
        .collect::<HashMap<_, _>>();
    let mut responses = Vec::new();
    for uid in changed_uids {
        if let Some(resource) = active.get(&uid) {
            responses.push(item_properties(
                &identity.username,
                calendar_id,
                resource,
                false,
            ));
        } else {
            let name =
                match resource_name_for_uid(state, identity.owner, calendar_id, &uid, true).await {
                    Ok(name) => name,
                    Err(response) => return response,
                };
            responses.push(deleted_item_response(
                &identity.username,
                calendar_id,
                &name,
            ));
        }
    }
    multistatus(responses, Some(next_token))
}

async fn get_resource(state: &AppState, identity: &DavIdentity, path: DavPath) -> Response {
    let DavPath::Item {
        calendar_id,
        resource_name,
        ..
    } = path
    else {
        return dav_error(
            StatusCode::METHOD_NOT_ALLOWED,
            "method-not-allowed",
            "GET requires a calendar object.",
        );
    };
    let calendar = match load_calendar(state, identity.owner, calendar_id).await {
        Ok(calendar) => calendar,
        Err(response) => return response,
    };
    let resources = match load_resources(state, identity.owner, &calendar).await {
        Ok(resources) => resources,
        Err(response) => return response,
    };
    let Some(resource) = resources
        .into_iter()
        .find(|entry| entry.name == resource_name)
    else {
        return dav_error(
            StatusCode::NOT_FOUND,
            "not-found",
            "Calendar object not found.",
        );
    };
    let mut response = (StatusCode::OK, resource.ics).into_response();
    response.headers_mut().insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("text/calendar; charset=utf-8"),
    );
    if let Ok(value) = HeaderValue::from_str(&resource.etag) {
        response.headers_mut().insert(header::ETAG, value);
    }
    response
}

async fn put_resource(
    state: &AppState,
    identity: &DavIdentity,
    path: DavPath,
    headers: &HeaderMap,
    body: &[u8],
    request_id: &str,
) -> Response {
    let DavPath::Item {
        calendar_id,
        resource_name,
        ..
    } = path
    else {
        return dav_error(
            StatusCode::METHOD_NOT_ALLOWED,
            "method-not-allowed",
            "PUT requires a calendar object.",
        );
    };
    let content = match std::str::from_utf8(body) {
        Ok(content) => content,
        Err(_) => {
            return dav_error(
                StatusCode::BAD_REQUEST,
                "valid-calendar-data",
                "Calendar data must be UTF-8.",
            )
        }
    };
    let calendar = match load_calendar(state, identity.owner, calendar_id).await {
        Ok(calendar) if !calendar.read_only && !calendar.archived => calendar,
        Ok(_) => {
            return dav_error(
                StatusCode::FORBIDDEN,
                "read-only",
                "This calendar is read-only.",
            )
        }
        Err(response) => return response,
    };
    let resources = match load_resources(state, identity.owner, &calendar).await {
        Ok(resources) => resources,
        Err(response) => return response,
    };
    let existing_resource = resources.iter().find(|entry| entry.name == resource_name);
    if !preconditions_match(
        headers,
        existing_resource.map(|resource| resource.etag.as_str()),
    ) {
        return dav_error(
            StatusCode::PRECONDITION_FAILED,
            "etag-mismatch",
            "The calendar object changed since it was last read.",
        );
    }
    let parsed = match parse_ics(
        content,
        &calendar,
        &format!("caldav:{}:{resource_name}", identity.credential_id),
        &Utc::now().to_rfc3339(),
    ) {
        Ok(parsed) if parsed.warnings.is_empty() && !parsed.items.is_empty() => parsed,
        Ok(parsed) => {
            return dav_error(
                StatusCode::BAD_REQUEST,
                "valid-calendar-data",
                parsed
                    .warnings
                    .first()
                    .map(String::as_str)
                    .unwrap_or("The calendar object contains no supported items."),
            )
        }
        Err(_) => {
            return dav_error(
                StatusCode::BAD_REQUEST,
                "valid-calendar-data",
                "The iCalendar object is invalid.",
            )
        }
    };
    let uids = parsed
        .items
        .iter()
        .map(|item| item.uid.as_str())
        .collect::<HashSet<_>>();
    if uids.len() != 1 {
        return dav_error(
            StatusCode::BAD_REQUEST,
            "valid-calendar-object-resource",
            "A CalDAV resource must contain exactly one UID.",
        );
    }
    let uid = parsed.items[0].uid.clone();
    let mapped_uid = match sqlx::query_scalar::<_, String>(
        r#"SELECT uid FROM calendar_caldav_resources
           WHERE owner_id=$1 AND calendar_id=$2 AND resource_name=$3"#,
    )
    .bind(identity.owner)
    .bind(calendar_id)
    .bind(&resource_name)
    .fetch_optional(&state.database)
    .await
    {
        Ok(value) => value,
        Err(_) => {
            return dav_error(
                StatusCode::SERVICE_UNAVAILABLE,
                "server-error",
                "Calendar mapping could not be loaded.",
            )
        }
    };
    if mapped_uid.as_deref().is_some_and(|mapped| mapped != uid) {
        return dav_error(
            StatusCode::CONFLICT,
            "no-uid-conflict",
            "A CalDAV resource cannot be reused for a different UID.",
        );
    }
    if let Some(other) = resources
        .iter()
        .find(|entry| entry.uid == uid && entry.name != resource_name)
    {
        return dav_error(
            StatusCode::CONFLICT,
            "no-uid-conflict",
            &format!("UID already belongs to {}.", other.name),
        );
    }
    let existing_rows = match load_uid_items(state, identity.owner, calendar_id, &uid, false).await
    {
        Ok(items) => items,
        Err(response) => return response,
    };
    let mut transaction = match state.database.begin().await {
        Ok(transaction) => transaction,
        Err(_) => {
            return dav_error(
                StatusCode::SERVICE_UNAVAILABLE,
                "server-error",
                "CalDAV write failed.",
            )
        }
    };
    if let Err(response) = apply_caldav_put(
        &mut transaction,
        state,
        identity,
        &calendar,
        &resource_name,
        &uid,
        parsed.items,
        existing_rows,
        request_id,
    )
    .await
    {
        return response;
    }
    if transaction.commit().await.is_err() {
        return dav_error(
            StatusCode::SERVICE_UNAVAILABLE,
            "server-error",
            "CalDAV write failed.",
        );
    }
    let calendar = match load_calendar(state, identity.owner, calendar_id).await {
        Ok(calendar) => calendar,
        Err(response) => return response,
    };
    let resources = match load_resources(state, identity.owner, &calendar).await {
        Ok(resources) => resources,
        Err(response) => return response,
    };
    let Some(resource) = resources.iter().find(|entry| entry.name == resource_name) else {
        return dav_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "server-error",
            "Calendar object was not materialized.",
        );
    };
    let status = if existing_resource.is_some() {
        StatusCode::NO_CONTENT
    } else {
        StatusCode::CREATED
    };
    let mut response = status.into_response();
    if let Ok(value) = HeaderValue::from_str(&resource.etag) {
        response.headers_mut().insert(header::ETAG, value);
    }
    response
}

async fn apply_caldav_put(
    transaction: &mut Transaction<'_, Postgres>,
    state: &AppState,
    identity: &DavIdentity,
    calendar: &CalendarDefinition,
    resource_name: &str,
    uid: &str,
    mut parsed_items: Vec<CalendarItem>,
    existing_items: Vec<CalendarItem>,
    request_id: &str,
) -> Result<(), Response> {
    let calendar_id = Uuid::parse_str(&calendar.id).map_err(|_| {
        dav_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "server-error",
            "Invalid calendar.",
        )
    })?;
    let existing_by_key = existing_items
        .iter()
        .map(|item| (recurrence_key(item.recurrence_id.as_ref()), item))
        .collect::<HashMap<_, _>>();
    let parsed_keys = parsed_items
        .iter()
        .map(|item| recurrence_key(item.recurrence_id.as_ref()))
        .collect::<HashSet<_>>();
    for item in &mut parsed_items {
        let key = recurrence_key(item.recurrence_id.as_ref());
        let existing = existing_by_key.get(&key).copied();
        item.id = existing
            .map(|entry| entry.id.clone())
            .unwrap_or_else(|| Uuid::now_v7().to_string());
    }
    let master_id = parsed_items
        .iter()
        .find(|item| item.recurrence_id.is_none())
        .map(|item| item.id.clone());
    if master_id.is_none() && parsed_items.iter().any(|item| item.recurrence_id.is_some()) {
        return Err(dav_error(
            StatusCode::BAD_REQUEST,
            "valid-calendar-object-resource",
            "Recurrence exceptions must include their master component.",
        ));
    }
    for mut item in parsed_items {
        let key = recurrence_key(item.recurrence_id.as_ref());
        let existing = existing_by_key.get(&key).copied();
        item.calendar_id = calendar.id.clone();
        item.source_binding = None;
        item.deleted_at = None;
        item.revision = existing.map(|entry| entry.revision + 1).unwrap_or(0);
        if item.recurrence_id.is_none() {
            item.recurrence_series_id = None;
        } else {
            item.recurrence_series_id = master_id.clone();
        }
        let operation = CalendarOperation {
            client_operation_id: format!(
                "caldav:{}:{}:{}",
                identity.credential_id, request_id, item.id
            ),
            device_id: format!("caldav:{}", identity.credential_id),
            expected_revision: Some(existing.map(|entry| entry.revision).unwrap_or(0)),
            source_change_id: None,
            propagation_lineage: Vec::new(),
            mutation: CalendarMutation::UpsertItem { item },
        };
        apply_operation(
            transaction,
            identity.owner,
            &operation,
            state.config.calendar_quota_bytes,
            request_id,
        )
        .await
        .map_err(IntoResponse::into_response)?;
    }
    for existing in existing_items {
        if parsed_keys.contains(&recurrence_key(existing.recurrence_id.as_ref())) {
            continue;
        }
        let operation = CalendarOperation {
            client_operation_id: format!(
                "caldav:{}:{}:delete:{}",
                identity.credential_id, request_id, existing.id
            ),
            device_id: format!("caldav:{}", identity.credential_id),
            expected_revision: Some(existing.revision),
            source_change_id: None,
            propagation_lineage: Vec::new(),
            mutation: CalendarMutation::DeleteItem {
                calendar_id: calendar.id.clone(),
                item_id: existing.id,
                deleted_at: Utc::now().to_rfc3339(),
            },
        };
        apply_operation(
            transaction,
            identity.owner,
            &operation,
            state.config.calendar_quota_bytes,
            request_id,
        )
        .await
        .map_err(IntoResponse::into_response)?;
    }
    sqlx::query(
        r#"INSERT INTO calendar_caldav_resources (owner_id,calendar_id,resource_name,uid)
           VALUES ($1,$2,$3,$4)
           ON CONFLICT (owner_id,calendar_id,resource_name)
           DO UPDATE SET uid=EXCLUDED.uid,updated_at=now()"#,
    )
    .bind(identity.owner)
    .bind(calendar_id)
    .bind(resource_name)
    .bind(uid)
    .execute(&mut **transaction)
    .await
    .map_err(|_| {
        dav_error(
            StatusCode::CONFLICT,
            "no-uid-conflict",
            "The calendar resource conflicts with an existing UID.",
        )
    })?;
    Ok(())
}

async fn delete_resource(
    state: &AppState,
    identity: &DavIdentity,
    path: DavPath,
    headers: &HeaderMap,
    request_id: &str,
) -> Response {
    let DavPath::Item {
        calendar_id,
        resource_name,
        ..
    } = path
    else {
        return dav_error(
            StatusCode::METHOD_NOT_ALLOWED,
            "method-not-allowed",
            "DELETE requires a calendar object.",
        );
    };
    let calendar = match load_calendar(state, identity.owner, calendar_id).await {
        Ok(calendar) if !calendar.read_only && !calendar.archived => calendar,
        Ok(_) => {
            return dav_error(
                StatusCode::FORBIDDEN,
                "read-only",
                "This calendar is read-only.",
            )
        }
        Err(response) => return response,
    };
    let resources = match load_resources(state, identity.owner, &calendar).await {
        Ok(resources) => resources,
        Err(response) => return response,
    };
    let Some(resource) = resources.iter().find(|entry| entry.name == resource_name) else {
        return dav_error(
            StatusCode::NOT_FOUND,
            "not-found",
            "Calendar object not found.",
        );
    };
    if !preconditions_match(headers, Some(&resource.etag)) {
        return dav_error(
            StatusCode::PRECONDITION_FAILED,
            "etag-mismatch",
            "The calendar object changed since it was last read.",
        );
    }
    let mut transaction = match state.database.begin().await {
        Ok(transaction) => transaction,
        Err(_) => {
            return dav_error(
                StatusCode::SERVICE_UNAVAILABLE,
                "server-error",
                "CalDAV delete failed.",
            )
        }
    };
    for item in &resource.items {
        let operation = CalendarOperation {
            client_operation_id: format!(
                "caldav:{}:{}:delete:{}",
                identity.credential_id, request_id, item.id
            ),
            device_id: format!("caldav:{}", identity.credential_id),
            expected_revision: Some(item.revision),
            source_change_id: None,
            propagation_lineage: Vec::new(),
            mutation: CalendarMutation::DeleteItem {
                calendar_id: calendar.id.clone(),
                item_id: item.id.clone(),
                deleted_at: Utc::now().to_rfc3339(),
            },
        };
        if let Err(error) = apply_operation(
            &mut transaction,
            identity.owner,
            &operation,
            state.config.calendar_quota_bytes,
            request_id,
        )
        .await
        {
            return error.into_response();
        }
    }
    if transaction.commit().await.is_err() {
        return dav_error(
            StatusCode::SERVICE_UNAVAILABLE,
            "server-error",
            "CalDAV delete failed.",
        );
    }
    StatusCode::NO_CONTENT.into_response()
}

fn preconditions_match(headers: &HeaderMap, current_etag: Option<&str>) -> bool {
    if headers
        .get(header::IF_NONE_MATCH)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| value.trim() == "*")
    {
        return current_etag.is_none();
    }
    match headers
        .get(header::IF_MATCH)
        .and_then(|value| value.to_str().ok())
    {
        Some("*") => current_etag.is_some(),
        Some(value) => current_etag.is_some_and(|etag| {
            value
                .split(',')
                .map(str::trim)
                .any(|candidate| candidate == etag)
        }),
        None => true,
    }
}

async fn load_calendars(
    state: &AppState,
    owner: Uuid,
) -> Result<Vec<CalendarDefinition>, Response> {
    let rows = sqlx::query(
        r#"SELECT payload FROM calendars
           WHERE owner_id=$1 AND deleted_at IS NULL AND read_only=FALSE
           ORDER BY created_at,id LIMIT 501"#,
    )
    .bind(owner)
    .fetch_all(&state.database)
    .await
    .map_err(|_| {
        dav_error(
            StatusCode::SERVICE_UNAVAILABLE,
            "server-error",
            "Calendars could not be loaded.",
        )
    })?;
    if rows.len() > 500 {
        return Err(dav_error(
            StatusCode::INSUFFICIENT_STORAGE,
            "number-of-matches-within-limits",
            "The account has too many calendars for this request.",
        ));
    }
    rows.into_iter()
        .map(|row| {
            serde_json::from_value(row.get("payload")).map_err(|_| {
                dav_error(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "server-error",
                    "Invalid calendar data.",
                )
            })
        })
        .collect()
}

async fn latest_sync_sequence(state: &AppState, owner: Uuid) -> Result<i64, Response> {
    sqlx::query_scalar::<_, Option<i64>>(
        "SELECT MAX(sequence) FROM calendar_change_log WHERE owner_id=$1",
    )
    .bind(owner)
    .fetch_one(&state.database)
    .await
    .map(|value| value.unwrap_or(0))
    .map_err(|_| {
        dav_error(
            StatusCode::SERVICE_UNAVAILABLE,
            "server-error",
            "The calendar synchronization token could not be loaded.",
        )
    })
}

async fn load_calendar(
    state: &AppState,
    owner: Uuid,
    calendar_id: Uuid,
) -> Result<CalendarDefinition, Response> {
    let payload = sqlx::query_scalar::<_, serde_json::Value>(
        r#"SELECT payload FROM calendars
           WHERE owner_id=$1 AND id=$2 AND deleted_at IS NULL AND read_only=FALSE"#,
    )
    .bind(owner)
    .bind(calendar_id)
    .fetch_optional(&state.database)
    .await
    .map_err(|_| {
        dav_error(
            StatusCode::SERVICE_UNAVAILABLE,
            "server-error",
            "Calendar could not be loaded.",
        )
    })?
    .ok_or_else(|| dav_error(StatusCode::NOT_FOUND, "not-found", "Calendar not found."))?;
    serde_json::from_value(payload).map_err(|_| {
        dav_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "server-error",
            "Invalid calendar data.",
        )
    })
}

async fn load_resources(
    state: &AppState,
    owner: Uuid,
    calendar: &CalendarDefinition,
) -> Result<Vec<DavResource>, Response> {
    let calendar_id = Uuid::parse_str(&calendar.id).map_err(|_| {
        dav_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "server-error",
            "Invalid calendar ID.",
        )
    })?;
    let rows = sqlx::query(
        r#"SELECT payload FROM calendar_items
           WHERE owner_id=$1 AND calendar_id=$2 AND deleted_at IS NULL
           ORDER BY uid,recurrence_id NULLS FIRST,id LIMIT $3"#,
    )
    .bind(owner)
    .bind(calendar_id)
    .bind((MAX_DAV_RESOURCES * 20 + 1) as i64)
    .fetch_all(&state.database)
    .await
    .map_err(|_| {
        dav_error(
            StatusCode::SERVICE_UNAVAILABLE,
            "server-error",
            "Calendar objects could not be loaded.",
        )
    })?;
    if rows.len() > MAX_DAV_RESOURCES * 20 {
        return Err(dav_error(
            StatusCode::INSUFFICIENT_STORAGE,
            "number-of-matches-within-limits",
            "The calendar contains too many recurrence resources.",
        ));
    }
    let mappings = sqlx::query(
        "SELECT uid,resource_name FROM calendar_caldav_resources WHERE owner_id=$1 AND calendar_id=$2",
    )
    .bind(owner)
    .bind(calendar_id)
    .fetch_all(&state.database)
    .await
    .map_err(|_| dav_error(StatusCode::SERVICE_UNAVAILABLE, "server-error", "Calendar mappings could not be loaded."))?
    .into_iter()
    .map(|row| (row.get::<String, _>("uid"), row.get::<String, _>("resource_name")))
    .collect::<HashMap<_, _>>();
    let mut grouped: HashMap<String, Vec<CalendarItem>> = HashMap::new();
    for row in rows {
        let item = serde_json::from_value::<CalendarItem>(row.get("payload")).map_err(|_| {
            dav_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "server-error",
                "Invalid calendar item.",
            )
        })?;
        grouped.entry(item.uid.clone()).or_default().push(item);
    }
    if grouped.len() > MAX_DAV_RESOURCES {
        return Err(dav_error(
            StatusCode::INSUFFICIENT_STORAGE,
            "number-of-matches-within-limits",
            "The calendar contains too many objects.",
        ));
    }
    let mut resources = grouped
        .into_iter()
        .map(|(uid, items)| {
            let name = mappings.get(&uid).cloned().unwrap_or_else(|| {
                let item = items
                    .iter()
                    .find(|item| item.recurrence_id.is_none())
                    .unwrap_or(&items[0]);
                format!("{}.ics", item.id)
            });
            let ics = export_ics(calendar, &items);
            let etag = format!("\"{}\"", hash_secret(&ics));
            DavResource {
                name,
                uid,
                items,
                ics,
                etag,
            }
        })
        .collect::<Vec<_>>();
    resources.sort_by(|left, right| left.name.cmp(&right.name));
    Ok(resources)
}

async fn load_uid_items(
    state: &AppState,
    owner: Uuid,
    calendar_id: Uuid,
    uid: &str,
    include_deleted: bool,
) -> Result<Vec<CalendarItem>, Response> {
    let rows = sqlx::query(
        r#"SELECT payload FROM calendar_items
           WHERE owner_id=$1 AND calendar_id=$2 AND uid=$3
             AND ($4 OR deleted_at IS NULL)
           ORDER BY recurrence_id NULLS FIRST,id LIMIT 101"#,
    )
    .bind(owner)
    .bind(calendar_id)
    .bind(uid)
    .bind(include_deleted)
    .fetch_all(&state.database)
    .await
    .map_err(|_| {
        dav_error(
            StatusCode::SERVICE_UNAVAILABLE,
            "server-error",
            "Calendar object could not be loaded.",
        )
    })?;
    if rows.len() > 100 {
        return Err(dav_error(
            StatusCode::INSUFFICIENT_STORAGE,
            "number-of-matches-within-limits",
            "The calendar object has too many recurrence exceptions.",
        ));
    }
    rows.into_iter()
        .map(|row| {
            serde_json::from_value(row.get("payload")).map_err(|_| {
                dav_error(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "server-error",
                    "Invalid calendar item.",
                )
            })
        })
        .collect()
}

async fn resource_name_for_uid(
    state: &AppState,
    owner: Uuid,
    calendar_id: Uuid,
    uid: &str,
    include_deleted: bool,
) -> Result<String, Response> {
    if let Some(name) = sqlx::query_scalar::<_, String>(
        r#"SELECT resource_name FROM calendar_caldav_resources
           WHERE owner_id=$1 AND calendar_id=$2 AND uid=$3"#,
    )
    .bind(owner)
    .bind(calendar_id)
    .bind(uid)
    .fetch_optional(&state.database)
    .await
    .map_err(|_| {
        dav_error(
            StatusCode::SERVICE_UNAVAILABLE,
            "server-error",
            "Calendar mapping could not be loaded.",
        )
    })? {
        return Ok(name);
    }
    let items = load_uid_items(state, owner, calendar_id, uid, include_deleted).await?;
    let item = items
        .iter()
        .find(|item| item.recurrence_id.is_none())
        .or_else(|| items.first())
        .ok_or_else(|| {
            dav_error(
                StatusCode::NOT_FOUND,
                "not-found",
                "Calendar object not found.",
            )
        })?;
    Ok(format!("{}.ics", item.id))
}

fn recurrence_key(value: Option<&CalendarTimeValue>) -> String {
    value
        .and_then(|value| serde_json::to_string(value).ok())
        .unwrap_or_default()
}

fn resource_in_time_range(resource: &DavResource, start: &str, end: &str) -> bool {
    let Some(start) = parse_caldav_timestamp(start) else {
        return true;
    };
    let Some(end) = parse_caldav_timestamp(end) else {
        return true;
    };
    resource.items.iter().any(|item| {
        if item.recurrence.is_some() {
            return true;
        }
        let item_start = item
            .start
            .as_ref()
            .or(item.due.as_ref())
            .and_then(time_value_timestamp)
            .or_else(|| item.date.as_deref().and_then(date_timestamp));
        let item_end = item
            .end
            .as_ref()
            .or(item.due.as_ref())
            .and_then(time_value_timestamp)
            .or_else(|| item.date.as_deref().and_then(date_timestamp))
            .or(item_start);
        item_start.is_some_and(|value| value < end) && item_end.is_some_and(|value| value >= start)
    })
}

fn parse_caldav_timestamp(value: &str) -> Option<DateTime<Utc>> {
    DateTime::parse_from_str(value, "%Y%m%dT%H%M%SZ")
        .ok()
        .map(|value| value.with_timezone(&Utc))
}

fn date_timestamp(value: &str) -> Option<DateTime<Utc>> {
    NaiveDate::parse_from_str(value, "%Y-%m-%d")
        .ok()?
        .and_hms_opt(0, 0, 0)?
        .and_utc()
        .into()
}

fn time_value_timestamp(value: &CalendarTimeValue) -> Option<DateTime<Utc>> {
    match value {
        CalendarTimeValue::DateTime { date_time, .. } => DateTime::parse_from_rfc3339(date_time)
            .ok()
            .map(|value| value.with_timezone(&Utc)),
        CalendarTimeValue::Date { date } => date_timestamp(date),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        app::{build_router, AppState},
        config::ServerConfig,
        database,
        storage::FileSystemBlobStorage,
    };
    use axum::{body::Body, http::Request, Router};
    use http_body_util::BodyExt;
    use serde_json::{json, Value};
    use sqlx::postgres::PgPoolOptions;
    use std::sync::Arc;
    use tower::ServiceExt;

    async fn request(
        app: &Router,
        method: &str,
        uri: &str,
        body: impl Into<Body>,
        authorization: &str,
        content_type: Option<&str>,
        etag_header: Option<(&str, &str)>,
    ) -> Response {
        let mut builder = Request::builder()
            .method(method)
            .uri(uri)
            .header(header::AUTHORIZATION, authorization);
        if let Some(content_type) = content_type {
            builder = builder.header(header::CONTENT_TYPE, content_type);
        }
        if let Some((name, value)) = etag_header {
            builder = builder.header(name, value);
        }
        app.clone()
            .oneshot(builder.body(body.into()).unwrap())
            .await
            .unwrap()
    }

    async fn json_body(response: Response) -> Value {
        let bytes = response.into_body().collect().await.unwrap().to_bytes();
        serde_json::from_slice(&bytes).unwrap()
    }

    #[test]
    fn parses_multiget_and_sync_requests_with_bounded_fields() {
        let multiget = parse_xml_request(
            br#"<?xml version="1.0"?><C:calendar-multiget xmlns:C="urn:ietf:params:xml:ns:caldav" xmlns:D="DAV:"><D:prop><D:getetag/><C:calendar-data/></D:prop><D:href>/caldav/calendars/user/id/event.ics</D:href></C:calendar-multiget>"#,
        )
        .unwrap();
        assert_eq!(multiget.root, "calendar-multiget");
        assert!(multiget.elements.contains("calendar-data"));
        assert_eq!(multiget.hrefs, vec!["/caldav/calendars/user/id/event.ics"]);

        let sync = parse_xml_request(
            br#"<D:sync-collection xmlns:D="DAV:"><D:sync-token>urn:collab:caldav:sync:42</D:sync-token><D:sync-level>1</D:sync-level></D:sync-collection>"#,
        )
        .unwrap();
        assert_eq!(
            sync.sync_token.as_deref(),
            Some("urn:collab:caldav:sync:42")
        );
    }

    #[test]
    fn etag_preconditions_prevent_stale_overwrites() {
        let mut headers = HeaderMap::new();
        headers.insert(header::IF_MATCH, HeaderValue::from_static("\"old\""));
        assert!(!preconditions_match(&headers, Some("\"new\"")));
        headers.insert(header::IF_MATCH, HeaderValue::from_static("\"new\""));
        assert!(preconditions_match(&headers, Some("\"new\"")));
        headers.clear();
        headers.insert(header::IF_NONE_MATCH, HeaderValue::from_static("*"));
        assert!(preconditions_match(&headers, None));
        assert!(!preconditions_match(&headers, Some("\"new\"")));
    }

    #[test]
    fn rejects_unsafe_resource_names_and_cross_user_paths() {
        assert!(validate_resource_name("event.ics").is_ok());
        assert!(validate_resource_name("../event.ics").is_err());
        assert!(parse_dav_path(
            &"/caldav/calendars/other/0198f9c1-5b21-7000-8000-000000000001/"
                .parse()
                .unwrap(),
            "owner"
        )
        .is_err());
    }

    #[tokio::test]
    async fn caldav_writes_share_change_log_etags_and_revocable_credentials() {
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
        let user_id = Uuid::now_v7();
        let native_token = "caldav-native-access";
        sqlx::query(
            "INSERT INTO users (id,username,normalized_username,display_name) VALUES ($1,'caldav-user','caldav-user','CalDAV User')",
        )
        .bind(user_id)
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query(
            r#"INSERT INTO native_sessions
               (id,user_id,access_token_hash,refresh_token_hash,client_name,access_expires_at,refresh_expires_at)
               VALUES ($1,$2,$3,$4,'caldav-test',now()+interval '1 hour',now()+interval '1 day')"#,
        )
        .bind(Uuid::now_v7())
        .bind(user_id)
        .bind(hash_secret(native_token))
        .bind(hash_secret("caldav-native-refresh"))
        .execute(&pool)
        .await
        .unwrap();
        let blobs = Arc::new(
            FileSystemBlobStorage::new(tempfile::tempdir().unwrap().keep())
                .await
                .unwrap(),
        );
        let app = build_router(AppState::new(ServerConfig::default(), pool.clone(), blobs));
        let bearer = format!("Bearer {native_token}");
        let calendar_id = Uuid::now_v7();
        let create_calendar = request(
            &app,
            "POST",
            "/api/v1/calendars",
            json!({
                "schemaVersion":1,
                "id":calendar_id,
                "globalId":Uuid::now_v7(),
                "location":{"kind":"hosted","serverUrl":"https://calendar.test","userId":user_id},
                "name":"DAV Work",
                "color":"#7c3aed",
                "defaultTimeZone":"Europe/Berlin",
                "archived":false,
                "readOnly":false,
                "revision":0,
                "createdAt":"2026-07-26T08:00:00Z",
                "updatedAt":"2026-07-26T08:00:00Z"
            })
            .to_string(),
            &bearer,
            Some("application/json"),
            None,
        )
        .await;
        assert_eq!(create_calendar.status(), StatusCode::CREATED);

        let credential_response = request(
            &app,
            "POST",
            "/api/v1/calendars/caldav-credentials",
            json!({"label":"Thunderbird"}).to_string(),
            &bearer,
            Some("application/json"),
            None,
        )
        .await;
        assert_eq!(credential_response.status(), StatusCode::CREATED);
        let credential = json_body(credential_response).await;
        let credential_id = credential["data"]["id"].as_str().unwrap();
        let password = credential["data"]["password"].as_str().unwrap();
        let basic = format!(
            "Basic {}",
            STANDARD.encode(format!("caldav-user:{password}"))
        );

        let discovery = request(
            &app,
            "PROPFIND",
            "/caldav/",
            r#"<D:propfind xmlns:D="DAV:"><D:prop><D:current-user-principal/></D:prop></D:propfind>"#,
            &basic,
            Some("application/xml"),
            Some(("depth", "0")),
        )
        .await;
        assert_eq!(discovery.status(), StatusCode::MULTI_STATUS);

        let resource_uri =
            format!("/caldav/calendars/caldav-user/{calendar_id}/external-event.ics");
        let first_ics = concat!(
            "BEGIN:VCALENDAR\r\nVERSION:2.0\r\n",
            "BEGIN:VEVENT\r\nUID:external-1@example.test\r\n",
            "SUMMARY:Created outside Collab\r\n",
            "DTSTART:20260727T080000Z\r\nDTEND:20260727T090000Z\r\n",
            "END:VEVENT\r\nEND:VCALENDAR\r\n"
        );
        let created = request(
            &app,
            "PUT",
            &resource_uri,
            first_ics,
            &basic,
            Some("text/calendar"),
            Some(("if-none-match", "*")),
        )
        .await;
        assert_eq!(created.status(), StatusCode::CREATED);
        let etag = created.headers()[header::ETAG].to_str().unwrap().to_owned();

        let stale = request(
            &app,
            "PUT",
            &resource_uri,
            first_ics.replace("Created outside Collab", "Stale overwrite"),
            &basic,
            Some("text/calendar"),
            Some(("if-match", "\"stale\"")),
        )
        .await;
        assert_eq!(stale.status(), StatusCode::PRECONDITION_FAILED);

        let downloaded = request(
            &app,
            "GET",
            &resource_uri,
            Body::empty(),
            &basic,
            None,
            None,
        )
        .await;
        assert_eq!(downloaded.status(), StatusCode::OK);
        assert_eq!(downloaded.headers()[header::ETAG], etag);

        let sync = request(
            &app,
            "REPORT",
            &format!("/caldav/calendars/caldav-user/{calendar_id}/"),
            r#"<D:sync-collection xmlns:D="DAV:"><D:sync-token></D:sync-token><D:sync-level>1</D:sync-level><D:prop><D:getetag/></D:prop></D:sync-collection>"#,
            &basic,
            Some("application/xml"),
            Some(("depth", "0")),
        )
        .await;
        assert_eq!(sync.status(), StatusCode::MULTI_STATUS);
        let sync_body = String::from_utf8(
            sync.into_body()
                .collect()
                .await
                .unwrap()
                .to_bytes()
                .to_vec(),
        )
        .unwrap();
        assert!(sync_body.contains("external-event.ics"));
        assert!(sync_body.contains("urn:collab:caldav:sync:"));
        let sync_token = sync_body
            .split("<D:sync-token>")
            .nth(1)
            .and_then(|value| value.split("</D:sync-token>").next())
            .unwrap()
            .to_owned();

        let deleted = request(
            &app,
            "DELETE",
            &resource_uri,
            Body::empty(),
            &basic,
            None,
            Some(("if-match", &etag)),
        )
        .await;
        assert_eq!(deleted.status(), StatusCode::NO_CONTENT);
        let delta = request(
            &app,
            "REPORT",
            &format!("/caldav/calendars/caldav-user/{calendar_id}/"),
            format!(
                "<D:sync-collection xmlns:D=\"DAV:\"><D:sync-token>{sync_token}</D:sync-token><D:sync-level>1</D:sync-level><D:prop><D:getetag/></D:prop></D:sync-collection>"
            ),
            &basic,
            Some("application/xml"),
            Some(("depth", "0")),
        )
        .await;
        assert_eq!(delta.status(), StatusCode::MULTI_STATUS);
        let delta_body = String::from_utf8(
            delta
                .into_body()
                .collect()
                .await
                .unwrap()
                .to_bytes()
                .to_vec(),
        )
        .unwrap();
        assert!(delta_body.contains("external-event.ics"));
        assert!(delta_body.contains("404 Not Found"));
        let mismatched_uid = request(
            &app,
            "PUT",
            &resource_uri,
            first_ics.replace("external-1@example.test", "different@example.test"),
            &basic,
            Some("text/calendar"),
            Some(("if-none-match", "*")),
        )
        .await;
        assert_eq!(mismatched_uid.status(), StatusCode::CONFLICT);
        let operations: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM calendar_change_log WHERE owner_id=$1 AND entity_type='item'",
        )
        .bind(user_id)
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(operations, 2);

        let revoked = request(
            &app,
            "DELETE",
            &format!("/api/v1/calendars/caldav-credentials/{credential_id}"),
            Body::empty(),
            &bearer,
            None,
            None,
        )
        .await;
        assert_eq!(revoked.status(), StatusCode::NO_CONTENT);
        let after_revoke = request(
            &app,
            "PROPFIND",
            "/caldav/",
            Body::empty(),
            &basic,
            None,
            Some(("depth", "0")),
        )
        .await;
        assert_eq!(after_revoke.status(), StatusCode::UNAUTHORIZED);
    }
}
