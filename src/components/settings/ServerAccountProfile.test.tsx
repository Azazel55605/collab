import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { listKnownServers, upsertKnownServer } from '../../lib/hostedServers';
import { tauriCommands } from '../../lib/tauri';
import { useServerStore } from '../../store/serverStore';

import ServerAccountProfile from './ServerAccountProfile';

vi.mock('../../lib/tauri', () => ({ tauriCommands: { hostedAccountRequest: vi.fn() } }));
const first = 'https://first.example';
const second = 'https://second.example';
const profile = (username: string) => ({
  role: 'member' as const,
  status: 'active' as const,
  id: username,
  username,
  displayName: `Name ${username}`,
  hasAvatar: false,
  avatarUpdatedAt: null,
});
beforeEach(() => {
  localStorage.clear();
  for (const serverUrl of [first, second])
    upsertKnownServer({
      serverUrl,
      username: 'member',
      allowInvalidCertificates: false,
      persistAcrossReboots: true,
    });
  useServerStore.setState({
    connections: Object.fromEntries(
      [first, second].map((serverUrl) => [
        serverUrl,
        {
          status: {
            connected: true,
            serverUrl,
            user: profile('member'),
            accessExpiresAt: null,
            allowInvalidCertificates: false,
          },
          hostedVaults: [],
        },
      ]),
    ),
    refreshAll: vi.fn(async () => {}),
  });
  vi.mocked(tauriCommands.hostedAccountRequest).mockImplementation(
    async (server, method, _path, body) =>
      method === 'PATCH'
        ? { ...profile('updated'), ...(body as object) }
        : profile(server === first ? 'first-user' : 'second-user'),
  );
});

describe('desktop server profile', () => {
  it('edits only the selected server and persists its username', async () => {
    render(<ServerAccountProfile />);
    await screen.findByDisplayValue('first-user');
    fireEvent.mouseDown(screen.getByRole('tab', { name: second }), { button: 0, ctrlKey: false });
    await screen.findByDisplayValue('second-user');
    fireEvent.change(screen.getByLabelText('Username'), { target: { value: 'renamed' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save account' }));
    await screen.findByText('Profile updated.');
    expect(tauriCommands.hostedAccountRequest).toHaveBeenCalledWith(
      second,
      'PATCH',
      '/api/v1/users/me',
      { username: 'renamed', displayName: 'Name second-user' },
    );
    expect(listKnownServers().map((s) => s.username)).toEqual(['member', 'renamed']);
    expect(listKnownServers()[1].persistAcrossReboots).toBe(true);
  });
  it('discards late responses after a server switch', async () => {
    let resolve!: (v: unknown) => void;
    vi.mocked(tauriCommands.hostedAccountRequest).mockImplementation((server) =>
      server === first
        ? new Promise((r) => {
            resolve = r;
          })
        : Promise.resolve(profile('second-user')),
    );
    render(<ServerAccountProfile />);
    fireEvent.mouseDown(screen.getByRole('tab', { name: second }), { button: 0, ctrlKey: false });
    await screen.findByDisplayValue('second-user');
    resolve(profile('stale'));
    await waitFor(() =>
      expect(screen.getByLabelText('Username')).toHaveProperty('value', 'second-user'),
    );
  });
  it('checks confirmation and clears passwords after successful change', async () => {
    render(<ServerAccountProfile />);
    await screen.findByDisplayValue('first-user');
    fireEvent.change(screen.getByLabelText('Current password'), {
      target: { value: 'old password long enough' },
    });
    fireEvent.change(screen.getByLabelText('New password'), {
      target: { value: 'new password long enough' },
    });
    fireEvent.change(screen.getByLabelText('Confirm new password'), {
      target: { value: 'different password long enough' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Change password' }));
    await screen.findByText('New passwords do not match.');
    fireEvent.change(screen.getByLabelText('Confirm new password'), {
      target: { value: 'new password long enough' },
    });
    vi.mocked(tauriCommands.hostedAccountRequest).mockResolvedValueOnce(undefined);
    fireEvent.click(screen.getByRole('button', { name: 'Change password' }));
    await screen.findByText('Password changed. Other sessions have been signed out.');
    expect(screen.getByLabelText('Current password')).toHaveProperty('value', '');
    expect(tauriCommands.hostedAccountRequest).toHaveBeenCalledWith(
      first,
      'POST',
      '/api/v1/users/me/password',
      { currentPassword: 'old password long enough', newPassword: 'new password long enough' },
    );
  });
  it('uploads/removes pictures and rejects oversized uploads', async () => {
    vi.mocked(tauriCommands.hostedAccountRequest).mockImplementation(
      async (_server, method, path) => {
        if (method === 'GET' && path.endsWith('/avatar')) return 'data:image/png;base64,YWJj';
        return { ...profile('member'), hasAvatar: method !== 'DELETE' };
      },
    );
    const { container } = render(<ServerAccountProfile />);
    await screen.findByAltText('Your profile picture');
    fireEvent.click(screen.getByRole('button', { name: 'Remove picture' }));
    await screen.findByText('Picture removed.');
    expect(tauriCommands.hostedAccountRequest).toHaveBeenCalledWith(
      first,
      'DELETE',
      '/api/v1/users/me/avatar',
    );
    const input = container.querySelector('input[type=file]')!;
    fireEvent.change(input, {
      target: {
        files: [new File([new Uint8Array(1024 * 1024 + 1)], 'large.png', { type: 'image/png' })],
      },
    });
    await screen.findByText('Pictures must be 1 MB or smaller.');
    const file = new File(['abc'], 'small.png', { type: 'image/png' });
    Object.defineProperty(file, 'arrayBuffer', {
      value: async () => new Uint8Array([97, 98, 99]).buffer,
    });
    fireEvent.change(input, { target: { files: [file] } });
    await screen.findByText('Picture updated.');
    expect(tauriCommands.hostedAccountRequest).toHaveBeenCalledWith(
      first,
      'PUT',
      '/api/v1/users/me/avatar',
      { mediaType: 'image/png', contentBase64: 'YWJj' },
    );
  });
});
