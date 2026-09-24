import { describe, expect, it } from 'vitest';

import { PDF_SIDECAR_SCHEMA_VERSION } from '../types/pdf';

import {
  createPdfInkDocument,
  migratePdfSidecar,
  pdfInkPage,
  pdfInkSurface,
  updatePdfInkSurface,
} from './pdfAnnotations';

describe('PDF annotation sidecar migration', () => {
  it('preserves every legacy annotation collection while adding anchored ink', () => {
    const legacy = {
      bookmarks: [{ id: 'bookmark', page: 2, createdAt: 1, updatedAt: 2 }],
      highlights: [
        { id: 'highlight', page: 1, text: 'Keep me', rects: [], createdAt: 3, updatedAt: 4 },
      ],
      textAnnotations: [
        {
          id: 'text',
          page: 1,
          text: 'Note',
          left: 0,
          top: 0,
          width: 0.2,
          height: 0.1,
          createdAt: 5,
          updatedAt: 6,
        },
      ],
      pageComments: [{ id: 'comment', page: 3, content: 'Review', createdAt: 7, updatedAt: 8 }],
      viewerState: { lastPage: 3 },
    };

    const result = migratePdfSidecar(legacy, 'Docs/paper.pdf', 8);

    expect(result.migrated).toBe(true);
    expect(result.state.schemaVersion).toBe(PDF_SIDECAR_SCHEMA_VERSION);
    expect(result.state.bookmarks).toEqual(legacy.bookmarks);
    expect(result.state.highlights).toEqual(legacy.highlights);
    expect(result.state.textAnnotations).toEqual(legacy.textAnnotations);
    expect(result.state.pageComments).toEqual(legacy.pageComments);
    expect(result.state.viewerState).toEqual(legacy.viewerState);
    expect(result.state.ink).toMatchObject({
      kind: 'collab-annotations',
      source: { relativePath: 'Docs/paper.pdf', pageCount: 8 },
      surfaceOrder: [],
    });
  });

  it('treats a native legacy null ink field as an empty sidecar without a repair warning', () => {
    const result = migratePdfSidecar(
      {
        bookmarks: [],
        highlights: [],
        textAnnotations: [],
        pageComments: [],
        ink: null,
      },
      'Docs/legacy.pdf',
      3,
    );

    expect(result.warnings).toEqual([]);
    expect(result.state.ink).toMatchObject({
      kind: 'collab-annotations',
      source: { relativePath: 'Docs/legacy.pdf', pageCount: 3 },
      surfaceOrder: [],
    });
  });

  it('stores page geometry in source points and scene geometry in ink units', () => {
    const document = createPdfInkDocument('paper.pdf', 1);
    const updated = updatePdfInkSurface(document, 1, 612, 792, (scene) => ({
      ...scene,
      objectOrder: ['stroke-1'],
    }));
    const surface = pdfInkSurface(updated, 1);

    expect(surface?.anchor).toEqual({ kind: 'pdf-page', page: 1, width: 612, height: 792 });
    expect(surface && pdfInkPage(surface)).toMatchObject({ width: 612 * 64, height: 792 * 64 });
  });

  it('tolerates absent and structurally incomplete ink during a PDF load transition', () => {
    expect(pdfInkSurface(undefined, 1)).toBeNull();
    expect(
      pdfInkSurface(
        {
          kind: 'collab-annotations',
          schemaVersion: 1,
          source: { relativePath: 'paper.pdf' },
          surfaces: { broken: { id: 'broken' } },
          surfaceOrder: ['broken'],
        } as never,
        1,
      ),
    ).toBeNull();
  });

  it('keeps existing anchored surfaces when the source path changes', () => {
    const original = updatePdfInkSurface(
      createPdfInkDocument('old.pdf', 1),
      1,
      400,
      500,
      (scene) => ({
        ...scene,
        objects: {
          'stamp-1': {
            id: 'stamp-1',
            type: 'stamp',
            layerId: 'pdf-page-1-layer-1',
            x: 100,
            y: 100,
            width: 800,
            height: 800,
            symbolId: 'check',
          },
        },
        objectOrder: ['stamp-1'],
      }),
    );
    const migrated = migratePdfSidecar(
      { bookmarks: [], highlights: [], textAnnotations: [], pageComments: [], ink: original },
      'Moved/new.pdf',
      1,
    );

    expect(migrated.state.ink?.source.relativePath).toBe('Moved/new.pdf');
    expect(migrated.state.ink?.surfaces['pdf-page-1'].scene.objectOrder).toEqual(['stamp-1']);
  });
});
