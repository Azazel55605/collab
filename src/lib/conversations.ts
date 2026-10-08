import type { HostedChatScope } from '../types/chat';
import type {
  ConversationAccount,
  ConversationEventPage,
  ConversationMember,
  ConversationMessage,
  ConversationPage,
  ConversationSummary,
} from '../types/conversation';

import { CHAT_PAGE_SIZE } from './hostedChat';
import { tauriCommands } from './tauri';
import type { ChatTransport } from './useHostedChat';

export function conversationRequest<T>(
  account: ConversationAccount & { notificationAccountKey?: string },
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
  suffix: string,
  body?: unknown,
) {
  if (account.notificationAccountKey)
    return tauriCommands.hostedConversationRequest<T>(
      account.serverUrl,
      account.accountId,
      method,
      `/api/v1/conversations${suffix}`,
      body,
      account.notificationAccountKey,
    );
  return tauriCommands.hostedConversationRequest<T>(
    account.serverUrl,
    account.accountId,
    method,
    `/api/v1/conversations${suffix}`,
    body,
  );
}
export const listConversations = (account: ConversationAccount, before?: string) =>
  conversationRequest<ConversationSummary[]>(
    account,
    'GET',
    `?limit=50${before ? `&before=${before}` : ''}`,
  );
export const conversationEvents = (account: ConversationAccount, after: string) =>
  conversationRequest<ConversationEventPage>(account, 'GET', `/events?limit=100&after=${after}`);
export const conversationMembers = (account: ConversationAccount, id: string) =>
  conversationRequest<ConversationMember[]>(account, 'GET', `/${id}/members`);
export const markConversationRead = (account: ConversationAccount, id: string, sequence: string) =>
  conversationRequest<void>(account, 'POST', `/${id}/read`, { sequence });
/** Conversation rows carry no per-message colour or avatar metadata. */
export const chatMessage = (message: ConversationMessage) => ({
  ...message,
  userColor: '#8b5cf6',
  hasAvatar: false,
  avatarUpdatedAt: null,
});
export const conversationTransport: ChatTransport = {
  kind: 'conversation',
  async read(scope: HostedChatScope, cursor = {}) {
    const query = new URLSearchParams({ limit: String(CHAT_PAGE_SIZE), ...cursor });
    const page = await conversationRequest<ConversationPage>(
      scope,
      'GET',
      `/${scope.vaultId}/messages?${query}`,
    );
    return {
      ...page,
      messages: page.messages.map(chatMessage),
      changed: page.changed?.map(chatMessage),
    };
  },
  outbox: (scope) =>
    tauriCommands.hostedChatOutbox(scope.serverUrl, scope.vaultId, scope.accountId, 'conversation'),
  queue: (scope, message) =>
    tauriCommands.hostedChatQueue(
      scope.serverUrl,
      scope.vaultId,
      scope.accountId,
      message,
      'conversation',
    ),
  discard: (scope, id) =>
    tauriCommands.hostedChatDiscard(
      scope.serverUrl,
      scope.vaultId,
      scope.accountId,
      id,
      'conversation',
    ),
  send: async (scope, message) => ({
    ...(await conversationRequest<ConversationMessage>(
      scope,
      'POST',
      `/${scope.vaultId}/messages`,
      {
        id: message.id,
        content: message.content,
        ...(message.replyTo ? { replyTo: message.replyTo } : {}),
      },
    )),
    userColor: '#8b5cf6',
  }),
  revisions: true,
};
const messagePath = (conversationId: string, messageId: string) =>
  `/${conversationId}/messages/${messageId}`;
export const editConversationMessage = (
  account: ConversationAccount,
  conversationId: string,
  messageId: string,
  content: string,
) =>
  conversationRequest<ConversationMessage>(
    account,
    'PATCH',
    messagePath(conversationId, messageId),
    { content },
  );
export const deleteConversationMessage = (
  account: ConversationAccount,
  conversationId: string,
  messageId: string,
) => conversationRequest<void>(account, 'DELETE', messagePath(conversationId, messageId));
export const reactToConversationMessage = (
  account: ConversationAccount,
  conversationId: string,
  messageId: string,
  emoji: string,
  reacted: boolean,
) =>
  conversationRequest<ConversationMessage>(
    account,
    'PUT',
    `${messagePath(conversationId, messageId)}/reactions`,
    { emoji, reacted },
  );

export async function getConversation(
  account: ConversationAccount,
  id: string,
  notificationAccountKey?: string,
) {
  const rows = await conversationRequest<ConversationSummary[]>(
    { ...account, notificationAccountKey },
    'GET',
    `?limit=1&conversation=${encodeURIComponent(id)}`,
  );
  if (!rows.length) throw new Error('This conversation is no longer available to this account.');
  return rows[0];
}
