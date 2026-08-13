/**
 * Phase 0 scale proofs for `.ink`.
 *
 * These run against `INK_PERFORMANCE_BUDGETS`, which are ceilings well above
 * the measured baselines in `docs/plans/digital-ink-phase0-contract.md`. A
 * change that regresses ink by an order of magnitude fails here; ordinary
 * machine-to-machine variation does not. Set `COLLAB_INK_BUDGET_SCALE` on a
 * slow runner rather than loosening the numbers.
 *
 * The fixture is 10,000 strokes because that is roughly a full handwritten
 * notebook, and because a renderer measured on ten strokes has not been
 * measured.
 */

import { describe, expect, it } from 'vitest';

import { INK_PAGE_PRESETS, INK_SAMPLE_RANGES } from '../../types/ink';
import type { InkScene, InkStroke } from '../../types/ink';
import { INK_PERFORMANCE_BUDGETS, inkTimeBudget } from './budgets';
import { decodeSamples } from './codec';
import { buildInkScene, buildStrokeSamples } from './fixture';
import { captureStroke } from './samples';
import type { InkPointerReading } from './samples';
import { outlineStroke, strokeBounds, strokeHitTest } from './stroke';
import { sceneToSvg } from './svg';
import { InkDirtyTiles, tilesForBounds, tilesForViewport } from './tiles';

const STROKE_COUNT = 10_000;
const SAMPLES_PER_STROKE = 40;

function elapsed(run: () => void): number {
  const started = performance.now();
  run();
  return performance.now() - started;
}

/** Narrows an object to a stroke, failing the test rather than casting blind. */
function strokeOf(current: InkScene, id: string): InkStroke {
  const object = current.objects[id];
  if (!object || object.type !== 'stroke') throw new Error(`${id} is not a stroke`);
  return object;
}

/** Strokes whose bounds touch any of the given tiles. */
function strokesInTiles(current: InkScene, tiles: Set<string>): string[] {
  return current.objectOrder.filter((id) => {
    const object = current.objects[id];
    if (object.type !== 'stroke' || !object.bounds) return false;
    return tilesForBounds(object.bounds).some((key) => tiles.has(`${key.col}:${key.row}`));
  });
}

/** Decodes the named strokes into the shape the outliner consumes. */
function decodeAll(current: InkScene, ids: string[]) {
  return ids.map((id) => {
    const stroke = strokeOf(current, id);
    return { samples: decodeSamples(stroke.samples), brush: stroke.brush };
  });
}

let cachedScene: InkScene | null = null;
function scene(): InkScene {
  cachedScene ??= buildInkScene({
    strokes: STROKE_COUNT,
    samplesPerStroke: SAMPLES_PER_STROKE,
    layers: 4,
  });
  return cachedScene;
}

describe('capture', () => {
  it('processes a completed stroke within budget', () => {
    const raw = buildStrokeSamples({ samples: 400, x: 0, y: 0, length: 24_000 });
    const readings: InkPointerReading[] = raw.map((sample) => ({
      x: sample.x,
      y: sample.y,
      pressure: sample.pressure! / INK_SAMPLE_RANGES.pressureMax,
      elapsed: sample.elapsed,
    }));

    // Warm the JIT: the first call through a cold path is not what a user's
    // second stroke costs.
    captureStroke(readings);
    const cost = elapsed(() => {
      captureStroke(readings);
    });
    expect(cost).toBeLessThan(inkTimeBudget('strokeCaptureMs'));
  });
});

describe('rendering', () => {
  it('outlines one stroke within the per-frame budget', () => {
    const samples = buildStrokeSamples({ samples: SAMPLES_PER_STROKE, x: 0, y: 0 });
    const { brush } = strokeOf(scene(), 'stroke-1');
    outlineStroke(samples, brush);
    const cost = elapsed(() => {
      outlineStroke(samples, brush);
    });
    expect(cost).toBeLessThan(inkTimeBudget('strokeOutlineMs'));
  });

  it('repaints one dirty tile inside a frame', () => {
    // The per-frame cost of an edit, and the number the editor actually has to
    // hit: an edit repaints the tiles its bounds touched, not the viewport.
    const current = scene();
    const decoded = decodeAll(current, strokesInTiles(current, new Set(['0:0'])));
    expect(decoded.length).toBeGreaterThan(20);

    for (const entry of decoded) outlineStroke(entry.samples, entry.brush);
    const cost = elapsed(() => {
      for (const entry of decoded) outlineStroke(entry.samples, entry.brush);
    });
    expect(cost).toBeLessThan(inkTimeBudget('tileRepaintMs'));
  });

  it('outlines a whole viewport within the cold-paint budget', () => {
    // This is the measurement that justifies tiling. At Phase 0 density a
    // third of a page holds thousands of strokes, and outlining all of them
    // costs more than one frame — so a renderer that redrew the viewport on
    // every edit could not keep up with a pen. It is paid on open and on zoom,
    // where a longer budget is honest.
    const current = scene();
    const viewport = {
      x: 0,
      y: 0,
      width: INK_PAGE_PRESETS.a4.width / 3,
      height: INK_PAGE_PRESETS.a4.height / 3,
      zoom: 1,
    };
    const visible = new Set(tilesForViewport(viewport).map((key) => `${key.col}:${key.row}`));
    const decoded = decodeAll(current, strokesInTiles(current, visible));
    expect(decoded.length).toBeGreaterThan(1_000);

    for (const entry of decoded) outlineStroke(entry.samples, entry.brush);
    const cost = elapsed(() => {
      for (const entry of decoded) outlineStroke(entry.samples, entry.brush);
    });
    expect(cost).toBeLessThan(inkTimeBudget('viewportOutlineMs'));

    // And the point of the comparison: one tile is a small fraction of that.
    const tileDecoded = decodeAll(current, strokesInTiles(current, new Set(['0:0'])));
    expect(tileDecoded.length * 4).toBeLessThan(decoded.length);
  });

  it('resolves viewport and dirty tiles within budget', () => {
    const current = scene();
    const cost = elapsed(() => {
      const dirty = new InkDirtyTiles();
      tilesForViewport({
        x: 0,
        y: 0,
        width: INK_PAGE_PRESETS.a4.width,
        height: INK_PAGE_PRESETS.a4.height,
        zoom: 1,
      });
      for (let index = 0; index < 200; index += 1) {
        const object = current.objects[`stroke-${index + 1}`];
        if (object?.bounds) dirty.markBounds(object.bounds);
      }
    });
    expect(cost).toBeLessThan(inkTimeBudget('tileResolveMs'));
  });
});

describe('hit testing', () => {
  it('finds the stroke under a tap without scanning the page', () => {
    // Stands in for the Phase 1 spatial index: tile membership narrows 10,000
    // strokes to the handful sharing a tile, and only those are tested.
    const current = scene();
    const samples = decodeSamples(strokeOf(current, 'stroke-5000').samples);
    const point = samples[Math.floor(samples.length / 2)];

    const candidateTiles = new Set(
      tilesForBounds({ minX: point.x, minY: point.y, maxX: point.x, maxY: point.y }).map(
        (key) => `${key.col}:${key.row}`,
      ),
    );
    const candidates = current.objectOrder.filter((id) => {
      const object = current.objects[id];
      if (object.type !== 'stroke' || !object.bounds) return false;
      return tilesForBounds(object.bounds).some((key) => candidateTiles.has(`${key.col}:${key.row}`));
    });
    expect(candidates.length).toBeLessThan(STROKE_COUNT / 10);

    let hit: string | null = null;
    const cost = elapsed(() => {
      for (let index = candidates.length - 1; index >= 0; index -= 1) {
        const stroke = strokeOf(current, candidates[index]);
        if (strokeHitTest(decodeSamples(stroke.samples), stroke.brush, point.x, point.y, 0)) {
          hit = candidates[index];
          break;
        }
      }
    });
    expect(hit).not.toBeNull();
    expect(cost).toBeLessThan(inkTimeBudget('hitTestMs'));
  });
});

describe('document lifecycle', () => {
  it('serializes a 10,000-stroke page within budget and within the size ceiling', () => {
    const current = scene();
    let json = '';
    const cost = elapsed(() => {
      json = JSON.stringify(current);
    });
    expect(cost).toBeLessThan(inkTimeBudget('pageSerializeMs'));
    expect(json.length).toBeLessThan(INK_PERFORMANCE_BUDGETS.tenThousandStrokeBytes);
  });

  it('parses and decodes a 10,000-stroke page within budget', () => {
    const json = JSON.stringify(scene());
    const cost = elapsed(() => {
      const parsed = JSON.parse(json) as InkScene;
      for (const id of parsed.objectOrder) {
        const object = parsed.objects[id];
        if (object.type === 'stroke') decodeSamples(object.samples);
      }
    });
    expect(cost).toBeLessThan(inkTimeBudget('pageOpenMs'));
  });

  it('rebuilds every stroke bound within the open budget', () => {
    // Bounds are derived, so opening a document that has none — or one written
    // by an older build — must not be slower than opening one that does.
    const current = scene();
    const decoded = decodeAll(current, current.objectOrder);
    const cost = elapsed(() => {
      for (const entry of decoded) strokeBounds(entry.samples, entry.brush);
    });
    expect(cost).toBeLessThan(inkTimeBudget('pageOpenMs'));
  });
});

describe('export', () => {
  it('exports a 10,000-stroke page to SVG within budget', () => {
    let svg = '';
    const cost = elapsed(() => {
      svg = sceneToSvg(scene());
    });
    expect(cost).toBeLessThan(inkTimeBudget('svgExportMs'));
    expect(svg.match(/<path/g)?.length).toBe(STROKE_COUNT);
  });
});
