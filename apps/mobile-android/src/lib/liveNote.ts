import { Channel } from '@tauri-apps/api/core';
import * as Y from 'yjs';
import { Awareness, applyAwarenessUpdate, encodeAwarenessUpdate, removeAwarenessStates } from 'y-protocols/awareness';

import {
  hostedWsTicket,
  liveWsClose,
  liveWsConnect,
  liveWsSend,
  replicaCacheCrdtState,
  replicaClearCrdtState,
  replicaReadCrdtState,
  type LiveWsEvent,
} from '../mobileTauri';

const SYNC_STEP1 = 1;
const SYNC_UPDATE = 2;
const AWARENESS = 3;
const HEADER_LEN = 17;
const PROTOCOL_VERSION = 1;
const NOTE_TEXT_NAME = 'content';
const ROOT_MAP_NAME = 'doc';
const CONNECT_TIMEOUT_MS = 8000;
const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 15000;
const PERSIST_DEBOUNCE_MS = 800;
const RELEASE_GRACE_MS = 30000;

const REMOTE_ORIGIN = Symbol('mobile-live-remote');
const SEED_ORIGIN = Symbol('mobile-live-seed');
const REMOTE_AWARENESS_ORIGIN = Symbol('mobile-live-awareness-remote');
const LOCAL_JSON_ORIGIN = Symbol('mobile-live-json-local');

export type LiveStatus = 'connecting' | 'connected' | 'disconnected';
export type MobileLiveDocumentKind = 'note' | 'kanban' | 'canvas' | 'logic';
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

export interface MobileLiveNoteSession {
  readonly doc: Y.Doc;
  readonly text: Y.Text;
  readonly awareness: Awareness;
  getStatus(): LiveStatus;
  onStatus(cb: (status: LiveStatus) => void): () => void;
  destroy(): void;
}

export interface MobileLiveJsonSession {
  readonly doc: Y.Doc;
  readonly awareness: Awareness;
  readJson(): JsonObject;
  writeJson(value: JsonObject): void;
  onChange(cb: (value: JsonObject) => void): () => void;
  getStatus(): LiveStatus;
  onStatus(cb: (status: LiveStatus) => void): () => void;
  destroy(): void;
}

function isPlainObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function toShared(value: JsonValue): unknown {
  if (Array.isArray(value)) {
    const array = new Y.Array<unknown>();
    array.push(value.map((item) => toShared(item)));
    return array;
  }
  if (isPlainObject(value)) {
    const map = new Y.Map<unknown>();
    for (const [key, child] of Object.entries(value)) {
      map.set(key, toShared(child));
    }
    return map;
  }
  return value;
}

function yToJson(value: unknown): JsonValue {
  if (value instanceof Y.Map) {
    const result: JsonObject = {};
    value.forEach((child, key) => {
      result[key] = yToJson(child);
    });
    return result;
  }
  if (value instanceof Y.Array) return value.map((child) => yToJson(child));
  if (typeof value === 'bigint') return Number(value);
  return value as JsonValue;
}

function stableEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a === 'bigint' || typeof b === 'bigint') return Number(a) === Number(b);
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((value, index) => stableEqual(value, b[index]));
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const aKeys = Object.keys(a);
    const bKeys = Object.keys(b);
    return aKeys.length === bKeys.length
      && aKeys.every((key) => Object.prototype.hasOwnProperty.call(b, key) && stableEqual(a[key], b[key]));
  }
  return false;
}

function entryId(value: unknown): string | undefined {
  if (value instanceof Y.Map) {
    const id = value.get('id');
    return typeof id === 'string' ? id : undefined;
  }
  if (isPlainObject(value) && typeof value.id === 'string') return value.id;
  return undefined;
}

function reconcileMap(ymap: Y.Map<unknown>, obj: JsonObject) {
  for (const [key, next] of Object.entries(obj)) {
    const current = ymap.get(key);
    if (current instanceof Y.Map && isPlainObject(next)) {
      reconcileMap(current, next);
    } else if (current instanceof Y.Array && Array.isArray(next)) {
      reconcileArray(current, next);
    } else if (!stableEqual(yToJson(current), next)) {
      ymap.set(key, toShared(next));
    }
  }
  for (const key of Array.from(ymap.keys())) {
    if (!(key in obj)) ymap.delete(key);
  }
}

function reconcileArray(yarr: Y.Array<unknown>, arr: JsonValue[]) {
  const idKeyed = arr.length > 0 && arr.every((item) => entryId(item) !== undefined);
  if (!idKeyed) {
    if (!stableEqual(yToJson(yarr), arr)) {
      if (yarr.length > 0) yarr.delete(0, yarr.length);
      yarr.insert(0, arr.map((item) => toShared(item)));
    }
    return;
  }

  const desiredIds = new Set(arr.map((item) => entryId(item)!));
  for (let i = yarr.length - 1; i >= 0; i -= 1) {
    if (!desiredIds.has(entryId(yarr.get(i)) ?? '')) yarr.delete(i, 1);
  }
  for (let index = 0; index < arr.length; index += 1) {
    const item = arr[index] as JsonObject;
    const current = index < yarr.length ? yarr.get(index) : undefined;
    if (current instanceof Y.Map && entryId(current) === item.id) {
      reconcileMap(current, item);
      continue;
    }
    let existingIndex = -1;
    for (let j = 0; j < yarr.length; j += 1) {
      if (entryId(yarr.get(j)) === item.id) {
        existingIndex = j;
        break;
      }
    }
    if (existingIndex >= 0) yarr.delete(existingIndex, 1);
    yarr.insert(index, [toShared(item)]);
  }
  if (yarr.length > arr.length) yarr.delete(arr.length, yarr.length - arr.length);
}

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

function base64ToArrayBuffer(base64: string): ArrayBuffer {
  return base64ToBytes(base64).buffer;
}

function encodeFileId(fileId: string): Uint8Array {
  const hex = fileId.replace(/-/g, '');
  const bytes = new Uint8Array(16);
  for (let i = 0; i < 16; i += 1) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return bytes;
}

function frame(tag: number, fileIdBytes: Uint8Array, payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(HEADER_LEN + payload.length);
  out[0] = tag;
  out.set(fileIdBytes, 1);
  out.set(payload, HEADER_LEN);
  return out;
}

class MobileLiveSocket {
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string | ArrayBuffer }) => void) | null = null;
  onclose: ((event: { code?: number }) => void) | null = null;
  onerror: (() => void) | null = null;

  private id: number | null = null;
  private closed = false;

  constructor(serverUrl: string, websocketUrl: string) {
    const channel = new Channel<LiveWsEvent>();
    channel.onmessage = (event) => this.handleEvent(event);
    liveWsConnect(serverUrl, websocketUrl, channel)
      .then((id) => {
        if (this.closed) {
          void liveWsClose(id).catch(() => {});
          return;
        }
        this.id = id;
        this.readyState = 1;
        this.onopen?.();
      })
      .catch(() => {
        this.readyState = 3;
        this.onerror?.();
        this.onclose?.({ code: 1006 });
      });
  }

  private handleEvent(event: LiveWsEvent) {
    if (this.closed) return;
    if (event.type === 'text') this.onmessage?.({ data: event.data });
    else if (event.type === 'binary') this.onmessage?.({ data: base64ToArrayBuffer(event.data) });
    else {
      this.readyState = 3;
      if (this.id !== null) {
        const id = this.id;
        this.id = null;
        void liveWsClose(id).catch(() => {});
      }
      this.onclose?.({ code: event.code ?? undefined });
    }
  }

  send(data: string | Uint8Array) {
    if (this.id === null || this.readyState !== 1) return;
    if (typeof data === 'string') void liveWsSend(this.id, 'text', data).catch(() => {});
    else void liveWsSend(this.id, 'binary', bytesToBase64(data)).catch(() => {});
  }

  close() {
    this.closed = true;
    this.readyState = 3;
    if (this.id !== null) {
      const id = this.id;
      this.id = null;
      void liveWsClose(id).catch(() => {});
    }
  }
}

class MobileLiveProvider implements MobileLiveNoteSession {
  readonly doc = new Y.Doc();
  readonly text = this.doc.getText(NOTE_TEXT_NAME);
  readonly awareness = new Awareness(this.doc);

  private readonly fileIdBytes: Uint8Array;
  private socket: MobileLiveSocket | null = null;
  private destroyed = false;
  private status: LiveStatus = 'connecting';
  private statusCallbacks = new Set<(status: LiveStatus) => void>();
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private subscribedCallback: ((ok: boolean) => void) | null = null;
  private initialSyncPending = false;
  private persistTimer: ReturnType<typeof setTimeout> | null = null;
  private replicaSeeded = false;

  constructor(
    private readonly serverUrl: string,
    private readonly vaultId: string,
    private readonly fileId: string,
  ) {
    this.fileIdBytes = encodeFileId(fileId);
    this.doc.on('update', this.handleLocalUpdate);
    this.doc.on('update', this.handlePersistUpdate);
    this.awareness.on('update', this.handleAwarenessUpdate);
  }

  async hydrateFromReplica(): Promise<void> {
    try {
      const base64 = await replicaReadCrdtState(this.serverUrl, this.vaultId, this.fileId);
      if (base64 && !this.destroyed) {
        this.replicaSeeded = true;
        Y.applyUpdate(this.doc, base64ToBytes(base64), SEED_ORIGIN);
      }
    } catch {
      // Best effort. The server handshake will seed the missing state.
    }
  }

  hasReplicaSeed(): boolean {
    return this.replicaSeeded;
  }

  connectOnce(): Promise<boolean> {
    return new Promise((resolve) => {
      let settled = false;
      const finish = (ok: boolean) => {
        if (settled) return;
        settled = true;
        resolve(ok);
      };
      const timeout = setTimeout(() => {
        this.setStatus('disconnected');
        this.scheduleReconnect();
        finish(false);
      }, CONNECT_TIMEOUT_MS);
      void this.openSocket((ok) => {
        clearTimeout(timeout);
        finish(ok);
      });
    });
  }

  getStatus() {
    return this.status;
  }

  onStatus(cb: (status: LiveStatus) => void) {
    this.statusCallbacks.add(cb);
    return () => this.statusCallbacks.delete(cb);
  }

  private setStatus(status: LiveStatus) {
    if (this.status === status) return;
    this.status = status;
    for (const cb of this.statusCallbacks) cb(status);
  }

  private async openSocket(onSubscribed?: (ok: boolean) => void) {
    if (this.destroyed) {
      onSubscribed?.(false);
      return;
    }
    this.setStatus('connecting');
    let ticket: Awaited<ReturnType<typeof hostedWsTicket>>;
    try {
      ticket = await hostedWsTicket(this.serverUrl, this.vaultId);
    } catch {
      onSubscribed?.(false);
      this.setStatus('disconnected');
      this.scheduleReconnect();
      return;
    }
    if (this.destroyed) {
      onSubscribed?.(false);
      return;
    }

    const socket = new MobileLiveSocket(this.serverUrl, ticket.websocketUrl);
    this.socket = socket;
    this.subscribedCallback = onSubscribed ?? null;
    this.initialSyncPending = false;

    socket.onopen = () => {
      socket.send(JSON.stringify({ type: 'authenticate', ticket: ticket.ticket, protocolVersion: PROTOCOL_VERSION }));
    };
    socket.onmessage = (event) => this.handleMessage(event);
    socket.onerror = () => {};
    socket.onclose = () => {
      if (this.socket === socket) this.socket = null;
      onSubscribed?.(false);
      if (!this.destroyed) {
        this.setStatus('disconnected');
        this.scheduleReconnect();
      }
    };
  }

  private handleMessage(event: { data: string | ArrayBuffer }) {
    if (typeof event.data === 'string') {
      let control: { type?: string; protocolVersion?: number; code?: string };
      try {
        control = JSON.parse(event.data);
      } catch {
        return;
      }
      if (control.type === 'ready') {
        if (typeof control.protocolVersion === 'number' && control.protocolVersion !== PROTOCOL_VERSION) {
          this.subscribedCallback?.(false);
          this.destroy();
          return;
        }
        this.socket?.send(JSON.stringify({ type: 'document.subscribe', fileId: this.fileId }));
      } else if (control.type === 'document.subscribed') {
        this.reconnectAttempts = 0;
        this.initialSyncPending = true;
        this.sendBinary(SYNC_STEP1, Y.encodeStateVector(this.doc));
        this.sendBinary(SYNC_UPDATE, Y.encodeStateAsUpdate(this.doc));
        this.sendLocalAwareness();
      } else if (control.type === 'error') {
        this.subscribedCallback?.(false);
      }
      return;
    }

    const data = new Uint8Array(event.data);
    if (data.length < HEADER_LEN) return;
    const tag = data[0];
    const payload = data.subarray(HEADER_LEN);
    if (tag === SYNC_STEP1) {
      this.sendBinary(SYNC_UPDATE, Y.encodeStateAsUpdate(this.doc, payload));
    } else if (tag === SYNC_UPDATE) {
      Y.applyUpdate(this.doc, payload, REMOTE_ORIGIN);
      if (this.initialSyncPending) {
        this.initialSyncPending = false;
        this.setStatus('connected');
        this.subscribedCallback?.(true);
        this.subscribedCallback = null;
      }
    } else if (tag === AWARENESS) {
      try {
        applyAwarenessUpdate(this.awareness, payload, REMOTE_AWARENESS_ORIGIN);
      } catch {
        // Ephemeral peer state is untrusted. Ignore malformed awareness frames.
      }
    }
  }

  private handleLocalUpdate = (update: Uint8Array, origin: unknown) => {
    if (origin === REMOTE_ORIGIN || origin === SEED_ORIGIN) return;
    this.sendBinary(SYNC_UPDATE, update);
  };

  private handlePersistUpdate = (_update: Uint8Array, origin: unknown) => {
    if (origin === SEED_ORIGIN) return;
    if (this.socket?.readyState !== 1) {
      if (this.persistTimer) {
        clearTimeout(this.persistTimer);
        this.persistTimer = null;
      }
      void this.persistNow();
      return;
    }
    this.schedulePersist();
  };

  private handleAwarenessUpdate = (
    changes: { added: number[]; updated: number[]; removed: number[] },
    origin: unknown,
  ) => {
    if (origin === REMOTE_AWARENESS_ORIGIN) return;
    const clients = [...changes.added, ...changes.updated, ...changes.removed];
    if (clients.length > 0) this.sendBinary(AWARENESS, encodeAwarenessUpdate(this.awareness, clients));
  };

  private sendLocalAwareness() {
    if (this.awareness.getLocalState() !== null) {
      this.sendBinary(AWARENESS, encodeAwarenessUpdate(this.awareness, [this.doc.clientID]));
    }
  }

  private sendBinary(tag: number, payload: Uint8Array) {
    if (this.socket?.readyState === 1) this.socket.send(frame(tag, this.fileIdBytes, payload));
  }

  private schedulePersist() {
    if (this.persistTimer) clearTimeout(this.persistTimer);
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      void this.persistNow();
    }, PERSIST_DEBOUNCE_MS);
  }

  private async persistNow() {
    try {
      await replicaCacheCrdtState(
        this.serverUrl,
        this.vaultId,
        this.fileId,
        bytesToBase64(Y.encodeStateAsUpdate(this.doc)),
      );
    } catch {
      // Best-effort offline cache.
    }
  }

  private scheduleReconnect() {
    if (this.destroyed || this.reconnectTimer) return;
    const delay = Math.min(RECONNECT_BASE_MS * 2 ** this.reconnectAttempts, RECONNECT_MAX_MS);
    this.reconnectAttempts += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.openSocket();
    }, delay);
  }

  destroy() {
    this.destroyed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.persistTimer) clearTimeout(this.persistTimer);
    void this.persistNow();
    this.doc.off('update', this.handleLocalUpdate);
    this.doc.off('update', this.handlePersistUpdate);
    removeAwarenessStates(this.awareness, [this.doc.clientID], 'destroy');
    this.awareness.off('update', this.handleAwarenessUpdate);
    this.socket?.close();
    this.socket = null;
    this.awareness.destroy();
    this.doc.destroy();
  }
}

interface CachedProvider {
  provider: MobileLiveProvider;
  refs: number;
  releaseTimer: ReturnType<typeof setTimeout> | null;
}

const providerCache = new Map<string, CachedProvider>();

function providerKey(
  kind: MobileLiveDocumentKind,
  serverUrl: string,
  vaultId: string,
  fileId: string,
): string {
  return `${kind}:${serverUrl}:${vaultId}:${fileId}`;
}

function retainCachedProvider(key: string, provider: MobileLiveProvider): CachedProvider {
  const existing = providerCache.get(key);
  if (existing) {
    if (existing.releaseTimer) {
      clearTimeout(existing.releaseTimer);
      existing.releaseTimer = null;
    }
    existing.refs += 1;
    return existing;
  }
  const entry: CachedProvider = { provider, refs: 1, releaseTimer: null };
  providerCache.set(key, entry);
  return entry;
}

function releaseCachedProvider(key: string) {
  const entry = providerCache.get(key);
  if (!entry) return;
  entry.refs = Math.max(0, entry.refs - 1);
  if (entry.refs > 0 || entry.releaseTimer) return;
  entry.releaseTimer = setTimeout(() => {
    const current = providerCache.get(key);
    if (!current || current.refs > 0) return;
    providerCache.delete(key);
    current.provider.destroy();
  }, RELEASE_GRACE_MS);
}

async function openCachedProvider(
  kind: MobileLiveDocumentKind,
  serverUrl: string,
  vaultId: string,
  fileId: string,
): Promise<{ key: string; provider: MobileLiveProvider } | null> {
  const key = providerKey(kind, serverUrl, vaultId, fileId);
  const cached = providerCache.get(key);
  if (cached) {
    retainCachedProvider(key, cached.provider);
    return { key, provider: cached.provider };
  }

  const provider = new MobileLiveProvider(serverUrl, vaultId, fileId);
  await provider.hydrateFromReplica();
  const ok = await provider.connectOnce();
  provider.awareness.setLocalStateField('document', { kind });
  if (!ok) {
    if (!provider.hasReplicaSeed()) {
      provider.destroy();
      return null;
    }
    retainCachedProvider(key, provider);
    return { key, provider };
  }
  retainCachedProvider(key, provider);
  return { key, provider };
}

export async function openMobileLiveNoteSession(
  serverUrl: string,
  vaultId: string,
  fileId: string,
): Promise<MobileLiveNoteSession | null> {
  const opened = await openCachedProvider('note', serverUrl, vaultId, fileId);
  if (!opened) return null;
  const { key, provider } = opened;
  return {
    doc: provider.doc,
    text: provider.text,
    awareness: provider.awareness,
    getStatus: () => provider.getStatus(),
    onStatus: (cb) => provider.onStatus(cb),
    destroy: () => releaseCachedProvider(key),
  };
}

export async function openMobileLiveJsonSession(
  serverUrl: string,
  vaultId: string,
  fileId: string,
  kind: Exclude<MobileLiveDocumentKind, 'note'>,
): Promise<MobileLiveJsonSession | null> {
  const opened = await openCachedProvider(kind, serverUrl, vaultId, fileId);
  if (!opened) return null;
  const { key, provider } = opened;
  const root = provider.doc.getMap<unknown>(ROOT_MAP_NAME);

  return {
    doc: provider.doc,
    awareness: provider.awareness,
    readJson: () => yToJson(root) as JsonObject,
    writeJson: (value: JsonObject) => {
      provider.doc.transact(() => reconcileMap(root, value), LOCAL_JSON_ORIGIN);
    },
    onChange: (cb) => {
      const observer = (_events: unknown, transaction: Y.Transaction) => {
        if (transaction.origin === LOCAL_JSON_ORIGIN) return;
        cb(yToJson(root) as JsonObject);
      };
      root.observeDeep(observer);
      return () => root.unobserveDeep(observer);
    },
    getStatus: () => provider.getStatus(),
    onStatus: (cb) => provider.onStatus(cb),
    destroy: () => releaseCachedProvider(key),
  };
}

export function clearMobileLiveNoteState(serverUrl: string, vaultId: string, fileId: string): Promise<void> {
  return replicaClearCrdtState(serverUrl, vaultId, fileId);
}
