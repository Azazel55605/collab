import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';

import type { DeckRichText } from '../../types/deck';

import { readRichText, writeRichText } from './liveText';
import {
  caretStop,
  clearFormatting,
  commonValue,
  deleteRange,
  flatText,
  formatAt,
  formatRange,
  insertRichText,
  insertSoftBreak,
  insertText,
  isRichTextEmpty,
  linkInRange,
  locate,
  paragraphsInRange,
  patchParagraphs,
  setLink,
  shiftLevel,
  sliceRichText,
  splitParagraph,
  stripTextFormatting,
  stylesInRange,
  textLength,
  textLimitError,
} from './richText';

const body = (): DeckRichText => ({
  paragraphs: [
    {
      id: 'p1',
      style: { align: 'center' },
      runs: [
        { kind: 'text', text: 'Hello ' },
        { kind: 'text', text: 'bold', style: { bold: true } },
      ],
    },
    { id: 'p2', runs: [{ kind: 'text', text: 'World' }] },
  ],
});

const ids = () => {
  let count = 0;
  return () => `n${++count}`;
};

describe('rich-text addressing', () => {
  it('counts one position per paragraph separator and per soft break', () => {
    expect(textLength(body())).toBe(16);
    expect(flatText(body())).toBe('Hello bold\nWorld');
    expect(locate(body(), 10)).toEqual({ index: 0, local: 10 });
    expect(locate(body(), 11)).toEqual({ index: 1, local: 0 });
    expect(locate(body(), 99)).toEqual({ index: 1, local: 5 });
    const withBreak = insertSoftBreak(body(), { start: 5, end: 5 }, ids());
    expect(textLength(withBreak)).toBe(17);
  });

  it('matches the live Y.Text encoding length', () => {
    const doc = new Y.Doc();
    const ytext = doc.getText('t');
    const withBreak = insertSoftBreak(body(), { start: 5, end: 5 }, ids());
    writeRichText(ytext, withBreak);
    // The live form terminates every paragraph; ours separates them.
    expect(ytext.length).toBe(textLength(withBreak) + 1);
    expect(readRichText(ytext)).toEqual(withBreak);
  });
});

describe('typing and deleting', () => {
  it('types in the formatting of the character before the caret', () => {
    const typed = insertText(body(), { start: 10, end: 10 }, '!', ids());
    expect(typed.paragraphs[0].runs).toEqual([
      { kind: 'text', text: 'Hello ' },
      { kind: 'text', text: 'bold!', style: { bold: true } },
    ]);
    const atStart = insertText(body(), { start: 0, end: 0 }, '>', ids());
    expect(atStart.paragraphs[0].runs[0]).toEqual({ kind: 'text', text: '>Hello ' });
  });

  it('replaces a selection that spans paragraphs, keeping the last id and style', () => {
    const replaced = insertText(body(), { start: 8, end: 13 }, 'X', ids());
    expect(flatText(replaced)).toBe('Hello boXrld');
    expect(replaced.paragraphs).toHaveLength(1);
    expect(replaced.paragraphs[0].id).toBe('p2');
  });

  it('types into an empty body by creating its first paragraph', () => {
    const typed = insertText({ paragraphs: [] }, { start: 0, end: 0 }, 'Hi', ids());
    expect(typed).toEqual({ paragraphs: [{ id: 'n1', runs: [{ kind: 'text', text: 'Hi' }] }] });
  });

  it('remembers the deleted style on an emptied paragraph so typing continues in it', () => {
    const emptied = deleteRange(body(), { start: 0, end: 10 });
    expect(emptied.paragraphs[0].runs).toEqual([]);
    expect(emptied.paragraphs[0].endStyle).toBeUndefined();
    const boldOnly = deleteRange(body(), { start: 0, end: 6 });
    const cleared = deleteRange(boldOnly, { start: 0, end: 4 });
    expect(cleared.paragraphs[0].endStyle).toEqual({ bold: true });
    expect(formatAt(cleared, 0)).toEqual({ style: { bold: true } });
    const typed = insertText(cleared, { start: 0, end: 0 }, 'x', ids());
    expect(typed.paragraphs[0].runs).toEqual([{ kind: 'text', text: 'x', style: { bold: true } }]);
  });

  it('splits a paragraph, giving the first half the new id as the live encoding does', () => {
    const split = splitParagraph(body(), { start: 3, end: 3 }, ids());
    expect(split.paragraphs.map((paragraph) => paragraph.id)).toEqual(['n1', 'p1', 'p2']);
    expect(flatText(split)).toBe('Hel\nlo bold\nWorld');
    expect(split.paragraphs[0].style).toEqual({ align: 'center' });
    expect(split.paragraphs[1].style).toEqual({ align: 'center' });
  });

  it('splits at the end of formatted text and keeps typing in that format', () => {
    const split = splitParagraph(body(), { start: 10, end: 10 }, ids());
    expect(split.paragraphs[1].runs).toEqual([]);
    expect(split.paragraphs[1].endStyle).toEqual({ bold: true });
  });

  it('pastes multi-line text as paragraphs and strips control characters', () => {
    const pasted = insertText(body(), { start: 5, end: 5 }, 'a\r\nb\u0007\nc', ids());
    expect(flatText(pasted)).toBe('Helloa\nb\nc bold\nWorld');
    expect(pasted.paragraphs.map((paragraph) => paragraph.id)).toEqual(['n1', 'n2', 'p1', 'p2']);
  });

  it('round-trips a rich slice through paste', () => {
    const slice = sliceRichText(body(), { start: 6, end: 13 });
    expect(slice.paragraphs.map((paragraph) => paragraph.runs)).toEqual([
      [{ kind: 'text', text: 'bold', style: { bold: true } }],
      [{ kind: 'text', text: 'Wo' }],
    ]);
    const pasted = insertRichText(body(), { start: 16, end: 16 }, slice, ids());
    expect(flatText(pasted)).toBe('Hello bold\nWorldbold\nWo');
  });
});

describe('formatting', () => {
  it('formats part of a run and merges back when cleared', () => {
    const bolded = formatRange(body(), { start: 0, end: 5 }, { bold: true });
    expect(bolded.paragraphs[0].runs).toEqual([
      { kind: 'text', text: 'Hello', style: { bold: true } },
      { kind: 'text', text: ' ' },
      { kind: 'text', text: 'bold', style: { bold: true } },
    ]);
    const cleared = formatRange(bolded, { start: 0, end: 10 }, { bold: null });
    expect(cleared.paragraphs[0].runs).toEqual([{ kind: 'text', text: 'Hello bold' }]);
  });

  it('formats the paragraph mark of fully covered paragraphs only', () => {
    const sized = formatRange(body(), { start: 0, end: 16 }, { size: 2_400 });
    expect(sized.paragraphs[0].endStyle).toEqual({ size: 2_400 });
    const partial = formatRange(body(), { start: 2, end: 16 }, { size: 2_400 });
    expect(partial.paragraphs[0].endStyle).toBeUndefined();
    expect(partial.paragraphs[1].endStyle).toEqual({ size: 2_400 });
  });

  it('leaves text untouched for a collapsed range in a non-empty paragraph', () => {
    const input = body();
    expect(formatRange(input, { start: 3, end: 3 }, { italic: true })).toBe(input);
  });

  it('reports the common style, and none where it is mixed', () => {
    const styles = stylesInRange(body().paragraphs, { start: 0, end: 10 });
    expect(commonValue(styles, 'bold')).toBeUndefined();
    const bold = stylesInRange(body().paragraphs, { start: 7, end: 9 });
    expect(commonValue(bold, 'bold')).toBe(true);
    expect(stylesInRange(body().paragraphs, { start: 8, end: 8 })).toEqual([{ bold: true }]);
  });

  it('sets, reads, and removes links', () => {
    const link = { kind: 'url' as const, href: 'https://example.com' };
    const linked = setLink(body(), { start: 0, end: 5 }, link);
    expect(linkInRange(linked, { start: 1, end: 3 })).toEqual(link);
    expect(linkInRange(linked, { start: 2, end: 2 })).toEqual(link);
    expect(linkInRange(linked, { start: 0, end: 8 })).toBeNull();
    // Typing just after a link does not extend it.
    expect(formatAt(linked, 5).link).toBeUndefined();
    expect(formatAt(linked, 3).link).toEqual(link);
    expect(linkInRange(setLink(linked, { start: 0, end: 5 }, null), { start: 1, end: 3 })).toBe(
      null,
    );
  });

  it('changes paragraph style and list level for every touched paragraph', () => {
    expect(paragraphsInRange(body(), { start: 4, end: 12 })).toEqual([0, 1]);
    const aligned = patchParagraphs(body(), { start: 4, end: 12 }, { align: 'right' });
    expect(aligned.paragraphs.map((paragraph) => paragraph.style)).toEqual([
      { align: 'right' },
      { align: 'right' },
    ]);
    const deeper = shiftLevel(body(), { start: 12, end: 12 }, 1);
    expect(deeper.paragraphs[1].style).toEqual({ level: 1 });
    expect(shiftLevel(deeper, { start: 12, end: 12 }, -5).paragraphs[1].style).toBeUndefined();
    expect(shiftLevel(body(), { start: 0, end: 0 }, 99).paragraphs[0].style?.level).toBe(8);
    const unlisted = patchParagraphs(body(), { start: 0, end: 0 }, { list: null });
    expect(unlisted.paragraphs[0].style).toEqual({ align: 'center', list: null });
  });

  it('clears formatting to the inherited style', () => {
    const cleared = clearFormatting(body(), { start: 0, end: 16 });
    expect(cleared.paragraphs[0].runs).toEqual([{ kind: 'text', text: 'Hello bold' }]);
    const stripped = stripTextFormatting(shiftLevel(body(), { start: 0, end: 0 }, 2));
    expect(stripped.paragraphs[0]).toEqual({
      id: 'p1',
      style: { level: 2 },
      runs: [{ kind: 'text', text: 'Hello bold' }],
    });
  });
});

describe('limits and caret movement', () => {
  it('names the text limit a body breaks', () => {
    expect(textLimitError(body())).toBeNull();
    const huge = insertText(body(), { start: 0, end: 0 }, 'x'.repeat(40_000), ids());
    expect(textLimitError(huge)).toMatch(/characters/);
    expect(isRichTextEmpty({ paragraphs: [{ id: 'a', runs: [] }] })).toBe(true);
    expect(isRichTextEmpty(body())).toBe(false);
  });

  it('steps over whole graphemes and words', () => {
    const text = 'ab👍🏽c\nde fg';
    expect(caretStop(text, 2, 1)).toBe(6);
    expect(caretStop(text, 6, -1)).toBe(2);
    expect(caretStop(text, 7, -1)).toBe(6);
    expect(caretStop(text, text.length, -1, 'word')).toBe(11);
    expect(caretStop(text, 11, -1, 'word')).toBe(8);
  });
});
