export interface ConversationSummary {
  id: string;
  kind: 'direct' | 'group' | 'channel';
  name: string;
  role: 'owner' | 'member';
  lastSequence: string;
  readSequence: string;
  unread: number;
  updatedCursor: string;
  picture: string | null;
  teamId?: string;
  teamName?: string;
  /** Newest visible message, truncated by the server; absent on older servers. */
  lastMessage?: string;
  lastMessageAt?: number;
  lastMessageOwn?: boolean;
  lastMessageDeleted?: boolean;
  /** The other participant of a direct chat, used for avatar lookup. */
  peerUserId?: string;
}
export interface ConversationMember {
  userId: string;
  displayName: string;
  role: 'owner' | 'member';
  active: boolean;
}
export interface ConversationEventPage {
  events: {
    sequence: string;
    conversationId: string;
    kind: 'created' | 'message' | 'members' | 'updated' | 'read' | 'removed';
  }[];
  nextAfter: string;
  hasMore: boolean;
}
export interface ConversationAccount {
  serverUrl: string;
  accountId: string;
}

export interface ConversationMessage {
  id: string;
  userId: string;
  userName: string;
  content: string;
  timestamp: number;
  sequence: string;
  editedAt?: number;
  deleted?: boolean;
  replyTo?: ConversationReplyPreview;
  reactions?: ConversationReaction[];
}
/** `content` is absent when the original was deleted or predates joining. */
export interface ConversationReplyPreview {
  id: string;
  userName: string;
  content?: string;
}
export interface ConversationReaction {
  emoji: string;
  count: number;
  mine: boolean;
}
export interface ConversationPage {
  messages: ConversationMessage[];
  nextBefore: string | null;
  nextAfter: string | null;
  hasMore: boolean;
  /** Held messages edited, deleted or reacted to since the `changes` cursor. */
  changed?: ConversationMessage[];
  revision?: string;
}
