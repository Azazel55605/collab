/**
 * Bounded presentation accessibility analysis and semantic labels.
 *
 * The visual renderer remains one SVG. This module builds the small semantic
 * companion tree used by assistive technology and the authoring audit; it
 * never creates a DOM node per glyph or chart point.
 */
import type { DeckDocument, DeckElement, DeckSlide } from '../../types/deck';

import { isFontAvailable, missingDeckFonts } from './fonts';
import type { ResolvedFill, ResolvedItem, ResolvedSlide, ResolvedTextBody } from './resolve';
import { resolveSlide } from './resolve';

export type DeckAccessibilityIssueCode =
  'missing-alt-text' | 'low-contrast' | 'unknown-background-contrast' | 'missing-font';

export interface DeckAccessibilityIssue {
  code: DeckAccessibilityIssueCode;
  severity: 'error' | 'warning';
  slideId?: string;
  elementId?: string;
  message: string;
}

function leafOrder(slide: DeckSlide): string[] {
  const output: string[] = [];
  const seen = new Set<string>();
  const visit = (id: string) => {
    if (seen.has(id)) return;
    seen.add(id);
    const element = slide.elements[id];
    if (!element) return;
    if (element.type === 'group') {
      element.childIds.forEach(visit);
      return;
    }
    output.push(id);
  };
  slide.elementOrder.forEach(visit);
  Object.keys(slide.elements).forEach(visit);
  return output;
}

/** Custom order first, followed by every still-unlisted object in paint order. */
export function slideReadingOrder(slide: DeckSlide): string[] {
  const leaves = leafOrder(slide);
  const allowed = new Set(leaves);
  const custom = (slide.readingOrder ?? []).filter(
    (id, index, order) => allowed.has(id) && order.indexOf(id) === index,
  );
  return [...custom, ...leaves.filter((id) => !custom.includes(id))];
}

function text(body: ResolvedTextBody | null): string {
  if (!body) return '';
  return body.paragraphs
    .map((paragraph) =>
      paragraph.runs.map((run) => (run.kind === 'text' ? run.text : ' ')).join(''),
    )
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function truncate(value: string, length = 180): string {
  return value.length <= length ? value : `${value.slice(0, length - 1).trimEnd()}…`;
}

/** Stable, bounded object name for the semantic slide companion. */
export function accessibleItemLabel(item: ResolvedItem): string {
  const authored = item.altText?.trim() || item.name?.trim();
  if (authored) return truncate(authored);
  switch (item.kind) {
    case 'shape': {
      const content = text(item.text);
      return content ? truncate(content) : item.elementType === 'text' ? 'Empty text box' : 'Shape';
    }
    case 'line':
      return 'Line';
    case 'image':
      return 'Image without alternative text';
    case 'table':
      return `Table, ${item.rowIds.length} rows by ${item.columnIds.length} columns`;
    case 'chart':
      return item.title?.trim()
        ? `${item.title}, ${item.chartKind} chart`
        : `${item.chartKind} chart without alternative text`;
    case 'embed':
      return `Linked document ${item.source.path}`;
  }
}

/** Resolved objects in semantic order: master/layout content, then slide order. */
export function accessibleSlideItems(slide: ResolvedSlide): ResolvedItem[] {
  const rank = new Map(slide.readingOrder.map((id, index) => [id, index]));
  const inherited = slide.items.filter((item) => item.origin !== 'slide');
  const authored = slide.items.filter((item) => item.origin === 'slide');
  authored.sort(
    (a, b) =>
      (rank.get(a.id) ?? Number.MAX_SAFE_INTEGER) - (rank.get(b.id) ?? Number.MAX_SAFE_INTEGER),
  );
  return [...inherited, ...authored];
}

function rgb(hex: string): [number, number, number] | null {
  const match = /^#([\da-f]{2})([\da-f]{2})([\da-f]{2})$/i.exec(hex);
  return match
    ? [Number.parseInt(match[1], 16), Number.parseInt(match[2], 16), Number.parseInt(match[3], 16)]
    : null;
}

function luminance(hex: string): number | null {
  const color = rgb(hex);
  if (!color) return null;
  const channel = (value: number) => {
    const linear = value / 255;
    return linear <= 0.04045 ? linear / 12.92 : ((linear + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(color[0]) + 0.7152 * channel(color[1]) + 0.0722 * channel(color[2]);
}

export function contrastRatio(foreground: string, background: string): number | null {
  const a = luminance(foreground);
  const b = luminance(background);
  if (a === null || b === null) return null;
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

function composite(foreground: string, alpha: number, background: string): string | null {
  const front = rgb(foreground);
  const back = rgb(background);
  if (!front || !back) return null;
  const value = front.map((channel, index) =>
    Math.round(channel * alpha + back[index] * (1 - alpha)),
  );
  return `#${value.map((channel) => channel.toString(16).padStart(2, '0')).join('')}`;
}

function solidBackground(fill: ResolvedFill, fallback: string | null): string | null {
  if (fill.kind === 'image') return null;
  if (fill.kind === 'none') return fallback;
  if (fill.color.alpha === 1) return fill.color.hex;
  return fallback ? composite(fill.color.hex, fill.color.alpha, fallback) : null;
}

function textBodies(
  item: ResolvedItem,
): Array<{ body: ResolvedTextBody; background: ResolvedFill }> {
  if (item.kind === 'shape' && item.text) return [{ body: item.text, background: item.fill }];
  if (item.kind === 'table')
    return item.cells.map((cell) => ({ body: cell.text, background: cell.fill }));
  if (item.kind === 'chart') {
    const body: ResolvedTextBody = {
      paragraphs: [
        {
          id: `${item.id}-chart-label`,
          align: 'left',
          level: 0,
          label: null,
          indent: 0,
          spaceBefore: 0,
          spaceAfter: 0,
          lineSpacing: 100,
          runs: [
            {
              kind: 'text',
              text: item.title ?? item.series.map((series) => series.name).join(' '),
              style: item.textStyle,
            },
          ],
          endStyle: item.textStyle,
        },
      ],
      insets: [0, 0, 0, 0],
      verticalAlign: 'top',
      autoFit: 'none',
      wrap: true,
    };
    return [{ body, background: { kind: 'none' } }];
  }
  return [];
}

function contrastIssues(slide: ResolvedSlide): DeckAccessibilityIssue[] {
  const issues: DeckAccessibilityIssue[] = [];
  const slideBackground = solidBackground(slide.background, '#ffffff');
  for (const item of slide.items) {
    for (const entry of textBodies(item)) {
      const background = solidBackground(entry.background, slideBackground);
      if (!background) {
        if (text(entry.body)) {
          issues.push({
            code: 'unknown-background-contrast',
            severity: 'warning',
            slideId: slide.slideId,
            elementId: item.id,
            message: `${accessibleItemLabel(item)} uses text over an image or transparent background; check contrast manually.`,
          });
        }
        continue;
      }
      let lowest = Number.POSITIVE_INFINITY;
      let threshold = 3;
      for (const paragraph of entry.body.paragraphs) {
        for (const run of paragraph.runs) {
          if (run.kind !== 'text' || !run.text.trim()) continue;
          const foreground = composite(
            run.style.color.hex,
            run.style.color.alpha * item.opacity,
            background,
          );
          const ratio = foreground ? contrastRatio(foreground, background) : null;
          if (ratio !== null) lowest = Math.min(lowest, ratio);
          const points = run.style.size / 100;
          threshold = Math.max(
            threshold,
            points >= 18 || (run.style.bold && points >= 14) ? 3 : 4.5,
          );
        }
      }
      if (lowest < threshold) {
        issues.push({
          code: 'low-contrast',
          severity: 'error',
          slideId: slide.slideId,
          elementId: item.id,
          message: `${accessibleItemLabel(item)} has ${lowest.toFixed(1)}:1 text contrast; ${threshold}:1 is required.`,
        });
      }
    }
  }
  return issues;
}

export interface DeckAccessibilityAuditOptions {
  fontAvailable?: (family: string) => boolean;
}

/** Whole-deck audit, bounded by the same document limits as resolution. */
export function auditDeckAccessibility(
  deck: DeckDocument,
  options: DeckAccessibilityAuditOptions = {},
): DeckAccessibilityIssue[] {
  const issues: DeckAccessibilityIssue[] = [];
  for (const slideId of deck.slideOrder) {
    const slide = resolveSlide(deck, slideId);
    for (const item of slide.items) {
      if (
        item.origin === 'slide' &&
        (item.kind === 'image' || item.kind === 'embed' || item.kind === 'chart') &&
        !item.altText?.trim() &&
        !(item.kind === 'chart' && item.title?.trim())
      ) {
        issues.push({
          code: 'missing-alt-text',
          severity: 'error',
          slideId,
          elementId: item.id,
          message: `${accessibleItemLabel(item)} needs alternative text.`,
        });
      }
    }
    issues.push(...contrastIssues(slide));
  }
  const fontAvailable = options.fontAvailable ?? isFontAvailable;
  for (const [family, fallback] of Object.entries(missingDeckFonts(deck, fontAvailable))) {
    issues.push({
      code: 'missing-font',
      severity: 'warning',
      message: `${family} is not installed; ${fallback} is used as the preview fallback.`,
    });
  }
  return issues;
}

export function objectReadingLabel(element: DeckElement): string {
  return (
    element.name?.trim() ||
    `${element.type[0].toUpperCase()}${element.type.slice(1)} · ${element.id}`
  );
}
