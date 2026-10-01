/**
 * The deck live codec against real Yjs, peer to peer, and against the server's
 * encoding in both directions through two checked-in updates:
 *
 * - `deck-live-client.bin` is written here (the desktop encoding of the shared
 *   fixture) and materialized by `crates/collab-live/src/deck.rs`;
 * - `deck-live-server.bin` is written by that crate's tests (the server's
 *   seed) and decoded here.
 *
 * Regenerate the client update with
 * `COLLAB_UPDATE_FIXTURES=1 pnpm vitest run src/lib/deck/liveDeckDocument.test.ts`.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';

import type { DeckDocument, DeckRichText, DeckShapeElement } from '../../types/deck';

import { normalizeDeckDocument } from './document';
import { buildFixtureDeck } from './fixture';
import { mergeRichText, readDeck, reconcileDeck, writeDeck } from './liveDeckDocument';
import { addElements, removeElements } from './operations';

const FIXTURES = resolve(__dirname, '../../../crates/collab-live/fixtures');

/** The live form loses nothing, empty styled runs included. */
function canonical(deck: DeckDocument): DeckDocument {
  return JSON.parse(JSON.stringify(deck)) as DeckDocument;
}

function peers(deck: DeckDocument = buildFixtureDeck()) {
  const a = new Y.Doc();
  a.clientID = 11;
  writeDeck(a, deck);
  const b = new Y.Doc();
  b.clientID = 12;
  Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
  const sync = () => {
    const toB = Y.encodeStateAsUpdate(a, Y.encodeStateVector(b));
    const toA = Y.encodeStateAsUpdate(b, Y.encodeStateVector(a));
    Y.applyUpdate(b, toB);
    Y.applyUpdate(a, toA);
  };
  const read = (doc: Y.Doc) => readDeck(doc) as unknown as DeckDocument;
  return { a, b, sync, read };
}

function body(deck: DeckDocument, slideId: string, elementId: string): DeckRichText {
  const element = deck.slides[slideId].elements[elementId] as DeckShapeElement;
  return element.text!.content;
}

function withBody(
  deck: DeckDocument,
  slideId: string,
  elementId: string,
  edit: (text: DeckRichText) => DeckRichText,
): DeckDocument {
  const next = structuredClone(deck);
  const element = next.slides[slideId].elements[elementId] as DeckShapeElement;
  element.text!.content = edit(element.text!.content);
  return next;
}

const plain = (text: DeckRichText) =>
  text.paragraphs
    .map((paragraph) =>
      paragraph.runs.map((run) => (run.kind === 'text' ? run.text : ' ')).join(''),
    )
    .join('\n');

function prependText(text: DeckRichText, insert: string): DeckRichText {
  const next = structuredClone(text);
  const run = next.paragraphs[0].runs.find((entry) => entry.kind === 'text');
  if (run?.kind === 'text') run.text = insert + run.text;
  return next;
}

function appendText(text: DeckRichText, insert: string): DeckRichText {
  const next = structuredClone(text);
  const runs = next.paragraphs[next.paragraphs.length - 1].runs;
  const run = [...runs].reverse().find((entry) => entry.kind === 'text');
  if (run?.kind === 'text') run.text += insert;
  return next;
}

describe('deck live codec', () => {
  it('round-trips the fixture and writes the desktop encoding for the server tests', () => {
    const doc = new Y.Doc();
    doc.clientID = 7;
    writeDeck(doc, buildFixtureDeck());
    expect(readDeck(doc)).toEqual(canonical(buildFixtureDeck()));
    const update = Y.encodeStateAsUpdate(doc);
    const file = resolve(FIXTURES, 'deck-live-client.bin');
    if (process.env.COLLAB_UPDATE_FIXTURES) writeFileSync(file, update);
    // The checked-in update still decodes to the current fixture.
    const check = new Y.Doc();
    Y.applyUpdate(check, readFileSync(file));
    expect(readDeck(check)).toEqual(canonical(buildFixtureDeck()));
  });

  it('decodes the server’s seed of the same fixture', () => {
    const doc = new Y.Doc();
    Y.applyUpdate(doc, readFileSync(resolve(FIXTURES, 'deck-live-server.bin')));
    expect(readDeck(doc)).toEqual(canonical(buildFixtureDeck()));
  });

  it('merges edits to different slides, objects, and one text box', () => {
    const { a, b, sync, read } = peers();
    const base = read(a);
    // A moves a shape and types at the start of the body; B hides a slide
    // and types at the end of the same body.
    const fromA = withBody(base, 'slide-2', 's2-body', (text) => prependText(text, 'Alpha '));
    fromA.slides['slide-3'].elements['s3-card'].frame!.x = 1_234;
    reconcileDeck(a, fromA);
    const fromB = withBody(base, 'slide-2', 's2-body', (text) => appendText(text, ' Omega'));
    fromB.slides['slide-4'].hidden = true;
    reconcileDeck(b, fromB);
    sync();
    const merged = read(a);
    expect(merged).toEqual(read(b));
    expect(merged.slides['slide-3'].elements['s3-card'].frame!.x).toBe(1_234);
    expect(merged.slides['slide-4'].hidden).toBe(true);
    const text = plain(body(merged, 'slide-2', 's2-body'));
    expect(text.startsWith('Alpha ')).toBe(true);
    expect(text.endsWith(' Omega')).toBe(true);
  });

  it('keeps a peer’s typing inside a word another peer makes bold', () => {
    const { a, b, sync, read } = peers();
    const base = read(a);
    const original = body(base, 'slide-2', 's2-body');
    // A bolds the whole first paragraph; B types into its middle.
    reconcileDeck(
      a,
      withBody(base, 'slide-2', 's2-body', (text) => {
        const next = structuredClone(text);
        for (const run of next.paragraphs[0].runs) {
          if (run.kind === 'text') run.style = { ...run.style, italic: true };
        }
        return next;
      }),
    );
    reconcileDeck(
      b,
      withBody(base, 'slide-2', 's2-body', (text) => {
        const next = structuredClone(text);
        const run = next.paragraphs[0].runs.find((entry) => entry.kind === 'text');
        if (run?.kind === 'text') run.text = `${run.text.slice(0, 3)}XYZ${run.text.slice(3)}`;
        return next;
      }),
    );
    sync();
    const merged = body(read(a), 'slide-2', 's2-body');
    expect(merged).toEqual(body(read(b), 'slide-2', 's2-body'));
    const first = merged.paragraphs[0];
    expect(first.runs.map((run) => (run.kind === 'text' ? run.text : '')).join('')).toContain(
      'XYZ',
    );
    // A formatting change re-formats; it never re-types the paragraph.
    expect(first.runs.every((run) => run.kind !== 'text' || run.style?.italic)).toBe(true);
    expect(merged.paragraphs.length).toBe(original.paragraphs.length);
  });

  it('two concurrent moves end at one position, never a mix', () => {
    const { a, b, sync, read } = peers();
    const base = read(a);
    const moveTo = (x: number, y: number) => {
      const next = structuredClone(base);
      const frame = next.slides['slide-3'].elements['s3-card'].frame!;
      frame.x = x;
      frame.y = y;
      return next;
    };
    reconcileDeck(a, moveTo(100, 100));
    reconcileDeck(b, moveTo(5_000, 5_000));
    sync();
    const frame = read(a).slides['slide-3'].elements['s3-card'].frame!;
    expect([
      [100, 100],
      [5_000, 5_000],
    ]).toContainEqual([frame.x, frame.y]);
    expect(read(b).slides['slide-3'].elements['s3-card'].frame).toEqual(frame);
  });

  it('repairs double orders and lets a delete win over a concurrent move', () => {
    const { a, b, sync, read } = peers();
    const base = read(a);
    const toFront = (deck: DeckDocument) => {
      const next = structuredClone(deck);
      next.slideOrder = ['slide-5', ...next.slideOrder.filter((id) => id !== 'slide-5')];
      return next;
    };
    // Both move slide 5 first; A deletes a shape that B moves.
    reconcileDeck(a, removeElements(toFront(base), 'slide-3', ['s3-card']).result);
    const moved = toFront(base);
    moved.slides['slide-3'].elements['s3-card'].frame!.x = 42;
    reconcileDeck(b, moved);
    sync();
    const merged = normalizeDeckDocument(read(a)).document;
    expect(merged.slideOrder[0]).toBe('slide-5');
    expect(new Set(merged.slideOrder).size).toBe(merged.slideOrder.length);
    expect(merged.slides['slide-3'].elements['s3-card']).toBeUndefined();
    expect(merged.slides['slide-3'].elementOrder).not.toContain('s3-card');
    // Writing the repaired deck back leaves a clean live state for everyone.
    reconcileDeck(a, merged);
    sync();
    expect(read(b).slideOrder).toEqual(merged.slideOrder);
  });

  it('reconciles only what changed', () => {
    const { a, read } = peers();
    const base = read(a);
    const updates: Uint8Array[] = [];
    a.on('update', (update: Uint8Array) => updates.push(update));
    const element = {
      ...base.slides['slide-1'].elements[base.slides['slide-1'].elementOrder[0]],
      id: 'added',
    };
    reconcileDeck(a, addElements(base, 'slide-1', [element]).result);
    expect(updates).toHaveLength(1);
    // Adding one element is a small update, not a rewrite of the deck.
    expect(updates[0].length).toBeLessThan(2_000);
    const before = updates.length;
    reconcileDeck(a, read(a));
    expect(updates.length).toBe(before);
  });

  it('rebases a text draft onto a collaborator’s typing, carrying the caret', () => {
    const base = body(buildFixtureDeck(), 'slide-2', 's2-body');
    const ours = appendText(base, '!');
    const theirs = prependText(base, 'Hi ');
    const end = plain(ours).length;
    const merged = mergeRichText(base, ours, theirs, { anchor: end, focus: end });
    const text = plain(merged.body);
    expect(text.startsWith('Hi ')).toBe(true);
    expect(text.endsWith('!')).toBe(true);
    // The caret was after "!"; the three characters typed before it move it.
    expect(merged.selection).toEqual({ anchor: end + 3, focus: end + 3 });
  });
});
