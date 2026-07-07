//! Live-collaboration WebSocket transport (Phase 5).
//!
//! Clients exchange a single-use ticket (`POST /api/v1/auth/ws-ticket`) for a
//! vault, then open `GET /ws/v1/vaults/{vault_id}` and present that ticket in an
//! `authenticate` control frame. After the server validates the ticket and the
//! user's membership it replies `ready`, and the client may subscribe to
//! individual documents.
//!
//! Two frame shapes travel over the socket:
//!
//! * JSON text frames carry control messages ([`WsClientControl`] /
//!   [`WsServerControl`]): authenticate, subscribe/unsubscribe, ping/pong.
//! * Binary frames carry CRDT and ephemeral awareness traffic:
//!   `[tag: u8][file_id: 16 bytes][payload]`, where the payload is Yjs v1
//!   encoded bytes for `SYNC_STEP1` / `SYNC_UPDATE`, or a y-protocols awareness
//!   update for `AWARENESS`.
//!
//! Authorization is enforced on every message: a session needs vault read
//! access to subscribe and editor (`file.write`) access on an active vault to
//! apply updates. Viewers receive a read-only stream.

use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, Mutex as StdMutex,
    },
    time::{Duration, Instant},
};

use axum::{
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        Path, State,
    },
    response::Response,
};
use collab_protocol::{
    ws_message, Capability, ErrorCode, HostedVaultRole, HostedVaultStatus, WsClientControl,
    WsServerControl, PROTOCOL_VERSION,
};
use futures_util::{sink::SinkExt, stream::StreamExt};
use sqlx::{PgPool, Row};
use tokio::sync::{broadcast, mpsc, Mutex, Notify};
use uuid::Uuid;
use yrs::{
    types::ToJson,
    updates::{decoder::Decode, encoder::Encode},
    Any, ArrayPrelim, Doc, GetString, In, Map, MapPrelim, ReadTxn, StateVector, Text, Transact,
    Update,
};

use crate::{api, app::AppState, auth::hash_secret, storage::BlobStorage};

/// The Yjs text type name shared between the server and the browser for note
/// documents. Both sides bind their CodeMirror/`yrs` text to this name.
const NOTE_TEXT_NAME: &str = "content";

/// The Yjs root map name shared between the server and the browser for
/// structured (Kanban / canvas) documents.
const JSON_ROOT_NAME: &str = "doc";

/// What kind of materialization a room performs into REST revisions.
#[derive(Clone, Copy, PartialEq, Eq)]
enum MaterializeKind {
    /// Not materialized (unknown document type).
    None,
    /// Note: the `content` Yjs text is written verbatim.
    NoteText,
    /// Kanban: the `doc` Yjs map is serialized to JSON.
    Json,
    /// Canvas: the `doc` Yjs map is serialized to JSON, with extra integrity
    /// guards because a degenerate live state can wipe a node graph.
    Canvas,
}

impl MaterializeKind {
    /// Whether this document materializes through the structured `doc` map.
    fn is_structured(self) -> bool {
        matches!(self, MaterializeKind::Json | MaterializeKind::Canvas)
    }
}

/// How long a document must be quiet (no new updates) before its live CRDT state
/// is materialized into a normal text revision.
const MATERIALIZE_DEBOUNCE: Duration = Duration::from_millis(1500);
const MAX_AWARENESS_BYTES: usize = 64 * 1024;

/// Per-connection inbound message flood guard. A single authenticated socket may
/// send at most this many frames per [`MESSAGE_FLOOD_WINDOW`]; this is far above
/// what fast collaborative editing produces and only trips on a runaway or
/// hostile client, which is then disconnected (and can reconnect and re-sync via
/// the state-vector handshake). This complements the coarse per-IP connection
/// rate limit applied at the HTTP upgrade.
const MESSAGE_FLOOD_LIMIT: usize = 2_000;
const MESSAGE_FLOOD_WINDOW: Duration = Duration::from_secs(10);

/// A live document update broadcast to every session subscribed to a file.
#[derive(Clone)]
struct RoomBroadcast {
    /// Session that produced the update, so it is not echoed back to its author.
    origin: Uuid,
    tag: u8,
    payload: Arc<Vec<u8>>,
}

/// In-memory shared state for one collaborative document.
struct Room {
    file_id: Uuid,
    vault_id: Uuid,
    /// How this document's live state is materialized into REST revisions.
    materialize: MaterializeKind,
    /// The authoritative materialized CRDT document. Guarded by `seq` for writes;
    /// reads take a short lock for state-vector / diff snapshots.
    doc: StdMutex<Doc>,
    /// Last persisted update sequence. The async lock also serializes
    /// apply+persist+broadcast so the update log stays strictly ordered.
    seq: Mutex<i64>,
    /// The author of the most recent applied update, attributed to materialized
    /// revisions.
    last_author: StdMutex<Option<Uuid>>,
    /// Pulsed after each applied update to wake the debounced materializer.
    dirty: Notify,
    /// Latest opaque awareness update from each connected session. This is
    /// in-memory only and is removed when the session unsubscribes/disconnects.
    awareness: StdMutex<HashMap<Uuid, Arc<Vec<u8>>>>,
    tx: broadcast::Sender<RoomBroadcast>,
}

impl Room {
    /// Loads a document room from its compacted state plus the append-only log.
    /// A note with no live history yet is seeded from its current REST content so
    /// the first collaborator sees the existing document, not a blank one.
    async fn load(
        db: &PgPool,
        blobs: &Arc<dyn BlobStorage>,
        file_id: Uuid,
        vault_id: Uuid,
    ) -> Result<Self, sqlx::Error> {
        let mut doc = Doc::new();
        let mut last_seq: i64 = 0;
        let mut had_state = false;

        if let Some(row) =
            sqlx::query("SELECT doc_state, update_seq FROM crdt_documents WHERE file_id = $1")
                .bind(file_id)
                .fetch_optional(db)
                .await?
        {
            had_state = true;
            let state: Vec<u8> = row.get("doc_state");
            last_seq = row.get("update_seq");
            apply_update_bytes(&doc, &state);
        }

        let updates = sqlx::query(
            "SELECT seq, update_bytes FROM crdt_updates WHERE file_id = $1 AND seq > $2 ORDER BY seq ASC",
        )
        .bind(file_id)
        .bind(last_seq)
        .fetch_all(db)
        .await?;
        let had_updates = !updates.is_empty();
        for row in updates {
            let bytes: Vec<u8> = row.get("update_bytes");
            apply_update_bytes(&doc, &bytes);
            last_seq = row.get("seq");
        }

        let document_type: Option<String> = sqlx::query_scalar(
            "SELECT document_type::text FROM hosted_file_entries WHERE id = $1 AND vault_id = $2",
        )
        .bind(file_id)
        .bind(vault_id)
        .fetch_optional(db)
        .await?
        .flatten();
        let materialize = match document_type.as_deref() {
            Some("note") => MaterializeKind::NoteText,
            Some("kanban") => MaterializeKind::Json,
            Some("canvas") => MaterializeKind::Canvas,
            _ => MaterializeKind::None,
        };

        let current_content =
            api::load_current_document_text(db, &**blobs, vault_id, file_id).await;

        // Seed a fresh room from existing REST content so the first collaborator
        // sees the existing document, not a blank one.
        if !had_state && !had_updates {
            if let Some(content) = current_content.as_deref() {
                match materialize {
                    MaterializeKind::NoteText if !content.is_empty() => {
                        let text = doc.get_or_insert_text(NOTE_TEXT_NAME);
                        let mut txn = doc.transact_mut();
                        text.insert(&mut txn, 0, &content);
                    }
                    MaterializeKind::Json | MaterializeKind::Canvas => {
                        seed_structured_doc(&doc, content);
                    }
                    _ => {}
                }
            }
        } else if materialize == MaterializeKind::NoteText {
            // Defensive recovery for early Phase 5 rooms that could record an
            // empty CRDT before the initial server seed reached the client.
            // Prefer a non-empty current revision over an empty live document;
            // a genuinely cleared note already has an empty REST revision.
            let text = doc.get_or_insert_text(NOTE_TEXT_NAME);
            let is_empty = text.get_string(&doc.transact()).is_empty();
            if is_empty {
                if let Some(content) = current_content
                    .as_deref()
                    .filter(|content| !content.is_empty())
                {
                    let mut txn = doc.transact_mut();
                    text.insert(&mut txn, 0, content);
                }
            }
        } else if materialize.is_structured() && (had_state || had_updates) {
            // Integrity recovery for structured (especially canvas) rooms. An
            // earlier startup race could persist a degenerate live state — an
            // empty root, or a canvas that lost all of its nodes — over a valid
            // canonical revision. When the persisted live state is degenerate
            // relative to the current REST content, reset the room: reseed from
            // REST and compact the CRDT log so the bad state cannot resurface.
            if let Some(content) = current_content
                .as_deref()
                .filter(|content| !content.trim().is_empty())
            {
                let live_json = doc_json_content(&doc);
                let root_empty = live_json.is_none();
                let lost_canvas_nodes = materialize == MaterializeKind::Canvas
                    && canvas_node_count(content).unwrap_or(0) > 0
                    && live_json
                        .as_deref()
                        .and_then(canvas_node_count)
                        .unwrap_or(0)
                        == 0;
                if root_empty || lost_canvas_nodes {
                    let fresh = Doc::new();
                    seed_structured_doc(&fresh, content);
                    let state = fresh
                        .transact()
                        .encode_state_as_update_v1(&StateVector::default());
                    sqlx::query("DELETE FROM crdt_updates WHERE file_id = $1")
                        .bind(file_id)
                        .execute(db)
                        .await?;
                    sqlx::query(
                        r#"
                        INSERT INTO crdt_documents (file_id, vault_id, doc_state, update_seq, updated_at)
                        VALUES ($1, $2, $3, 0, NOW())
                        ON CONFLICT (file_id)
                        DO UPDATE SET doc_state = EXCLUDED.doc_state, update_seq = 0, updated_at = NOW()
                        "#,
                    )
                    .bind(file_id)
                    .bind(vault_id)
                    .bind(&state)
                    .execute(db)
                    .await?;
                    doc = fresh;
                    last_seq = 0;
                }
            }
        }

        let (tx, _rx) = broadcast::channel(256);
        Ok(Self {
            file_id,
            vault_id,
            materialize,
            doc: StdMutex::new(doc),
            seq: Mutex::new(last_seq),
            last_author: StdMutex::new(None),
            dirty: Notify::new(),
            awareness: StdMutex::new(HashMap::new()),
            tx,
        })
    }

    /// Reads the current note text from the live document.
    fn note_text(&self) -> String {
        let doc = self.doc.lock().expect("room doc lock poisoned");
        let text = doc.get_or_insert_text(NOTE_TEXT_NAME);
        let value = text.get_string(&doc.transact());
        value
    }

    /// Serializes the structured (Kanban / canvas) live document to JSON, or
    /// `None` when the root map is empty (not yet seeded) so an empty document is
    /// never materialized over real content.
    fn json_content(&self) -> Option<String> {
        let doc = self.doc.lock().expect("room doc lock poisoned");
        doc_json_content(&doc)
    }

    /// The room's current Yjs v1 state vector.
    fn state_vector(&self) -> Vec<u8> {
        let doc = self.doc.lock().expect("room doc lock poisoned");
        let bytes = doc.transact().state_vector().encode_v1();
        bytes
    }

    /// A Yjs v1 update carrying everything the room knows that the peer (described
    /// by `remote_sv`) is missing. Returns `None` if the state vector is invalid.
    fn diff(&self, remote_sv: &[u8]) -> Option<Vec<u8>> {
        let sv = StateVector::decode_v1(remote_sv).ok()?;
        let doc = self.doc.lock().expect("room doc lock poisoned");
        let update = doc.transact().encode_state_as_update_v1(&sv);
        Some(update)
    }

    /// Applies a remote update: validates it, persists it to the append-only log,
    /// applies it to the in-memory document, then broadcasts it to peers. The
    /// async lock keeps sequence allocation, persistence, and broadcast ordered.
    async fn apply_remote_update(
        &self,
        db: &PgPool,
        update_bytes: &[u8],
        author: Uuid,
        origin: Uuid,
        debug: bool,
    ) -> Result<(), sqlx::Error> {
        // Validate the update before allocating a sequence or touching the doc.
        if Update::decode_v1(update_bytes).is_err() {
            return Ok(());
        }
        let mut seq_guard = self.seq.lock().await;
        let content_before = self.materialized_content();
        let next = *seq_guard + 1;
        sqlx::query(
            "INSERT INTO crdt_updates (id, file_id, vault_id, seq, update_bytes, author_user_id) VALUES ($1, $2, $3, $4, $5, $6)",
        )
        .bind(Uuid::now_v7())
        .bind(self.file_id)
        .bind(self.vault_id)
        .bind(next)
        .bind(update_bytes)
        .bind(author)
        .execute(db)
        .await?;
        *seq_guard = next;
        apply_update_bytes(
            &self.doc.lock().expect("room doc lock poisoned"),
            update_bytes,
        );
        drop(seq_guard);
        let content_changed = self.materialized_content() != content_before;
        if content_changed {
            *self.last_author.lock().expect("author lock poisoned") = Some(author);
        }
        let delivered = self
            .tx
            .send(RoomBroadcast {
                origin,
                tag: ws_message::SYNC_UPDATE,
                payload: Arc::new(update_bytes.to_vec()),
            })
            .unwrap_or(0);
        if debug {
            tracing::info!(
                target: "collab_server::ws",
                file_id = %self.file_id,
                seq = next,
                bytes = update_bytes.len(),
                content_changed,
                broadcast_receivers = delivered,
                "applied remote SYNC_UPDATE and broadcast to peers"
            );
        }
        // Sync-handshake/no-op updates still belong in the CRDT log for
        // convergence. Wake the quiet-period worker for every valid update so
        // it can compact the CRDT log even when materialized content is
        // unchanged; `persist_materialized_document` itself skips identical
        // REST revisions.
        self.dirty.notify_one();
        Ok(())
    }

    fn materialized_content(&self) -> Option<String> {
        match self.materialize {
            MaterializeKind::NoteText => Some(self.note_text()),
            MaterializeKind::Json | MaterializeKind::Canvas => self.json_content(),
            MaterializeKind::None => None,
        }
    }

    /// Stores and relays an opaque y-protocols awareness update. Awareness is
    /// intentionally never persisted or materialized into document content.
    fn apply_awareness(&self, payload: &[u8], origin: Uuid) {
        let payload = Arc::new(payload.to_vec());
        self.awareness
            .lock()
            .expect("awareness lock poisoned")
            .insert(origin, payload.clone());
        let _ = self.tx.send(RoomBroadcast {
            origin,
            tag: ws_message::AWARENESS,
            payload,
        });
    }

    fn awareness_snapshots(&self, exclude: Uuid) -> Vec<Arc<Vec<u8>>> {
        self.awareness
            .lock()
            .expect("awareness lock poisoned")
            .iter()
            .filter_map(|(session, payload)| (*session != exclude).then_some(payload.clone()))
            .collect()
    }

    fn remove_awareness(&self, session_id: Uuid) {
        self.awareness
            .lock()
            .expect("awareness lock poisoned")
            .remove(&session_id);
    }
}

/// Background task: after a note room goes quiet, materialize its live CRDT
/// content into a normal text revision so REST reads, history, search, and
/// export stay valid. One task runs per note room for the room's lifetime.
fn spawn_materializer(room: Arc<Room>, db: PgPool, blobs: Arc<dyn BlobStorage>) {
    if room.materialize == MaterializeKind::None {
        return;
    }
    tokio::spawn(async move {
        loop {
            room.dirty.notified().await;
            tokio::time::sleep(MATERIALIZE_DEBOUNCE).await;
            let content = match room.materialize {
                MaterializeKind::NoteText => Some(room.note_text()),
                MaterializeKind::Json | MaterializeKind::Canvas => room.json_content(),
                MaterializeKind::None => None,
            };
            let Some(content) = content else { continue };
            // Canvas integrity guard: never overwrite a canonical revision that
            // has nodes with a live state that has lost all of them. Such a state
            // is the signature of the startup/hydration race that previously
            // damaged hosted canvases, so refuse the destructive materialization
            // and leave the good revision in place (the room self-heals on its
            // next load via the structured recovery in `Room::load`).
            if room.materialize == MaterializeKind::Canvas {
                if let Some(current) =
                    api::load_current_document_text(&db, &*blobs, room.vault_id, room.file_id).await
                {
                    let current_nodes = canvas_node_count(&current).unwrap_or(0);
                    let new_nodes = canvas_node_count(&content).unwrap_or(0);
                    if current_nodes > 0 && new_nodes == 0 {
                        continue;
                    }
                }
            }
            let author = *room.last_author.lock().expect("author lock poisoned");
            if api::persist_materialized_document(
                &db,
                &*blobs,
                room.vault_id,
                room.file_id,
                &content,
                author,
            )
            .await
            .is_ok()
            {
                let _ = compact_room_log(&room, &db).await;
            }
        }
    });
}

/// Folds a room's current Yjs document into `crdt_documents` and removes every
/// update row covered by that state. The room sequence lock is held across the
/// database transaction so newer updates cannot be inserted with a sequence
/// number that is then accidentally deleted by this compaction.
async fn compact_room_log(room: &Room, db: &PgPool) -> Result<(), sqlx::Error> {
    let seq_guard = room.seq.lock().await;
    let compacted_seq = *seq_guard;
    if compacted_seq <= 0 {
        return Ok(());
    }
    let state = {
        let doc = room.doc.lock().expect("room doc lock poisoned");
        let state = doc
            .transact()
            .encode_state_as_update_v1(&StateVector::default());
        state
    };
    let mut transaction = db.begin().await?;
    sqlx::query(
        r#"
        INSERT INTO crdt_documents (file_id, vault_id, doc_state, update_seq, updated_at)
        VALUES ($1, $2, $3, $4, NOW())
        ON CONFLICT (file_id)
        DO UPDATE SET
          vault_id = EXCLUDED.vault_id,
          doc_state = EXCLUDED.doc_state,
          update_seq = EXCLUDED.update_seq,
          updated_at = NOW()
        WHERE crdt_documents.update_seq <= EXCLUDED.update_seq
        "#,
    )
    .bind(room.file_id)
    .bind(room.vault_id)
    .bind(&state)
    .bind(compacted_seq)
    .execute(&mut *transaction)
    .await?;
    sqlx::query("DELETE FROM crdt_updates WHERE file_id = $1 AND seq <= $2")
        .bind(room.file_id)
        .bind(compacted_seq)
        .execute(&mut *transaction)
        .await?;
    transaction.commit().await?;
    Ok(())
}

/// Converts a JSON value into a `yrs` preliminary input, building nested shared
/// types (`Map`/`Array`) so the browser can do field-level CRDT edits, matching
/// the client's `toShared` convention in `src/lib/liveJsonDocument.ts`.
fn json_to_in(value: &serde_json::Value) -> In {
    match value {
        serde_json::Value::Null => In::Any(Any::Null),
        serde_json::Value::Bool(b) => In::Any(Any::Bool(*b)),
        serde_json::Value::Number(n) => {
            // Structured documents are normal JSON. Encoding integral values as
            // Yjs BigInt leaks JavaScript `bigint` into the frontend, where it
            // is not JSON-stringifiable and breaks canvas numeric validation.
            In::Any(Any::Number(n.as_f64().unwrap_or(0.0)))
        }
        serde_json::Value::String(s) => In::Any(Any::String(s.as_str().into())),
        serde_json::Value::Array(items) => In::Array(ArrayPrelim::from(
            items.iter().map(json_to_in).collect::<Vec<_>>(),
        )),
        serde_json::Value::Object(map) => In::Map(MapPrelim::from_iter(
            map.iter()
                .map(|(key, value)| (key.clone(), json_to_in(value))),
        )),
    }
}

/// Seeds a structured (`doc` map) document from a serialized JSON object,
/// building nested shared types so the browser can do field-level CRDT edits.
fn seed_structured_doc(doc: &Doc, content: &str) {
    if let Ok(serde_json::Value::Object(map)) = serde_json::from_str::<serde_json::Value>(content) {
        let root = doc.get_or_insert_map(JSON_ROOT_NAME);
        let mut txn = doc.transact_mut();
        for (key, value) in map {
            root.insert(&mut txn, key, json_to_in(&value));
        }
    }
}

/// Serializes a structured `doc` map to JSON, or `None` when the root map is
/// empty (not yet seeded), so an empty document is never treated as real content.
fn doc_json_content(doc: &Doc) -> Option<String> {
    let root = doc.get_or_insert_map(JSON_ROOT_NAME);
    let txn = doc.transact();
    if root.len(&txn) == 0 {
        return None;
    }
    serde_json::to_string(&root.to_json(&txn)).ok()
}

/// Number of `nodes` entries in a serialized canvas document, or `None` when the
/// content does not parse as a canvas object carrying a `nodes` array. Used as
/// the canvas integrity signal: a canvas that has lost all of its nodes relative
/// to the canonical revision is treated as a degenerate (damaged) live state.
fn canvas_node_count(content: &str) -> Option<usize> {
    let value = serde_json::from_str::<serde_json::Value>(content).ok()?;
    value.get("nodes")?.as_array().map(|nodes| nodes.len())
}

fn apply_update_bytes(doc: &Doc, bytes: &[u8]) {
    let Ok(update) = Update::decode_v1(bytes) else {
        return;
    };
    let mut txn = doc.transact_mut();
    let _ = txn.apply_update(update);
}

/// Registry of live document rooms keyed by file id. Rooms are created lazily on
/// first subscription and reused by every later subscriber.
///
/// Rooms (and their materializer tasks) currently live for the process lifetime
/// once opened; bounded eviction of idle rooms is a Phase 5 hardening follow-up.
pub struct Hub {
    db: PgPool,
    blobs: Arc<dyn BlobStorage>,
    rooms: Mutex<HashMap<Uuid, Arc<Room>>>,
    active_connections: AtomicU64,
    /// Runtime-toggleable verbose live-collaboration tracing (admin-controlled,
    /// process-local, off by default). When on, the WS relay emits `info!` traces
    /// of subscribe/apply/broadcast/forward events without an env var or restart.
    live_debug: AtomicBool,
}

pub struct HubRuntimeMetrics {
    pub active_connections: u64,
    pub loaded_rooms: u64,
    pub active_awareness_states: u64,
}

pub struct ConnectionGuard {
    hub: Arc<Hub>,
}

impl Hub {
    pub fn new(db: PgPool, blobs: Arc<dyn BlobStorage>) -> Self {
        Self {
            db,
            blobs,
            rooms: Mutex::new(HashMap::new()),
            active_connections: AtomicU64::new(0),
            live_debug: AtomicBool::new(false),
        }
    }

    /// Whether verbose live-collaboration tracing is currently enabled.
    pub fn live_debug(&self) -> bool {
        self.live_debug.load(Ordering::Relaxed)
    }

    /// Enables or disables verbose live-collaboration tracing at runtime.
    pub fn set_live_debug(&self, enabled: bool) {
        self.live_debug.store(enabled, Ordering::Relaxed);
        tracing::info!(target: "collab_server::ws", enabled, "live-collaboration debug tracing toggled");
    }

    pub fn track_connection(self: &Arc<Self>) -> ConnectionGuard {
        self.active_connections.fetch_add(1, Ordering::Relaxed);
        ConnectionGuard {
            hub: Arc::clone(self),
        }
    }

    pub async fn runtime_metrics(&self) -> HubRuntimeMetrics {
        let rooms = self.rooms.lock().await;
        let active_awareness_states = rooms
            .values()
            .map(|room| {
                room.awareness
                    .lock()
                    .expect("room awareness lock poisoned")
                    .len() as u64
            })
            .sum();
        HubRuntimeMetrics {
            active_connections: self.active_connections.load(Ordering::Relaxed),
            loaded_rooms: rooms.len() as u64,
            active_awareness_states,
        }
    }

    async fn join(&self, file_id: Uuid, vault_id: Uuid) -> Result<Arc<Room>, sqlx::Error> {
        let mut rooms = self.rooms.lock().await;
        if let Some(room) = rooms.get(&file_id) {
            return Ok(room.clone());
        }
        let room = Arc::new(Room::load(&self.db, &self.blobs, file_id, vault_id).await?);
        spawn_materializer(room.clone(), self.db.clone(), self.blobs.clone());
        rooms.insert(file_id, room.clone());
        Ok(room)
    }
}

impl Drop for ConnectionGuard {
    fn drop(&mut self) {
        self.hub.active_connections.fetch_sub(1, Ordering::Relaxed);
    }
}

/// Axum handler for `GET /ws/v1/vaults/{vault_id}`.
pub async fn vault_ws(
    State(state): State<AppState>,
    Path(vault_id): Path<Uuid>,
    ws: WebSocketUpgrade,
) -> Response {
    ws.on_upgrade(move |socket| handle_socket(socket, state, vault_id))
}

/// Effective live-collaboration access for an authenticated session.
struct LiveAccess {
    vault_id: Uuid,
    user_id: Uuid,
    can_read: bool,
    can_write: bool,
    active: bool,
    role: HostedVaultRole,
}

async fn resolve_live_access(db: &PgPool, vault_id: Uuid, user_id: Uuid) -> Option<LiveAccess> {
    // Reuse the REST capability resolver; any error (including "no grant") fails
    // closed to no access. A throwaway request id is fine because the result is
    // not surfaced as an HTTP error here.
    let request_id = Uuid::new_v4().to_string();
    let access = api::resolve_vault_capabilities(db, vault_id, user_id, &request_id)
        .await
        .ok()?;
    Some(LiveAccess {
        vault_id,
        user_id,
        can_read: access.has(Capability::VaultRead),
        can_write: access.has(Capability::FileWrite),
        active: access.status() == HostedVaultStatus::Active,
        role: access.derived_role(),
    })
}

/// Validates and consumes a WebSocket ticket, returning the bound user id when
/// the ticket is valid, unconsumed, unexpired, and bound to `vault_id`.
async fn consume_ticket(db: &PgPool, raw_ticket: &str, vault_id: Uuid) -> Option<Uuid> {
    let row = sqlx::query(
        r#"
        UPDATE ws_tickets
        SET consumed_at = NOW()
        WHERE ticket_hash = $1
          AND vault_id = $2
          AND consumed_at IS NULL
          AND expires_at > NOW()
        RETURNING user_id
        "#,
    )
    .bind(hash_secret(raw_ticket))
    .bind(vault_id)
    .fetch_optional(db)
    .await
    .ok()??;
    Some(row.get::<Uuid, _>("user_id"))
}

async fn handle_socket(socket: WebSocket, state: AppState, vault_id: Uuid) {
    let _connection = state.hub.track_connection();
    let session_id = Uuid::new_v4();
    let (mut sink, mut stream) = socket.split();

    // Funnel every outgoing frame (control replies + broadcast forwards) through
    // a single writer task so the read loop and per-subscription forwarders can
    // share the sink safely.
    let (out_tx, mut out_rx) = mpsc::channel::<Message>(256);
    let writer = tokio::spawn(async move {
        while let Some(message) = out_rx.recv().await {
            if sink.send(message).await.is_err() {
                break;
            }
        }
    });

    let access = match authenticate(&state, vault_id, &mut stream, &out_tx).await {
        Some(access) => access,
        None => {
            drop(out_tx);
            let _ = writer.await;
            return;
        }
    };

    // file_id -> room + forwarder task for each active subscription.
    let mut subscriptions: HashMap<Uuid, Subscription> = HashMap::new();

    // Sliding window of recent inbound frame times for the message flood guard.
    let mut recent_messages: Vec<Instant> = Vec::new();

    while let Some(Ok(message)) = stream.next().await {
        // Ping/Pong are connection keepalives and are not counted toward the flood
        // budget. Everything else (control + binary CRDT/awareness frames) is.
        if !matches!(message, Message::Ping(_) | Message::Pong(_)) {
            let now = Instant::now();
            recent_messages.retain(|at| now.duration_since(*at) < MESSAGE_FLOOD_WINDOW);
            if recent_messages.len() >= MESSAGE_FLOOD_LIMIT {
                send_error(
                    &out_tx,
                    ErrorCode::RateLimited,
                    "Too many messages on this connection; reconnect and retry.",
                )
                .await;
                break;
            }
            recent_messages.push(now);
        }
        match message {
            Message::Text(text) => {
                let Ok(control) = serde_json::from_str::<WsClientControl>(text.as_str()) else {
                    continue;
                };
                match control {
                    WsClientControl::Authenticate { .. } => {
                        // Already authenticated; ignore repeats.
                    }
                    WsClientControl::DocumentSubscribe { file_id } => {
                        handle_subscribe(
                            &state,
                            vault_id,
                            session_id,
                            &file_id,
                            &out_tx,
                            &mut subscriptions,
                        )
                        .await;
                    }
                    WsClientControl::DocumentUnsubscribe { file_id } => {
                        if let Ok(id) = Uuid::parse_str(&file_id) {
                            if let Some(subscription) = subscriptions.remove(&id) {
                                subscription.room.remove_awareness(session_id);
                                subscription.forwarder.abort();
                            }
                        }
                    }
                    WsClientControl::Ping => {
                        let _ = send_control(&out_tx, WsServerControl::Pong).await;
                    }
                }
            }
            Message::Binary(data) => {
                handle_binary(&state, &access, session_id, &data, &subscriptions, &out_tx).await;
            }
            Message::Close(_) => break,
            Message::Ping(_) | Message::Pong(_) => {}
        }
    }

    for (_, subscription) in subscriptions.drain() {
        subscription.room.remove_awareness(session_id);
        subscription.forwarder.abort();
    }
    drop(out_tx);
    let _ = writer.await;
}

struct Subscription {
    room: Arc<Room>,
    forwarder: tokio::task::JoinHandle<()>,
}

/// Runs the authenticate handshake, returning the resolved access on success.
async fn authenticate(
    state: &AppState,
    vault_id: Uuid,
    stream: &mut futures_util::stream::SplitStream<WebSocket>,
    out_tx: &mpsc::Sender<Message>,
) -> Option<LiveAccess> {
    // The first meaningful frame must be an `authenticate` control message.
    while let Some(Ok(message)) = stream.next().await {
        let text = match message {
            Message::Text(text) => text,
            Message::Close(_) => return None,
            _ => continue,
        };
        let Ok(WsClientControl::Authenticate {
            ticket,
            protocol_version,
        }) = serde_json::from_str::<WsClientControl>(text.as_str())
        else {
            send_error(
                out_tx,
                ErrorCode::AuthenticationRequired,
                "Expected authenticate.",
            )
            .await;
            return None;
        };
        if let Some(version) = protocol_version {
            if version != PROTOCOL_VERSION {
                send_error(
                    out_tx,
                    ErrorCode::ProtocolVersionUnsupported,
                    "Unsupported protocol version.",
                )
                .await;
                return None;
            }
        }
        let Some(user_id) = consume_ticket(&state.database, &ticket, vault_id).await else {
            send_error(
                out_tx,
                ErrorCode::AuthenticationInvalid,
                "The session ticket is invalid or expired.",
            )
            .await;
            return None;
        };
        let Some(access) = resolve_live_access(&state.database, vault_id, user_id).await else {
            send_error(
                out_tx,
                ErrorCode::VaultPermissionDenied,
                "You do not have access to this vault.",
            )
            .await;
            return None;
        };
        if !access.can_read {
            send_error(
                out_tx,
                ErrorCode::VaultPermissionDenied,
                "You do not have access to this vault.",
            )
            .await;
            return None;
        }
        let manifest_sequence = sqlx::query_scalar::<_, i64>(
            "SELECT manifest_sequence FROM hosted_vaults WHERE id = $1",
        )
        .bind(vault_id)
        .fetch_optional(&state.database)
        .await
        .ok()
        .flatten()
        .unwrap_or(0);
        let _ = send_control(
            out_tx,
            WsServerControl::Ready {
                manifest_sequence,
                protocol_version: PROTOCOL_VERSION,
                role: access.role,
            },
        )
        .await;
        return Some(access);
    }
    None
}

async fn handle_subscribe(
    state: &AppState,
    vault_id: Uuid,
    session_id: Uuid,
    file_id: &str,
    out_tx: &mpsc::Sender<Message>,
    subscriptions: &mut HashMap<Uuid, Subscription>,
) {
    let Ok(file_id) = Uuid::parse_str(file_id) else {
        return;
    };
    if subscriptions.contains_key(&file_id) {
        return;
    }
    // The file must be an active document inside this vault.
    let document_type = sqlx::query_scalar::<_, String>(
        "SELECT document_type::text FROM hosted_file_entries WHERE id = $1 AND vault_id = $2 AND kind = 'document' AND state = 'active'",
    )
    .bind(file_id)
    .bind(vault_id)
    .fetch_optional(&state.database)
    .await
    .ok()
    .flatten();
    if document_type.is_none() {
        send_error(out_tx, ErrorCode::ResourceNotFound, "Document not found.").await;
        return;
    }

    let room = match state.hub.join(file_id, vault_id).await {
        Ok(room) => room,
        Err(_) => {
            send_error(
                out_tx,
                ErrorCode::ServerUnavailable,
                "Could not open document.",
            )
            .await;
            return;
        }
    };

    let debug = state.hub.live_debug();
    // Subscribe to broadcasts before sending our state vector so no concurrent
    // update is missed between the snapshot and the live stream.
    let mut rx = room.tx.subscribe();
    let forward_out = out_tx.clone();
    let handle = tokio::spawn(async move {
        loop {
            match rx.recv().await {
                Ok(broadcast) => {
                    if broadcast.origin == session_id {
                        continue;
                    }
                    let frame = encode_binary(broadcast.tag, file_id, &broadcast.payload);
                    if debug {
                        tracing::info!(
                            target: "collab_server::ws",
                            %file_id,
                            %session_id,
                            tag = broadcast.tag,
                            bytes = broadcast.payload.len(),
                            "forwarding broadcast to subscriber"
                        );
                    }
                    if forward_out
                        .send(Message::Binary(frame.into()))
                        .await
                        .is_err()
                    {
                        break;
                    }
                }
                Err(broadcast::error::RecvError::Lagged(_)) => continue,
                Err(broadcast::error::RecvError::Closed) => break,
            }
        }
    });
    subscriptions.insert(
        file_id,
        Subscription {
            room: room.clone(),
            forwarder: handle,
        },
    );
    if debug {
        tracing::info!(
            target: "collab_server::ws",
            %file_id,
            %session_id,
            room_subscribers = room.tx.receiver_count(),
            "session subscribed to document room"
        );
    }

    let _ = send_control(
        out_tx,
        WsServerControl::DocumentSubscribed {
            file_id: file_id.to_string(),
        },
    )
    .await;
    // Solicit the client's missing updates by sending our current state vector.
    let frame = encode_binary(ws_message::SYNC_STEP1, file_id, &room.state_vector());
    let _ = out_tx.send(Message::Binary(frame.into())).await;
    // Awareness is ephemeral, but replay the latest in-memory state from active
    // peers so a newly subscribed client can immediately render them.
    for awareness in room.awareness_snapshots(session_id) {
        let frame = encode_binary(ws_message::AWARENESS, file_id, &awareness);
        let _ = out_tx.send(Message::Binary(frame.into())).await;
    }
}

async fn handle_binary(
    state: &AppState,
    access: &LiveAccess,
    session_id: Uuid,
    data: &[u8],
    subscriptions: &HashMap<Uuid, Subscription>,
    out_tx: &mpsc::Sender<Message>,
) {
    let Some((tag, file_id, payload)) = decode_binary(data) else {
        return;
    };
    // Only subscribed documents accept traffic.
    if !subscriptions.contains_key(&file_id) {
        return;
    }
    let Some(current_access) =
        resolve_live_access(&state.database, access.vault_id, access.user_id).await
    else {
        send_error(
            out_tx,
            ErrorCode::VaultPermissionDenied,
            "You no longer have access to this vault.",
        )
        .await;
        return;
    };
    if !current_access.can_read {
        send_error(
            out_tx,
            ErrorCode::VaultPermissionDenied,
            "You no longer have permission to read this document.",
        )
        .await;
        return;
    }
    let Ok(room) = state.hub.join(file_id, current_access.vault_id).await else {
        return;
    };
    match tag {
        ws_message::SYNC_STEP1 => {
            // Read-only: reply with everything the peer is missing.
            if let Some(update) = room.diff(payload) {
                let frame = encode_binary(ws_message::SYNC_UPDATE, file_id, &update);
                let _ = out_tx.send(Message::Binary(frame.into())).await;
            }
        }
        ws_message::SYNC_UPDATE => {
            if !current_access.can_write || !current_access.active {
                send_error(
                    out_tx,
                    ErrorCode::VaultPermissionDenied,
                    "You do not have permission to edit this document.",
                )
                .await;
                return;
            }
            let _ = room
                .apply_remote_update(
                    &state.database,
                    payload,
                    current_access.user_id,
                    session_id,
                    state.hub.live_debug(),
                )
                .await;
        }
        // Awareness is allowed for every subscribed reader, including viewers,
        // and is relayed only in memory.
        ws_message::AWARENESS if payload.len() <= MAX_AWARENESS_BYTES => {
            room.apply_awareness(payload, session_id)
        }
        _ => {}
    }
}

fn encode_binary(tag: u8, file_id: Uuid, payload: &[u8]) -> Vec<u8> {
    let mut frame = Vec::with_capacity(ws_message::HEADER_LEN + payload.len());
    frame.push(tag);
    frame.extend_from_slice(file_id.as_bytes());
    frame.extend_from_slice(payload);
    frame
}

fn decode_binary(frame: &[u8]) -> Option<(u8, Uuid, &[u8])> {
    if frame.len() < ws_message::HEADER_LEN {
        return None;
    }
    let tag = frame[0];
    let file_id = Uuid::from_slice(&frame[1..ws_message::HEADER_LEN]).ok()?;
    Some((tag, file_id, &frame[ws_message::HEADER_LEN..]))
}

async fn send_control(out_tx: &mpsc::Sender<Message>, control: WsServerControl) -> Option<()> {
    let text = serde_json::to_string(&control).ok()?;
    out_tx.send(Message::Text(text.into())).await.ok()
}

async fn send_error(out_tx: &mpsc::Sender<Message>, code: ErrorCode, message: &str) {
    let _ = send_control(
        out_tx,
        WsServerControl::Error {
            code,
            message: message.to_owned(),
        },
    )
    .await;
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        app::build_router, auth::hash_secret, config::ServerConfig, database,
        storage::FileSystemBlobStorage, AppState,
    };
    use futures_util::{SinkExt, StreamExt};
    use sqlx::postgres::PgPoolOptions;
    use std::time::Duration;
    use tokio::net::TcpListener;
    use tokio_tungstenite::{connect_async, tungstenite::Message as ClientMessage};

    /// A connected, authenticated WebSocket test client that also acts as a yrs
    /// peer for the document it subscribes to.
    struct TestClient {
        socket: tokio_tungstenite::WebSocketStream<
            tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
        >,
    }

    impl TestClient {
        async fn connect(addr: &str, vault_id: Uuid, ticket: &str) -> Self {
            Self::connect_with_version(addr, vault_id, ticket, Some(PROTOCOL_VERSION)).await
        }

        async fn connect_with_version(
            addr: &str,
            vault_id: Uuid,
            ticket: &str,
            protocol_version: Option<u32>,
        ) -> Self {
            let url = format!("ws://{addr}/ws/v1/vaults/{vault_id}");
            let (mut socket, _) = connect_async(&url).await.expect("ws connect");
            socket
                .send(ClientMessage::Text(
                    serde_json::to_string(&WsClientControl::Authenticate {
                        ticket: ticket.to_owned(),
                        protocol_version,
                    })
                    .unwrap()
                    .into(),
                ))
                .await
                .unwrap();
            Self { socket }
        }

        async fn next(&mut self) -> ClientMessage {
            tokio::time::timeout(Duration::from_secs(5), self.socket.next())
                .await
                .expect("frame within timeout")
                .expect("stream not closed")
                .expect("frame ok")
        }

        /// Reads control frames until a matching server control is decoded.
        async fn expect_control(&mut self) -> WsServerControl {
            loop {
                if let ClientMessage::Text(text) = self.next().await {
                    if let Ok(control) = serde_json::from_str::<WsServerControl>(text.as_str()) {
                        return control;
                    }
                }
            }
        }

        async fn expect_ready(&mut self) -> WsServerControl {
            let control = self.expect_control().await;
            assert!(
                matches!(control, WsServerControl::Ready { .. }),
                "{control:?}"
            );
            control
        }

        async fn subscribe(&mut self, file_id: Uuid) {
            self.socket
                .send(ClientMessage::Text(
                    serde_json::to_string(&WsClientControl::DocumentSubscribe {
                        file_id: file_id.to_string(),
                    })
                    .unwrap()
                    .into(),
                ))
                .await
                .unwrap();
            // Expect the subscribed confirmation and the server's SYNC_STEP1.
            let control = self.expect_control().await;
            assert!(
                matches!(control, WsServerControl::DocumentSubscribed { .. }),
                "{control:?}"
            );
        }

        async fn send_binary(&mut self, tag: u8, file_id: Uuid, payload: &[u8]) {
            let frame = encode_binary(tag, file_id, payload);
            self.socket
                .send(ClientMessage::Binary(frame.into()))
                .await
                .unwrap();
        }

        /// Waits for the next binary frame with the given tag and returns its
        /// payload, or `None` if a server error/control arrives first.
        async fn next_binary(&mut self, want_tag: u8) -> Option<(u8, Vec<u8>)> {
            loop {
                match self.next().await {
                    ClientMessage::Binary(data) => {
                        let (tag, _file, payload) = decode_binary(&data)?;
                        if tag == want_tag {
                            return Some((tag, payload.to_vec()));
                        }
                    }
                    ClientMessage::Text(text) => {
                        if let Ok(WsServerControl::Error { .. }) =
                            serde_json::from_str::<WsServerControl>(text.as_str())
                        {
                            return None;
                        }
                    }
                    _ => {}
                }
            }
        }

        /// Waits briefly for an error control frame.
        async fn try_error(&mut self) -> Option<WsServerControl> {
            let result = tokio::time::timeout(Duration::from_secs(3), async {
                loop {
                    match self.socket.next().await {
                        Some(Ok(ClientMessage::Text(text))) => {
                            if let Ok(control) =
                                serde_json::from_str::<WsServerControl>(text.as_str())
                            {
                                if matches!(control, WsServerControl::Error { .. }) {
                                    return Some(control);
                                }
                            }
                        }
                        Some(Ok(_)) => {}
                        _ => return None,
                    }
                }
            })
            .await;
            result.unwrap_or(None)
        }
    }

    /// Builds a full Yjs v1 update that inserts `content` into a `content` text.
    fn text_update(content: &str) -> Vec<u8> {
        let doc = Doc::new();
        let text = doc.get_or_insert_text("content");
        {
            let mut txn = doc.transact_mut();
            text.insert(&mut txn, 0, content);
        }
        let update = doc
            .transact()
            .encode_state_as_update_v1(&StateVector::default());
        update
    }

    /// Applies a Yjs update and reads back the `content` text.
    fn read_text(update: &[u8]) -> String {
        let doc = Doc::new();
        let text = doc.get_or_insert_text("content");
        apply_update_bytes(&doc, update);
        let value = text.get_string(&doc.transact());
        value
    }

    /// Connects to the shared test database, holding the live-PostgreSQL guard so
    /// truncating tests do not race. The returned guard must be kept alive for
    /// the duration of the test.
    async fn test_pool() -> Option<(sqlx::PgPool, tokio::sync::MutexGuard<'static, ()>)> {
        let url = std::env::var("COLLAB_TEST_DATABASE_URL").ok()?;
        let guard = database::db_test_guard().lock().await;
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
        Some((pool, guard))
    }

    async fn insert_user(pool: &sqlx::PgPool, username: &str) -> Uuid {
        let id = Uuid::now_v7();
        sqlx::query(
            "INSERT INTO users (id, username, normalized_username, display_name) VALUES ($1, $2, $2, $3)",
        )
        .bind(id)
        .bind(username)
        .bind(username)
        .execute(pool)
        .await
        .unwrap();
        id
    }

    async fn insert_vault(pool: &sqlx::PgPool, owner: Uuid) -> Uuid {
        let id = Uuid::now_v7();
        sqlx::query(
            "INSERT INTO hosted_vaults (id, name, owner_user_id, status) VALUES ($1, 'Test', $2, 'active')",
        )
        .bind(id)
        .bind(owner)
        .execute(pool)
        .await
        .unwrap();
        id
    }

    async fn insert_member(pool: &sqlx::PgPool, vault: Uuid, user: Uuid, role: &str) {
        sqlx::query(
            "INSERT INTO hosted_vault_memberships (vault_id, user_id, role) VALUES ($1, $2, $3::hosted_vault_role)",
        )
        .bind(vault)
        .bind(user)
        .bind(role)
        .execute(pool)
        .await
        .unwrap();
    }

    async fn insert_document(pool: &sqlx::PgPool, vault: Uuid, name: &str) -> Uuid {
        insert_typed_document(pool, vault, name, "note").await
    }

    async fn insert_typed_document(
        pool: &sqlx::PgPool,
        vault: Uuid,
        name: &str,
        document_type: &str,
    ) -> Uuid {
        let id = Uuid::now_v7();
        sqlx::query(
            "INSERT INTO hosted_file_entries (id, vault_id, parent_id, name, normalized_name, kind, document_type, state) VALUES ($1, $2, NULL, $3, $3, 'document', $4::hosted_document_type, 'active')",
        )
        .bind(id)
        .bind(vault)
        .bind(name)
        .bind(document_type)
        .execute(pool)
        .await
        .unwrap();
        id
    }

    async fn insert_ticket(pool: &sqlx::PgPool, user: Uuid, vault: Uuid, raw: &str) {
        sqlx::query(
            "INSERT INTO ws_tickets (id, ticket_hash, user_id, vault_id, expires_at) VALUES ($1, $2, $3, $4, NOW() + INTERVAL '60 seconds')",
        )
        .bind(Uuid::now_v7())
        .bind(hash_secret(raw))
        .bind(user)
        .bind(vault)
        .execute(pool)
        .await
        .unwrap();
    }

    /// Writes an initial REST text revision for a document (blob + revision row +
    /// current pointer), so live rooms can seed from it.
    async fn insert_note_revision(
        pool: &sqlx::PgPool,
        blobs: &Arc<dyn BlobStorage>,
        vault: Uuid,
        file: Uuid,
        content: &str,
    ) {
        let digest = blobs.put(content.as_bytes()).await.unwrap();
        sqlx::query(
            "INSERT INTO hosted_blobs (digest, size_bytes, media_type, storage_key) VALUES ($1, $2, 'text/plain', $1) ON CONFLICT (digest) DO NOTHING",
        )
        .bind(&digest)
        .bind(content.len() as i64)
        .execute(pool)
        .await
        .unwrap();
        let revision = Uuid::now_v7();
        sqlx::query(
            "INSERT INTO hosted_file_revisions (id, vault_id, file_id, sequence, blob_digest, content_hash, size_bytes) VALUES ($1, $2, $3, 1, $4, $4, $5)",
        )
        .bind(revision)
        .bind(vault)
        .bind(file)
        .bind(&digest)
        .bind(content.len() as i64)
        .execute(pool)
        .await
        .unwrap();
        sqlx::query("UPDATE hosted_file_entries SET current_revision_id = $1 WHERE id = $2")
            .bind(revision)
            .bind(file)
            .execute(pool)
            .await
            .unwrap();
    }

    async fn serve(pool: sqlx::PgPool) -> (String, AppState) {
        let blobs = Arc::new(
            FileSystemBlobStorage::new(tempfile::tempdir().unwrap().keep())
                .await
                .unwrap(),
        );
        let state = AppState::new(ServerConfig::default(), pool, blobs);
        let app = build_router(state.clone());
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap().to_string();
        tokio::spawn(async move {
            axum::serve(listener, app.into_make_service())
                .await
                .unwrap();
        });
        (addr, state)
    }

    async fn wait_for_compaction(pool: &sqlx::PgPool, file: Uuid, min_seq: i64) {
        let deadline = tokio::time::Instant::now() + Duration::from_secs(8);
        loop {
            let row = sqlx::query(
                r#"
                SELECT
                  (SELECT COUNT(*) FROM crdt_updates WHERE file_id = $1) AS pending,
                  (SELECT update_seq FROM crdt_documents WHERE file_id = $1) AS update_seq
                "#,
            )
            .bind(file)
            .fetch_one(pool)
            .await
            .unwrap();
            let pending: i64 = row.get("pending");
            let update_seq: Option<i64> = row.get("update_seq");
            if pending == 0 && update_seq.unwrap_or(0) >= min_seq {
                return;
            }
            assert!(
                tokio::time::Instant::now() < deadline,
                "CRDT log did not compact in time; pending={pending}, update_seq={update_seq:?}"
            );
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    }

    #[tokio::test]
    async fn live_document_sync_converges_persists_and_enforces_viewer() {
        let Some((pool, _db_guard)) = test_pool().await else {
            return;
        };
        let owner = insert_user(&pool, "owner").await;
        let viewer = insert_user(&pool, "viewer").await;
        let vault = insert_vault(&pool, owner).await;
        insert_member(&pool, vault, viewer, "viewer").await;
        let file = insert_document(&pool, vault, "note.md").await;
        insert_ticket(&pool, owner, vault, "owner-a").await;
        insert_ticket(&pool, owner, vault, "owner-b").await;
        insert_ticket(&pool, viewer, vault, "viewer-t").await;
        insert_ticket(&pool, owner, vault, "owner-c").await;

        let (addr, _state) = serve(pool.clone()).await;

        // Two owner connections subscribe to the same document.
        let mut client_a = TestClient::connect(&addr, vault, "owner-a").await;
        client_a.expect_ready().await;
        client_a.subscribe(file).await;
        let _ = client_a.next_binary(ws_message::SYNC_STEP1).await; // server SV

        let mut client_b = TestClient::connect(&addr, vault, "owner-b").await;
        client_b.expect_ready().await;
        client_b.subscribe(file).await;
        let _ = client_b.next_binary(ws_message::SYNC_STEP1).await;

        // A makes an edit; B converges on it.
        client_a
            .send_binary(ws_message::SYNC_UPDATE, file, &text_update("hello"))
            .await;
        let (_, update) = client_b
            .next_binary(ws_message::SYNC_UPDATE)
            .await
            .expect("client B receives the edit");
        assert_eq!(read_text(&update), "hello");

        // The update is persisted to the append-only log, authored by the owner.
        let count: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM crdt_updates WHERE file_id = $1 AND author_user_id = $2",
        )
        .bind(file)
        .bind(owner)
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(count, 1);

        // A fresh connection recovers the persisted state via the sync handshake.
        let mut client_c = TestClient::connect(&addr, vault, "owner-c").await;
        client_c.expect_ready().await;
        client_c.subscribe(file).await;
        let _ = client_c.next_binary(ws_message::SYNC_STEP1).await;
        client_c
            .send_binary(
                ws_message::SYNC_STEP1,
                file,
                &StateVector::default().encode_v1(),
            )
            .await;
        let (_, state) = client_c
            .next_binary(ws_message::SYNC_UPDATE)
            .await
            .expect("client C receives the persisted state");
        assert_eq!(read_text(&state), "hello");

        // A viewer may subscribe but cannot mutate.
        let mut viewer_client = TestClient::connect(&addr, vault, "viewer-t").await;
        viewer_client.expect_ready().await;
        viewer_client.subscribe(file).await;
        let _ = viewer_client.next_binary(ws_message::SYNC_STEP1).await;
        viewer_client
            .send_binary(ws_message::SYNC_UPDATE, file, &text_update("nope"))
            .await;
        let error = viewer_client.try_error().await;
        assert!(
            matches!(error, Some(WsServerControl::Error { code, .. }) if code == ErrorCode::VaultPermissionDenied),
            "viewer write should be denied: {error:?}"
        );
        let count_after: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM crdt_updates WHERE file_id = $1")
                .bind(file)
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(count_after, 1, "viewer write must not persist");
    }

    #[tokio::test]
    async fn live_update_log_compacts_and_recovers_from_compacted_state() {
        let Some((pool, _db_guard)) = test_pool().await else {
            return;
        };
        let owner = insert_user(&pool, "compact-owner").await;
        let vault = insert_vault(&pool, owner).await;
        let file = insert_document(&pool, vault, "compact.md").await;
        insert_ticket(&pool, owner, vault, "compact-a").await;
        insert_ticket(&pool, owner, vault, "compact-restart").await;

        let (addr, _state) = serve(pool.clone()).await;
        let mut client = TestClient::connect(&addr, vault, "compact-a").await;
        client.expect_ready().await;
        client.subscribe(file).await;
        let _ = client.next_binary(ws_message::SYNC_STEP1).await;
        client
            .send_binary(ws_message::SYNC_UPDATE, file, &text_update("compact me"))
            .await;

        wait_for_compaction(&pool, file, 1).await;

        // Restarting the server builds a fresh Hub with no in-memory room. The
        // document must still recover from crdt_documents even though the update
        // log has been compacted away.
        let (restarted_addr, _restarted_state) = serve(pool.clone()).await;
        let mut restarted = TestClient::connect(&restarted_addr, vault, "compact-restart").await;
        restarted.expect_ready().await;
        restarted.subscribe(file).await;
        let _ = restarted.next_binary(ws_message::SYNC_STEP1).await;
        restarted
            .send_binary(
                ws_message::SYNC_STEP1,
                file,
                &StateVector::default().encode_v1(),
            )
            .await;
        let (_, state_update) = restarted
            .next_binary(ws_message::SYNC_UPDATE)
            .await
            .expect("compacted state is replayed");
        assert_eq!(read_text(&state_update), "compact me");
    }

    #[tokio::test]
    async fn live_permissions_are_rechecked_after_role_changes() {
        let Some((pool, _db_guard)) = test_pool().await else {
            return;
        };
        let owner = insert_user(&pool, "dynamic-owner").await;
        let editor = insert_user(&pool, "dynamic-editor").await;
        let vault = insert_vault(&pool, owner).await;
        insert_member(&pool, vault, editor, "editor").await;
        let file = insert_document(&pool, vault, "dynamic.md").await;
        insert_ticket(&pool, editor, vault, "dynamic-editor-t").await;

        let (addr, _state) = serve(pool.clone()).await;
        let mut client = TestClient::connect(&addr, vault, "dynamic-editor-t").await;
        client.expect_ready().await;
        client.subscribe(file).await;
        let _ = client.next_binary(ws_message::SYNC_STEP1).await;

        sqlx::query(
            "UPDATE hosted_vault_memberships SET role = 'viewer' WHERE vault_id = $1 AND user_id = $2",
        )
        .bind(vault)
        .bind(editor)
        .execute(&pool)
        .await
        .unwrap();

        client
            .send_binary(
                ws_message::SYNC_UPDATE,
                file,
                &text_update("not allowed anymore"),
            )
            .await;
        let error = client.try_error().await;
        assert!(
            matches!(error, Some(WsServerControl::Error { code, .. }) if code == ErrorCode::VaultPermissionDenied),
            "downgraded editor write should be denied: {error:?}"
        );
        let persisted: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM crdt_updates WHERE file_id = $1")
                .bind(file)
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(persisted, 0);
    }

    #[tokio::test]
    async fn awareness_is_ephemeral_relayed_and_available_to_viewers() {
        let Some((pool, _db_guard)) = test_pool().await else {
            return;
        };
        let owner = insert_user(&pool, "awareness-owner").await;
        let viewer = insert_user(&pool, "awareness-viewer").await;
        let vault = insert_vault(&pool, owner).await;
        insert_member(&pool, vault, viewer, "viewer").await;
        let file = insert_document(&pool, vault, "awareness.md").await;
        insert_ticket(&pool, owner, vault, "awareness-owner-a").await;
        insert_ticket(&pool, viewer, vault, "awareness-viewer-a").await;
        insert_ticket(&pool, owner, vault, "awareness-owner-late").await;

        let (addr, _state) = serve(pool.clone()).await;

        let mut owner_client = TestClient::connect(&addr, vault, "awareness-owner-a").await;
        owner_client.expect_ready().await;
        owner_client.subscribe(file).await;
        let _ = owner_client.next_binary(ws_message::SYNC_STEP1).await;

        let mut viewer_client = TestClient::connect(&addr, vault, "awareness-viewer-a").await;
        viewer_client.expect_ready().await;
        viewer_client.subscribe(file).await;
        let _ = viewer_client.next_binary(ws_message::SYNC_STEP1).await;

        let owner_awareness = b"owner-awareness";
        owner_client
            .send_binary(ws_message::AWARENESS, file, owner_awareness)
            .await;
        let (_, relayed_owner_awareness) = viewer_client
            .next_binary(ws_message::AWARENESS)
            .await
            .expect("viewer receives owner awareness");
        assert_eq!(relayed_owner_awareness, owner_awareness);

        let viewer_awareness = b"viewer-awareness";
        viewer_client
            .send_binary(ws_message::AWARENESS, file, viewer_awareness)
            .await;
        let (_, relayed_viewer_awareness) = owner_client
            .next_binary(ws_message::AWARENESS)
            .await
            .expect("owner receives viewer awareness");
        assert_eq!(relayed_viewer_awareness, viewer_awareness);

        // A late subscriber receives the latest in-memory awareness snapshots
        // from active sessions, without awareness entering the CRDT update log.
        let mut late_client = TestClient::connect(&addr, vault, "awareness-owner-late").await;
        late_client.expect_ready().await;
        late_client.subscribe(file).await;
        let _ = late_client.next_binary(ws_message::SYNC_STEP1).await;
        let (_, replayed_awareness) = late_client
            .next_binary(ws_message::AWARENESS)
            .await
            .expect("late subscriber receives active awareness");
        assert!(
            replayed_awareness == owner_awareness || replayed_awareness == viewer_awareness,
            "unexpected replayed awareness payload"
        );

        let persisted: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM crdt_updates WHERE file_id = $1")
                .bind(file)
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(persisted, 0, "awareness must never be persisted");
    }

    #[tokio::test]
    async fn rejects_invalid_ticket_and_foreign_vault_ticket() {
        let Some((pool, _db_guard)) = test_pool().await else {
            return;
        };
        let owner = insert_user(&pool, "owner").await;
        let vault = insert_vault(&pool, owner).await;
        let other_vault = insert_vault(&pool, owner).await;
        insert_ticket(&pool, owner, other_vault, "wrong-vault").await;

        let (addr, _state) = serve(pool.clone()).await;

        // A made-up ticket is rejected.
        let mut bogus = TestClient::connect(&addr, vault, "does-not-exist").await;
        let control = bogus.expect_control().await;
        assert!(
            matches!(control, WsServerControl::Error { code, .. } if code == ErrorCode::AuthenticationInvalid),
            "{control:?}"
        );

        // A ticket bound to a different vault cannot be replayed against `vault`.
        let mut foreign = TestClient::connect(&addr, vault, "wrong-vault").await;
        let control = foreign.expect_control().await;
        assert!(
            matches!(control, WsServerControl::Error { code, .. } if code == ErrorCode::AuthenticationInvalid),
            "{control:?}"
        );
    }

    #[tokio::test]
    async fn ticket_is_single_use() {
        let Some((pool, _db_guard)) = test_pool().await else {
            return;
        };
        let owner = insert_user(&pool, "owner").await;
        let vault = insert_vault(&pool, owner).await;
        insert_ticket(&pool, owner, vault, "one-shot").await;
        let (addr, _state) = serve(pool.clone()).await;

        let mut first = TestClient::connect(&addr, vault, "one-shot").await;
        first.expect_ready().await;

        let mut second = TestClient::connect(&addr, vault, "one-shot").await;
        let control = second.expect_control().await;
        assert!(
            matches!(control, WsServerControl::Error { code, .. } if code == ErrorCode::AuthenticationInvalid),
            "reused ticket must be rejected: {control:?}"
        );
    }

    #[tokio::test]
    async fn unsupported_protocol_version_is_rejected_before_ready() {
        let Some((pool, _db_guard)) = test_pool().await else {
            return;
        };
        let owner = insert_user(&pool, "owner").await;
        let vault = insert_vault(&pool, owner).await;
        insert_ticket(&pool, owner, vault, "ver-t").await;
        let (addr, _state) = serve(pool.clone()).await;

        // A client speaking an incompatible wire version is rejected during the
        // handshake, before any ready/subscribe is possible.
        let mut client =
            TestClient::connect_with_version(&addr, vault, "ver-t", Some(PROTOCOL_VERSION + 1))
                .await;
        let control = client.expect_control().await;
        assert!(
            matches!(control, WsServerControl::Error { code, .. } if code == ErrorCode::ProtocolVersionUnsupported),
            "unsupported version must be rejected: {control:?}"
        );

        // The version check precedes ticket consumption, so the still-unused
        // ticket lets a correctly-versioned client connect afterwards.
        let mut ok = TestClient::connect(&addr, vault, "ver-t").await;
        ok.expect_ready().await;
    }

    #[tokio::test]
    async fn fresh_note_room_seeds_from_existing_revision() {
        let Some((pool, _db_guard)) = test_pool().await else {
            return;
        };
        let owner = insert_user(&pool, "owner").await;
        let vault = insert_vault(&pool, owner).await;
        let file = insert_document(&pool, vault, "note.md").await;
        insert_ticket(&pool, owner, vault, "seed-t").await;

        let (addr, state) = serve(pool.clone()).await;
        insert_note_revision(&pool, &state.blobs, vault, file, "existing body").await;

        let mut client = TestClient::connect(&addr, vault, "seed-t").await;
        client.expect_ready().await;
        client.subscribe(file).await;
        let _ = client.next_binary(ws_message::SYNC_STEP1).await;
        // Ask for everything we are missing; the room is seeded from REST content.
        client
            .send_binary(
                ws_message::SYNC_STEP1,
                file,
                &StateVector::default().encode_v1(),
            )
            .await;
        let (_, state_update) = client
            .next_binary(ws_message::SYNC_UPDATE)
            .await
            .expect("seeded state");
        assert_eq!(read_text(&state_update), "existing body");
    }

    #[tokio::test]
    async fn empty_legacy_live_state_recovers_from_nonempty_revision() {
        let Some((pool, _db_guard)) = test_pool().await else {
            return;
        };
        let owner = insert_user(&pool, "recover-owner").await;
        let vault = insert_vault(&pool, owner).await;
        let file = insert_document(&pool, vault, "recover.md").await;
        insert_ticket(&pool, owner, vault, "recover-t").await;

        let (addr, state) = serve(pool.clone()).await;
        insert_note_revision(&pool, &state.blobs, vault, file, "recover this body").await;
        let empty_doc = Doc::new();
        let empty_state = empty_doc
            .transact()
            .encode_state_as_update_v1(&StateVector::default());
        sqlx::query(
            "INSERT INTO crdt_documents (file_id, vault_id, doc_state, update_seq) VALUES ($1, $2, $3, 0)",
        )
        .bind(file)
        .bind(vault)
        .bind(empty_state)
        .execute(&pool)
        .await
        .unwrap();

        let mut client = TestClient::connect(&addr, vault, "recover-t").await;
        client.expect_ready().await;
        client.subscribe(file).await;
        let _ = client.next_binary(ws_message::SYNC_STEP1).await;
        client
            .send_binary(
                ws_message::SYNC_STEP1,
                file,
                &StateVector::default().encode_v1(),
            )
            .await;
        let (_, state_update) = client
            .next_binary(ws_message::SYNC_UPDATE)
            .await
            .expect("recovered state");
        assert_eq!(read_text(&state_update), "recover this body");
    }

    /// Applies a Yjs update and reads the structured `doc` map back as JSON.
    fn read_doc_json(update: &[u8]) -> serde_json::Value {
        let doc = Doc::new();
        apply_update_bytes(&doc, update);
        let root = doc.get_or_insert_map(JSON_ROOT_NAME);
        let txn = doc.transact();
        serde_json::to_value(root.to_json(&txn)).unwrap()
    }

    #[tokio::test]
    async fn live_json_document_seeds_and_materializes() {
        let Some((pool, _db_guard)) = test_pool().await else {
            return;
        };
        let owner = insert_user(&pool, "owner").await;
        let vault = insert_vault(&pool, owner).await;
        let file = insert_typed_document(&pool, vault, "board.kanban", "kanban").await;
        insert_ticket(&pool, owner, vault, "json-t").await;

        let (addr, state) = serve(pool.clone()).await;
        let seed = r#"{"columns":[{"id":"c1","name":"To Do"}]}"#;
        insert_note_revision(&pool, &state.blobs, vault, file, seed).await;

        let mut client = TestClient::connect(&addr, vault, "json-t").await;
        client.expect_ready().await;
        client.subscribe(file).await;
        let _ = client.next_binary(ws_message::SYNC_STEP1).await;

        // Pull the seeded structured state and confirm it mirrors the REST JSON.
        client
            .send_binary(
                ws_message::SYNC_STEP1,
                file,
                &StateVector::default().encode_v1(),
            )
            .await;
        let (_, state_update) = client
            .next_binary(ws_message::SYNC_UPDATE)
            .await
            .expect("seeded state");
        assert_eq!(
            read_doc_json(&state_update),
            serde_json::json!({"columns": [{"id": "c1", "name": "To Do"}]}),
        );

        // Make a field-level edit and confirm it materializes back into JSON.
        let local = Doc::new();
        apply_update_bytes(&local, &state_update);
        let before = local.transact().state_vector();
        {
            let root = local.get_or_insert_map(JSON_ROOT_NAME);
            let mut txn = local.transact_mut();
            root.insert(&mut txn, "title", In::Any(Any::String("My Board".into())));
        }
        let delta = local.transact().encode_state_as_update_v1(&before);
        client
            .send_binary(ws_message::SYNC_UPDATE, file, &delta)
            .await;

        tokio::time::sleep(Duration::from_millis(2500)).await;
        let content = api::load_current_document_text(&pool, &*state.blobs, vault, file)
            .await
            .expect("materialized json");
        let value: serde_json::Value = serde_json::from_str(&content).unwrap();
        assert_eq!(value["title"], serde_json::json!("My Board"));
        assert_eq!(value["columns"][0]["id"], serde_json::json!("c1"));
    }

    /// A canvas that loses every node must never overwrite a canonical revision
    /// that still has nodes — the signature of the startup/hydration race that
    /// previously damaged hosted canvases.
    #[tokio::test]
    async fn canvas_node_loss_is_not_materialized_over_a_populated_revision() {
        let Some((pool, _db_guard)) = test_pool().await else {
            return;
        };
        let owner = insert_user(&pool, "owner").await;
        let vault = insert_vault(&pool, owner).await;
        let file = insert_typed_document(&pool, vault, "board.canvas", "canvas").await;
        insert_ticket(&pool, owner, vault, "canvas-guard-t").await;

        let (addr, state) = serve(pool.clone()).await;
        let seed = r#"{"nodes":[{"id":"n1","type":"text","position":{"x":0,"y":0}}],"edges":[],"viewport":{"x":0,"y":0,"zoom":1}}"#;
        insert_note_revision(&pool, &state.blobs, vault, file, seed).await;

        let mut client = TestClient::connect(&addr, vault, "canvas-guard-t").await;
        client.expect_ready().await;
        client.subscribe(file).await;
        let _ = client.next_binary(ws_message::SYNC_STEP1).await;
        client
            .send_binary(
                ws_message::SYNC_STEP1,
                file,
                &StateVector::default().encode_v1(),
            )
            .await;
        let (_, state_update) = client
            .next_binary(ws_message::SYNC_UPDATE)
            .await
            .expect("seeded canvas state");

        // The client clears every node (the destructive case).
        let local = Doc::new();
        apply_update_bytes(&local, &state_update);
        let before = local.transact().state_vector();
        {
            let root = local.get_or_insert_map(JSON_ROOT_NAME);
            let mut txn = local.transact_mut();
            root.insert(&mut txn, "nodes", ArrayPrelim::from(Vec::<In>::new()));
        }
        let delta = local.transact().encode_state_as_update_v1(&before);
        client
            .send_binary(ws_message::SYNC_UPDATE, file, &delta)
            .await;

        // Past the materialize debounce, the canonical revision must still have
        // its node — the destructive write was refused.
        tokio::time::sleep(Duration::from_millis(2500)).await;
        let content = api::load_current_document_text(&pool, &*state.blobs, vault, file)
            .await
            .expect("canvas content");
        assert_eq!(
            canvas_node_count(&content),
            Some(1),
            "node-losing canvas update must not be materialized: {content}",
        );
    }

    /// A persisted-but-degenerate canvas room (0 nodes while the REST revision has
    /// nodes) is reset from the canonical revision on load, and its stale update
    /// log is compacted away.
    #[tokio::test]
    async fn degenerate_canvas_room_recovers_from_revision_on_load() {
        let Some((pool, _db_guard)) = test_pool().await else {
            return;
        };
        let owner = insert_user(&pool, "owner").await;
        let vault = insert_vault(&pool, owner).await;
        let file = insert_typed_document(&pool, vault, "board.canvas", "canvas").await;
        insert_ticket(&pool, owner, vault, "canvas-recover-t").await;

        let (addr, state) = serve(pool.clone()).await;
        let seed = r#"{"nodes":[{"id":"n1","type":"text","position":{"x":0,"y":0}}],"edges":[],"viewport":{"x":0,"y":0,"zoom":1}}"#;
        insert_note_revision(&pool, &state.blobs, vault, file, seed).await;

        // Persist a degenerate live state (canvas with no nodes) plus a stale
        // update-log row, mimicking a room damaged by the early startup race.
        let degenerate = Doc::new();
        seed_structured_doc(
            &degenerate,
            r#"{"nodes":[],"edges":[],"viewport":{"x":0,"y":0,"zoom":1}}"#,
        );
        let degenerate_state = degenerate
            .transact()
            .encode_state_as_update_v1(&StateVector::default());
        sqlx::query(
            "INSERT INTO crdt_documents (file_id, vault_id, doc_state, update_seq) VALUES ($1, $2, $3, 0)",
        )
        .bind(file)
        .bind(vault)
        .bind(&degenerate_state)
        .execute(&pool)
        .await
        .unwrap();
        let before = degenerate.transact().state_vector();
        {
            let root = degenerate.get_or_insert_map(JSON_ROOT_NAME);
            let mut txn = degenerate.transact_mut();
            root.insert(&mut txn, "title", In::Any(Any::String("stale".into())));
        }
        let stale_update = degenerate.transact().encode_state_as_update_v1(&before);
        sqlx::query(
            "INSERT INTO crdt_updates (id, file_id, vault_id, seq, update_bytes, author_user_id) VALUES ($1, $2, $3, 1, $4, $5)",
        )
        .bind(Uuid::now_v7())
        .bind(file)
        .bind(vault)
        .bind(&stale_update)
        .bind(owner)
        .execute(&pool)
        .await
        .unwrap();

        let mut client = TestClient::connect(&addr, vault, "canvas-recover-t").await;
        client.expect_ready().await;
        client.subscribe(file).await;
        let _ = client.next_binary(ws_message::SYNC_STEP1).await;
        client
            .send_binary(
                ws_message::SYNC_STEP1,
                file,
                &StateVector::default().encode_v1(),
            )
            .await;
        let (_, recovered) = client
            .next_binary(ws_message::SYNC_UPDATE)
            .await
            .expect("recovered canvas state");
        let value = read_doc_json(&recovered);
        assert_eq!(
            value["nodes"].as_array().map(|nodes| nodes.len()),
            Some(1),
            "degenerate canvas room must recover its node from the revision: {value}",
        );
        assert!(value.get("title").is_none(), "stale field must be dropped");

        // The stale update log is compacted away by the reset.
        let updates: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM crdt_updates WHERE file_id = $1")
                .bind(file)
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(updates, 0, "stale update log must be reset");
    }

    #[tokio::test]
    async fn live_edits_materialize_into_a_text_revision() {
        let Some((pool, _db_guard)) = test_pool().await else {
            return;
        };
        let owner = insert_user(&pool, "owner").await;
        let vault = insert_vault(&pool, owner).await;
        let file = insert_document(&pool, vault, "note.md").await;
        insert_ticket(&pool, owner, vault, "mat-t").await;

        let (addr, state) = serve(pool.clone()).await;

        let mut client = TestClient::connect(&addr, vault, "mat-t").await;
        client.expect_ready().await;
        client.subscribe(file).await;
        let _ = client.next_binary(ws_message::SYNC_STEP1).await;
        client
            .send_binary(
                ws_message::SYNC_UPDATE,
                file,
                &text_update("materialized body"),
            )
            .await;

        // Wait past the materialize debounce, then confirm a REST revision exists.
        tokio::time::sleep(Duration::from_millis(2500)).await;
        let content = api::load_current_document_text(&pool, &*state.blobs, vault, file).await;
        assert_eq!(content.as_deref(), Some("materialized body"));
        let revisions: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM hosted_file_revisions WHERE file_id = $1")
                .bind(file)
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(revisions, 1, "exactly one materialized revision");
    }
}
