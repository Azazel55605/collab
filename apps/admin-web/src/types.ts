export type UserRole = 'member' | 'admin';
export type UserStatus = 'active' | 'disabled';

export interface ServerUser {
  id: string;
  username: string;
  displayName: string;
  role: UserRole;
  status: UserStatus;
  createdAt: string;
  lastLoginAt: string | null;
  activeSessions: number;
  isPrimaryAdmin: boolean;
  /** Per-account UI preferences (e.g. appearance). Opaque object. */
  preferences?: Record<string, unknown> | null;
  /** Whether the account has an avatar image served from `/users/{id}/avatar`. */
  hasAvatar?: boolean;
  /** Avatar last-updated timestamp, used to cache-bust the avatar URL. */
  avatarUpdatedAt?: string | null;
}

export interface AuditEvent {
  id: string;
  actorDisplayName: string | null;
  action: string;
  targetType: string | null;
  targetId: string | null;
  result: string;
  createdAt: string;
}

export interface HostedChatMessage {
  id: string;
  userId: string;
  userName: string;
  userColor: string;
  content: string;
  timestamp: number;
}

export interface AdminOverview {
  health: 'ok' | 'degraded';
  serverVersion: string;
  protocolVersion: number;
  uptimeSeconds: number;
  users: number;
  activeUsers: number;
  activeSessions: number;
  pendingInvitations: number;
  hostedVaults: number;
  storage: {
    databaseBytes: number;
    blobBytes: number;
    warningThresholdBytes: number;
    storedContentBytes: number;
    quotaBytes: number;
  };
  liveCollaboration: {
    activeConnections: number;
    loadedRooms: number;
    activeAwarenessStates: number;
    activePresenceUsers: number;
    pendingUpdateCount: number;
    pendingUpdateBytes: number;
    updatesLastMinute: number;
    compactedDocuments: number;
    compactedStateBytes: number;
    lastCompactionAt: string | null;
  };
  operationalWarnings: OperationalWarning[];
  recentAuditEvents: AuditEvent[];
}

export interface OperationalWarning {
  code: string;
  message: string;
  severity: string;
}

export interface AdminBackupOverview {
  backupDir: string;
  backupCommandConfigured: boolean;
  restoreCommandConfigured: boolean;
  schedule: AdminBackupSchedule;
  exportTarget: AdminBackupExportTarget;
  settings: AdminBackupSettings;
  backups: AdminBackupSummary[];
}

export interface AdminBackupSchedule {
  enabled: boolean;
  intervalSeconds: number;
  retentionDays: number;
  mode: string;
}

export interface AdminBackupExportTarget {
  configured: boolean;
  path: string | null;
  writable: boolean;
  message: string;
}

export interface AdminBackupSettings {
  scheduleEnabled: boolean;
  intervalSeconds: number;
  retentionDays: number;
  exportDir: string | null;
  locks: {
    scheduleEnabled: boolean;
    intervalSeconds: boolean;
    retentionDays: boolean;
    exportDir: boolean;
  };
}

export interface AdminRuntimeSetting<T> {
  value: T;
  envVar: string;
  locked: boolean;
  source: 'default' | 'gui' | 'env' | string;
}

export interface MaintenanceReport {
  expiredWsTickets: number;
  expiredSessions: number;
  stalePresence: number;
  prunedAuditEvents: number;
  prunedActivityEvents: number;
  prunedRevisions: number;
  reclaimedBlobs: number;
  reclaimedBlobBytes: number;
}

export interface LiveDebugState {
  enabled: boolean;
}

export interface AdminServerSettings {
  runtime: {
    browserSecureCookies: AdminRuntimeSetting<boolean>;
    sessionTtlHours: AdminRuntimeSetting<number>;
    nativeAccessTtlMinutes: AdminRuntimeSetting<number>;
    nativeRefreshTtlDays: AdminRuntimeSetting<number>;
    wsTicketTtlSeconds: AdminRuntimeSetting<number>;
    maxFileBytes: AdminRuntimeSetting<number>;
    maxImportBytes: AdminRuntimeSetting<number>;
    maxImportExpandedBytes: AdminRuntimeSetting<number>;
    storageWarningBytes: AdminRuntimeSetting<number>;
    storageQuotaBytes: AdminRuntimeSetting<number>;
    revisionHistoryLimit: AdminRuntimeSetting<number>;
    revisionStorageTargetBytes: AdminRuntimeSetting<number>;
  };
  backup: AdminBackupSettings;
  maintenance: {
    enabled: boolean;
    message: string | null;
    updatedAt: string | null;
  };
}

export interface AdminBackupSummary {
  name: string;
  createdAt: string | null;
  sizeBytes: number;
  hasPostgresDump: boolean;
  hasBlobArchive: boolean;
  hasManifest: boolean;
  hasConfig: boolean;
  hasChecksums: boolean;
}

export interface AdminBackupVerification {
  name: string;
  ok: boolean;
  checkedAt: string;
  artifacts: AdminBackupArtifactVerification[];
}

export interface AdminBackupArtifactVerification {
  path: string;
  expectedSha256: string;
  actualSha256: string | null;
  ok: boolean;
  error: string | null;
}

export interface AdminBackupCommandResult {
  status: string;
  message: string;
  output: string | null;
}

export interface Invitation {
  id: string;
  username: string;
  displayName: string;
  role: UserRole;
  createdAt: string;
  expiresAt: string;
  acceptedAt: string | null;
  revokedAt: string | null;
}

export interface CreatedInvitation {
  invitation: Invitation;
  token: string;
}

export type HostedVaultStatus = 'active' | 'archived' | 'pending_delete';
export type HostedVaultRole = 'viewer' | 'editor' | 'admin';

export interface HostedVaultSummary {
  id: string;
  name: string;
  ownerDisplayName: string;
  status: HostedVaultStatus;
  members: number;
  storageBytes: number;
  requireOfflineCopy?: boolean;
  updatedAt: string;
}

export interface HostedVaultAdminDetail {
  id: string;
  name: string;
  ownerUserId: string;
  ownerUsername: string;
  ownerDisplayName: string;
  status: HostedVaultStatus;
  manifestSequence: number;
  members: number;
  activeFiles: number;
  trashedFiles: number;
  storageBytes: number;
  requireOfflineCopy?: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface HostedVaultMember {
  userId: string;
  username: string;
  displayName: string;
  role: HostedVaultRole;
  owner: boolean;
  createdAt: string;
}

export interface HostedVaultActivityEvent {
  id: string;
  actorDisplayName: string | null;
  eventType: string;
  targetType: string | null;
  targetId: string | null;
  createdAt: string;
}

export interface HostedVaultStorage {
  activeBytes: number;
  trashBytes: number;
  retainedRevisionBytes: number;
  uniqueBlobBytes: number;
  activeFiles: number;
  trashedFiles: number;
  revisionCount: number;
  snapshotCount: number;
}

export interface HostedVaultImportResult {
  importedFiles: number;
  importedFolders: number;
  importedBytes: number;
  resultManifestSequence: number;
}

export type HostedFileKind = 'folder' | 'document' | 'asset';
export type HostedFileState = 'active' | 'trashed' | 'tombstoned';

export interface HostedFileRevision {
  id: string;
  sequence: number;
  contentHash: string;
  sizeBytes: number;
  createdByDisplayName: string | null;
  createdAt: string;
}

export interface HostedFileEntry {
  id: string;
  parentId: string | null;
  name: string;
  relativePath: string;
  kind: HostedFileKind;
  documentType: 'note' | 'kanban' | 'canvas' | null;
  state: HostedFileState;
  currentRevision: HostedFileRevision | null;
  trashedByDisplayName?: string | null;
  trashedAt?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface HostedVaultManifest {
  vaultId: string;
  sequence: number;
  files: HostedFileEntry[];
}

// --- Fine-grained permissions ---

export type GrantSubjectType = 'user' | 'group';

export interface PermissionTemplate {
  id: string;
  name: string;
  description: string | null;
  isBuiltin: boolean;
  capabilities: string[];
  createdAt: string;
  updatedAt: string;
}

export interface UserGroup {
  id: string;
  name: string;
  description: string | null;
  memberCount: number;
  createdAt: string;
}

export interface UserGroupMember {
  userId: string;
  username: string;
  displayName: string;
  addedAt: string;
}

export interface VaultGrant {
  subjectType: GrantSubjectType;
  subjectId: string;
  subjectName: string;
  templateId: string | null;
  templateName: string | null;
  capabilities: string[];
  createdAt: string;
}

/**
 * The capability vocabulary grouped by domain, mirroring
 * `collab_protocol::Capability`. Drives the template capability editor and the
 * grant capability summaries.
 */
export const CAPABILITY_GROUPS: Array<{ domain: string; capabilities: Array<{ token: string; label: string }> }> = [
  {
    domain: 'Vault',
    capabilities: [
      { token: 'vault.read', label: 'Read' },
      { token: 'vault.search', label: 'Search' },
      { token: 'vault.viewHistory', label: 'View history' },
      { token: 'vault.viewActivity', label: 'View activity' },
      { token: 'vault.export', label: 'Export' },
      { token: 'vault.import', label: 'Import' },
      { token: 'vault.offlineCopy', label: 'Create offline copies' },
      { token: 'vault.manageMembers', label: 'Manage members' },
      { token: 'vault.managePermissions', label: 'Manage permissions' },
      { token: 'vault.manageSnapshots', label: 'Manage snapshots' },
    ],
  },
  {
    domain: 'Files',
    capabilities: [
      { token: 'file.create', label: 'Create' },
      { token: 'file.write', label: 'Write' },
      { token: 'file.move', label: 'Move / rename' },
      { token: 'file.delete', label: 'Delete' },
      { token: 'file.uploadAsset', label: 'Upload assets' },
    ],
  },
  {
    domain: 'Kanban',
    capabilities: [
      { token: 'kanban.card.create', label: 'Create cards' },
      { token: 'kanban.card.editContent', label: 'Edit card content' },
      { token: 'kanban.card.move', label: 'Move cards' },
      { token: 'kanban.card.comment', label: 'Comment on cards' },
      { token: 'kanban.card.delete', label: 'Delete cards' },
      { token: 'kanban.card.archive', label: 'Archive cards' },
      { token: 'kanban.column.manage', label: 'Manage columns' },
    ],
  },
  {
    domain: 'PDF',
    capabilities: [
      { token: 'pdf.comment', label: 'Add page comments' },
      { token: 'pdf.annotate', label: 'Annotate (bookmarks/highlights)' },
    ],
  },
  {
    domain: 'Documents',
    capabilities: [
      { token: 'note.edit', label: 'Edit notes' },
      { token: 'canvas.edit', label: 'Edit canvases' },
    ],
  },
];

/** Every known capability token, in canonical domain order. */
export const ALL_CAPABILITIES: string[] = CAPABILITY_GROUPS.flatMap((group) =>
  group.capabilities.map((capability) => capability.token),
);

/** Human-readable label for a capability token (falls back to the raw token). */
export function capabilityLabel(token: string): string {
  for (const group of CAPABILITY_GROUPS) {
    const match = group.capabilities.find((capability) => capability.token === token);
    if (match) return `${group.domain}: ${match.label}`;
  }
  return token;
}
