import { beforeEach, describe, expect, it } from 'vitest';

import { createInkDocument } from '../../../../src/lib/ink/document';
import { INK_LIMITS } from '../../../../src/types/ink';
import type { HostedFileEntry } from '../mobileTauri';

import {
  clampInkScale,
  clearInkViewState,
  drawingName,
  INK_MOBILE_SCALE,
  inspectInkContent,
  isInkFile,
  loadInkViewState,
  saveInkViewState,
  serializeInk,
} from './ink';

function entry(overrides: Partial<HostedFileEntry> = {}): HostedFileEntry {
  return {
    id: 'f1',
    parentId: null,
    name: 'Ideas.ink',
    relativePath: 'Ideas.ink',
    kind: 'document',
    documentType: 'ink',
    state: 'active',
    updatedAt: null,
    sizeBytes: 10,
    contentHash: 'h',
    revisionSequence: 1,
    ...overrides,
  };
}

describe('isInkFile', () => {
  it('accepts the hosted document type and the extension', () => {
    expect(isInkFile(entry())).toBe(true);
    // A drawing uploaded before `ink` existed as a hosted type is stored as a
    // note; the extension still identifies it.
    expect(isInkFile(entry({ documentType: 'note' }))).toBe(true);
  });

  it('rejects folders and other documents', () => {
    expect(isInkFile(entry({ kind: 'folder', documentType: null as never }))).toBe(false);
    expect(
      isInkFile(
        entry({ name: 'Budget.sheet', relativePath: 'Budget.sheet', documentType: 'sheet' }),
      ),
    ).toBe(false);
  });
});

describe('inspectInkContent', () => {
  it('round-trips a document through serialize and parse', () => {
    const document = createInkDocument({ name: 'Ideas', timestamp: '2026-01-01T00:00:00.000Z' });
    const inspected = inspectInkContent(serializeInk(document));
    expect(inspected.document).toEqual(document);
    expect(inspected.support).toBe('supported');
    expect(inspected.warnings).toEqual([]);
  });

  it('throws rather than returning an empty drawing', () => {
    // A blank page the user could draw on and save over the top of their work
    // is worse than an error.
    expect(() => inspectInkContent('{ not json')).toThrow();
    expect(() => inspectInkContent('{"kind":"collab-sheet","schemaVersion":1}')).toThrow();
  });

  it('reports a newer schema without normalizing it', () => {
    const document = JSON.parse(
      serializeInk(createInkDocument({ name: 'X', timestamp: '2026-01-01T00:00:00.000Z' })),
    );
    document.schemaVersion = 99;
    document.futureField = { keep: 'me' };

    const inspected = inspectInkContent(JSON.stringify(document));
    expect(inspected.support).toBe('newer');
    expect((inspected.document as unknown as Record<string, unknown>).futureField).toEqual({
      keep: 'me',
    });
  });

  it('surfaces repairs rather than applying them silently', () => {
    const document = JSON.parse(
      serializeInk(createInkDocument({ name: 'X', timestamp: '2026-01-01T00:00:00.000Z' })),
    );
    const pageId = document.pageOrder[0];
    document.pages[pageId].scene.objects.orphan = {
      id: 'orphan',
      type: 'stroke',
      layerId: 'gone',
      brush: {
        kind: 'ballpoint',
        color: '#000',
        opacity: 1,
        width: 96,
        thinning: 0.5,
        smoothing: 0.5,
        streamline: 0.4,
        taperStart: 0,
        taperEnd: 0,
      },
      samples: { x: [0, 1], y: [0, 1] },
    };
    document.pages[pageId].scene.objectOrder = ['orphan'];

    const inspected = inspectInkContent(JSON.stringify(document));
    expect(inspected.warnings.length).toBeGreaterThan(0);
    // Repaired, not dropped — it is somebody's handwriting.
    expect(inspected.document.pages[pageId].scene.objects.orphan).toBeTruthy();
  });
});

describe('drawingName', () => {
  it('drops the extension', () => {
    expect(drawingName(entry())).toBe('Ideas');
    expect(drawingName(entry({ name: 'NOTES.INK' }))).toBe('NOTES');
  });

  it('falls back to the whole name when there is nothing left', () => {
    expect(drawingName(entry({ name: '.ink' }))).toBe('.ink');
  });
});

describe('clampInkScale', () => {
  it('stays inside the mobile bounds and the shared world limits', () => {
    expect(clampInkScale(0.0001)).toBe(INK_MOBILE_SCALE.min);
    expect(clampInkScale(1_000)).toBe(INK_MOBILE_SCALE.max);
    expect(clampInkScale(Number.NaN)).toBe(INK_MOBILE_SCALE.default);
    expect(INK_MOBILE_SCALE.min).toBeGreaterThanOrEqual(INK_LIMITS.minZoom);
    expect(INK_MOBILE_SCALE.max).toBeLessThanOrEqual(INK_LIMITS.maxZoom);
  });
});

describe('view state across process recreation', () => {
  beforeEach(() => {
    globalThis.sessionStorage.clear();
  });

  it('round-trips per file', () => {
    saveInkViewState('a', { pageId: 'page-1', originX: 100, originY: 200, zoom: 2 });
    saveInkViewState('b', { pageId: 'page-9', originX: 5, originY: 6, zoom: 0.5 });

    expect(loadInkViewState('a')).toEqual({
      pageId: 'page-1',
      originX: 100,
      originY: 200,
      zoom: 2,
    });
    expect(loadInkViewState('b')?.pageId).toBe('page-9');
  });

  it('is null for a file that has none', () => {
    expect(loadInkViewState('never-opened')).toBeNull();
  });

  it('clamps a restored zoom into range', () => {
    saveInkViewState('a', { pageId: 'p', originX: 0, originY: 0, zoom: 9_999 });
    expect(loadInkViewState('a')!.zoom).toBe(INK_MOBILE_SCALE.max);
  });

  it('ignores a corrupt record rather than failing to open the drawing', () => {
    globalThis.sessionStorage.setItem('collab.ink.viewState', 'not json');
    expect(loadInkViewState('a')).toBeNull();
    // And a later write repairs the store.
    saveInkViewState('a', { pageId: 'p', originX: 1, originY: 2, zoom: 1 });
    expect(loadInkViewState('a')?.originX).toBe(1);
  });

  it('ignores a record with a non-numeric zoom', () => {
    globalThis.sessionStorage.setItem(
      'collab.ink.viewState',
      JSON.stringify({ a: { pageId: 'p', originX: 0, originY: 0, zoom: 'big' } }),
    );
    expect(loadInkViewState('a')).toBeNull();
  });

  it('forgets a file on request', () => {
    saveInkViewState('a', { pageId: 'p', originX: 1, originY: 2, zoom: 1 });
    clearInkViewState('a');
    expect(loadInkViewState('a')).toBeNull();
  });
});
