import { beforeEach, expect, it, vi } from 'vitest';

import { tauriCommands } from './tauri';
import { clearUserAvatars, readUserAvatar } from './userAvatars';

vi.mock('./tauri', () => ({ tauriCommands: { hostedAccountRequest: vi.fn() } }));
beforeEach(() => clearUserAvatars());

it('asks the server once per user and caches missing avatars as null', async () => {
  vi.mocked(tauriCommands.hostedAccountRequest)
    .mockResolvedValueOnce('data:image/png;base64,YWJj')
    .mockRejectedValueOnce(new Error('Not found'));
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
it('ignores responses that are not image data URLs', async () => {
  vi.mocked(tauriCommands.hostedAccountRequest).mockResolvedValueOnce('<html>');
  expect(await readUserAvatar('https://one.test', 'c')).toBeNull();
});
