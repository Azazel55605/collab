import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useConversationNavigation } from '../../store/conversationNavigation';

import { ConversationAccounts } from './ConversationAccounts';

const api = vi.hoisted(() => ({
  hostedConversationRequest: vi.fn(),
  hostedChatOutbox: vi.fn(),
  hostedChatQueue: vi.fn(),
  hostedChatDiscard: vi.fn(),
  hostedUserDirectory: vi.fn(),
  hostedAccountRequest: vi.fn(),
}));
vi.mock('../../lib/tauri', () => ({ tauriCommands: api }));
const accounts = [
  { serverUrl: 'https://one.test', accountId: 'me', label: 'First server', connected: true },
  { serverUrl: 'https://two.test', accountId: 'me2', label: 'Second server', connected: true },
];
const summary = {
  id: 'group',
  kind: 'group',
  name: 'Friends',
  role: 'owner',
  lastSequence: '9007199254740993',
  readSequence: '0',
  unread: 2,
  updatedCursor: '2',
  picture: null,
};
const members = [
  { userId: 'me', displayName: 'Me', role: 'owner', active: true },
  { userId: 'other', displayName: 'Other', role: 'member', active: true },
];
const page = {
  messages: [
    {
      id: 'm1',
      userId: 'other',
      userName: 'Other',
      content: 'Private message',
      timestamp: 1,
      sequence: '9007199254740993',
    },
  ],
  nextBefore: null,
  nextAfter: '9007199254740993',
  hasMore: false,
};
beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  useConversationNavigation.getState().clear();
  HTMLElement.prototype.scrollIntoView = vi.fn();
  api.hostedChatOutbox.mockResolvedValue([]);
  api.hostedAccountRequest.mockRejectedValue(new Error('No avatar'));
  api.hostedChatQueue.mockResolvedValue(undefined);
  api.hostedChatDiscard.mockResolvedValue(undefined);
  api.hostedUserDirectory.mockResolvedValue([
    { userId: 'other', username: 'other', displayName: 'Other' },
  ]);
  api.hostedConversationRequest.mockImplementation(
    async (server: string, _user: string, method: string, path: string) => {
      if (path.startsWith('/api/v1/teams')) return [];
      if (path.includes('/events')) return { events: [], nextAfter: '0', hasMore: false };
      if (path.includes('/messages')) {
        if (method === 'POST') throw new Error('Network interrupted');
        return page;
      }
      if (path.endsWith('/read')) return null;
      if (path.endsWith('/members')) return members;
      if (path.startsWith('/api/v1/conversations?'))
        return server === accounts[0].serverUrl
          ? [summary]
          : [{ ...summary, id: 'second', name: 'Second account chat' }];
      if (method === 'POST') return 'group';
      if (method === 'PATCH') throw new Error('Promote another owner first.');
    },
  );
});
describe('shared personal inbox', () => {
  it('persists before send, retries one UUID and marks only the displayed exact cursor read', async () => {
    render(<ConversationAccounts accounts={accounts} />);
    fireEvent.click(await screen.findByRole('button', { name: /Friends/ }));
    await screen.findByText('Private message');
    await waitFor(() =>
      expect(api.hostedConversationRequest).toHaveBeenCalledWith(
        'https://one.test',
        'me',
        'POST',
        '/api/v1/conversations/group/read',
        { sequence: '9007199254740993' },
      ),
    );
    fireEvent.change(screen.getByLabelText('Message'), { target: { value: 'Pending reply' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }));
    const retry = await screen.findByRole('button', { name: 'Retry' });
    const queued = api.hostedChatQueue.mock.calls[0];
    expect(queued.slice(0, 3)).toEqual(['https://one.test', 'group', 'me']);
    expect(queued[4]).toBe('conversation');
    expect(screen.getByLabelText('Message')).toHaveProperty('value', '');
    api.hostedConversationRequest.mockImplementation(
      async (_s: string, _u: string, method: string, path: string) =>
        path.includes('/messages') ? (method === 'POST' ? page.messages[0] : page) : null,
    );
    fireEvent.click(retry);
    await waitFor(() =>
      expect(api.hostedChatDiscard).toHaveBeenCalledWith(
        'https://one.test',
        'group',
        'me',
        queued[3].id,
        'conversation',
      ),
    );
    const sends = api.hostedConversationRequest.mock.calls.filter(
      (call) => call[2] === 'POST' && call[3].endsWith('/messages'),
    );
    expect(sends[0][4].id).toBe(sends[1][4].id);
  });
  it('changes server without retaining another account’s messages', async () => {
    render(<ConversationAccounts accounts={accounts} />);
    fireEvent.click(await screen.findByRole('button', { name: /Friends/ }));
    await screen.findByText('Private message');
    fireEvent.pointerDown(screen.getByRole('button', { name: 'Switch server account' }), {
      button: 0,
      ctrlKey: false,
    });
    fireEvent.click(await screen.findByRole('menuitem', { name: /Second server/ }));
    expect(screen.queryByText('Private message')).toBeNull();
    await screen.findByRole('button', { name: /Second account chat/ });
    expect(api.hostedConversationRequest).toHaveBeenCalledWith(
      'https://two.test',
      'me2',
      'GET',
      expect.stringContaining('/conversations?'),
      undefined,
    );
  });
  it('ordinary users create groups through the conversation API and ownership errors are shown', async () => {
    render(<ConversationAccounts accounts={accounts} />);
    fireEvent.click(screen.getByRole('button', { name: 'New group chat' }));
    fireEvent.change(screen.getByLabelText('Group name'), { target: { value: 'Friends' } });
    fireEvent.click(await screen.findByRole('button', { name: /Other/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Create conversation' }));
    await screen.findByText('Private message');
    expect(api.hostedConversationRequest).toHaveBeenCalledWith(
      'https://one.test',
      'me',
      'POST',
      '/api/v1/conversations',
      { kind: 'group', name: 'Friends', members: ['other'] },
    );
    fireEvent.click(screen.getByRole('button', { name: 'Manage group' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Make member' }));
    await screen.findByText('Error: Promote another owner first.');
  });
  it('revalidates a notification destination and rejects revoked membership', async () => {
    api.hostedConversationRequest.mockImplementation(
      async (_s: string, _u: string, _m: string, path: string) =>
        path.includes('conversation=')
          ? []
          : path.includes('/events')
            ? { events: [], nextAfter: '0', hasMore: false }
            : [summary],
    );
    useConversationNavigation
      .getState()
      .open({ serverUrl: 'https://two.test', accountId: 'me2', conversationId: 'revoked' });
    render(<ConversationAccounts accounts={accounts} />);
    await screen.findByText('Error: This conversation is no longer available to this account.');
    expect(screen.queryByLabelText('Message')).toBeNull();
    expect(api.hostedConversationRequest).toHaveBeenCalledWith(
      'https://two.test',
      'me2',
      'GET',
      '/api/v1/conversations?limit=1&conversation=revoked',
      undefined,
    );
  });
});

it('consumes a removal once so a rejoining member can open the conversation again', async () => {
  let removed = false;
  api.hostedConversationRequest.mockImplementation(
    async (_s: string, _u: string, _m: string, path: string) => {
      if (path.startsWith('/api/v1/teams')) return [];
      if (path.includes('/events'))
        return {
          events: removed ? [{ sequence: '2', conversationId: 'group', kind: 'removed' }] : [],
          nextAfter: removed ? '2' : '3',
          hasMore: false,
        };
      if (path.includes('/messages')) {
        if (removed) throw new Error('Membership revoked');
        return page;
      }
      if (path.endsWith('/read')) return null;
      return removed ? [] : [summary];
    },
  );
  render(<ConversationAccounts accounts={accounts} />);
  fireEvent.click(await screen.findByRole('button', { name: /Friends/ }));
  await screen.findByText('Private message');
  removed = true;
  fireEvent(window, new Event('focus'));
  await waitFor(() => expect(screen.queryByLabelText('Message')).toBeNull());
  removed = false;
  fireEvent(window, new Event('focus'));
  fireEvent.click(await screen.findByRole('button', { name: /Friends/ }));
  await screen.findByText('Private message');
});

it('opens the canonical direct chat from top search and keeps the conversation sidebar mounted', async () => {
  render(<ConversationAccounts accounts={accounts} />);
  fireEvent.focus(screen.getByRole('combobox'));
  fireEvent.click(await screen.findByRole('option', { name: /Other/ }));
  await screen.findByText('Private message');
  expect(api.hostedConversationRequest).toHaveBeenCalledWith(
    'https://one.test',
    'me',
    'POST',
    '/api/v1/conversations',
    { kind: 'direct', members: ['other'] },
  );
  expect(screen.getByRole('navigation', { name: 'Conversations' })).not.toBeNull();
  expect(screen.getByRole('button', { name: /Friends/ })).not.toBeNull();
});
it('does not create a duplicate group when opening the newly created group fails', async () => {
  const implementation = api.hostedConversationRequest.getMockImplementation()!;
  let fail = true;
  api.hostedConversationRequest.mockImplementation(async (...args: unknown[]) => {
    if (String(args[3]).includes('conversation=') && fail)
      throw new Error('Temporarily unavailable');
    return implementation(...args);
  });
  render(<ConversationAccounts accounts={accounts} />);
  fireEvent.click(screen.getByRole('button', { name: 'New group chat' }));
  fireEvent.change(screen.getByLabelText('Group name'), { target: { value: 'Friends' } });
  fireEvent.click(await screen.findByRole('button', { name: /Other/ }));
  fireEvent.click(screen.getByRole('button', { name: 'Create conversation' }));
  await screen.findByRole('button', { name: 'Open conversation' });
  fail = false;
  fireEvent.click(screen.getByRole('button', { name: 'Open conversation' }));
  await screen.findByText('Private message');
  expect(
    api.hostedConversationRequest.mock.calls.filter(
      (call) => call[2] === 'POST' && call[3] === '/api/v1/conversations',
    ),
  ).toHaveLength(1);
});
it('persists separate chat and team navigation across account workspace remounts', async () => {
  const first = render(<ConversationAccounts accounts={accounts} />);
  fireEvent.pointerDown(screen.getByRole('button', { name: 'Chat layout' }), {
    button: 0,
    ctrlKey: false,
  });
  fireEvent.click(await screen.findByRole('menuitemradio', { name: 'Separate chats and teams' }));
  await screen.findByRole('button', { name: /^Teams$/ });
  first.unmount();
  render(<ConversationAccounts accounts={accounts} />);
  expect(screen.getByRole('button', { name: /^Teams$/ })).not.toBeNull();
  fireEvent.click(screen.getByRole('button', { name: /^Teams$/ }));
  expect(screen.queryByRole('navigation', { name: 'Conversations' })).toBeNull();
  expect(screen.getByRole('navigation', { name: 'Teams and channels' })).not.toBeNull();
});
it('shows the newest message preview and sends on Enter but not Shift+Enter', async () => {
  const implementation = api.hostedConversationRequest.getMockImplementation()!;
  api.hostedConversationRequest.mockImplementation(async (...args: unknown[]) =>
    String(args[3]).startsWith('/api/v1/conversations?limit=50')
      ? [
          {
            ...summary,
            lastMessage: 'See you soon',
            lastMessageAt: Date.now(),
            lastMessageOwn: true,
          },
        ]
      : implementation(...args),
  );
  render(<ConversationAccounts accounts={accounts} />);
  fireEvent.click(await screen.findByRole('button', { name: /You: See you soon/ }));
  const field = await screen.findByLabelText('Message');
  await waitFor(() => expect((field as HTMLTextAreaElement).disabled).toBe(false));
  fireEvent.change(field, { target: { value: 'Draft' } });
  fireEvent.keyDown(field, { key: 'Enter', shiftKey: true });
  expect(api.hostedChatQueue).not.toHaveBeenCalled();
  fireEvent.keyDown(field, { key: 'Enter' });
  await waitFor(() => expect(api.hostedChatQueue).toHaveBeenCalled());
});
it('reacts, replies, edits and deletes messages and applies changes from other devices', async () => {
  const own = {
    id: 'own',
    userId: 'me',
    userName: 'Me',
    content: 'my **plan**',
    timestamp: Date.now() - 60_000,
    sequence: '2',
  };
  const other = {
    ...page.messages[0],
    sequence: '1',
    timestamp: Date.now() - 120_000,
    reactions: [{ emoji: '👍', count: 2, mine: false }],
  };
  let changed: unknown[] = [];
  api.hostedConversationRequest.mockImplementation(
    async (_s: string, _u: string, method: string, path: string, body?: { emoji?: string }) => {
      if (path.startsWith('/api/v1/teams')) return [];
      if (path.includes('/events')) return { events: [], nextAfter: '0', hasMore: false };
      if (path.endsWith('/reactions'))
        return { ...other, reactions: [{ emoji: body!.emoji, count: 3, mine: true }] };
      if (path.endsWith('/messages/own') && method === 'PATCH')
        return { ...own, content: 'new plan', editedAt: Date.now() };
      if (path.endsWith('/messages/own') && method === 'DELETE') return null;
      if (path.endsWith('/messages') && method === 'POST') return { ...own, id: 'reply' };
      if (path.includes('/messages?'))
        return {
          messages: [other, own],
          nextBefore: null,
          nextAfter: '2',
          hasMore: false,
          revision: '4',
          changed: path.includes('changes=4') ? changed : [],
        };
      if (path.endsWith('/read')) return null;
      return [summary];
    },
  );
  render(<ConversationAccounts accounts={accounts} />);
  fireEvent.click(await screen.findByRole('button', { name: /Friends/ }));
  await screen.findByText('Private message');
  expect(screen.getByText('plan').tagName).toBe('STRONG');

  fireEvent.click(screen.getAllByRole('button', { name: 'React with 👍' })[0]);
  await screen.findByRole('button', { name: '👍 3, including you' });
  expect(api.hostedConversationRequest).toHaveBeenCalledWith(
    'https://one.test',
    'me',
    'PUT',
    '/api/v1/conversations/group/messages/m1/reactions',
    { emoji: '👍', reacted: true },
  );

  fireEvent.click(screen.getAllByRole('button', { name: 'Reply' })[0]);
  expect(screen.getByText('Replying to Other')).not.toBeNull();
  fireEvent.change(screen.getByLabelText('Message'), { target: { value: 'Agreed' } });
  fireEvent.keyDown(screen.getByLabelText('Message'), { key: 'Enter' });
  await waitFor(() =>
    expect(api.hostedChatQueue.mock.calls[0][3]).toMatchObject({
      content: 'Agreed',
      replyTo: 'm1',
    }),
  );
  await waitFor(() => expect(screen.queryByText('Replying to Other')).toBeNull());

  const ownActions = screen.getAllByRole('button', { name: 'More message actions' })[1];
  fireEvent.pointerDown(ownActions, { button: 0, ctrlKey: false });
  fireEvent.click(await screen.findByRole('menuitem', { name: 'Edit' }));
  const field = screen.getByLabelText('Message') as HTMLTextAreaElement;
  expect(field.value).toBe('my **plan**');
  fireEvent.change(field, { target: { value: 'new plan' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save edit' }));
  await screen.findByText('new plan');
  expect(screen.getByText('Edited')).not.toBeNull();

  fireEvent.pointerDown(screen.getAllByRole('button', { name: 'More message actions' })[1], {
    button: 0,
    ctrlKey: false,
  });
  fireEvent.click(await screen.findByRole('menuitem', { name: 'Delete' }));
  fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
  await screen.findByText('This message was deleted.');

  changed = [{ ...other, content: 'Edited elsewhere', editedAt: Date.now() }];
  fireEvent(window, new Event('focus'));
  await screen.findByText('Edited elsewhere');
});
