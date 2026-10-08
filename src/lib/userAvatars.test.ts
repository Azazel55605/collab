import { beforeEach, expect, it, vi } from 'vitest';

import { tauriCommands } from './tauri';
import { clearUserAvatars, readUserAvatar } from './userAvatars';

vi.mock('./tauri', () => ({ tauriCommands: { hostedAccountRequest: vi.fn() } }));
beforeEach(() => {
  clearUserAvatars();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

it('asks the server once per user and caches users without an avatar', async () => {
  vi.mocked(tauriCommands.hostedAccountRequest)
    .mockResolvedValueOnce('data:image/png;base64,YWJj')
    .mockResolvedValueOnce(null);
  expect(await readUserAvatar('https://one.test', 'a')).toBe('data:image/png;base64,YWJj');
  expect(await readUserAvatar('https://one.test', 'a')).toBe('data:image/png;base64,YWJj');
  expect(await readUserAvatar('https://one.test', 'b')).toBeNull();
  expect(await readUserAvatar('https://one.test', 'b')).toBeNull();
  expect(tauriCommands.hostedAccountRequest).toHaveBeenCalledTimes(2);
  expect(tauriCommands.hostedAccountRequest).toHaveBeenCalledWith(
    'https://one.test',
    'GET',
    '/api/v1/users/a/avatar',
  );
});
it('does not cache failed requests, so a later attempt can succeed', async () => {
  vi.mocked(tauriCommands.hostedAccountRequest)
    .mockRejectedValueOnce(new Error('Session refreshing'))
    .mockResolvedValueOnce('data:image/png;base64,YWJj');
  await expect(readUserAvatar('https://one.test', 'c')).rejects.toThrow('Session refreshing');
  expect(await readUserAvatar('https://one.test', 'c')).toBe('data:image/png;base64,YWJj');
});
it('ignores responses that are not image data URLs', async () => {
  vi.mocked(tauriCommands.hostedAccountRequest).mockResolvedValueOnce('<html>');
  expect(await readUserAvatar('https://one.test', 'd')).toBeNull();
});
