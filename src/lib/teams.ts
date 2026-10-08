import type { ConversationAccount } from '../types/conversation';
import type { TeamRequest } from '../types/team';

import { tauriCommands } from './tauri';

export function nativeTeamRequest(account: ConversationAccount): TeamRequest {
  return (method, path, body) =>
    tauriCommands.hostedConversationRequest(
      account.serverUrl,
      account.accountId,
      method,
      `/api/v1/teams${path}`,
      body,
    );
}
