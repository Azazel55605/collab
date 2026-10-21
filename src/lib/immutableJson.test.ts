import { expect, it } from 'vitest';

import { immutableJson } from './immutableJson';

it('preserves JSON/live semantics while reusing unchanged immutable cell subtrees', () => {
  const shared = { formula: '=1+1', value: undefined };
  const first = { cells: { one: shared }, array: [undefined, NaN], date: new Date('2026-01-01Z') };
  const a = immutableJson(first) as Record<string, unknown>;
  expect(a).toEqual(JSON.parse(JSON.stringify(first)));
  const second = { ...first, cells: { ...first.cells, two: { value: 2 } } };
  const b = immutableJson(second) as Record<string, unknown>;
  expect((a.cells as Record<string, unknown>).one).toBe((b.cells as Record<string, unknown>).one);
  expect((b.cells as Record<string, unknown>).two).toEqual({ value: 2 });
  expect(shared).toHaveProperty('value', undefined);
});
it('rejects cycles instead of handing a cyclic structure to the collaboration codec', () => {
  const value: { self?: unknown } = {};
  value.self = value;
  expect(() => immutableJson(value)).toThrow('Cyclic');
});
