/**
 * The shared ink scene renderer and its tile cache.
 *
 * Drawing is expressed against `InkRenderTarget`, a deliberately tiny subset of
 * `CanvasRenderingContext2D`. That is not indirection for its own sake: it
 * makes the paint path testable without a real canvas, lets the same code paint
 * a screen tile, an export bitmap, or a page thumbnail, and keeps jsdom — which
 * has no canvas — able to verify *what* would be drawn.
 *
 * The cache is the reason a dense page stays interactive. Phase 0 measured a
 * viewport repaint at 31 ms against 2.5 ms for one tile on a 10,000-stroke
 * page, so the renderer repaints tiles, never the viewport.
 */

import type {
  InkBounds,
  InkLayer,
  InkObject,
  InkPage,
  InkScene,
  InkStroke,
} from '../../types/ink';
import { decodeSamples } from './codec';
import { outlineStroke } from './stroke';
import type { InkPoint, InkStrokeOutliner } from './stroke';
import { objectBounds } from './svg';
import {
  INK_TILE_CACHE_BUDGET_BYTES,
  INK_TILE_SIZE,
  tileBounds,
  tileBytes,
  tileId,
  tilePixelSize,
  tilesForBounds,
  tilesForViewport,
  tilesToEvict,
} from './tiles';
import type { InkTileCacheEntry, InkTileKey, InkViewport } from './tiles';

/** The drawing surface the renderer needs. A 2D canvas context satisfies it. */
export interface InkRenderTarget {
  save(): void;
  restore(): void;
  setTransform(a: number, b: number, c: number, d: number, e: number, f: number): void;
  translate(x: number, y: number): void;
  scale(x: number, y: number): void;
  clearRect(x: number, y: number, width: number, height: number): void;
  fillRect(x: number, y: number, width: number, height: number): void;
  beginPath(): void;
  moveTo(x: number, y: number): void;
  lineTo(x: number, y: number): void;
  closePath(): void;
  fill(): void;
  stroke(): void;
  fillText(text: string, x: number, y: number): void;
  fillStyle: string;
  strokeStyle: string;
  lineWidth: number;
  globalAlpha: number;
  font: string;
}

export interface InkRenderOptions {
  outliner?: InkStrokeOutliner;
  /** Restrict painting to these objects. */
  objectIds?: string[];
  /** Paint layers marked `exported: false`. True on screen, false on export. */
  includeNonExported?: boolean;
  /** Skip hidden layers. Defaults to true. */
  respectVisibility?: boolean;
}

function layerPaints(layer: InkLayer | undefined, options: InkRenderOptions): boolean {
  if (!layer) return true;
  if (options.respectVisibility !== false && !layer.visible) return false;
  if (!options.includeNonExported && layer.exported === false) return false;
  return true;
}

function fillOutline(target: InkRenderTarget, outline: InkPoint[]): void {
  if (outline.length < 3) return;
  target.beginPath();
  target.moveTo(outline[0].x, outline[0].y);
  for (let index = 1; index < outline.length; index += 1) {
    target.lineTo(outline[index].x, outline[index].y);
  }
  target.closePath();
  target.fill();
}

function paintStroke(
  target: InkRenderTarget,
  stroke: InkStroke,
  outliner: InkStrokeOutliner,
): void {
  const outline = outliner(decodeSamples(stroke.samples), stroke.brush);
  if (outline.length === 0) return;
  target.fillStyle = stroke.brush.color;
  target.globalAlpha = stroke.brush.opacity;
  fillOutline(target, outline);
  target.globalAlpha = 1;
}

function paintObject(
  target: InkRenderTarget,
  object: InkObject,
  outliner: InkStrokeOutliner,
): void {
  switch (object.type) {
    case 'stroke':
      paintStroke(target, object, outliner);
      break;
    case 'shape': {
      if (object.points.length < 4) return;
      target.beginPath();
      target.moveTo(object.points[0], object.points[1]);
      for (let index = 2; index + 1 < object.points.length; index += 2) {
        target.lineTo(object.points[index], object.points[index + 1]);
      }
      const closed =
        object.shape !== 'line' && object.shape !== 'polyline' && object.shape !== 'arc';
      if (closed) target.closePath();
      if (closed && object.fill) {
        target.fillStyle = object.fill;
        target.globalAlpha = object.fillOpacity ?? 1;
        target.fill();
        target.globalAlpha = 1;
      }
      target.strokeStyle = object.stroke.color;
      target.lineWidth = object.stroke.width;
      target.globalAlpha = object.stroke.opacity;
      target.stroke();
      target.globalAlpha = 1;
      break;
    }
    case 'text':
      target.fillStyle = object.color;
      target.font = `${object.fontSize}px ${object.fontFamily ?? 'sans-serif'}`;
      target.fillText(object.text, object.x, object.y + object.fontSize);
      break;
    default:
      // Images, stamps, connectors, and groups need asset loading or Phase 5
      // editors. Painting a placeholder would be worse than painting nothing.
      break;
  }
}

/**
 * Paints the part of a scene falling inside `region`, in document coordinates.
 *
 * The caller has already set up the transform, so this function works purely in
 * ink units. It skips objects whose bounds miss the region — the check that
 * makes a tile repaint cost a tile's worth of work rather than a page's.
 */
export function paintScene(
  target: InkRenderTarget,
  scene: InkScene,
  region: InkBounds,
  options: InkRenderOptions = {},
): number {
  const outliner = options.outliner ?? outlineStroke;
  const only = options.objectIds ? new Set(options.objectIds) : null;
  let painted = 0;

  // Paint order is document data, so walk objectOrder — never the object map.
  for (const id of scene.objectOrder) {
    const object = scene.objects[id];
    if (!object) continue;
    if (only && !only.has(id)) continue;
    if (!layerPaints(scene.layers[object.layerId], options)) continue;

    const bounds = objectBounds(object);
    if (bounds && !overlaps(bounds, region)) continue;

    const layer = scene.layers[object.layerId];
    const layerOpacity = layer?.opacity ?? 1;
    if (layerOpacity < 1) {
      target.save();
      target.globalAlpha = layerOpacity;
    }
    paintObject(target, object, outliner);
    if (layerOpacity < 1) target.restore();
    painted += 1;
  }
  return painted;
}

function overlaps(left: InkBounds, right: InkBounds): boolean {
  return !(
    left.maxX < right.minX ||
    left.minX > right.maxX ||
    left.maxY < right.minY ||
    left.minY > right.maxY
  );
}

/** Paints a page background pattern into a region, in document coordinates. */
export function paintPageBackground(
  target: InkRenderTarget,
  page: InkPage,
  region: InkBounds,
): void {
  const background = page.background;
  if (background.color) {
    target.fillStyle = background.color;
    target.fillRect(
      region.minX,
      region.minY,
      region.maxX - region.minX,
      region.maxY - region.minY,
    );
  }
  if (background.pattern === 'blank') return;

  const spacing = background.spacing && background.spacing > 0 ? background.spacing : 1_600;
  target.strokeStyle = background.lineColor ?? '#c9d1dc';
  target.lineWidth = 8;
  target.fillStyle = background.lineColor ?? '#c9d1dc';

  const firstY = Math.ceil(region.minY / spacing) * spacing;
  const firstX = Math.ceil(region.minX / spacing) * spacing;

  if (background.pattern === 'ruled' || background.pattern === 'grid') {
    for (let y = firstY; y <= region.maxY; y += spacing) {
      target.beginPath();
      target.moveTo(region.minX, y);
      target.lineTo(region.maxX, y);
      target.stroke();
    }
  }
  if (background.pattern === 'grid') {
    for (let x = firstX; x <= region.maxX; x += spacing) {
      target.beginPath();
      target.moveTo(x, region.minY);
      target.lineTo(x, region.maxY);
      target.stroke();
    }
  }
  if (background.pattern === 'dotted') {
    for (let y = firstY; y <= region.maxY; y += spacing) {
      for (let x = firstX; x <= region.maxX; x += spacing) {
        target.fillRect(x - 8, y - 8, 16, 16);
      }
    }
  }
}

/* -------------------------------------------------------------------------
 * Tile cache
 * ---------------------------------------------------------------------- */

/** Creates and disposes the backing surfaces the cache stores. */
export interface InkTileSurfaceFactory<S> {
  create(pixelSize: number): { surface: S; target: InkRenderTarget };
  dispose?(surface: S): void;
}

interface CachedTile<S> {
  key: InkTileKey;
  surface: S;
  target: InkRenderTarget;
  pixelSize: number;
  lastUsed: number;
}

export interface InkTileRenderResult<S> {
  key: InkTileKey;
  surface: S;
  /** Ink-unit region this surface covers. */
  bounds: InkBounds;
  pixelSize: number;
  /** False when the tile was served from cache. */
  repainted: boolean;
}

/**
 * Renders a scene through a cache of tile surfaces.
 *
 * Generic over the surface type so the same cache serves an
 * `OffscreenCanvas`, an `HTMLCanvasElement`, or a test double.
 */
export class InkTileRenderer<S> {
  private readonly tiles = new Map<string, CachedTile<S>>();
  private clock = 0;
  private cachedBytes = 0;

  constructor(
    private readonly factory: InkTileSurfaceFactory<S>,
    private readonly options: {
      tileSize?: number;
      budgetBytes?: number;
      render?: InkRenderOptions;
    } = {},
  ) {}

  private get tileSize(): number {
    return this.options.tileSize ?? INK_TILE_SIZE;
  }

  get cachedTileCount(): number {
    return this.tiles.size;
  }

  get cachedByteEstimate(): number {
    return this.cachedBytes;
  }

  /** Discards a tile so the next request repaints it. */
  invalidate(key: InkTileKey): void {
    const id = tileId(key);
    const tile = this.tiles.get(id);
    if (!tile) return;
    this.cachedBytes -= tileBytes(tile.pixelSize);
    this.factory.dispose?.(tile.surface);
    this.tiles.delete(id);
  }

  /** Discards every tile a bounds rectangle touches. */
  invalidateBounds(bounds: InkBounds): void {
    for (const key of tilesForBounds(bounds, this.tileSize)) this.invalidate(key);
  }

  /** Discards the tiles an object vacated and the ones it now occupies. */
  invalidateMoved(before: InkBounds, after: InkBounds): void {
    this.invalidateBounds(before);
    this.invalidateBounds(after);
  }

  invalidateAll(): void {
    for (const tile of this.tiles.values()) this.factory.dispose?.(tile.surface);
    this.tiles.clear();
    this.cachedBytes = 0;
  }

  /**
   * Renders every tile a viewport needs, painting only the ones not cached.
   *
   * Eviction runs after painting and never touches a tile the viewport needs —
   * evicting a visible tile only forces an immediate repaint.
   */
  renderViewport(
    scene: InkScene,
    viewport: InkViewport,
    page?: InkPage,
    devicePixelRatio = 1,
  ): Array<InkTileRenderResult<S>> {
    const keys = tilesForViewport(viewport, 1, this.tileSize);
    const pixelSize = tilePixelSize(viewport.zoom, devicePixelRatio, this.tileSize);
    const results = keys.map((key) => this.renderTile(scene, key, pixelSize, page));
    this.evict(keys);
    return results;
  }

  private renderTile(
    scene: InkScene,
    key: InkTileKey,
    pixelSize: number,
    page?: InkPage,
  ): InkTileRenderResult<S> {
    const id = tileId(key);
    const bounds = tileBounds(key, this.tileSize);
    this.clock += 1;

    const cached = this.tiles.get(id);
    // A zoom change alters the pixel size, so a tile cached at another zoom is
    // the wrong resolution and has to be repainted rather than scaled.
    if (cached && cached.pixelSize === pixelSize) {
      cached.lastUsed = this.clock;
      return { key, surface: cached.surface, bounds, pixelSize, repainted: false };
    }
    if (cached) this.invalidate(key);

    const { surface, target } = this.factory.create(pixelSize);
    const scale = pixelSize / this.tileSize;

    target.save();
    target.setTransform(1, 0, 0, 1, 0, 0);
    target.clearRect(0, 0, pixelSize, pixelSize);
    target.scale(scale, scale);
    target.translate(-bounds.minX, -bounds.minY);
    if (page) paintPageBackground(target, page, bounds);
    paintScene(target, scene, bounds, this.options.render);
    target.restore();

    this.tiles.set(id, { key, surface, target, pixelSize, lastUsed: this.clock });
    this.cachedBytes += tileBytes(pixelSize);

    return { key, surface, bounds, pixelSize, repainted: true };
  }

  private evict(visible: InkTileKey[]): void {
    const entries: InkTileCacheEntry[] = [...this.tiles.values()].map((tile) => ({
      key: tile.key,
      pixelSize: tile.pixelSize,
      lastUsed: tile.lastUsed,
    }));
    const budget = this.options.budgetBytes ?? INK_TILE_CACHE_BUDGET_BYTES;
    for (const key of tilesToEvict(entries, visible, budget)) this.invalidate(key);
  }
}
