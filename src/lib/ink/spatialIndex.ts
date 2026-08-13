/**
 * Bounded spatial index over an ink scene.
 *
 * A page holding ten thousand strokes cannot answer "what is under this tap" by
 * testing every stroke: Phase 0 measured stroke hit testing at a few
 * microseconds each, so a full scan is tens of milliseconds per tap and worse
 * per eraser sample — and an eraser drag asks the question on every pointer
 * event.
 *
 * The index is a uniform grid keyed on the same tiles the renderer uses. That
 * is deliberate: one geometry model for painting and for picking means an
 * object can never be painted into a tile it cannot be found in.
 *
 * The index is **derived**. It is rebuilt from the scene after loading,
 * migration, or recovery, and is never persisted.
 */

import type { InkBounds, InkObject, InkScene } from '../../types/ink';
import { decodeSamples } from './codec';
import { strokeHitTest } from './stroke';
import { objectBounds } from './svg';
import { INK_TILE_SIZE, tileId, tilesForBounds } from './tiles';

export interface InkHitOptions {
  /**
   * Extra radius in **ink units**, for touch targets. Callers divide their
   * pixel slop by the current zoom, so the target stays a constant size on
   * screen rather than growing as the user zooms in.
   */
  slop?: number;
  /** Skip objects on hidden layers. Defaults to true. */
  respectVisibility?: boolean;
  /** Skip objects on locked layers, and locked objects. Defaults to true. */
  respectLocking?: boolean;
}

export class InkSpatialIndex {
  private readonly cells = new Map<string, string[]>();
  private readonly bounds = new Map<string, InkBounds>();

  constructor(
    private readonly scene: InkScene,
    private readonly tileSize: number = INK_TILE_SIZE,
  ) {
    for (const id of scene.objectOrder) {
      const object = scene.objects[id];
      if (object) this.insert(object);
    }
  }

  private insert(object: InkObject): void {
    const objectBound = objectBounds(object);
    if (!objectBound) return;
    this.bounds.set(object.id, objectBound);
    for (const key of tilesForBounds(objectBound, this.tileSize)) {
      const cell = tileId(key);
      const existing = this.cells.get(cell);
      if (existing) existing.push(object.id);
      else this.cells.set(cell, [object.id]);
    }
  }

  /** Cached bounds of an indexed object. */
  boundsOf(objectId: string): InkBounds | undefined {
    return this.bounds.get(objectId);
  }

  get cellCount(): number {
    return this.cells.size;
  }

  /**
   * Candidate ids whose bounds overlap the region, in paint order.
   *
   * Candidates, not hits: a bounds overlap is a cheap filter, and the caller
   * still runs the exact geometry test. Returned back-to-front so a caller
   * wanting the topmost can walk from the end.
   */
  candidates(region: InkBounds): string[] {
    const seen = new Set<string>();
    for (const key of tilesForBounds(region, this.tileSize)) {
      const cell = this.cells.get(tileId(key));
      if (!cell) continue;
      for (const id of cell) {
        const objectBound = this.bounds.get(id);
        if (!objectBound || !boundsOverlap(objectBound, region)) continue;
        seen.add(id);
      }
    }
    return this.scene.objectOrder.filter((id) => seen.has(id));
  }

  private isPickable(object: InkObject, options: InkHitOptions): boolean {
    const layer = this.scene.layers[object.layerId];
    if (options.respectVisibility !== false && layer && !layer.visible) return false;
    if (options.respectLocking !== false) {
      if (object.locked) return false;
      if (layer?.locked) return false;
    }
    return true;
  }

  /** The topmost object at a point, or null. */
  hitTest(x: number, y: number, options: InkHitOptions = {}): string | null {
    const slop = options.slop ?? 0;
    const region: InkBounds = {
      minX: x - slop,
      minY: y - slop,
      maxX: x + slop,
      maxY: y + slop,
    };
    const candidates = this.candidates(region);

    // Back to front: the topmost object wins a tap, as on screen.
    for (let index = candidates.length - 1; index >= 0; index -= 1) {
      const object = this.scene.objects[candidates[index]];
      if (!object || !this.isPickable(object, options)) continue;
      if (objectHitTest(object, x, y, slop)) return object.id;
    }
    return null;
  }

  /** Every object touching a rectangle, for a rectangular selection. */
  hitTestRegion(
    region: InkBounds,
    mode: 'intersect' | 'contain' = 'intersect',
    options: InkHitOptions = {},
  ): string[] {
    const hits: string[] = [];
    for (const id of this.candidates(region)) {
      const object = this.scene.objects[id];
      if (!object || !this.isPickable(object, options)) continue;
      const objectBound = this.bounds.get(id);
      if (!objectBound) continue;
      if (mode === 'contain' ? boundsContain(region, objectBound) : true) hits.push(id);
    }
    return hits;
  }

  /**
   * Every object inside a freeform lasso.
   *
   * `contain` requires the whole bounding box inside the polygon;
   * `intersect` accepts an object whose bounds overlap the polygon's bounds and
   * which has any geometry inside it.
   */
  hitTestLasso(
    polygon: number[],
    mode: 'intersect' | 'contain' = 'intersect',
    options: InkHitOptions = {},
  ): string[] {
    if (polygon.length < 6) return [];
    const region = polygonBounds(polygon);
    const hits: string[] = [];

    for (const id of this.candidates(region)) {
      const object = this.scene.objects[id];
      if (!object || !this.isPickable(object, options)) continue;
      const objectBound = this.bounds.get(id);
      if (!objectBound) continue;

      if (mode === 'contain') {
        if (boundsCorners(objectBound).every(([x, y]) => pointInPolygon(polygon, x, y))) {
          hits.push(id);
        }
        continue;
      }
      if (objectIntersectsPolygon(object, polygon, objectBound)) hits.push(id);
    }
    return hits;
  }

  /**
   * Objects an eraser stroke passes over.
   *
   * Takes the whole eraser path at once rather than one point at a time: the
   * pointer delivers samples faster than the display refreshes, and querying
   * per sample is what makes an eraser drag stutter on a dense page.
   */
  hitTestEraser(
    path: Array<{ x: number; y: number }>,
    radius: number,
    options: InkHitOptions = {},
  ): string[] {
    const hits = new Set<string>();
    for (const point of path) {
      const id = this.hitTest(point.x, point.y, { ...options, slop: radius });
      if (id) hits.add(id);
    }
    return this.scene.objectOrder.filter((id) => hits.has(id));
  }
}

/* -------------------------------------------------------------------------
 * Geometry primitives
 * ---------------------------------------------------------------------- */

export function boundsOverlap(left: InkBounds, right: InkBounds): boolean {
  return !(
    left.maxX < right.minX ||
    left.minX > right.maxX ||
    left.maxY < right.minY ||
    left.minY > right.maxY
  );
}

/** True when `outer` fully contains `inner`. */
export function boundsContain(outer: InkBounds, inner: InkBounds): boolean {
  return (
    inner.minX >= outer.minX &&
    inner.maxX <= outer.maxX &&
    inner.minY >= outer.minY &&
    inner.maxY <= outer.maxY
  );
}

function boundsCorners(bounds: InkBounds): Array<[number, number]> {
  return [
    [bounds.minX, bounds.minY],
    [bounds.maxX, bounds.minY],
    [bounds.maxX, bounds.maxY],
    [bounds.minX, bounds.maxY],
  ];
}

export function polygonBounds(polygon: number[]): InkBounds {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let index = 0; index + 1 < polygon.length; index += 2) {
    minX = Math.min(minX, polygon[index]);
    maxX = Math.max(maxX, polygon[index]);
    minY = Math.min(minY, polygon[index + 1]);
    maxY = Math.max(maxY, polygon[index + 1]);
  }
  return { minX, minY, maxX, maxY };
}

/** Even-odd point-in-polygon test. */
export function pointInPolygon(polygon: number[], x: number, y: number): boolean {
  let inside = false;
  const count = Math.floor(polygon.length / 2);
  for (let i = 0, j = count - 1; i < count; j = i, i += 1) {
    const xi = polygon[i * 2];
    const yi = polygon[i * 2 + 1];
    const xj = polygon[j * 2];
    const yj = polygon[j * 2 + 1];
    const straddles = yi > y !== yj > y;
    if (straddles && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Exact geometry test for one object. */
export function objectHitTest(
  object: InkObject,
  x: number,
  y: number,
  slop: number,
): boolean {
  if (object.type === 'stroke') {
    return strokeHitTest(decodeSamples(object.samples), object.brush, x, y, slop);
  }
  const bounds = objectBounds(object);
  if (!bounds) return false;
  return (
    x >= bounds.minX - slop &&
    x <= bounds.maxX + slop &&
    y >= bounds.minY - slop &&
    y <= bounds.maxY + slop
  );
}

function objectIntersectsPolygon(
  object: InkObject,
  polygon: number[],
  bounds: InkBounds,
): boolean {
  if (object.type === 'stroke') {
    // Testing the actual samples matters here: a long diagonal stroke has a
    // huge bounding box, and accepting it on bounds alone would select strokes
    // the lasso never went near.
    const samples = decodeSamples(object.samples);
    return samples.some((sample) => pointInPolygon(polygon, sample.x, sample.y));
  }
  return boundsCorners(bounds).some(([x, y]) => pointInPolygon(polygon, x, y));
}
