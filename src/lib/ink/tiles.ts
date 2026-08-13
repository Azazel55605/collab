/**
 * The renderer-free half of tiled ink rendering.
 *
 * The editor paints ink into a grid of cached canvas tiles. This module owns
 * every decision about that grid — which tiles a viewport needs, which tiles an
 * edit dirtied, which tiles to evict under memory pressure — with no canvas,
 * no DOM, and no React, so all of it is testable and none of it is duplicated
 * between desktop and mobile.
 *
 * The thing this exists to prevent: repainting the whole page on every stroke.
 * A page holding ten thousand strokes cannot be redrawn between two pointer
 * events, so an edit must repaint only the tiles its bounds touch.
 */

import { INK_LIMITS } from '../../types/ink';
import type { InkBounds } from '../../types/ink';

/** Tile edge in ink units. 8192 units is 128 pt, ~171 CSS px at 100% zoom. */
export const INK_TILE_SIZE = 8_192;

/** Device pixels a cached tile may occupy on its longest edge. */
export const INK_TILE_MAX_PIXELS = 512;

/**
 * Total cached tile bytes before eviction begins.
 *
 * 96 MiB at 4 bytes per pixel is roughly 96 tiles at full 512x512 resolution —
 * enough for several screens of context around the viewport on a desktop, and
 * the point at which a low-memory Android device should start dropping tiles it
 * can regenerate from vector data.
 */
export const INK_TILE_CACHE_BUDGET_BYTES = 96 * 1024 * 1024;

export interface InkTileKey {
  col: number;
  row: number;
}

export interface InkViewport {
  /** Top-left of the visible region, in ink units. */
  x: number;
  y: number;
  /** Visible size in ink units (CSS size divided by zoom). */
  width: number;
  height: number;
  zoom: number;
}

export function tileId(key: InkTileKey): string {
  return `${key.col}:${key.row}`;
}

/** Ink-unit bounds of a tile. */
export function tileBounds(key: InkTileKey, tileSize = INK_TILE_SIZE): InkBounds {
  return {
    minX: key.col * tileSize,
    minY: key.row * tileSize,
    maxX: (key.col + 1) * tileSize,
    maxY: (key.row + 1) * tileSize,
  };
}

function floorDiv(value: number, divisor: number): number {
  return Math.floor(value / divisor);
}

/**
 * Tiles overlapping a bounds rectangle.
 *
 * Returned in row-major order so painting follows a predictable path and two
 * callers computing the same region get the same list.
 */
export function tilesForBounds(
  bounds: InkBounds,
  tileSize = INK_TILE_SIZE,
): InkTileKey[] {
  if (bounds.maxX < bounds.minX || bounds.maxY < bounds.minY) return [];
  const firstCol = floorDiv(bounds.minX, tileSize);
  const lastCol = floorDiv(bounds.maxX, tileSize);
  const firstRow = floorDiv(bounds.minY, tileSize);
  const lastRow = floorDiv(bounds.maxY, tileSize);

  const keys: InkTileKey[] = [];
  for (let row = firstRow; row <= lastRow; row += 1) {
    for (let col = firstCol; col <= lastCol; col += 1) {
      keys.push({ col, row });
    }
  }
  return keys;
}

/**
 * Tiles a viewport needs, including an overscan ring.
 *
 * The ring is what makes panning smooth: the tile about to scroll into view is
 * already rendered. One ring is the right size — two quadruples the work for a
 * gesture the user can outrun anyway.
 */
export function tilesForViewport(
  viewport: InkViewport,
  overscanTiles = 1,
  tileSize = INK_TILE_SIZE,
): InkTileKey[] {
  const margin = overscanTiles * tileSize;
  return tilesForBounds(
    {
      minX: viewport.x - margin,
      minY: viewport.y - margin,
      maxX: viewport.x + viewport.width + margin,
      maxY: viewport.y + viewport.height + margin,
    },
    tileSize,
  );
}

/**
 * Device-pixel size of a tile at a given zoom and device pixel ratio.
 *
 * Capped at `INK_TILE_MAX_PIXELS`: past that, a deep zoom would allocate
 * unboundedly large backing stores. The renderer draws the capped tile scaled
 * up and refines it from vector data, which is why the cap is a memory bound
 * rather than a quality ceiling.
 */
export function tilePixelSize(
  zoom: number,
  devicePixelRatio = 1,
  tileSize = INK_TILE_SIZE,
): number {
  const clampedZoom = Math.min(Math.max(zoom, INK_LIMITS.minZoom), INK_LIMITS.maxZoom);
  const ideal = (tileSize / 64) * 0.75 * clampedZoom * devicePixelRatio;
  return Math.max(1, Math.min(INK_TILE_MAX_PIXELS, Math.ceil(ideal)));
}

export function tileBytes(pixelSize: number): number {
  return pixelSize * pixelSize * 4;
}

export interface InkTileCacheEntry {
  key: InkTileKey;
  pixelSize: number;
  /** Monotonic counter, not a clock — tests and replays must be reproducible. */
  lastUsed: number;
}

/**
 * Which cached tiles to drop to get back under budget.
 *
 * Least-recently-used, with tiles the viewport currently needs exempt. Evicting
 * a visible tile only forces an immediate repaint, so a cache that does it is
 * worse than one that briefly exceeds its budget.
 */
export function tilesToEvict(
  entries: InkTileCacheEntry[],
  visible: InkTileKey[],
  budgetBytes = INK_TILE_CACHE_BUDGET_BYTES,
): InkTileKey[] {
  let total = 0;
  for (const entry of entries) total += tileBytes(entry.pixelSize);
  if (total <= budgetBytes) return [];

  const visibleIds = new Set(visible.map(tileId));
  const candidates = entries
    .filter((entry) => !visibleIds.has(tileId(entry.key)))
    .sort((left, right) => left.lastUsed - right.lastUsed);

  const evicted: InkTileKey[] = [];
  for (const entry of candidates) {
    if (total <= budgetBytes) break;
    total -= tileBytes(entry.pixelSize);
    evicted.push(entry.key);
  }
  return evicted;
}

/**
 * Accumulates the tiles an editing session dirtied.
 *
 * An edit reports the bounds it affected — for a move or a restyle, both the
 * old and the new bounds, since the tiles the object vacated need repainting
 * too. Forgetting the old bounds is what leaves a ghost of the object behind.
 */
export class InkDirtyTiles {
  private readonly dirty = new Set<string>();

  constructor(private readonly tileSize: number = INK_TILE_SIZE) {}

  markBounds(bounds: InkBounds): void {
    for (const key of tilesForBounds(bounds, this.tileSize)) {
      this.dirty.add(tileId(key));
    }
  }

  /** Marks both the region an object left and the one it now occupies. */
  markMoved(before: InkBounds, after: InkBounds): void {
    this.markBounds(before);
    this.markBounds(after);
  }

  get size(): number {
    return this.dirty.size;
  }

  has(key: InkTileKey): boolean {
    return this.dirty.has(tileId(key));
  }

  /** Dirty tiles the viewport can see, in paint order. */
  take(visible: InkTileKey[]): InkTileKey[] {
    const repaint = visible.filter((key) => this.dirty.has(tileId(key)));
    for (const key of repaint) this.dirty.delete(tileId(key));
    return repaint;
  }

  clear(): void {
    this.dirty.clear();
  }
}
