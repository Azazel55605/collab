import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { useMobileStore } from '../state/store';

import { ServersScreen } from './ServersScreen';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));

describe('mobile server editing', () => {
  it('expands an editor below the selected server with a per-server offline mode', () => {
    useMobileStore.setState({
      servers: [
        {
          serverUrl: 'https://server.test',
          username: 'ada',
          allowInvalidCertificates: true,
          persistAcrossReboots: true,
          offlineCopyMode: 'always',
        },
      ],
      statuses: {},
    });

    render(<ServersScreen onOpenServer={vi.fn()} />);
    fireEvent.click(screen.getByLabelText('Edit https://server.test'));

    expect(screen.getByRole('form', { name: 'Edit https://server.test' })).not.toBeNull();
    expect(screen.getByRole('button', { name: 'Always' }).className).toContain('selected');
    expect(screen.queryByRole('button', { name: 'Add' })).toBeNull();
  });

  it('opens a password-only reauthentication sheet for a saved server', async () => {
    const reauthenticate = vi.fn().mockResolvedValue(undefined);
    useMobileStore.setState({
      servers: [
        {
          serverUrl: 'https://server.test',
          username: 'ada',
          allowInvalidCertificates: false,
          persistAcrossReboots: true,
          offlineCopyMode: 'always',
        },
      ],
      statuses: {},
      reauthenticate,
    });

    render(<ServersScreen onOpenServer={vi.fn()} />);
    fireEvent.click(screen.getByLabelText('Sign in again to https://server.test'));

    expect(
      screen.getByRole('dialog', { name: 'Sign in again to https://server.test' }),
    ).not.toBeNull();
    expect(screen.getByText('ada on https://server.test')).not.toBeNull();
    fireEvent.change(screen.getByLabelText('Password'), {
      target: { value: 'replacement-password' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));

    await waitFor(() =>
      expect(reauthenticate).toHaveBeenCalledWith('https://server.test', 'replacement-password'),
    );
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('hides reauthentication while the server is connected', () => {
    useMobileStore.setState({
      servers: [
        {
          serverUrl: 'https://server.test',
          username: 'ada',
          allowInvalidCertificates: false,
          persistAcrossReboots: true,
        },
      ],
      statuses: {
        'https://server.test': {
          connected: true,
          serverUrl: 'https://server.test',
          allowInvalidCertificates: false,
          user: { id: 'user-1', username: 'ada', displayName: 'Ada' },
          accessExpiresAt: '2999-01-01T00:00:00Z',
        },
      },
    });

    render(<ServersScreen onOpenServer={vi.fn()} />);

    expect(screen.queryByLabelText('Sign in again to https://server.test')).toBeNull();
  });

  it('shows startup restoration without presenting the server as disconnected', () => {
    useMobileStore.setState({
      servers: [
        {
          serverUrl: 'https://server.test',
          username: 'ada',
          allowInvalidCertificates: false,
          persistAcrossReboots: true,
        },
      ],
      statuses: {},
      restoringServers: { 'https://server.test': true },
    });

    render(<ServersScreen onOpenServer={vi.fn()} />);

    expect(screen.getByText('Connecting to 1 server…')).not.toBeNull();
    expect(screen.getByText('Connecting…')).not.toBeNull();
    expect(screen.queryByText('Disconnected')).toBeNull();
    expect(screen.queryByLabelText('Reconnect')).toBeNull();
    expect(screen.queryByLabelText('Sign in again to https://server.test')).toBeNull();
  });
});
