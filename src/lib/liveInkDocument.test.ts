import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';

import type { InkDocument, InkText } from '../types/ink';

import { createInkDocument } from './ink/document';
import { addObject, removeObject, reorderObjects } from './ink/operations';
import { transformObject, translation } from './ink/transform';
import { reconcileInkMap } from './liveInkDocument';
import type { JsonObject } from './liveJsonDocument';
import { yToJson } from './liveJsonDocument';

function withText(): InkDocument {
  const document = createInkDocument({ name: 'Shared', timestamp: '2026-01-01T00:00:00.000Z' });
  const pageId = document.pageOrder[0];
  const page = document.pages[pageId];
  const layerId = page.scene.layerOrder[0];
  const text: InkText = {
    id: 'text-1',
    type: 'text',
    layerId,
    x: 10,
    y: 20,
    width: 300,
    height: 100,
    text: 'hello',
    color: '#111111',
    fontSize: 64,
  };
  return {
    ...document,
    pages: {
      ...document.pages,
      [pageId]: { ...page, scene: addObject(page.scene, text).result },
    },
  };
}

function write(doc: Y.Doc, document: InkDocument) {
  doc.transact(() => {
    reconcileInkMap(doc.getMap('doc'), document as unknown as JsonObject);
  });
}

function sync(from: Y.Doc, to: Y.Doc) {
  Y.applyUpdate(to, Y.encodeStateAsUpdate(from, Y.encodeStateVector(to)));
}

function read(doc: Y.Doc): InkDocument {
  return yToJson(doc.getMap('doc')) as unknown as InkDocument;
}

describe('live ink CRDT', () => {
  it('stores editable ink text as Y.Text', () => {
    const doc = new Y.Doc();
    write(doc, withText());
    const root = doc.getMap<unknown>('doc');
    const pages = root.get('pages') as Y.Map<unknown>;
    const page = pages.get('page-1') as Y.Map<unknown>;
    const scene = page.get('scene') as Y.Map<unknown>;
    const objects = scene.get('objects') as Y.Map<unknown>;
    const text = objects.get('text-1') as Y.Map<unknown>;
    expect(text.get('text')).toBeInstanceOf(Y.Text);
  });

  it('merges concurrent object additions by stable id', () => {
    const first = new Y.Doc();
    const second = new Y.Doc();
    const base = withText();
    write(first, base);
    sync(first, second);

    const pageId = base.pageOrder[0];
    const layerId = base.pages[pageId].scene.layerOrder[0];
    const add = (document: InkDocument, id: string) => {
      const page = document.pages[pageId];
      const scene = addObject(page.scene, {
        id,
        type: 'stamp',
        layerId,
        x: 0,
        y: 0,
        width: 100,
        height: 100,
        symbolId: 'star',
      }).result;
      return { ...document, pages: { ...document.pages, [pageId]: { ...page, scene } } };
    };
    write(first, add(read(first), 'first-stamp'));
    write(second, add(read(second), 'second-stamp'));
    sync(first, second);
    sync(second, first);

    const merged = read(first).pages[pageId].scene;
    expect(merged.objects).toMatchObject({
      'first-stamp': { id: 'first-stamp' },
      'second-stamp': { id: 'second-stamp' },
    });
    expect(merged.objectOrder).toEqual(expect.arrayContaining(['first-stamp', 'second-stamp']));
    expect(new Set(merged.objectOrder).size).toBe(merged.objectOrder.length);
  });

  it('merges concurrent edits inside ink text objects', () => {
    const first = new Y.Doc();
    const second = new Y.Doc();
    write(first, withText());
    sync(first, second);

    const editText = (doc: Y.Doc, suffix: string) => {
      const next = read(doc);
      const object = next.pages['page-1'].scene.objects['text-1'] as InkText;
      object.text += suffix;
      write(doc, next);
    };
    editText(first, ' A');
    editText(second, ' B');
    sync(first, second);
    sync(second, first);

    const merged = (read(first).pages['page-1'].scene.objects['text-1'] as InkText).text;
    expect(merged).toContain('A');
    expect(merged).toContain('B');
  });

  it('converges concurrent erase, transform, and reorder operations', () => {
    const first = new Y.Doc();
    const second = new Y.Doc();
    const base = withText();
    const pageId = base.pageOrder[0];
    const page = base.pages[pageId];
    const layerId = page.scene.layerOrder[0];
    let scene = page.scene;
    for (const [index, id] of ['erase-me', 'move-me', 'front-me'].entries()) {
      scene = addObject(scene, {
        id,
        type: 'stamp',
        layerId,
        x: index * 100,
        y: 0,
        width: 80,
        height: 80,
        symbolId: 'star',
      }).result;
    }
    write(first, { ...base, pages: { ...base.pages, [pageId]: { ...page, scene } } });
    sync(first, second);

    const erased = read(first);
    const erasedPage = erased.pages[pageId];
    write(first, {
      ...erased,
      pages: {
        ...erased.pages,
        [pageId]: { ...erasedPage, scene: removeObject(erasedPage.scene, 'erase-me').result },
      },
    });

    const transformed = read(second);
    const transformedPage = transformed.pages[pageId];
    const movedObject = transformObject(
      transformedPage.scene.objects['move-me'],
      translation(250, 125),
    );
    const transformedScene = reorderObjects(
      {
        ...transformedPage.scene,
        objects: { ...transformedPage.scene.objects, 'move-me': movedObject },
      },
      ['front-me'],
      'front',
    ).result;
    write(second, {
      ...transformed,
      pages: {
        ...transformed.pages,
        [pageId]: { ...transformedPage, scene: transformedScene },
      },
    });

    sync(first, second);
    sync(second, first);
    const merged = read(first).pages[pageId].scene;
    expect(merged.objects['erase-me']).toBeUndefined();
    expect(merged.objects['move-me']).toMatchObject({ x: 350, y: 125 });
    expect(merged.objectOrder[merged.objectOrder.length - 1]).toBe('front-me');
    expect(new Set(merged.objectOrder).size).toBe(merged.objectOrder.length);
  });
});
