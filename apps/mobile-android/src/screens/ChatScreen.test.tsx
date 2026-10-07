import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { HostedChatPage } from '../../../../src/types/chat';
import { useMobileStore } from '../state/store';

import { ChatScreen } from './ChatScreen';

const invoke = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...args: unknown[]) => invoke(...args) }));
vi.mock('@tauri-apps/plugin-dialog', () => ({ open: vi.fn(), save: vi.fn() }));
const SERVER = 'https://one.test';
const page: HostedChatPage = {
  messages: [
    {
      id: 'm1',
      sequence: '1',
      userId: 'other',
      userName: 'Other',
      userColor: '#fff',
      content: 'Hello from desktop',
      timestamp: 1,
      hasAvatar: false,
      avatarUpdatedAt: null,
    },
  ],
  nextBefore: '1',
  nextAfter: '1',
  hasMore: true,
};

beforeEach(() => {
  vi.clearAllMocks();
  HTMLElement.prototype.scrollIntoView = vi.fn();
  useMobileStore.setState({
    selected: {
      serverUrl: SERVER,
      vault: {
        id: 'v1',
        name: 'Team vault',
        role: 'editor',
        status: 'active',
        members: 2,
        storageBytes: 0,
        manifestSequence: 1,
        updatedAt: null,
        capabilities: ['vault.read', 'chat.send'],
      },
    },
    statuses: {
      [SERVER]: {
        connected: true,
        serverUrl: SERVER,
        user: { id: 'me', displayName: 'Me' } as never,
        allowInvalidCertificates: false,
        accessExpiresAt: null,
      },
    },
    activeSheet: { kind: 'chat' },
  });
  invoke.mockImplementation(async (command: string, args: Record<string, unknown>) => {
    if (command === 'hosted_chat_outbox') return [];
    if (command === 'hosted_vault_request') {
      if (args.method === 'POST') throw new Error('Network interrupted');
      return page;
    }
    return undefined;
  });
});

describe('Android vault chat', () => {
  it('shows paginated history and keeps failed sends in the retry outbox', async () => {
    render(<ChatScreen />);
    await screen.findByText('Hello from desktop');
    expect(screen.getByText('one.test')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Earlier messages' }));
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith(
        'hosted_vault_request',
        expect.objectContaining({
          path: '/api/v1/vaults/v1/chat/page?limit=50&before=1',
          expectedUserId: 'me',
        }),
      ),
    );
    fireEvent.change(screen.getByLabelText('Message'), { target: { value: 'A new message' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await screen.findByRole('button', { name: 'Retry' });
    expect(screen.getByLabelText('Message')).toHaveProperty('value', '');
    expect(screen.getByText('A new message')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() =>
      expect(
        invoke.mock.calls.filter(
          ([command, args]) => command === 'hosted_vault_request' && args.method === 'POST',
        ),
      ).toHaveLength(2),
    );
    const sends = invoke.mock.calls.filter(
      ([command, args]) => command === 'hosted_vault_request' && args.method === 'POST',
    );
    expect(sends[0][1].body.id).toBe(sends[1][1].body.id);
  });

  it('enforces read-only chat and closes through the existing navigation boundary', async () => {
    const selected = useMobileStore.getState().selected!;
    useMobileStore.setState({
      selected: { ...selected, vault: { ...selected.vault, capabilities: ['vault.read'] } },
    });
    render(<ChatScreen />);
    await screen.findByText('Hello from desktop');
    expect(screen.getByRole('button', { name: 'Send' })).toHaveProperty('disabled', true);
    expect(screen.getByLabelText('Message')).toHaveProperty('disabled', true);
    fireEvent.click(screen.getByRole('button', { name: 'Back to files' }));
    expect(useMobileStore.getState().activeSheet).toBeNull();
  });

  it('hides server history when disconnected', async () => {
    render(<ChatScreen />);
    await screen.findByText('Hello from desktop');
    act(() =>
      useMobileStore.setState({
        statuses: { [SERVER]: { ...useMobileStore.getState().statuses[SERVER], connected: false } },
      }),
    );
    expect(screen.queryByText('Hello from desktop')).toBeNull();
    expect(screen.getByRole('button', { name: 'Send' })).toHaveProperty('disabled', true);
  });
});
