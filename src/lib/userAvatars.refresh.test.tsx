import { act, renderHook, waitFor } from '@testing-library/react';
import { expect, it, vi } from 'vitest';

import { tauriCommands } from './tauri';
import { clearUserAvatars, useUserAvatar } from './userAvatars';

vi.mock('./tauri', () => ({ tauriCommands: { hostedAccountRequest: vi.fn() } }));
it('refreshes mounted consumers after profile invalidation and drops obsolete account responses', async () => {
  clearUserAvatars();
  vi.mocked(tauriCommands.hostedAccountRequest).mockResolvedValue('data:image/png;base64,b2xk');
  const hook = renderHook(() => useUserAvatar('https://one.test', 'user'));
  await waitFor(() => expect(hook.result.current).toContain('b2xk'));
  vi.mocked(tauriCommands.hostedAccountRequest).mockResolvedValue('data:image/png;base64,bmV3');
  act(() => clearUserAvatars('https://one.test'));
  await waitFor(() => expect(hook.result.current).toContain('bmV3'));
  hook.unmount();
});

it('refreshes a still-mounted avatar when its TTL expires', async () => {
  vi.useFakeTimers();
  clearUserAvatars();
  vi.mocked(tauriCommands.hostedAccountRequest).mockResolvedValue('data:image/png;base64,first');
  const hook = renderHook(() => useUserAvatar('https://ttl.test', 'ttl-user'));
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
  const count = vi.mocked(tauriCommands.hostedAccountRequest).mock.calls.length;
  await act(async () => {
    await vi.advanceTimersByTimeAsync(5 * 60_000 + 1);
  });
  expect(tauriCommands.hostedAccountRequest).toHaveBeenCalledTimes(count + 1);
  hook.unmount();
  vi.useRealTimers();
});
