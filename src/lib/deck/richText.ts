/**
 * Editing operations on a stored `.deck` rich-text body.
 *
 * The text editor never edits the DOM as its model: every keystroke, paste,
 * and toolbar command becomes one of these pure operations on `DeckRichText`,
 * and the editing surface is re-rendered from the result.
 *
 * Positions are **global offsets** in UTF-16 code units, the same addressing
 * `liveText.ts` uses for the `Y.Text` encoding: every paragraph's content is
 * followed by one separator position, and a soft line break counts as one
 * character. Paragraph `i` therefore starts at the sum of the lengths of the
 * paragraphs before it plus one per separator.
 *
 * The id rules mirror the live encoding, so Phase 6 can map each operation
 * onto `Y.Text` edits one-to-one:
 *
 * - Splitting a paragraph gives the part *before* the split a new id; the part
 *   after keeps the original id (the inserted `\n` carries the new id).
 * - Joining paragraphs keeps the id and style of the *last* one (the deleted
 *   `\n` characters were the earlier paragraphs' ends).
 *
 * Every result is canonical: adjacent runs with identical formatting merge and
 * empty text runs are dropped.
 */
import { DECK_LIMITS } from '../../types/deck';
import type {
  DeckLink,
  DeckParagraph,
  DeckParagraphStyle,
  DeckRichText,
  DeckRun,
  DeckRunStyle,
} from '../../types/deck';

export const SOFT_BREAK = '\u2028';

export interface TextRange {
  start: number;
  end: number;
}

/** Formatting carried by inserted text. */
export interface TextFormat {
  style?: DeckRunStyle;
  link?: DeckLink;
}

/** A run style change: a value sets a key, `null` clears it. */
export type RunStylePatch = { [K in keyof DeckRunStyle]?: DeckRunStyle[K] | null };

/* ------------------------------------------------------------------------- */
/* Measuring and locating                                                     */
/* ------------------------------------------------------------------------- */

export function runLength(run: DeckRun): number {
  return run.kind === 'break' ? 1 : run.text.length;
}

export function paragraphLength(paragraph: Pick<DeckParagraph, 'runs'>): number {
  let length = 0;
  for (const run of paragraph.runs) length += runLength(run);
  return length;
}

/** Offset just past the last character, i.e. the length of the whole body. */
export function textLength(body: DeckRichText): number {
  if (body.paragraphs.length === 0) return 0;
  let length = body.paragraphs.length - 1;
  for (const paragraph of body.paragraphs) length += paragraphLength(paragraph);
  return length;
}

/** Start offset of each paragraph. */
export function paragraphStarts(body: DeckRichText): number[] {
  const starts: number[] = [];
  let offset = 0;
  for (const paragraph of body.paragraphs) {
    starts.push(offset);
    offset += paragraphLength(paragraph) + 1;
  }
  return starts;
}

/** The paragraph containing `offset` and the offset inside it. Clamped. */
export function locate(body: DeckRichText, offset: number): { index: number; local: number } {
  let start = 0;
  for (let index = 0; index < body.paragraphs.length; index += 1) {
    const length = paragraphLength(body.paragraphs[index]);
    if (offset <= start + length || index === body.paragraphs.length - 1) {
      return { index, local: Math.max(0, Math.min(length, offset - start)) };
    }
    start += length + 1;
  }
  return { index: 0, local: 0 };
}

export function normalizeRange(range: TextRange, body?: DeckRichText): TextRange {
  let start = Math.min(range.start, range.end);
  let end = Math.max(range.start, range.end);
  if (body) {
    const length = textLength(body);
    start = Math.max(0, Math.min(length, start));
    end = Math.max(0, Math.min(length, end));
  }
  return { start, end };
}

/** The body as a string: paragraphs joined by `\n`, soft breaks as U+2028. */
export function flatText(body: DeckRichText): string {
  return body.paragraphs
    .map((paragraph) =>
      paragraph.runs.map((run) => (run.kind === 'break' ? SOFT_BREAK : run.text)).join(''),
    )
    .join('\n');
}

/** Plain text for the clipboard and reports: every break becomes a newline. */
export function richTextToPlain(body: DeckRichText): string {
  return flatText(body).replace(/\u2028/g, '\n');
}

export function isRichTextEmpty(body: DeckRichText | undefined): boolean {
  return !body || body.paragraphs.every((paragraph) => paragraphLength(paragraph) === 0);
}

/* ------------------------------------------------------------------------- */
/* Run helpers                                                                */
/* ------------------------------------------------------------------------- */

/** Canonical JSON, so equal styles compare equal whatever their key order. */
function canonical(value: unknown): string {
  return JSON.stringify(value ?? null, (_key, entry: unknown) =>
    entry && typeof entry === 'object' && !Array.isArray(entry)
      ? Object.fromEntries(
          Object.entries(entry as Record<string, unknown>)
            .filter(([, inner]) => inner !== undefined)
            .sort(([a], [b]) => a.localeCompare(b)),
        )
      : entry,
  );
}

function sameFormat(a: DeckRun, b: DeckRun): boolean {
  return (
    canonical(a.style ?? {}) === canonical(b.style ?? {}) &&
    canonical(a.kind === 'text' ? (a.link ?? null) : null) ===
      canonical(b.kind === 'text' ? (b.link ?? null) : null)
  );
}

function cleanStyle(style: DeckRunStyle | undefined): DeckRunStyle | undefined {
  if (!style) return undefined;
  const entries = Object.entries(style).filter(([, value]) => value !== undefined);
  return entries.length > 0 ? (Object.fromEntries(entries) as DeckRunStyle) : undefined;
}

function makeTextRun(text: string, format: TextFormat | undefined): DeckRun {
  const run: DeckRun = { kind: 'text', text };
  const style = cleanStyle(format?.style);
  if (style) run.style = style;
  if (format?.link) run.link = format.link;
  return run;
}

function makeBreakRun(format: TextFormat | undefined): DeckRun {
  const style = cleanStyle(format?.style);
  return style ? { kind: 'break', style } : { kind: 'break' };
}

/** Drops empty text runs and merges neighbours with identical formatting. */
export function normalizeRuns(runs: DeckRun[]): DeckRun[] {
  const out: DeckRun[] = [];
  for (const run of runs) {
    if (run.kind === 'text' && run.text === '') continue;
    const previous = out[out.length - 1];
    if (previous?.kind === 'text' && run.kind === 'text' && sameFormat(previous, run)) {
      out[out.length - 1] = { ...previous, text: previous.text + run.text };
    } else {
      out.push(run);
    }
  }
  return out;
}

/** Splits a run list at a local offset; text runs are cut, breaks are atomic. */
function splitRuns(runs: DeckRun[], offset: number): [DeckRun[], DeckRun[]] {
  const left: DeckRun[] = [];
  const right: DeckRun[] = [];
  let position = 0;
  for (const run of runs) {
    const length = runLength(run);
    if (position + length <= offset) left.push(run);
    else if (position >= offset) right.push(run);
    else if (run.kind === 'text') {
      const cut = offset - position;
      left.push({ ...run, text: run.text.slice(0, cut) });
      right.push({ ...run, text: run.text.slice(cut) });
    }
    position += length;
  }
  return [left, right];
}

function withRuns(paragraph: DeckParagraph, runs: DeckRun[]): DeckParagraph {
  return { ...paragraph, runs: normalizeRuns(runs) };
}

/** A body that always has at least one paragraph to edit in. */
function editable(body: DeckRichText | undefined, nextId: () => string): DeckRichText {
  if (body && body.paragraphs.length > 0) return body;
  return { paragraphs: [{ id: nextId(), runs: [] }] };
}

/* ------------------------------------------------------------------------- */
/* Queries                                                                    */
/* ------------------------------------------------------------------------- */

/**
 * The formatting new text typed at `offset` takes: the character before it,
 * the character after it at a paragraph start, or the paragraph mark's style
 * in an empty paragraph. A link continues only strictly inside it, so typing
 * after a link does not extend it.
 */
export function formatAt(body: DeckRichText, offset: number): TextFormat {
  if (body.paragraphs.length === 0) return {};
  const { index, local } = locate(body, offset);
  const paragraph = body.paragraphs[index];
  if (paragraph.runs.length === 0) return paragraph.endStyle ? { style: paragraph.endStyle } : {};
  const [left, right] = splitRuns(paragraph.runs, local);
  const before = left[left.length - 1];
  const after = right[0];
  const source = before ?? after;
  const format: TextFormat = {};
  if (source?.style) format.style = source.style;
  if (
    before?.kind === 'text' &&
    after?.kind === 'text' &&
    before.link &&
    canonical(before.link) === canonical(after.link ?? null)
  ) {
    format.link = before.link;
  }
  return format;
}

/** Indices of the paragraphs a range touches (a collapsed range touches one). */
export function paragraphsInRange(body: DeckRichText, range: TextRange): number[] {
  const { start, end } = normalizeRange(range);
  const starts = paragraphStarts(body);
  const out: number[] = [];
  body.paragraphs.forEach((paragraph, index) => {
    const from = starts[index];
    const to = from + paragraphLength(paragraph);
    if (to >= start && from <= end) out.push(index);
  });
  return out;
}

interface RunLike<S> {
  kind: 'text' | 'break';
  text?: string;
  style?: S;
}

/**
 * The styles of every text run a range covers, for toolbar state. Works on
 * stored runs and on resolved runs alike, since the resolver keeps one
 * resolved run per stored run. A collapsed range yields the style typing there
 * would use; an empty paragraph yields its end style.
 */
export function stylesInRange<S>(
  paragraphs: Array<{ runs: Array<RunLike<S>>; endStyle?: S }>,
  range: TextRange,
): S[] {
  const { start, end } = normalizeRange(range);
  const styles: S[] = [];
  let paragraphStart = 0;
  for (const paragraph of paragraphs) {
    let length = 0;
    for (const run of paragraph.runs) length += run.kind === 'break' ? 1 : (run.text?.length ?? 0);
    const paragraphEnd = paragraphStart + length;
    if (paragraphEnd >= start && paragraphStart <= end) {
      let position = paragraphStart;
      let before: S | undefined;
      let after: S | undefined;
      for (const run of paragraph.runs) {
        const runEnd = position + (run.kind === 'break' ? 1 : (run.text?.length ?? 0));
        if (run.kind === 'text') {
          const style = run.style ?? ({} as S);
          if (start === end) {
            if (runEnd <= start || (position < start && runEnd >= start)) before = style;
            if (position >= start && after === undefined) after = style;
          } else if (runEnd > start && position < end) {
            styles.push(style);
          }
        }
        position = runEnd;
      }
      if (start === end) {
        const style = before ?? after ?? paragraph.endStyle;
        if (style !== undefined) styles.push(style);
      } else if (length === 0 && paragraph.endStyle !== undefined) {
        styles.push(paragraph.endStyle);
      }
    }
    paragraphStart = paragraphEnd + 1;
  }
  return styles;
}

/** The value every style agrees on for `key`, or `undefined` when mixed. */
export function commonValue<S, K extends keyof S>(styles: S[], key: K): S[K] | undefined {
  if (styles.length === 0) return undefined;
  const first = canonical(styles[0][key]);
  return styles.every((style) => canonical(style[key]) === first) ? styles[0][key] : undefined;
}

/** The link on the text a range covers, when it is one link throughout. */
export function linkInRange(body: DeckRichText, range: TextRange): DeckLink | null {
  const { start, end } = normalizeRange(range, body);
  const from = start === end ? Math.max(0, start - 1) : start;
  const to = start === end ? start + 1 : end;
  let found: DeckLink | null = null;
  let position = 0;
  for (const paragraph of body.paragraphs) {
    for (const run of paragraph.runs) {
      const runEnd = position + runLength(run);
      if (runEnd > from && position < to && run.kind === 'text' && run.text !== '') {
        if (!run.link) return null;
        if (found && canonical(found) !== canonical(run.link)) return null;
        found = run.link;
      }
      position = runEnd;
    }
    position += 1;
  }
  return found;
}

/** The whole run of linked text around `offset`, or null when it is not in a link. */
export function linkExtent(body: DeckRichText, offset: number): TextRange | null {
  const { index, local } = locate(body, offset);
  const paragraph = body.paragraphs[index];
  if (!paragraph) return null;
  const start = paragraphStarts(body)[index];
  let position = 0;
  let found: { from: number; to: number; link: DeckLink } | null = null;
  const spans: Array<{ from: number; to: number; link: DeckLink | null }> = [];
  for (const run of paragraph.runs) {
    const length = runLength(run);
    spans.push({
      from: position,
      to: position + length,
      link: run.kind === 'text' && run.link ? run.link : null,
    });
    position += length;
  }
  for (let at = 0; at < spans.length; at += 1) {
    const span = spans[at];
    if (!span.link || local < span.from || local > span.to) continue;
    let from = span.from;
    let to = span.to;
    const key = canonical(span.link);
    for (let back = at - 1; back >= 0 && canonical(spans[back].link) === key; back -= 1) {
      from = spans[back].from;
    }
    for (let next = at + 1; next < spans.length && canonical(spans[next].link) === key; next += 1) {
      to = spans[next].to;
    }
    found = { from, to, link: span.link };
    break;
  }
  return found ? { start: start + found.from, end: start + found.to } : null;
}

/* ------------------------------------------------------------------------- */
/* Structural edits                                                           */
/* ------------------------------------------------------------------------- */

/**
 * Deletes a range. Joined paragraphs keep the last paragraph's id and style,
 * as the live encoding does; a paragraph emptied by the delete remembers the
 * first deleted run's style as its end style, so typing continues in it.
 */
export function deleteRange(body: DeckRichText, range: TextRange): DeckRichText {
  const { start, end } = normalizeRange(range, body);
  if (start === end || body.paragraphs.length === 0) return body;
  const from = locate(body, start);
  const to = locate(body, end);
  const first = body.paragraphs[from.index];
  const last = body.paragraphs[to.index];
  const [keptLeft, rest] = splitRuns(first.runs, from.local);
  const [, keptRight] = splitRuns(last.runs, to.local);
  const deletedStyle = (
    from.index === to.index ? splitRuns(rest, to.local - from.local)[0] : rest
  ).concat(from.index === to.index ? [] : splitRuns(last.runs, to.local)[0])[0]?.style;

  let merged = withRuns({ ...last }, [...keptLeft, ...keptRight]);
  if (merged.runs.length === 0) {
    const endStyle = deletedStyle ?? merged.endStyle ?? first.endStyle;
    merged = { ...merged };
    if (endStyle) merged.endStyle = endStyle;
  }
  const paragraphs = [
    ...body.paragraphs.slice(0, from.index),
    merged,
    ...body.paragraphs.slice(to.index + 1),
  ];
  return { paragraphs };
}

/** Removes characters XML and the text model cannot carry. Keeps `\n`, `\t`, U+2028. */
export function sanitizeText(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/\u2029/g, '\n')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\ufffe\uffff]/g, '');
}

/**
 * Replaces a range with a rich fragment. The fragment's first paragraph joins
 * the paragraph at the insertion point and its last paragraph joins what
 * follows; paragraphs in between are inserted whole with fresh ids.
 */
export function insertRichText(
  source: DeckRichText | undefined,
  range: TextRange,
  fragment: DeckRichText,
  nextId: () => string,
): DeckRichText {
  if (fragment.paragraphs.length === 0) return source ?? { paragraphs: [] };
  const body = deleteRange(editable(source, nextId), range);
  const { start } = normalizeRange(range, editable(source, nextId));
  const { index, local } = locate(body, start);
  const target = body.paragraphs[index];
  const [left, right] = splitRuns(target.runs, local);
  const parts = fragment.paragraphs;

  if (parts.length === 1) {
    const paragraphs = [...body.paragraphs];
    paragraphs[index] = withRuns(target, [...left, ...parts[0].runs, ...right]);
    return { paragraphs };
  }

  const inserted: DeckParagraph[] = [];
  const firstPart: DeckParagraph = { id: nextId(), runs: [] };
  if (target.style) firstPart.style = target.style;
  if (target.endStyle) firstPart.endStyle = target.endStyle;
  inserted.push(withRuns(firstPart, [...left, ...parts[0].runs]));
  for (const middle of parts.slice(1, -1)) {
    const paragraph: DeckParagraph = { id: nextId(), runs: [] };
    const style = middle.style ?? target.style;
    if (style) paragraph.style = style;
    const endStyle = middle.endStyle ?? target.endStyle;
    if (endStyle) paragraph.endStyle = endStyle;
    inserted.push(withRuns(paragraph, middle.runs));
  }
  inserted.push(withRuns(target, [...parts[parts.length - 1].runs, ...right]));
  return {
    paragraphs: [
      ...body.paragraphs.slice(0, index),
      ...inserted,
      ...body.paragraphs.slice(index + 1),
    ],
  };
}

/** Plain text as a fragment: `\n` separates paragraphs, U+2028 is a soft break. */
export function textFragment(text: string, format: TextFormat = {}): DeckRichText {
  return {
    paragraphs: sanitizeText(text)
      .split('\n')
      .map((line, index) => {
        const runs: DeckRun[] = [];
        line.split(SOFT_BREAK).forEach((piece, pieceIndex) => {
          if (pieceIndex > 0) runs.push(makeBreakRun(format));
          if (piece !== '') runs.push(makeTextRun(piece, format));
        });
        return { id: `fragment-${index}`, runs };
      }),
  };
}

/**
 * Types text over a range. Without an explicit format the text takes the
 * formatting at the insertion point (see {@link formatAt}).
 */
export function insertText(
  source: DeckRichText | undefined,
  range: TextRange,
  text: string,
  nextId: () => string,
  format?: TextFormat,
): DeckRichText {
  const body = editable(source, nextId);
  const { start } = normalizeRange(range, body);
  const applied = format ?? formatAt(deleteRange(body, range), start);
  return insertRichText(body, range, textFragment(text, applied), nextId);
}

/** Enter: splits the paragraph at `offset` (after deleting a selection). */
export function splitParagraph(
  source: DeckRichText | undefined,
  range: TextRange,
  nextId: () => string,
): DeckRichText {
  const body = editable(source, nextId);
  const { start } = normalizeRange(range, body);
  const collapsed = deleteRange(body, range);
  const { index } = locate(collapsed, start);
  const format = formatAt(collapsed, start);
  const result = insertRichText(
    collapsed,
    { start, end: start },
    {
      paragraphs: [
        { id: 'a', runs: [] },
        { id: 'b', runs: [] },
      ],
    },
    nextId,
  );
  // An empty half keeps typing in the style of the text it was split from.
  if (format.style) {
    const halves = [index, index + 1].filter((at) => result.paragraphs[at].runs.length === 0);
    for (const at of halves) {
      if (!result.paragraphs[at].endStyle) {
        result.paragraphs[at] = { ...result.paragraphs[at], endStyle: format.style };
      }
    }
  }
  return result;
}

/** Shift+Enter: a soft line break inside the paragraph. */
export function insertSoftBreak(
  source: DeckRichText | undefined,
  range: TextRange,
  nextId: () => string,
): DeckRichText {
  return insertText(source, range, SOFT_BREAK, nextId);
}

/** A copy of the text inside a range, for the clipboard. */
export function sliceRichText(body: DeckRichText, range: TextRange): DeckRichText {
  const { start, end } = normalizeRange(range, body);
  if (start === end || body.paragraphs.length === 0) return { paragraphs: [] };
  const from = locate(body, start);
  const to = locate(body, end);
  const paragraphs: DeckParagraph[] = [];
  for (let index = from.index; index <= to.index; index += 1) {
    const paragraph = body.paragraphs[index];
    let runs = paragraph.runs;
    if (index === to.index) runs = splitRuns(runs, to.local)[0];
    if (index === from.index) runs = splitRuns(runs, from.local)[1];
    paragraphs.push({ ...paragraph, runs: normalizeRuns(runs) });
  }
  return { paragraphs };
}

/* ------------------------------------------------------------------------- */
/* Formatting                                                                 */
/* ------------------------------------------------------------------------- */

export function applyStylePatch(
  style: DeckRunStyle | undefined,
  patch: RunStylePatch,
): DeckRunStyle | undefined {
  const next: Record<string, unknown> = { ...(style ?? {}) };
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete next[key];
    else if (value !== undefined) next[key] = value;
  }
  return cleanStyle(next as DeckRunStyle);
}

function mapRange(
  body: DeckRichText,
  range: TextRange,
  mapRun: (run: DeckRun) => DeckRun,
  mapEndStyle: (style: DeckRunStyle | undefined) => DeckRunStyle | undefined,
): DeckRichText {
  const { start, end } = normalizeRange(range, body);
  const starts = paragraphStarts(body);
  let changed = false;
  const paragraphs = body.paragraphs.map((paragraph, index) => {
    const paragraphStart = starts[index];
    const length = paragraphLength(paragraph);
    const paragraphEnd = paragraphStart + length;
    if (paragraphEnd < start || paragraphStart > end) return paragraph;
    if (length > 0 && (paragraphEnd === start || paragraphStart === end) && start !== end) {
      return paragraph;
    }
    const localStart = Math.max(0, start - paragraphStart);
    const localEnd = Math.min(length, end - paragraphStart);
    const [before, rest] = splitRuns(paragraph.runs, localStart);
    const [middle, after] = splitRuns(rest, localEnd - localStart);
    const runs = normalizeRuns([...before, ...middle.map(mapRun), ...after]);
    let next: DeckParagraph = { ...paragraph, runs };
    // The paragraph mark follows when the whole paragraph is covered.
    if (start <= paragraphStart && end >= paragraphEnd) {
      const endStyle = mapEndStyle(paragraph.endStyle);
      next = { ...next };
      if (endStyle) next.endStyle = endStyle;
      else delete next.endStyle;
    }
    if (canonical(next) !== canonical(paragraph)) changed = true;
    return next;
  });
  return changed ? { paragraphs } : body;
}

/** Applies run formatting to a range. A collapsed range changes nothing but an empty paragraph's mark. */
export function formatRange(
  body: DeckRichText,
  range: TextRange,
  patch: RunStylePatch,
): DeckRichText {
  return mapRange(
    body,
    range,
    (run) => {
      const style = applyStylePatch(run.style, patch);
      const next = { ...run } as DeckRun;
      if (style) next.style = style;
      else delete next.style;
      return next;
    },
    (style) => applyStylePatch(style, patch),
  );
}

/** Sets or removes the link on a range. */
export function setLink(body: DeckRichText, range: TextRange, link: DeckLink | null): DeckRichText {
  const { start, end } = normalizeRange(range, body);
  if (start === end) return body;
  return mapRange(
    body,
    range,
    (run) => {
      if (run.kind !== 'text') return run;
      const next: DeckRun = { ...run };
      if (link) next.link = link;
      else delete next.link;
      return next;
    },
    (style) => style,
  );
}

/** Rewrites the paragraph style of every paragraph a range touches. */
export function updateParagraphs(
  body: DeckRichText,
  range: TextRange,
  update: (style: DeckParagraphStyle | undefined) => DeckParagraphStyle | undefined,
): DeckRichText {
  const touched = new Set(paragraphsInRange(body, range));
  let changed = false;
  const paragraphs = body.paragraphs.map((paragraph, index) => {
    if (!touched.has(index)) return paragraph;
    const style = update(paragraph.style);
    const cleaned =
      style &&
      (Object.fromEntries(
        Object.entries(style).filter(([, value]) => value !== undefined),
      ) as DeckParagraphStyle);
    const next: DeckParagraph = { ...paragraph };
    if (cleaned && Object.keys(cleaned).length > 0) next.style = cleaned;
    else delete next.style;
    if (canonical(next.style ?? null) !== canonical(paragraph.style ?? null)) changed = true;
    return next;
  });
  return changed ? { paragraphs } : body;
}

/** Applies a patch to every paragraph style in the range; `null` clears a key. */
export function patchParagraphs(
  body: DeckRichText,
  range: TextRange,
  patch: { [K in keyof DeckParagraphStyle]?: DeckParagraphStyle[K] | null },
): DeckRichText {
  return updateParagraphs(body, range, (style) => {
    const next: Record<string, unknown> = { ...(style ?? {}) };
    for (const [key, value] of Object.entries(patch)) {
      if (value === null && key !== 'list') delete next[key];
      else if (value !== undefined) next[key] = value;
    }
    return next as DeckParagraphStyle;
  });
}

/** Changes list/outline level by `delta`, bounded to the nine OOXML levels. */
export function shiftLevel(body: DeckRichText, range: TextRange, delta: number): DeckRichText {
  return updateParagraphs(body, range, (style) => {
    const level = Math.max(
      0,
      Math.min(DECK_LIMITS.listLevels - 1, (style?.level ?? 0) + Math.trunc(delta)),
    );
    const next: DeckParagraphStyle = { ...(style ?? {}) };
    if (level > 0) next.level = level;
    else delete next.level;
    return next;
  });
}

/** Strips run formatting (not links) from a range, returning text to its inherited style. */
export function clearFormatting(body: DeckRichText, range: TextRange): DeckRichText {
  return mapRange(
    body,
    range,
    (run) => {
      const next = { ...run } as DeckRun;
      delete next.style;
      return next;
    },
    () => undefined,
  );
}

/** Removes every run and paragraph style override, keeping text, links, and levels. */
export function stripTextFormatting(body: DeckRichText): DeckRichText {
  return {
    paragraphs: body.paragraphs.map((paragraph) => {
      const next: DeckParagraph = {
        id: paragraph.id,
        runs: normalizeRuns(
          paragraph.runs.map((run) => {
            const copy = { ...run } as DeckRun;
            delete copy.style;
            return copy;
          }),
        ),
      };
      if (paragraph.style?.level) next.style = { level: paragraph.style.level };
      return next;
    }),
  };
}

/* ------------------------------------------------------------------------- */
/* Limits and boundaries                                                      */
/* ------------------------------------------------------------------------- */

/** A message naming the first text limit a body exceeds, or null. */
export function textLimitError(body: DeckRichText): string | null {
  if (body.paragraphs.length > DECK_LIMITS.paragraphsPerBody) {
    return `A text box can hold at most ${DECK_LIMITS.paragraphsPerBody} paragraphs.`;
  }
  let characters = 0;
  for (const paragraph of body.paragraphs) {
    if (paragraph.runs.length > DECK_LIMITS.runsPerParagraph) {
      return `A paragraph can hold at most ${DECK_LIMITS.runsPerParagraph} differently formatted runs.`;
    }
    for (const run of paragraph.runs) if (run.kind === 'text') characters += run.text.length;
  }
  if (characters > DECK_LIMITS.textPerBody) {
    return `A text box can hold at most ${DECK_LIMITS.textPerBody.toLocaleString('en-US')} characters.`;
  }
  return null;
}

type Segmenter = { segment(text: string): Iterable<{ index: number; isWordLike?: boolean }> };

function segmenter(granularity: 'grapheme' | 'word'): Segmenter | null {
  const Ctor = (
    Intl as unknown as { Segmenter?: new (locale?: string, options?: object) => Segmenter }
  ).Segmenter;
  return Ctor ? new Ctor(undefined, { granularity }) : null;
}

/**
 * The next caret stop from `offset` in `direction`: one grapheme (so an emoji
 * or a combining sequence is deleted whole), or one word for Ctrl+Backspace.
 */
export function caretStop(
  text: string,
  offset: number,
  direction: 1 | -1,
  unit: 'grapheme' | 'word' = 'grapheme',
): number {
  const stops = new Set<number>([0, text.length]);
  const words = unit === 'word';
  const seg = segmenter(words ? 'word' : 'grapheme');
  if (seg) {
    for (const part of seg.segment(text)) if (!words || part.isWordLike) stops.add(part.index);
  } else {
    let index = 0;
    for (const char of text) {
      if (!words || (/\s/.test(text[index - 1] ?? ' ') && !/\s/.test(char))) stops.add(index);
      index += char.length;
    }
  }
  // Paragraph separators are always stops on both sides.
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === '\n' || text[index] === SOFT_BREAK) {
      stops.add(index);
      stops.add(index + 1);
    }
  }
  const sorted = [...stops].sort((a, b) => a - b);
  if (direction > 0) return sorted.find((stop) => stop > offset) ?? text.length;
  return [...sorted].reverse().find((stop) => stop < offset) ?? 0;
}
