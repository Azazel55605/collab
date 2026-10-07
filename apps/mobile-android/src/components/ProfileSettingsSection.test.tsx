import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { tauriCommands } from '../../../../src/lib/tauri';
import { useMobileStore } from '../state/store';

import { ProfileSettingsSection } from './ProfileSettingsSection';

vi.mock('../../../../src/lib/tauri', () => ({ tauriCommands: { hostedAccountRequest: vi.fn() } }));
const first = 'https://first.example';
const second = 'https://second.example';
const profile = (username: string) => ({
  id: username,
  username,
  displayName: `Name ${username}`,
  hasAvatar: false,
  avatarUpdatedAt: null,
});

beforeEach(() => {
  useMobileStore.setState({
    servers: [first, second].map((serverUrl) => ({
      serverUrl,
      username: 'member',
      allowInvalidCertificates: false,
      persistAcrossReboots: false,
    })),
    statuses: Object.fromEntries(
      [first, second].map((serverUrl) => [
        serverUrl,
        {
          connected: true,
          serverUrl,
          allowInvalidCertificates: false,
          user: profile('member'),
          accessExpiresAt: null,
        },
      ]),
    ),
    refreshStatuses: vi.fn(async () => {}),
  });
  vi.mocked(tauriCommands.hostedAccountRequest).mockImplementation(
    async (server, method, _path, body) => {
      if (method === 'PATCH') return { ...profile('updated'), ...(body as object) };
      return profile(server === first ? 'first-user' : 'second-user');
    },
  );
});

describe('mobile profile', () => {
  it('edits only the selected server and updates its saved username', async () => {
    render(<ProfileSettingsSection />);
    await screen.findByDisplayValue('first-user');
    fireEvent.click(screen.getByRole('button', { name: second }));
    await screen.findByDisplayValue('second-user');
    expect(screen.queryByDisplayValue('first-user')).toBeNull();
    fireEvent.change(screen.getByLabelText('Username'), { target: { value: 'renamed' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save profile' }));
    await screen.findByText('Profile updated.');
    expect(tauriCommands.hostedAccountRequest).toHaveBeenCalledWith(
      second,
      'PATCH',
      '/api/v1/users/me',
      { username: 'renamed', displayName: 'Name second-user' },
    );
    expect(
      useMobileStore.getState().servers.find((server) => server.serverUrl === second)?.username,
    ).toBe('renamed');
    expect(
      useMobileStore.getState().servers.find((server) => server.serverUrl === first)?.username,
    ).toBe('member');
  });

  it('discards a late profile response after switching servers', async () => {
    let resolveFirst!: (value: unknown) => void;
    vi.mocked(tauriCommands.hostedAccountRequest).mockImplementation((server) =>
      server === first
        ? new Promise((resolve) => {
            resolveFirst = resolve;
          })
        : Promise.resolve(profile('second-user')),
    );
    render(<ProfileSettingsSection />);
    fireEvent.click(screen.getByRole('button', { name: second }));
    await screen.findByDisplayValue('second-user');
    resolveFirst(profile('stale-first'));
    await waitFor(() =>
      expect(screen.getByLabelText('Username')).toHaveProperty('value', 'second-user'),
    );
  });

  it('rejects mismatched passwords before making a request', async () => {
    render(<ProfileSettingsSection />);
    await screen.findByDisplayValue('first-user');
    fireEvent.change(screen.getByLabelText('Current password'), {
      target: { value: 'old password here' },
    });
    fireEvent.change(screen.getByLabelText('New password'), {
      target: { value: 'new password here' },
    });
    fireEvent.change(screen.getByLabelText('Confirm new password'), {
      target: { value: 'different password' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Change password' }));
    expect(await screen.findByRole('alert')).toHaveProperty(
      'textContent',
      'New passwords do not match.',
    );
    expect(
      vi
        .mocked(tauriCommands.hostedAccountRequest)
        .mock.calls.some((call) => call[2].endsWith('/password')),
    ).toBe(false);
  });
});
