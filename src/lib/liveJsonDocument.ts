import { useEffect, useState } from 'react';

import * as Y from 'yjs';

import { connectLiveProvider, type LiveDocumentHandle } from './liveDocumentSession';
import type { VaultClient } from './vaultClient';

/**
 * Live collaboration for structured JSON documents (Kanban boards, canvases).
 *
 * The document is represented as a Yjs `Y.Map` named `doc` whose shape mirrors
 * the JSON: objects become `Y.Map`s, arrays become `Y.Array`s, primitives are
 * stored directly. This is the same convention the server materializes from
 * (`crates/collab-server/src/ws.rs`), so the server can serialize the live state
 * back into `.kanban` / `.canvas` revisions.
 *
 * Edits are applied through {@link LiveJsonSession.writeJson}, which deep-diffs
 * the new value against the live structure and emits only the changed Yjs
 * operations. Arrays of objects that carry a stable `id` (cards, columns, nodes,
 * edges) are reconciled by id so concurrent edits to different items merge,
 * matching how the note text binding merges per-character edits. As with any
 * Yjs array, moving an item is expressed as remove+insert, so a reordered item
 * does not preserve a concurrent edit made to it during the move — an accepted
 * limitation shared by mature Yjs object bindings.
 */

const ROOT_MAP = 'doc';
/** Origin tag for our own writes, so we do not echo them back as remote changes. */
const LOCAL_ORIGIN = Symbol('live-json-local');

export type JsonValue =
  string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

export interface LiveJsonSession extends LiveDocumentHandle {
  /** Current document value read from the live structure. */
  readJson(): JsonObject;
  /** Reconcile a new document value into the live structure (a local edit). */
  writeJson(value: JsonObject): void;
  /** Subscribe to remote changes (not the caller's own writes). */
  onChange(cb: (value: JsonObject) => void): () => void;
}

export interface UseLiveJsonDocumentSessionOptions<TDocument> {
  client: VaultClient | null;
  relativePath: string | null;
  enabled: boolean;
  fromJson(value: JsonObject): TDocument | null;
  /**
   * Validates the initial live state before the view adopts it. Use this to
   * reject an empty/corrupt offline seed that would otherwise replace the
   * REST-canonical document.
   */
  validateInitial?(document: TDocument): boolean;
  applyDocument(document: TDocument, source: 'initial' | 'remote'): void;
}

function isPlainObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Converts a JSON value into a Yjs value (nested shared types for containers). */
export function toShared(value: JsonValue): unknown {
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

/** Reads a Yjs value back into a plain JSON value. */
export function yToJson(value: unknown): JsonValue {
  if (value instanceof Y.Text) return value.toString();
  if (value instanceof Y.Map) {
    const result: JsonObject = {};
    value.forEach((child, key) => {
      result[key] = yToJson(child);
    });
    return result;
  }
  if (value instanceof Y.Array) {
    return value.map((child) => yToJson(child));
  }
  // `yrs` may encode integral JSON numbers as Yjs BigInt. JavaScript bigint is
  // not valid JSON, breaks JSON.stringify, and is rejected by numeric canvas
  // validation. Structured documents use ordinary JSON numbers, so normalize
  // legacy/incoming bigint values at the transport boundary.
  if (typeof value === 'bigint') {
    return Number(value);
  }
  return value as JsonValue;
}

function stableEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a === 'bigint' || typeof b === 'bigint') {
    return Number(a) === Number(b);
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((value, index) => stableEqual(value, b[index]));
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const aKeys = Object.keys(a);
    const bKeys = Object.keys(b);
    return (
      aKeys.length === bKeys.length &&
      aKeys.every(
        (key) => Object.prototype.hasOwnProperty.call(b, key) && stableEqual(a[key], b[key]),
      )
    );
  }
  return false;
}

function entryId(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (value instanceof Y.Map) {
    const id = value.get('id');
    return typeof id === 'string' ? id : undefined;
  }
  if (isPlainObject(value) && typeof value.id === 'string') {
    return value.id;
  }
  return undefined;
}

/** Deep-reconciles a `Y.Map` to match a plain object, emitting minimal ops. */
export function reconcileMap(ymap: Y.Map<unknown>, obj: JsonObject) {
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

/** Deep-reconciles a `Y.Array` to match a plain array. */
export function reconcileArray(yarr: Y.Array<unknown>, arr: JsonValue[]) {
  const idKeyed = arr.length > 0 && arr.every((item) => entryId(item) !== undefined);
  if (!idKeyed) {
    // Non-entity arrays are replaced wholesale when they differ.
    if (!stableEqual(yToJson(yarr), arr)) {
      if (yarr.length > 0) yarr.delete(0, yarr.length);
      yarr.insert(
        0,
        arr.map((item) => toShared(item)),
      );
    }
    return;
  }

  const desiredIds = new Set(arr.map((item) => entryId(item)!));
  // Remove items no longer present (from the end to keep indices valid).
  for (let i = yarr.length - 1; i >= 0; i -= 1) {
    if (!desiredIds.has(entryId(yarr.get(i)) ?? '')) yarr.delete(i, 1);
  }
  // Reconcile / order by id, position by position.
  for (let index = 0; index < arr.length; index += 1) {
    const item = arr[index];
    const desiredId = entryId(item);
    const current = index < yarr.length ? yarr.get(index) : undefined;
    if (entryId(current) === desiredId) {
      if (current instanceof Y.Map && isPlainObject(item)) reconcileMap(current, item);
      continue;
    }
    let existingIndex = -1;
    for (let j = 0; j < yarr.length; j += 1) {
      if (entryId(yarr.get(j)) === desiredId) {
        existingIndex = j;
        break;
      }
    }
    if (existingIndex >= 0) yarr.delete(existingIndex, 1);
    yarr.insert(index, [toShared(item)]);
  }
  if (yarr.length > arr.length) yarr.delete(arr.length, yarr.length - arr.length);
}

/**
 * Opens a live structured-document session for a hosted Kanban board or canvas,
 * or returns `null` when live collaboration is unavailable so the caller falls
 * back to REST.
 */
export async function openLiveJsonSession(
  client: VaultClient,
  relativePath: string,
): Promise<LiveJsonSession | null> {
  // Persist + seed the structured CRDT state through the offline replica, like
  // notes, so unflushed live edits survive an app restart and reconcile via the
  // reconnect state-vector handshake. The Kanban/canvas open guards reject a
  // degenerate seed and call `discardOfflineState()` so a corrupt cache cannot
  // persist.
  const provider = await connectLiveProvider(client, relativePath, { offlineReplica: true });
  if (!provider) return null;

  const doc = provider.doc;
  const root = doc.getMap<unknown>(ROOT_MAP);

  return {
    ...provider.handle(),
    readJson: () => yToJson(root) as JsonObject,
    writeJson: (value: JsonObject) => {
      doc.transact(() => reconcileMap(root, value), LOCAL_ORIGIN);
    },
    onChange: (cb) => {
      const observer = (_events: unknown, transaction: Y.Transaction) => {
        // Skip our own writes; only surface remote (and seeded) changes.
        if (transaction.origin === LOCAL_ORIGIN) return;
        cb(yToJson(root) as JsonObject);
      };
      root.observeDeep(observer);
      return () => root.unobserveDeep(observer);
    },
  };
}

/**
 * Reusable React binding for structured live JSON documents. It intentionally
 * keeps document parsing/validation in the caller so each file type can enforce
 * its own invariants before accepting a live seed.
 */
export function useLiveJsonDocumentSession<TDocument>({
  client,
  relativePath,
  enabled,
  fromJson,
  validateInitial,
  applyDocument,
}: UseLiveJsonDocumentSessionOptions<TDocument>): LiveJsonSession | null {
  const [session, setSession] = useState<LiveJsonSession | null>(null);

  useEffect(() => {
    if (!enabled || !client || !relativePath || !client.resolveLiveSession) {
      setSession(null);
      return;
    }

    let cancelled = false;
    let opened: LiveJsonSession | null = null;
    let off: (() => void) | undefined;

    openLiveJsonSession(client, relativePath)
      .then((liveSession) => {
        if (cancelled || !liveSession) {
          liveSession?.destroy();
          return;
        }

        const initialJson = liveSession.readJson();
        const initial = Object.keys(initialJson).length > 0 ? fromJson(initialJson) : null;
        if (!initial || validateInitial?.(initial) === false) {
          liveSession.discardOfflineState();
          liveSession.destroy();
          return;
        }

        opened = liveSession;
        applyDocument(initial, 'initial');
        off = liveSession.onChange((json) => {
          if (cancelled) return;
          const next = fromJson(json);
          if (next) applyDocument(next, 'remote');
        });
        setSession(liveSession);
      })
      .catch(() => {
        // Best-effort; the caller's REST session remains active.
      });

    return () => {
      cancelled = true;
      off?.();
      opened?.destroy();
      setSession(null);
    };
  }, [applyDocument, client, enabled, fromJson, relativePath, validateInitial]);

  return session;
}
