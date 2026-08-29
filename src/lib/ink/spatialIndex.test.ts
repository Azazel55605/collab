import { describe, expect, it } from 'vitest';

import type { InkScene } from '../../types/ink';

import { decodeSamples, encodeSamples } from './codec';
import { strokeOf } from './document';
import { buildInkScene, buildStroke, FIXTURE_BRUSH } from './fixture';
import {
  boundsContain,
  boundsOverlap,
  InkSpatialIndex,
  pointInPolygon,
  polygonBounds,
} from './spatialIndex';
import { INK_TILE_SIZE } from './tiles';

function sceneWith(
  strokes: Array<{ id: string; x: number; y: number; layerId?: string }>,
): InkScene {
  const scene: InkScene = {
    layers: {
      'layer-1': { id: 'layer-1', name: 'One', visible: true, locked: false, opacity: 1 },
      'layer-2': { id: 'layer-2', name: 'Two', visible: true, locked: false, opacity: 1 },
    },
    layerOrder: ['layer-1', 'layer-2'],
    objects: {},
    objectOrder: [],
  };
  for (const entry of strokes) {
    scene.objects[entry.id] = buildStroke(entry.id, entry.layerId ?? 'layer-1', {
      samples: 12,
      x: entry.x,
      y: entry.y,
      length: 2_000,
      pressure: false,
    });
    scene.objectOrder.push(entry.id);
  }
  return scene;
}

describe('InkSpatialIndex', () => {
  it('finds the stroke under a point', () => {
    const scene = sceneWith([{ id: 'a', x: 1_000, y: 1_000 }]);
    const index = new InkSpatialIndex(scene);
    const samples = decodeSamples(strokeOf(scene, 'a')!.samples);
    const point = samples[6];
    expect(index.hitTest(point.x, point.y)).toBe('a');
  });

  it('misses empty space', () => {
    const scene = sceneWith([{ id: 'a', x: 1_000, y: 1_000 }]);
    expect(new InkSpatialIndex(scene).hitTest(900_000, 900_000)).toBeNull();
  });

  it('returns the topmost object when strokes overlap', () => {
    // A tap picks what the user can see, which is the last thing painted.
    const scene = sceneWith([
      { id: 'under', x: 1_000, y: 1_000 },
      { id: 'over', x: 1_000, y: 1_000 },
    ]);
    const index = new InkSpatialIndex(scene);
    const samples = decodeSamples(strokeOf(scene, 'over')!.samples);
    expect(index.hitTest(samples[6].x, samples[6].y)).toBe('over');
  });

  it('expands the target by the caller-supplied slop', () => {
    const scene = sceneWith([{ id: 'a', x: 0, y: 0 }]);
    const index = new InkSpatialIndex(scene);
    const samples = decodeSamples(strokeOf(scene, 'a')!.samples);
    const beside = { x: samples[6].x, y: samples[6].y + FIXTURE_BRUSH.width };
    expect(index.hitTest(beside.x, beside.y)).toBeNull();
    expect(index.hitTest(beside.x, beside.y, { slop: FIXTURE_BRUSH.width })).toBe('a');
  });

  it('skips objects on a hidden layer', () => {
    const scene = sceneWith([{ id: 'a', x: 0, y: 0, layerId: 'layer-2' }]);
    scene.layers['layer-2'].visible = false;
    const index = new InkSpatialIndex(scene);
    const samples = decodeSamples(strokeOf(scene, 'a')!.samples);
    expect(index.hitTest(samples[6].x, samples[6].y)).toBeNull();
    expect(index.hitTest(samples[6].x, samples[6].y, { respectVisibility: false })).toBe('a');
  });

  it('skips locked objects and objects on locked layers', () => {
    const scene = sceneWith([
      { id: 'a', x: 0, y: 0 },
      { id: 'b', x: 0, y: 0, layerId: 'layer-2' },
    ]);
    scene.objects.a = { ...scene.objects.a, locked: true };
    scene.layers['layer-2'].locked = true;

    const index = new InkSpatialIndex(scene);
    const samples = decodeSamples(strokeOf(scene, 'a')!.samples);
    expect(index.hitTest(samples[6].x, samples[6].y)).toBeNull();
    expect(index.hitTest(samples[6].x, samples[6].y, { respectLocking: false })).toBe('b');
  });

  it('narrows candidates to the tiles a region touches', () => {
    // The reason the index exists: a tap must not test every stroke on a page.
    const scene = buildInkScene({ strokes: 2_000, samplesPerStroke: 10 });
    const index = new InkSpatialIndex(scene);
    const candidates = index.candidates({ minX: 0, minY: 0, maxX: 10, maxY: 10 });
    expect(candidates.length).toBeGreaterThan(0);
    expect(candidates.length).toBeLessThan(scene.objectOrder.length / 4);
  });

  it('returns candidates in paint order', () => {
    const scene = sceneWith([
      { id: 'a', x: 0, y: 0 },
      { id: 'b', x: 0, y: 0 },
      { id: 'c', x: 0, y: 0 },
    ]);
    const index = new InkSpatialIndex(scene);
    expect(index.candidates({ minX: -1e6, minY: -1e6, maxX: 1e6, maxY: 1e6 })).toEqual([
      'a',
      'b',
      'c',
    ]);
  });

  it('indexes a stroke into every tile it crosses', () => {
    const scene: InkScene = {
      layers: { 'layer-1': { id: 'layer-1', name: 'L', visible: true, locked: false, opacity: 1 } },
      layerOrder: ['layer-1'],
      objects: {
        long: buildStroke('long', 'layer-1', {
          samples: 40,
          x: 0,
          y: 0,
          length: INK_TILE_SIZE * 5,
        }),
      },
      objectOrder: ['long'],
    };
    const index = new InkSpatialIndex(scene);
    expect(index.cellCount).toBeGreaterThan(4);
  });

  it('handles negative coordinates, which an infinite canvas has', () => {
    const scene = sceneWith([{ id: 'a', x: -50_000, y: -50_000 }]);
    const index = new InkSpatialIndex(scene);
    const samples = decodeSamples(strokeOf(scene, 'a')!.samples);
    expect(index.hitTest(samples[6].x, samples[6].y)).toBe('a');
  });
});

describe('region selection', () => {
  it('selects intersecting objects, and only contained ones in contain mode', () => {
    const scene = sceneWith([
      { id: 'inside', x: 1_000, y: 1_000 },
      { id: 'far', x: 400_000, y: 400_000 },
    ]);
    const index = new InkSpatialIndex(scene);
    const region = { minX: 0, minY: 0, maxX: 20_000, maxY: 20_000 };

    expect(index.hitTestRegion(region, 'intersect')).toEqual(['inside']);
    expect(index.hitTestRegion(region, 'contain')).toEqual(['inside']);
    expect(index.hitTestRegion({ minX: 0, minY: 0, maxX: 100, maxY: 100 }, 'contain')).toEqual([]);
  });
});

describe('lasso selection', () => {
  const scene = sceneWith([
    { id: 'a', x: 1_000, y: 1_000 },
    { id: 'b', x: 60_000, y: 60_000 },
  ]);
  const index = new InkSpatialIndex(scene);

  it('selects a stroke the lasso encloses', () => {
    const polygon = [0, 0, 20_000, 0, 20_000, 20_000, 0, 20_000];
    expect(index.hitTestLasso(polygon, 'intersect')).toEqual(['a']);
  });

  it('ignores a stroke whose bounding box overlaps but whose ink does not', () => {
    // A true diagonal stroke's bounding box is the whole square it spans, so
    // its corners are far from any ink. Accepting on bounds alone would select
    // strokes the lasso never went near.
    const diagonal = sceneWith([]);
    const samples = Array.from({ length: 40 }, (_, index) => ({
      x: index * 2_500,
      y: index * 2_500,
    }));
    diagonal.objects.diagonal = {
      id: 'diagonal',
      type: 'stroke',
      layerId: 'layer-1',
      brush: FIXTURE_BRUSH,
      samples: encodeSamples(samples),
    };
    diagonal.objectOrder.push('diagonal');
    const diagonalIndex = new InkSpatialIndex(diagonal);

    // Sanity: the lasso really is inside the stroke's bounding box.
    const bounds = diagonalIndex.boundsOf('diagonal')!;
    const corner = [0, 80_000, 15_000, 80_000, 15_000, 97_500, 0, 97_500];
    expect(boundsOverlap(bounds, polygonBounds(corner))).toBe(true);

    // But the ink runs along the diagonal, nowhere near that corner.
    expect(diagonalIndex.hitTestLasso(corner, 'intersect')).toEqual([]);

    // And a lasso actually over the ink does select it.
    const onInk = [45_000, 45_000, 55_000, 45_000, 55_000, 55_000, 45_000, 55_000];
    expect(diagonalIndex.hitTestLasso(onInk, 'intersect')).toEqual(['diagonal']);
  });

  it('requires full containment in contain mode', () => {
    const partial = [0, 0, 2_000, 0, 2_000, 2_000, 0, 2_000];
    expect(index.hitTestLasso(partial, 'contain')).toEqual([]);
  });

  it('ignores a degenerate polygon', () => {
    expect(index.hitTestLasso([0, 0, 1, 1], 'intersect')).toEqual([]);
  });
});

describe('eraser', () => {
  it('collects every object along the eraser path, in paint order', () => {
    const scene = sceneWith([
      { id: 'a', x: 0, y: 0 },
      { id: 'b', x: 3_000, y: 0 },
    ]);
    const index = new InkSpatialIndex(scene);
    const path = [];
    for (let x = 0; x <= 5_000; x += 250) path.push({ x, y: 0 });

    const erased = index.hitTestEraser(path, 200);
    expect(erased).toEqual(['a', 'b']);
  });

  it('erases nothing along a path over empty space', () => {
    const scene = sceneWith([{ id: 'a', x: 0, y: 0 }]);
    const index = new InkSpatialIndex(scene);
    expect(index.hitTestEraser([{ x: 500_000, y: 500_000 }], 100)).toEqual([]);
  });
});

describe('geometry primitives', () => {
  it('detects overlap and containment', () => {
    const outer = { minX: 0, minY: 0, maxX: 100, maxY: 100 };
    expect(boundsOverlap(outer, { minX: 50, minY: 50, maxX: 150, maxY: 150 })).toBe(true);
    expect(boundsOverlap(outer, { minX: 200, minY: 0, maxX: 300, maxY: 100 })).toBe(false);
    expect(boundsContain(outer, { minX: 10, minY: 10, maxX: 90, maxY: 90 })).toBe(true);
    expect(boundsContain(outer, { minX: 10, minY: 10, maxX: 110, maxY: 90 })).toBe(false);
  });

  it('treats touching bounds as overlapping', () => {
    expect(
      boundsOverlap(
        { minX: 0, minY: 0, maxX: 100, maxY: 100 },
        { minX: 100, minY: 0, maxX: 200, maxY: 100 },
      ),
    ).toBe(true);
  });

  it('tests points against a polygon', () => {
    const square = [0, 0, 100, 0, 100, 100, 0, 100];
    expect(pointInPolygon(square, 50, 50)).toBe(true);
    expect(pointInPolygon(square, 150, 50)).toBe(false);
  });

  it('handles a concave polygon, which a lasso usually is', () => {
    const cShape = [0, 0, 100, 0, 100, 30, 30, 30, 30, 70, 100, 70, 100, 100, 0, 100];
    expect(pointInPolygon(cShape, 10, 50)).toBe(true);
    // Inside the bounding box but in the mouth of the C.
    expect(pointInPolygon(cShape, 70, 50)).toBe(false);
  });

  it('computes polygon bounds', () => {
    expect(polygonBounds([0, 0, 100, 50, -20, 80])).toEqual({
      minX: -20,
      minY: 0,
      maxX: 100,
      maxY: 80,
    });
  });
});
