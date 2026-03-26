export interface PresenceEntry {
  userId: string;
  userName: string;
  userColor: string;
  activeFile: string | null;
  cursorLine: number | null;
  lastSeen: number;
  appVersion: string;
}
