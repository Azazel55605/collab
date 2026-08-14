import { describe, expect, it } from 'vitest';

import { INK_PAGE_PRESETS } from '../../types/ink';
import { createInkPage } from './document';
import { buildInkScene, buildStroke } from './fixture';
import type { InkRenderTarget } from './renderer';
import {
  INK_MAX_EXPORT_EDGE,
  INK_MAX_EXPORT_PIXELS,
  INK_UNITS_PER_EXPORT_PIXEL,
  InkExportError,
  pageExportBounds,
  paintRasterExport,
  planRasterExport,
} from './raster';

class CountingTarget implements InkRenderTarget {
  fills = 0;
  rects = 0;
  fillStyle = '';
  strokeStyle = '';
  lineWidth = 1;
  globalAlpha = 1;
  font = '';
  private depth = 0;
  save(): void {
    this.depth += 1;
  }
  restore(): void {
    this.depth -= 1;
  }
  get balanced(): boolean {
    return this.depth === 0;
  }
  setTransform(): void {}
  translate(): void {}
  scale(): void {}
  rotate(): void {}
  clearRect(): void {}
  fillRect(): void {
    this.rects += 1;
  }
  beginPath(): void {}
  moveTo(): void {}
  lineTo(): void {}
  closePath(): void {}
  fill(): void {
    this.fills += 1;
  }
  stroke(): void {}
  fillText(): void {}
}

describe('planRasterExport', () => {
  const scene = () => buildInkScene({ strokes: 20, samplesPerStroke: 10 });

  it('sizes the output from the content bounds at 1:1', () => {
    const plan = planRasterExport(scene());
    const unitWidth = plan.bounds.maxX - plan.bounds.minX;
    expect(plan.width).toBe(Math.floor(unitWidth / INK_UNITS_PER_EXPORT_PIXEL));
    expect(plan.scale).toBe(1);
    expect(plan.clampedFrom).toBeUndefined();
  });

  it('scales up on request', () => {
    const single = planRasterExport(scene(), { scale: 1 });
    const double = planRasterExport(scene(), { scale: 2 });
    expect(double.width).toBeGreaterThan(single.width * 1.9);
    expect(double.bytes).toBeGreaterThan(single.bytes * 3);
  });

  it('adds padding in ink units', () => {
    const plain = planRasterExport(scene());
    const padded = planRasterExport(scene(), { padding: 4_800 });
    expect(padded.bounds.minX).toBe(plain.bounds.minX - 4_800);
    expect(padded.width).toBeGreaterThan(plain.width);
  });

  it('reduces an over-ambitious scale rather than failing', () => {
    // A user asking for 64x on a full page wants the biggest image they can
    // have, not an error.
    const plan = planRasterExport(scene(), {
      bounds: { minX: 0, minY: 0, maxX: INK_PAGE_PRESETS.a4.width, maxY: INK_PAGE_PRESETS.a4.height },
      scale: 64,
    });
    expect(plan.clampedFrom).toBe(64);
    expect(plan.scale).toBeLessThan(64);
    expect(plan.width).toBeLessThanOrEqual(INK_MAX_EXPORT_EDGE);
    expect(plan.height).toBeLessThanOrEqual(INK_MAX_EXPORT_EDGE);
    expect(plan.width * plan.height).toBeLessThanOrEqual(INK_MAX_EXPORT_PIXELS);
  });

  it('never exceeds the edge or area ceiling at any requested scale', () => {
    for (const scale of [1, 4, 16, 100, 10_000]) {
      // 8333x6250 at 1:1, comfortably inside the ceiling, so only the
      // requested scale can push it over.
      const plan = planRasterExport(scene(), {
        bounds: { minX: 0, minY: 0, maxX: 400_000, maxY: 300_000 },
        scale,
      });
      expect(plan.width).toBeLessThanOrEqual(INK_MAX_EXPORT_EDGE);
      expect(plan.height).toBeLessThanOrEqual(INK_MAX_EXPORT_EDGE);
      expect(plan.width * plan.height).toBeLessThanOrEqual(INK_MAX_EXPORT_PIXELS);
    }
  });

  it('refuses a region too large to export even at 1:1', () => {
    // Not merely ambitious — impossible. Reducing the scale cannot help.
    try {
      planRasterExport(scene(), {
        bounds: { minX: 0, minY: 0, maxX: 16_000_000, maxY: 16_000_000 },
      });
      throw new Error('expected a throw');
    } catch (error) {
      expect(error).toBeInstanceOf(InkExportError);
      expect((error as InkExportError).code).toBe('too-large');
    }
  });

  it('refuses a region with no area', () => {
    try {
      planRasterExport(scene(), { bounds: { minX: 10, minY: 10, maxX: 10, maxY: 10 } });
      throw new Error('expected a throw');
    } catch (error) {
      expect((error as InkExportError).code).toBe('empty');
    }
  });

  it('never plans a zero-sized image', () => {
    const plan = planRasterExport(scene(), {
      bounds: { minX: 0, minY: 0, maxX: 1, maxY: 1 },
    });
    expect(plan.width).toBeGreaterThanOrEqual(1);
    expect(plan.height).toBeGreaterThanOrEqual(1);
  });
});

describe('paintRasterExport', () => {
  it('paints the scene and leaves the target balanced', () => {
    const scene = buildInkScene({ strokes: 6, samplesPerStroke: 8 });
    const plan = planRasterExport(scene);
    const target = new CountingTarget();
    paintRasterExport(target, scene, plan);
    expect(target.fills).toBe(6);
    expect(target.balanced).toBe(true);
  });

  it('fills a background only when asked', () => {
    const scene = buildInkScene({ strokes: 2, samplesPerStroke: 6 });
    const plan = planRasterExport(scene);

    const transparent = new CountingTarget();
    paintRasterExport(transparent, scene, plan);
    const opaque = new CountingTarget();
    paintRasterExport(opaque, scene, plan, { background: '#ffffff' });
    expect(opaque.rects).toBeGreaterThan(transparent.rects);
  });

  it('honours per-layer export exclusion even though the screen does not', () => {
    const scene = buildInkScene({ strokes: 6, samplesPerStroke: 8, layers: 2 });
    scene.layers['layer-2'].exported = false;
    const plan = planRasterExport(scene);

    const target = new CountingTarget();
    paintRasterExport(target, scene, plan);
    expect(target.fills).toBeLessThan(6);
  });

  it('exports only a selection when asked', () => {
    const scene = buildInkScene({ strokes: 5, samplesPerStroke: 8 });
    const plan = planRasterExport(scene);
    const target = new CountingTarget();
    paintRasterExport(target, scene, plan, { objectIds: ['stroke-2'] });
    expect(target.fills).toBe(1);
  });

  it('includes the page background only on request', () => {
    const scene = buildInkScene({ strokes: 2, samplesPerStroke: 6 });
    const page = { ...createInkPage('p', { background: { pattern: 'dotted', spacing: 2_000 } }), scene };
    const plan = planRasterExport(scene);

    const without = new CountingTarget();
    paintRasterExport(without, scene, plan, {}, page);
    const with_ = new CountingTarget();
    paintRasterExport(with_, scene, plan, { includePageBackground: true }, page);
    expect(with_.rects).toBeGreaterThan(without.rects);
  });
});

describe('pageExportBounds', () => {
  it('uses the sheet edges for a fixed page', () => {
    const page = createInkPage('p', { preset: 'a4' });
    expect(pageExportBounds(page)).toEqual({
      minX: 0,
      minY: 0,
      maxX: page.width,
      maxY: page.height,
    });
  });

  it('uses the content bounds for an infinite page, which has no edges', () => {
    // An infinite page's `width` is only its initial viewport extent, so
    // content legitimately sits outside it — in both directions. The export has
    // to follow the ink, not that nominal box.
    const scene = buildInkScene({ strokes: 4, samplesPerStroke: 8 });
    scene.objects['stroke-1'] = buildStroke('stroke-1', 'layer-1', {
      samples: 8,
      x: -20_000,
      y: -20_000,
      length: 1_000,
    });
    const page = { ...createInkPage('p', { mode: 'infinite' }), scene };

    const bounds = pageExportBounds(page);
    expect(bounds.minX).toBeLessThan(0);
    expect(bounds).not.toEqual({ minX: 0, minY: 0, maxX: page.width, maxY: page.height });
  });
});
