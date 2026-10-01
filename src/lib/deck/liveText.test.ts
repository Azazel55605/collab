import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';

import type { DeckRichText } from '../../types/deck';

import { buildFixtureDeck, paragraph, richText } from './fixture';
import {
  formatRange,
  offsetOf,
  readRichText,
  setParagraphStyle,
  splitParagraph,
  writeRichText,
} from './liveText';

/** Two peers editing one text box, each with its own document. */
function peers(initial: DeckRichText) {
  const a = new Y.Doc();
  a.clientID = 1;
  const b = new Y.Doc();
  b.clientID = 2;
  writeRichText(a.getText('body'), initial);
  Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
  const sync = () => {
    // Exchange only what each side is missing, as the live socket does.
    const toB = Y.encodeStateAsUpdate(a, Y.encodeStateVector(b));
    const toA = Y.encodeStateAsUpdate(b, Y.encodeStateVector(a));
    Y.applyUpdate(b, toB);
    Y.applyUpdate(a, toA);
  };
  return { a: a.getText('body'), b: b.getText('body'), docA: a, docB: b, sync };
}

const plain = (text: DeckRichText) =>
  text.paragraphs.map((p) => p.runs.map((run) => (run.kind === 'text' ? run.text : '\n')).join(''));

describe('live rich text', () => {
  it('round-trips every fixture body losslessly', () => {
    const deck = buildFixtureDeck();
    const bodies: DeckRichText[] = [];
    for (const slide of Object.values(deck.slides)) {
      for (const element of Object.values(slide.elements)) {
        if ((element.type === 'text' || element.type === 'shape') && element.text)
          bodies.push(element.text.content);
      }
      if (slide.speakerNotes) bodies.push(slide.speakerNotes);
    }
    expect(bodies.length).toBeGreaterThan(8);
    for (const body of bodies) {
      const text = new Y.Doc().getText('body');
      writeRichText(text, body);
      // Lossless, empty styled runs included: a placeholder's empty run is
      // where its colour and font come from.
      const expected = JSON.parse(JSON.stringify(body)) as DeckRichText;
      expect(readRichText(text)).toEqual(expected);
    }
  });

  it('merges concurrent typing at different places in one paragraph', () => {
    const { a, b, sync } = peers(richText(paragraph('p1', 'Hello world')));
    a.insert(offsetOf(a, 'p1', 5), ',');
    b.insert(offsetOf(b, 'p1', 11), '!');
    sync();
    expect(plain(readRichText(a))).toEqual(['Hello, world!']);
    expect(readRichText(b)).toEqual(readRichText(a));
  });

  it('keeps both insertions at the same position, in the same order on both peers', () => {
    const { a, b, sync } = peers(richText(paragraph('p1', 'ab')));
    a.insert(1, 'X');
    b.insert(1, 'Y');
    sync();
    const result = plain(readRichText(a))[0];
    expect(result.split('').sort().join('')).toBe('XYab');
    expect(plain(readRichText(b))[0]).toBe(result);
  });

  it('merges one peer bolding a word while another types inside it', () => {
    const { a, b, sync } = peers(richText(paragraph('p1', 'make this bold')));
    formatRange(a, offsetOf(a, 'p1', 5), 4, { b: true });
    b.insert(offsetOf(b, 'p1', 7), 'IS');
    sync();
    const runs = readRichText(a).paragraphs[0].runs;
    expect(runs.map((run) => (run.kind === 'text' ? run.text : ''))).toEqual([
      'make ',
      'thISis',
      ' bold',
    ]);
    expect(runs[1].style?.bold).toBe(true);
    expect(readRichText(b)).toEqual(readRichText(a));
  });

  it('keeps both peers’ overlapping bold and italic', () => {
    const { a, b, sync } = peers(richText(paragraph('p1', 'overlap here')));
    formatRange(a, 0, 7, { b: true });
    formatRange(b, 4, 8, { i: true });
    sync();
    const runs = readRichText(a).paragraphs[0].runs;
    const styleAt = (text: string) =>
      runs.find((run) => run.kind === 'text' && run.text === text)?.style;
    expect(styleAt('over')).toEqual({ bold: true });
    expect(styleAt('lap')).toEqual({ bold: true, italic: true });
    expect(styleAt(' here')).toEqual({ italic: true });
  });

  it('moves concurrent typing into the new paragraph when a peer splits', () => {
    const { a, b, sync } = peers(richText(paragraph('p1', 'first second')));
    splitParagraph(a, offsetOf(a, 'p1', 6), 'p0');
    b.insert(offsetOf(b, 'p1', 12), ' third');
    sync();
    const result = readRichText(a);
    expect(result.paragraphs.map((p) => p.id)).toEqual(['p0', 'p1']);
    expect(plain(result)).toEqual(['first ', 'second third']);
    expect(readRichText(b)).toEqual(result);
  });

  it('merges a paragraph restyle with concurrent typing in it', () => {
    const { a, b, sync } = peers(richText(paragraph('p1', 'centre me'), paragraph('p2', 'other')));
    setParagraphStyle(a, 'p1', { align: 'center' });
    b.insert(offsetOf(b, 'p1', 0), '>> ');
    sync();
    const first = readRichText(a).paragraphs[0];
    expect(first.style).toEqual({ align: 'center' });
    expect(plain({ paragraphs: [first] })).toEqual(['>> centre me']);
  });

  it('converges when one peer deletes a range another is formatting', () => {
    const { a, b, sync } = peers(richText(paragraph('p1', 'keep drop keep')));
    a.delete(offsetOf(a, 'p1', 5), 5);
    formatRange(b, offsetOf(b, 'p1', 0), 14, { u: true });
    sync();
    expect(plain(readRichText(a))).toEqual(['keep keep']);
    expect(readRichText(a).paragraphs[0].runs[0].style).toEqual({ underline: true });
    expect(readRichText(b)).toEqual(readRichText(a));
  });

  it('reconciles a long offline session on reconnect', () => {
    const { a, b, sync } = peers(richText(paragraph('p1', 'shared start')));
    for (let index = 0; index < 50; index += 1) a.insert(a.length - 1, ` a${index}`);
    for (let index = 0; index < 50; index += 1) b.insert(0, `b${index} `);
    formatRange(b, 0, 10, { i: true });
    sync();
    expect(readRichText(a)).toEqual(readRichText(b));
    const text = plain(readRichText(a))[0];
    expect(text).toContain('shared start');
    expect(text).toContain('a49');
    expect(text).toContain('b49');
  });

  it('sends one typed character as a small incremental update', () => {
    // Text-operation granularity: a keystroke is not a body replacement.
    const doc = new Y.Doc();
    const text = doc.getText('body');
    const body = buildFixtureDeck().slides['slide-2'].elements['s2-body'];
    if (body.type !== 'text') throw new Error('fixture changed');
    writeRichText(text, body.text.content);
    const before = Y.encodeStateVector(doc);
    text.insert(3, 'x');
    const update = Y.encodeStateAsUpdate(doc, before);
    expect(update.byteLength).toBeLessThan(64);
  });
});
