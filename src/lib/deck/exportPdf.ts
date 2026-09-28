/**
 * Slide image and PDF output — the Phase 0 proof of the path, not the final
 * exporter.
 *
 * Each slide goes resolved scene → SVG (`svg.ts`) → raster → page, reusing the
 * bounded PDF writer the ink exporter already ships. Rasterizing is injected:
 * in the app it is an `OffscreenCanvas` in a worker; in tests it is a stub.
 *
 * Raster pages keep slides pixel-identical to the editor but make PDF text
 * unselectable. Whether Phase 5 adds a vector PDF writer (real text, embedded
 * fonts) is an open decision recorded in the contract.
 */
import type { DeckAssetRef, DeckDocument } from '../../types/deck';
import { buildInkPdf } from '../ink/exportPdf';
import type { InkPdfImagePage } from '../ink/exportPdf';

import { resolveDeck } from './resolve';
import { renderSlideSvg } from './svg';
import type { DeckTextMeasurer } from './textLayout';
import { unitsToPoints, unitsToPx } from './units';

/** Turns one slide SVG into JPEG bytes at the given pixel size. */
export type DeckRasterizer = (
  svg: string,
  pixelWidth: number,
  pixelHeight: number,
) => Promise<Uint8Array>;

export interface DeckImageExportOptions {
  measurer: DeckTextMeasurer;
  rasterize: DeckRasterizer;
  resolveAsset?: (asset: DeckAssetRef) => string | null;
  /** Output pixels per CSS pixel. 2 gives 2560 x 1440 for a widescreen slide. */
  scale?: number;
  slideIds?: string[];
  includeHidden?: boolean;
  isCancelled?: () => boolean;
  onProgress?: (completed: number, total: number) => void;
}

/** The longest raster edge any one slide may request. */
export const DECK_MAX_RASTER_EDGE = 8_192;

export class DeckExportCancelledError extends Error {
  constructor() {
    super('Deck export was cancelled.');
    this.name = 'DeckExportCancelledError';
  }
}

export async function renderDeckPages(
  deck: DeckDocument,
  options: DeckImageExportOptions,
): Promise<InkPdfImagePage[]> {
  const wanted = options.slideIds ? new Set(options.slideIds) : null;
  const slides = resolveDeck(deck).filter(
    (slide) => (!wanted || wanted.has(slide.slideId)) && (options.includeHidden || !slide.hidden),
  );
  const scale = options.scale ?? 2;
  const pages: InkPdfImagePage[] = [];
  for (const [index, slide] of slides.entries()) {
    if (options.isCancelled?.()) throw new DeckExportCancelledError();
    const longest = Math.max(unitsToPx(slide.width), unitsToPx(slide.height)) * scale;
    const bounded =
      longest > DECK_MAX_RASTER_EDGE ? (scale * DECK_MAX_RASTER_EDGE) / longest : scale;
    const pixelWidth = Math.round(unitsToPx(slide.width) * bounded);
    const pixelHeight = Math.round(unitsToPx(slide.height) * bounded);
    const svg = renderSlideSvg(slide, {
      measurer: options.measurer,
      ...(options.resolveAsset ? { resolveAsset: options.resolveAsset } : {}),
      pixelWidth,
      pixelHeight,
    });
    pages.push({
      jpeg: await options.rasterize(svg, pixelWidth, pixelHeight),
      pixelWidth,
      pixelHeight,
      pointWidth: unitsToPoints(slide.width),
      pointHeight: unitsToPoints(slide.height),
    });
    options.onProgress?.(index + 1, slides.length);
  }
  return pages;
}

/** Renders the deck to a PDF with one page per visible slide, at the slide's physical size. */
export async function exportDeckToPdf(
  deck: DeckDocument,
  options: DeckImageExportOptions,
): Promise<Uint8Array> {
  return buildInkPdf(await renderDeckPages(deck, options));
}

/** The in-app rasterizer: SVG → bitmap → JPEG, with no DOM and no network. */
export const offscreenCanvasRasterizer: DeckRasterizer = async (svg, pixelWidth, pixelHeight) => {
  const bitmap = await createImageBitmap(new Blob([svg], { type: 'image/svg+xml' }));
  const canvas = new OffscreenCanvas(pixelWidth, pixelHeight);
  const context = canvas.getContext('2d');
  if (!context) {
    bitmap.close();
    throw new Error('The export canvas is not available in this runtime.');
  }
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, pixelWidth, pixelHeight);
  context.drawImage(bitmap, 0, 0, pixelWidth, pixelHeight);
  bitmap.close();
  const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.92 });
  return new Uint8Array(await blob.arrayBuffer());
};
