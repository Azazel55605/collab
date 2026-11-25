//! Native hosted-session orchestration shared by desktop and Android command
//! wrappers. This layer owns refresh-token resolution, serialized refresh-token
//! rotation, and access-token freshness so the two platforms do not fork the
//! hosted session lifecycle. It operates on [`AppState`] and the shared
//! [`crate::hosted_client`]/[`crate::server_token_store`] modules; the Tauri
//! command definitions in `commands/server.rs` stay thin wrappers over it.
//!
//! Bearer/access tokens never leave the backend: callers receive a
//! [`ServerSessionState`] used to construct authenticated requests in Rust.

use crate::hosted_client::{decode_session, server_client, server_request_error};
use crate::server_token_store::{persist_rotation, prepare_rotation, read_refresh_token};
use crate::state::{HostedSessionRuntime, SavedRefreshToken, ServerSessionState};
use chrono::{DateTime, Duration, Utc};

const ACCESS_REFRESH_SKEW_SECONDS: i64 = 120;

pub(crate) const NO_SAVED_SESSION: &str = "No saved server session was found.";
pub(crate) const REJECTED_SESSION: &str =
    "The saved server session has expired or was revoked. Sign in again.";

#[derive(Clone, Copy, PartialEq, Eq)]
pub(crate) enum RefreshMode {
    Automatic,
    Interactive,
}

fn resolve_refresh_token(
    state: &HostedSessionRuntime,
    base: &str,
    persistent: bool,
    mode: RefreshMode,
) -> Result<String, String> {
    match state.refresh_token_cache.read().get(base) {
        Some(SavedRefreshToken::Stored(token)) => return Ok(token.clone()),
        Some(SavedRefreshToken::SignInRequired(reason)) if mode == RefreshMode::Automatic => {
            return Err((*reason).into())
        }
        _ => {}
    }
    let token = read_refresh_token(base, persistent, mode == RefreshMode::Interactive)?;
    let mut cache = state.refresh_token_cache.write();
    match token {
        Some(token) => {
            cache.insert(base.into(), SavedRefreshToken::Stored(token.clone()));
            Ok(token)
        }
        None => {
            cache.insert(
                base.into(),
                SavedRefreshToken::SignInRequired(NO_SAVED_SESSION),
            );
            Err(NO_SAVED_SESSION.into())
        }
    }
}

/// A failed write leaves the previous checkpoint in place. The live session
/// owns the newer, usable token and the next refresh retries the write first.
fn checkpoint_rotation(
    state: &HostedSessionRuntime,
    session: &ServerSessionState,
    save: impl FnOnce(&str, &str, bool) -> Result<(), String>,
) -> Result<(), String> {
    let base = &session.server_url;
    if matches!(state.refresh_token_cache.read().get(base), Some(SavedRefreshToken::Stored(saved)) if saved == &session.refresh_token)
    {
        return Ok(());
    }
    save(base, &session.refresh_token, session.persist_across_reboots)?;
    state.refresh_token_cache.write().insert(
        base.clone(),
        SavedRefreshToken::Stored(session.refresh_token.clone()),
    );
    Ok(())
}

pub(crate) fn access_token_needs_refresh(session: &ServerSessionState) -> bool {
    DateTime::parse_from_rfc3339(&session.access_expires_at)
        .map(|expires| {
            expires.with_timezone(&Utc)
                <= Utc::now() + Duration::seconds(ACCESS_REFRESH_SKEW_SECONDS)
        })
        .unwrap_or(false)
}

/// Background jobs and foreground requests reuse the same session. An explicit
/// restore can also recover a remotely invalidated, locally still-fresh session.
pub(crate) async fn refresh_session_locked(
    state: &HostedSessionRuntime,
    base: &str,
    allow_invalid_certificates: bool,
    persist_across_reboots: bool,
    mode: RefreshMode,
) -> Result<ServerSessionState, String> {
    let _guard = state.lock_server(base).await;
    refresh_session(
        state,
        base,
        allow_invalid_certificates,
        persist_across_reboots,
        mode,
    )
    .await
}

/// Caller holds the server's lifecycle lock through any registration changes.
pub(crate) async fn refresh_session(
    state: &HostedSessionRuntime,
    base: &str,
    allow_invalid_certificates: bool,
    persist_across_reboots: bool,
    mode: RefreshMode,
) -> Result<ServerSessionState, String> {
    let current = state.server_sessions.read().get(base).cloned();
    let interactive = mode == RefreshMode::Interactive;
    let (refresh_token, allow_invalid_certificates, persist_across_reboots) = match current {
        Some(session) => {
            if !interactive && !access_token_needs_refresh(&session) {
                let _ = checkpoint_rotation(state, &session, persist_rotation);
                return Ok(session);
            }
            let ready = prepare_rotation(base, session.persist_across_reboots, interactive)
                .and_then(|_| checkpoint_rotation(state, &session, persist_rotation));
            if let Err(reason) = ready {
                if !interactive
                    && DateTime::parse_from_rfc3339(&session.access_expires_at)
                        .is_ok_and(|expires| expires > Utc::now())
                {
                    return Ok(session);
                }
                return Err(reason);
            }
            (
                session.refresh_token,
                session.allow_invalid_certificates,
                session.persist_across_reboots,
            )
        }
        None => {
            let token = resolve_refresh_token(state, base, persist_across_reboots, mode)?;
            prepare_rotation(base, persist_across_reboots, interactive)?;
            (token, allow_invalid_certificates, persist_across_reboots)
        }
    };

    let response = server_client(allow_invalid_certificates)?
        .post(format!("{base}/api/v1/auth/refresh"))
        .json(&serde_json::json!({ "refreshToken": refresh_token }))
        .send()
        .await
        .map_err(server_request_error)?;
    if response.status() == reqwest::StatusCode::UNAUTHORIZED {
        state.server_sessions.write().remove(base);
        state.refresh_token_cache.write().insert(
            base.into(),
            SavedRefreshToken::SignInRequired(REJECTED_SESSION),
        );
        return Err(REJECTED_SESSION.into());
    }
    if !response.status().is_success() {
        return Err(format!(
            "The server could not refresh the session (HTTP {}). Try again later.",
            response.status().as_u16()
        ));
    }
    let session = decode_session(response).await?;
    let next = ServerSessionState {
        server_url: base.to_string(),
        allow_invalid_certificates,
        persist_across_reboots,
        access_token: session.access_token,
        refresh_token: session.refresh_token,
        access_expires_at: session.access_expires_at,
        user: session.user,
    };
    state
        .server_sessions
        .write()
        .insert(base.into(), next.clone());
    // The server has already consumed the previous token. The replacement is
    // valid even if the keyring became unavailable during the HTTP request.
    let _ = checkpoint_rotation(state, &next, persist_rotation);
    Ok(next)
}

/// Resolves the connected session for `server_url`, or the given "not connected"
/// message when the app is not signed in to that server. The message intentionally
/// contains "Connect to the Collab server" so the frontend's
/// `isLikelyConnectivityError` treats an unconnected server's vault as offline
/// (replica fallback + queued writes) rather than a hard failure.
pub(crate) fn session_for(
    state: &HostedSessionRuntime,
    server_url: &str,
    not_connected_message: &str,
) -> Result<ServerSessionState, String> {
    let base = crate::hosted_client::validate_server_url(server_url)?;
    state
        .server_sessions
        .read()
        .get(&base)
        .cloned()
        .ok_or_else(|| not_connected_message.to_string())
}

/// Like [`session_for`], but transparently refreshes the access token first when
/// it is at or near expiry, so callers always build requests with a valid bearer.
pub(crate) async fn fresh_session_for(
    state: &HostedSessionRuntime,
    server_url: &str,
    not_connected_message: &str,
) -> Result<ServerSessionState, String> {
    let session = session_for(state, server_url, not_connected_message)?;
    if !access_token_needs_refresh(&session) {
        return Ok(session);
    }
    refresh_session_locked(
        state,
        &session.server_url,
        session.allow_invalid_certificates,
        session.persist_across_reboots,
        RefreshMode::Automatic,
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    use collab_protocol::{ServerUser, ServerUserRole, ServerUserStatus};

    fn session(url: &str, user: &str) -> ServerSessionState {
        ServerSessionState {
            server_url: url.to_string(),
            allow_invalid_certificates: false,
            persist_across_reboots: false,
            access_token: format!("{user}-access"),
            refresh_token: format!("{user}-refresh"),
            access_expires_at: "2099-01-01T00:00:00Z".to_string(),
            user: ServerUser {
                id: user.to_string(),
                username: user.to_string(),
                display_name: user.to_string(),
                role: ServerUserRole::Member,
                status: ServerUserStatus::Active,
                created_at: String::new(),
                last_login_at: None,
                active_sessions: 1,
                is_primary_admin: false,
                has_avatar: false,
                avatar_updated_at: None,
                preferences: serde_json::Value::Null,
            },
        }
    }

    #[test]
    fn multiple_server_sessions_resolve_independently_by_url() {
        let state = HostedSessionRuntime::new();
        state.server_sessions.write().insert(
            "https://a.example.com".to_string(),
            session("https://a.example.com", "alice"),
        );
        state.server_sessions.write().insert(
            "https://b.example.com".to_string(),
            session("https://b.example.com", "bob"),
        );

        // Each server resolves to its own session, concurrently.
        assert_eq!(
            session_for(&state, "https://a.example.com", "nope")
                .unwrap()
                .access_token,
            "alice-access"
        );
        assert_eq!(
            session_for(&state, "https://b.example.com/admin", "nope")
                .unwrap()
                .user
                .id,
            "bob"
        );
        // A server we are not connected to yields the connectivity message.
        assert_eq!(
            session_for(&state, "https://c.example.com", "not connected").unwrap_err(),
            "not connected"
        );

        // Dropping one server leaves the other intact.
        state
            .server_sessions
            .write()
            .remove("https://a.example.com");
        assert!(session_for(&state, "https://a.example.com", "gone").is_err());
        assert!(session_for(&state, "https://b.example.com", "gone").is_ok());
    }

    #[test]
    fn failed_checkpoint_retries_the_replacement_without_rewriting_a_saved_token() {
        let state = HostedSessionRuntime::new();
        let next = session("https://a.example.com", "alice");
        state.refresh_token_cache.write().insert(
            next.server_url.clone(),
            SavedRefreshToken::Stored("spent".into()),
        );
        assert!(checkpoint_rotation(&state, &next, |_, _, _| Err("locked".into())).is_err());
        checkpoint_rotation(&state, &next, |_, token, _| {
            assert_eq!(token, "alice-refresh");
            Ok(())
        })
        .unwrap();
        checkpoint_rotation(&state, &next, |_, _, _| panic!("already checkpointed")).unwrap();
    }

    #[tokio::test]
    async fn retry_after_outage_uses_the_saved_token_and_stops_on_definitive_rejection() {
        use httpmock::prelude::*;
        let server = MockServer::start_async().await;
        let base = server.base_url();
        let state = HostedSessionRuntime::new();
        state
            .refresh_token_cache
            .write()
            .insert(base.clone(), SavedRefreshToken::Stored("fixture".into()));
        let attempt =
            || refresh_session_locked(&state, &base, false, false, RefreshMode::Automatic);
        let outage = server
            .mock_async(|when, then| {
                when.method(POST).path("/api/v1/auth/refresh");
                then.status(503);
            })
            .await;
        assert!(attempt().await.unwrap_err().contains("503"));
        outage.delete_async().await;
        let rejected = server
            .mock_async(|when, then| {
                when.method(POST)
                    .path("/api/v1/auth/refresh")
                    .json_body(serde_json::json!({"refreshToken": "fixture"}));
                then.status(401);
            })
            .await;
        assert_eq!(attempt().await.unwrap_err(), REJECTED_SESSION);
        assert_eq!(attempt().await.unwrap_err(), REJECTED_SESSION);
        rejected.assert_calls_async(1).await;
    }

    #[tokio::test]
    async fn simultaneous_automatic_restores_share_one_exchange() {
        use collab_protocol::{DataResponse, NativeSession};
        use httpmock::prelude::*;
        let server = MockServer::start_async().await;
        let base = server.base_url();
        let state = HostedSessionRuntime::new();
        let next = session(&base, "alice");
        state.refresh_token_cache.write().insert(
            base.clone(),
            SavedRefreshToken::Stored(next.refresh_token.clone()),
        );
        let refresh = server
            .mock_async(|when, then| {
                when.method(POST).path("/api/v1/auth/refresh");
                then.status(200)
                    .json_body_obj(&DataResponse::new(NativeSession {
                        user: next.user.clone(),
                        access_token: next.access_token.clone(),
                        refresh_token: next.refresh_token.clone(),
                        access_expires_at: next.access_expires_at.clone(),
                        refresh_expires_at: next.access_expires_at.clone(),
                    }));
            })
            .await;
        let attempt =
            || refresh_session_locked(&state, &base, false, false, RefreshMode::Automatic);
        let (first, second) = tokio::join!(attempt(), attempt());
        assert_eq!(first.unwrap().access_token, second.unwrap().access_token);
        refresh.assert_calls_async(1).await;
    }
}
