import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { HostedChatPage, HostedChatScope } from '../types/chat';

import { chatScopeKey, compareChatSequence } from './hostedChat';
import { useHostedChat } from './useHostedChat';

const api = vi.hoisted(() => ({
  hostedVaultRequest: vi.fn(),
  hostedChatOutbox: vi.fn(),
  hostedChatQueue: vi.fn(),
  hostedChatDiscard: vi.fn(),
  hostedAccountRequest: vi.fn(),
}));
vi.mock('./tauri', () => ({ tauriCommands: api }));
const scope: HostedChatScope = {
  serverUrl: 'https://one.test',
  accountId: 'account',
  vaultId: 'vault',
};
const page = (id = 'message', sequence = '1'): HostedChatPage => ({
  messages: [
    {
      id,
      sequence,
      content: 'Hello',
      userId: 'other',
      userName: 'Other',
      userColor: '#fff',
      timestamp: 1,
      hasAvatar: false,
      avatarUpdatedAt: null,
    },
  ],
  nextBefore: null,
  nextAfter: sequence,
  hasMore: false,
});

beforeEach(() => {
  vi.clearAllMocks();
  api.hostedChatOutbox.mockResolvedValue([]);
  api.hostedChatQueue.mockResolvedValue(undefined);
  api.hostedChatDiscard.mockResolvedValue(undefined);
  api.hostedVaultRequest.mockResolvedValue(page());
});

describe('hosted chat boundary', () => {
  it('preserves BIGINT cursor precision and includes server and account in identity', () => {
    expect(compareChatSequence('9007199254740992', '9007199254740993')).toBeLessThan(0);
    expect(compareChatSequence('99', '100')).toBeLessThan(0);
    expect(chatScopeKey(scope)).not.toBe(chatScopeKey({ ...scope, accountId: 'second' }));
    expect(chatScopeKey(scope)).not.toBe(chatScopeKey({ ...scope, serverUrl: 'https://two.test' }));
  });

  it('persists before sending, then retries the same UUID after a lost acknowledgement', async () => {
    let saved!: () => void;
    api.hostedChatQueue.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          saved = resolve;
        }),
    );
    api.hostedVaultRequest.mockImplementation(async (_server, method) => {
      if (method === 'POST') throw new Error('Connection interrupted');
      return page();
    });
    const { result } = renderHook(() => useHostedChat(scope, true));
    await waitFor(() => expect(result.current.authorized).toBe(true));
    let submitting!: Promise<boolean>;
    act(() => {
      submitting = result.current.submit('A durable message');
    });
    expect(api.hostedVaultRequest.mock.calls.some((call) => call[1] === 'POST')).toBe(false);
    await act(async () => {
      saved();
      await submitting;
    });
    expect(result.current.pending).toHaveLength(1);
    const id = result.current.pending[0].id;
    expect(result.current.error).toContain('Connection interrupted');
    api.hostedVaultRequest.mockImplementation(async (_server, method) =>
      method === 'POST' ? { id } : page(),
    );
    await act(async () => {
      await result.current.retry(result.current.pending[0]);
    });
    const sends = api.hostedVaultRequest.mock.calls.filter((call) => call[1] === 'POST');
    expect(sends.map((call) => call[3].id)).toEqual([id, id]);
    expect(sends[0][4]).toBe(scope.accountId);
    expect(api.hostedChatQueue).toHaveBeenCalledTimes(1);
    expect(api.hostedChatDiscard).toHaveBeenCalledWith(
      scope.serverUrl,
      scope.vaultId,
      scope.accountId,
      id,
    );
    expect(result.current.pending).toEqual([]);
  });

  it('does not send or lose text if durable storage fails', async () => {
    api.hostedChatQueue.mockRejectedValueOnce(new Error('Storage full'));
    const { result } = renderHook(() => useHostedChat(scope, true));
    await waitFor(() => expect(result.current.authorized).toBe(true));
    let accepted = true;
    await act(async () => {
      accepted = await result.current.submit('Keep this');
    });
    expect(accepted).toBe(false);
    expect(api.hostedVaultRequest.mock.calls.some((call) => call[1] === 'POST')).toBe(false);
    expect(result.current.error).toContain('Storage full');
  });

  it('clears history on access failure but retains private unsent drafts', async () => {
    api.hostedChatOutbox.mockResolvedValue([{ id: 'draft', content: 'Unsent', createdAt: 1 }]);
    const { result } = renderHook(() => useHostedChat(scope, true));
    await waitFor(() => expect(result.current.messages).toHaveLength(1));
    api.hostedVaultRequest.mockRejectedValueOnce(new Error('Permission denied'));
    await act(async () => {
      await result.current.refresh();
    });
    expect(result.current.messages).toEqual([]);
    expect(result.current.authorized).toBe(false);
    expect(result.current.pending[0].content).toBe('Unsent');
  });

  it('rejects late responses after changing server or disconnecting', async () => {
    let oldResponse!: (value: HostedChatPage) => void;
    api.hostedVaultRequest.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          oldResponse = resolve;
        }),
    );
    api.hostedVaultRequest.mockResolvedValue(page('new-account', '2'));
    const { result, rerender } = renderHook(
      ({ selected, connected }) => useHostedChat(selected, connected),
      { initialProps: { selected: scope, connected: true } },
    );
    rerender({ selected: { ...scope, serverUrl: 'https://two.test' }, connected: true });
    await waitFor(() => expect(result.current.messages[0]?.id).toBe('new-account'));
    await act(async () => {
      oldResponse(page('old-account'));
    });
    expect(result.current.messages[0].id).toBe('new-account');
    rerender({ selected: { ...scope, serverUrl: 'https://two.test' }, connected: false });
    expect(result.current.messages).toEqual([]);
    expect(result.current.authorized).toBe(false);
  });
});
