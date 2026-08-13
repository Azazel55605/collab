import { describe, expect, it } from 'vitest';

import { INK_SAMPLE_RANGES } from '../../types/ink';
import type { InkBrushParameters, InkSample } from '../../types/ink';
import { FIXTURE_BRUSH, buildStrokeSamples } from './fixture';
import { halfWidthAt, outlineStroke, strokeBounds, strokeHitTest } from './stroke';
import { outlineStrokeWithPerfectFreehand } from './strokeAdapters';

const UNIFORM: InkBrushParameters = { ...FIXTURE_BRUSH, thinning: 0 };

function pressure(value: number): number {
  return Math.round(value * INK_SAMPLE_RANGES.pressureMax);
}

describe('halfWidthAt', () => {
  it('ignores pressure when the brush does not thin', () => {
    const light = halfWidthAt({ x: 0, y: 0, pressure: pressure(0.1) }, UNIFORM, undefined);
    const heavy = halfWidthAt({ x: 0, y: 0, pressure: pressure(0.9) }, UNIFORM, undefined);
    expect(light).toBe(heavy);
    expect(light).toBe(UNIFORM.width / 2);
  });

  it('widens with pressure when the brush thins', () => {
    const brush = { ...FIXTURE_BRUSH, thinning: 0.6 };
    const light = halfWidthAt({ x: 0, y: 0, pressure: pressure(0.1) }, brush, undefined);
    const heavy = halfWidthAt({ x: 0, y: 0, pressure: pressure(0.9) }, brush, undefined);
    expect(heavy).toBeGreaterThan(light);
  });

  it('inverts with negative thinning', () => {
    const brush = { ...FIXTURE_BRUSH, thinning: -0.6 };
    const light = halfWidthAt({ x: 0, y: 0, pressure: pressure(0.1) }, brush, undefined);
    const heavy = halfWidthAt({ x: 0, y: 0, pressure: pressure(0.9) }, brush, undefined);
    expect(heavy).toBeLessThan(light);
  });

  it('draws a uniform line when the device reported no pressure', () => {
    // Not a half-pressure line. A mouse stroke that fakes pressure looks wrong,
    // which is why simulation is opt-in per brush.
    const brush = { ...FIXTURE_BRUSH, thinning: 0.8 };
    expect(halfWidthAt({ x: 0, y: 0 }, brush, undefined)).toBe(brush.width / 2);
  });

  it('uses simulated pressure only when the brush opts in', () => {
    const off = { ...FIXTURE_BRUSH, thinning: 0.8, simulatePressure: false };
    const on = { ...FIXTURE_BRUSH, thinning: 0.8, simulatePressure: true };
    expect(halfWidthAt({ x: 0, y: 0 }, off, 0.9)).toBe(off.width / 2);
    expect(halfWidthAt({ x: 0, y: 0 }, on, 0.9)).not.toBe(on.width / 2);
  });
});

describe('outlineStroke', () => {
  it('is deterministic', () => {
    // Byte-identical SVG re-export depends on this. A generator that varied
    // would churn every source-linked note embed on every save.
    const samples = buildStrokeSamples({ samples: 80, x: 1_000, y: 2_000 });
    expect(outlineStroke(samples, FIXTURE_BRUSH)).toEqual(outlineStroke(samples, FIXTURE_BRUSH));
  });

  it('produces a closed outline with points on both sides of the centre line', () => {
    const samples: InkSample[] = [
      { x: 0, y: 0 },
      { x: 1_000, y: 0 },
    ];
    const outline = outlineStroke(samples, UNIFORM);
    expect(outline.length).toBeGreaterThan(4);
    expect(outline.some((point) => point.y > 0)).toBe(true);
    expect(outline.some((point) => point.y < 0)).toBe(true);
  });

  it('draws a dot for a single sample rather than nothing', () => {
    // A tap must leave a mark. An outliner that returns an empty polygon for
    // one sample silently discards every dotted i.
    const outline = outlineStroke([{ x: 500, y: 500 }], UNIFORM);
    expect(outline.length).toBeGreaterThan(4);
    for (const point of outline) {
      expect(Math.hypot(point.x - 500, point.y - 500)).toBeCloseTo(UNIFORM.width / 2, 5);
    }
  });

  it('returns nothing for no samples', () => {
    expect(outlineStroke([], UNIFORM)).toEqual([]);
  });

  it('narrows toward a tapered end', () => {
    const brush = { ...UNIFORM, taperEnd: 2_000 };
    const samples: InkSample[] = Array.from({ length: 20 }, (_, index) => ({
      x: index * 500,
      y: 0,
    }));
    const outline = outlineStroke(samples, brush);
    const spread = (index: number) => Math.abs(outline[index].y);
    expect(spread(outline.length / 4 | 0)).toBeGreaterThan(spread(19));
  });
});

describe('strokeBounds', () => {
  it('includes the stroke width, not just the centre line', () => {
    const bounds = strokeBounds(
      [
        { x: 0, y: 0 },
        { x: 1_000, y: 0 },
      ],
      UNIFORM,
    );
    expect(bounds.minY).toBeLessThanOrEqual(-UNIFORM.width / 2);
    expect(bounds.maxY).toBeGreaterThanOrEqual(UNIFORM.width / 2);
  });

  it('does not change when the outliner does', () => {
    // Bounds drive the tile cache. If they depended on the installed adapter,
    // swapping it would invalidate every cached tile in every document.
    const samples = buildStrokeSamples({ samples: 60, x: 0, y: 0 });
    const before = strokeBounds(samples, FIXTURE_BRUSH);
    outlineStrokeWithPerfectFreehand(samples, FIXTURE_BRUSH);
    expect(strokeBounds(samples, FIXTURE_BRUSH)).toEqual(before);
  });

  it('is empty for no samples', () => {
    expect(strokeBounds([], UNIFORM)).toEqual({ minX: 0, minY: 0, maxX: 0, maxY: 0 });
  });
});

describe('strokeHitTest', () => {
  const line: InkSample[] = [
    { x: 0, y: 0 },
    { x: 1_000, y: 0 },
  ];

  it('hits on the line and misses beside it', () => {
    expect(strokeHitTest(line, UNIFORM, 500, 0)).toBe(true);
    expect(strokeHitTest(line, UNIFORM, 500, UNIFORM.width)).toBe(false);
  });

  it('expands the target by the caller-supplied slop', () => {
    expect(strokeHitTest(line, UNIFORM, 500, UNIFORM.width, 0)).toBe(false);
    expect(strokeHitTest(line, UNIFORM, 500, UNIFORM.width, UNIFORM.width)).toBe(true);
  });

  it('misses past the ends of the line', () => {
    expect(strokeHitTest(line, UNIFORM, -1_000, 0)).toBe(false);
    expect(strokeHitTest(line, UNIFORM, 2_000, 0)).toBe(false);
  });

  it('hits a single-sample dot', () => {
    expect(strokeHitTest([{ x: 100, y: 100 }], UNIFORM, 110, 100)).toBe(true);
  });

  it('is empty for no samples', () => {
    expect(strokeHitTest([], UNIFORM, 0, 0)).toBe(false);
  });
});

describe('outliner adapter boundary', () => {
  const samples = buildStrokeSamples({ samples: 120, x: 3_000, y: 4_000 });

  it('both implementations satisfy the same contract', () => {
    // What makes `InkStrokeOutliner` a real seam: two independent generators,
    // same input types, same output type, both closed polygons in ink units.
    for (const outline of [
      outlineStroke(samples, FIXTURE_BRUSH),
      outlineStrokeWithPerfectFreehand(samples, FIXTURE_BRUSH),
    ]) {
      expect(outline.length).toBeGreaterThan(8);
      for (const point of outline) {
        expect(Number.isFinite(point.x)).toBe(true);
        expect(Number.isFinite(point.y)).toBe(true);
      }
    }
  });

  it('both stay inside the bounds computed from the centre line', () => {
    // The bound is adapter-independent, so it must actually contain whatever
    // either adapter draws — with a unit of slack for the rounding to integers.
    const bounds = strokeBounds(samples, FIXTURE_BRUSH);
    for (const outline of [
      outlineStroke(samples, FIXTURE_BRUSH),
      outlineStrokeWithPerfectFreehand(samples, FIXTURE_BRUSH),
    ]) {
      for (const point of outline) {
        expect(point.x).toBeGreaterThanOrEqual(bounds.minX - 1);
        expect(point.x).toBeLessThanOrEqual(bounds.maxX + 1);
        expect(point.y).toBeGreaterThanOrEqual(bounds.minY - 1);
        expect(point.y).toBeLessThanOrEqual(bounds.maxY + 1);
      }
    }
  });

  it('perfect-freehand is deterministic too', () => {
    expect(outlineStrokeWithPerfectFreehand(samples, FIXTURE_BRUSH)).toEqual(
      outlineStrokeWithPerfectFreehand(samples, FIXTURE_BRUSH),
    );
  });
});
