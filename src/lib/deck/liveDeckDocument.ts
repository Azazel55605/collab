/**
 * The live form of a `.deck` presentation, on the desktop side.
 *
 * The deck lives in the structured root map (`doc`) the server materializes
 * from, with the same rules as `crates/collab-live/src/deck.rs`:
 *
 * - objects are `Y.Map`s and arrays `Y.Array`s, so different slides and
 *   different elements merge independently;
 * - rich text (an object whose only key is `paragraphs`) is one `Y.Text` in
 *   the `liveText.ts` encoding, so two people typing in one box merge
 *   character by character, and one's bold and another's italic both stay;
 * - geometry values (`frame`, `crop`, `from`, `to`, `size`) are written
 *   whole, so concurrent moves end at one position, never a mix.
 *
 * Local edits arrive as whole documents (the editor's operations stay pure);
 * `reconcileDeck` turns the difference into the smallest Yjs changes it can:
 * per-key map updates, id-keyed array moves, and, for text, a character diff
 * that keeps unchanged characters (and a peer's cursor in them) in place and
 * re-formats rather than re-types when only the formatting changed.
 */
import * as Y from 'yjs';

import type { DeckRichText } from '../../types/deck';

import {
  paragraphAttributes,
  readRichText,
  runAttributes,
  SOFT_BREAK,
  writeRichText,
} from './liveText';

export const DECK_ROOT_MAP = 'doc';
export const DECK_ATOMIC_KEYS: ReadonlySet<string> = new Set([
  'frame',
  'crop',
  'from',
  'to',
  'size',
]);

type Json = string | number | boolean | null | Json[] | { [key: string]: Json };
type JsonObject = { [key: string]: Json };

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** True for a `DeckRichText` value: an object whose only key is `paragraphs`. */
export function isRichText(value: unknown): value is DeckRichText {
  if (!isObject(value)) return false;
  const keys = Object.keys(value);
  return keys.length === 1 && keys[0] === 'paragraphs' && Array.isArray(value.paragraphs);
}

/* ------------------------------------------------------------------------- */
/* JSON <-> shared types                                                      */
/* ------------------------------------------------------------------------- */

/** A JSON value as the shared type it lives as. */
export function toDeckShared(value: Json, key?: string): unknown {
  if (key !== undefined && DECK_ATOMIC_KEYS.has(key)) return value;
  if (isRichText(value)) {
    // A new text queues its formatted inserts until it is integrated.
    const text = new Y.Text();
    writeRichText(text, value);
    return text;
  }
  if (Array.isArray(value)) {
    const array = new Y.Array<unknown>();
    array.push(value.map((item) => toDeckShared(item)));
    return array;
  }
  if (isObject(value)) {
    const map = new Y.Map<unknown>();
    for (const [childKey, child] of Object.entries(value)) {
      map.set(childKey, toDeckShared(child, childKey));
    }
    return map;
  }
  return value;
}

/** Reads a shared value back into JSON. Rich texts decode to `DeckRichText`. */
export function deckToJson(value: unknown): Json {
  if (value instanceof Y.Text) return readRichText(value) as unknown as Json;
  if (value instanceof Y.Map) {
    const result: JsonObject = {};
    value.forEach((child, key) => {
      result[key] = deckToJson(child);
    });
    return result;
  }
  if (value instanceof Y.Array) return value.map((child) => deckToJson(child));
  if (typeof value === 'bigint') return Number(value);
  if (isObject(value)) {
    // An atomic value; may hold bigints written by the server.
    return JSON.parse(
      JSON.stringify(value, (_key, entry: unknown) =>
        typeof entry === 'bigint' ? Number(entry) : entry,
      ),
    ) as Json;
  }
  return value as Json;
}

function equalJson(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((value, index) => equalJson(value, b[index]));
  }
  if (isObject(a) && isObject(b)) {
    const keys = Object.keys(a);
    return (
      keys.length === Object.keys(b).length &&
      keys.every((key) => Object.prototype.hasOwnProperty.call(b, key) && equalJson(a[key], b[key]))
    );
  }
  return false;
}

/* ------------------------------------------------------------------------- */
/* Rich-text diff                                                             */
/* ------------------------------------------------------------------------- */

type Attrs = Record<string, unknown>;
interface Unit {
  /** One UTF-16 code unit, as Yjs indexes text. */
  char: string;
  attrs: Attrs;
  key: string;
}

function attrKey(attrs: Attrs): string {
  return JSON.stringify(
    Object.keys(attrs)
      .filter((key) => attrs[key] !== null && attrs[key] !== undefined)
      .sort()
      .map((key) => [key, attrs[key]]),
  );
}

function pushUnits(units: Unit[], text: string, attrs: Attrs) {
  const key = attrKey(attrs);
  for (let index = 0; index < text.length; index += 1)
    units.push({ char: text[index], attrs, key });
}

/** The units a body is written as (the same as `writeRichText`). */
function bodyUnits(body: DeckRichText): Unit[] {
  const units: Unit[] = [];
  for (const paragraph of body.paragraphs) {
    for (const run of paragraph.runs) {
      const content = run.kind === 'break' ? SOFT_BREAK : run.text.replace(/[\n\u2028]/g, ' ');
      if (content === '') continue;
      pushUnits(
        units,
        content,
        runAttributes(run.style, run.kind === 'text' ? run.link : undefined),
      );
    }
    const attrs: Attrs = paragraphAttributes(paragraph);
    pushUnits(units, '\n', attrs);
  }
  return units;
}

function textUnits(text: Y.Text): Unit[] {
  const units: Unit[] = [];
  for (const op of text.toDelta() as Array<{ insert: unknown; attributes?: Attrs }>) {
    if (typeof op.insert !== 'string') continue;
    pushUnits(units, op.insert, op.attributes ?? {});
  }
  return units;
}

const isHigh = (char: string | undefined) => !!char && /[\uD800-\uDBFF]/.test(char);
const isLow = (char: string | undefined) => !!char && /[\uDC00-\uDFFF]/.test(char);

/**
 * Brings a `Y.Text` to a body with the smallest change: unchanged characters
 * at both ends stay (only re-formatted where their formatting changed) and
 * the characters between are replaced.
 */
export function reconcileRichText(text: Y.Text, body: DeckRichText): void {
  const current = textUnits(text);
  const next = bodyUnits(body);
  let prefix = 0;
  const limit = Math.min(current.length, next.length);
  while (prefix < limit && current[prefix].char === next[prefix].char) prefix += 1;
  let suffix = 0;
  while (
    suffix < limit - prefix &&
    current[current.length - 1 - suffix].char === next[next.length - 1 - suffix].char
  ) {
    suffix += 1;
  }
  // Never split a surrogate pair between kept and replaced text.
  if (prefix > 0 && isHigh(current[prefix - 1].char) && prefix < current.length) prefix -= 1;
  if (suffix > 0 && isLow(current[current.length - suffix]?.char) && suffix < limit - prefix + 1) {
    const at = current.length - suffix;
    if (at > prefix && isHigh(current[at - 1]?.char)) suffix -= 1;
  }

  const removeCount = current.length - prefix - suffix;
  if (removeCount > 0) text.delete(prefix, removeCount);
  // Insert the replaced middle, one call per formatting run.
  let at = prefix;
  const middle = next.slice(prefix, next.length - suffix);
  for (let start = 0; start < middle.length;) {
    let end = start + 1;
    while (end < middle.length && middle[end].key === middle[start].key) end += 1;
    text.insert(
      at,
      middle
        .slice(start, end)
        .map((unit) => unit.char)
        .join(''),
      { ...middle[start].attrs },
    );
    at += end - start;
    start = end;
  }

  // Re-format kept characters whose formatting changed.
  const reformat = (from: Unit[], to: Unit[], offset: number) => {
    for (let start = 0; start < to.length;) {
      if (from[start].key === to[start].key) {
        start += 1;
        continue;
      }
      let end = start + 1;
      while (
        end < to.length &&
        from[end].key === from[start].key &&
        to[end].key === to[start].key
      ) {
        end += 1;
      }
      const attrs: Attrs = { ...to[start].attrs };
      for (const key of Object.keys(from[start].attrs)) if (!(key in attrs)) attrs[key] = null;
      text.format(offset + start, end - start, attrs);
      start = end;
    }
  };
  reformat(current.slice(0, prefix), next.slice(0, prefix), 0);
  reformat(
    current.slice(current.length - suffix),
    next.slice(next.length - suffix),
    prefix + middle.length,
  );
}

/* ------------------------------------------------------------------------- */
/* Structural reconcile                                                       */
/* ------------------------------------------------------------------------- */

function entryId(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (value instanceof Y.Map) {
    const id = value.get('id');
    return typeof id === 'string' ? id : undefined;
  }
  if (isObject(value) && typeof value.id === 'string') return value.id;
  return undefined;
}

function reconcileValue(parent: Y.Map<unknown>, key: string, next: Json) {
  const current = parent.get(key);
  if (DECK_ATOMIC_KEYS.has(key)) {
    if (!equalJson(deckToJson(current), next)) parent.set(key, next);
    return;
  }
  if (current instanceof Y.Text && isRichText(next)) reconcileRichText(current, next);
  else if (current instanceof Y.Map && isObject(next) && !isRichText(next))
    reconcileMap(current, next);
  else if (current instanceof Y.Array && Array.isArray(next)) reconcileArray(current, next);
  else if (current === undefined || !equalJson(deckToJson(current), next))
    parent.set(key, toDeckShared(next, key));
}

function reconcileMap(map: Y.Map<unknown>, value: JsonObject) {
  for (const [key, next] of Object.entries(value)) reconcileValue(map, key, next);
  for (const key of Array.from(map.keys())) if (!(key in value)) map.delete(key);
}

/**
 * Arrays whose entries all have distinct ids (slide and element orders, group
 * children, sections, rows, series) are reconciled by id, so a concurrent
 * insert elsewhere survives a reorder; anything else is replaced whole.
 */
function reconcileArray(array: Y.Array<unknown>, value: Json[]) {
  const ids = value.map(entryId);
  const keyed =
    value.length > 0 && ids.every((id) => id !== undefined) && new Set(ids).size === ids.length;
  if (!keyed) {
    if (!equalJson(deckToJson(array), value)) {
      if (array.length > 0) array.delete(0, array.length);
      array.insert(
        0,
        value.map((item) => toDeckShared(item)),
      );
    }
    return;
  }
  const wanted = new Set(ids as string[]);
  for (let index = array.length - 1; index >= 0; index -= 1) {
    if (!wanted.has(entryId(array.get(index)) ?? '')) array.delete(index, 1);
  }
  // Duplicates a concurrent move can leave: keep the first.
  const seen = new Set<string>();
  for (let index = 0; index < array.length;) {
    const id = entryId(array.get(index)) ?? '';
    if (seen.has(id)) array.delete(index, 1);
    else {
      seen.add(id);
      index += 1;
    }
  }
  for (let index = 0; index < value.length; index += 1) {
    const item = value[index];
    const id = ids[index];
    const current = index < array.length ? array.get(index) : undefined;
    if (entryId(current) === id) {
      if (current instanceof Y.Map && isObject(item)) reconcileMap(current, item);
      continue;
    }
    let existing = -1;
    for (let other = index + 1; other < array.length; other += 1) {
      if (entryId(array.get(other)) === id) {
        existing = other;
        break;
      }
    }
    if (existing >= 0) array.delete(existing, 1);
    array.insert(index, [toDeckShared(item)]);
  }
  if (array.length > value.length) array.delete(value.length, array.length - value.length);
}

/** Writes a whole deck into an empty root (the seed for a new room). */
export function writeDeck(doc: Y.Doc, deck: object, origin?: unknown): void {
  doc.transact(() => {
    const root = doc.getMap<unknown>(DECK_ROOT_MAP);
    for (const [key, value] of Object.entries(deck as JsonObject)) {
      root.set(key, toDeckShared(value, key));
    }
  }, origin);
}

/** Reads the live deck as plain JSON, or null when the room is empty. */
export function readDeck(doc: Y.Doc): Record<string, unknown> | null {
  const root = doc.getMap<unknown>(DECK_ROOT_MAP);
  if (root.size === 0) return null;
  return deckToJson(root) as Record<string, unknown>;
}

/** Applies a local edit: the whole next deck, reconciled into the live state. */
export function reconcileDeck(doc: Y.Doc, deck: object, origin?: unknown): void {
  doc.transact(() => reconcileMap(doc.getMap<unknown>(DECK_ROOT_MAP), deck as JsonObject), origin);
}

/**
 * Three-way merge of one text body: what the document held (`base`), this
 * person's draft (`ours`), and what it holds now after a collaborator's edit
 * (`theirs`). Both edits are replayed as character changes on one `Y.Text`,
 * so typing in different places both survive, and the selection is carried
 * through the collaborator's edit by relative position.
 */
export function mergeRichText(
  base: DeckRichText,
  ours: DeckRichText,
  theirs: DeckRichText,
  selection: { anchor: number; focus: number },
): { body: DeckRichText; selection: { anchor: number; focus: number } } {
  const mine = new Y.Doc();
  mine.clientID = 1;
  const text = mine.getText('body');
  writeRichText(text, base);
  const other = new Y.Doc();
  other.clientID = 2;
  Y.applyUpdate(other, Y.encodeStateAsUpdate(mine));
  mine.transact(() => reconcileRichText(text, ours));
  other.transact(() => reconcileRichText(other.getText('body'), theirs));
  const anchor = Y.createRelativePositionFromTypeIndex(text, selection.anchor);
  const focus = Y.createRelativePositionFromTypeIndex(text, selection.focus);
  Y.applyUpdate(mine, Y.encodeStateAsUpdate(other, Y.encodeStateVector(mine)));
  const at = (position: Y.RelativePosition, fallback: number) =>
    Y.createAbsolutePositionFromRelativePosition(position, mine)?.index ?? fallback;
  return {
    body: readRichText(text),
    selection: { anchor: at(anchor, selection.anchor), focus: at(focus, selection.focus) },
  };
}
