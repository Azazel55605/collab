import * as Y from 'yjs';
import {
  applyAwarenessUpdate,
  Awareness,
  encodeAwarenessUpdate,
  removeAwarenessStates,
} from 'y-protocols/awareness';
import { tauriCommands } from './tauri';
import { isLiveCollabDebugEnabled, liveDebugPush } from './liveDebugLog';
import type { VaultClient } from './vaultClient';

/**
 * Live collaboration transport for hosted documents.
 *
 * Speaks the Phase 5 server protocol (see `crates/collab-server/src/ws.rs`):
 * JSON control frames for `authenticate`/`ready`/`document.subscribe` and binary
 * `[tag][fileId][yjs-v1-payload]` frames for the CRDT sync handshake. The shared
 * document is a standard `Y.Doc`, so it binds directly to CodeMirror through
 * `y-codemirror.next`.
 *
 * A session only opens when the initial connect+authenticate+subscribe succeeds,
 * so callers can fall back to the REST optimistic-write path when live
 * collaboration is unavailable (local vaults, self-signed servers the webview
 * cannot reach, or a server that is offline). Once live, brief disconnections
 * are recovered by reconnecting and re-running the sync handshake rather than
 * dropping back to REST mid-edit.
 */

const SYNC_STEP1 = 1;
const SYNC_UPDATE = 2;
const AWARENESS = 3;
const HEADER_LEN = 1 + 16;
/**
 * Live-collaboration wire protocol version this client speaks. Sent in the
 * `authenticate` frame and checked against the server's advertised version in
 * `ready`. Must stay in sync with `collab_protocol::PROTOCOL_VERSION`.
 */
const PROTOCOL_VERSION = 1;
/** Server error code (snake_case `ErrorCode`) for an unsupported wire version. */
const PROTOCOL_VERSION_UNSUPPORTED = 'protocol_version_unsupported';
const NOTE_TEXT_NAME = 'content';
const CONNECT_TIMEOUT_MS = 8000;
const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 15000;
/** Debounce for writing the merged CRDT state to the offline replica. */
const PERSIST_DEBOUNCE_MS = 800;

export type LiveStatus = 'connecting' | 'connected' | 'disconnected';

/** Connection target resolved from a {@link VaultClient}. */
export interface LiveTarget {
  serverUrl: string;
  vaultId: string;
  fileId: string;
}

/** Generic live document handle shared by note (text) and structured sessions. */
export interface LiveDocumentHandle {
  readonly doc: Y.Doc;
  readonly awareness: Awareness;
  getStatus(): LiveStatus;
  onStatus(cb: (status: LiveStatus) => void): () => void;
  /**
   * Discard the offline replica's persisted CRDT state for this document and
   * stop persisting it: the current (in-memory) state is not flushed on
   * {@link destroy}, and the cached state is cleared so the next session reseeds
   * from the server. Used when a seeded structured-document session is rejected
   * as degenerate so a corrupt cache cannot persist. No-op without offline
   * replication.
   */
  discardOfflineState(): void;
  destroy(): void;
}

export interface LiveDocumentSession extends LiveDocumentHandle {
  readonly text: Y.Text;
}

/** Origin tag for updates applied from the network, so they are not re-sent. */
const REMOTE_ORIGIN = Symbol('live-remote');
const REMOTE_AWARENESS_ORIGIN = Symbol('live-awareness-remote');
/**
 * Origin tag for updates applied while seeding the document from the offline
 * replica's persisted CRDT state. Seeded state is not re-sent as a fresh local
 * update (the reconnect state-vector handshake uploads anything the server is
 * missing) and is not re-persisted (it just came from the cache).
 */
const SEED_ORIGIN = Symbol('live-replica-seed');

/** Encode raw bytes as base64 for transport across the Tauri boundary. */
function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function encodeFileId(fileId: string): Uint8Array {
  // Hosted file ids are UUID strings; encode the 16 raw bytes into the header.
  const hex = fileId.replace(/-/g, '');
  const bytes = new Uint8Array(16);
  for (let i = 0; i < 16; i += 1) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

function frame(tag: number, fileIdBytes: Uint8Array, payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(HEADER_LEN + payload.length);
  out[0] = tag;
  out.set(fileIdBytes, 1);
  out.set(payload, HEADER_LEN);
  return out;
}

/**
 * Opt-in live-collaboration tracing, controlled by the Settings → "Live
 * collaboration debug" toggle (or the legacy `localStorage.collabLiveDebug`
 * fallback). Events are mirrored to the console and to the in-app Live Debug
 * panel. Off by default and zero-cost when disabled. Used to localize live
 * co-editing faults (send vs. transport vs. receive vs. editor binding) that the
 * unit tests — which bypass the real WebSocket transport and the CodeMirror
 * binding — cannot reach.
 */
function liveDebugOn(): boolean {
  return isLiveCollabDebugEnabled();
}
function liveLog(file: string, message: string, detail?: unknown): void {
  if (!isLiveCollabDebugEnabled()) return;
  liveDebugPush(file, detail === undefined ? message : `${message} ${JSON.stringify(detail)}`);
}
function tagName(tag: number): string {
  return tag === SYNC_STEP1 ? 'SYNC_STEP1' : tag === SYNC_UPDATE ? 'SYNC_UPDATE' : tag === AWARENESS ? 'AWARENESS' : `tag#${tag}`;
}

export class WebSocketYProvider {
  readonly doc = new Y.Doc();
  readonly awareness = new Awareness(this.doc);

  private socket: WebSocket | null = null;
  private status: LiveStatus = 'connecting';
  private statusCallbacks = new Set<(status: LiveStatus) => void>();
  private readonly fileIdBytes: Uint8Array;
  private destroyed = false;
  // A non-recoverable failure (e.g. the server speaks an incompatible protocol
  // version). Unlike a transient drop or an expired single-use ticket, retrying
  // cannot help, so reconnection is suppressed and the caller falls back to REST.
  private fatal = false;
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private initialSyncPending = false;
  private subscribedCallback: ((ok: boolean) => void) | undefined;
  private persistTimer: ReturnType<typeof setTimeout> | null = null;
  // When set, the offline replica state for this document has been discarded as
  // degenerate: stop persisting and do not flush on destroy.
  private offlineDiscarded = false;

  /**
   * @param offlineReplica when true, the merged CRDT state is persisted to the
   * native offline replica on change and the document is seeded from it before
   * connecting, so edits survive across sessions and reconcile via the
   * reconnect state-vector handshake.
   */
  constructor(
    private readonly target: LiveTarget,
    private readonly offlineReplica = false,
  ) {
    this.fileIdBytes = encodeFileId(target.fileId);
    this.doc.on('update', this.handleLocalUpdate);
    if (this.offlineReplica) this.doc.on('update', this.handlePersistUpdate);
    this.awareness.on('update', this.handleAwarenessUpdate);
    liveLog(target.fileId, 'provider created', { server: target.serverUrl, vault: target.vaultId });
    if (liveDebugOn()) {
      // Trace every mutation of the shared doc so it is obvious whether the
      // CodeMirror/yCollab binding is actually feeding local edits into Y.Text
      // (sender) and whether received remote updates land in Y.Text (receiver).
      this.doc.on('update', (_u: Uint8Array, origin: unknown) => {
        const kind = origin === REMOTE_ORIGIN ? 'remote' : origin === SEED_ORIGIN ? 'seed' : 'local';
        liveLog(target.fileId, `doc update (${kind}) -> text len ${this.doc.getText(NOTE_TEXT_NAME).length}`);
      });
    }
  }

  /**
   * Seed the document from the offline replica's persisted CRDT state before the
   * first connection. No-op when offline replication is disabled or no state has
   * been cached yet. Best-effort: a replica read failure leaves the document
   * empty so the normal server handshake seeds it.
   */
  async hydrateFromReplica(): Promise<void> {
    if (!this.offlineReplica || this.destroyed) return;
    try {
      const base64 = await tauriCommands.replicaReadCrdtState(
        this.target.serverUrl,
        this.target.vaultId,
        this.target.fileId,
      );
      if (base64 && !this.destroyed) {
        Y.applyUpdate(this.doc, base64ToBytes(base64), SEED_ORIGIN);
      }
    } catch {
      // Best-effort: fall through to a server-seeded document.
    }
  }

  private handlePersistUpdate = (_update: Uint8Array, origin: unknown) => {
    // Seeded state came from the cache; everything else (local edits and merged
    // remote updates) is persisted so the replica reflects the converged state.
    if (origin === SEED_ORIGIN || this.offlineDiscarded) return;
    this.schedulePersist();
  };

  /**
   * Discard the offline replica's persisted CRDT state and stop persisting. Used
   * when a structured-document seed is rejected as degenerate so the corrupt
   * cache cannot persist and re-poison the next session.
   */
  discardOfflineState() {
    this.offlineDiscarded = true;
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }
    if (!this.offlineReplica) return;
    void tauriCommands
      .replicaClearCrdtState(this.target.serverUrl, this.target.vaultId, this.target.fileId)
      .catch(() => {
        // Best-effort: a clear failure leaves the next session to re-evaluate.
      });
  }

  private schedulePersist() {
    if (this.persistTimer) clearTimeout(this.persistTimer);
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      void this.persistNow();
    }, PERSIST_DEBOUNCE_MS);
  }

  private async persistNow() {
    if (!this.offlineReplica) return;
    try {
      const state = bytesToBase64(Y.encodeStateAsUpdate(this.doc));
      await tauriCommands.replicaCacheCrdtState(
        this.target.serverUrl,
        this.target.vaultId,
        this.target.fileId,
        state,
      );
    } catch {
      // Best-effort caching; never disrupt the live session.
    }
  }

  /** Generic handle without document-shape-specific accessors. */
  handle(): LiveDocumentHandle {
    return {
      doc: this.doc,
      awareness: this.awareness,
      getStatus: () => this.getStatus(),
      onStatus: (cb) => this.onStatus(cb),
      discardOfflineState: () => this.discardOfflineState(),
      destroy: () => this.destroy(),
    };
  }

  private handleLocalUpdate = (update: Uint8Array, origin: unknown) => {
    // Remote updates are not echoed; seeded offline state is uploaded through the
    // reconnect state-vector handshake (server SYNC_STEP1 -> our SYNC_UPDATE),
    // not re-broadcast as a fresh local edit.
    if (origin === REMOTE_ORIGIN || origin === SEED_ORIGIN) return;
    this.sendBinary(SYNC_UPDATE, update);
  };

  private handleAwarenessUpdate = (
    changes: { added: number[]; updated: number[]; removed: number[] },
    origin: unknown,
  ) => {
    if (origin === REMOTE_AWARENESS_ORIGIN) return;
    const clients = [...changes.added, ...changes.updated, ...changes.removed];
    if (clients.length > 0) {
      this.sendBinary(AWARENESS, encodeAwarenessUpdate(this.awareness, clients));
    }
  };

  private sendLocalAwareness() {
    if (this.awareness.getLocalState() !== null) {
      this.sendBinary(AWARENESS, encodeAwarenessUpdate(this.awareness, [this.doc.clientID]));
    }
  }

  private sendBinary(tag: number, payload: Uint8Array) {
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(frame(tag, this.fileIdBytes, payload));
      liveLog(this.target.fileId, `send ${tagName(tag)} (${payload.length}B)`);
    } else {
      liveLog(this.target.fileId, `send ${tagName(tag)} DROPPED (socket ${this.socket?.readyState ?? 'null'})`);
    }
  }

  private setStatus(status: LiveStatus) {
    if (this.status === status) return;
    liveLog(this.target.fileId, `status: ${this.status} -> ${status}`);
    this.status = status;
    for (const cb of this.statusCallbacks) cb(status);
  }

  getStatus() {
    return this.status;
  }

  onStatus(cb: (status: LiveStatus) => void) {
    this.statusCallbacks.add(cb);
    return () => this.statusCallbacks.delete(cb);
  }

  /**
   * Opens the socket and resolves once the document subscription is confirmed
   * (live), or `false` if the connection fails before that point. Used for the
   * initial live-vs-REST decision.
   */
  connectOnce(): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      let settled = false;
      const finish = (ok: boolean) => {
        if (settled) return;
        settled = true;
        resolve(ok);
      };
      const timeout = setTimeout(() => finish(false), CONNECT_TIMEOUT_MS);
      void this.openSocket((ok) => {
        clearTimeout(timeout);
        finish(ok);
      });
    });
  }

  private async openSocket(onSubscribed?: (ok: boolean) => void) {
    if (this.destroyed) {
      onSubscribed?.(false);
      return;
    }
    this.setStatus(this.reconnectAttempts === 0 ? 'connecting' : 'connecting');
    let ticket: { ticket: string; websocketUrl: string };
    try {
      ticket = await tauriCommands.hostedWsTicket(this.target.serverUrl, this.target.vaultId);
    } catch {
      onSubscribed?.(false);
      this.scheduleReconnect();
      return;
    }
    if (this.destroyed) {
      onSubscribed?.(false);
      return;
    }

    liveLog(this.target.fileId, `opening socket -> ${ticket.websocketUrl}`);
    let socket: WebSocket;
    try {
      socket = new WebSocket(ticket.websocketUrl);
    } catch {
      onSubscribed?.(false);
      this.scheduleReconnect();
      return;
    }
    socket.binaryType = 'arraybuffer';
    this.socket = socket;
    this.subscribedCallback = onSubscribed;
    this.initialSyncPending = false;

    socket.onopen = () => {
      socket.send(
        JSON.stringify({
          type: 'authenticate',
          ticket: ticket.ticket,
          protocolVersion: PROTOCOL_VERSION,
        }),
      );
    };
    socket.onmessage = (event) => this.handleMessage(event, onSubscribed);
    socket.onerror = () => {
      // `onclose` follows and handles reconnect.
    };
    socket.onclose = (event) => {
      liveLog(this.target.fileId, `socket closed`, { code: (event as CloseEvent)?.code, reason: (event as CloseEvent)?.reason });
      if (this.socket === socket) this.socket = null;
      onSubscribed?.(false);
      if (!this.destroyed) {
        this.setStatus('disconnected');
        this.scheduleReconnect();
      }
    };
  }

  private handleMessage(event: MessageEvent, onSubscribed?: (ok: boolean) => void) {
    if (typeof event.data === 'string') {
      let control: { type?: string; protocolVersion?: number; code?: string };
      try {
        control = JSON.parse(event.data);
      } catch {
        return;
      }
      liveLog(this.target.fileId, `recv control: ${control.type ?? '?'}`);
      switch (control.type) {
        case 'ready':
          // Protocol negotiation: the server echoes the version it accepted. A
          // mismatch is unrecoverable, so do not subscribe and stop retrying.
          if (
            typeof control.protocolVersion === 'number' &&
            control.protocolVersion !== PROTOCOL_VERSION
          ) {
            this.failFatally(onSubscribed);
            break;
          }
          this.socket?.send(
            JSON.stringify({ type: 'document.subscribe', fileId: this.target.fileId }),
          );
          break;
        case 'document.subscribed':
          this.reconnectAttempts = 0;
          // Pull anything the server has that we are missing.
          this.initialSyncPending = true;
          this.sendBinary(SYNC_STEP1, Y.encodeStateVector(this.doc));
          this.sendLocalAwareness();
          break;
        case 'error':
          if (control.code === PROTOCOL_VERSION_UNSUPPORTED) {
            // The server rejected our wire version: retrying cannot help.
            this.failFatally(onSubscribed);
          } else {
            // Other authentication/authorization failures may be transient (an
            // expired single-use ticket reconnects with a fresh one), so allow
            // the normal close-driven reconnect. The initial connect resolves as
            // failed so callers use REST.
            onSubscribed?.(false);
          }
          break;
        default:
          break;
      }
      return;
    }

    // Binary CRDT frame.
    const data = new Uint8Array(event.data as ArrayBuffer);
    if (data.length < HEADER_LEN) return;
    const tag = data[0];
    const payload = data.subarray(HEADER_LEN);
    liveLog(this.target.fileId, `recv ${tagName(tag)} (${payload.length}B)`);
    if (tag === SYNC_STEP1) {
      // Peer's state vector: reply with everything it is missing.
      const update = Y.encodeStateAsUpdate(this.doc, payload);
      this.sendBinary(SYNC_UPDATE, update);
    } else if (tag === SYNC_UPDATE) {
      Y.applyUpdate(this.doc, payload, REMOTE_ORIGIN);
      if (this.initialSyncPending) {
        this.initialSyncPending = false;
        this.setStatus('connected');
        this.subscribedCallback?.(true);
        this.subscribedCallback = undefined;
      }
    } else if (tag === AWARENESS) {
      try {
        applyAwarenessUpdate(this.awareness, payload, REMOTE_AWARENESS_ORIGIN);
      } catch {
        // Awareness is untrusted peer input. Ignore malformed ephemeral state
        // without interrupting the durable document session.
      }
    }
  }

  /**
   * Marks the session unrecoverable, resolves any pending connect as failed, and
   * closes the socket without scheduling a reconnect. Used for protocol-version
   * mismatches where retrying with the same client cannot succeed.
   */
  private failFatally(onSubscribed?: (ok: boolean) => void) {
    this.fatal = true;
    onSubscribed?.(false);
    this.subscribedCallback?.(false);
    this.subscribedCallback = undefined;
    this.setStatus('disconnected');
    const socket = this.socket;
    this.socket = null;
    if (socket) {
      socket.onclose = null;
      socket.onerror = null;
      socket.onmessage = null;
      try {
        socket.close();
      } catch {
        // ignore
      }
    }
  }

  private scheduleReconnect() {
    if (this.destroyed || this.fatal || this.reconnectTimer) return;
    const delay = Math.min(
      RECONNECT_BASE_MS * 2 ** this.reconnectAttempts,
      RECONNECT_MAX_MS,
    );
    this.reconnectAttempts += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.openSocket();
    }, delay);
  }

  noteSession(): LiveDocumentSession {
    return {
      ...this.handle(),
      text: this.doc.getText(NOTE_TEXT_NAME),
    };
  }

  destroy() {
    this.destroyed = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.offlineReplica) {
      // Flush the latest merged state before tearing down so the next session
      // (or app launch) seeds from the most recent edit — unless the offline
      // state was discarded as degenerate, in which case it must not be re-saved.
      if (this.persistTimer) {
        clearTimeout(this.persistTimer);
        this.persistTimer = null;
      }
      this.doc.off('update', this.handlePersistUpdate);
      if (!this.offlineDiscarded) void this.persistNow();
    }
    this.doc.off('update', this.handleLocalUpdate);
    // Broadcast a final removal update when destruction is graceful. Unexpected
    // disconnects still age out through y-protocols awareness staleness.
    removeAwarenessStates(this.awareness, [this.doc.clientID], 'destroy');
    this.awareness.off('update', this.handleAwarenessUpdate);
    if (this.socket) {
      this.socket.onclose = null;
      this.socket.onerror = null;
      this.socket.onmessage = null;
      try {
        this.socket.close();
      } catch {
        // ignore
      }
      this.socket = null;
    }
    this.awareness.destroy();
    this.doc.destroy();
  }
}

/**
 * Resolves the live target and opens a connected provider, or returns `null`
 * when live collaboration is unavailable so callers fall back to REST. Shared by
 * the note (text) and structured (JSON) session entry points.
 */
export interface ConnectLiveOptions {
  /**
   * Persist the merged CRDT state to the native offline replica and seed the
   * document from it before connecting, so edits survive across sessions and
   * reconcile via the reconnect state-vector handshake. Enabled for notes and
   * for structured (Kanban/canvas) documents; the structured open guards reject
   * a degenerate seed (empty or node-losing) and call `discardOfflineState()`
   * so a corrupt cached state cannot persist.
   */
  offlineReplica?: boolean;
}

export async function connectLiveProvider(
  client: VaultClient,
  relativePath: string,
  options: ConnectLiveOptions = {},
): Promise<WebSocketYProvider | null> {
  if (!client.resolveLiveSession) return null;
  let target: LiveTarget | null;
  try {
    target = await client.resolveLiveSession(relativePath);
  } catch {
    return null;
  }
  if (!target) return null;

  const provider = new WebSocketYProvider(target, options.offlineReplica ?? false);
  // Seed any offline edits before the handshake so the state vector reflects
  // them and the server sends back only what we are missing.
  await provider.hydrateFromReplica();
  const ok = await provider.connectOnce();
  if (!ok) {
    provider.destroy();
    return null;
  }
  return provider;
}

/**
 * Opens a live collaboration session for a hosted note, or returns `null` when
 * live collaboration is unavailable so the caller falls back to REST.
 */
export async function openLiveNoteSession(
  client: VaultClient,
  relativePath: string,
): Promise<LiveDocumentSession | null> {
  const provider = await connectLiveProvider(client, relativePath, { offlineReplica: true });
  return provider ? provider.noteSession() : null;
}
