use crate::background::BackgroundServerRegistration;
use crate::state::{AppState, ServerSessionState};
use base64::Engine as _;
use collab_protocol::{NativeSession, ServerUser};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, State};
use tauri_plugin_fs::{FilePath, FsExt, OpenOptions};
use tokio::io::AsyncWriteExt;

use crate::hosted_client::{
    decode_hosted_error, decode_hosted_json_response, decode_session, hosted_request_method,
    server_client, server_request_error, validate_hosted_calendar_path, validate_hosted_vault_path,
    validate_identifier, validate_server_url,
};
use crate::hosted_session::{fresh_session_for, refresh_session_locked};
use crate::server_token_store::{delete_refresh_token, read_refresh_token, store_refresh_token};

#[cfg(mobile)]
const NATIVE_CLIENT_NAME: &str = "Collab Android companion";

#[cfg(not(mobile))]
const NATIVE_CLIENT_NAME: &str = "Collab desktop";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerConnectionStatus {
    pub connected: bool,
    pub server_url: Option<String>,
    pub allow_invalid_certificates: bool,
    pub user: Option<ServerUser>,
    pub access_expires_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerHealthStatus {
    pub ok: bool,
    pub server_url: String,
    pub message: String,
}

async fn authenticate_and_install_session(
    state: &AppState,
    base: &str,
    username: &str,
    password: &str,
    allow_invalid_certificates: bool,
    persist_across_reboots: bool,
) -> Result<ServerConnectionStatus, String> {
    let response = server_client(allow_invalid_certificates)?
        .post(format!("{base}/api/v1/auth/native/login"))
        .json(&serde_json::json!({
            "username": username,
            "password": password,
            "clientName": NATIVE_CLIENT_NAME
        }))
        .send()
        .await
        .map_err(server_request_error)?;
    let session = decode_session(response).await?;
    store_refresh_token(base, &session.refresh_token, persist_across_reboots)?;
    state
        .hosted_sessions()
        .refresh_token_cache
        .write()
        .insert(base.to_string(), session.refresh_token.clone());
    let profile_id = session.user.id.clone();
    let status = status_from_session(base, allow_invalid_certificates, &session);
    state.hosted_sessions().server_sessions.write().insert(
        base.to_string(),
        ServerSessionState {
            server_url: base.to_string(),
            allow_invalid_certificates,
            persist_across_reboots,
            access_token: session.access_token,
            refresh_token: session.refresh_token,
            access_expires_at: session.access_expires_at,
            user: session.user,
        },
    );
    let _ = state
        .background
        .upsert_server(BackgroundServerRegistration {
            server_url: base.to_string(),
            allow_invalid_certificates,
            persist_across_reboots,
            background_sync_enabled: true,
            profile_ids: vec![profile_id],
            updated_at: chrono::Utc::now().to_rfc3339(),
        });
    #[cfg(target_os = "android")]
    let _ = crate::android_jni::refresh_push_registration();
    Ok(status)
}

#[tauri::command]
pub async fn connect_server(
    state: State<'_, AppState>,
    server_url: String,
    username: String,
    password: String,
    allow_invalid_certificates: bool,
    persist_across_reboots: bool,
) -> Result<ServerConnectionStatus, String> {
    let base = validate_server_url(&server_url)?;
    authenticate_and_install_session(
        &state,
        &base,
        &username,
        &password,
        allow_invalid_certificates,
        persist_across_reboots,
    )
    .await
}

#[tauri::command]
pub async fn reauthenticate_server(
    state: State<'_, AppState>,
    server_url: String,
    username: String,
    password: String,
    allow_invalid_certificates: bool,
    persist_across_reboots: bool,
) -> Result<ServerConnectionStatus, String> {
    let base = validate_server_url(&server_url)?;
    let previous = state
        .hosted_sessions()
        .server_sessions
        .read()
        .get(&base)
        .cloned();
    let status = authenticate_and_install_session(
        &state,
        &base,
        &username,
        &password,
        allow_invalid_certificates,
        persist_across_reboots,
    )
    .await?;

    // Authentication succeeded and the replacement token is durable. Revoke a
    // still-valid previous native session without risking loss of the new one.
    if let Some(previous) = previous {
        if let Ok(client) = server_client(previous.allow_invalid_certificates) {
            let _ = client
                .post(format!("{}/api/v1/auth/native/logout", previous.server_url))
                .bearer_auth(&previous.access_token)
                .send()
                .await;
        }
    }
    Ok(status)
}

#[tauri::command]
pub async fn reconnect_server(
    state: State<'_, AppState>,
    server_url: String,
    allow_invalid_certificates: bool,
    persist_across_reboots: bool,
) -> Result<ServerConnectionStatus, String> {
    let base = validate_server_url(&server_url)?;
    let session = refresh_session_locked(
        state.hosted_sessions(),
        &base,
        allow_invalid_certificates,
        persist_across_reboots,
        false,
    )
    .await?;
    let profile_id = session.user.id.clone();
    let status = ServerConnectionStatus {
        connected: true,
        server_url: Some(session.server_url),
        allow_invalid_certificates: session.allow_invalid_certificates,
        user: Some(session.user),
        access_expires_at: Some(session.access_expires_at),
    };
    let _ = state
        .background
        .upsert_server(BackgroundServerRegistration {
            server_url: base,
            allow_invalid_certificates,
            persist_across_reboots,
            background_sync_enabled: true,
            profile_ids: vec![profile_id],
            updated_at: chrono::Utc::now().to_rfc3339(),
        });
    #[cfg(target_os = "android")]
    let _ = crate::android_jni::refresh_push_registration();
    Ok(status)
}

#[tauri::command]
pub async fn disconnect_server(
    state: State<'_, AppState>,
    server_url: String,
) -> Result<(), String> {
    let base = validate_server_url(&server_url)?;
    let notification_root = crate::commands::app_config_dir()?;
    for profile_id in
        crate::notifications::profile_ids(&notification_root).map_err(|error| error.to_string())?
    {
        let store = crate::notifications::NotificationStore::open(&notification_root, &profile_id)
            .await
            .map_err(|error| error.to_string())?;
        store
            .remove_server_scope(&profile_id, &base)
            .await
            .map_err(|error| error.to_string())?;
        #[cfg(target_os = "android")]
        crate::android_jni::schedule_notification_profile(
            &profile_id,
            store
                .next_delivery_at(&profile_id)
                .await
                .map_err(|error| error.to_string())?
                .as_ref()
                .map(chrono::DateTime::to_rfc3339)
                .as_deref(),
        )?;
    }
    // Remove only this server's session, leaving any other connected servers
    // intact (the app can be signed in to several servers at once).
    let session = state
        .hosted_sessions()
        .server_sessions
        .write()
        .remove(&base);
    if let Some(session) = session {
        if let Ok(client) = server_client(session.allow_invalid_certificates) {
            #[cfg(target_os = "android")]
            if let Ok(Some(installation_id)) = crate::android_jni::push_installation_id() {
                let _ = client
                    .delete(format!(
                        "{}/api/v1/notifications/devices",
                        session.server_url
                    ))
                    .bearer_auth(&session.access_token)
                    .json(&serde_json::json!({
                        "installationId": installation_id,
                        "provider": "fcm"
                    }))
                    .send()
                    .await;
            }
            let _ = client
                .post(format!("{}/api/v1/auth/native/logout", session.server_url))
                .bearer_auth(&session.access_token)
                .send()
                .await;
        }
    }
    delete_refresh_token(&base);
    state
        .hosted_sessions()
        .refresh_token_cache
        .write()
        .remove(&base);
    let _ = state.background.remove_server(&base);
    Ok(())
}

/// Whether a refresh token for `server_url` exists in the OS credential store.
/// Used to decide if an automatic startup reconnect should even be attempted, so
/// a stale saved server URL (e.g. left over after a disconnect) does not surface
/// a spurious "could not restore session" error when no credential exists.
#[tauri::command]
pub fn server_has_saved_session(server_url: String) -> Result<bool, String> {
    let base = validate_server_url(&server_url)?;
    Ok(read_refresh_token(&base, true).is_some())
}

/// One status entry per currently connected server (the app may be signed in to
/// several at once). An empty list means no servers are connected.
#[tauri::command]
pub fn server_connection_statuses(state: State<'_, AppState>) -> Vec<ServerConnectionStatus> {
    state
        .hosted_sessions()
        .server_sessions
        .read()
        .values()
        .map(|session| ServerConnectionStatus {
            connected: true,
            server_url: Some(session.server_url.clone()),
            allow_invalid_certificates: session.allow_invalid_certificates,
            user: Some(session.user.clone()),
            access_expires_at: Some(session.access_expires_at.clone()),
        })
        .collect()
}

#[tauri::command]
pub async fn server_health_check(
    server_url: String,
    allow_invalid_certificates: bool,
) -> Result<ServerHealthStatus, String> {
    let base = validate_server_url(&server_url)?;
    let response = server_client(allow_invalid_certificates)?
        .get(format!("{base}/health/live"))
        .send()
        .await
        .map_err(server_request_error)?;
    let status = response.status();
    Ok(ServerHealthStatus {
        ok: status.is_success(),
        server_url: base,
        message: if status.is_success() {
            "The server health endpoint responded successfully.".to_string()
        } else {
            format!("The server health endpoint returned HTTP {status}.")
        },
    })
}

#[tauri::command]
pub async fn hosted_vault_request(
    state: State<'_, AppState>,
    server_url: String,
    method: String,
    path: String,
    body: Option<Value>,
) -> Result<Value, String> {
    let session = fresh_session_for(
        state.hosted_sessions(),
        &server_url,
        "Connect to the Collab server before opening hosted vaults.",
    )
    .await?;
    let method = hosted_request_method(&method)?;
    let path = validate_hosted_vault_path(&path)?;
    let mut request = server_client(session.allow_invalid_certificates)?
        .request(method, format!("{}{}", session.server_url, path))
        .bearer_auth(&session.access_token);
    if let Some(body) = body {
        request = request.json(&body);
    }
    decode_hosted_json_response(request.send().await.map_err(server_request_error)?).await
}

#[tauri::command]
pub async fn hosted_calendar_request(
    state: State<'_, AppState>,
    server_url: String,
    method: String,
    path: String,
    body: Option<Value>,
) -> Result<Value, String> {
    let session = fresh_session_for(
        state.hosted_sessions(),
        &server_url,
        "Connect to the Collab server before synchronizing calendars.",
    )
    .await?;
    let method = hosted_request_method(&method)?;
    let path = validate_hosted_calendar_path(&path)?;
    let mut request = server_client(session.allow_invalid_certificates)?
        .request(method, format!("{}{}", session.server_url, path))
        .bearer_auth(&session.access_token);
    if let Some(body) = body {
        request = request.json(&body);
    }
    decode_hosted_json_response(request.send().await.map_err(server_request_error)?).await
}

/// Exchanges the connected server session for a single-use live-collaboration
/// WebSocket ticket bound to one vault. The bearer token stays in Rust; the
/// webview receives only the opaque ticket plus the `ws(s)://` URL to open. The
/// WebSocket itself authenticates with the ticket, not a bearer token.
#[tauri::command]
pub async fn hosted_ws_ticket(
    state: State<'_, AppState>,
    server_url: String,
    vault_id: String,
) -> Result<Value, String> {
    validate_identifier(&vault_id)?;
    let session = fresh_session_for(
        state.hosted_sessions(),
        &server_url,
        "Connect to the Collab server before starting live collaboration.",
    )
    .await?;
    let response = server_client(session.allow_invalid_certificates)?
        .post(format!("{}/api/v1/auth/ws-ticket", session.server_url))
        .bearer_auth(&session.access_token)
        .json(&serde_json::json!({ "vaultId": vault_id }))
        .send()
        .await
        .map_err(server_request_error)?;
    let data = decode_hosted_json_response(response).await?;
    let ticket = data
        .get("ticket")
        .and_then(Value::as_str)
        .ok_or_else(|| "The server returned an invalid ticket response.".to_string())?;
    let websocket_path = data
        .get("websocketPath")
        .and_then(Value::as_str)
        .ok_or_else(|| "The server returned an invalid ticket response.".to_string())?;
    // Derive the WebSocket origin from the connected HTTP origin.
    let ws_origin = if let Some(rest) = session.server_url.strip_prefix("https://") {
        format!("wss://{rest}")
    } else if let Some(rest) = session.server_url.strip_prefix("http://") {
        format!("ws://{rest}")
    } else {
        return Err("The connected server URL is not valid.".to_string());
    };
    Ok(serde_json::json!({
        "ticket": ticket,
        "websocketUrl": format!("{}{}", ws_origin.trim_end_matches('/'), websocket_path),
        "protocolVersion": data.get("protocolVersion").cloned().unwrap_or(Value::Null),
    }))
}

#[tauri::command]
pub async fn hosted_vault_asset_data_url(
    state: State<'_, AppState>,
    server_url: String,
    vault_id: String,
    file_id: String,
) -> Result<String, String> {
    validate_identifier(&vault_id)?;
    validate_identifier(&file_id)?;
    let session = fresh_session_for(
        state.hosted_sessions(),
        &server_url,
        "Connect to the Collab server before downloading hosted assets.",
    )
    .await?;
    let response = server_client(session.allow_invalid_certificates)?
        .get(format!(
            "{}/api/v1/vaults/{vault_id}/files/{file_id}/content",
            session.server_url,
        ))
        .bearer_auth(&session.access_token)
        .send()
        .await
        .map_err(server_request_error)?;
    if !response.status().is_success() {
        return Err(decode_hosted_error(response).await);
    }
    let media_type = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("application/octet-stream")
        .to_string();
    let bytes = response
        .bytes()
        .await
        .map_err(|_| "The server returned an invalid asset response.".to_string())?;
    Ok(format!(
        "data:{media_type};base64,{}",
        base64::engine::general_purpose::STANDARD.encode(bytes),
    ))
}

#[tauri::command]
pub async fn hosted_vault_upload_file(
    app: AppHandle,
    state: State<'_, AppState>,
    server_url: String,
    vault_id: String,
    parent_id: Option<String>,
    source_path: FilePath,
) -> Result<Value, String> {
    validate_identifier(&vault_id)?;
    if let Some(parent_id) = parent_id.as_deref() {
        validate_identifier(parent_id)?;
    }
    let session = fresh_session_for(
        state.hosted_sessions(),
        &server_url,
        "Connect to the Collab server before uploading hosted assets.",
    )
    .await?;
    let payload = super::files::read_file_for_upload(app, source_path)?;
    let response = server_client(session.allow_invalid_certificates)?
        .post(format!(
            "{}/api/v1/vaults/{vault_id}/uploads",
            session.server_url
        ))
        .bearer_auth(&session.access_token)
        .json(&serde_json::json!({
            "parentId": parent_id,
            "name": payload.name,
            "mediaType": payload.media_type,
            "contentBase64": payload.content_base64,
            "expectedHash": payload.expected_hash,
        }))
        .send()
        .await
        .map_err(server_request_error)?;
    decode_hosted_json_response(response).await
}

#[tauri::command]
pub async fn hosted_vault_download_entry(
    app: AppHandle,
    state: State<'_, AppState>,
    server_url: String,
    vault_id: String,
    file_id: String,
    archive: bool,
    destination_path: FilePath,
) -> Result<(), String> {
    validate_identifier(&vault_id)?;
    validate_identifier(&file_id)?;
    let session = fresh_session_for(
        state.hosted_sessions(),
        &server_url,
        "Connect to the Collab server before downloading hosted files.",
    )
    .await?;
    let suffix = if archive { "archive" } else { "content" };
    let response = server_client(session.allow_invalid_certificates)?
        .get(format!(
            "{}/api/v1/vaults/{vault_id}/files/{file_id}/{suffix}",
            session.server_url,
        ))
        .bearer_auth(&session.access_token)
        .send()
        .await
        .map_err(server_request_error)?;
    if !response.status().is_success() {
        return Err(decode_hosted_error(response).await);
    }
    let mut options = OpenOptions::new();
    options.write(true).create(true).truncate(true);
    let file = app
        .fs()
        .open(destination_path, options)
        .map_err(|_| "Could not create the downloaded file.".to_string())?;
    let mut file = tokio::fs::File::from_std(file);
    let mut response = response;
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| "The server returned an invalid download response.".to_string())?
    {
        file.write_all(&chunk)
            .await
            .map_err(|_| "Could not write the downloaded file.".to_string())?;
    }
    file.flush()
        .await
        .map_err(|_| "Could not finish writing the downloaded file.".to_string())?;
    Ok(())
}

/// Read-only authenticated user directory used when adding hosted vault members.
/// This is the one non-`/vaults` route the native client may reach; the bearer
/// token stays in Rust and only the resolved directory entries reach the webview.
#[tauri::command]
pub async fn hosted_user_directory(
    state: State<'_, AppState>,
    server_url: String,
    query: String,
) -> Result<Value, String> {
    let session = fresh_session_for(
        state.hosted_sessions(),
        &server_url,
        "Connect to the Collab server before browsing users.",
    )
    .await?;
    let request = server_client(session.allow_invalid_certificates)?
        .get(format!("{}/api/v1/users/directory", session.server_url))
        .query(&[("q", query.as_str())])
        .bearer_auth(&session.access_token);
    decode_hosted_json_response(request.send().await.map_err(server_request_error)?).await
}

/// Download an admin-only hosted-vault ZIP export and write it to a local path.
/// The bearer token stays in Rust; only the success/failure result reaches the
/// webview. Server authorization (vault admin) is enforced server-side.
#[tauri::command]
pub async fn hosted_vault_export_zip(
    app: AppHandle,
    state: State<'_, AppState>,
    server_url: String,
    vault_id: String,
    destination_path: FilePath,
) -> Result<(), String> {
    validate_identifier(&vault_id)?;
    let session = fresh_session_for(
        state.hosted_sessions(),
        &server_url,
        "Connect to the Collab server before exporting hosted vaults.",
    )
    .await?;
    let response = server_client(session.allow_invalid_certificates)?
        .get(format!(
            "{}/api/v1/vaults/{vault_id}/export",
            session.server_url,
        ))
        .bearer_auth(&session.access_token)
        .send()
        .await
        .map_err(server_request_error)?;
    if !response.status().is_success() {
        return Err(decode_hosted_error(response).await);
    }
    let mut options = OpenOptions::new();
    options.write(true).create(true).truncate(true);
    let file = app
        .fs()
        .open(destination_path, options)
        .map_err(|_| "Could not write the exported vault archive to disk.".to_string())?;
    let mut file = tokio::fs::File::from_std(file);
    let mut response = response;
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| "The server returned an invalid export response.".to_string())?
    {
        file.write_all(&chunk)
            .await
            .map_err(|_| "Could not write the exported vault archive to disk.".to_string())?;
    }
    file.flush()
        .await
        .map_err(|_| "Could not write the exported vault archive to disk.".to_string())?;
    Ok(())
}

fn status_from_session(
    server_url: &str,
    allow_invalid_certificates: bool,
    session: &NativeSession,
) -> ServerConnectionStatus {
    ServerConnectionStatus {
        connected: true,
        server_url: Some(server_url.to_owned()),
        allow_invalid_certificates,
        user: Some(session.user.clone()),
        access_expires_at: Some(session.access_expires_at.clone()),
    }
}
