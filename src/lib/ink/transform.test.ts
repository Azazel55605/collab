import { describe, expect, it } from 'vitest';

import { INK_LIMITS } from '../../types/ink';
import type { InkObject } from '../../types/ink';
import { decodeSamples } from './codec';
import { buildStroke, FIXTURE_BRUSH } from './fixture';
import { objectBounds } from './svg';
import {
  affineScale,
  applyAffine,
  boundsToBounds,
  composeAffine,
  INK_IDENTITY,
  resizeBounds,
  rotationAbout,
  scaleAbout,
  transformObject,
  translation,
} from './transform';

const BOX = { minX: 0, minY: 0, maxX: 100, maxY: 50 };

describe('affine primitives', () => {
  it('translates', () => {
    expect(applyAffine(translation(10, -5), 1, 2)).toEqual({ x: 11, y: -3 });
  });

  it('scales about a fixed point, leaving that point where it was', () => {
    // What makes a resize handle drag against its opposite corner.
    const transform = scaleAbout(100, 100, 2, 3);
    expect(applyAffine(transform, 100, 100)).toEqual({ x: 100, y: 100 });
    expect(applyAffine(transform, 200, 100)).toEqual({ x: 300, y: 100 });
  });

  it('rotates about a fixed point', () => {
    const quarter = rotationAbout(0, 0, Math.PI / 2);
    const rotated = applyAffine(quarter, 100, 0);
    expect(rotated.x).toBeCloseTo(0, 6);
    expect(rotated.y).toBeCloseTo(100, 6);
  });

  it('composes in application order', () => {
    const composed = composeAffine(translation(10, 0), scaleAbout(0, 0, 2, 2));
    expect(applyAffine(composed, 0, 0)).toEqual({ x: 20, y: 0 });
  });

  it('is a no-op for the identity', () => {
    expect(applyAffine(INK_IDENTITY, 7, 9)).toEqual({ x: 7, y: 9 });
    expect(affineScale(INK_IDENTITY)).toBe(1);
  });

  it('reports a uniform scale as the geometric mean of the axes', () => {
    expect(affineScale(scaleAbout(0, 0, 2, 2))).toBeCloseTo(2, 6);
    expect(affineScale(scaleAbout(0, 0, 4, 1))).toBeCloseTo(2, 6);
  });

  it('reports a scale of 1 for a pure rotation', () => {
    expect(affineScale(rotationAbout(0, 0, 0.7))).toBeCloseTo(1, 6);
  });
});

describe('transformObject', () => {
  const stroke = () => buildStroke('s', 'layer-1', { samples: 20, x: 1_000, y: 1_000 });

  it('moves a stroke without restyling it', () => {
    // Pressure, tilt, and time describe how the stroke was drawn, not where it
    // sits. Moving must not change any of them.
    const original = stroke();
    const before = decodeSamples(original.samples);
    const moved = transformObject(original, translation(500, -200));
    const after = decodeSamples((moved as typeof original).samples);

    expect(after).toHaveLength(before.length);
    after.forEach((sample, index) => {
      expect(sample.x).toBe(before[index].x + 500);
      expect(sample.y).toBe(before[index].y - 200);
      expect(sample.pressure).toBe(before[index].pressure);
      expect(sample.elapsed).toBe(before[index].elapsed);
    });
  });

  it('scales the stroke width with the object', () => {
    const scaled = transformObject(stroke(), scaleAbout(0, 0, 2, 2));
    expect((scaled as { brush: { width: number } }).brush.width).toBeCloseTo(
      FIXTURE_BRUSH.width * 2,
      4,
    );
  });

  it('does not change the width for a pure translation', () => {
    const moved = transformObject(stroke(), translation(100, 100));
    expect((moved as { brush: { width: number } }).brush.width).toBeCloseTo(
      FIXTURE_BRUSH.width,
      6,
    );
  });

  it('bakes the geometry rather than storing a matrix', () => {
    // Bounds, hit testing, the index, the tile cache, and both exporters all
    // read coordinates directly; a stored matrix would need composing in five
    // places, and one forgetting means ink that draws and selects apart.
    const moved = transformObject(stroke(), translation(5_000, 0));
    expect((moved as { transform?: unknown }).transform).toBeUndefined();
    expect(objectBounds(moved)!.minX).toBeGreaterThan(objectBounds(stroke())!.minX);
  });

  it('drops the cached bounds so they are recomputed', () => {
    const moved = transformObject(stroke(), translation(10, 10));
    expect((moved as { bounds?: unknown }).bounds).toBeUndefined();
  });

  it('clamps a transform that would leave the world', () => {
    const original = stroke();
    const moved = transformObject(original, translation(INK_LIMITS.worldExtent * 2, 0));
    for (const sample of decodeSamples((moved as typeof original).samples)) {
      expect(Math.abs(sample.x)).toBeLessThanOrEqual(INK_LIMITS.worldExtent);
    }
  });

  it('moves a text box and scales its type with the frame', () => {
    // Otherwise a resized sticky note keeps small text in a bigger box.
    const text: InkObject = {
      id: 't', type: 'text', layerId: 'layer-1',
      x: 100, y: 100, width: 200, height: 80,
      text: 'hi', color: '#000', fontSize: 96,
    };
    const scaled = transformObject(text, scaleAbout(0, 0, 2, 2));
    expect(scaled).toMatchObject({ x: 200, y: 200, width: 400, height: 160, fontSize: 192 });
  });

  it('leaves a group record alone, since it holds only ids', () => {
    const group: InkObject = { id: 'g', type: 'group', layerId: 'layer-1', childIds: ['a', 'b'] };
    expect(transformObject(group, translation(50, 50))).toEqual(group);
  });
});

describe('boundsToBounds', () => {
  it('maps one rectangle exactly onto another', () => {
    const target = { minX: 200, minY: 100, maxX: 400, maxY: 200 };
    const transform = boundsToBounds(BOX, target);
    expect(applyAffine(transform, BOX.minX, BOX.minY)).toEqual({ x: 200, y: 100 });
    expect(applyAffine(transform, BOX.maxX, BOX.maxY)).toEqual({ x: 400, y: 200 });
  });

  it('survives a degenerate source without dividing by zero', () => {
    const flat = { minX: 5, minY: 5, maxX: 5, maxY: 5 };
    const transform = boundsToBounds(flat, BOX);
    expect(Number.isFinite(transform.a)).toBe(true);
    expect(Number.isFinite(transform.e)).toBe(true);
  });
});

describe('resizeBounds', () => {
  it('keeps the opposite edge fixed', () => {
    expect(resizeBounds(BOX, 'se', 50, 25)).toEqual({
      minX: 0, minY: 0, maxX: 150, maxY: 75,
    });
    expect(resizeBounds(BOX, 'nw', -50, -25)).toEqual({
      minX: -50, minY: -25, maxX: 100, maxY: 50,
    });
  });

  it('moves one axis only for an edge handle', () => {
    expect(resizeBounds(BOX, 'e', 40, 999)).toEqual({
      minX: 0, minY: 0, maxX: 140, maxY: 50,
    });
  });

  it('locks the aspect ratio when asked', () => {
    const uniform = resizeBounds(BOX, 'se', 100, 0, true);
    const width = uniform.maxX - uniform.minX;
    const height = uniform.maxY - uniform.minY;
    expect(width / height).toBeCloseTo(100 / 50, 6);
  });

  it('flips rather than inverting when dragged past the opposite edge', () => {
    // An inverted rectangle makes every downstream bounds check silently false.
    const flipped = resizeBounds(BOX, 'e', -300, 0);
    expect(flipped.minX).toBeLessThanOrEqual(flipped.maxX);
    expect(flipped.minY).toBeLessThanOrEqual(flipped.maxY);
  });
});
