import { expect, it, vi } from 'vitest';

import { listenSafely } from './nativeSubscription';

const mocks = vi.hoisted(() => ({ listen: vi.fn() }));
vi.mock('@tauri-apps/api/event', () => ({ listen: mocks.listen }));

it('disposes late registration and ignores callbacks after cleanup', async () => {
  let finish!: (cleanup: () => void) => void;
  mocks.listen.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const handler = vi.fn();
  const dispose = listenSafely('test', handler);
  dispose();
  mocks.listen.mock.calls[0][1]({ payload: {} });
  const cleanup = vi.fn();
  finish(cleanup);
  await Promise.resolve();
  expect(cleanup).toHaveBeenCalledOnce();
  expect(handler).not.toHaveBeenCalled();
});

it('runs the readiness handshake only while its listener is still owned', async () => {
  const cleanup = vi.fn();
  mocks.listen.mockResolvedValue(cleanup);
  const ready = vi.fn();
  const dispose = listenSafely('ready', vi.fn(), ready);
  await Promise.resolve();
  expect(ready).toHaveBeenCalledOnce();
  dispose();
  expect(cleanup).toHaveBeenCalledOnce();
});
