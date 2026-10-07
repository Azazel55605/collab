import { beforeEach, expect, it, vi } from 'vitest';

import { conversationTransport, getConversation } from './conversations';

const api = vi.hoisted(() => ({
  hostedConversationRequest: vi.fn(),
  hostedChatOutbox: vi.fn(),
  hostedChatQueue: vi.fn(),
  hostedChatDiscard: vi.fn(),
}));
vi.mock('./tauri', () => ({ tauriCommands: api }));
beforeEach(() => {
  vi.clearAllMocks();
});
it('keeps notification account identity and conversation outbox namespace at the native boundary', async () => {
  api.hostedConversationRequest.mockResolvedValue([{ id: 'chat' }]);
  const account = { serverUrl: 'https://server.test', accountId: 'user' };
  await getConversation(account, 'chat', 'opaque-notice-account');
  expect(api.hostedConversationRequest).toHaveBeenCalledWith(
    account.serverUrl,
    'user',
    'GET',
    '/api/v1/conversations?limit=1&conversation=chat',
    undefined,
    'opaque-notice-account',
  );
  await conversationTransport.outbox({ ...account, vaultId: 'chat' });
  expect(api.hostedChatOutbox).toHaveBeenCalledWith(
    account.serverUrl,
    'chat',
    'user',
    'conversation',
  );
});
