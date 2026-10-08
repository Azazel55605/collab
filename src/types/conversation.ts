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
}
export interface ConversationPage {
  messages: ConversationMessage[];
  nextBefore: string | null;
  nextAfter: string | null;
  hasMore: boolean;
}
