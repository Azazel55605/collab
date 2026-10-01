/**
 * Output pages: what a deck prints or exports as, before any raster step.
 *
 * Two page kinds share one pipeline:
 *
 * - **slides** — one page per slide, at the slide's own size;
 * - **handouts** — paper pages (A4 or Letter, either orientation) holding 1,
 *   2, 3, 4, 6, or 9 slides, optionally with each slide's speaker notes.
 *
 * Each page is an SVG (points as units, so print and raster agree), the text
 * runs drawn on it (for the PDF's invisible text layer), and its links. Print
 * shows the SVG directly; PDF export rasterizes it (`exportPdf.ts`).
 */
import type { DeckAssetRef, DeckDocument, DeckLink } from '../../types/deck';

import { fmt } from './geometry';
import type { DeckPdfLink, DeckPdfTextRun } from './pdf';
import { resolveDeck } from './resolve';
import type { ResolvedSlide, ResolvedTextBody } from './resolve';
import { escapeXml, renderSlideSvg, textSvg } from './svg';
import { applyMatrix, multiply, slideTextRuns } from './textLayer';
import type { DeckMatrix, DeckTextRun } from './textLayer';
import type { DeckTextMeasurer } from './textLayout';
import { layoutText } from './textLayout';
import { unitsToPoints } from './units';

export type DeckPaper = 'a4' | 'letter';
export type DeckOrientation = 'portrait' | 'landscape';
export const HANDOUT_SLIDES_PER_PAGE = [1, 2, 3, 4, 6, 9] as const;
export type HandoutSlidesPerPage = (typeof HANDOUT_SLIDES_PER_PAGE)[number];

export interface HandoutOptions {
  paper: DeckPaper;
  orientation: DeckOrientation;
  slidesPerPage: HandoutSlidesPerPage;
  notes: boolean;
}

export type DeckOutputLayout = { kind: 'slides' } | ({ kind: 'handouts' } & HandoutOptions);

export interface DeckOutputOptions {
  measurer: DeckTextMeasurer;
  resolveAsset?: (asset: DeckAssetRef) => string | null;
  /** Slides to include, in deck order. All slides when omitted. */
  slideIds?: readonly string[];
  /** Hidden slides are left out unless named in `slideIds` or this is set. */
  includeHidden?: boolean;
  /** Printed in handout headers. */
  title?: string;
}

export interface DeckOutputPage {
  /** Page size, points. */
  width: number;
  height: number;
  /** The page as SVG at the given CSS pixel size (the viewBox is in points). */
  svg: (pixelWidth: number, pixelHeight: number) => string;
  text: DeckPdfTextRun[];
  links: DeckPdfLink[];
}

/** Paper sizes in points, portrait. */
export const PAPER_SIZES: Record<DeckPaper, { width: number; height: number }> = {
  a4: { width: 595.28, height: 841.89 },
  letter: { width: 612, height: 792 },
};

const MARGIN = 36;
const HEADER = 22;
const GAP = 18;
/** One deck unit in points. */
const POINT = unitsToPoints(1);
/** Largest notes text on paper, deck units (11 pt). */
const NOTES_MAX_SIZE = 1_100;

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface HandoutCell {
  slide: Rect;
  notes: Rect | null;
}

/** The slides that go out, in deck order. */
export function outputSlides(deck: DeckDocument, options: DeckOutputOptions): ResolvedSlide[] {
  const wanted = options.slideIds ? new Set(options.slideIds) : null;
  return resolveDeck(deck).filter((slide) =>
    wanted ? wanted.has(slide.slideId) : options.includeHidden || !slide.hidden,
  );
}

function fitInto(area: Rect, aspect: number): Rect {
  const width = Math.min(area.width, area.height * aspect);
  const height = width / aspect;
  return {
    x: area.x + (area.width - width) / 2,
    y: area.y + (area.height - height) / 2,
    width,
    height,
  };
}

/** The page size and the slide (and notes) boxes for one handout page. */
export function handoutGrid(
  options: HandoutOptions,
  aspect: number,
): { width: number; height: number; cells: HandoutCell[] } {
  const paper = PAPER_SIZES[options.paper];
  const landscape = options.orientation === 'landscape';
  const width = landscape ? paper.height : paper.width;
  const height = landscape ? paper.width : paper.height;
  const area: Rect = {
    x: MARGIN,
    y: MARGIN + HEADER,
    width: width - MARGIN * 2,
    height: height - MARGIN * 2 - HEADER * 2,
  };
  const per = options.slidesPerPage;
  const cells: HandoutCell[] = [];

  if (options.notes && per === 1) {
    // A notes page: the slide in the upper part, the notes below it.
    const slideArea = { ...area, height: area.height * 0.46 };
    const slide = fitInto(slideArea, aspect);
    const notesTop = slideArea.y + slideArea.height + GAP;
    cells.push({
      slide,
      notes: { x: area.x, y: notesTop, width: area.width, height: area.y + area.height - notesTop },
    });
    return { width, height, cells };
  }

  if (options.notes) {
    // Rows: the slide on the left, its notes on the right.
    const rowHeight = (area.height - GAP * (per - 1)) / per;
    const slideWidth = landscape ? area.width * 0.42 : area.width * 0.5;
    for (let row = 0; row < per; row += 1) {
      const y = area.y + row * (rowHeight + GAP);
      const slide = fitInto({ x: area.x, y, width: slideWidth, height: rowHeight }, aspect);
      const notesX = area.x + slideWidth + GAP;
      cells.push({
        // Top-aligned, so the notes start level with their slide.
        slide: { ...slide, x: area.x, y },
        notes: { x: notesX, y, width: area.x + area.width - notesX, height: rowHeight },
      });
    }
    return { width, height, cells };
  }

  // A grid of slides. Portrait pages stack rows; landscape pages widen them.
  const grids: Record<HandoutSlidesPerPage, [number, number]> = {
    1: [1, 1],
    2: [1, 2],
    3: [1, 3],
    4: [2, 2],
    6: [2, 3],
    9: [3, 3],
  };
  let [columns, rows] = grids[per];
  if (landscape && per !== 4 && per !== 9) [columns, rows] = [rows, columns];
  const cellWidth = (area.width - GAP * (columns - 1)) / columns;
  const cellHeight = (area.height - GAP * (rows - 1)) / rows;
  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column < columns; column += 1) {
      cells.push({
        slide: fitInto(
          {
            x: area.x + column * (cellWidth + GAP),
            y: area.y + row * (cellHeight + GAP),
            width: cellWidth,
            height: cellHeight,
          },
          aspect,
        ),
        notes: null,
      });
    }
  }
  return { width, height, cells };
}

/** The slide SVG placed as a nested `<svg>` at a rectangle of the page. */
function placedSlideSvg(slide: ResolvedSlide, rect: Rect, options: DeckOutputOptions): string {
  const svg = renderSlideSvg(slide, {
    measurer: options.measurer,
    ...(options.resolveAsset ? { resolveAsset: options.resolveAsset } : {}),
    pixelWidth: rect.width,
    pixelHeight: rect.height,
  });
  return svg.replace(
    /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/,
    `<svg x="${fmt(rect.x)}" y="${fmt(rect.y)}"`,
  );
}

function runToPdf(run: DeckTextRun, page: DeckMatrix): DeckPdfTextRun {
  return {
    text: run.text,
    matrix: multiply(multiply(page, run.matrix), [1, 0, 0, 1, run.x, run.baseline]),
    size: run.size,
    width: run.width,
  };
}

function linkTarget(
  link: DeckLink,
  pageOfSlide: ReadonlyMap<string, number>,
): DeckPdfLink['target'] | null {
  if (link.kind === 'url') {
    return /^(https?:|mailto:)/i.test(link.href) ? { kind: 'uri', uri: link.href } : null;
  }
  if (link.kind === 'slide') {
    const pageIndex = pageOfSlide.get(link.slideId);
    return pageIndex === undefined ? null : { kind: 'page', pageIndex };
  }
  return null;
}

function runLink(
  run: DeckTextRun,
  page: DeckMatrix,
  pageOfSlide: ReadonlyMap<string, number>,
): DeckPdfLink | null {
  if (!run.link) return null;
  const target = linkTarget(run.link, pageOfSlide);
  if (!target) return null;
  const m = multiply(page, run.matrix);
  const corners = [
    applyMatrix(m, run.x, run.top),
    applyMatrix(m, run.x + run.width, run.top),
    applyMatrix(m, run.x, run.top + run.height),
    applyMatrix(m, run.x + run.width, run.top + run.height),
  ];
  const xs = corners.map((point) => point.x);
  const ys = corners.map((point) => point.y);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y, target };
}

function slideContent(
  slide: ResolvedSlide,
  rect: Rect,
  options: DeckOutputOptions,
  pageOfSlide: ReadonlyMap<string, number>,
): {
  svg: (pixelWidth: number, pixelHeight: number) => string;
  text: DeckPdfTextRun[];
  links: DeckPdfLink[];
} {
  const scale = rect.width / slide.width;
  const page: DeckMatrix = [scale, 0, 0, scale, rect.x, rect.y];
  const runs = slideTextRuns(slide, options.measurer);
  return {
    svg: () => placedSlideSvg(slide, rect, options),
    text: runs.map((run) => runToPdf(run, page)),
    links: runs
      .map((run) => runLink(run, page, pageOfSlide))
      .filter((link): link is DeckPdfLink => link !== null),
  };
}

/** Notes shrink to fit their box (to a floor), then clip. */
function notesContent(
  notes: ResolvedTextBody,
  rect: Rect,
  measurer: DeckTextMeasurer,
): { svg: string; text: DeckPdfTextRun[] } {
  const body: ResolvedTextBody = { ...notes, autoFit: 'shrink' };
  // Notes are styled for the speaker's screen; on paper they read at 11 pt at most.
  let largest = 0;
  for (const paragraph of notes.paragraphs) {
    for (const run of paragraph.runs) largest = Math.max(largest, run.style.size);
  }
  const scale = largest > 0 ? Math.min(1, NOTES_MAX_SIZE / largest) : 1;
  const width = rect.width / POINT / scale;
  const height = rect.height / POINT / scale;
  const page: DeckMatrix = [POINT * scale, 0, 0, POINT * scale, rect.x, rect.y];
  const layout = layoutText(body, width, height, measurer);
  const text: DeckPdfTextRun[] = [];
  for (const line of layout.lines) {
    if (line.top + line.height > height + 1) break;
    for (const fragment of line.label ? [line.label, ...line.fragments] : line.fragments) {
      if (!fragment.text.trim()) continue;
      text.push({
        text: fragment.text,
        matrix: multiply(page, [1, 0, 0, 1, fragment.x, line.baseline]),
        size: fragment.style.size,
        width: fragment.width,
      });
    }
  }
  const svg =
    `<svg x="${fmt(rect.x)}" y="${fmt(rect.y)}" width="${fmt(rect.width)}" height="${fmt(rect.height)}"` +
    ` viewBox="0 0 ${fmt(width)} ${fmt(height)}" overflow="hidden">${textSvg(body, width, height, measurer)}</svg>`;
  return { svg, text };
}

function pageSvg(width: number, height: number, body: string) {
  return (pixelWidth: number, pixelHeight: number) =>
    `<svg xmlns="http://www.w3.org/2000/svg" width="${fmt(pixelWidth)}" height="${fmt(pixelHeight)}"` +
    ` viewBox="0 0 ${fmt(width)} ${fmt(height)}" overflow="hidden">` +
    `<rect width="${fmt(width)}" height="${fmt(height)}" fill="#ffffff"/>${body}</svg>`;
}

/** Builds every output page for a layout. */
export function buildOutputPages(
  deck: DeckDocument,
  layout: DeckOutputLayout,
  options: DeckOutputOptions,
): DeckOutputPage[] {
  const slides = outputSlides(deck, options);
  if (slides.length === 0) return [];

  if (layout.kind === 'slides') {
    const pageOfSlide = new Map(slides.map((slide, index) => [slide.slideId, index]));
    return slides.map((slide) => {
      const width = unitsToPoints(slide.width);
      const height = unitsToPoints(slide.height);
      const content = slideContent(slide, { x: 0, y: 0, width, height }, options, pageOfSlide);
      const inner = content.svg(width, height);
      return {
        width,
        height,
        svg: pageSvg(width, height, inner),
        text: content.text,
        links: content.links,
      };
    });
  }

  const aspect = slides[0].width / slides[0].height;
  const grid = handoutGrid(layout, aspect);
  const perPage = grid.cells.length;
  const pageCount = Math.ceil(slides.length / perPage);
  const pageOfSlide = new Map(
    slides.map((slide, index) => [slide.slideId, Math.floor(index / perPage)]),
  );
  const title = options.title?.trim() ?? '';
  const pages: DeckOutputPage[] = [];
  for (let pageIndex = 0; pageIndex < pageCount; pageIndex += 1) {
    const parts: string[] = [];
    const text: DeckPdfTextRun[] = [];
    const links: DeckPdfLink[] = [];
    if (title) {
      parts.push(
        `<text x="${MARGIN}" y="${MARGIN + 10}" font-family="Inter, Arial, sans-serif" font-size="10" fill="#6b7280">${escapeXml(title)}</text>`,
      );
    }
    parts.push(
      `<text x="${fmt(grid.width / 2)}" y="${fmt(grid.height - MARGIN + 4)}" text-anchor="middle" font-family="Inter, Arial, sans-serif" font-size="9" fill="#6b7280">${pageIndex + 1} / ${pageCount}</text>`,
    );
    grid.cells.forEach((cell, cellIndex) => {
      const slide = slides[pageIndex * perPage + cellIndex];
      if (!slide) return;
      const content = slideContent(slide, cell.slide, options, pageOfSlide);
      parts.push(content.svg(cell.slide.width, cell.slide.height));
      parts.push(
        `<rect x="${fmt(cell.slide.x)}" y="${fmt(cell.slide.y)}" width="${fmt(cell.slide.width)}" height="${fmt(cell.slide.height)}" fill="none" stroke="#9ca3af" stroke-width="0.75"/>`,
      );
      text.push(...content.text);
      links.push(...content.links);
      if (cell.notes && slide.notes) {
        const notes = notesContent(slide.notes, cell.notes, options.measurer);
        parts.push(notes.svg);
        text.push(...notes.text);
      }
    });
    pages.push({
      width: grid.width,
      height: grid.height,
      svg: pageSvg(grid.width, grid.height, parts.join('')),
      text,
      links,
    });
  }
  return pages;
}

/**
 * Parses a slide range such as `1-3, 5, 8-` into 1-based slide numbers, in
 * order and without repeats. Throws with a readable message when invalid.
 */
export function parseSlideRange(input: string, count: number): number[] {
  const out = new Set<number>();
  const parts = input
    .split(/[,;]/)
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.length === 0) throw new Error('Enter slide numbers, such as 1-3, 5.');
  for (const part of parts) {
    const match = /^(\d*)\s*[-–]\s*(\d*)$/.exec(part) ?? /^(\d+)$/.exec(part);
    if (!match) throw new Error(`“${part}” is not a slide number or range.`);
    const single = match.length === 2;
    const start = match[1] ? Number(match[1]) : 1;
    const end = single ? start : match[2] ? Number(match[2]) : count;
    if (start < 1 || end > count || start > end) {
      throw new Error(`“${part}” is outside slides 1–${count}.`);
    }
    for (let number = start; number <= end; number += 1) out.add(number);
  }
  return [...out].sort((a, b) => a - b);
}
