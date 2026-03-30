export interface VaultMeta {
  id: string;
  name: string;
  path: string;
  lastOpened: number;
  isEncrypted: boolean;
}

export interface NoteFile {
  relativePath: string;
  name: string;
  extension: string;
  modifiedAt: number;
  size: number;
  isFolder: boolean;
  children?: NoteFile[];
}

export interface NoteContent {
  content: string;
  hash: string;
  modifiedAt: number;
}

export interface WriteResult {
  hash: string;
  conflict?: ConflictInfo;
}

export interface ConflictInfo {
  ourContent: string;
  theirContent: string;
  relativePath: string;
}

export type MemberRole = 'viewer' | 'editor' | 'admin';

export interface VaultMember {
  userId: string;
  userName: string;
  role: MemberRole;
}

export interface VaultConfig {
  id: string;
  name: string;
  knownUsers: KnownUser[];
  owner?: string;
  members?: VaultMember[];
  isEncrypted?: boolean;
}

export interface KnownUser {
  userId: string;
  userName: string;
  userColor: string;
  lastSeen: number;
}
