export type VaultKind = 'local' | 'hosted';

interface VaultMetaBase {
  id: string;
  name: string;
  path: string;
  lastOpened: number;
  isEncrypted: boolean;
}

export interface LocalVaultMeta extends VaultMetaBase {
  /**
   * Optional while older persisted recent-vault entries are migrated.
   * Missing kinds are always treated as local.
   */
  kind?: 'local';
}

export interface HostedVaultMeta extends VaultMetaBase {
  kind: 'hosted';
  serverUrl: string;
  hostedVaultId: string;
  role: MemberRole;
  /**
   * The caller's effective capability tokens on this vault (see
   * `collab_protocol::Capability`). Populated from the vault DTO at open; may be
   * empty/absent for legacy persisted metadata, in which case capability-gated
   * controls fail closed until the vault is reopened.
   */
  capabilities?: string[];
  /** Server policy: this vault should be prepared for offline use on clients. */
  requireOfflineCopy?: boolean;
}

export interface HostedVaultSummary {
  id: string;
  name: string;
  ownerUserId: string;
  ownerDisplayName: string;
  role: MemberRole;
  status: 'active' | 'archived' | 'pending_delete';
  manifestSequence: number;
  members: number;
  storageBytes: number;
  createdAt: string;
  updatedAt: string;
  /** The caller's effective capability tokens on this vault. */
  capabilities?: string[];
  /** Server policy: clients should create a full offline copy when opening. */
  requireOfflineCopy?: boolean;
}

export function hostedVaultMeta(serverUrl: string, vault: HostedVaultSummary): HostedVaultMeta {
  return {
    kind: 'hosted',
    id: vault.id,
    hostedVaultId: vault.id,
    serverUrl,
    name: vault.name,
    path: `hosted://${vault.id}`,
    lastOpened: Date.parse(vault.updatedAt) || Date.now(),
    isEncrypted: false,
    role: vault.role,
    capabilities: vault.capabilities ?? [],
    requireOfflineCopy: vault.requireOfflineCopy ?? false,
  };
}

export type VaultMeta = LocalVaultMeta | HostedVaultMeta;

export function vaultKind(vault: VaultMeta): VaultKind {
  return vault.kind ?? 'local';
}

/**
 * Whether the open vault is read-only for the current user. Only hosted vaults
 * have server-authoritative roles; a `viewer` cannot write, so document editors
 * must present a read-only experience and never attempt a save (which the server
 * would reject with a "could not save" error). Local vaults are always writable.
 */
export function isVaultReadOnly(vault: VaultMeta | null | undefined): boolean {
  return !!vault && vault.kind === 'hosted' && vault.role === 'viewer';
}

/**
 * Whether the caller holds a specific fine-grained capability on the vault.
 * Local vaults are always fully capable (no roles). Hosted vaults consult the
 * effective capability tokens carried on the meta; absent capabilities fail
 * closed (return false) so capability-gated controls stay disabled until the
 * vault is reopened with a fresh DTO.
 */
export function vaultCan(vault: VaultMeta | null | undefined, capability: string): boolean {
  if (!vault) return false;
  if (vault.kind !== 'hosted') return true;
  return (vault.capabilities ?? []).includes(capability);
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
  mergedContent?: string;
  conflict?: ConflictInfo;
}

export interface RestoreConflictInfo {
  existingRelativePath: string;
  suggestedRelativePath: string;
}

export interface TrashEntry {
  id: string;
  originalRelativePath: string;
  deletedAt: number;
  deletedByUserId?: string | null;
  deletedByUserName?: string | null;
  itemKind: 'file' | 'folder';
  extension?: string | null;
  size: number;
  rootName: string;
  restoreConflict?: RestoreConflictInfo | null;
}

export interface PathChangePreview {
  oldRelativePath: string;
  newRelativePath: string;
  itemKind: 'file' | 'folder';
  operation: 'move' | 'rename' | 'move-and-rename' | 'unchanged';
  nestedItemCount: number;
  affectedReferencePaths: string[];
  blockedReason?: string | null;
}

export type FileReferenceSourceDocumentType = 'note' | 'kanban' | 'canvas';
export type FileReferenceKind =
  | 'note-markdown-link'
  | 'note-wikilink'
  | 'kanban-attachment'
  | 'canvas-file-node'
  | 'canvas-note-node';

export interface FileReference {
  referencedRelativePath: string;
  sourceRelativePath: string;
  sourceDocumentType: FileReferenceSourceDocumentType;
  referenceKind: FileReferenceKind;
  displayLabel?: string | null;
  context?: string | null;
}

export interface ConflictInfo {
  /** Authoritative revision accompanying theirContent, when supplied by the server. */
  theirVersion?: string;
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

/** Server-authoritative membership record for a hosted vault. */
export interface HostedVaultMember {
  userId: string;
  username: string;
  displayName: string;
  role: MemberRole;
  owner: boolean;
  createdAt: string;
  /**
   * The member's effective capability tokens at the membership level (explicit
   * override, else assigned template, else role default; canonical order). Group
   * grants further restrict at runtime and are not reflected here.
   */
  capabilities?: string[];
  /** Explicit per-member capability override; null/absent when from a template or role default. */
  customCapabilities?: string[] | null;
  /** Permission template assigned to this membership, if any. */
  templateId?: string | null;
  templateName?: string | null;
}

/** A reusable bundle of capabilities. Built-in templates (viewer/editor/admin) are read-only. */
export interface PermissionTemplate {
  id: string;
  name: string;
  description?: string | null;
  isBuiltin: boolean;
  capabilities: string[];
  createdAt: string;
  updatedAt: string;
}

/** Searchable user-directory entry used when adding hosted vault members. */
export interface UserDirectoryEntry {
  userId: string;
  username: string;
  displayName: string;
}

/** Digest-verified payload produced by the native client for a hosted asset upload. */
export interface HostedUploadPayload {
  name: string;
  mediaType: string;
  contentBase64: string;
  expectedHash: string;
}

export interface VaultConfig {
  id: string;
  name: string;
  knownUsers: KnownUser[];
  /** Legacy local-vault metadata. Readable for compatibility, never authoritative. */
  owner?: string;
  /** Legacy local-vault metadata. Readable for compatibility, never authoritative. */
  members?: VaultMember[];
  isEncrypted?: boolean;
}

export interface KnownUser {
  userId: string;
  userName: string;
  userColor: string;
  lastSeen: number;
}
