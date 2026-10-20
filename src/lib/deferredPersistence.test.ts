import { afterEach, expect, it, vi } from 'vitest';

import { createDeferredPersistence } from './deferredPersistence';

afterEach(() => vi.useRealTimers());
it('serializes only the latest state once per window and flushes at a boundary', () => {
  vi.useFakeTimers();
  const setItem = vi.fn();
  const storage = { setItem, getItem: () => null, removeItem: vi.fn() } as unknown as Storage;
  const persistence = createDeferredPersistence<{ position: number }>('fixture', () => storage);
  const stringify = vi.spyOn(JSON, 'stringify');
  for (let position = 0; position < 100; position++)
    persistence.storage.setItem('fixture', { state: { position }, version: 0 });
  expect(setItem).not.toHaveBeenCalled();
  expect(stringify).not.toHaveBeenCalled();
  vi.advanceTimersByTime(300);
  expect(setItem).toHaveBeenCalledTimes(1);
  expect(JSON.parse(setItem.mock.calls[0][1]).state.position).toBe(99);
  const value = { state: { position: 100 }, version: 0 };
  persistence.storage.setItem('fixture', value);
  persistence.flush();
  persistence.storage.setItem('fixture', value);
  vi.advanceTimersByTime(1000);
  expect(setItem).toHaveBeenCalledTimes(2);
  persistence.storage.setItem('fixture', { state: { position: 200 }, version: 0 });
  persistence.storage.removeItem('fixture');
  vi.advanceTimersByTime(1000);
  expect(setItem).toHaveBeenCalledTimes(2);
});
