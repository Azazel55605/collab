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
