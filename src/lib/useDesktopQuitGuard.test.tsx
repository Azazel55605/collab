import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { useDesktopQuitGuard } from './useDesktopQuitGuard';

const mocks = vi.hoisted(() => ({
  handler: undefined as (() => void) | undefined,
  flush: vi.fn(),
  persist: vi.fn(),
  complete: vi.fn(),
  off: vi.fn(),
  ready: undefined as (() => void) | undefined,
  requested: vi.fn(),
}));
vi.mock('./nativeSubscription', () => ({
  listenSafely: (_name: string, handler: () => void, ready: () => void) => {
    mocks.ready = ready;
    mocks.handler = handler;
    return mocks.off;
  },
}));
vi.mock('../store/editorStore', () => ({ flushEditorPersistence: mocks.persist }));
vi.mock('./documentNavigation', () => ({ runDocumentNavigation: mocks.flush }));
vi.mock('./tauri', () => ({
  tauriCommands: { backgroundCompleteQuit: mocks.complete, backgroundQuitPending: mocks.requested },
}));

beforeEach(() => {
  mocks.persist.mockClear();
  mocks.complete.mockReset().mockResolvedValue(undefined);
  mocks.flush.mockReset();
  mocks.requested.mockReset().mockResolvedValue(false);
});
afterEach(cleanup);

it('waits for saving, coalesces repeated quit events and only then acknowledges', async () => {
  let finish!: (allowed: boolean) => void;
  mocks.flush.mockReturnValue(new Promise<boolean>((resolve) => (finish = resolve)));
  renderHook(useDesktopQuitGuard);
  act(() => {
    mocks.handler!();
    mocks.handler!();
  });
  expect(mocks.complete).not.toHaveBeenCalled();
  expect(mocks.flush).toHaveBeenCalledTimes(1);
  await act(async () => finish(true));
  await waitFor(() => expect(mocks.complete).toHaveBeenCalledWith(true));
  expect(mocks.persist).toHaveBeenCalledTimes(1);
  expect(mocks.persist.mock.invocationCallOrder[0]).toBeLessThan(
    mocks.complete.mock.invocationCallOrder[0],
  );
});

it('rejects quitting on a save failure and permits another attempt', async () => {
  mocks.flush.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
  renderHook(useDesktopQuitGuard);
  await act(async () => mocks.handler!());
  expect(mocks.complete).toHaveBeenLastCalledWith(false);
  await act(async () => mocks.handler!());
  expect(mocks.complete).toHaveBeenLastCalledWith(true);
});

it('does not authorize exit after the editor lifetime was disposed', async () => {
  let finish!: (allowed: boolean) => void;
  mocks.flush.mockReturnValue(new Promise<boolean>((resolve) => (finish = resolve)));
  const hook = renderHook(useDesktopQuitGuard);
  act(() => mocks.handler!());
  hook.unmount();
  await act(async () => finish(true));
  expect(mocks.complete).toHaveBeenCalledWith(false);
  expect(mocks.off).toHaveBeenCalled();
});

it('recovers a quit requested before native listener registration completes', async () => {
  mocks.flush.mockResolvedValue(true);
  mocks.requested.mockResolvedValue(true);
  renderHook(useDesktopQuitGuard);
  await act(async () => mocks.ready!());
  await waitFor(() => expect(mocks.complete).toHaveBeenCalledWith(true));
});
