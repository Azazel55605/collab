import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useNoteIndexStore } from '../store/noteIndexStore';
import type { NoteMetadata } from '../types/note';
import type { VaultMeta } from '../types/vault';

import { useVaultNoteIndex } from './useVaultNoteIndex';

const mocks = vi.hoisted(() => ({ build: vi.fn(), handlers: new Map<string, () => void>() }));
vi.mock('./vaultClient', () => ({
  createVaultClient: (vault: VaultMeta) => ({ buildNoteIndex: () => mocks.build(vault.path) }),
}));
vi.mock('./nativeSubscription', () => ({
  listenSafely: (name: string, handler: () => void) => {
    mocks.handlers.set(name, handler);
    return () => mocks.handlers.delete(name);
  },
}));
vi.mock('./nativeReplicaSync', () => ({ subscribeToNativeReplicaSync: () => () => {} }));
vi.mock('./vaultReplica', () => ({ onReplicaMutated: () => () => {} }));
const vault = (path: string): VaultMeta => ({
  id: path,
  path,
  name: path,
  isEncrypted: false,
  lastOpened: 1,
});
const notes = (name: string): NoteMetadata[] => [
  {
    relativePath: name,
    title: name,
    tags: [],
    wikilinksOut: [],
    wordCount: 0,
    modifiedAt: 0,
    hash: name,
  },
];
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
describe('vault note index ownership', () => {
  beforeEach(() => {
    mocks.build.mockReset();
    mocks.handlers.clear();
    useNoteIndexStore.setState({ notes: [], isIndexing: false });
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });
  it('rejects a late index from a previous vault and clears notes on close', async () => {
    const a = deferred<NoteMetadata[]>(),
      b = deferred<NoteMetadata[]>();
    mocks.build.mockReturnValueOnce(a.promise).mockReturnValueOnce(b.promise);
    const hook = renderHook(
      ({ current }: { current: VaultMeta | null }) =>
        useVaultNoteIndex(current, false, async () => {}),
      { initialProps: { current: vault('/A') as VaultMeta | null } },
    );
    hook.rerender({ current: vault('/B') });
    await act(async () => {
      b.resolve(notes('b.md'));
    });
    expect(useNoteIndexStore.getState().notes).toEqual(notes('b.md'));
    await act(async () => {
      a.resolve(notes('a.md'));
    });
    expect(useNoteIndexStore.getState().notes).toEqual(notes('b.md'));
    hook.rerender({ current: null });
    expect(useNoteIndexStore.getState()).toMatchObject({ notes: [], isIndexing: false });
  });
  it('keeps a newer loading state when an obsolete job completes', async () => {
    const a = deferred<NoteMetadata[]>(),
      b = deferred<NoteMetadata[]>();
    mocks.build.mockReturnValueOnce(a.promise).mockReturnValueOnce(b.promise);
    const hook = renderHook(({ current }) => useVaultNoteIndex(current, false, async () => {}), {
      initialProps: { current: vault('/A') },
    });
    hook.rerender({ current: vault('/B') });
    await act(async () => {
      a.resolve(notes('a'));
    });
    expect(useNoteIndexStore.getState()).toMatchObject({ notes: [], isIndexing: true });
    await act(async () => {
      b.resolve(notes('b'));
    });
  });
  it('coalesces file events into one trailing refresh and skips obsolete publication', async () => {
    const first = deferred<NoteMetadata[]>(),
      second = deferred<NoteMetadata[]>();
    mocks.build.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const refresh = vi.fn(async () => {});
    renderHook(() => useVaultNoteIndex(vault('/A'), false, refresh));
    vi.useFakeTimers();
    act(() => {
      for (let i = 0; i < 5; i++) mocks.handlers.get('vault:file-modified')!();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(150);
    });
    expect(mocks.build).toHaveBeenCalledTimes(1);
    await act(async () => {
      first.resolve(notes('obsolete'));
    });
    expect(useNoteIndexStore.getState().notes).toEqual([]);
    expect(mocks.build).toHaveBeenCalledTimes(2);
    expect(refresh).toHaveBeenCalledOnce();
    await act(async () => {
      second.resolve(notes('latest'));
    });
    expect(useNoteIndexStore.getState().notes).toEqual(notes('latest'));
  });
  it('waits for unlock and does not restart on vault metadata identity changes', async () => {
    mocks.build.mockResolvedValue(notes('visible'));
    const hook = renderHook(
      ({ current, locked }) => useVaultNoteIndex(current, locked, async () => {}),
      { initialProps: { current: vault('/A'), locked: true } },
    );
    expect(mocks.build).not.toHaveBeenCalled();
    hook.rerender({ current: vault('/A'), locked: false });
    await waitFor(() => expect(useNoteIndexStore.getState().notes).toEqual(notes('visible')));
    hook.rerender({ current: { ...vault('/A'), name: 'renamed' }, locked: false });
    expect(mocks.build).toHaveBeenCalledOnce();
    hook.rerender({ current: vault('/A'), locked: true });
    expect(useNoteIndexStore.getState().notes).toEqual([]);
  });
  it('distinguishes hosted servers even when vault ids and paths match', async () => {
    const a = deferred<NoteMetadata[]>(),
      b = deferred<NoteMetadata[]>();
    mocks.build.mockReturnValueOnce(a.promise).mockReturnValueOnce(b.promise);
    const hosted = (serverUrl: string): VaultMeta => ({
      ...vault('hosted://same'),
      kind: 'hosted',
      serverUrl,
      hostedVaultId: 'same',
      role: 'editor',
    });
    const hook = renderHook(({ current }) => useVaultNoteIndex(current, false, async () => {}), {
      initialProps: { current: hosted('https://A') },
    });
    hook.rerender({ current: hosted('https://B') });
    await act(async () => {
      b.resolve(notes('b'));
      a.resolve(notes('a'));
    });
    expect(useNoteIndexStore.getState().notes).toEqual(notes('b'));
  });
});
