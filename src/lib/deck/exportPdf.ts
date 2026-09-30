/**
 * PDF and slide-image export.
 *
 * Output pages (`output.ts`) go SVG → raster → PDF page, with each page's
 * invisible text layer and links carried over (`pdf.ts`). Rasterizing is
 * injected: in the app it is an image drawn to a canvas; in tests it is a stub.
 *
 * Raster pages keep slides pixel-identical to the editor; the text layer keeps
 * the PDF searchable and selectable. That is the Phase 5 answer to the
 * contract's vector-or-raster decision.
 */
import type { DeckDocument } from '../../types/deck';
import type { DeckAssetRef } from '../../types/deck';

import { buildOutputPages } from './output';
import type { DeckOutputLayout, DeckOutputOptions, DeckOutputPage } from './output';
import { buildDeckPdf } from './pdf';
import type { DeckPdfPage } from './pdf';
import { resolveSlide } from './resolve';
import { renderSlideSvg } from './svg';
import type { DeckTextMeasurer } from './textLayout';
import { unitsToPx } from './units';

/** Turns one SVG into image bytes (JPEG unless the rasterizer says otherwise). */
export type DeckRasterizer = (
  svg: string,
  pixelWidth: number,
  pixelHeight: number,
) => Promise<Uint8Array>;

export interface DeckPdfExportOptions extends DeckOutputOptions {
  rasterize: DeckRasterizer;
  /** Raster pixels per point. 2.667 (192 dpi) keeps slide text sharp in print. */
  pixelsPerPoint?: number;
  isCancelled?: () => boolean;
  onProgress?: (completed: number, total: number) => void;
}

/** The longest raster edge any one page may request. */
export const DECK_MAX_RASTER_EDGE = 8_192;
export const DEFAULT_PIXELS_PER_POINT = 192 / 72;

export class DeckExportCancelledError extends Error {
  constructor() {
    super('Deck export was cancelled.');
    this.name = 'DeckExportCancelledError';
  }
}

/** Pixel size for a page of `width` x `height` points, bounded to the raster edge. */
export function rasterSize(
  width: number,
  height: number,
  pixelsPerPoint: number,
): { pixelWidth: number; pixelHeight: number } {
  const longest = Math.max(width, height) * pixelsPerPoint;
  const scale =
    longest > DECK_MAX_RASTER_EDGE
      ? (pixelsPerPoint * DECK_MAX_RASTER_EDGE) / longest
      : pixelsPerPoint;
  return {
    pixelWidth: Math.max(1, Math.round(width * scale)),
    pixelHeight: Math.max(1, Math.round(height * scale)),
  };
}

export async function rasterizeOutputPages(
  pages: readonly DeckOutputPage[],
  options: Pick<
    DeckPdfExportOptions,
    'rasterize' | 'pixelsPerPoint' | 'isCancelled' | 'onProgress'
  >,
): Promise<DeckPdfPage[]> {
  const out: DeckPdfPage[] = [];
  for (const [index, page] of pages.entries()) {
    if (options.isCancelled?.()) throw new DeckExportCancelledError();
    const { pixelWidth, pixelHeight } = rasterSize(
      page.width,
      page.height,
      options.pixelsPerPoint ?? DEFAULT_PIXELS_PER_POINT,
    );
    const jpeg = await options.rasterize(
      page.svg(pixelWidth, pixelHeight),
      pixelWidth,
      pixelHeight,
    );
    out.push({
      width: page.width,
      height: page.height,
      jpeg,
      pixelWidth,
      pixelHeight,
      text: page.text,
      links: page.links,
    });
    options.onProgress?.(index + 1, pages.length);
  }
  if (options.isCancelled?.()) throw new DeckExportCancelledError();
  return out;
}

/** Renders slides or handouts to a PDF with a text layer. */
export async function exportDeckPdf(
  deck: DeckDocument,
  layout: DeckOutputLayout,
  options: DeckPdfExportOptions,
): Promise<Uint8Array> {
  const pages = buildOutputPages(deck, layout, options);
  if (pages.length === 0) throw new Error('There are no slides to export.');
  return buildDeckPdf(await rasterizeOutputPages(pages, options), {
    ...(options.title ? { title: options.title } : {}),
  });
}

export interface DeckSlideImageOptions {
  measurer: DeckTextMeasurer;
  resolveAsset?: (asset: DeckAssetRef) => string | null;
  /** Output pixels per CSS pixel of the slide at 100%. */
  scale?: number;
}

/** One slide as a standalone SVG document at `scale`. */
export function slideSvgDocument(
  deck: DeckDocument,
  slideId: string,
  options: DeckSlideImageOptions,
): { svg: string; pixelWidth: number; pixelHeight: number } {
  const slide = resolveSlide(deck, slideId);
  const scale = options.scale ?? 1;
  const longest = Math.max(unitsToPx(slide.width), unitsToPx(slide.height)) * scale;
  const bounded = longest > DECK_MAX_RASTER_EDGE ? (scale * DECK_MAX_RASTER_EDGE) / longest : scale;
  const pixelWidth = Math.round(unitsToPx(slide.width) * bounded);
  const pixelHeight = Math.round(unitsToPx(slide.height) * bounded);
  const svg = renderSlideSvg(slide, {
    measurer: options.measurer,
    ...(options.resolveAsset ? { resolveAsset: options.resolveAsset } : {}),
    pixelWidth,
    pixelHeight,
  });
  return { svg, pixelWidth, pixelHeight };
}

/** Loads an SVG document as an image. `createImageBitmap` cannot decode SVG in Chromium. */
function loadSvgImage(svg: string): Promise<HTMLImageElement> {
  const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
  const image = new Image();
  return new Promise<HTMLImageElement>((resolve, reject) => {
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('A slide could not be drawn for export.'));
    image.src = url;
  }).finally(() => URL.revokeObjectURL(url));
}

async function canvasRaster(
  svg: string,
  pixelWidth: number,
  pixelHeight: number,
  type: 'image/jpeg' | 'image/png',
): Promise<Uint8Array> {
  const image = await loadSvgImage(svg);
  const canvas = document.createElement('canvas');
  canvas.width = pixelWidth;
  canvas.height = pixelHeight;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('The export canvas is not available in this runtime.');
  if (type === 'image/jpeg') {
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, pixelWidth, pixelHeight);
  }
  context.drawImage(image, 0, 0, pixelWidth, pixelHeight);
  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob(resolve, type, type === 'image/jpeg' ? 0.92 : undefined),
  );
  if (!blob) throw new Error('A slide could not be encoded for export.');
  return new Uint8Array(await blob.arrayBuffer());
}

/**
 * The in-app rasterizer: SVG → image → canvas → JPEG. The SVG is
 * self-contained (inline assets only), so nothing is fetched.
 */
export const canvasRasterizer: DeckRasterizer = (svg, pixelWidth, pixelHeight) =>
  canvasRaster(svg, pixelWidth, pixelHeight, 'image/jpeg');

/** SVG → PNG, for slide images. */
export const pngRasterizer: DeckRasterizer = (svg, pixelWidth, pixelHeight) =>
  canvasRaster(svg, pixelWidth, pixelHeight, 'image/png');
