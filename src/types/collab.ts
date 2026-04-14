export interface PresenceEntry {
  userId: string;
  userName: string;
  userColor: string;
  activeFile: string | null;
  cursorLine: number | null;
  chatTypingUntil?: number | null;
  lastSeen: number;
  appVersion: string;
}

export interface ChatMessage {
  id: string;
  userId: string;
  userName: string;
  userColor: string;
  content: string;
  timestamp: number;
}

export interface SnapshotMeta {
  id: string;
  relativePath: string;
  authorId: string;
  authorName: string;
  timestamp: number;
  hash: string;
  label?: string;
}
