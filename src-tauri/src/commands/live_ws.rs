//! Backend proxy for live-collaboration WebSockets.
//!
//! The webview cannot open a `wss://` socket to a server with an untrusted
//! (self-signed / hostname-mismatched) certificate: `new WebSocket()` enforces
//! the platform TLS policy and the per-session "untrusted certificate" opt-in —
//! which only applies to the Rust `reqwest` client — cannot reach it. That left
//! live co-editing dead against private servers even though REST worked.
//!
//! These commands move the live socket into Rust so it rides the *same* TLS
//! configuration as every other hosted request (via
//! [`crate::hosted_client::ws_server_client`], honoring `allow_invalid_certificates`; it
//! is HTTP/1.1-only because the WS upgrade fails over the HTTP/2 a modern server
//! would negotiate via ALPN). The webview drives the socket over the
//! Tauri IPC boundary: control/CRDT frames are sent with [`live_ws_send`] and
//! inbound frames are streamed back through a [`Channel`]. The app-level protocol
//! handshake (authenticate / subscribe / Yjs sync) still runs in the frontend
//! exactly as before — only the transport moved.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};

use base64::Engine;
use futures_util::{SinkExt, StreamExt};
use reqwest_websocket::{Message, RequestBuilderExt};
use serde::Serialize;
use tauri::ipc::Channel;
use tauri::State;
use tokio::sync::{mpsc, Mutex};

use crate::hosted_client::ws_server_client;
use crate::hosted_session::session_for;
use crate::state::AppState;

/// An inbound event forwarded from the server socket to the webview.
#[derive(Clone, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum LiveWsEvent {
    /// A text control frame (JSON handshake message).
    Text { data: String },
    /// A binary CRDT/awareness frame, base64-encoded for the IPC boundary.
    Binary { data: String },
    /// The socket closed; `code` is the WebSocket close code when known.
    Closed { code: Option<u16> },
}

struct LiveConn {
    outbound: mpsc::UnboundedSender<Message>,
    reader: tokio::task::JoinHandle<()>,
    writer: tokio::task::JoinHandle<()>,
}

/// Registry of active backend-proxied live sockets, keyed by an opaque id handed
/// back to the webview. Lives on [`AppState`].
#[derive(Default)]
pub struct LiveWsRegistry {
    next_id: AtomicU64,
    conns: Mutex<HashMap<u64, LiveConn>>,
}

fn to_http_url(websocket_url: &str) -> Result<String, String> {
    if let Some(rest) = websocket_url.strip_prefix("wss://") {
        Ok(format!("https://{rest}"))
    } else if let Some(rest) = websocket_url.strip_prefix("ws://") {
        Ok(format!("http://{rest}"))
    } else {
        Err("The live collaboration URL is not a valid WebSocket URL.".to_string())
    }
}

/// Opens a live-collaboration WebSocket to `websocket_url` using the connected
/// server session's TLS configuration, and streams inbound frames to `on_event`.
/// Returns an opaque connection id used by [`live_ws_send`] / [`live_ws_close`].
#[tauri::command]
pub async fn live_ws_connect(
    state: State<'_, AppState>,
    server_url: String,
    websocket_url: String,
    on_event: Channel<LiveWsEvent>,
) -> Result<u64, String> {
    let session = session_for(
        state.hosted_sessions(),
        &server_url,
        "Connect to the Collab server before starting live collaboration.",
    )?;

    // reqwest speaks http(s); the WS upgrade rides that scheme. Reusing the
    // server client is what makes the untrusted-certificate opt-in apply here.
    let http_url = to_http_url(&websocket_url)?;
    // HTTP/1.1-only: the WS upgrade fails over HTTP/2, which a modern server
    // (valid cert) would otherwise negotiate via ALPN.
    let client = ws_server_client(session.allow_invalid_certificates)?;
    let response = client
        .get(&http_url)
        .upgrade()
        .send()
        .await
        .map_err(|error| format!("Live collaboration connection failed: {error}"))?;
    let websocket = response
        .into_websocket()
        .await
        .map_err(|error| format!("Live collaboration upgrade failed: {error}"))?;
    let (mut sink, mut stream) = websocket.split();

    let (outbound, mut outbound_rx) = mpsc::unbounded_channel::<Message>();

    let writer = tokio::spawn(async move {
        while let Some(message) = outbound_rx.recv().await {
            if sink.send(message).await.is_err() {
                break;
            }
        }
        let _ = sink.close().await;
    });

    let events = on_event.clone();
    let reader = tokio::spawn(async move {
        while let Some(item) = stream.next().await {
            match item {
                Ok(Message::Text(text)) => {
                    let _ = events.send(LiveWsEvent::Text { data: text });
                }
                Ok(Message::Binary(bytes)) => {
                    let _ = events.send(LiveWsEvent::Binary {
                        data: base64::engine::general_purpose::STANDARD.encode(&bytes),
                    });
                }
                Ok(Message::Close { code, .. }) => {
                    let _ = events.send(LiveWsEvent::Closed {
                        code: Some(u16::from(code)),
                    });
                    return;
                }
                Ok(Message::Ping(_)) | Ok(Message::Pong(_)) => {}
                Err(_) => break,
            }
        }
        let _ = events.send(LiveWsEvent::Closed { code: None });
    });

    let id = state.live_ws.next_id.fetch_add(1, Ordering::Relaxed);
    state.live_ws.conns.lock().await.insert(
        id,
        LiveConn {
            outbound,
            reader,
            writer,
        },
    );
    Ok(id)
}

/// Sends a frame over a proxied live socket. `kind` is `"text"` for JSON control
/// frames or `"binary"` for base64-encoded CRDT/awareness frames.
#[tauri::command]
pub async fn live_ws_send(
    state: State<'_, AppState>,
    id: u64,
    kind: String,
    data: String,
) -> Result<(), String> {
    let message = match kind.as_str() {
        "text" => Message::Text(data),
        "binary" => Message::Binary(
            base64::engine::general_purpose::STANDARD
                .decode(data.as_bytes())
                .map_err(|_| "Invalid live collaboration frame.".to_string())?
                .into(),
        ),
        _ => return Err("Unknown live collaboration frame kind.".to_string()),
    };
    let conns = state.live_ws.conns.lock().await;
    let conn = conns
        .get(&id)
        .ok_or_else(|| "The live collaboration connection is closed.".to_string())?;
    conn.outbound
        .send(message)
        .map_err(|_| "The live collaboration connection is closed.".to_string())
}

/// Closes and forgets a proxied live socket. Safe to call for an unknown id.
#[tauri::command]
pub async fn live_ws_close(state: State<'_, AppState>, id: u64) -> Result<(), String> {
    if let Some(conn) = state.live_ws.conns.lock().await.remove(&id) {
        conn.reader.abort();
        conn.writer.abort();
    }
    Ok(())
}
