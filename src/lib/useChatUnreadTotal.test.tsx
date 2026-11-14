import { renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useServerStore } from '../store/serverStore';

import { useChatUnreadTotal } from './useChatUnreadTotal';

const listConversations = vi.hoisted(() => vi.fn());
vi.mock('./conversations', () => ({ listConversations }));

const connection = (id: string, connected = true) => ({
  status: { connected, serverUrl: '', user: { id, username: id, displayName: id } },
  hostedVaults: [],
});

describe('useChatUnreadTotal', () => {
  beforeEach(() => {
    listConversations.mockReset();
  });

  it('adds up unread messages across signed-in accounts', async () => {
    listConversations.mockImplementation(async ({ serverUrl }: { serverUrl: string }) =>
      serverUrl === 'https://a.test' ? [{ unread: 2 }, { unread: 0 }] : [{ unread: 3 }],
    );
    useServerStore.setState({
      connections: {
        'https://a.test': connection('alice'),
        'https://b.test': connection('bob'),
        'https://c.test': connection('carol', false),
      },
    } as never);
    const { result } = renderHook(() => useChatUnreadTotal());
    await waitFor(() => expect(result.current).toBe(5));
    // Disconnected accounts are not asked.
    expect(listConversations).toHaveBeenCalledTimes(2);
  });

  it('is zero without accounts', () => {
    useServerStore.setState({ connections: {} } as never);
    const { result } = renderHook(() => useChatUnreadTotal());
    expect(result.current).toBe(0);
  });
});
