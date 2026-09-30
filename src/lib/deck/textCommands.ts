/**
 * Toolbar and shortcut commands on a text body, shared by the in-place editor
 * (acting on its selection) and the object selection (acting on whole
 * bodies, as PowerPoint formats a selected box's text).
 *
 * Toggles read the *resolved* style, so un-bolding an inherited bold title
 * writes an explicit `bold: false` rather than clearing an override that was
 * never there.
 */
import { DECK_LIMITS, DECK_UNITS_PER_POINT } from '../../types/deck';
import type { DeckLink, DeckParagraphStyle, DeckRichText, DeckTextAlign } from '../../types/deck';

import type { ResolvedParagraph, ResolvedRunStyle, ResolvedTextBody } from './resolve';
import {
  applyStylePatch,
  clearFormatting,
  commonValue,
  formatAt,
  formatRange,
  normalizeRange,
  paragraphLength,
  paragraphsInRange,
  paragraphStarts,
  setLink,
  shiftLevel,
  stylesInRange,
  updateParagraphs,
} from './richText';
import type { RunStylePatch, TextFormat, TextRange } from './richText';

export type TextCommand =
  | { kind: 'toggle'; key: 'bold' | 'italic' | 'underline' | 'strike' }
  | { kind: 'baseline'; value: 'superscript' | 'subscript' }
  | { kind: 'style'; patch: RunStylePatch }
  | { kind: 'sizeStep'; direction: 1 | -1 }
  | { kind: 'align'; value: DeckTextAlign }
  | { kind: 'list'; list: 'bullet' | 'number' }
  | { kind: 'level'; delta: 1 | -1 }
  | {
      kind: 'paragraph';
      patch: Partial<Pick<DeckParagraphStyle, 'lineSpacing' | 'spaceBefore' | 'spaceAfter'>>;
    }
  | { kind: 'link'; link: DeckLink | null }
  | { kind: 'clear' };

/** The font-size ladder the grow/shrink commands step along, in points. */
export const FONT_SIZE_STEPS = [
  8, 9, 10, 10.5, 11, 12, 14, 16, 18, 20, 24, 28, 32, 36, 40, 44, 48, 54, 60, 66, 72, 80, 88, 96,
  120, 144, 200,
];

export function steppedSize(size: number, direction: 1 | -1): number {
  const points = size / DECK_UNITS_PER_POINT;
  const next =
    direction > 0
      ? (FONT_SIZE_STEPS.find((step) => step > points + 0.01) ?? Math.min(points * 1.2, 4_000))
      : ([...FONT_SIZE_STEPS].reverse().find((step) => step < points - 0.01) ??
        Math.max(points / 1.2, 1));
  return Math.max(
    DECK_LIMITS.minFontSize,
    Math.min(DECK_LIMITS.maxFontSize, Math.round(next * DECK_UNITS_PER_POINT)),
  );
}

/** What the toolbar shows for a range: values every run agrees on, else undefined. */
export interface TextState {
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strike?: boolean;
  baseline?: ResolvedRunStyle['baseline'];
  size?: number;
  family?: string;
  color?: string;
  align?: DeckTextAlign;
  list?: 'bullet' | 'number' | 'none';
  level?: number;
  lineSpacing?: number;
  spaceBefore?: number;
  spaceAfter?: number;
}

function paragraphList(paragraph: ResolvedParagraph): 'bullet' | 'number' | 'none' {
  if (!paragraph.label) return 'none';
  return /^[0-9a-z]+\.$/i.test(paragraph.label) ? 'number' : 'bullet';
}

function agree<T>(values: T[]): T | undefined {
  return values.length > 0 && values.every((value) => value === values[0]) ? values[0] : undefined;
}

export function textState(
  resolved: ResolvedTextBody,
  range: TextRange,
  pending?: TextFormat | null,
): TextState {
  const styles = stylesInRange(resolved.paragraphs, range);
  // Resolved paragraphs keep one run per stored run, so offsets line up.
  const touched = paragraphsInRange(resolved as unknown as DeckRichText, range).map(
    (index) => resolved.paragraphs[index],
  );
  const pick = <K extends keyof ResolvedRunStyle>(key: K) => commonValue(styles, key);
  const state: TextState = {
    bold: pick('bold'),
    italic: pick('italic'),
    underline: pick('underline'),
    strike: pick('strike'),
    baseline: pick('baseline'),
    size: pick('size'),
    family: agree(styles.map((style) => style.font.family)),
    color: agree(styles.map((style) => style.color.hex)),
    align: agree(touched.map((paragraph) => paragraph.align)),
    list: agree(touched.map(paragraphList)),
    level: agree(touched.map((paragraph) => paragraph.level)),
    lineSpacing: agree(touched.map((paragraph) => paragraph.lineSpacing)),
    spaceBefore: agree(touched.map((paragraph) => paragraph.spaceBefore)),
    spaceAfter: agree(touched.map((paragraph) => paragraph.spaceAfter)),
  };
  const override = pending?.style;
  if (override) {
    for (const key of ['bold', 'italic', 'underline', 'strike', 'size'] as const) {
      if (override[key] !== undefined) (state as Record<string, unknown>)[key] = override[key];
    }
    if (override.baseline) state.baseline = override.baseline;
    if (typeof override.font === 'string') state.family = override.font;
  }
  return state;
}

export interface TextCommandResult {
  body: DeckRichText;
  /** New typing format when the command applied to a caret in non-empty text. */
  pending?: TextFormat | null;
}

/** Whether a run-level command at this range only sets the typing format. */
function caretInText(body: DeckRichText, range: TextRange): boolean {
  if (range.start !== range.end) return false;
  const index = paragraphsInRange(body, range)[0];
  return index !== undefined && paragraphLength(body.paragraphs[index]) > 0;
}

function runPatch(command: TextCommand, state: TextState): RunStylePatch | null {
  switch (command.kind) {
    case 'toggle':
      return { [command.key]: !state[command.key] };
    case 'baseline':
      return { baseline: state.baseline === command.value ? null : command.value };
    case 'style':
      return command.patch;
    case 'sizeStep':
      return { size: steppedSize(state.size ?? 18 * DECK_UNITS_PER_POINT, command.direction) };
    default:
      return null;
  }
}

/**
 * Applies a command to `range` of `body`. `resolved` is the same body
 * resolved, used to read the current effective values.
 */
export function runTextCommand(
  body: DeckRichText,
  resolved: ResolvedTextBody,
  range: TextRange,
  command: TextCommand,
  pending?: TextFormat | null,
): TextCommandResult {
  const normalized = normalizeRange(range, body);
  const state = textState(resolved, normalized, pending);
  const patch = runPatch(command, state);
  if (patch) {
    if (caretInText(body, normalized)) {
      const base = pending ?? formatAt(body, normalized.start);
      const style = applyStylePatch(base.style, patch);
      return {
        body,
        pending: { ...(style ? { style } : {}), ...(base.link ? { link: base.link } : {}) },
      };
    }
    return { body: formatRange(body, normalized, patch) };
  }
  switch (command.kind) {
    case 'align':
      return {
        body: updateParagraphs(body, normalized, (style) => ({ ...style, align: command.value })),
      };
    case 'list': {
      const on = state.list !== command.list;
      return {
        body: updateParagraphs(body, normalized, (style) => {
          const next: DeckParagraphStyle = { ...style };
          if (!on) next.list = null;
          else if (style?.list === null && command.list === 'bullet') delete next.list;
          else next.list = command.list === 'bullet' ? { kind: 'bullet' } : { kind: 'number' };
          return next;
        }),
      };
    }
    case 'level':
      return { body: shiftLevel(body, normalized, command.delta) };
    case 'paragraph':
      return {
        body: updateParagraphs(body, normalized, (style) => ({ ...style, ...command.patch })),
      };
    case 'link':
      return { body: setLink(body, normalized, command.link) };
    case 'clear':
      return { body: clearFormatting(body, normalized), pending: null };
    default:
      return { body };
  }
}

/** The whole body as a range, for commands on a selected (not edited) box. */
export function wholeBody(body: DeckRichText): TextRange {
  const starts = paragraphStarts(body);
  const last = body.paragraphs.length - 1;
  return {
    start: 0,
    end: last < 0 ? 0 : starts[last] + paragraphLength(body.paragraphs[last]),
  };
}
