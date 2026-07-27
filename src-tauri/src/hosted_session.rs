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
use crate::server_token_store::{read_refresh_token, store_refresh_token};
use crate::state::{HostedSessionRuntime, ServerSessionState};
use chrono::{DateTime, Duration, Utc};

const ACCESS_REFRESH_SKEW_SECONDS: i64 = 120;

/// Resolves the refresh token for `base` while touching the OS keyring at most
/// once per launch: prefers the in-memory session, then the per-launch cache,
/// and only then reads the keyring (priming the cache with what it read).
fn resolve_refresh_token(
    state: &HostedSessionRuntime,
    base: &str,
    persist_across_reboots: bool,
) -> Result<String, String> {
    if let Some(session) = state.server_sessions.read().get(base) {
        if !session.refresh_token.is_empty() {
            return Ok(session.refresh_token.clone());
        }
    }
    if let Some(token) = state.refresh_token_cache.read().get(base) {
        return Ok(token.clone());
    }
    let token = read_refresh_token(base, persist_across_reboots)
        .ok_or_else(|| "No saved server session was found.".to_string())?;
    state
        .refresh_token_cache
        .write()
        .insert(base.to_string(), token.clone());
    Ok(token)
}

/// Whether a rotated refresh token must be re-written to the keyring. Skipping
/// an unchanged write avoids a redundant Secret Service access (a potential
/// unlock prompt on Linux).
fn should_persist_rotation(previous: &str, next: &str) -> bool {
    previous != next
}

fn access_token_needs_refresh(session: &ServerSessionState) -> bool {
    DateTime::parse_from_rfc3339(&session.access_expires_at)
        .map(|expires| {
            expires.with_timezone(&Utc)
                <= Utc::now() + Duration::seconds(ACCESS_REFRESH_SKEW_SECONDS)
        })
        .unwrap_or(false)
}

/// Refreshes the session for `base`, serializing rotation across the process so
/// the server's single-use refresh token is never spent by two concurrent
/// refreshes. When `only_if_needed` is set, an already-fresh session is returned
/// without contacting the server.
pub(crate) async fn refresh_session_locked(
    state: &HostedSessionRuntime,
    base: &str,
    allow_invalid_certificates: bool,
    persist_across_reboots: bool,
    only_if_needed: bool,
) -> Result<ServerSessionState, String> {
    let _guard = state.server_refresh_lock.lock().await;

    if let Some(current) = state.server_sessions.read().get(base).cloned() {
        if only_if_needed && !access_token_needs_refresh(&current) {
            return Ok(current);
        }
    }

    // Resolve the refresh token without touching the keyring on the hot path:
    // prefer the live session, then the per-launch cache, and only read the
    // keyring (once) when neither is primed. The keyring read primes the cache
    // immediately, so a refresh that then fails (e.g. the server is down at
    // startup) does not make the auto-reconnect retry loop re-read the keyring.
    let refresh_token = resolve_refresh_token(state, base, persist_across_reboots)?;
    let response = server_client(allow_invalid_certificates)?
        .post(format!("{base}/api/v1/auth/refresh"))
        .json(&serde_json::json!({ "refreshToken": refresh_token }))
        .send()
        .await
        .map_err(server_request_error)?;
    let session = decode_session(response).await?;
    // Persist the rotated token only when it actually changed, to avoid redundant
    // Secret Service writes (each a potential unlock prompt on Linux).
    if should_persist_rotation(&refresh_token, &session.refresh_token) {
        store_refresh_token(base, &session.refresh_token, persist_across_reboots)?;
    }
    state
        .refresh_token_cache
        .write()
        .insert(base.to_string(), session.refresh_token.clone());
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
        .insert(base.to_string(), next.clone());
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
        true,
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::{session_for, should_persist_rotation};

    #[test]
    fn multiple_server_sessions_resolve_independently_by_url() {
        use crate::state::{HostedSessionRuntime, ServerSessionState};
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
    fn rotated_refresh_token_is_persisted_only_when_it_changes() {
        // A server that returns the same refresh token on refresh must not
        // trigger a redundant keyring write (which can prompt on Linux).
        assert!(!should_persist_rotation("same-token", "same-token"));
        assert!(should_persist_rotation("old-token", "new-token"));
    }
}
