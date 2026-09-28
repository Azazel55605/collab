/**
 * The live CRDT encoding of one `.deck` rich-text body — the Phase 0 proof that
 * two people can edit the same text box at once.
 *
 * A body is one `Y.Text`. Paragraph content is ordinary characters carrying
 * run formatting as Yjs attributes, one attribute per style key; every
 * paragraph ends in `\n`, and that newline carries the paragraph's stable id
 * and paragraph style. A soft line break is U+2028.
 *
 * Why one `Y.Text` per body rather than one per paragraph: splitting a
 * paragraph is then just inserting a `\n`, so text a peer is concurrently
 * typing after the split point lands in the new paragraph instead of in a
 * deleted range. Per-key attributes mean one peer's bold and another's italic
 * on the same word both survive.
 *
 * This module converts between that live form and the plain `DeckRichText`
 * stored in `.deck` JSON. The live form never reaches disk: server
 * materialization writes the plain form (Phase 6).
 */
import * as Y from 'yjs';

import type {
  DeckColor,
  DeckLink,
  DeckParagraph,
  DeckParagraphStyle,
  DeckRichText,
  DeckRun,
  DeckRunStyle,
} from '../../types/deck';

export const SOFT_BREAK = '\u2028';
const PARAGRAPH_END = '\n';

type Attributes = Record<string, unknown>;

/* ------------------------------------------------------------------------- */
/* Run style <-> attributes                                                   */
/* ------------------------------------------------------------------------- */

/** Every run attribute key. A `null` value in a format call clears one. */
type RunKey = 'b' | 'i' | 'u' | 's' | 'sz' | 'font' | 'color' | 'base' | 'lang' | 'link';

export function runAttributes(style: DeckRunStyle | undefined, link?: DeckLink): Attributes {
  const attrs: Attributes = {};
  if (style?.bold) attrs.b = true;
  if (style?.italic) attrs.i = true;
  if (style?.underline) attrs.u = true;
  if (style?.strike) attrs.s = true;
  if (style?.size !== undefined) attrs.sz = style.size;
  if (style?.font !== undefined)
    attrs.font = typeof style.font === 'string' ? style.font : `theme:${style.font.theme}`;
  // Structured values travel as canonical JSON, so equal values compare equal.
  if (style?.color) attrs.color = canonical(style.color);
  if (style?.baseline) attrs.base = style.baseline;
  if (style?.lang) attrs.lang = style.lang;
  if (link) attrs.link = canonical(link);
  return attrs;
}

function runFromAttributes(text: string, attrs: Attributes | undefined): DeckRun {
  const style: DeckRunStyle = {};
  if (attrs?.b) style.bold = true;
  if (attrs?.i) style.italic = true;
  if (attrs?.u) style.underline = true;
  if (attrs?.s) style.strike = true;
  if (typeof attrs?.sz === 'number') style.size = attrs.sz;
  if (typeof attrs?.font === 'string') {
    style.font = attrs.font.startsWith('theme:')
      ? { theme: attrs.font.slice(6) === 'heading' ? 'heading' : 'body' }
      : attrs.font;
  }
  if (typeof attrs?.color === 'string') style.color = JSON.parse(attrs.color) as DeckColor;
  if (attrs?.base === 'superscript' || attrs?.base === 'subscript') style.baseline = attrs.base;
  if (typeof attrs?.lang === 'string') style.lang = attrs.lang;
  const run: DeckRun = { kind: 'text', text };
  if (Object.keys(style).length > 0) run.style = style;
  if (typeof attrs?.link === 'string') run.link = JSON.parse(attrs.link) as DeckLink;
  return run;
}

function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, entry: unknown) =>
    entry && typeof entry === 'object' && !Array.isArray(entry)
      ? Object.fromEntries(
          Object.entries(entry as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)),
        )
      : entry,
  );
}

function paragraphAttributes(
  paragraph: Pick<DeckParagraph, 'id' | 'style' | 'endStyle'>,
): Attributes {
  const attrs: Attributes = { pid: paragraph.id };
  if (paragraph.style && Object.keys(paragraph.style).length > 0)
    attrs.pstyle = canonical(paragraph.style);
  if (paragraph.endStyle && Object.keys(paragraph.endStyle).length > 0)
    attrs.pend = canonical(paragraph.endStyle);
  return attrs;
}

/* ------------------------------------------------------------------------- */
/* Encode / decode                                                            */
/* ------------------------------------------------------------------------- */

/** Replaces a `Y.Text`'s content with a rich-text body, in one transaction. */
export function writeRichText(ytext: Y.Text, text: DeckRichText): void {
  const apply = () => {
    ytext.delete(0, ytext.length);
    let offset = 0;
    for (const paragraph of text.paragraphs) {
      for (const run of paragraph.runs) {
        const content = run.kind === 'break' ? SOFT_BREAK : run.text.replace(/[\n\u2028]/g, ' ');
        if (content === '') continue;
        ytext.insert(
          offset,
          content,
          runAttributes(run.style, run.kind === 'text' ? run.link : undefined),
        );
        offset += content.length;
      }
      ytext.insert(offset, PARAGRAPH_END, paragraphAttributes(paragraph));
      offset += 1;
    }
  };
  if (ytext.doc) ytext.doc.transact(apply);
  else apply();
}

/**
 * Reads a `Y.Text` back into a rich-text body. Adjacent runs with identical
 * formatting merge, so the result is canonical whatever edit history produced
 * it. Text after the last paragraph end (possible mid-merge) becomes a final
 * paragraph with a derived id.
 */
export function readRichText(ytext: Y.Text): DeckRichText {
  const paragraphs: DeckParagraph[] = [];
  let runs: DeckRun[] = [];
  const seen = new Set<string>();

  const pushRun = (text: string, attrs: Attributes | undefined) => {
    const pieces = text.split(SOFT_BREAK);
    pieces.forEach((piece, index) => {
      if (index > 0) runs.push(withStyle({ kind: 'break' }, attrs));
      if (piece === '') return;
      const run = runFromAttributes(piece, attrs);
      const previous = runs[runs.length - 1];
      if (
        previous?.kind === 'text' &&
        run.kind === 'text' &&
        canonical([previous.style, previous.link]) === canonical([run.style, run.link])
      ) {
        previous.text += run.text;
      } else {
        runs.push(run);
      }
    });
  };

  const endParagraph = (attrs: Attributes | undefined) => {
    let id = typeof attrs?.pid === 'string' ? attrs.pid : `p-${paragraphs.length}`;
    // Two paragraph ends can carry one id after concurrent copies; keep ids unique.
    while (seen.has(id)) id = `${id}-${paragraphs.length}`;
    seen.add(id);
    const paragraph: DeckParagraph = { id, runs };
    if (typeof attrs?.pstyle === 'string')
      paragraph.style = JSON.parse(attrs.pstyle) as DeckParagraphStyle;
    if (typeof attrs?.pend === 'string')
      paragraph.endStyle = JSON.parse(attrs.pend) as DeckRunStyle;
    paragraphs.push(paragraph);
    runs = [];
  };

  for (const op of ytext.toDelta() as Array<{ insert: unknown; attributes?: Attributes }>) {
    if (typeof op.insert !== 'string') continue;
    const parts = op.insert.split(PARAGRAPH_END);
    parts.forEach((part, index) => {
      if (part !== '') pushRun(part, stripParagraphKeys(op.attributes));
      if (index < parts.length - 1) endParagraph(op.attributes);
    });
  }
  if (runs.length > 0) endParagraph(undefined);
  return { paragraphs };
}

function withStyle(
  run: Extract<DeckRun, { kind: 'break' }>,
  attrs: Attributes | undefined,
): DeckRun {
  const style = runFromAttributes('', attrs);
  return style.kind === 'text' && style.style ? { ...run, style: style.style } : run;
}

function stripParagraphKeys(attrs: Attributes | undefined): Attributes | undefined {
  if (!attrs) return undefined;
  const { pid: _pid, pstyle: _pstyle, pend: _pend, ...rest } = attrs;
  return rest;
}

/* ------------------------------------------------------------------------- */
/* Editing operations                                                         */
/* ------------------------------------------------------------------------- */

/** Offset of character `index` inside paragraph `paragraphId`, or -1. */
export function offsetOf(ytext: Y.Text, paragraphId: string, index: number): number {
  let offset = 0;
  let paragraphStart = 0;
  for (const op of ytext.toDelta() as Array<{ insert: unknown; attributes?: Attributes }>) {
    if (typeof op.insert !== 'string') continue;
    for (const char of op.insert) {
      if (char === PARAGRAPH_END) {
        if (op.attributes?.pid === paragraphId) return Math.min(paragraphStart + index, offset);
        paragraphStart = offset + 1;
      }
      offset += char.length;
    }
  }
  return -1;
}

/** Applies run formatting to a range. `null` values clear a key. */
export function formatRange(
  ytext: Y.Text,
  from: number,
  length: number,
  style: Partial<Record<RunKey, unknown>>,
): void {
  ytext.format(from, length, style);
}

/** Splits the paragraph containing `offset` (Enter), giving the first half a new id. */
export function splitParagraph(
  ytext: Y.Text,
  offset: number,
  newId: string,
  style?: DeckParagraphStyle,
): void {
  ytext.insert(
    offset,
    PARAGRAPH_END,
    paragraphAttributes({ id: newId, ...(style ? { style } : {}) }),
  );
}

/** Sets a paragraph's style by formatting its terminating newline. */
export function setParagraphStyle(
  ytext: Y.Text,
  paragraphId: string,
  style: DeckParagraphStyle,
): void {
  let offset = 0;
  for (const op of ytext.toDelta() as Array<{ insert: unknown; attributes?: Attributes }>) {
    if (typeof op.insert !== 'string') continue;
    for (const char of op.insert) {
      if (char === PARAGRAPH_END && op.attributes?.pid === paragraphId) {
        ytext.format(offset, 1, { pstyle: canonical(style) });
        return;
      }
      offset += char.length;
    }
  }
}
