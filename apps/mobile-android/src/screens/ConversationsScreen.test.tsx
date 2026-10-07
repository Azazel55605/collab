import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';

import { useConversationNavigation } from '../../../../src/store/conversationNavigation';
import { clearBackDismissStack } from '../lib/backStack';
import { useMobileStore } from '../state/store';

import { ConversationsScreen } from './ConversationsScreen';

const invoke = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...args: unknown[]) => invoke(...args) }));
beforeEach(() => {
  vi.clearAllMocks();
  clearBackDismissStack();
  useConversationNavigation.getState().clear();
  HTMLElement.prototype.scrollIntoView = vi.fn();
  useMobileStore.setState({
    tab: 'chats',
    activeSheet: null,
    selected: null,
    statuses: {
      'https://chat.test': {
        serverUrl: 'https://chat.test',
        connected: true,
        user: { id: 'me', displayName: 'Me' } as never,
        allowInvalidCertificates: false,
        accessExpiresAt: null,
      },
    },
  });
  invoke.mockImplementation(async (command: string, args: Record<string, unknown>) => {
    if (command === 'hosted_chat_outbox') return [];
    if (command === 'hosted_conversation_request') {
      const path = String(args.path);
      if (path.includes('/events')) return { events: [], nextAfter: '0', hasMore: false };
      if (path.includes('/messages'))
        return {
          messages: [
            {
              id: 'm',
              userId: 'other',
              userName: 'Other',
              content: 'Mobile group message',
              timestamp: 1,
              sequence: '1',
            },
          ],
          nextBefore: null,
          nextAfter: '1',
          hasMore: false,
        };
      if (path.includes('/members'))
        return [
          { userId: 'me', displayName: 'Me', role: 'owner', active: true },
          { userId: 'other', displayName: 'Other', role: 'member', active: true },
        ];
      if (path.endsWith('/read')) return null;
      return [
        {
          id: 'g',
          kind: 'group',
          name: 'Mobile friends',
          role: 'owner',
          unread: 1,
          updatedCursor: '1',
          lastSequence: '1',
          readSequence: '0',
          picture: null,
        },
      ];
    }
    if (command === 'hosted_user_directory') return [];
  });
});
it('works without a vault and hardware back unwinds group details before the inbox', async () => {
  render(<ConversationsScreen />);
  fireEvent.click(await screen.findByRole('button', { name: /Mobile friends/ }));
  await screen.findByText('Mobile group message');
  fireEvent.click(screen.getByRole('button', { name: 'Manage group' }));
  await screen.findByText('Me · owner');
  act(() => expect(useMobileStore.getState().goBack()).toBe(true));
  await screen.findByText('Mobile group message');
  act(() => expect(useMobileStore.getState().goBack()).toBe(true));
  await screen.findByRole('button', { name: /Mobile friends/ });
  expect(screen.queryByLabelText('Message')).toBeNull();
  expect(invoke).toHaveBeenCalledWith(
    'hosted_conversation_request',
    expect.objectContaining({ serverUrl: 'https://chat.test', expectedUserId: 'me' }),
  );
});
