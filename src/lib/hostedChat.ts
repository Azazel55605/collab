import type { HostedChatPage, HostedChatScope, PendingChatMessage } from '../types/chat';
import type { ChatMessage } from '../types/collab';

import { tauriCommands } from './tauri';

export const CHAT_WINDOW_LIMIT = 300;
export const CHAT_PAGE_SIZE = 50;

export function chatScopeKey(scope: HostedChatScope): string {
  return JSON.stringify([scope.serverUrl, scope.accountId, scope.vaultId]);
}

/** Decimal strings compare exactly without losing BIGINT precision. */
export function compareChatSequence(left: string, right: string): number {
  return left.length - right.length || left.localeCompare(right);
}

/** `changes` is a conversation revision; vault chat ignores it. */
export type ChatPageCursor = { before?: string; after?: string; changes?: string };
export function readChatPage(
  scope: HostedChatScope,
  cursor: ChatPageCursor = {},
): Promise<HostedChatPage> {
  const query = new URLSearchParams({ limit: String(CHAT_PAGE_SIZE), ...cursor });
  return tauriCommands.hostedVaultRequest(
    scope.serverUrl,
    'GET',
    `/api/v1/vaults/${scope.vaultId}/chat/page?${query}`,
    undefined,
    scope.accountId,
  );
}

export const chatOutbox = (scope: HostedChatScope) =>
  tauriCommands.hostedChatOutbox(scope.serverUrl, scope.vaultId, scope.accountId);
export const queueChat = (scope: HostedChatScope, message: PendingChatMessage) =>
  tauriCommands.hostedChatQueue(scope.serverUrl, scope.vaultId, scope.accountId, message);
export const discardChat = (scope: HostedChatScope, id: string) =>
  tauriCommands.hostedChatDiscard(scope.serverUrl, scope.vaultId, scope.accountId, id);
export const sendChat = (scope: HostedChatScope, message: PendingChatMessage) =>
  tauriCommands.hostedVaultRequest<ChatMessage>(
    scope.serverUrl,
    'POST',
    `/api/v1/vaults/${scope.vaultId}/chat`,
    { id: message.id, content: message.content },
    scope.accountId,
  );
export const readChatAvatar = (scope: HostedChatScope, userId: string) =>
  tauriCommands.hostedAccountRequest<string>(
    scope.serverUrl,
    'GET',
    `/api/v1/users/${userId}/avatar`,
  );
