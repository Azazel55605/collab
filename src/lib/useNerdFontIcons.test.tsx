import { act, renderHook, waitFor } from '@testing-library/react';
import { expect, it, vi } from 'vitest';

import { useNerdFontIcons } from './useNerdFontIcons';

const load = vi.hoisted(() => ({ started: vi.fn(), finish: (() => {}) as () => void }));
vi.mock('./nerdFontIcons', async () => {
  load.started();
  await new Promise<void>((resolve) => {
    load.finish = resolve;
  });
  return { searchNerdFontIcons: (query: string) => [{ id: query }] };
});

it('defers the catalog until requested and searches the latest query after loading', async () => {
  const { result, rerender } = renderHook(
    ({ enabled, query }) => useNerdFontIcons(query, 5, enabled),
    { initialProps: { enabled: false, query: 'old' } },
  );
  expect(load.started).not.toHaveBeenCalled();
  expect(result.current.entries).toEqual([]);
  rerender({ enabled: true, query: 'old' });
  await waitFor(() => expect(load.started).toHaveBeenCalledOnce());
  rerender({ enabled: true, query: 'latest' });
  await act(async () => {
    load.finish();
  });
  await waitFor(() => expect(result.current.entries[0]?.id).toBe('latest'));
  rerender({ enabled: false, query: 'latest' });
  expect(result.current.entries).toEqual([]);
  rerender({ enabled: true, query: 'again' });
  expect(result.current.entries[0]?.id).toBe('again');
  expect(load.started).toHaveBeenCalledOnce();
});
