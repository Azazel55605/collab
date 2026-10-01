/**
 * The words on a slide, where they are drawn.
 *
 * Slide images keep a slide pixel-identical to the editor, but a picture of
 * text cannot be searched, selected, or read aloud. This walks the same
 * resolved scene and text layout the SVG renderer draws, and reports each
 * drawn run with its position, so the PDF writer can lay an invisible text
 * layer over the image and playback can find the link under a click.
 *
 * Positions are deck units in slide coordinates. Every run carries the matrix
 * of the box it sits in, so rotation and flips map exactly as they draw.
 */
import type { DeckLink } from '../../types/deck';

import type { ResolvedItem, ResolvedSlide, ResolvedTextBody } from './resolve';
import { layoutText } from './textLayout';
import type { DeckTextMeasurer } from './textLayout';

/** A 2D affine matrix `[a, b, c, d, e, f]`, as in SVG and PDF. */
export type DeckMatrix = [number, number, number, number, number, number];

export interface DeckTextRun {
  text: string;
  /** Box-local left edge and baseline, deck units. */
  x: number;
  baseline: number;
  /** Box-local line top and height, for hit testing. */
  top: number;
  height: number;
  /** Advance width in deck units. */
  width: number;
  /** Font size in deck units. */
  size: number;
  /** Box-local → slide coordinates. */
  matrix: DeckMatrix;
  link?: DeckLink;
}

export const IDENTITY: DeckMatrix = [1, 0, 0, 1, 0, 0];

export function multiply(m: DeckMatrix, n: DeckMatrix): DeckMatrix {
  return [
    m[0] * n[0] + m[2] * n[1],
    m[1] * n[0] + m[3] * n[1],
    m[0] * n[2] + m[2] * n[3],
    m[1] * n[2] + m[3] * n[3],
    m[0] * n[4] + m[2] * n[5] + m[4],
    m[1] * n[4] + m[3] * n[5] + m[5],
  ];
}

export function applyMatrix(m: DeckMatrix, x: number, y: number): { x: number; y: number } {
  return { x: m[0] * x + m[2] * y + m[4], y: m[1] * x + m[3] * y + m[5] };
}

function invert(m: DeckMatrix): DeckMatrix | null {
  const det = m[0] * m[3] - m[1] * m[2];
  if (Math.abs(det) < 1e-12) return null;
  return [
    m[3] / det,
    -m[1] / det,
    -m[2] / det,
    m[0] / det,
    (m[2] * m[5] - m[3] * m[4]) / det,
    (m[1] * m[4] - m[0] * m[5]) / det,
  ];
}

/** The matrix `svg.ts` places an item's local box with (translate, rotate about centre, flip). */
export function frameMatrix(frame: ResolvedItem['frame']): DeckMatrix {
  let m: DeckMatrix = [1, 0, 0, 1, frame.x, frame.y];
  if (frame.rotation) {
    const angle = ((frame.rotation / 100) * Math.PI) / 180;
    const cx = frame.width / 2;
    const cy = frame.height / 2;
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    m = multiply(m, [cos, sin, -sin, cos, cx - cos * cx + sin * cy, cy - sin * cx - cos * cy]);
  }
  if (frame.flipH || frame.flipV) {
    m = multiply(m, [
      frame.flipH ? -1 : 1,
      0,
      0,
      frame.flipV ? -1 : 1,
      frame.flipH ? frame.width : 0,
      frame.flipV ? frame.height : 0,
    ]);
  }
  return m;
}

function bodyRuns(
  body: ResolvedTextBody,
  width: number,
  height: number,
  measurer: DeckTextMeasurer,
  matrix: DeckMatrix,
  out: DeckTextRun[],
): void {
  const layout = layoutText(body, width, height, measurer);
  const paragraphs = new Map(body.paragraphs.map((paragraph) => [paragraph.id, paragraph]));
  for (const line of layout.lines) {
    const paragraph = paragraphs.get(line.paragraphId);
    const fragments = line.label ? [line.label, ...line.fragments] : line.fragments;
    for (const fragment of fragments) {
      if (!fragment.text.trim()) continue;
      const run = fragment === line.label ? undefined : paragraph?.runs[fragment.runIndex];
      const link = run?.kind === 'text' ? run.link : undefined;
      out.push({
        text: fragment.text,
        x: fragment.x,
        baseline: line.baseline,
        top: line.top,
        height: line.height,
        width: fragment.width,
        size: fragment.style.size,
        matrix,
        ...(link ? { link } : {}),
      });
    }
  }
}

/** Every drawn text run on a slide, in paint order. Chart labels are not included. */
export function slideTextRuns(slide: ResolvedSlide, measurer: DeckTextMeasurer): DeckTextRun[] {
  const out: DeckTextRun[] = [];
  for (const item of slide.items) {
    const matrix = frameMatrix(item.frame);
    if (item.kind === 'shape' && item.text && !item.prompt) {
      bodyRuns(item.text, item.frame.width, item.frame.height, measurer, matrix, out);
    } else if (item.kind === 'table') {
      for (const cell of item.cells) {
        const cellMatrix = multiply(matrix, [
          1,
          0,
          0,
          1,
          cell.x - item.frame.x,
          cell.y - item.frame.y,
        ]);
        bodyRuns(cell.text, cell.width, cell.height, measurer, cellMatrix, out);
      }
    }
  }
  return out;
}

/** The link under a point in slide coordinates, topmost first. */
export function linkAt(runs: readonly DeckTextRun[], x: number, y: number): DeckLink | null {
  for (let index = runs.length - 1; index >= 0; index -= 1) {
    const run = runs[index];
    if (!run.link) continue;
    const inverse = invert(run.matrix);
    if (!inverse) continue;
    const local = applyMatrix(inverse, x, y);
    if (
      local.x >= run.x &&
      local.x <= run.x + run.width &&
      local.y >= run.top &&
      local.y <= run.top + run.height
    ) {
      return run.link;
    }
  }
  return null;
}
