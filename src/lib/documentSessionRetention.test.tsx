import { act, cleanup, render, renderHook, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { DocumentPane, DocumentPaneContext } from './documentPaneContext';
import { useDocumentSessionController } from './documentSessionController';
import { DocumentSessionRetention, documentSessionRetention } from './documentSessionRetention';

beforeEach(() => documentSessionRetention.clear());
afterEach(cleanup);
const identity = JSON.stringify(['vault-a', 'note.md', 'note', 'left']);
const wrapper = ({ children }: { children: React.ReactNode }) => (
  <DocumentPaneContext.Provider value={identity}>{children}</DocumentPaneContext.Provider>
);
const options = () => ({
  serialize: (s: string) => s,
  deserialize: (s: string) => s,
  applyDocument: vi.fn(),
  write: vi.fn(async () => ({ version: '2' })),
  schedule: () => () => {},
});
it('retains serialized drafts across teardown and revalidates without resetting unsaved edits', async () => {
  const a = renderHook(() => useDocumentSessionController(options()), { wrapper });
  act(() => {
    a.result.current.controller.initialize('base', '1');
    a.result.current.controller.markLocalChange('draft');
  });
  a.unmount();
  const saved = documentSessionRetention.get(identity)!;
  expect(saved.currentContent).toBe('draft');
  expect(saved.pendingRemote).toBeNull();
  const b = renderHook(() => useDocumentSessionController(options()), { wrapper });
  act(() => b.result.current.controller.initialize('remote', '2'));
  expect(b.result.current.snapshot.currentContent).toBe('draft');
  expect(b.result.current.snapshot.pendingRemote?.content).toBe('remote');
  expect(b.result.current.snapshot.dirty).toBe(true);
  await act(async () => {});
});
it('bounds clean retained state and rejects stale detach after a lock/logout boundary', () => {
  const a = renderHook(() => useDocumentSessionController(options()));
  act(() => a.result.current.controller.load('a'.repeat(100), '1'));
  const cache = new DocumentSessionRetention(2, 4000);
  const epoch = cache.epoch;
  for (let i = 0; i < 1000; i++) cache.put(String(i), a.result.current.snapshot);
  expect(cache.get('0')).toBeUndefined();
  expect(cache.get('999')).toBeDefined();
  expect(cache.bytes).toBeLessThanOrEqual(4000);
  cache.clear();
  cache.put('old', a.result.current.snapshot, epoch);
  expect(cache.get('old')).toBeUndefined();
});

it('replaces the controller when the same relative path is opened under another vault scope', () => {
  let active!: ReturnType<typeof useDocumentSessionController<string>>;
  const opts = options();
  function Probe() {
    active = useDocumentSessionController(opts);
    return <span>{active.snapshot.currentContent ?? 'empty'}</span>;
  }
  const vault = { id: 'a', name: 'A', path: '/a', isEncrypted: false, lastOpened: 0 };
  const view = render(
    <DocumentPane vault={vault} relativePath="same.md" type="note">
      <Probe />
    </DocumentPane>,
  );
  const original = active.controller;
  act(() => original.load('private A', '1'));
  view.rerender(
    <DocumentPane vault={{ ...vault, path: '/b' }} relativePath="same.md" type="note">
      <Probe />
    </DocumentPane>,
  );
  expect(active.controller).not.toBe(original);
  expect(screen.getByText('empty')).toBeTruthy();
});

it('does not replay a retained REST baseline over a live owner when a delayed initial read finishes', () => {
  let live = false;
  const opts = { ...options(), isLive: () => live };
  const hook = renderHook(() => useDocumentSessionController(opts));
  act(() => hook.result.current.controller.load('cached baseline', '1'));
  opts.applyDocument.mockClear();
  live = true;
  act(() => hook.result.current.controller.initialize('late REST read', '2'));
  expect(opts.applyDocument).not.toHaveBeenCalled();
  expect(hook.result.current.snapshot.currentContent).toBe('cached baseline');
});
