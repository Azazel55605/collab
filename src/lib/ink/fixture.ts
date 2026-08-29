/**
 * Deterministic `.ink` fixtures.
 *
 * Phase 0 uses these to prove the model at scale: a page carrying ten thousand
 * representative strokes with real pressure variation. Later phases reuse them
 * for renderer, export, collaboration, and migration tests, so generation must
 * stay deterministic — no `Math.random`, no clock reads. The pseudo-random
 * source below is seeded and reproducible.
 */
import {
  INK_DOCUMENT_KIND,
  INK_PAGE_PRESETS,
  INK_SAMPLE_RANGES,
  INK_SCHEMA_VERSION,
} from '../../types/ink';
import type {
  InkBrushParameters,
  InkDocument,
  InkPage,
  InkSample,
  InkScene,
  InkStroke,
} from '../../types/ink';

import { encodeSamples } from './codec';
import { strokeBounds } from './stroke';

const FIXED_TIMESTAMP = '2026-01-01T00:00:00.000Z';

/** Mulberry32 — small, fast, and reproducible across platforms. */
export function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const FIXTURE_BRUSH: InkBrushParameters = {
  kind: 'ballpoint',
  color: '#1f2933',
  opacity: 1,
  width: 96,
  thinning: 0.55,
  smoothing: 0.5,
  streamline: 0.4,
  taperStart: 0,
  taperEnd: 0,
};

export interface InkStrokeFixtureOptions {
  seed?: number;
  samples: number;
  /** Origin of the stroke, in ink units. */
  x: number;
  y: number;
  /** Nominal length of the stroke, in ink units. */
  length?: number;
  /** Emit a pressure channel. */
  pressure?: boolean;
  tilt?: boolean;
  /** Milliseconds between samples. */
  sampleIntervalMs?: number;
}

/**
 * One handwriting-shaped stroke.
 *
 * Not a straight line: a straight line simplifies to two samples and would make
 * every size and performance measurement meaningless. This traces a wobbling
 * arc with pressure that rises and falls, which is what real writing costs.
 */
export function buildStrokeSamples(options: InkStrokeFixtureOptions): InkSample[] {
  const random = seededRandom(options.seed ?? 1);
  const length = options.length ?? 4_000;
  const interval = options.sampleIntervalMs ?? 8;
  const samples: InkSample[] = [];

  for (let index = 0; index < options.samples; index += 1) {
    const progress = options.samples === 1 ? 0 : index / (options.samples - 1);
    const wobble = Math.sin(progress * Math.PI * 6) * length * 0.08;
    const jitter = (random() - 0.5) * 24;
    const sample: InkSample = {
      x: Math.round(options.x + progress * length + jitter),
      y: Math.round(options.y + wobble + jitter),
    };
    if (options.pressure !== false) {
      // Press on entering the stroke, ease off leaving it.
      const curve = Math.sin(Math.PI * progress) * 0.65 + 0.3;
      sample.pressure = Math.round(
        Math.min(1, Math.max(0, curve + (random() - 0.5) * 0.05)) * INK_SAMPLE_RANGES.pressureMax,
      );
    }
    if (options.tilt) {
      sample.tiltX = Math.round(-30 + Math.sin(progress * Math.PI * 2) * 12);
      sample.tiltY = Math.round(20 + Math.cos(progress * Math.PI * 2) * 8);
    }
    sample.elapsed = index * interval;
    samples.push(sample);
  }
  return samples;
}

export function buildStroke(
  id: string,
  layerId: string,
  options: InkStrokeFixtureOptions,
  brush: InkBrushParameters = FIXTURE_BRUSH,
): InkStroke {
  const samples = buildStrokeSamples(options);
  return {
    id,
    type: 'stroke',
    layerId,
    brush,
    samples: encodeSamples(samples),
    bounds: strokeBounds(samples, brush),
  };
}

export interface InkSceneFixtureOptions {
  strokes: number;
  samplesPerStroke?: number;
  seed?: number;
  layers?: number;
  pressure?: boolean;
  /** Ink-unit extent the strokes are distributed over. */
  spreadX?: number;
  spreadY?: number;
}

/** A scene holding `strokes` strokes laid out across the page. */
export function buildInkScene(options: InkSceneFixtureOptions): InkScene {
  const layerCount = Math.max(1, options.layers ?? 1);
  const samplesPerStroke = options.samplesPerStroke ?? 64;
  const spreadX = options.spreadX ?? INK_PAGE_PRESETS.a4.width;
  const spreadY = options.spreadY ?? INK_PAGE_PRESETS.a4.height;

  const scene: InkScene = { layers: {}, layerOrder: [], objects: {}, objectOrder: [] };
  for (let index = 0; index < layerCount; index += 1) {
    const id = `layer-${index + 1}`;
    scene.layers[id] = {
      id,
      name: `Layer ${index + 1}`,
      visible: true,
      locked: false,
      opacity: 1,
    };
    scene.layerOrder.push(id);
  }

  // Lay strokes out on a grid so bounds are spread across tiles rather than
  // stacked at the origin — a tiled renderer measured against one tile has not
  // been measured.
  const columns = Math.max(1, Math.ceil(Math.sqrt(options.strokes)));
  for (let index = 0; index < options.strokes; index += 1) {
    const column = index % columns;
    const row = Math.floor(index / columns);
    const id = `stroke-${index + 1}`;
    scene.objects[id] = buildStroke(id, scene.layerOrder[index % layerCount], {
      seed: (options.seed ?? 1) + index,
      samples: samplesPerStroke,
      x: Math.round((column / columns) * spreadX),
      y: Math.round((row / columns) * spreadY),
      length: Math.round(spreadX / columns) || 1,
      pressure: options.pressure,
    });
    scene.objectOrder.push(id);
  }
  return scene;
}

export interface InkDocumentFixtureOptions extends InkSceneFixtureOptions {
  pages?: number;
  name?: string;
}

export function buildInkDocument(options: InkDocumentFixtureOptions): InkDocument {
  const pageCount = Math.max(1, options.pages ?? 1);
  const pages: Record<string, InkPage> = {};
  const pageOrder: string[] = [];

  for (let index = 0; index < pageCount; index += 1) {
    const id = `page-${index + 1}`;
    pages[id] = {
      id,
      name: `Page ${index + 1}`,
      mode: 'fixed',
      width: INK_PAGE_PRESETS.a4.width,
      height: INK_PAGE_PRESETS.a4.height,
      background: { pattern: 'blank' },
      scene: buildInkScene({ ...options, seed: (options.seed ?? 1) + index * 10_000 }),
    };
    pageOrder.push(id);
  }

  return {
    kind: INK_DOCUMENT_KIND,
    schemaVersion: INK_SCHEMA_VERSION,
    id: 'ink-fixture',
    name: options.name ?? 'Fixture',
    createdAt: FIXED_TIMESTAMP,
    updatedAt: FIXED_TIMESTAMP,
    settings: {
      defaultPageMode: 'fixed',
      defaultBackground: { pattern: 'blank' },
    },
    pages,
    pageOrder,
    brushes: {
      default: { id: 'default', name: 'Ballpoint', ...FIXTURE_BRUSH },
    },
    swatches: [{ id: 'ink', color: '#1f2933' }],
  };
}
