import { describe, expect, it } from 'vitest';

import { INK_DOCUMENT_KIND, INK_LIMITS, INK_SCHEMA_VERSION } from '../../types/ink';
import {
  InkDocumentError,
  createInkDocument,
  createInkPage,
  inkDocumentStats,
  isVaultRelativePath,
  migrateInkDocument,
  normalizeInkDocument,
  parseInkDocument,
  serializeInkDocument,
} from './document';
import {
  MALFORMED_INK_CASES,
  geometryEdgeCaseDocument,
  largeInkDocument,
  newerSchemaInkDocument,
  wellFormedInkDocument,
} from './fixtureShapes';

describe('createInkDocument', () => {
  it('creates a document that normalizes without a single repair', () => {
    const document = createInkDocument({ name: 'Sketch', timestamp: '2026-01-01T00:00:00.000Z' });
    const inspection = normalizeInkDocument(JSON.parse(JSON.stringify(document)));
    expect(inspection.support).toBe('supported');
    expect(inspection.warnings).toEqual([]);
  });

  it('gives every page at least one layer', () => {
    // A scene with no layers has nowhere to put the next stroke.
    const page = createInkPage('page-1');
    expect(page.scene.layerOrder.length).toBeGreaterThan(0);
  });

  it('swaps the page dimensions for landscape', () => {
    const portrait = createInkPage('p', { preset: 'a4' });
    const landscape = createInkPage('p', { preset: 'a4', landscape: true });
    expect(landscape.width).toBe(portrait.height);
    expect(landscape.height).toBe(portrait.width);
  });
});

describe('normalizeInkDocument', () => {
  it('accepts a well-formed document unchanged', () => {
    const inspection = normalizeInkDocument(wellFormedInkDocument());
    expect(inspection.warnings).toEqual([]);
    expect(inspection.document.pageOrder).toEqual(['page-1']);
    expect(inspection.document.pages['page-1'].scene.objectOrder).toEqual(['s1']);
  });

  // The corpus is the point: every one of these is something a real vault can
  // contain, and a drawing app that refuses to open somebody's notebook over a
  // malformed layer record is worse than one that opens it repaired.
  describe.each(MALFORMED_INK_CASES)('$name', (testCase) => {
    it(`is handled by ${testCase.expect}`, () => {
      if (testCase.expect === 'throws') {
        try {
          normalizeInkDocument(testCase.build());
          throw new Error('expected normalization to throw');
        } catch (error) {
          expect(error).toBeInstanceOf(InkDocumentError);
          expect((error as InkDocumentError).code).toBe(testCase.code);
        }
        return;
      }
      const inspection = normalizeInkDocument(testCase.build());
      expect(inspection.support).toBe('supported');
      expect(inspection.document.pageOrder.length).toBeGreaterThan(0);
    });
  });

  it('moves an orphaned object to the bottom layer instead of dropping it', () => {
    // The rule that matters most in this file: an object is somebody's
    // handwriting, and a missing layer record must never cost them a stroke.
    const source = wellFormedInkDocument();
    (source.pages as any)['page-1'].scene.objects.s1.layerId = 'gone';

    const inspection = normalizeInkDocument(source);
    const scene = inspection.document.pages['page-1'].scene;
    expect(scene.objectOrder).toContain('s1');
    expect(scene.objects.s1.layerId).toBe(scene.layerOrder[0]);
    expect(inspection.warnings.join(' ')).toContain('missing layer');
  });

  it('reports every repair rather than applying it silently', () => {
    const source = wellFormedInkDocument();
    (source.pages as any)['page-1'].scene.objectOrder = [];
    const inspection = normalizeInkDocument(source);
    expect(inspection.warnings.length).toBeGreaterThan(0);
  });

  it('drops a truncated optional channel but keeps the stroke', () => {
    const source = wellFormedInkDocument();
    (source.pages as any)['page-1'].scene.objects.s1.samples.p = [2048];

    const inspection = normalizeInkDocument(source);
    const stroke = inspection.document.pages['page-1'].scene.objects.s1;
    expect(stroke.type).toBe('stroke');
    if (stroke.type === 'stroke') {
      expect(stroke.samples.p).toBeUndefined();
      expect(stroke.samples.x).toHaveLength(3);
    }
  });

  it('strips an image whose path reaches outside the vault', () => {
    // The one place a document names something outside itself, so the one place
    // document content could try to drive a fetch.
    for (const path of ['../secret.png', '/etc/passwd', 'https://example.com/x.png']) {
      const source = wellFormedInkDocument();
      (source.pages as any)['page-1'].scene.objects.i1 = {
        id: 'i1',
        type: 'image',
        layerId: 'layer-1',
        x: 0,
        y: 0,
        width: 10,
        height: 10,
        relativePath: path,
      };
      (source.pages as any)['page-1'].scene.objectOrder.push('i1');

      const inspection = normalizeInkDocument(source);
      expect(inspection.document.pages['page-1'].scene.objects.i1).toBeUndefined();
    }
  });

  it('keeps an ordinary vault-relative image', () => {
    const source = wellFormedInkDocument();
    (source.pages as any)['page-1'].scene.objects.i1 = {
      id: 'i1',
      type: 'image',
      layerId: 'layer-1',
      x: 0,
      y: 0,
      width: 10,
      height: 10,
      relativePath: 'Pictures/diagram.png',
    };
    (source.pages as any)['page-1'].scene.objectOrder.push('i1');
    expect(
      normalizeInkDocument(source).document.pages['page-1'].scene.objects.i1,
    ).toBeDefined();
  });

  it('clamps brush values into range rather than rejecting the stroke', () => {
    const source = wellFormedInkDocument();
    (source.pages as any)['page-1'].scene.objects.s1.brush.opacity = 42;
    (source.pages as any)['page-1'].scene.objects.s1.brush.thinning = -9;

    const stroke = normalizeInkDocument(source).document.pages['page-1'].scene.objects.s1;
    if (stroke.type === 'stroke') {
      expect(stroke.brush.opacity).toBe(1);
      expect(stroke.brush.thinning).toBe(-1);
    }
  });

  it('normalizes Phase 5 shapes, connectors, and sticky text at the trust boundary', () => {
    const source = wellFormedInkDocument();
    const scene = (source.pages as any)['page-1'].scene;
    scene.objects.shape = {
      id: 'shape', type: 'shape', layerId: 'layer-1', shape: 'rectangle',
      points: [0, 0, 100, 0, 100, 100, 0, 100],
      stroke: { kind: 'technical', color: '#123', opacity: 2, width: 64, thinning: 0, smoothing: 0, streamline: 0, taperStart: 0, taperEnd: 0 },
      fill: '#fff', fillOpacity: 2, arrowEnd: 'arrow',
    };
    scene.objects.connector = {
      id: 'connector', type: 'connector', layerId: 'layer-1',
      from: { x: 0, y: 0 }, to: { x: 100, y: 100 }, routing: 'orthogonal',
      stroke: scene.objects.shape.stroke, arrowEnd: 'arrow',
    };
    scene.objects.sticky = {
      id: 'sticky', type: 'text', layerId: 'layer-1', x: 0, y: 0,
      width: 100, height: 100, text: 'note', color: '#000', fontSize: 24,
      sticky: true, backgroundColor: '#ff0', align: 'center',
    };
    scene.objectOrder.push('shape', 'connector', 'sticky');

    const normalized = normalizeInkDocument(source).document.pages['page-1'].scene;
    expect(normalized.objects.shape).toMatchObject({ type: 'shape', fillOpacity: 1, arrowEnd: 'arrow' });
    expect(normalized.objects.connector).toMatchObject({ type: 'connector', routing: 'orthogonal', arrowEnd: 'arrow' });
    expect(normalized.objects.sticky).toMatchObject({ type: 'text', sticky: true, backgroundColor: '#ff0', align: 'center' });
  });

  it('keeps safe object links and equations while dropping unsafe links', () => {
    const source = wellFormedInkDocument();
    const scene = (source.pages as any)['page-1'].scene;
    scene.objects.s1.link = { kind: 'url', target: 'javascript:alert(1)' };
    scene.objects.equation = {
      id: 'equation', type: 'text', layerId: 'layer-1', x: 0, y: 0,
      width: 100, height: 50, text: 'x^2', color: '#000', fontSize: 24,
      equation: true, link: { kind: 'vault', target: 'Notes/Math.md' },
    };
    scene.objectOrder.push('equation');
    const normalized = normalizeInkDocument(source).document.pages['page-1'].scene;
    expect(normalized.objects.s1.link).toBeUndefined();
    expect(normalized.objects.equation).toMatchObject({
      type: 'text', equation: true, link: { kind: 'vault', target: 'Notes/Math.md' },
    });
  });

  it('preserves fields it does not understand', () => {
    // A file written by a newer build has to survive a round trip through an
    // older one, or a shared vault degrades every time it is opened.
    const source = wellFormedInkDocument();
    (source as any).futureField = { keep: 'me' };
    (source.pages as any)['page-1'].futurePageField = 7;
    (source.pages as any)['page-1'].scene.layers['layer-1'].futureLayerField = true;

    const { document } = normalizeInkDocument(source);
    expect((document as any).futureField).toEqual({ keep: 'me' });
    expect((document.pages['page-1'] as any).futurePageField).toBe(7);
    expect((document.pages['page-1'].scene.layers['layer-1'] as any).futureLayerField).toBe(true);
  });
});

describe('newer schema versions', () => {
  it('opens read-only without normalizing', () => {
    const inspection = normalizeInkDocument(newerSchemaInkDocument());
    expect(inspection.support).toBe('newer');
    expect(inspection.schemaVersion).toBe(INK_SCHEMA_VERSION + 1);
    // Untouched: normalizing would strip the fields this build cannot see, and
    // writing that back would corrupt the file for the build that made it.
    expect((inspection.document as any).inkFlowFields).toEqual({ turbulence: 0.4 });
  });
});

describe('parseInkDocument', () => {
  it('parses serialized output back to an equal document', () => {
    const document = createInkDocument({ name: 'Round trip', timestamp: '2026-01-01T00:00:00.000Z' });
    const { document: parsed } = parseInkDocument(serializeInkDocument(document));
    expect(parsed).toEqual(document);
  });

  it('reports invalid JSON distinctly from an invalid document', () => {
    try {
      parseInkDocument('{ not json');
      throw new Error('expected a throw');
    } catch (error) {
      expect((error as InkDocumentError).code).toBe('invalid-json');
    }
  });

  it('refuses a document over the byte limit before parsing it', () => {
    const oversized = 'x'.repeat(INK_LIMITS.documentBytes + 1);
    try {
      parseInkDocument(oversized);
      throw new Error('expected a throw');
    } catch (error) {
      expect((error as InkDocumentError).code).toBe('limit-exceeded');
    }
  });
});

describe('serializeInkDocument', () => {
  it('is deterministic regardless of key insertion order', () => {
    // Without this, a save after a reorder rewrites the whole file and every
    // revision diff is noise.
    const a = createInkDocument({ name: 'A', timestamp: '2026-01-01T00:00:00.000Z' });
    const reordered = JSON.parse(
      JSON.stringify({
        pageOrder: a.pageOrder,
        pages: a.pages,
        swatches: a.swatches,
        brushes: a.brushes,
        settings: a.settings,
        updatedAt: a.updatedAt,
        createdAt: a.createdAt,
        name: a.name,
        id: a.id,
        schemaVersion: a.schemaVersion,
        kind: a.kind,
      }),
    );
    expect(serializeInkDocument(reordered)).toBe(serializeInkDocument(a));
  });

  it('ends with a newline', () => {
    const document = createInkDocument({ name: 'N', timestamp: '2026-01-01T00:00:00.000Z' });
    expect(serializeInkDocument(document).endsWith('\n')).toBe(true);
  });
});

describe('migrateInkDocument', () => {
  it('is a no-op at the current version', () => {
    const document = createInkDocument({ name: 'M', timestamp: '2026-01-01T00:00:00.000Z' });
    const result = migrateInkDocument(document, INK_SCHEMA_VERSION);
    expect(result.document).toEqual(document);
    expect(result.warnings).toEqual([]);
  });

  it('stamps the current version and reports a gap it cannot bridge', () => {
    // Version 1 is the first schema, so there is nothing to migrate yet. The
    // dispatch exists now so adding version 2 is a step, not a retrofit.
    const document = createInkDocument({ name: 'M', timestamp: '2026-01-01T00:00:00.000Z' });
    const result = migrateInkDocument({ ...document, schemaVersion: 0 }, 0);
    expect(result.document.schemaVersion).toBe(INK_SCHEMA_VERSION);
    expect(result.warnings.join(' ')).toContain('no migration');
  });
});

describe('geometry edge cases', () => {
  it('opens every degenerate stroke shape', () => {
    const inspection = normalizeInkDocument(geometryEdgeCaseDocument());
    const scene = inspection.document.pages['page-1'].scene;
    for (const id of ['dot', 'still', 'doubled', 'negative']) {
      expect(scene.objects[id]).toBeDefined();
    }
  });
});

describe('large documents', () => {
  it('normalizes a 20-page notebook and counts it correctly', () => {
    const document = largeInkDocument({ pages: 20, strokesPerPage: 200 });
    const inspection = normalizeInkDocument(JSON.parse(JSON.stringify(document)));
    expect(inspection.warnings).toEqual([]);

    const stats = inkDocumentStats(inspection.document);
    expect(stats.pages).toBe(20);
    expect(stats.strokes).toBe(20 * 200);
    expect(stats.samples).toBe(20 * 200 * 40);
  });

  it('refuses a document over the whole-document object limit', () => {
    const document = normalizeInkDocument(
      JSON.parse(JSON.stringify(largeInkDocument({ pages: 1, strokesPerPage: 10 }))),
    ).document;
    const scene = document.pages['page-1'].scene;
    // Synthesize past the ceiling without building it stroke by stroke.
    const objects: Record<string, unknown> = {};
    const order: string[] = [];
    const template = scene.objects[scene.objectOrder[0]];
    for (let index = 0; index <= INK_LIMITS.objectsPerPage; index += 1) {
      const id = `s-${index}`;
      objects[id] = { ...template, id };
      order.push(id);
    }
    const oversized = {
      ...document,
      pages: {
        'page-1': {
          ...document.pages['page-1'],
          scene: { ...scene, objects, objectOrder: order },
        },
      },
    };

    try {
      normalizeInkDocument(JSON.parse(JSON.stringify(oversized)));
      throw new Error('expected a throw');
    } catch (error) {
      expect((error as InkDocumentError).code).toBe('limit-exceeded');
    }
  });
});

describe('isVaultRelativePath', () => {
  it('accepts ordinary vault paths', () => {
    expect(isVaultRelativePath('Pictures/a.png')).toBe(true);
    expect(isVaultRelativePath('a b/c-d_e.svg')).toBe(true);
  });

  it('rejects absolute paths, traversal, and schemes', () => {
    expect(isVaultRelativePath('/etc/passwd')).toBe(false);
    expect(isVaultRelativePath('\\\\server\\share')).toBe(false);
    expect(isVaultRelativePath('../secret')).toBe(false);
    expect(isVaultRelativePath('a/../../b')).toBe(false);
    expect(isVaultRelativePath('https://example.com/x.png')).toBe(false);
    expect(isVaultRelativePath('file:///tmp/x')).toBe(false);
    expect(isVaultRelativePath('data:image/png;base64,AAAA')).toBe(false);
    expect(isVaultRelativePath('')).toBe(false);
  });
});

describe('inkDocumentStats', () => {
  it('counts only pages that exist', () => {
    const document = createInkDocument({ name: 'S', timestamp: '2026-01-01T00:00:00.000Z' });
    const stats = inkDocumentStats({ ...document, pageOrder: [...document.pageOrder, 'ghost'] });
    expect(stats.pages).toBe(1);
  });

  it('reports the document kind it was built for', () => {
    expect(createInkDocument({ name: 'K' }).kind).toBe(INK_DOCUMENT_KIND);
  });
});
