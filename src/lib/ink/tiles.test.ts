import { describe, expect, it } from 'vitest';

import { INK_LIMITS } from '../../types/ink';
import {
  INK_TILE_MAX_PIXELS,
  INK_TILE_SIZE,
  InkDirtyTiles,
  tileBounds,
  tileBytes,
  tileId,
  tilePixelSize,
  tilesForBounds,
  tilesForViewport,
  tilesToEvict,
} from './tiles';
import type { InkTileCacheEntry } from './tiles';

describe('tilesForBounds', () => {
  it('returns the single tile a small stroke sits in', () => {
    expect(tilesForBounds({ minX: 10, minY: 10, maxX: 200, maxY: 200 })).toEqual([
      { col: 0, row: 0 },
    ]);
  });

  it('returns every tile a stroke crosses', () => {
    const tiles = tilesForBounds({
      minX: INK_TILE_SIZE - 10,
      minY: INK_TILE_SIZE - 10,
      maxX: INK_TILE_SIZE + 10,
      maxY: INK_TILE_SIZE + 10,
    });
    expect(tiles).toHaveLength(4);
  });

  it('handles negative coordinates, which an infinite canvas has', () => {
    // Truncating division would put -1 and +1 in the same tile and leave a
    // stripe of the canvas unrepaintable.
    expect(tilesForBounds({ minX: -10, minY: -10, maxX: -5, maxY: -5 })).toEqual([
      { col: -1, row: -1 },
    ]);
  });

  it('is empty for inverted bounds', () => {
    expect(tilesForBounds({ minX: 100, minY: 100, maxX: 0, maxY: 0 })).toEqual([]);
  });

  it('agrees with tileBounds', () => {
    const key = { col: 3, row: -2 };
    const bounds = tileBounds(key);
    expect(tilesForBounds({ ...bounds, maxX: bounds.maxX - 1, maxY: bounds.maxY - 1 })).toEqual([
      key,
    ]);
  });
});

describe('tilesForViewport', () => {
  it('includes an overscan ring around the visible region', () => {
    const viewport = { x: 0, y: 0, width: INK_TILE_SIZE, height: INK_TILE_SIZE, zoom: 1 };
    const without = tilesForViewport(viewport, 0);
    const withRing = tilesForViewport(viewport, 1);
    expect(withRing.length).toBeGreaterThan(without.length);
    expect(withRing).toContainEqual({ col: -1, row: -1 });
  });
});

describe('tilePixelSize', () => {
  it('grows with zoom and device pixel ratio', () => {
    expect(tilePixelSize(2, 1)).toBeGreaterThan(tilePixelSize(1, 1));
    expect(tilePixelSize(1, 2)).toBeGreaterThan(tilePixelSize(1, 1));
  });

  it('never allocates past the cap, however deep the zoom', () => {
    // Without the cap a deep zoom asks for a backing store proportional to the
    // zoom, which is an unbounded allocation driven by a pinch gesture.
    expect(tilePixelSize(INK_LIMITS.maxZoom, 4)).toBe(INK_TILE_MAX_PIXELS);
    expect(tilePixelSize(1e9, 4)).toBe(INK_TILE_MAX_PIXELS);
  });

  it('never returns a zero-sized tile at extreme zoom-out', () => {
    expect(tilePixelSize(INK_LIMITS.minZoom, 1)).toBeGreaterThanOrEqual(1);
    expect(tilePixelSize(0, 1)).toBeGreaterThanOrEqual(1);
  });
});

describe('tilesToEvict', () => {
  const entry = (col: number, lastUsed: number): InkTileCacheEntry => ({
    key: { col, row: 0 },
    pixelSize: INK_TILE_MAX_PIXELS,
    lastUsed,
  });

  it('evicts nothing while under budget', () => {
    expect(tilesToEvict([entry(0, 1)], [], INK_TILE_MAX_PIXELS * INK_TILE_MAX_PIXELS * 4)).toEqual(
      [],
    );
  });

  it('evicts least-recently-used first', () => {
    const budget = tileBytes(INK_TILE_MAX_PIXELS) * 2;
    const evicted = tilesToEvict([entry(0, 30), entry(1, 10), entry(2, 20)], [], budget);
    expect(evicted).toEqual([{ col: 1, row: 0 }]);
  });

  it('never evicts a tile the viewport is showing', () => {
    // Evicting a visible tile only forces an immediate repaint, so it is worse
    // than briefly exceeding the budget.
    const budget = tileBytes(INK_TILE_MAX_PIXELS);
    const evicted = tilesToEvict(
      [entry(0, 1), entry(1, 2)],
      [{ col: 0, row: 0 }],
      budget,
    );
    expect(evicted).toEqual([{ col: 1, row: 0 }]);
  });

  it('stops as soon as it is back under budget', () => {
    const budget = tileBytes(INK_TILE_MAX_PIXELS) * 2;
    const evicted = tilesToEvict([entry(0, 1), entry(1, 2), entry(2, 3), entry(3, 4)], [], budget);
    expect(evicted).toHaveLength(2);
  });
});

describe('InkDirtyTiles', () => {
  it('marks only the tiles an edit touched', () => {
    const dirty = new InkDirtyTiles();
    dirty.markBounds({ minX: 0, minY: 0, maxX: 100, maxY: 100 });
    expect(dirty.size).toBe(1);
    expect(dirty.has({ col: 0, row: 0 })).toBe(true);
    expect(dirty.has({ col: 1, row: 0 })).toBe(false);
  });

  it('marks both the old and the new region of a moved object', () => {
    // Forgetting the vacated region is what leaves a ghost of the object where
    // it used to be.
    const dirty = new InkDirtyTiles();
    dirty.markMoved(
      { minX: 0, minY: 0, maxX: 100, maxY: 100 },
      { minX: INK_TILE_SIZE * 4, minY: 0, maxX: INK_TILE_SIZE * 4 + 100, maxY: 100 },
    );
    expect(dirty.has({ col: 0, row: 0 })).toBe(true);
    expect(dirty.has({ col: 4, row: 0 })).toBe(true);
  });

  it('returns only the dirty tiles the viewport can see, and clears them', () => {
    const dirty = new InkDirtyTiles();
    dirty.markBounds({ minX: 0, minY: 0, maxX: 100, maxY: 100 });
    dirty.markBounds({ minX: INK_TILE_SIZE * 9, minY: 0, maxX: INK_TILE_SIZE * 9 + 10, maxY: 10 });

    const repaint = dirty.take([{ col: 0, row: 0 }, { col: 1, row: 0 }]);
    expect(repaint).toEqual([{ col: 0, row: 0 }]);
    // The offscreen tile stays dirty so it repaints when it scrolls into view.
    expect(dirty.has({ col: 9, row: 0 })).toBe(true);
    expect(dirty.take([{ col: 0, row: 0 }])).toEqual([]);
  });

  it('deduplicates overlapping edits', () => {
    const dirty = new InkDirtyTiles();
    for (let index = 0; index < 50; index += 1) {
      dirty.markBounds({ minX: index, minY: index, maxX: index + 10, maxY: index + 10 });
    }
    expect(dirty.size).toBe(1);
  });
});

describe('tileId', () => {
  it('distinguishes tiles that differ only by sign', () => {
    expect(tileId({ col: -1, row: 2 })).not.toBe(tileId({ col: 1, row: 2 }));
  });
});
