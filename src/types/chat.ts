import type { ChatMessage } from './collab';

export interface HostedChatPageMessage extends ChatMessage {
  /** Decimal BIGINT cursor; keep as a string across IPC and JSON. */
  sequence: string;
  hasAvatar: boolean;
  avatarUpdatedAt: string | null;
}

export interface HostedChatPage {
  messages: HostedChatPageMessage[];
  nextBefore: string | null;
  nextAfter: string | null;
  hasMore: boolean;
}

export interface PendingChatMessage {
  id: string;
  content: string;
  createdAt: number;
}

export interface HostedChatScope {
  serverUrl: string;
  accountId: string;
  vaultId: string;
}
