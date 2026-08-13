import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';

import { INK_LIMITS } from '../../types/ink';
import type { InkSample, InkStroke } from '../../types/ink';
import { encodeSamples } from './codec';
import { FIXTURE_BRUSH, buildStrokeSamples } from './fixture';
import {
  INK_MAX_PREVIEW_BYTES,
  INK_MAX_TRANSACTION_BYTES,
  buildStrokePreview,
  strokeTransactions,
  transactionBytes,
  validateTransaction,
} from './transaction';

describe('strokeTransactions', () => {
  it('turns one completed stroke into exactly one transaction', () => {
    // The central rule of the collaboration model. Anything that produces more
    // than one transaction per stroke floods the room and the revision log.
    const samples = buildStrokeSamples({ samples: 400, x: 1_000, y: 1_000 });
    const transactions = strokeTransactions('stroke-a', 'layer-1', samples, FIXTURE_BRUSH);
    expect(transactions).toHaveLength(1);
    expect(transactions[0].kind).toBe('stroke.add');
    expect(transactions[0].objects).toHaveLength(1);
  });

  it('links the segments of a stroke that outgrew the ceiling', () => {
    const samples = buildStrokeSamples({
      samples: INK_LIMITS.samplesPerStroke + 500,
      x: 0,
      y: 0,
      length: 500_000,
    });
    const transactions = strokeTransactions('long', 'layer-1', samples, FIXTURE_BRUSH);
    expect(transactions.length).toBeGreaterThan(1);

    const strokes = transactions.map((transaction) => transaction.objects[0] as InkStroke);
    // Shared identity is what makes the segments select, move, and erase as one
    // line rather than as unrelated pieces the user has to find.
    expect(new Set(strokes.map((stroke) => stroke.continuationId))).toEqual(new Set(['long']));
    expect(strokes.map((stroke) => stroke.continuationIndex)).toEqual(
      strokes.map((_, index) => index),
    );
    expect(new Set(strokes.map((stroke) => stroke.id)).size).toBe(strokes.length);
  });

  it('does not mark an ordinary stroke as a continuation', () => {
    const samples = buildStrokeSamples({ samples: 50, x: 0, y: 0 });
    const stroke = strokeTransactions('s', 'layer-1', samples, FIXTURE_BRUSH)[0]
      .objects[0] as InkStroke;
    expect(stroke.continuationId).toBeUndefined();
    expect(stroke.id).toBe('s');
  });

  it('produces nothing for an empty stroke', () => {
    expect(strokeTransactions('s', 'layer-1', [], FIXTURE_BRUSH)).toEqual([]);
  });

  it('records the collaboration author, never a device identifier', () => {
    const samples = buildStrokeSamples({ samples: 10, x: 0, y: 0 });
    const stroke = strokeTransactions('s', 'layer-1', samples, FIXTURE_BRUSH, {
      authorId: 'user-7',
    })[0].objects[0] as InkStroke;
    expect(stroke.authorId).toBe('user-7');
  });
});

describe('validateTransaction', () => {
  it('accepts every transaction the capture pipeline produces', () => {
    const samples = buildStrokeSamples({
      samples: INK_LIMITS.samplesPerStroke * 3,
      x: 0,
      y: 0,
      length: 1_000_000,
    });
    for (const transaction of strokeTransactions('s', 'layer-1', samples, FIXTURE_BRUSH)) {
      expect(validateTransaction(transaction)).toEqual([]);
      expect(transactionBytes(transaction)).toBeLessThanOrEqual(INK_MAX_TRANSACTION_BYTES);
    }
  });

  it('reports an oversized sample count', () => {
    const samples: InkSample[] = Array.from(
      { length: INK_LIMITS.samplesPerStroke + 1 },
      (_, index) => ({ x: index, y: 0 }),
    );
    const violations = validateTransaction({
      kind: 'stroke.add',
      objects: [
        {
          id: 's',
          type: 'stroke',
          layerId: 'layer-1',
          brush: FIXTURE_BRUSH,
          samples: encodeSamples(samples),
        },
      ],
    });
    expect(violations.map((violation) => violation.reason)).toContain('too-many-samples');
  });

  it('reports an oversized payload', () => {
    const violations = validateTransaction({
      kind: 'object.style',
      objects: [
        {
          id: 'text',
          type: 'text',
          layerId: 'layer-1',
          x: 0,
          y: 0,
          width: 10,
          height: 10,
          text: 'x'.repeat(INK_MAX_TRANSACTION_BYTES + 1),
          color: '#000',
          fontSize: 12,
        },
      ],
    });
    expect(violations.map((violation) => violation.reason)).toContain('too-large');
  });
});

describe('buildStrokePreview', () => {
  it('fits the awareness budget however long the stroke gets', () => {
    // An unbounded preview is the failure mode: awareness is broadcast to every
    // peer on every update, so it is the cheapest thing to make expensive.
    for (const count of [10, 500, INK_LIMITS.samplesPerStroke]) {
      const samples = buildStrokeSamples({ samples: count, x: 0, y: 0, length: count * 40 });
      const preview = buildStrokePreview('s', 'page-1', 'layer-1', FIXTURE_BRUSH, samples, 1);
      expect(JSON.stringify(preview.points).length).toBeLessThanOrEqual(INK_MAX_PREVIEW_BYTES);
    }
  });

  it('thins evenly rather than truncating', () => {
    // A truncated preview shows the peer a line that stopped growing. An
    // evenly thinned one shows the whole shape at lower resolution.
    const samples = buildStrokeSamples({ samples: 2_000, x: 0, y: 0, length: 200_000 });
    const preview = buildStrokePreview('s', 'page-1', 'layer-1', FIXTURE_BRUSH, samples, 1);
    const last = samples[samples.length - 1];
    expect(preview.points[preview.points.length - 2]).toBe(last.x);
    expect(preview.points[preview.points.length - 1]).toBe(last.y);
  });

  it('carries a sequence so a late frame cannot overwrite a newer one', () => {
    const samples = buildStrokeSamples({ samples: 10, x: 0, y: 0 });
    expect(buildStrokePreview('s', 'p', 'l', FIXTURE_BRUSH, samples, 42).sequence).toBe(42);
  });

  it('handles a stroke of one sample', () => {
    const preview = buildStrokePreview('s', 'p', 'l', FIXTURE_BRUSH, [{ x: 5, y: 6 }], 1);
    expect(preview.points).toEqual([5, 6]);
  });
});

describe('over a real CRDT', () => {
  /** Applies one transaction the way the Phase 6 session will. */
  function commit(doc: Y.Doc, objects: Y.Map<Y.Map<unknown>>, stroke: InkStroke): void {
    doc.transact(() => {
      const entry = new Y.Map<unknown>();
      entry.set('type', 'stroke');
      entry.set('layerId', stroke.layerId);
      entry.set('brush', stroke.brush);
      entry.set('samples', stroke.samples);
      objects.set(stroke.id, entry);
    });
  }

  it('emits one update per stroke, not one per sample', () => {
    const doc = new Y.Doc();
    const objects = doc.getMap<Y.Map<unknown>>('objects');
    let updates = 0;
    doc.on('update', () => {
      updates += 1;
    });

    const samples = buildStrokeSamples({ samples: 800, x: 0, y: 0, length: 60_000 });
    const stroke = strokeTransactions('s', 'layer-1', samples, FIXTURE_BRUSH)[0]
      .objects[0] as InkStroke;
    commit(doc, objects, stroke);

    // 800 samples in, one update out. Appending per sample would be 800.
    expect(updates).toBe(1);
  });

  it('keeps the encoded update inside the transaction budget', () => {
    const doc = new Y.Doc();
    const objects = doc.getMap<Y.Map<unknown>>('objects');
    let encoded = new Uint8Array();
    doc.on('update', (update: Uint8Array) => {
      encoded = update;
    });

    const samples = buildStrokeSamples({
      samples: INK_LIMITS.samplesPerStroke,
      x: 0,
      y: 0,
      length: 400_000,
    });
    const stroke = strokeTransactions('s', 'layer-1', samples, FIXTURE_BRUSH)[0]
      .objects[0] as InkStroke;
    commit(doc, objects, stroke);

    expect(encoded.byteLength).toBeGreaterThan(0);
    expect(encoded.byteLength).toBeLessThanOrEqual(INK_MAX_TRANSACTION_BYTES);
  });

  it('merges strokes drawn concurrently by two peers', () => {
    // The merge semantics the plan requires: strokes added by different peers
    // are independent and neither is lost.
    const left = new Y.Doc();
    const right = new Y.Doc();
    const leftObjects = left.getMap<Y.Map<unknown>>('objects');
    const rightObjects = right.getMap<Y.Map<unknown>>('objects');

    const samples = buildStrokeSamples({ samples: 40, x: 0, y: 0 });
    commit(left, leftObjects, strokeTransactions('left-stroke', 'layer-1', samples, FIXTURE_BRUSH)[0]
      .objects[0] as InkStroke);
    commit(right, rightObjects, strokeTransactions('right-stroke', 'layer-1', samples, FIXTURE_BRUSH)[0]
      .objects[0] as InkStroke);

    Y.applyUpdate(left, Y.encodeStateAsUpdate(right));
    Y.applyUpdate(right, Y.encodeStateAsUpdate(left));

    for (const objects of [leftObjects, rightObjects]) {
      expect([...objects.keys()].sort()).toEqual(['left-stroke', 'right-stroke']);
    }
  });

  it('lets a delete win over a concurrent restyle of the same stroke', () => {
    const left = new Y.Doc();
    const right = new Y.Doc();
    const samples = buildStrokeSamples({ samples: 20, x: 0, y: 0 });
    const stroke = strokeTransactions('s', 'layer-1', samples, FIXTURE_BRUSH)[0]
      .objects[0] as InkStroke;
    commit(left, left.getMap<Y.Map<unknown>>('objects'), stroke);
    Y.applyUpdate(right, Y.encodeStateAsUpdate(left));

    left.transact(() => left.getMap<Y.Map<unknown>>('objects').delete('s'));
    right.transact(() => {
      (right.getMap<Y.Map<unknown>>('objects').get('s') as Y.Map<unknown>).set('brush', {
        ...FIXTURE_BRUSH,
        color: '#ff0000',
      });
    });

    Y.applyUpdate(left, Y.encodeStateAsUpdate(right));
    Y.applyUpdate(right, Y.encodeStateAsUpdate(left));

    // Restyling a deleted object must not resurrect it on either side.
    expect(left.getMap('objects').has('s')).toBe(false);
    expect(right.getMap('objects').has('s')).toBe(false);
  });
});
