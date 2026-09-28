/**
 * Text layout for resolved text bodies.
 *
 * One layout feeds every non-editing output — thumbnails, presentation mode,
 * SVG, PDF, and images — so a line breaks in the same place everywhere the
 * same fonts are available. Width measurement is the only platform-dependent
 * input, and it sits behind `DeckTextMeasurer`:
 *
 * - `createCanvasMeasurer()` measures with the platform's real fonts.
 * - `createApproximateMeasurer()` is deterministic and font-free, for tests,
 *   workers without a canvas, and fallback previews.
 *
 * Line height is `1.2 x size x lineSpacing%`, the single-spacing factor
 * PowerPoint and most slide tools use; it is an approximation of each font's
 * real ascent and descent, and `tools/deck-text-probe.html` measures how far
 * that is from the platform's own layout.
 */
import type { ResolvedParagraph, ResolvedRunStyle, ResolvedTextBody } from './resolve';

export interface DeckTextMeasurer {
  /** Advance width of `text` in deck units, for `style` (size is in deck units). */
  measure(text: string, style: ResolvedRunStyle): number;
}

export interface LaidOutFragment {
  /** Left edge relative to the text box, deck units. */
  x: number;
  width: number;
  text: string;
  style: ResolvedRunStyle;
  /** Index of the source run inside its paragraph. */
  runIndex: number;
}

export interface LaidOutLine {
  paragraphId: string;
  /** Baseline relative to the text box top, deck units. */
  baseline: number;
  top: number;
  height: number;
  width: number;
  fragments: LaidOutFragment[];
  /** List label, drawn on the paragraph's first line only. */
  label: LaidOutFragment | null;
}

export interface DeckTextLayout {
  lines: LaidOutLine[];
  /** Applied `shrink` factor, 1 when the text fits or auto-fit is off. */
  scale: number;
  /** Height the text needs, including insets, at `scale`. */
  contentHeight: number;
  /** True when the text still does not fit vertically. */
  overflow: boolean;
}

export const DECK_LINE_HEIGHT_FACTOR = 1.2;
const ASCENT_FACTOR = 0.8;
/** The smallest shrink PowerPoint applies before it gives up: 25%. */
const MIN_SHRINK = 0.25;

/* ------------------------------------------------------------------------- */
/* Measurers                                                                  */
/* ------------------------------------------------------------------------- */

/** Rough advance widths in ems, per character class. */
function approximateEm(char: string): number {
  if (char === ' ') return 0.28;
  if ("il.,:;'|!ſ".includes(char)) return 0.26;
  if ('fjrt()[]{}'.includes(char)) return 0.36;
  if ('mwMW@%'.includes(char)) return 0.86;
  if (char >= 'A' && char <= 'Z') return 0.66;
  if (char >= '0' && char <= '9') return 0.56;
  if (char.charCodeAt(0) > 0x2e7f) return 1; // CJK and other full-width text
  return 0.52;
}

/** Deterministic, font-free measurer. Never used where real fonts are available. */
export function createApproximateMeasurer(): DeckTextMeasurer {
  return {
    measure(text, style) {
      let ems = 0;
      for (const char of text) ems += approximateEm(char);
      return ems * style.size * (style.bold ? 1.06 : 1);
    },
  };
}

/** CSS font-family list for a resolved font, generic families unquoted. */
export function cssFontFamily(font: ResolvedRunStyle['font']): string {
  return [font.family, ...font.fallbacks]
    .map((family) =>
      /^(serif|sans-serif|monospace|cursive|fantasy|system-ui)$/.test(family)
        ? family
        : `"${family.replace(/["\\]/g, '')}"`,
    )
    .join(', ');
}

/** CSS `font` shorthand for a resolved style at a given pixel size. */
export function cssFont(style: ResolvedRunStyle, pixelSize: number): string {
  return `${style.italic ? 'italic ' : ''}${style.bold ? '700 ' : '400 '}${pixelSize}px ${cssFontFamily(style.font)}`;
}

type MeasuringContext = { font: string; measureText(text: string): { width: number } };

/**
 * Measures with the platform's fonts through a 2D canvas context. Measures at
 * a fixed reference size and scales, so the cache is per font, not per size.
 */
export function createCanvasMeasurer(context?: MeasuringContext): DeckTextMeasurer {
  const REFERENCE_PX = 100;
  const ctx =
    context ??
    ((typeof OffscreenCanvas !== 'undefined'
      ? new OffscreenCanvas(1, 1).getContext('2d')
      : document.createElement('canvas').getContext('2d')) as MeasuringContext | null);
  if (!ctx) return createApproximateMeasurer();
  const cache = new Map<string, number>();
  return {
    measure(text, style) {
      const font = cssFont({ ...style, size: 0 }, REFERENCE_PX);
      const key = `${font}\u0000${text}`;
      let width = cache.get(key);
      if (width === undefined) {
        ctx.font = font;
        width = ctx.measureText(text).width;
        if (cache.size > 20_000) cache.clear();
        cache.set(key, width);
      }
      // Width at 100 px scales linearly: deck units = px width * size / 100.
      return (width * style.size) / REFERENCE_PX;
    },
  };
}

/* ------------------------------------------------------------------------- */
/* Layout                                                                     */
/* ------------------------------------------------------------------------- */

interface Token {
  text: string;
  style: ResolvedRunStyle;
  runIndex: number;
  isSpace: boolean;
  isBreak: boolean;
}

function tokenize(paragraph: ResolvedParagraph): Token[] {
  const tokens: Token[] = [];
  paragraph.runs.forEach((run, runIndex) => {
    if (run.kind === 'break') {
      tokens.push({ text: '', style: run.style, runIndex, isSpace: false, isBreak: true });
      return;
    }
    for (const part of run.text.split(/(\s+)/)) {
      if (part === '') continue;
      tokens.push({
        text: part,
        style: run.style,
        runIndex,
        isSpace: /^\s+$/.test(part),
        isBreak: false,
      });
    }
  });
  return tokens;
}

function scaled(style: ResolvedRunStyle, scale: number): ResolvedRunStyle {
  return scale === 1 ? style : { ...style, size: style.size * scale };
}

/** Splits a word wider than the line into pieces that fit, by code point. */
function splitWord(
  token: Token,
  width: number,
  measurer: DeckTextMeasurer,
  style: ResolvedRunStyle,
): Token[] {
  const pieces: Token[] = [];
  let current = '';
  for (const char of token.text) {
    if (current !== '' && measurer.measure(current + char, style) > width) {
      pieces.push({ ...token, text: current });
      current = char;
    } else {
      current += char;
    }
  }
  if (current !== '') pieces.push({ ...token, text: current });
  return pieces;
}

function layoutAtScale(
  body: ResolvedTextBody,
  boxWidth: number,
  measurer: DeckTextMeasurer,
  scale: number,
): { lines: LaidOutLine[]; height: number } {
  const [insetLeft, insetTop, insetRight] = body.insets;
  const available = Math.max(0, boxWidth - insetLeft - insetRight);
  const lines: LaidOutLine[] = [];
  let cursor = insetTop;

  body.paragraphs.forEach((paragraph, paragraphIndex) => {
    if (paragraphIndex > 0) cursor += paragraph.spaceBefore * scale;
    const indent = paragraph.indent * scale;
    const lineAvailable = Math.max(1, available - indent);
    const spacing = paragraph.lineSpacing / 100;

    let fragments: LaidOutFragment[] = [];
    let lineWidth = 0;
    let lineMaxSize = 0;
    let first = true;

    const flush = () => {
      // Trailing spaces neither count toward the width nor get drawn. A space
      // may have merged into the fragment of the word before it.
      while (fragments.length > 0) {
        const last = fragments[fragments.length - 1];
        const trimmed = last.text.replace(/\s+$/, '');
        if (trimmed === last.text) break;
        lineWidth -= last.width;
        if (trimmed === '') {
          fragments.pop();
          continue;
        }
        last.text = trimmed;
        last.width = measurer.measure(trimmed, last.style);
        lineWidth += last.width;
        break;
      }
      const size = lineMaxSize || paragraph.endStyle.size * scale;
      const height = size * DECK_LINE_HEIGHT_FACTOR * spacing;
      let offset = 0;
      if (paragraph.align === 'center') offset = (lineAvailable - lineWidth) / 2;
      else if (paragraph.align === 'right') offset = lineAvailable - lineWidth;
      const x0 = insetLeft + indent + Math.max(0, offset);
      let label: LaidOutFragment | null = null;
      if (first && paragraph.label) {
        const labelStyle = scaled(
          paragraph.runs.find((run) => run.kind === 'text')?.style ?? paragraph.endStyle,
          scale,
        );
        const labelWidth = measurer.measure(paragraph.label, labelStyle);
        // The label hangs to the left of the text, a quarter em clear of it.
        label = {
          x: Math.max(insetLeft, x0 - labelWidth - labelStyle.size * 0.25),
          width: labelWidth,
          text: paragraph.label,
          style: labelStyle,
          runIndex: -1,
        };
      }
      lines.push({
        paragraphId: paragraph.id,
        top: cursor,
        height,
        baseline: cursor + height - size * DECK_LINE_HEIGHT_FACTOR * spacing * (1 - ASCENT_FACTOR),
        width: lineWidth,
        fragments: fragments.map((fragment) => ({ ...fragment, x: fragment.x + x0 })),
        label,
      });
      cursor += height;
      fragments = [];
      lineWidth = 0;
      lineMaxSize = 0;
      first = false;
    };

    const place = (token: Token, style: ResolvedRunStyle, width: number) => {
      const previous = fragments[fragments.length - 1];
      // Merge adjacent pieces of the same run, and measure the merged text as
      // one string: summing word widths loses kerning across the spaces and
      // breaks lines early at exact edges (measured by the text probe).
      if (previous && previous.runIndex === token.runIndex) {
        previous.text += token.text;
        const merged = measurer.measure(previous.text, style);
        lineWidth += merged - previous.width;
        previous.width = merged;
        lineMaxSize = Math.max(lineMaxSize, style.size);
        return;
      } else {
        fragments.push({ x: lineWidth, width, text: token.text, style, runIndex: token.runIndex });
      }
      lineWidth += width;
      lineMaxSize = Math.max(lineMaxSize, style.size);
    };

    const tokens = tokenize(paragraph);
    for (let index = 0; index < tokens.length; index += 1) {
      const token = tokens[index];
      const style = scaled(token.style, scale);
      if (token.isBreak) {
        lineMaxSize = Math.max(lineMaxSize, style.size);
        flush();
        continue;
      }
      if (token.isSpace && fragments.length === 0 && !first) continue; // no leading space on wrapped lines
      const width = measurer.measure(token.text, style);
      const previous = fragments[fragments.length - 1];
      const projected =
        previous && previous.runIndex === token.runIndex
          ? lineWidth - previous.width + measurer.measure(previous.text + token.text, style)
          : lineWidth + width;
      if (body.wrap && !token.isSpace && fragments.length > 0 && projected > lineAvailable) {
        flush();
      }
      if (body.wrap && !token.isSpace && fragments.length === 0 && width > lineAvailable) {
        const pieces = splitWord(token, lineAvailable, measurer, style);
        pieces.forEach((piece, pieceIndex) => {
          place(piece, style, measurer.measure(piece.text, style));
          if (pieceIndex < pieces.length - 1) flush();
        });
        continue;
      }
      place(token, style, width);
    }
    flush();
    cursor += paragraph.spaceAfter * scale;
  });

  return { lines, height: cursor + body.insets[3] };
}

/**
 * Lays out a resolved text body inside a box of `boxWidth` x `boxHeight` deck
 * units. Coordinates are relative to the box's top-left corner.
 */
export function layoutText(
  body: ResolvedTextBody,
  boxWidth: number,
  boxHeight: number,
  measurer: DeckTextMeasurer,
): DeckTextLayout {
  let scale = 1;
  let result = layoutAtScale(body, boxWidth, measurer, 1);

  if (body.autoFit === 'shrink' && result.height > boxHeight) {
    // Whole-percent steps, as PowerPoint's `fontScale`, found by bisection.
    let low = Math.round(MIN_SHRINK * 100);
    let high = 99;
    let best = low;
    while (low <= high) {
      const middle = Math.floor((low + high) / 2);
      if (layoutAtScale(body, boxWidth, measurer, middle / 100).height <= boxHeight) {
        best = middle;
        low = middle + 1;
      } else {
        high = middle - 1;
      }
    }
    scale = best / 100;
    result = layoutAtScale(body, boxWidth, measurer, scale);
  }

  const overflow = body.autoFit !== 'grow' && result.height > boxHeight + 0.5;
  const frameHeight = body.autoFit === 'grow' ? Math.max(boxHeight, result.height) : boxHeight;
  const slack = Math.max(0, frameHeight - result.height);
  const shift =
    body.verticalAlign === 'middle' ? slack / 2 : body.verticalAlign === 'bottom' ? slack : 0;
  const lines =
    shift === 0
      ? result.lines
      : result.lines.map((line) => ({
          ...line,
          top: line.top + shift,
          baseline: line.baseline + shift,
        }));

  return { lines, scale, contentHeight: result.height, overflow };
}
