import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';

import { type JsonObject, reconcileMap, toShared, yToJson } from './liveJsonDocument';

function withMap(initial: JsonObject): { doc: Y.Doc; root: Y.Map<unknown> } {
  const doc = new Y.Doc();
  const root = doc.getMap<unknown>('doc');
  doc.transact(() => reconcileMap(root, initial));
  return { doc, root };
}

describe('liveJsonDocument reconciler', () => {
  it('round-trips nested objects, arrays, and primitives', () => {
    const value: JsonObject = {
      title: 'Board',
      count: 3,
      flag: true,
      nothing: null,
      columns: [{ id: 'c1', name: 'To Do', cards: [{ id: 'k1', text: 'hi' }] }],
    };
    const { root } = withMap(value);
    expect(yToJson(root)).toEqual(value);
  });

  it('normalizes Yjs bigint values into JSON numbers and reconciles them safely', () => {
    const doc = new Y.Doc();
    const root = doc.getMap<unknown>('doc');
    doc.transact(() => {
      root.set('viewport', toShared({ x: 0n, y: 24n, zoom: 1n } as unknown as JsonObject));
    });

    expect(yToJson(root)).toEqual({ viewport: { x: 0, y: 24, zoom: 1 } });
    expect(() => {
      doc.transact(() =>
        reconcileMap(root, {
          viewport: { x: 0, y: 24, zoom: 1 },
        }),
      );
    }).not.toThrow();
  });

  it('applies minimal field edits, additions, and deletions', () => {
    const { doc, root } = withMap({ a: 1, b: 'x', nested: { keep: true, drop: 1 } });
    doc.transact(() => reconcileMap(root, { a: 2, c: 'new', nested: { keep: true } }));
    expect(yToJson(root)).toEqual({ a: 2, c: 'new', nested: { keep: true } });
    expect(root.has('b')).toBe(false);
  });

  it('reconciles id-keyed arrays by id, preserving untouched item identity', () => {
    const { doc, root } = withMap({
      cards: [
        { id: 'a', title: 'Apple' },
        { id: 'b', title: 'Banana' },
      ],
    });
    const cards = root.get('cards') as Y.Array<unknown>;
    const itemBBefore = cards.get(1);

    // Edit only card "a".
    doc.transact(() =>
      reconcileMap(root, {
        cards: [
          { id: 'a', title: 'Apricot' },
          { id: 'b', title: 'Banana' },
        ],
      }),
    );

    // Card "b" keeps its shared-type identity (its field edit was not churned).
    expect(cards.get(1)).toBe(itemBBefore);
    expect(yToJson(root)).toEqual({
      cards: [
        { id: 'a', title: 'Apricot' },
        { id: 'b', title: 'Banana' },
      ],
    });
  });

  it('handles array insertion and removal by id', () => {
    const { doc, root } = withMap({ cards: [{ id: 'a' }, { id: 'b' }, { id: 'c' }] });
    doc.transact(() => reconcileMap(root, { cards: [{ id: 'a' }, { id: 'c' }, { id: 'd' }] }));
    expect(yToJson(root)).toEqual({ cards: [{ id: 'a' }, { id: 'c' }, { id: 'd' }] });
  });

  it('merges concurrent edits to different items across two documents', () => {
    const base: JsonObject = {
      cards: [
        { id: 'c1', title: 'One' },
        { id: 'c2', title: 'Two' },
      ],
    };
    const a = new Y.Doc();
    const b = new Y.Doc();
    const ra = a.getMap<unknown>('doc');
    a.transact(() => reconcileMap(ra, base));
    // Sync B from A's initial state.
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
    const rb = b.getMap<unknown>('doc');

    // Concurrent edits: A edits c1, B edits c2.
    a.transact(() =>
      reconcileMap(ra, {
        cards: [
          { id: 'c1', title: 'One-A' },
          { id: 'c2', title: 'Two' },
        ],
      }),
    );
    b.transact(() =>
      reconcileMap(rb, {
        cards: [
          { id: 'c1', title: 'One' },
          { id: 'c2', title: 'Two-B' },
        ],
      }),
    );

    // Exchange deltas.
    const fromA = Y.encodeStateAsUpdate(a, Y.encodeStateVector(b));
    const fromB = Y.encodeStateAsUpdate(b, Y.encodeStateVector(a));
    Y.applyUpdate(b, fromA);
    Y.applyUpdate(a, fromB);

    expect(yToJson(ra)).toEqual(yToJson(rb));
    expect(yToJson(ra)).toEqual({
      cards: [
        { id: 'c1', title: 'One-A' },
        { id: 'c2', title: 'Two-B' },
      ],
    });
  });

  it('converges concurrent inserts into stable string identity arrays', () => {
    const base: JsonObject = { rowOrder: ['r1', 'r2'] };
    const a = new Y.Doc();
    const b = new Y.Doc();
    const ra = a.getMap<unknown>('doc');
    a.transact(() => reconcileMap(ra, base));
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
    const rb = b.getMap<unknown>('doc');

    a.transact(() => reconcileMap(ra, { rowOrder: ['r1', 'row-a', 'r2'] }));
    b.transact(() => reconcileMap(rb, { rowOrder: ['r1', 'row-b', 'r2'] }));

    const fromA = Y.encodeStateAsUpdate(a, Y.encodeStateVector(b));
    const fromB = Y.encodeStateAsUpdate(b, Y.encodeStateVector(a));
    Y.applyUpdate(b, fromA);
    Y.applyUpdate(a, fromB);

    const order = (yToJson(ra) as JsonObject).rowOrder as string[];
    expect(yToJson(ra)).toEqual(yToJson(rb));
    expect(order[0]).toBe('r1');
    expect(order[order.length - 1]).toBe('r2');
    expect(new Set(order)).toEqual(new Set(['r1', 'row-a', 'row-b', 'r2']));
  });

  it('reconciles unique string arrays by identity', () => {
    const { doc, root } = withMap({ tags: ['a', 'b', 'c'] });
    doc.transact(() => reconcileMap(root, { tags: ['x', 'y'] }));
    expect(yToJson(root)).toEqual({ tags: ['x', 'y'] });
  });

  it('toShared builds nested shared types once integrated', () => {
    const doc = new Y.Doc();
    const root = doc.getMap<unknown>('doc');
    doc.transact(() => root.set('v', toShared({ a: [{ id: '1' }] })));
    const inner = root.get('v');
    expect(inner).toBeInstanceOf(Y.Map);
    expect((inner as Y.Map<unknown>).get('a')).toBeInstanceOf(Y.Array);
  });
});
