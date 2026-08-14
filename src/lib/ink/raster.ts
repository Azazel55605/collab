/**
 * Raster export scene adapter.
 *
 * The sibling of `svg.ts`: both walk the authoritative scene and neither reads
 * back the editor's viewport. This module owns the part raster export needs and
 * vector export does not — deciding output pixel dimensions under a set of
 * bounds that can be enormous, and refusing an allocation that would take the
 * process down.
 *
 * Actually producing bytes needs a real canvas and belongs to the Phase 7
 * export job. What lives here is every decision that can be made without one,
 * so the job is a thin wrapper rather than the place the rules live.
 */

import type { InkBounds, InkPage, InkScene } from '../../types/ink';
import { paintPageBackground, paintScene } from './renderer';
import type { InkRenderOptions, InkRenderTarget } from './renderer';
import { sceneBounds } from './svg';
import { inkExportPalette, resolveInkColor } from './colors';

/**
 * Hard ceiling on an exported bitmap.
 *
 * 64 megapixels is above any reasonable print need and below the point where a
 * 4-bytes-per-pixel buffer (256 MiB here) threatens a mobile process. Browsers
 * also impose their own canvas-area limits well under this on some platforms,
 * so an export that passes here can still fail later — which is why the export
 * job reports failure rather than assuming success.
 */
export const INK_MAX_EXPORT_PIXELS = 64_000_000;
export const INK_MAX_EXPORT_EDGE = 16_384;

export interface InkRasterExportRequest {
  /** Region to export. Defaults to the scene's content bounds. */
  bounds?: InkBounds;
  /** Device pixels per ink unit before clamping. */
  scale?: number;
  /** Painted behind the content; omit for transparency. */
  background?: string;
  /** Include the page's ruled/grid/dotted pattern. */
  includePageBackground?: boolean;
  objectIds?: string[];
  /** Padding in ink units added around the bounds. */
  padding?: number;
}

export interface InkRasterPlan {
  bounds: InkBounds;
  /** Output size in device pixels. */
  width: number;
  height: number;
  /** The scale actually used, after clamping. */
  scale: number;
  /** Set when the requested scale had to be reduced to fit the ceiling. */
  clampedFrom?: number;
  bytes: number;
}

export class InkExportError extends Error {
  readonly code: 'empty' | 'too-large';

  constructor(code: 'empty' | 'too-large', message: string) {
    super(message);
    this.name = 'InkExportError';
    this.code = code;
  }
}

/**
 * Ink units per device pixel at 100%: 1 px is 0.75 pt is 48 ink units.
 * A scale of 1 therefore means "one device pixel per screen pixel at 100% zoom".
 */
export const INK_UNITS_PER_EXPORT_PIXEL = 48;

/**
 * Decides the output size for a raster export.
 *
 * Reduces the scale rather than throwing when the request is merely ambitious —
 * a user asking for 8x on a big page wants the biggest image they can have, not
 * an error. It throws only when even 1:1 cannot fit, which means the region
 * itself is impossible.
 */
export function planRasterExport(
  scene: InkScene,
  request: InkRasterExportRequest = {},
): InkRasterPlan {
  const padding = Math.max(0, request.padding ?? 0);
  const source = request.bounds ?? sceneBounds(scene);
  const bounds: InkBounds = {
    minX: source.minX - padding,
    minY: source.minY - padding,
    maxX: source.maxX + padding,
    maxY: source.maxY + padding,
  };

  const unitWidth = bounds.maxX - bounds.minX;
  const unitHeight = bounds.maxY - bounds.minY;
  if (unitWidth <= 0 || unitHeight <= 0) {
    throw new InkExportError('empty', 'Nothing to export: the region has no area');
  }

  const requested = request.scale && request.scale > 0 ? request.scale : 1;
  const basePixelWidth = unitWidth / INK_UNITS_PER_EXPORT_PIXEL;
  const basePixelHeight = unitHeight / INK_UNITS_PER_EXPORT_PIXEL;

  if (
    basePixelWidth > INK_MAX_EXPORT_EDGE ||
    basePixelHeight > INK_MAX_EXPORT_EDGE ||
    basePixelWidth * basePixelHeight > INK_MAX_EXPORT_PIXELS
  ) {
    throw new InkExportError(
      'too-large',
      `Region is too large to export: ${Math.round(basePixelWidth)}x${Math.round(
        basePixelHeight,
      )} pixels at 1:1 exceeds the export ceiling`,
    );
  }

  const maxByEdge = Math.min(
    INK_MAX_EXPORT_EDGE / basePixelWidth,
    INK_MAX_EXPORT_EDGE / basePixelHeight,
  );
  const maxByArea = Math.sqrt(INK_MAX_EXPORT_PIXELS / (basePixelWidth * basePixelHeight));
  const scale = Math.min(requested, maxByEdge, maxByArea);

  const width = Math.max(1, Math.floor(basePixelWidth * scale));
  const height = Math.max(1, Math.floor(basePixelHeight * scale));

  return {
    bounds,
    width,
    height,
    scale,
    ...(scale < requested ? { clampedFrom: requested } : {}),
    bytes: width * height * 4,
  };
}

/**
 * Paints a planned export onto a target.
 *
 * The target is supplied already sized to `plan.width` x `plan.height`; this
 * sets up the transform and draws. Splitting the plan from the paint is what
 * lets the size be validated, reported, and cancelled before any allocation.
 */
export function paintRasterExport(
  target: InkRenderTarget,
  scene: InkScene,
  plan: InkRasterPlan,
  request: InkRasterExportRequest = {},
  page?: InkPage,
  options: InkRenderOptions = {},
): void {
  const pixelsPerUnit = plan.width / (plan.bounds.maxX - plan.bounds.minX);

  target.save();
  target.setTransform(1, 0, 0, 1, 0, 0);
  target.clearRect(0, 0, plan.width, plan.height);
  const exportSurface = request.background
    ?? (request.includePageBackground ? page?.background.color : undefined);
  const colors = options.colors ?? inkExportPalette(exportSurface);
  if (request.background) {
    target.fillStyle = resolveInkColor(request.background, colors);
    target.fillRect(0, 0, plan.width, plan.height);
  }
  target.scale(pixelsPerUnit, pixelsPerUnit);
  target.translate(-plan.bounds.minX, -plan.bounds.minY);

  if (page && request.includePageBackground) {
    paintPageBackground(target, page, plan.bounds, colors);
  }
  paintScene(target, scene, plan.bounds, {
    ...options,
    colors,
    // Export honours per-layer export exclusion; the screen does not.
    includeNonExported: false,
    ...(request.objectIds ? { objectIds: request.objectIds } : {}),
  });
  target.restore();
}

/** Bounds of a whole fixed page, for a page export. */
export function pageExportBounds(page: InkPage): InkBounds {
  if (page.mode === 'fixed') {
    return { minX: 0, minY: 0, maxX: page.width, maxY: page.height };
  }
  // An infinite page has no edges, so its export is bounded by its content.
  return sceneBounds(page.scene);
}
