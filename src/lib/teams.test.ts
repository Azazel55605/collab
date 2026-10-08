import { expect, it, vi } from 'vitest';

import { nativeTeamRequest } from './teams';

const bridge = vi.hoisted(() => vi.fn());
vi.mock('./tauri', () => ({ tauriCommands: { hostedConversationRequest: bridge } }));
it('binds team operations to the selected native server account', async () => {
  bridge.mockResolvedValue([]);
  await nativeTeamRequest({ serverUrl: 'https://one.test', accountId: 'alice' })(
    'GET',
    '/team/channels',
  );
  await nativeTeamRequest({ serverUrl: 'https://two.test', accountId: 'bob' })(
    'POST',
    '/team/members',
    { userId: 'cara', role: 'member' },
  );
  expect(bridge).toHaveBeenNthCalledWith(
    1,
    'https://one.test',
    'alice',
    'GET',
    '/api/v1/teams/team/channels',
    undefined,
  );
  expect(bridge).toHaveBeenNthCalledWith(
    2,
    'https://two.test',
    'bob',
    'POST',
    '/api/v1/teams/team/members',
    { userId: 'cara', role: 'member' },
  );
});
