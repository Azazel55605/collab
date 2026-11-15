use super::{
    empty, extension, range, reply, Playback, PlaybackSource, PreviewBudget, Reply, MAX_SESSIONS,
    SOURCE_IDLE,
};
use crate::{
    commands::replica,
    hosted_client::{playback_server_client, server_request_error, validate_server_url},
    hosted_session::{access_token_needs_refresh, fresh_session_for, session_for},
    state::{AppState, HostedSessionRuntime},
};
use axum::{
    body::{Body, Bytes},
    http::{header, HeaderMap, Method, StatusCode},
};
use collab_protocol::media::MAX_RANGE_BYTES;
use futures_util::stream;
use parking_lot::Mutex;
use serde::Deserialize;
use std::{
    collections::HashMap,
    io,
    path::Path,
    sync::{Arc, LazyLock},
    time::Duration,
};
use tauri::{State, WebviewWindow};
use tokio::sync::{Mutex as AsyncMutex, Semaphore};
use tokio_util::sync::CancellationToken;
use uuid::Uuid;
use zeroize::{Zeroize, Zeroizing};

const MAX_OFFLINE_BYTES: u64 = 32 * 1024 * 1024;
const OFFLINE_HEADER: &str = "x-collab-offline-copy";
const NO_SESSION: &str = "Sign in to the Collab server to open this media.";
const OFFLINE_MISSING: &str =
    "The server is unreachable and this revision has no offline playback copy.";
static OPEN_SLOTS: Semaphore = Semaphore::const_new(MAX_SESSIONS);
static DOWNLOAD_SLOT: LazyLock<Semaphore> = LazyLock::new(|| Semaphore::new(1));

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HostedPlaybackFile {
    server_url: String,
    vault_id: Uuid,
    file_id: Uuid,
    revision_id: Uuid,
    content_hash: String,
    size: u64,
    path: String,
    #[serde(default)]
    preview: bool,
}

#[derive(Default)]
pub(super) struct Registry {
    epoch: u64,
    sessions: HashMap<String, Arc<HostedSource>>,
}

impl Registry {
    pub(super) fn clear(&mut self, server_url: Option<&str>, vault_id: Option<Uuid>) {
        self.epoch = self.epoch.wrapping_add(1);
        self.sessions.retain(|_, session| {
            if server_url.is_none_or(|server| server == session.file.server_url)
                && vault_id.is_none_or(|vault| vault == session.file.vault_id)
            {
                session.cancel.cancel();
                false
            } else {
                true
            }
        });
    }

    pub(super) fn remove(&mut self, id: &str) {
        if let Some(session) = self.sessions.remove(id) {
            session.cancel.cancel();
        }
    }

    pub(super) fn get(&self, id: &str) -> Option<Arc<HostedSource>> {
        self.sessions.get(id).cloned()
    }
}

impl Playback {
    pub(crate) fn clear_hosted_server(&self, server_url: &str) {
        self.hosted.lock().clear(Some(server_url), None);
    }

    pub(crate) fn clear_hosted_vault(&self, server_url: &str, vault_id: Uuid) {
        self.hosted.lock().clear(Some(server_url), Some(vault_id));
    }
}

pub(super) struct HostedSource {
    file: HostedPlaybackFile,
    account: String,
    runtime: Arc<HostedSessionRuntime>,
    mime: &'static str,
    can_download: bool,
    offline: Option<Zeroizing<Vec<u8>>>,
    cancel: CancellationToken,
    touched: Mutex<tokio::time::Instant>,
    authorized: AsyncMutex<tokio::time::Instant>,
    failure: Mutex<Option<String>>,
    preview_budget: PreviewBudget,
}

enum Failure {
    Network(String),
    NoAccess,
    Changed,
    OfflineDenied,
    RateLimited,
    InvalidResponse,
    Closed,
}

impl Failure {
    fn message(&self) -> String {
        match self {
            Self::Network(message) => message.clone(),
            Self::NoAccess => "You no longer have access to this hosted media.".into(),
            Self::Changed => "The hosted media revision changed or was removed. Reload it.".into(),
            Self::OfflineDenied => "You no longer have permission for offline copies.".into(),
            Self::RateLimited => "The server is limiting playback requests. Wait briefly and reload.".into(),
            Self::InvalidResponse => "The server could not provide the requested media range. Check that it supports hosted playback.".into(),
            Self::Closed => "This playback session has ended.".into(),
        }
    }

    fn status(&self) -> StatusCode {
        match self {
            Self::Network(_) => StatusCode::SERVICE_UNAVAILABLE,
            Self::NoAccess | Self::OfflineDenied => StatusCode::FORBIDDEN,
            Self::Changed | Self::Closed => StatusCode::GONE,
            Self::RateLimited => StatusCode::TOO_MANY_REQUESTS,
            Self::InvalidResponse => StatusCode::BAD_GATEWAY,
        }
    }
}

impl HostedSource {
    fn etag(&self) -> String {
        format!("\"{}\"", self.file.revision_id)
    }

    fn cache_prefix(&self) -> String {
        // An explicit copy belongs to the current native account and revision,
        // even when the replica manifest is shared between signed-in profiles.
        collab_core::sha256_bytes(
            format!(
                "{}:{}:{}",
                self.account, self.file.file_id, self.file.revision_id
            )
            .as_bytes(),
        )
    }

    fn validate_account(&self) -> Result<(), Failure> {
        if self.cancel.is_cancelled() {
            return Err(Failure::Closed);
        }
        let session = session_for(&self.runtime, &self.file.server_url, NO_SESSION)
            .map_err(|_| Failure::NoAccess)?;
        if self.account != session.user.id {
            return Err(Failure::NoAccess);
        }
        Ok(())
    }

    async fn request(
        &self,
        range: Option<(u64, u64)>,
        require_offline: bool,
    ) -> Result<reqwest::Response, Failure> {
        self.validate_account()?;
        let url = format!(
            "{}/api/v1/vaults/{}/files/{}/playback",
            self.file.server_url, self.file.vault_id, self.file.file_id,
        );
        let work = async {
            let mut session = session_for(&self.runtime, &self.file.server_url, NO_SESSION)
                .map_err(|_| Failure::NoAccess)?;
            if access_token_needs_refresh(&session) {
                let runtime = self.runtime.clone();
                let url = self.file.server_url.clone();
                // An abandoned seek must not interrupt persistence of a
                // single-use refresh token after the server rotates it.
                session =
                    tokio::spawn(
                        async move { fresh_session_for(&runtime, &url, NO_SESSION).await },
                    )
                    .await
                    .map_err(|_| Failure::InvalidResponse)?
                    .map_err(|message| {
                        if message.starts_with("Could not reach the Collab server") {
                            Failure::Network(message)
                        } else {
                            Failure::NoAccess
                        }
                    })?;
            }
            if self.account != session.user.id {
                return Err(Failure::NoAccess);
            }
            let client = playback_server_client(session.allow_invalid_certificates)
                .map_err(|_| Failure::InvalidResponse)?;
            let mut request = match range {
                Some((start, end)) => client
                    .get(&url)
                    .header(header::RANGE, format!("bytes={start}-{end}")),
                None => client.head(&url),
            };
            request = request
                .header(header::IF_MATCH, self.etag())
                .bearer_auth(&session.access_token)
                .timeout(Duration::from_secs(8));
            let response = request.send().await.map_err(|error| {
                let retryable = error.is_connect() || error.is_timeout();
                let message = server_request_error(error);
                if retryable && message.starts_with("Could not reach the Collab server") {
                    Failure::Network(message)
                } else {
                    Failure::InvalidResponse
                }
            })?;
            self.validate_account()?;
            if response.url().as_str() != url {
                return Err(Failure::InvalidResponse);
            }
            match response.status() {
                StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN => return Err(Failure::NoAccess),
                StatusCode::PRECONDITION_FAILED => return Err(Failure::Changed),
                StatusCode::TOO_MANY_REQUESTS => return Err(Failure::RateLimited),
                StatusCode::NOT_FOUND
                    if response
                        .headers()
                        .get(header::CONTENT_TYPE)
                        .is_some_and(|value| value.as_bytes().starts_with(b"application/json")) =>
                {
                    return Err(Failure::Changed)
                }
                _ => {}
            }
            let (status, length) = match range {
                Some((start, end)) => {
                    let expected = format!("bytes {start}-{end}/{}", self.file.size);
                    if response
                        .headers()
                        .get(header::CONTENT_RANGE)
                        .and_then(|value| value.to_str().ok())
                        != Some(expected.as_str())
                    {
                        return Err(Failure::InvalidResponse);
                    }
                    (StatusCode::PARTIAL_CONTENT, end - start + 1)
                }
                None => (StatusCode::OK, self.file.size),
            };
            let headers = response.headers();
            if response.status() != status
                || headers.get(header::ETAG).and_then(|v| v.to_str().ok())
                    != Some(self.etag().as_str())
                || headers
                    .get(header::CONTENT_TYPE)
                    .and_then(|v| v.to_str().ok())
                    != Some(self.mime)
                || headers
                    .get(header::CONTENT_LENGTH)
                    .and_then(|v| v.to_str().ok())
                    .and_then(|n| n.parse().ok())
                    != Some(length)
            {
                return Err(Failure::InvalidResponse);
            }
            if require_offline && headers.get(OFFLINE_HEADER).is_none_or(|value| value != "1") {
                return Err(Failure::OfflineDenied);
            }
            Ok(response)
        };
        tokio::select! {
            biased;
            _ = self.cancel.cancelled() => Err(Failure::Closed),
            result = tokio::time::timeout(Duration::from_secs(9), work) => result
                .unwrap_or_else(|_| Err(Failure::Network("The media server did not respond.".into()))),
        }
    }

    async fn read_range(&self, start: u64, end: u64, download: bool) -> Result<Bytes, Failure> {
        self.validate_account()?;
        if let Some(offline) = &self.offline {
            return Ok(Bytes::copy_from_slice(
                &offline[start as usize..=end as usize],
            ));
        }
        let result = async {
            let mut response = self.request(Some((start, end)), download).await?;
            let length = (end - start + 1) as usize;
            let mut bytes = Vec::with_capacity(length);
            while let Some(chunk) = response.chunk().await.map_err(|_| {
                Failure::Network(
                    "The media connection was interrupted. Reload to reconnect.".into(),
                )
            })? {
                if chunk.len() > length - bytes.len() {
                    return Err(Failure::InvalidResponse);
                }
                bytes.extend_from_slice(&chunk);
            }
            self.validate_account()?;
            if bytes.len() != length {
                return Err(Failure::InvalidResponse);
            }
            Ok(Bytes::from(bytes))
        };
        let result = tokio::select! {
            biased;
            _ = self.cancel.cancelled() => return Err(Failure::Closed),
            result = result => result,
        };
        if let Err(error) = &result {
            if !download {
                *self.failure.lock() = Some(error.message());
            }
            self.invalidate_if_denied(error).await;
        }
        result
    }

    async fn invalidate_if_denied(&self, error: &Failure) {
        if !matches!(
            error,
            Failure::NoAccess | Failure::Changed | Failure::OfflineDenied
        ) {
            return;
        }
        if !matches!(error, Failure::OfflineDenied) || self.offline.is_some() {
            self.cancel.cancel();
        }
        let url = self.file.server_url.clone();
        let vault = self.file.vault_id.to_string();
        let file = self.file.file_id.to_string();
        // Do not unlock a keyring just to evict this file.
        let _ = tokio::task::spawn_blocking(move || {
            if let Some(store) = collab_replica::ReplicaStore::open_existing(
                &crate::commands::app_config_dir()?,
                &url,
                &vault,
            ) {
                store.forget_cached_playback(&file)?;
            }
            Ok::<(), String>(())
        })
        .await;
    }

    pub(super) async fn check(&self) -> Result<(), String> {
        if let Some(error) = self.failure.lock().clone() {
            return Err(error);
        }
        self.validate_account().map_err(|error| error.message())?;
        *self.touched.lock() = tokio::time::Instant::now();
        self.refresh_access().await
    }

    async fn refresh_access(&self) -> Result<(), String> {
        self.validate_account().map_err(|error| error.message())?;
        let mut next = self.authorized.lock().await;
        if *next > tokio::time::Instant::now() {
            return self.validate_account().map_err(|error| error.message());
        }
        let result = self.request(None, self.offline.is_some()).await;
        *next = tokio::time::Instant::now() + Duration::from_secs(4);
        match result {
            Ok(_) | Err(Failure::Network(_)) => Ok(()),
            Err(error) => {
                let message = error.message();
                *self.failure.lock() = Some(message.clone());
                self.invalidate_if_denied(&error).await;
                self.cancel.cancel();
                Err(message)
            }
        }
    }
}

#[tauri::command]
pub async fn open_hosted_playback(
    state: State<'_, AppState>,
    window: WebviewWindow,
    mut file: HostedPlaybackFile,
) -> Result<PlaybackSource, String> {
    if window.label() != "main" {
        return Err("Playback is available from the main window.".into());
    }
    let _permit = OPEN_SLOTS
        .try_acquire()
        .map_err(|_| "Too many media files are opening.")?;
    let epoch = state.playback.hosted.lock().epoch;
    file.server_url = validate_server_url(&file.server_url)?;
    let mime = super::mime(&extension(Path::new(&file.path))).ok_or("Unsupported media type.")?;
    if file.size == 0
        || file.size > i64::MAX as u64
        || file.content_hash.len() != 64
        || !file.content_hash.bytes().all(|b| b.is_ascii_hexdigit())
    {
        return Err("Invalid hosted media revision.".into());
    }
    let session = session_for(state.hosted_sessions(), &file.server_url, NO_SESSION)?;
    let now = tokio::time::Instant::now();
    let preview_budget = PreviewBudget::new(file.preview);
    let mut source = HostedSource {
        file,
        account: session.user.id,
        runtime: state.hosted_sessions.clone(),
        mime,
        can_download: false,
        offline: None,
        cancel: CancellationToken::new(),
        touched: Mutex::new(now),
        authorized: AsyncMutex::new(now),
        failure: Mutex::new(None),
        preview_budget,
    };
    match source.request(None, false).await {
        Ok(response) => {
            source.can_download = !source.file.preview
                && source.file.size <= MAX_OFFLINE_BYTES
                && response
                    .headers()
                    .get(OFFLINE_HEADER)
                    .is_some_and(|value| value == "1");
        }
        Err(Failure::Network(_)) => {
            if source.file.size > MAX_OFFLINE_BYTES {
                return Err("Offline playback inside a hosted vault is limited to 32 MiB. Download larger media to an unencrypted local vault for offline playback.".into());
            }
            let url = source.file.server_url.clone();
            let vault = source.file.vault_id.to_string();
            let id = source.file.file_id.to_string();
            let prefix = source.cache_prefix();
            let hash = source.file.content_hash.clone();
            let size = source.file.size as usize;
            source.offline = tokio::task::spawn_blocking(move || {
                let store = replica::existing_read(&url, &vault).ok().flatten()?;
                let payload = store
                    .read_cached_playback(&id, size + prefix.len())
                    .ok()
                    .flatten()?;
                authenticate_offline_payload(payload, prefix.as_bytes(), size, &hash)
            })
            .await
            .map_err(|_| OFFLINE_MISSING)?;
            if source.offline.is_none() {
                return Err(OFFLINE_MISSING.into());
            }
        }
        Err(error) => {
            source.invalidate_if_denied(&error).await;
            return Err(error.message());
        }
    }
    let address = state.playback.address().await?;
    let id = Uuid::new_v4().simple().to_string();
    let source = Arc::new(source);
    {
        let mut registry = state.playback.hosted.lock();
        if registry.epoch != epoch {
            return Err("The vault changed while opening media.".into());
        }
        source.validate_account().map_err(|error| error.message())?;
        if registry.sessions.len() >= MAX_SESSIONS {
            return Err(
                "Too many hosted playback sessions. Close another player and try again.".into(),
            );
        }
        registry.sessions.insert(id.clone(), source.clone());
    }
    let playback = Arc::downgrade(&state.playback);
    let expire = id.clone();
    let retained = source.clone();
    tauri::async_runtime::spawn(async move {
        loop {
            tokio::select! {
                _ = retained.cancel.cancelled() => {
                    if retained.failure.lock().is_some() {
                        tokio::time::sleep(Duration::from_secs(8)).await;
                    }
                    break;
                }
                _ = tokio::time::sleep(Duration::from_secs(5)) => {
                    if retained.touched.lock().elapsed() >= SOURCE_IDLE { break; }
                    // A fully buffered file can keep playing without new HTTP
                    // requests. Recheck current server access in native code.
                    if !retained.cancel.is_cancelled() {
                        let _ = retained.refresh_access().await;
                    }
                }
            }
        }
        if let Some(playback) = playback.upgrade() {
            playback.hosted.lock().remove(&expire);
        }
    });
    Ok(PlaybackSource {
        url: format!("http://{address}/{id}/media"),
        id,
        revision: source.file.revision_id.to_string(),
        captions: Vec::new(),
        audio_tracks: Vec::new(),
        audio_metadata: None,
        offline: Some(source.offline.is_some()),
        can_download_offline: Some(source.can_download),
    })
}

fn authenticate_offline_payload(
    payload: Vec<u8>,
    prefix: &[u8],
    size: usize,
    hash: &str,
) -> Option<Zeroizing<Vec<u8>>> {
    let mut payload = Zeroizing::new(payload);
    let bytes = payload.strip_prefix(prefix)?;
    if bytes.len() != size || collab_core::sha256_bytes(bytes) != hash {
        return None;
    }
    payload.copy_within(prefix.len().., 0);
    payload[size..].zeroize();
    payload.truncate(size);
    Some(payload)
}

#[tauri::command]
pub async fn download_hosted_playback(
    state: State<'_, AppState>,
    id: String,
) -> Result<(), String> {
    let _permit = DOWNLOAD_SLOT
        .try_acquire()
        .map_err(|_| "An offline media download is already running.")?;
    let source = state
        .playback
        .hosted
        .lock()
        .get(&id)
        .ok_or("This playback session has ended.")?;
    if !source.can_download {
        return Err("This media is not eligible for an offline playback copy.".into());
    }
    let prefix = source.cache_prefix();
    let mut payload = Zeroizing::new(Vec::with_capacity(prefix.len() + source.file.size as usize));
    payload.extend_from_slice(prefix.as_bytes());
    let mut offset = 0;
    while offset < source.file.size {
        let end = (offset + MAX_RANGE_BYTES).min(source.file.size) - 1;
        let bytes = source
            .read_range(offset, end, true)
            .await
            .map_err(|error| error.message())?;
        payload.extend_from_slice(&bytes);
        offset = end + 1;
    }
    if collab_core::sha256_bytes(&payload[prefix.len()..]) != source.file.content_hash {
        return Err("The downloaded media failed its integrity check.".into());
    }
    source
        .request(None, true)
        .await
        .map_err(|error| error.message())?;
    tokio::task::spawn_blocking(move || {
        let vault = source.file.vault_id.to_string();
        let store = replica::existing(&source.file.server_url, &vault)?;
        source.validate_account().map_err(|error| error.message())?;
        let id = source.file.file_id.to_string();
        store.cache_playback(&id, &payload)?;
        if let Err(error) = source.validate_account() {
            let _ = store.forget_cached_playback(&id);
            return Err(error.message());
        }
        Ok(())
    })
    .await
    .map_err(|_| "Could not save the offline playback copy.")?
}

#[tauri::command]
pub fn clear_hosted_playback(
    state: State<AppState>,
    server_url: String,
    vault_id: Uuid,
) -> Result<(), String> {
    state
        .playback
        .clear_hosted_vault(&validate_server_url(&server_url)?, vault_id);
    Ok(())
}

pub(super) async fn serve(
    source: Arc<HostedSource>,
    slots: Arc<Semaphore>,
    asset: &str,
    method: Method,
    headers: HeaderMap,
) -> Reply {
    if asset != "media" {
        return empty(StatusCode::NOT_FOUND);
    }
    if let Err(error) = source.validate_account() {
        return empty(error.status());
    }
    let size = source.file.size;
    let bounds = match headers.get(header::RANGE).filter(|_| method == Method::GET) {
        Some(value) => value
            .to_str()
            .ok()
            .and_then(|value| range(value, size))
            .map(|(start, end)| (start, end, StatusCode::PARTIAL_CONTENT)),
        None => Some((0, size - 1, StatusCode::OK)),
    };
    let Some((start, end, status)) = bounds else {
        let mut response = empty(StatusCode::RANGE_NOT_SATISFIABLE);
        response.headers_mut().insert(
            header::CONTENT_RANGE,
            format!("bytes */{size}").parse().unwrap(),
        );
        return response;
    };
    let mime = source.mime;
    let body = if method == Method::HEAD {
        Body::empty()
    } else {
        let Ok(Ok(slot)) =
            tokio::time::timeout(Duration::from_secs(2), slots.acquire_owned()).await
        else {
            return empty(StatusCode::SERVICE_UNAVAILABLE);
        };
        // Resolve the first chunk before sending successful response headers.
        let first_end = (start + MAX_RANGE_BYTES - 1).min(end);
        if source
            .preview_budget
            .consume(first_end - start + 1)
            .is_err()
        {
            return empty(StatusCode::RANGE_NOT_SATISFIABLE);
        }
        let first = match source.read_range(start, first_end, false).await {
            Ok(bytes) => bytes,
            Err(error) => return empty(error.status()),
        };
        *source.touched.lock() = tokio::time::Instant::now();
        Body::from_stream(stream::try_unfold(
            (source, slot, first_end + 1, Some(first)),
            move |(source, slot, offset, first)| async move {
                let to_io = |error: Failure| io::Error::other(error.message());
                source.validate_account().map_err(to_io)?;
                if let Some(first) = first {
                    return Ok(Some((first, (source, slot, offset, None))));
                }
                if offset > end {
                    return Ok(None);
                }
                let stop = (offset + MAX_RANGE_BYTES - 1).min(end);
                source.preview_budget.consume(stop - offset + 1)?;
                let bytes = source
                    .read_range(offset, stop, false)
                    .await
                    .map_err(to_io)?;
                *source.touched.lock() = tokio::time::Instant::now();
                Ok::<_, io::Error>(Some((bytes, (source, slot, stop + 1, None))))
            },
        ))
    };
    let mut response = reply(status, mime, body);
    let headers = response.headers_mut();
    headers.insert(header::ACCEPT_RANGES, "bytes".parse().unwrap());
    headers.insert(header::CONTENT_LENGTH, (end - start + 1).into());
    if status == StatusCode::PARTIAL_CONTENT {
        headers.insert(
            header::CONTENT_RANGE,
            format!("bytes {start}-{end}/{size}").parse().unwrap(),
        );
    }
    response
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::ServerSessionState;
    use axum::{extract::State as AxumState, routing::get, Router};
    use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};

    #[derive(Default)]
    struct Fixture {
        start: AtomicU64,
        bytes: AtomicU64,
        revoked: AtomicBool,
        revision: Uuid,
    }

    #[test]
    fn offline_payload_requires_the_same_account_revision_and_content() {
        let hash = collab_core::sha256_bytes(b"audio");
        let data = b"account-and-revisionaudio".to_vec();
        let restored =
            authenticate_offline_payload(data.clone(), b"account-and-revision", 5, &hash).unwrap();
        assert_eq!(restored.as_slice(), b"audio");
        assert!(authenticate_offline_payload(data.clone(), b"other-account", 5, &hash).is_none());
        assert!(
            authenticate_offline_payload(data.clone(), b"account-and-revision", 5, "wrong")
                .is_none()
        );
        assert!(authenticate_offline_payload(data, b"account-and-revision", 7, &hash).is_none());
    }

    #[tokio::test]
    async fn native_proxy_seeks_without_prefetch_and_rejects_revocation() {
        const SIZE: u64 = 36_100_000_000;
        let fixture = Arc::new(Fixture {
            revision: Uuid::new_v4(),
            ..Fixture::default()
        });
        let handler = |AxumState(fixture): AxumState<Arc<Fixture>>,
                       method: Method,
                       headers: HeaderMap| async move {
            if headers
                .get(header::AUTHORIZATION)
                .is_none_or(|v| v != "Bearer fixture-token")
                || fixture.revoked.load(Ordering::Relaxed)
            {
                return empty(StatusCode::FORBIDDEN);
            }
            let etag = format!("\"{}\"", fixture.revision);
            if headers
                .get(header::IF_MATCH)
                .is_none_or(|v| v != etag.as_str())
            {
                return empty(StatusCode::PRECONDITION_FAILED);
            }
            let mut response = axum::http::Response::builder()
                .header(header::ETAG, etag)
                .header(header::CONTENT_TYPE, "video/mp4")
                .header(OFFLINE_HEADER, "1");
            if method == Method::HEAD {
                return response
                    .header(header::CONTENT_LENGTH, SIZE)
                    .body(Body::empty())
                    .unwrap();
            }
            let (start, end) = range(headers[header::RANGE].to_str().unwrap(), SIZE).unwrap();
            let count = end - start + 1;
            assert!(count <= MAX_RANGE_BYTES);
            fixture.start.store(start, Ordering::Relaxed);
            fixture.bytes.fetch_add(count, Ordering::Relaxed);
            response = response
                .status(StatusCode::PARTIAL_CONTENT)
                .header(header::CONTENT_RANGE, format!("bytes {start}-{end}/{SIZE}"))
                .header(header::CONTENT_LENGTH, count);
            response.body(Body::from(vec![42; count as usize])).unwrap()
        };
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let app = Router::new()
            .route("/api/v1/vaults/{vault}/files/{file}/playback", get(handler))
            .with_state(fixture.clone());
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let account = Uuid::new_v4().to_string();
        let runtime = Arc::new(HostedSessionRuntime::new());
        runtime.server_sessions.write().insert(
            url.clone(),
            ServerSessionState {
                server_url: url.clone(),
                access_token: "fixture-token".into(),
                refresh_token: String::new(),
                allow_invalid_certificates: false,
                persist_across_reboots: false,
                access_expires_at: (chrono::Utc::now() + chrono::Duration::hours(1)).to_rfc3339(),
                user: serde_json::from_value(serde_json::json!({
                    "id": account, "username": "fixture", "displayName":"fixture", "role":"admin",
                    "status":"active", "createdAt":"", "activeSessions":1, "isPrimaryAdmin":true,
                }))
                .unwrap(),
            },
        );
        let source = Arc::new(HostedSource {
            file: HostedPlaybackFile {
                server_url: url,
                vault_id: Uuid::new_v4(),
                file_id: Uuid::new_v4(),
                revision_id: fixture.revision,
                content_hash: "0".repeat(64),
                size: SIZE,
                path: "clip.mp4".into(),
                preview: false,
            },
            account,
            runtime,
            mime: "video/mp4",
            can_download: false,
            offline: None,
            cancel: CancellationToken::new(),
            touched: Mutex::new(tokio::time::Instant::now()),
            authorized: AsyncMutex::new(tokio::time::Instant::now()),
            failure: Mutex::new(None),
            preview_budget: PreviewBudget::default(),
        });
        assert!(source.request(None, false).await.is_ok());
        assert_eq!(fixture.bytes.load(Ordering::Relaxed), 0);

        let slots = Arc::new(Semaphore::new(4));
        let mut headers = HeaderMap::new();
        headers.insert(
            header::RANGE,
            format!("bytes={}-", SIZE - 4).parse().unwrap(),
        );
        let seek = serve(
            source.clone(),
            slots.clone(),
            "media",
            Method::GET,
            headers.clone(),
        )
        .await;
        assert_eq!(seek.status(), StatusCode::PARTIAL_CONTENT);
        assert_eq!(
            &axum::body::to_bytes(seek.into_body(), 4).await.unwrap()[..],
            &[42; 4]
        );
        assert_eq!(fixture.start.load(Ordering::Relaxed), SIZE - 4);
        assert_eq!(fixture.bytes.load(Ordering::Relaxed), 4);

        fixture.revoked.store(true, Ordering::Relaxed);
        let response = serve(source.clone(), slots, "media", Method::GET, headers).await;
        assert_eq!(response.status(), StatusCode::FORBIDDEN);
        assert!(source.cancel.is_cancelled());
        assert!(source
            .check()
            .await
            .unwrap_err()
            .contains("no longer have access"));
        server.abort();
    }
}
