import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { Awareness } from 'y-protocols/awareness';

import { DocumentSessionController } from './documentSessionController';
import type { LiveDocumentHandle, LiveStatus } from './liveDocumentSession';
import { useLiveDocumentStatus } from './useLiveDocumentStatus';

function controller() {
  return new DocumentSessionController<string>({
    serialize: (value) => value,
    deserialize: (value) => value,
    applyDocument: vi.fn(),
    write: vi.fn(async ({ content }) => ({ version: content })),
  });
}

function liveHandle(initial: LiveStatus) {
  let status = initial;
  const listeners = new Set<(status: LiveStatus) => void>();
  return {
    handle: {
      getStatus: () => status,
      onStatus: (cb: (next: LiveStatus) => void) => {
        listeners.add(cb);
        return () => listeners.delete(cb);
      },
      awareness: {} as Awareness,
      doc: {} as never,
      discardOfflineState: vi.fn(),
      destroy: vi.fn(),
    } as LiveDocumentHandle,
    emit(next: LiveStatus) {
      status = next;
      for (const listener of listeners) listener(next);
    },
  };
}

describe('useLiveDocumentStatus', () => {
  it('maps connected live sessions into the document session status', () => {
    const doc = controller();
    const live = liveHandle('connected');

    const { result } = renderHook(() => useLiveDocumentStatus(doc, live.handle));

    expect(result.current).toBe('connected');
    expect(doc.getSnapshot().status).toBe('live-connected');
  });

  it('keeps a live session in reconnecting state during brief disconnects', () => {
    const doc = controller();
    const live = liveHandle('connected');
    renderHook(() => useLiveDocumentStatus(doc, live.handle));

    act(() => live.emit('disconnected'));

    expect(doc.getSnapshot().status).toBe('live-reconnecting');
  });

  it('clears live state when the session is removed for REST fallback', () => {
    const doc = controller();
    const live = liveHandle('connected');
    const { rerender } = renderHook(({ session }) => useLiveDocumentStatus(doc, session), {
      initialProps: { session: live.handle as LiveDocumentHandle | null },
    });

    rerender({ session: null });

    expect(doc.getSnapshot().status).toBe('idle');
  });
});

it('waits for the current live checkpoint and removes the barrier when the session changes', async () => {
  const doc = controller();
  const live = liveHandle('connected');
  let finish!: () => void;
  const checkpoint = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  live.handle.flushOfflineState = checkpoint;
  const hook = renderHook(({ session }) => useLiveDocumentStatus(doc, session), {
    initialProps: { session: live.handle as LiveDocumentHandle | null },
  });
  let done = false;
  const leaving = doc.prepareToLeave().then(() => {
    done = true;
  });
  expect(checkpoint).toHaveBeenCalledOnce();
  expect(done).toBe(false);
  finish();
  await leaving;
  expect(done).toBe(true);
  hook.rerender({ session: null });
  await doc.prepareToLeave();
  expect(checkpoint).toHaveBeenCalledOnce();
});
