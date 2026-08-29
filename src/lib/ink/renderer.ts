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
  InkDashStyle,
  InkLayer,
  InkObject,
  InkPage,
  InkScene,
  InkStroke,
} from '../../types/ink';

import { stampGlyph } from './advancedTools';
import { decodeSamples } from './codec';
import { INK_LIGHT_PALETTE, resolveInkColor } from './colors';
import type { InkColorPalette } from './colors';
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
  rotate(angle: number): void;
  clearRect(x: number, y: number, width: number, height: number): void;
  fillRect(x: number, y: number, width: number, height: number): void;
  beginPath(): void;
  moveTo(x: number, y: number): void;
  lineTo(x: number, y: number): void;
  closePath(): void;
  fill(): void;
  stroke(): void;
  fillText(text: string, x: number, y: number): void;
  setLineDash?(segments: number[]): void;
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
  /** Paint equation source as plain text when no rich KaTeX overlay exists. */
  paintEquationFallback?: boolean;
  /** Concrete colours used to resolve semantic `ink:*` document colours. */
  colors?: InkColorPalette;
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
  colors: InkColorPalette,
): void {
  const outline = outliner(decodeSamples(stroke.samples), stroke.brush);
  if (outline.length === 0) return;
  target.fillStyle = resolveInkColor(stroke.brush.color, colors);
  target.globalAlpha = stroke.brush.opacity;
  fillOutline(target, outline);
  target.globalAlpha = 1;
}

function paintObject(
  target: InkRenderTarget,
  object: InkObject,
  outliner: InkStrokeOutliner,
  options: InkRenderOptions,
): void {
  const colors = options.colors ?? INK_LIGHT_PALETTE;
  if ((object.type === 'text' || object.type === 'stamp') && object.rotation) {
    const centerX = object.x + object.width / 2;
    const centerY = object.y + object.height / 2;
    target.save();
    target.translate(centerX, centerY);
    target.rotate(object.rotation);
    target.translate(-centerX, -centerY);
    paintObject(target, { ...object, rotation: 0 }, outliner, options);
    target.restore();
    return;
  }
  switch (object.type) {
    case 'stroke':
      paintStroke(target, object, outliner, colors);
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
        target.fillStyle = resolveInkColor(object.fill, colors);
        target.globalAlpha = object.fillOpacity ?? 1;
        target.fill();
        target.globalAlpha = 1;
      }
      const strokeColor = resolveInkColor(object.stroke.color, colors);
      target.strokeStyle = strokeColor;
      target.lineWidth = object.stroke.width;
      applyDash(target, object.stroke.dash, object.stroke.width);
      target.globalAlpha = object.stroke.opacity;
      target.stroke();
      paintArrowheads(target, object.points, object.arrowStart, object.arrowEnd, {
        ...object.stroke,
        color: strokeColor,
      });
      applyDash(target, 'solid', object.stroke.width);
      target.globalAlpha = 1;
      break;
    }
    case 'connector': {
      const points = connectorPoints(object);
      target.beginPath();
      target.moveTo(points[0], points[1]);
      for (let index = 2; index + 1 < points.length; index += 2) {
        target.lineTo(points[index], points[index + 1]);
      }
      const strokeColor = resolveInkColor(object.stroke.color, colors);
      target.strokeStyle = strokeColor;
      target.lineWidth = object.stroke.width;
      target.globalAlpha = object.stroke.opacity;
      applyDash(target, object.stroke.dash, object.stroke.width);
      target.stroke();
      paintArrowheads(target, points, object.arrowStart, object.arrowEnd, {
        ...object.stroke,
        color: strokeColor,
      });
      applyDash(target, 'solid', object.stroke.width);
      target.globalAlpha = 1;
      break;
    }
    case 'text': {
      if (object.equation && options.paintEquationFallback === false) break;
      if (object.sticky || object.backgroundColor) {
        target.fillStyle = resolveInkColor(object.backgroundColor ?? '#fef3a7', colors);
        target.fillRect(object.x, object.y, object.width, object.height);
      }
      target.fillStyle = resolveInkColor(object.color, colors);
      target.font = `${object.fontSize}px ${object.fontFamily ?? 'sans-serif'}`;
      const inset = object.sticky ? Math.max(32, object.fontSize * 0.35) : 0;
      object.text.split('\n').forEach((line, index) => {
        target.fillText(line, object.x + inset, object.y + inset + object.fontSize * (index + 1));
      });
      break;
    }
    case 'stamp': {
      target.fillStyle = resolveInkColor(object.color ?? 'ink:foreground', colors);
      target.font = `${Math.max(1, object.height)}px sans-serif`;
      target.fillText(stampGlyph(object.symbolId), object.x, object.y + object.height);
      break;
    }
    default:
      // Images, stamps, connectors, and groups need asset loading or Phase 5
      // editors. Painting a placeholder would be worse than painting nothing.
      break;
  }
}

function applyDash(target: InkRenderTarget, dash: InkDashStyle | undefined, width: number): void {
  if (!target.setLineDash) return;
  target.setLineDash(
    dash === 'dashed' ? [width * 4, width * 3] : dash === 'dotted' ? [width, width * 2] : [],
  );
}

function connectorPoints(object: Extract<InkObject, { type: 'connector' }>): number[] {
  if (object.routing === 'orthogonal') {
    const midX = Math.round((object.from.x + object.to.x) / 2);
    return [
      object.from.x,
      object.from.y,
      midX,
      object.from.y,
      midX,
      object.to.y,
      object.to.x,
      object.to.y,
    ];
  }
  return [object.from.x, object.from.y, object.to.x, object.to.y];
}

function paintArrowheads(
  target: InkRenderTarget,
  points: number[],
  start: Extract<InkObject, { type: 'shape' }>['arrowStart'],
  end: Extract<InkObject, { type: 'shape' }>['arrowEnd'],
  stroke: Extract<InkObject, { type: 'shape' }>['stroke'],
): void {
  if (points.length < 4) return;
  if (start && start !== 'none') {
    paintArrowhead(target, points[0], points[1], points[2], points[3], start, stroke);
  }
  if (end && end !== 'none') {
    const last = points.length - 2;
    paintArrowhead(
      target,
      points[last],
      points[last + 1],
      points[last - 2],
      points[last - 1],
      end,
      stroke,
    );
  }
}

function paintArrowhead(
  target: InkRenderTarget,
  x: number,
  y: number,
  previousX: number,
  previousY: number,
  kind: 'arrow' | 'open' | 'dot',
  stroke: Extract<InkObject, { type: 'shape' }>['stroke'],
): void {
  const angle = Math.atan2(y - previousY, x - previousX);
  const size = Math.max(stroke.width * 4, 160);
  target.fillStyle = stroke.color;
  target.strokeStyle = stroke.color;
  if (kind === 'dot') {
    const segments = 12;
    target.beginPath();
    for (let index = 0; index < segments; index += 1) {
      const theta = (index / segments) * Math.PI * 2;
      const px = x + Math.cos(theta) * size * 0.45;
      const py = y + Math.sin(theta) * size * 0.45;
      if (index === 0) target.moveTo(px, py);
      else target.lineTo(px, py);
    }
    target.closePath();
    target.fill();
    return;
  }
  const leftX = x - Math.cos(angle - Math.PI / 6) * size;
  const leftY = y - Math.sin(angle - Math.PI / 6) * size;
  const rightX = x - Math.cos(angle + Math.PI / 6) * size;
  const rightY = y - Math.sin(angle + Math.PI / 6) * size;
  target.beginPath();
  target.moveTo(leftX, leftY);
  target.lineTo(x, y);
  target.lineTo(rightX, rightY);
  if (kind === 'arrow') {
    target.closePath();
    target.fill();
  } else {
    target.stroke();
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
    if (object.type === 'shape' && object.guide && !options.includeNonExported) continue;
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
    paintObject(target, object, outliner, options);
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
  colors: InkColorPalette = INK_LIGHT_PALETTE,
): void {
  const background = page.background;
  if (background.color) {
    target.fillStyle = resolveInkColor(background.color, colors);
    target.fillRect(region.minX, region.minY, region.maxX - region.minX, region.maxY - region.minY);
  }
  if (background.pattern === 'blank') return;

  const spacing = background.spacing && background.spacing > 0 ? background.spacing : 1_600;
  const lineColor = background.lineColor
    ? resolveInkColor(background.lineColor, colors)
    : colors.grid;
  target.strokeStyle = lineColor;
  target.lineWidth = 8;
  target.fillStyle = lineColor;

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
  if (background.pattern === 'staff') {
    const staffGap = Math.max(64, Math.round(spacing / 4));
    const staffStride = staffGap * 8;
    const firstStaffY = Math.floor(region.minY / staffStride) * staffStride;
    for (let startY = firstStaffY; startY <= region.maxY; startY += staffStride) {
      for (let line = 0; line < 5; line += 1) {
        const y = startY + line * staffGap;
        target.beginPath();
        target.moveTo(region.minX, y);
        target.lineTo(region.maxX, y);
        target.stroke();
      }
    }
  }
  if (background.pattern === 'storyboard') {
    const columnWidth = Math.max(spacing * 4, 3_200);
    const rowHeight = Math.max(spacing * 3, 2_400);
    const firstColumn = Math.floor(region.minX / columnWidth) * columnWidth;
    const firstRow = Math.floor(region.minY / rowHeight) * rowHeight;
    for (let y = firstRow; y <= region.maxY; y += rowHeight) {
      for (let x = firstColumn; x <= region.maxX; x += columnWidth) {
        target.beginPath();
        target.moveTo(x + 96, y + 96);
        target.lineTo(x + columnWidth - 96, y + 96);
        target.lineTo(x + columnWidth - 96, y + rowHeight - 96);
        target.lineTo(x + 96, y + rowHeight - 96);
        target.closePath();
        target.stroke();
      }
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

  /** Theme changes alter semantic colours without changing scene identity. */
  setRenderOptions(render: InkRenderOptions): void {
    this.options.render = render;
    this.invalidateAll();
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
    if (page) paintPageBackground(target, page, bounds, this.options.render?.colors);
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
