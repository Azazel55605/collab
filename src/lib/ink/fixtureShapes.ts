/**
 * Malformed, migration, geometry, and large-document fixtures.
 *
 * `fixture.ts` builds *well-formed* documents for scale and rendering work.
 * These are the ones that are wrong on purpose: every case here is something a
 * real vault can contain — a file half-written when a process died, a document
 * from a newer build, a stroke whose layer record went missing in a bad merge —
 * and the normalizer's job is to open all of them rather than refuse.
 *
 * Kept beside the fixtures rather than inline in a test so Phases 2-9 test
 * against the same corpus instead of each inventing its own bad input.
 */

import { INK_DOCUMENT_KIND, INK_LIMITS, INK_SCHEMA_VERSION } from '../../types/ink';
import type { InkDocument } from '../../types/ink';
import { buildInkScene } from './fixture';

/** A document that should normalize cleanly, as the baseline to mutate. */
export function wellFormedInkDocument(): Record<string, unknown> {
  return {
    kind: INK_DOCUMENT_KIND,
    schemaVersion: INK_SCHEMA_VERSION,
    id: 'doc-1',
    name: 'Drawing',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    settings: { defaultPageMode: 'fixed', defaultBackground: { pattern: 'blank' } },
    pages: {
      'page-1': {
        id: 'page-1',
        mode: 'fixed',
        width: 38_098,
        height: 53_881,
        background: { pattern: 'ruled', spacing: 1_600 },
        scene: {
          layers: {
            'layer-1': {
              id: 'layer-1',
              name: 'Layer 1',
              visible: true,
              locked: false,
              opacity: 1,
            },
          },
          layerOrder: ['layer-1'],
          objects: {
            's1': {
              id: 's1',
              type: 'stroke',
              layerId: 'layer-1',
              brush: {
                kind: 'ballpoint',
                color: '#1f2933',
                opacity: 1,
                width: 96,
                thinning: 0.5,
                smoothing: 0.5,
                streamline: 0.4,
                taperStart: 0,
                taperEnd: 0,
              },
              samples: { x: [100, 10, 10], y: [200, 5, -5], p: [2048, 100, -200] },
            },
          },
          objectOrder: ['s1'],
        },
      },
    },
    pageOrder: ['page-1'],
    brushes: {},
    swatches: [],
  };
}

export interface MalformedInkCase {
  name: string;
  /** What the normalizer must do: open with repairs, or refuse outright. */
  expect: 'repairs' | 'throws';
  /** Error code when `expect` is `throws`. */
  code?: string;
  build: () => unknown;
}

/** Reads a nested path out of the baseline fixture, for mutation helpers. */
function withPage(mutate: (page: Record<string, any>) => void): Record<string, unknown> {
  const document = wellFormedInkDocument();
  mutate((document.pages as Record<string, any>)['page-1']);
  return document;
}

export const MALFORMED_INK_CASES: MalformedInkCase[] = [
  {
    name: 'object referencing a layer that no longer exists',
    expect: 'repairs',
    build: () =>
      withPage((page) => {
        page.scene.objects.s1.layerId = 'deleted-layer';
      }),
  },
  {
    name: 'object present in the map but missing from objectOrder',
    expect: 'repairs',
    build: () =>
      withPage((page) => {
        page.scene.objectOrder = [];
      }),
  },
  {
    name: 'layer present in the map but missing from layerOrder',
    expect: 'repairs',
    build: () =>
      withPage((page) => {
        page.scene.layerOrder = [];
      }),
  },
  {
    name: 'objectOrder naming an object that is not there',
    expect: 'repairs',
    build: () =>
      withPage((page) => {
        page.scene.objectOrder = ['s1', 'ghost'];
      }),
  },
  {
    name: 'stroke with mismatched sample channel lengths',
    expect: 'repairs',
    build: () =>
      withPage((page) => {
        page.scene.objects.s1.samples.p = [2048];
      }),
  },
  {
    name: 'stroke with a non-numeric coordinate delta',
    expect: 'repairs',
    build: () =>
      withPage((page) => {
        page.scene.objects.s1.samples.x = [100, 'ten', 10];
      }),
  },
  {
    name: 'stroke whose accumulated position leaves the world',
    expect: 'repairs',
    build: () =>
      withPage((page) => {
        page.scene.objects.s1.samples.x = [INK_LIMITS.worldExtent, INK_LIMITS.worldExtent];
        page.scene.objects.s1.samples.y = [0, 0];
      }),
  },
  {
    name: 'stroke with no samples at all',
    expect: 'repairs',
    build: () =>
      withPage((page) => {
        page.scene.objects.s1.samples = { x: [], y: [] };
      }),
  },
  {
    name: 'object of an unknown type',
    expect: 'repairs',
    build: () =>
      withPage((page) => {
        page.scene.objects.s1.type = 'hologram';
      }),
  },
  {
    name: 'image reaching outside the vault',
    expect: 'repairs',
    build: () =>
      withPage((page) => {
        page.scene.objects.i1 = {
          id: 'i1',
          type: 'image',
          layerId: 'layer-1',
          x: 0,
          y: 0,
          width: 100,
          height: 100,
          relativePath: '../../../etc/passwd',
        };
        page.scene.objectOrder.push('i1');
      }),
  },
  {
    name: 'image pointing at a remote URL',
    expect: 'repairs',
    build: () =>
      withPage((page) => {
        page.scene.objects.i1 = {
          id: 'i1',
          type: 'image',
          layerId: 'layer-1',
          x: 0,
          y: 0,
          width: 100,
          height: 100,
          relativePath: 'https://example.com/tracker.png',
        };
        page.scene.objectOrder.push('i1');
      }),
  },
  {
    name: 'page with no scene',
    expect: 'repairs',
    build: () =>
      withPage((page) => {
        delete page.scene;
      }),
  },
  {
    name: 'document with no pages',
    expect: 'repairs',
    build: () => ({ ...wellFormedInkDocument(), pages: {}, pageOrder: [] }),
  },
  {
    name: 'brush with out-of-range values',
    expect: 'repairs',
    build: () =>
      withPage((page) => {
        page.scene.objects.s1.brush.opacity = 42;
        page.scene.objects.s1.brush.thinning = -9;
      }),
  },
  {
    name: 'not an object',
    expect: 'throws',
    code: 'not-an-object',
    build: () => [1, 2, 3],
  },
  {
    name: 'wrong document kind',
    expect: 'throws',
    code: 'wrong-kind',
    build: () => ({ ...wellFormedInkDocument(), kind: 'collab-sheet' }),
  },
  {
    name: 'missing schema version',
    expect: 'throws',
    code: 'invalid-schema-version',
    build: () => {
      const document = wellFormedInkDocument();
      delete document.schemaVersion;
      return document;
    },
  },
  {
    name: 'zero schema version',
    expect: 'throws',
    code: 'invalid-schema-version',
    build: () => ({ ...wellFormedInkDocument(), schemaVersion: 0 }),
  },
  {
    name: 'stroke over the per-stroke sample limit',
    expect: 'throws',
    code: 'limit-exceeded',
    build: () =>
      withPage((page) => {
        const deltas = new Array(INK_LIMITS.samplesPerStroke + 1).fill(1);
        page.scene.objects.s1.samples = { x: deltas, y: deltas };
      }),
  },
  {
    name: 'more layers than a page may hold',
    expect: 'throws',
    code: 'limit-exceeded',
    build: () =>
      withPage((page) => {
        for (let index = 0; index <= INK_LIMITS.layersPerPage; index += 1) {
          const id = `extra-${index}`;
          page.scene.layers[id] = {
            id,
            name: id,
            visible: true,
            locked: false,
            opacity: 1,
          };
          page.scene.layerOrder.push(id);
        }
      }),
  },
  {
    name: 'text longer than the limit',
    expect: 'throws',
    code: 'limit-exceeded',
    build: () =>
      withPage((page) => {
        page.scene.objects.t1 = {
          id: 't1',
          type: 'text',
          layerId: 'layer-1',
          x: 0,
          y: 0,
          width: 100,
          height: 100,
          text: 'x'.repeat(INK_LIMITS.textLength + 1),
          color: '#000',
          fontSize: 12,
        };
        page.scene.objectOrder.push('t1');
      }),
  },
];

/**
 * A document from a hypothetical future schema version.
 *
 * Carries a field this build has no idea about, which is the point: opening it
 * read-only and never rewriting it is what keeps a vault shared between builds
 * from being corrupted by the older one.
 */
export function newerSchemaInkDocument(): Record<string, unknown> {
  const document = wellFormedInkDocument();
  document.schemaVersion = INK_SCHEMA_VERSION + 1;
  (document as Record<string, unknown>).inkFlowFields = { turbulence: 0.4 };
  return document;
}

/** Geometry edge cases a renderer and hit tester must survive. */
export function geometryEdgeCaseDocument(): Record<string, unknown> {
  return withPage((page) => {
    const brush = page.scene.objects.s1.brush;
    // A single-sample dot.
    page.scene.objects.dot = {
      id: 'dot',
      type: 'stroke',
      layerId: 'layer-1',
      brush,
      samples: { x: [5_000], y: [5_000] },
    };
    // A stroke that never moves: every sample identical.
    page.scene.objects.still = {
      id: 'still',
      type: 'stroke',
      layerId: 'layer-1',
      brush,
      samples: { x: [1_000, 0, 0, 0], y: [1_000, 0, 0, 0] },
    };
    // A stroke doubling back on itself exactly.
    page.scene.objects.doubled = {
      id: 'doubled',
      type: 'stroke',
      layerId: 'layer-1',
      brush,
      samples: { x: [0, 1_000, -1_000], y: [0, 0, 0] },
    };
    // Negative coordinates, which an infinite canvas has.
    page.scene.objects.negative = {
      id: 'negative',
      type: 'stroke',
      layerId: 'layer-1',
      brush,
      samples: { x: [-9_000, -500], y: [-9_000, -500] },
    };
    page.scene.objectOrder.push('dot', 'still', 'doubled', 'negative');
  });
}

/** A document at the scale Phase 10 has to stay usable at. */
export function largeInkDocument(options: {
  pages?: number;
  strokesPerPage?: number;
  samplesPerStroke?: number;
} = {}): InkDocument {
  const pageCount = options.pages ?? 20;
  const pages: Record<string, any> = {};
  const pageOrder: string[] = [];

  for (let index = 0; index < pageCount; index += 1) {
    const id = `page-${index + 1}`;
    pages[id] = {
      id,
      name: `Page ${index + 1}`,
      mode: 'fixed',
      width: 38_098,
      height: 53_881,
      background: { pattern: 'blank' },
      scene: buildInkScene({
        strokes: options.strokesPerPage ?? 500,
        samplesPerStroke: options.samplesPerStroke ?? 40,
        seed: index * 1_000 + 1,
        layers: 3,
      }),
    };
    pageOrder.push(id);
  }

  return {
    kind: INK_DOCUMENT_KIND,
    schemaVersion: INK_SCHEMA_VERSION,
    id: 'large',
    name: 'Large notebook',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    settings: { defaultPageMode: 'fixed', defaultBackground: { pattern: 'blank' } },
    pages,
    pageOrder,
    brushes: {},
    swatches: [],
  };
}
