import { expect, it } from 'vitest';

import { ImmutableHistory } from './immutableHistory';

it('charges shared subtrees once and bounds large past/future edits without mutating documents', () => {
  const shared = { text: 'x'.repeat(10000) };
  const first = { shared, cell: 1 };
  const second = { shared, cell: 2 };
  const history = new ImmutableHistory<typeof first>(24000, 10);
  history.record(first);
  const bytes = history.retainedBytes;
  history.record(second);
  expect(history.retainedBytes).toBeLessThan(bytes + 1000);
  expect(history.undo({ shared, cell: 3 })).toBe(second);
  expect(history.redo(second)).toEqual({ shared, cell: 3 });
  history.record({ shared: { text: 'y'.repeat(50000) }, cell: 4 });
  expect(history.retainedBytes).toBeLessThanOrEqual(24000);
  expect(first.shared.text.length).toBe(10000);
  history.clear();
  expect(history.retainedBytes).toBe(0);
  expect(history.future).toHaveLength(0);
});
it('drops redo at a new local history boundary and bounds step count across undo/redo', () => {
  const h = new ImmutableHistory<{ value: number }>(100000, 2);
  h.record({ value: 1 });
  h.record({ value: 2 });
  h.record({ value: 3 });
  expect(h.past.map((v) => v.value)).toEqual([2, 3]);
  expect(h.undo({ value: 4 })).toEqual({ value: 3 });
  h.record({ value: 5 });
  expect(h.future).toHaveLength(0);
});
