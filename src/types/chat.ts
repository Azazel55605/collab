import type { ChatMessage } from './collab';
import type { ConversationReaction, ConversationReplyPreview } from './conversation';

export interface HostedChatPageMessage extends ChatMessage {
  /** Decimal BIGINT cursor; keep as a string across IPC and JSON. */
  sequence: string;
  hasAvatar: boolean;
  avatarUpdatedAt: string | null;
  /** Personal conversations only; vault chat never sets these. */
  editedAt?: number;
  deleted?: boolean;
  replyTo?: ConversationReplyPreview;
  reactions?: ConversationReaction[];
}

export interface HostedChatPage {
  messages: HostedChatPageMessage[];
  nextBefore: string | null;
  nextAfter: string | null;
  hasMore: boolean;
  changed?: HostedChatPageMessage[];
  revision?: string;
}

export interface PendingChatMessage {
  id: string;
  content: string;
  createdAt: number;
  replyTo?: string;
}

export interface HostedChatScope {
  serverUrl: string;
  accountId: string;
  vaultId: string;
}
