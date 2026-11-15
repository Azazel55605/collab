mod audio_metadata;
pub(crate) mod hosted;
mod mp4;

use audio_metadata::{AudioDetails, AudioMetadata};

use super::{files, vault::read_vault_config_pub};
use crate::{crypto, models::vault::VaultKind, state::AppState};
use axum::{
    body::{Body, Bytes},
    extract::{Path as RoutePath, State as HttpState},
    http::{header, HeaderMap, Method, Response, StatusCode},
    routing::get,
    Router,
};
use cap_std::{ambient_authority, fs::Dir};
use futures_util::stream;
use parking_lot::Mutex;
use same_file::Handle;
use serde::Serialize;
use std::{
    collections::HashMap,
    fs::File,
    io::{self, Read, Seek, SeekFrom},
    net::SocketAddr,
    path::{Component, Path, PathBuf},
    sync::Arc,
    time::{Duration, SystemTime},
};
use tauri::{AppHandle, Manager, State, WebviewWindow};
use tauri_plugin_opener::OpenerExt;
use tokio::sync::{OnceCell, Semaphore};
use tokio_util::sync::CancellationToken;

// Read ahead with enough headroom for high-bitrate 4K sources while retaining
// a fixed allocation per read and the shared four-stream limit.
const CHUNK: usize = 256 * 1024;
const MAX_STREAMS: usize = 4;
// Keep a separate admission limit for local response bodies. A paused decoder
// may hold an old range open while issuing another range for a seek.
const MAX_LOCAL_BODIES: usize = 16;
const MAX_SESSIONS: usize = 4;
// An inspector can decode one frame under a lifetime range-read budget.
const MAX_PREVIEW_BYTES: u64 = 8 * 1024 * 1024;

#[derive(Default)]
struct PreviewBudget(Option<Mutex<u64>>);

impl PreviewBudget {
    fn new(enabled: bool) -> Self {
        Self(enabled.then(|| Mutex::new(MAX_PREVIEW_BYTES)))
    }

    fn consume(&self, bytes: u64) -> io::Result<()> {
        if let Some(remaining) = &self.0 {
            let mut remaining = remaining.lock();
            *remaining = remaining
                .checked_sub(bytes)
                .ok_or_else(|| io::Error::other("Media preview byte budget reached"))?;
        }
        Ok(())
    }
}

const MAX_CAPTION_BYTES: u64 = 1024 * 1024;
const CHUNK_INTERVAL: Duration = Duration::from_millis(8);
const SOURCE_IDLE: Duration = Duration::from_secs(30);

pub(super) fn mime(extension: &str) -> Option<&'static str> {
    collab_protocol::media::mime_for_extension(extension)
}

fn extension(path: &Path) -> String {
    path.extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase()
}

#[derive(Default)]
pub(crate) struct Playback {
    listener: OnceCell<SocketAddr>,
    sessions: Mutex<HashMap<String, Arc<Source>>>,
    hosted: Mutex<hosted::Registry>,
}

impl Playback {
    pub(crate) fn clear(&self) {
        self.hosted.lock().clear(None, None);
        for (_, source) in self.sessions.lock().drain() {
            source.revoke();
        }
    }

    fn remove(&self, id: &str) {
        self.hosted.lock().remove(id);
        if let Some(source) = self.sessions.lock().remove(id) {
            source.revoke();
        }
    }

    fn get(&self, id: &str) -> Option<Arc<Source>> {
        self.sessions.lock().get(id).cloned()
    }

    async fn address(self: &Arc<Self>) -> Result<SocketAddr, String> {
        self.listener
            .get_or_try_init(|| async {
                let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
                    .await
                    .map_err(|_| "Could not start the local player.")?;
                let address = listener
                    .local_addr()
                    .map_err(|_| "Could not start the local player.")?;
                let state = HttpServer {
                    address,
                    playback: self.clone(),
                    slots: Arc::new(Semaphore::new(MAX_STREAMS)),
                    local_reads: Arc::new(Semaphore::new(MAX_STREAMS)),
                };
                let router = Router::new()
                    .route("/{id}/{asset}", get(serve))
                    .with_state(state);
                tauri::async_runtime::spawn(async move {
                    let _ = axum::serve(listener, router).await;
                });
                Ok(address)
            })
            .await
            .copied()
    }
}

struct Source {
    root: PathBuf,
    relative: PathBuf,
    identity: Mutex<Option<Handle>>,
    failure: Mutex<Option<String>>,
    modified: SystemTime,
    len: u64,
    mime: &'static str,
    revision: String,
    captions: Vec<Caption>,
    cancel: CancellationToken,
    touched: Mutex<tokio::time::Instant>,
    next_read: tokio::sync::Mutex<tokio::time::Instant>,
    track_overlays: Vec<u64>,
    embedded: Vec<mp4::Track>,
    audio: Vec<String>,
    audio_metadata: Option<AudioMetadata>,
    preview_budget: PreviewBudget,
    bodies: Arc<Semaphore>,
}

struct Caption {
    label: String,
    vtt: Bytes,
}

impl Source {
    fn open(root: &str, relative: &str, selected_caption: Option<&str>) -> Result<Self, String> {
        Self::open_with_mode(root, relative, selected_caption, false, None, None)
    }

    fn open_with_mode(
        root: &str,
        relative: &str,
        selected_caption: Option<&str>,
        compatibility: bool,
        audio_track: Option<usize>,
        restore_revision: Option<&str>,
    ) -> Result<Self, String> {
        // Normalize at the IPC boundary. The directory capability also confines
        // resolution across symlinks and concurrent path substitutions.
        let relative = visible_path(relative)?;
        let mime = mime(&extension(&relative)).ok_or("Unsupported media file type.")?;
        let vault = Dir::open_ambient_dir(root, ambient_authority()).map_err(file_error)?;
        let mut file = open_regular(&vault, &relative).map_err(file_error)?;
        let mut magic = [0; 4];
        let encrypted = match file.read_exact(&mut magic) {
            Ok(()) => crypto::is_encrypted_data(&magic),
            Err(error) if error.kind() == io::ErrorKind::UnexpectedEof => false,
            Err(error) => return Err(file_error(error)),
        };
        if encrypted {
            return Err("Encrypted files are unavailable in the local player.".into());
        }
        let meta = file.metadata().map_err(file_error)?;
        let len = meta.len();
        if len == 0 {
            return Err("This media file is empty.".into());
        }
        let modified = meta.modified().map_err(file_error)?;
        let identity =
            Handle::from_file(file.try_clone().map_err(file_error)?).map_err(file_error)?;
        // Identity, size and mtime distinguish replacement without hashing an
        // entire file before playback. No device path or inode goes over IPC.
        use std::hash::{DefaultHasher, Hash, Hasher};
        let mut hash = DefaultHasher::new();
        (&identity, modified, len).hash(&mut hash);
        let revision = format!("{:016x}", hash.finish());
        let apply_options = restore_revision.is_none_or(|expected| expected == revision);
        let selected_caption = selected_caption.filter(|_| apply_options);
        let compatibility = compatibility && apply_options;
        let audio_track = audio_track.filter(|_| apply_options);
        let mut captions = Vec::new();
        if let Some(path) = selected_caption {
            let path = visible_path(path)?;
            captions.push(read_caption(&vault, &path)?);
        } else {
            for ext in ["vtt", "srt"] {
                let path = relative.with_extension(ext);
                if let Ok(caption) = read_caption(&vault, &path) {
                    captions.push(caption);
                }
            }
        }
        let tracks = if mime == "video/mp4" {
            match mp4::tracks(&mut file, len) {
                Ok(tracks) => tracks,
                Err(_) if compatibility || audio_track.is_some() => {
                    return Err("Could not read MP4 tracks for compatibility playback.".into())
                }
                Err(_) => mp4::Tracks::default(),
            }
        } else {
            mp4::Tracks::default()
        };
        let mut track_overlays = Vec::new();
        if compatibility {
            track_overlays.extend(tracks.subtitles.iter().map(|track| track.header));
            if track_overlays.is_empty() && audio_track.is_none() {
                return Err("No embedded MP4 subtitle tracks could be bypassed.".into());
            }
        }
        if let Some(index) = audio_track {
            if index >= tracks.audio.len() {
                return Err("The selected audio track does not exist.".into());
            }
            track_overlays.extend(
                tracks
                    .audio
                    .iter()
                    .enumerate()
                    .filter(|(i, _)| *i != index)
                    .map(|(_, track)| track.header),
            );
        }
        track_overlays.sort_unstable();
        let audio = tracks
            .audio
            .into_iter()
            .map(|track| track.language)
            .collect();
        let embedded = if compatibility {
            mp4::supported_text_tracks(&mut file, tracks.subtitles)
        } else {
            Vec::new()
        };
        let audio_metadata = AudioMetadata::read(&vault, &relative, &mut file, mime);
        let now = tokio::time::Instant::now();
        Ok(Self {
            root: root.into(),
            relative,
            identity: Mutex::new(Some(identity)),
            failure: Mutex::new(None),
            modified,
            len,
            mime,
            revision,
            captions,
            cancel: CancellationToken::new(),
            touched: Mutex::new(now),
            next_read: tokio::sync::Mutex::new(now),
            track_overlays,
            embedded,
            audio,
            audio_metadata,
            preview_budget: PreviewBudget::default(),
            bodies: Arc::new(Semaphore::new(MAX_LOCAL_BODIES)),
        })
    }

    fn revoke(&self) {
        self.cancel.cancel();
        self.bodies.close();
        self.identity.lock().take();
    }

    fn invalidate(&self, message: String) -> String {
        let mut failure = self.failure.lock();
        let reason = failure.get_or_insert(message).clone();
        self.revoke();
        reason
    }

    fn current(&self) -> Result<File, String> {
        if self.cancel.is_cancelled() {
            return Err(self
                .failure
                .lock()
                .clone()
                .unwrap_or_else(|| "This playback session has ended.".into()));
        }
        let current = (|| {
            // Open from the named root on every read so a moved vault, a revoked
            // directory permission, or an unlinked file cannot retain access
            // through an already-open descriptor.
            let vault =
                Dir::open_ambient_dir(&self.root, ambient_authority()).map_err(file_error)?;
            let candidate = open_regular(&vault, &self.relative).map_err(file_error)?;
            let meta = candidate.metadata().map_err(file_error)?;
            let candidate_identity = Handle::from_file(candidate.try_clone().map_err(file_error)?)
                .map_err(file_error)?;
            let identity = self.identity.lock();
            if identity.is_none() {
                return Err("This playback session has ended.".into());
            }
            if meta.len() != self.len
                || meta.modified().map_err(file_error)? != self.modified
                || identity.as_ref() != Some(&candidate_identity)
            {
                return Err("The media file changed. Reload it to continue.".into());
            }
            Ok(candidate)
        })();
        current.map_err(|message| self.invalidate(message))
    }

    async fn pace(&self) {
        let mut next = self.next_read.lock().await;
        tokio::time::sleep_until(*next).await;
        *next = tokio::time::Instant::now() + CHUNK_INTERVAL;
    }
}

fn visible_path(relative: &str) -> Result<PathBuf, String> {
    let path = collab_core::normalize_relative_path(relative).map_err(|err| err.to_string())?;
    if path.components().any(
        |part| !matches!(part, Component::Normal(name) if !name.to_string_lossy().starts_with('.')),
    ) {
        return Err("Select a file visible in the vault.".into());
    }
    Ok(path)
}

fn open_regular(dir: &Dir, path: &Path) -> io::Result<File> {
    // Reject special files and symlinks in the requested path. cap-std also
    // enforces confinement at open, including against parent races.
    if !dir.symlink_metadata(path)?.is_file() {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "Not a regular file",
        ));
    }
    let mut options = cap_std::fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use cap_std::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NONBLOCK);
    }
    let file = dir.open_with(path, &options)?.into_std();
    if !file.metadata()?.is_file() {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "Not a regular file",
        ));
    }
    Ok(file)
}

fn file_error(error: io::Error) -> String {
    match error.kind() {
        io::ErrorKind::NotFound => "The media file is missing.".into(),
        io::ErrorKind::PermissionDenied => "The media file is no longer accessible.".into(),
        _ => "Could not read the local media file.".into(),
    }
}

pub(super) fn import(
    state: &AppState,
    root: &str,
    source: &Path,
    folder: &str,
    name: &str,
) -> Result<String, String> {
    let active = state.active_vault.read();
    authorize_active(state, active.as_ref(), root)?;
    let vault = Dir::open_ambient_dir(root, ambient_authority()).map_err(file_error)?;
    let folder = visible_path(folder)?;
    if !folder.as_os_str().is_empty() {
        vault.create_dir_all(&folder).map_err(file_error)?;
    }
    let mut input = File::open(source).map_err(file_error)?;
    if !input.metadata().map_err(file_error)?.is_file() {
        return Err("Select a regular media file.".into());
    }
    let temporary = folder.join(format!(
        ".collab-media-{}.tmp",
        uuid::Uuid::new_v4().simple()
    ));
    let mut output = vault
        .open_with(
            &temporary,
            cap_std::fs::OpenOptions::new().write(true).create_new(true),
        )
        .map_err(file_error)?;
    let result = (|| {
        io::copy(&mut input, &mut output).map_err(file_error)?;
        output.sync_all().map_err(file_error)?;
        drop(output);
        let path = Path::new(name);
        let stem = path
            .file_stem()
            .and_then(|stem| stem.to_str())
            .unwrap_or("media");
        let ext = extension(path);
        for suffix in 0..1000 {
            let target = folder.join(if suffix == 0 {
                name.to_owned()
            } else {
                format!("{stem}-{suffix}.{ext}")
            });
            match vault.hard_link(&temporary, &vault, &target) {
                Ok(()) => return Ok(target.to_string_lossy().replace('\\', "/")),
                Err(error) if error.kind() == io::ErrorKind::AlreadyExists => continue,
                Err(error) => return Err(file_error(error)),
            }
        }
        Err("Too many files share this name.".into())
    })();
    let _ = vault.remove_file(temporary);
    result
}

fn read_caption(vault: &Dir, path: &Path) -> Result<Caption, String> {
    let ext = extension(path);
    if !matches!(ext.as_str(), "vtt" | "srt") {
        return Err("Select a WebVTT (.vtt) or SubRip (.srt) caption file.".into());
    }
    let file = open_regular(vault, path).map_err(file_error)?;
    let mut text = String::new();
    file.take(MAX_CAPTION_BYTES + 1)
        .read_to_string(&mut text)
        .map_err(|_| "Captions must be UTF-8 text.")?;
    if text.len() as u64 > MAX_CAPTION_BYTES {
        return Err("Caption files are limited to 1 MiB.".into());
    }
    let text = text.trim_start_matches('\u{feff}');
    let vtt = if ext == "srt" {
        srt_to_vtt(text)?
    } else if text == "WEBVTT"
        || text.starts_with("WEBVTT\n")
        || text.starts_with("WEBVTT\r")
        || text.starts_with("WEBVTT ")
        || text.starts_with("WEBVTT\t")
    {
        text.to_owned()
    } else {
        return Err("This file does not have a WebVTT header.".into());
    };
    Ok(Caption {
        label: path
            .file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .into_owned(),
        vtt: Bytes::from(vtt),
    })
}

fn srt_to_vtt(text: &str) -> Result<String, String> {
    let mut vtt = String::from("WEBVTT\n\n");
    let text = text.replace("\r\n", "\n").replace('\r', "\n");
    let mut timing_found = false;
    for block in text
        .split("\n\n")
        .map(str::trim)
        .filter(|block| !block.is_empty())
    {
        let mut lines = block.lines();
        let first = lines.next().unwrap_or_default();
        let timing = if first.chars().all(|c| c.is_ascii_digit()) {
            lines.next().unwrap_or_default()
        } else {
            first
        };
        let Some((start, end)) = timing.split_once(" --> ") else {
            continue;
        };
        let valid = |stamp: &str| {
            stamp.len() == 12
                && stamp.bytes().enumerate().all(|(index, byte)| match index {
                    2 | 5 => byte == b':',
                    8 => matches!(byte, b',' | b'.'),
                    _ => byte.is_ascii_digit(),
                })
        };
        if !valid(start) || !valid(end) {
            continue;
        }
        timing_found = true;
        vtt.push_str(&timing.replace(',', "."));
        vtt.push('\n');
        for line in lines {
            vtt.push_str(line);
            vtt.push('\n');
        }
        vtt.push('\n');
    }
    if !timing_found {
        return Err("No valid SubRip caption timings were found.".into());
    }
    Ok(vtt)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlaybackSource {
    id: String,
    url: String,
    revision: String,
    captions: Vec<PlaybackCaption>,
    audio_tracks: Vec<String>,
    audio_metadata: Option<AudioDetails>,
    #[serde(skip_serializing_if = "Option::is_none")]
    offline: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    can_download_offline: Option<bool>,
}
#[derive(Serialize)]
struct PlaybackCaption {
    label: String,
    url: String,
    language: String,
}

fn authorize_active(
    state: &AppState,
    active: Option<&crate::models::vault::VaultMeta>,
    root: &str,
) -> Result<(), String> {
    if !active.is_some_and(|vault| vault.kind == VaultKind::Local && vault.path == root) {
        return Err("The local vault is no longer active.".into());
    }
    if active.is_some_and(|vault| vault.is_encrypted)
        || state.encryption_key.read().is_some()
        || read_vault_config_pub(root)?.is_encrypted
    {
        return Err("Playback is unavailable in encrypted vaults.".into());
    }
    Ok(())
}

#[tauri::command]
pub async fn open_local_playback(
    state: State<'_, AppState>,
    window: WebviewWindow,
    vault_path: String,
    relative_path: String,
    caption_path: Option<String>,
    compatibility: Option<bool>,
    audio_track: Option<usize>,
    preview: Option<bool>,
    restore_revision: Option<String>,
) -> Result<PlaybackSource, String> {
    if window.label() != "main" {
        return Err("Playback is available from the main window.".into());
    }
    let address = state.playback.address().await?;
    let app = window.app_handle().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        register(
            &state,
            address,
            &vault_path,
            &relative_path,
            caption_path.as_deref(),
            compatibility.unwrap_or(false),
            audio_track,
            preview.unwrap_or(false),
            restore_revision.as_deref(),
        )
    })
    .await
    .map_err(|_| "Could not open the local playback source.")?
}

fn register(
    state: &AppState,
    address: SocketAddr,
    vault_path: &str,
    relative_path: &str,
    caption_path: Option<&str>,
    compatibility: bool,
    audio_track: Option<usize>,
    preview: bool,
    restore_revision: Option<&str>,
) -> Result<PlaybackSource, String> {
    let _mutation = crate::local_mutation::lock_path(Path::new(vault_path))?;
    let active = state.active_vault.read();
    authorize_active(state, active.as_ref(), vault_path)?;
    let mut source = Source::open_with_mode(
        vault_path,
        relative_path,
        caption_path,
        compatibility,
        audio_track,
        restore_revision,
    )?;
    source.preview_budget = PreviewBudget::new(preview);
    let source = Arc::new(source);
    let mut sessions = state.playback.sessions.lock();
    if sessions.len() >= MAX_SESSIONS {
        return Err("Too many local playback sessions. Close another player and try again.".into());
    }
    let id = uuid::Uuid::new_v4().simple().to_string();
    let base = format!("http://{address}/{id}");
    sessions.insert(id.clone(), source.clone());
    let reply = PlaybackSource {
        id: id.clone(),
        url: format!("{base}/media"),
        revision: source.revision.clone(),
        audio_tracks: source.audio.clone(),
        offline: None,
        can_download_offline: None,
        audio_metadata: source
            .audio_metadata
            .as_ref()
            .map(|metadata| metadata.details(&base)),
        captions: source
            .captions
            .iter()
            .enumerate()
            .map(|(index, caption)| PlaybackCaption {
                label: caption.label.clone(),
                url: format!("{base}/{index}.vtt"),
                language: String::new(),
            })
            .chain(
                source
                    .embedded
                    .iter()
                    .enumerate()
                    .map(|(index, track)| PlaybackCaption {
                        label: format!("Embedded subtitle {}", index + 1),
                        language: track.language.clone(),
                        url: format!("{base}/embedded-{index}.vtt"),
                    }),
            )
            .collect(),
    };
    let playback = Arc::downgrade(&state.playback);
    tauri::async_runtime::spawn(async move {
        loop {
            tokio::select! {
                _ = source.cancel.cancelled() => {
                    if source.failure.lock().is_some() {
                        tokio::time::sleep(Duration::from_secs(8)).await;
                        if let Some(playback) = playback.upgrade() {
                            playback.remove(&id);
                        }
                    }
                    break;
                }
                _ = tokio::time::sleep(Duration::from_secs(5)) => {
                    if source.touched.lock().elapsed() >= SOURCE_IDLE {
                        if let Some(playback) = playback.upgrade() {
                            playback.remove(&id);
                        }
                        break;
                    }
                }
            }
        }
    });
    Ok(reply)
}

#[tauri::command]
pub async fn check_local_playback(state: State<'_, AppState>, id: String) -> Result<(), String> {
    let hosted = state.playback.hosted.lock().get(&id);
    if let Some(source) = hosted {
        return source.check().await;
    }
    let source = state
        .playback
        .get(&id)
        .ok_or("This playback session has ended.")?;
    let result = tokio::task::spawn_blocking({
        let source = source.clone();
        move || source.current().map(|_| ())
    })
    .await
    .map_err(|_| "Could not verify the local media file.")?;
    result?;
    *source.touched.lock() = tokio::time::Instant::now();
    Ok(())
}

#[tauri::command]
pub fn close_local_playback(state: State<AppState>, id: String) {
    state.playback.remove(&id);
}

#[tauri::command]
pub fn open_media_externally(
    state: State<AppState>,
    app: AppHandle,
    vault_path: String,
    relative_path: String,
) -> Result<(), String> {
    let _mutation = crate::local_mutation::lock_path(Path::new(&vault_path))?;
    let active = state.active_vault.read();
    authorize_active(&state, active.as_ref(), &vault_path)?;
    let relative = visible_path(&relative_path)?;
    let source = Source::open(&vault_path, &relative_path, None)?;
    source.current()?;
    let path = files::resolve_vault_path(&vault_path, &relative_path)?;
    let canonical = path.canonicalize().map_err(file_error)?;
    let root = Path::new(&vault_path).canonicalize().map_err(file_error)?;
    if !canonical.starts_with(&root) || canonical != root.join(relative) {
        return Err("Only regular files inside the vault can be opened externally.".into());
    }
    app.opener()
        .open_path(canonical.to_string_lossy(), None::<&str>)
        .map_err(|_| "Could not open the default media application.".into())
}

#[derive(Clone)]
struct HttpServer {
    address: SocketAddr,
    playback: Arc<Playback>,
    slots: Arc<Semaphore>,
    local_reads: Arc<Semaphore>,
}

type Reply = Response<Body>;

fn reply(status: StatusCode, mime: &str, body: Body) -> Reply {
    Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, mime)
        .header(header::CACHE_CONTROL, "no-store")
        .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
        .header(header::X_CONTENT_TYPE_OPTIONS, "nosniff")
        .header(
            header::CONTENT_SECURITY_POLICY,
            "sandbox; default-src 'none'",
        )
        .body(body)
        .expect("static media headers")
}

fn artwork_reply(metadata: Option<&AudioMetadata>, method: Method) -> Reply {
    let Some(artwork) = metadata.and_then(|metadata| metadata.artwork.as_ref()) else {
        return empty(StatusCode::NOT_FOUND);
    };
    let body = if method == Method::HEAD {
        Body::empty()
    } else {
        Body::from(artwork.clone())
    };
    let mut response = reply(StatusCode::OK, "image/png", body);
    response
        .headers_mut()
        .insert(header::CONTENT_LENGTH, artwork.len().into());
    response
}

fn empty(status: StatusCode) -> Reply {
    reply(status, "text/plain", Body::empty())
}

fn range(value: &str, size: u64) -> Option<(u64, u64)> {
    let (start, end) = value.strip_prefix("bytes=")?.split_once('-')?;
    let last = size.checked_sub(1)?;
    let number = |text: &str| {
        text.bytes()
            .all(|b| b.is_ascii_digit())
            .then(|| text.parse::<u64>().ok())
            .flatten()
    };
    if start.is_empty() {
        let count = number(end)?;
        return (count > 0).then_some((size.saturating_sub(count), last));
    }
    let start = number(start)?;
    let end = if end.is_empty() {
        last
    } else {
        last.min(number(end)?)
    };
    (start <= end).then_some((start, end))
}

async fn serve(
    HttpState(server): HttpState<HttpServer>,
    RoutePath((id, asset)): RoutePath<(String, String)>,
    method: Method,
    headers: HeaderMap,
) -> Reply {
    if headers
        .get(header::HOST)
        .and_then(|value| value.to_str().ok())
        != Some(server.address.to_string().as_str())
    {
        return empty(StatusCode::FORBIDDEN);
    }
    let hosted = server.playback.hosted.lock().get(&id);
    if let Some(source) = hosted {
        return hosted::serve(source, server.slots, &asset, method, headers).await;
    }
    let Some(source) = server.playback.get(&id) else {
        return empty(StatusCode::NOT_FOUND);
    };
    let Ok(Ok(check_slot)) = tokio::time::timeout(
        Duration::from_secs(2),
        server.local_reads.clone().acquire_owned(),
    )
    .await
    else {
        return empty(StatusCode::SERVICE_UNAVAILABLE);
    };
    let check = source.clone();
    if !matches!(
        tokio::task::spawn_blocking(move || {
            let _slot = check_slot;
            check.current()
        })
        .await,
        Ok(Ok(_))
    ) {
        return empty(StatusCode::GONE);
    }
    *source.touched.lock() = tokio::time::Instant::now();
    if let Some(index) = asset
        .strip_prefix("embedded-")
        .and_then(|name| name.strip_suffix(".vtt"))
        .and_then(|index| index.parse::<usize>().ok())
    {
        let Ok(Ok(slot)) = tokio::time::timeout(
            Duration::from_secs(2),
            server.local_reads.clone().acquire_owned(),
        )
        .await
        else {
            return empty(StatusCode::SERVICE_UNAVAILABLE);
        };
        let text = tokio::task::spawn_blocking(move || {
            let _slot = slot;
            let track = source.embedded.get(index)?;
            let mut file = source.current().ok()?;
            let text = mp4::text_track(&mut file, track, source.len).ok()?;
            let metadata = file.metadata().ok()?;
            (!source.cancel.is_cancelled()
                && metadata.len() == source.len
                && metadata.modified().ok()? == source.modified)
                .then_some(text)
        })
        .await
        .ok()
        .flatten();
        return match text {
            Some(text) => reply(StatusCode::OK, "text/vtt; charset=utf-8", Body::from(text)),
            None => empty(StatusCode::UNPROCESSABLE_ENTITY),
        };
    }
    if asset == "artwork" {
        return artwork_reply(source.audio_metadata.as_ref(), method);
    }
    if asset != "media" {
        return asset
            .strip_suffix(".vtt")
            .and_then(|index| index.parse::<usize>().ok())
            .and_then(|index| source.captions.get(index))
            .map_or_else(
                || empty(StatusCode::NOT_FOUND),
                |caption| {
                    let body = if method == Method::HEAD {
                        Body::empty()
                    } else {
                        Body::from(caption.vtt.clone())
                    };
                    let mut response = reply(StatusCode::OK, "text/vtt; charset=utf-8", body);
                    response
                        .headers_mut()
                        .insert(header::CONTENT_LENGTH, caption.vtt.len().into());
                    response
                },
            );
    }
    let (start, end, status) =
        if let Some(value) = headers.get(header::RANGE).filter(|_| method == Method::GET) {
            let Some((start, end)) = value
                .to_str()
                .ok()
                .and_then(|value| range(value, source.len))
            else {
                let mut response = empty(StatusCode::RANGE_NOT_SATISFIABLE);
                response.headers_mut().insert(
                    header::CONTENT_RANGE,
                    format!("bytes */{}", source.len).parse().unwrap(),
                );
                return response;
            };
            (start, end, StatusCode::PARTIAL_CONTENT)
        } else {
            (0, source.len - 1, StatusCode::OK)
        };
    let total = source.len;
    let mime = source.mime;
    let body = if method == Method::HEAD {
        Body::empty()
    } else {
        let Ok(Ok(body_slot)) = tokio::time::timeout(
            Duration::from_secs(2),
            source.bodies.clone().acquire_owned(),
        )
        .await
        else {
            return empty(StatusCode::SERVICE_UNAVAILABLE);
        };
        Body::from_stream(stream::try_unfold(
            (source, body_slot, server.local_reads, start),
            move |(source, body_slot, reads, offset)| async move {
                if offset > end {
                    return Ok::<_, io::Error>(None);
                }
                let count = (end - offset + 1).min(CHUNK as u64) as usize;
                let cancelled = || io::Error::new(io::ErrorKind::Interrupted, "Playback closed");
                tokio::select! {
                    biased;
                    _ = source.cancel.cancelled() => return Err(cancelled()),
                    _ = source.pace() => {}
                }
                source.preview_budget.consume(count as u64)?;
                let permit = tokio::select! {
                    biased;
                    _ = source.cancel.cancelled() => return Err(cancelled()),
                    result = reads.clone().acquire_owned() => result.map_err(|_| cancelled())?,
                };
                let read_source = source.clone();
                let bytes = tokio::task::spawn_blocking(move || {
                    let _permit = permit;
                    let mut file = read_source.current().map_err(io::Error::other)?;
                    file.seek(SeekFrom::Start(offset))?;
                    let mut bytes = vec![0; count];
                    file.read_exact(&mut bytes).map_err(|error| {
                        io::Error::other(read_source.invalidate(file_error(error)))
                    })?;
                    let meta = file.metadata()?;
                    if meta.len() != read_source.len || meta.modified()? != read_source.modified {
                        return Err(io::Error::other(read_source.invalidate(
                            "The media file changed. Reload it to continue.".into(),
                        )));
                    }
                    mp4::apply_overlays(&mut bytes, offset, &read_source.track_overlays);
                    Ok::<_, io::Error>(Bytes::from(bytes))
                })
                .await??;
                if source.cancel.is_cancelled() {
                    return Err(cancelled());
                }
                Ok(Some((
                    bytes,
                    (source, body_slot, reads, offset + count as u64),
                )))
            },
        ))
    };
    let mut response = reply(status, mime, body);
    response
        .headers_mut()
        .insert(header::ACCEPT_RANGES, "bytes".parse().unwrap());
    response
        .headers_mut()
        .insert(header::CONTENT_LENGTH, (end - start + 1).into());
    if status == StatusCode::PARTIAL_CONTENT {
        response.headers_mut().insert(
            header::CONTENT_RANGE,
            format!("bytes {start}-{end}/{total}").parse().unwrap(),
        );
    }
    response
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn preview_budget_counts_all_ranges_and_leaves_regular_sessions_unlimited() {
        let preview = PreviewBudget::new(true);
        assert!(preview.consume(MAX_PREVIEW_BYTES - 2).is_ok());
        assert!(preview.consume(3).is_err());
        assert!(preview.consume(2).is_ok());
        assert!(preview.consume(1).is_err());
        assert!(PreviewBudget::default().consume(u64::MAX).is_ok());
    }

    #[test]
    fn validates_byte_ranges_and_converts_subrip() {
        assert_eq!(range("bytes=1-3", 10), Some((1, 3)));
        assert_eq!(range("bytes=8-", 10), Some((8, 9)));
        assert_eq!(range("bytes=-3", 10), Some((7, 9)));
        assert_eq!(range("bytes=10-", 10), None);
        assert_eq!(range("bytes=0-3,5-7", 10), None);
        assert_eq!(
            srt_to_vtt("1\r\n00:00:01,000 --> 00:00:03,500\r\nHello, world!").unwrap(),
            "WEBVTT\n\n00:00:01.000 --> 00:00:03.500\nHello, world!\n\n",
        );
        assert!(srt_to_vtt("invalid").is_err());
    }

    #[test]
    fn rejects_encryption_and_replaced_files() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("song.wav");
        std::fs::write(&path, b"CENC encrypted").unwrap();
        let root = root.path().to_str().unwrap();
        assert!(Source::open(root, "song.wav", None)
            .err()
            .unwrap()
            .contains("Encrypted"));
        assert!(Source::open(root, "../outside.wav", None).is_err());
        assert!(Source::open(root, ".collab/private.wav", None).is_err());
        std::fs::write(&path, b"RIFF test").unwrap();
        let original = Source::open(root, "song.wav", None).unwrap();
        assert!(original.current().is_ok());
        assert_eq!(
            original.revision,
            Source::open(root, "song.wav", None).unwrap().revision
        );
        std::fs::rename(&path, path.with_extension("old")).unwrap();
        assert!(original.current().unwrap_err().contains("missing"));
        std::fs::write(&path, b"RIFF test").unwrap();
        assert!(original.current().unwrap_err().contains("missing"));
        assert_ne!(
            original.revision,
            Source::open(root, "song.wav", None).unwrap().revision
        );
    }

    #[test]
    fn reopens_a_replaced_revision_without_its_old_track_options() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("clip.mp4");
        std::fs::write(&path, b"original").unwrap();
        let directory = root.path().to_str().unwrap();
        let previous = Source::open(directory, "clip.mp4", None).unwrap();
        std::fs::rename(&path, path.with_extension("old")).unwrap();
        std::fs::write(&path, b"replaced").unwrap();

        assert!(previous.current().unwrap_err().contains("changed"));
        let replacement = Source::open_with_mode(
            directory,
            "clip.mp4",
            Some("deleted.srt"),
            true,
            Some(2),
            Some(&previous.revision),
        )
        .unwrap();
        assert_ne!(previous.revision, replacement.revision);
        assert!(replacement.captions.is_empty());
        assert!(replacement.track_overlays.is_empty());
    }

    fn test_http(playback: Arc<Playback>) -> HttpServer {
        HttpServer {
            address: "127.0.0.1:54321".parse().unwrap(),
            playback,
            slots: Arc::new(Semaphore::new(MAX_STREAMS)),
            local_reads: Arc::new(Semaphore::new(MAX_STREAMS)),
        }
    }

    async fn test_range(server: &HttpServer, id: &str, range: &str) -> Reply {
        let mut headers = HeaderMap::new();
        headers.insert(header::HOST, server.address.to_string().parse().unwrap());
        headers.insert(header::RANGE, range.parse().unwrap());
        serve(
            HttpState(server.clone()),
            RoutePath((id.into(), "media".into())),
            Method::GET,
            headers,
        )
        .await
    }

    #[tokio::test]
    async fn outstanding_ranges_leave_capacity_for_a_seek_and_close_revokes_all_bodies() {
        use futures_util::StreamExt;
        let root = tempfile::tempdir().unwrap();
        std::fs::write(root.path().join("clip.mp4"), vec![7; 2 * CHUNK]).unwrap();
        let playback = Arc::new(Playback::default());
        let source =
            Arc::new(Source::open(root.path().to_str().unwrap(), "clip.mp4", None).unwrap());
        playback
            .sessions
            .lock()
            .insert("test".into(), source.clone());
        let server = test_http(playback.clone());
        let mut bodies = Vec::new();
        for _ in 0..MAX_STREAMS {
            let response = test_range(&server, "test", "bytes=0-").await;
            assert_eq!(response.status(), StatusCode::PARTIAL_CONTENT);
            let mut body = response.into_body().into_data_stream();
            assert_eq!(body.next().await.unwrap().unwrap().len(), CHUNK);
            bodies.push(body);
        }
        let seek = test_range(&server, "test", "bytes=-4").await;
        assert_eq!(seek.status(), StatusCode::PARTIAL_CONTENT);
        assert_eq!(
            axum::body::to_bytes(seek.into_body(), 4).await.unwrap(),
            &[7; 4][..]
        );
        playback.remove("test");
        assert!(source.identity.lock().is_none());
        for mut body in bodies {
            assert!(body.next().await.unwrap().is_err());
        }
        assert_eq!(
            test_range(&server, "test", "bytes=-4").await.status(),
            StatusCode::NOT_FOUND
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn permission_loss_terminates_an_in_flight_range() {
        use futures_util::StreamExt;
        use std::os::unix::fs::PermissionsExt;

        // Root can read regardless of ordinary Unix mode bits.
        if unsafe { libc::geteuid() } == 0 {
            return;
        }
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("clip.mp4");
        std::fs::write(&path, vec![7; 2 * CHUNK]).unwrap();
        let playback = Arc::new(Playback::default());
        let source =
            Arc::new(Source::open(root.path().to_str().unwrap(), "clip.mp4", None).unwrap());
        playback
            .sessions
            .lock()
            .insert("test".into(), source.clone());
        let server = test_http(playback);
        let response = test_range(&server, "test", "bytes=0-").await;
        let mut body = response.into_body().into_data_stream();
        assert_eq!(body.next().await.unwrap().unwrap().len(), CHUNK);
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0)).unwrap();
        assert!(body.next().await.unwrap().is_err());
        assert!(source
            .current()
            .unwrap_err()
            .contains("no longer accessible"));
        assert!(source.identity.lock().is_none());
        assert_eq!(
            test_range(&server, "test", "bytes=0-").await.status(),
            StatusCode::GONE
        );
    }

    #[cfg(unix)]
    #[test]
    fn cannot_follow_symlinks_outside_the_vault() {
        let root = tempfile::tempdir().unwrap();
        let other = tempfile::tempdir().unwrap();
        std::fs::write(other.path().join("song.wav"), b"RIFF test").unwrap();
        std::os::unix::fs::symlink(other.path(), root.path().join("outside")).unwrap();
        assert!(Source::open(root.path().to_str().unwrap(), "outside/song.wav", None).is_err());
    }

    #[tokio::test]
    async fn streams_a_large_file_range_and_revokes_the_handle() {
        let root = tempfile::tempdir().unwrap();
        let mut file = File::create(root.path().join("video.mp4")).unwrap();
        // Windows may reserve physical storage when extending a regular file.
        let size = if cfg!(unix) {
            36_100_000_000
        } else {
            600 * 1024 * 1024
        };
        file.seek(SeekFrom::Start(size - 4)).unwrap();
        std::io::Write::write_all(&mut file, b"tail").unwrap();
        drop(file);
        std::fs::write(root.path().join("video.vtt"), b"WEBVTT\n\n").unwrap();
        let playback = Arc::new(Playback::default());
        let source =
            Arc::new(Source::open(root.path().to_str().unwrap(), "video.mp4", None).unwrap());
        playback
            .sessions
            .lock()
            .insert("test".into(), source.clone());
        let address = playback.address().await.unwrap();
        let base = format!("http://{address}/test");
        let client = reqwest::Client::builder().no_proxy().build().unwrap();
        let request = client.get(format!("{base}/media"));
        let start = size - 4;
        let end = size - 1;
        let range = request
            .try_clone()
            .unwrap()
            .header(header::RANGE, format!("bytes={start}-{end}"))
            .send()
            .await
            .unwrap();
        assert_eq!(range.status(), StatusCode::PARTIAL_CONTENT);
        assert_eq!(
            range.headers()[header::CONTENT_RANGE],
            format!("bytes {start}-{end}/{size}").as_str()
        );
        assert_eq!(&range.bytes().await.unwrap()[..], b"tail");
        let mut read_ahead = request
            .try_clone()
            .unwrap()
            .header(header::RANGE, "bytes=0-16777215")
            .send()
            .await
            .unwrap();
        assert_eq!(read_ahead.status(), StatusCode::PARTIAL_CONTENT);
        let started = std::time::Instant::now();
        let mut bytes = 0;
        while let Some(chunk) = read_ahead.chunk().await.unwrap() {
            bytes += chunk.len();
        }
        assert_eq!(bytes, 16 * 1024 * 1024);
        eprintln!(
            "16 MiB local range body streamed in {:?}",
            started.elapsed()
        );
        let caption = client.get(format!("{base}/0.vtt")).send().await.unwrap();
        assert_eq!(caption.text().await.unwrap(), "WEBVTT\n\n");
        let mut live = request.try_clone().unwrap().send().await.unwrap();
        assert!(live.chunk().await.unwrap().is_some());
        playback.clear();
        assert!(source.cancel.is_cancelled());
        assert_eq!(
            request.send().await.unwrap().status(),
            StatusCode::NOT_FOUND
        );
        loop {
            match live.chunk().await {
                Ok(Some(_)) => continue,
                Err(_) => break,
                Ok(None) => panic!("the full stream survived revocation"),
            }
        }
    }
}
