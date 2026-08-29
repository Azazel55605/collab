import * as Y from 'yjs';

import type { InkDocument } from '../types/ink';

import { connectLiveProvider, type LiveDocumentHandle } from './liveDocumentSession';
import { type JsonObject, type JsonValue, reconcileArray, yToJson } from './liveJsonDocument';
import type { VaultClient } from './vaultClient';

const ROOT_MAP = 'doc';
const LOCAL_ORIGIN = Symbol('live-ink-local');

export interface LiveInkSession extends LiveDocumentHandle {
  readDocument(): InkDocument | null;
  writeDocument(document: InkDocument): void;
  onChange(cb: (document: InkDocument) => void): () => void;
}

function isPlainObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isInkTextObject(value: JsonObject): boolean {
  return value.type === 'text';
}

export function toInkShared(value: JsonValue, textValue = false): unknown {
  if (textValue && typeof value === 'string') {
    return new Y.Text(value);
  }
  if (Array.isArray(value)) {
    const array = new Y.Array<unknown>();
    array.push(value.map((item) => toInkShared(item)));
    return array;
  }
  if (isPlainObject(value)) {
    const map = new Y.Map<unknown>();
    const inkText = isInkTextObject(value);
    for (const [key, child] of Object.entries(value)) {
      map.set(key, toInkShared(child, inkText && key === 'text'));
    }
    return map;
  }
  return value;
}

function equalJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(yToJson(left)) === JSON.stringify(right);
}

function reconcileText(text: Y.Text, next: string) {
  const current = text.toString();
  if (current === next) return;
  let prefix = 0;
  const limit = Math.min(current.length, next.length);
  while (prefix < limit && current[prefix] === next[prefix]) prefix += 1;
  let suffix = 0;
  while (
    suffix < current.length - prefix &&
    suffix < next.length - prefix &&
    current[current.length - 1 - suffix] === next[next.length - 1 - suffix]
  ) {
    suffix += 1;
  }
  const remove = current.length - prefix - suffix;
  if (remove > 0) text.delete(prefix, remove);
  const insert = next.slice(prefix, next.length - suffix);
  if (insert) text.insert(prefix, insert);
}

export function reconcileInkMap(map: Y.Map<unknown>, value: JsonObject) {
  const inkText = isInkTextObject(value);
  for (const [key, next] of Object.entries(value)) {
    const current = map.get(key);
    if (inkText && key === 'text' && typeof next === 'string' && current instanceof Y.Text) {
      reconcileText(current, next);
    } else if (current instanceof Y.Map && isPlainObject(next)) {
      reconcileInkMap(current, next);
    } else if (current instanceof Y.Array && Array.isArray(next)) {
      reconcileArray(current, next);
    } else if (!equalJson(current, next)) {
      map.set(key, toInkShared(next, inkText && key === 'text'));
    }
  }
  for (const key of Array.from(map.keys())) {
    if (!(key in value)) map.delete(key);
  }
}

function readInk(root: Y.Map<unknown>): InkDocument | null {
  const value = yToJson(root);
  if (!isPlainObject(value) || Object.keys(value).length === 0) return null;
  return value as unknown as InkDocument;
}

/** Opens a hosted `.ink` document as one stable, offline-backed Yjs session. */
export async function openLiveInkSession(
  client: VaultClient,
  relativePath: string,
): Promise<LiveInkSession | null> {
  const provider = await connectLiveProvider(client, relativePath, { offlineReplica: true });
  if (!provider) return null;
  const root = provider.doc.getMap<unknown>(ROOT_MAP);

  return {
    ...provider.handle(),
    readDocument: () => readInk(root),
    writeDocument: (document) => {
      provider.doc.transact(
        () => reconcileInkMap(root, document as unknown as JsonObject),
        LOCAL_ORIGIN,
      );
    },
    onChange: (cb) => {
      const observer = (_events: unknown, transaction: Y.Transaction) => {
        if (transaction.origin === LOCAL_ORIGIN) return;
        const document = readInk(root);
        if (document) cb(document);
      };
      root.observeDeep(observer);
      return () => root.unobserveDeep(observer);
    },
  };
}
