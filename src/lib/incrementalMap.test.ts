import { expect, it, vi } from 'vitest';

import { IncrementalMap } from './incrementalMap';
import { retainProjection } from './stableProjection';

it('reuses unrelated geometry and retires removed edges across thousands of gesture updates', () => {
  const cache = new IncrementalMap<number>();
  const compute = vi.fn(() => 1);
  const positions = Array.from({ length: 1000 }, () => ({ x: 0 }));
  positions.forEach((p, i) => cache.get(String(i), [p], compute));
  compute.mockClear();
  for (let frame = 0; frame < 100; frame++)
    for (let i = 0; i < 1000; i++) cache.get(String(i), [i === 0 ? frame : positions[i]], compute);
  expect(compute).toHaveBeenCalledTimes(100);
  cache.retain(new Set(['0']));
  expect(cache.size).toBe(1);
});
it('selection or geometry-only updates do not invalidate semantic evaluation projections', () => {
  const data = { value: 1 };
  const previous = [{ id: 'a', data, selected: false }];
  const next = [{ id: 'a', data, selected: true }];
  expect(retainProjection(previous, next, (a, b) => a.id === b.id && a.data === b.data)).toBe(
    previous,
  );
  expect(
    retainProjection(previous, [{ ...next[0], data: { value: 2 } }], (a, b) => a.data === b.data),
  ).not.toBe(previous);
});
