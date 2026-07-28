import { invoke, Channel } from '@tauri-apps/api/core';
import { getVersion } from '@tauri-apps/api/app';
import { open, save } from '@tauri-apps/plugin-dialog';
import { revealItemInDir } from '@tauri-apps/plugin-opener';

export const getAppVersion = getVersion;
import type {
  VaultMeta,
  NoteFile,
  NoteContent,
  WriteResult,
  VaultConfig,
  TrashEntry,
  PathChangePreview,
  FileReference,
  HostedUploadPayload,
  UserDirectoryEntry,
} from '../types/vault';
import type { NoteMetadata, SearchResult } from '../types/note';
import type { PresenceEntry, ChatMessage, SnapshotMeta } from '../types/collab';
import type { KanbanBoard } from '../types/kanban';
import type { KanbanAutomationPreset, KanbanFilterPreset, KanbanTemplate, LogicComponentTemplate, TemplateSource } from '../types/template';
import type { NoteSnippet, NoteSnippetDraft, NoteSnippetScope } from '../types/noteSnippet';
import type { PdfSidecarState } from '../types/pdf';
import type { UpdateInfo } from '../store/updateStore';
import type { LogicDiagramDocument } from '../types/logicDiagram';
import type { CalendarCleanupResult, CalendarDefinition, CalendarItem, CalendarMirrorAnchor, CalendarMirrorConflict, CalendarMirrorGroup, CalendarOperation, CalendarOperationFailure, CalendarRemoteChange, CalendarSubscription, CalendarSyncState } from '../types/calendar';
import type {
  ConsumedNotificationAction,
  NotificationAction,
  NotificationActionToken,
  NotificationCategory,
  NotificationEnvelope,
  NotificationPermissionStatus,
  NotificationPreferences,
  NotificationRecord,
  NotificationReconcileResult,
  NotificationReconciliationRequest,
} from '../types/notification';
import type {
  CircuitDcResult,
  CircuitJobOutcome,
  CircuitJobPhase,
  CircuitJobStatus,
  CircuitSweepChunk,
  CircuitTransientChunk,
} from '../types/circuitRuntime';
import type {
  CacheCleanupReport,
  CachedContentStatus,
  PendingOperation,
  PendingOpStatus,
  ReplicaIntegrityReport,
  ReplicaManifest,
  ReplicaSummary,
  ReplicaSyncState,
  Tombstone,
} from './vaultReplica';

export { Channel };
export type {
  CircuitDcDiagnostic,
  CircuitDcResult,
  CircuitJobOutcome,
  CircuitJobPhase,
  CircuitJobStage,
  CircuitJobStatus,
  CircuitProbeValue,
  CircuitSweepChunk,
  CircuitSweepOutput,
  CircuitSweepResult,
  CircuitSweepSummary,
  CircuitTransientChunk,
  CircuitTransientOutput,
  CircuitTransientResult,
  CircuitTransientSummary,
  CircuitTerminalNet,
  CircuitWireNet,
} from '../types/circuitRuntime';

/** Inbound frame from a backend-proxied live-collaboration WebSocket. */
export type LiveWsEvent =
  | { type: 'text'; data: string }
  | { type: 'binary'; data: string }
  | { type: 'closed'; code: number | null };

export interface LinkPreviewData {
  resolvedUrl: string;
  title?: string | null;
  description?: string | null;
  siteName?: string | null;
  imageUrl?: string | null;
  faviconUrl?: string | null;
  embeddable?: boolean;
  embedBlockReason?: string | null;
}

export interface CalendarFeedResponse {
  resolvedUrl: string;
  notModified: boolean;
  content?: string;
  etag?: string;
  lastModified?: string;
}

export interface ServerConnectionStatus {
  connected: boolean;
  serverUrl: string | null;
  allowInvalidCertificates: boolean;
  user: {
    id: string;
    username: string;
    displayName: string;
    role: 'member' | 'admin';
    status: 'active' | 'disabled';
  } | null;
  accessExpiresAt: string | null;
}

export interface OcrLanguagePack {
  code: string;
  label: string;
  bundled: boolean;
  installed: boolean;
  sizeBytes: number | null;
  sha256: string | null;
  installedAt: string | null;
  sourceUrl: string;
}

export interface OcrLanguagePackData {
  code: string;
  dataBase64: string;
}

export interface NativeOcrWord {
  text: string;
  confidence: number;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export interface NativeOcrResult {
  text: string;
  words: NativeOcrWord[];
}

export interface BackgroundRuntimeProbe {
  runCount: number;
  lastTrigger: string;
  lastRunAt: string;
  processId: number;
  filePath: string;
}

export type BackgroundJobKind =
  | 'replica_sync'
  | 'calendar_sync'
  | 'notification_sync'
  | 'maintenance';
export type BackgroundJobTrigger =
  | 'foreground'
  | 'periodic'
  | 'push_invalidation'
  | 'retry'
  | 'user_initiated';
export type BackgroundJobStatus =
  | 'queued'
  | 'running'
  | 'succeeded'
  | 'partial'
  | 'deferred'
  | 'authentication_required'
  | 'permission_denied'
  | 'conflict'
  | 'cancelled'
  | 'failed';

export interface BackgroundServerRegistration {
  serverUrl: string;
  allowInvalidCertificates: boolean;
  persistAcrossReboots: boolean;
  backgroundSyncEnabled: boolean;
  profileIds: string[];
  updatedAt: string;
}

export type BackgroundCloseBehavior = 'hide_to_tray' | 'quit';
export type BackgroundSyncInterval =
  | 'system_managed'
  | 'fifteen_minutes'
  | 'thirty_minutes'
  | 'hourly'
  | 'manual';

export interface BackgroundSettings {
  schemaVersion: number;
  runInBackground: boolean;
  backgroundSync: boolean;
  syncInterval: BackgroundSyncInterval;
  startAtLogin: boolean;
  closeBehavior: BackgroundCloseBehavior;
  paused: boolean;
  onlyUnmeteredNetworks: boolean;
  requireCharging: boolean;
  pauseOnLowBattery: boolean;
  allowRoaming: boolean;
}

export interface BackgroundJobRequest {
  idempotencyKey: string;
  kind: BackgroundJobKind;
  serverUrl?: string | null;
  profileId?: string | null;
  vaultId?: string | null;
  trigger: BackgroundJobTrigger;
  runtimeBudgetSeconds?: number | null;
}

export interface BackgroundJobRecord {
  id: string;
  idempotencyKey: string;
  kind: BackgroundJobKind;
  serverUrl: string | null;
  profileId: string | null;
  vaultId: string | null;
  trigger: BackgroundJobTrigger;
  attempt: number;
  status: BackgroundJobStatus;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  nextRetryAt: string | null;
  progress: {
    completed: number;
    total: number | null;
    detail: string | null;
  };
  changed?: number | null;
  summary: string | null;
  errorCategory: string | null;
  errorMessage: string | null;
  retryable: boolean;
}

export interface BackgroundJobAggregate {
  queued: number;
  running: number;
  succeeded: number;
  attentionRequired: number;
  latestFinishedAt: string | null;
}

export interface BackgroundStatusSnapshot {
  generatedAt: string;
  activeJobs: number;
  attentionRequired: number;
  lastSuccessfulAt: string | null;
  nextEligibleRetryAt: string | null;
  progress: {
    completed: number;
    total: number | null;
    detail: string | null;
  };
}

export const tauriCommands = {
  backgroundRuntimeProbe: (trigger: string) =>
    invoke<BackgroundRuntimeProbe>('background_runtime_probe', { trigger }),
  backgroundServerList: () =>
    invoke<BackgroundServerRegistration[]>('background_server_list'),
  backgroundServerReplace: (servers: BackgroundServerRegistration[]) =>
    invoke<BackgroundServerRegistration[]>('background_server_replace', { servers }),
  backgroundServerUpsert: (server: BackgroundServerRegistration) =>
    invoke<BackgroundServerRegistration>('background_server_upsert', { server }),
  backgroundServerRemove: (serverUrl: string) =>
    invoke<void>('background_server_remove', { serverUrl }),
  backgroundJobRun: (request: BackgroundJobRequest) =>
    invoke<BackgroundJobRecord>('background_job_run', { request }),
  backgroundJobGet: (jobId: string) =>
    invoke<BackgroundJobRecord | null>('background_job_get', { jobId }),
  backgroundJobList: (limit = 50) =>
    invoke<BackgroundJobRecord[]>('background_job_list', { limit }),
  backgroundJobCancel: (jobId: string) =>
    invoke<BackgroundJobRecord>('background_job_cancel', { jobId }),
  backgroundJobAggregate: () =>
    invoke<BackgroundJobAggregate>('background_job_aggregate'),
  backgroundStatusSnapshot: () =>
    invoke<BackgroundStatusSnapshot>('background_status_snapshot'),
  backgroundSettingsGet: () =>
    invoke<BackgroundSettings>('background_settings_get'),
  backgroundSettingsSave: (settings: BackgroundSettings) =>
    invoke<BackgroundSettings>('background_settings_save', { settings }),
  backgroundSyncRegistered: () =>
    invoke<BackgroundJobRecord[]>('background_sync_registered'),

  // User calendar profile store
  calendarList: (profileId: string) => invoke<CalendarDefinition[]>('calendar_list', { profileId }),
  calendarSave: (profileId: string, calendar: CalendarDefinition) =>
    invoke<void>('calendar_save', { profileId, calendar }),
  calendarReplaceGeneratedKanban: (
    profileId: string,
    calendar: CalendarDefinition,
    items: CalendarItem[],
  ) => invoke<void>('calendar_replace_generated_kanban', { profileId, calendar, items }),
  calendarReplaceSubscription: (
    profileId: string,
    calendar: CalendarDefinition,
    items: CalendarItem[],
    subscription: CalendarSubscription,
  ) => invoke<void>('calendar_replace_subscription', { profileId, calendar, items, subscription }),
  calendarListSubscriptions: (profileId: string) =>
    invoke<CalendarSubscription[]>('calendar_list_subscriptions', { profileId }),
  calendarSaveSubscription: (profileId: string, subscription: CalendarSubscription) =>
    invoke<void>('calendar_save_subscription', { profileId, subscription }),
  calendarDeleteSubscription: (profileId: string, subscriptionId: string) =>
    invoke<void>('calendar_delete_subscription', { profileId, subscriptionId }),
  calendarSaveWithOperation: (profileId: string, calendar: CalendarDefinition, operation: CalendarOperation) =>
    invoke<void>('calendar_save_with_operation', { profileId, calendar, operation }),
  calendarDelete: (profileId: string, calendarId: string, deletedAt: string, operation: CalendarOperation) =>
    invoke<void>('calendar_delete', { profileId, calendarId, deletedAt, operation }),
  calendarCleanup: (profileId: string, retentionDays = 90) =>
    invoke<CalendarCleanupResult>('calendar_cleanup', { profileId, retentionDays }),
  calendarListItems: (
    profileId: string,
    from: string,
    to: string,
    limit = 500,
    includeDeleted = false,
  ) => invoke<CalendarItem[]>('calendar_list_items', { profileId, from, to, limit, includeDeleted }),
  calendarUpsertItem: (profileId: string, item: CalendarItem, operation: CalendarOperation) =>
    invoke<void>('calendar_upsert_item', { profileId, item, operation }),
  calendarUpsertItems: (
    profileId: string,
    entries: Array<[CalendarItem, CalendarOperation]>,
  ) => invoke<void>('calendar_upsert_items', { profileId, entries }),
  calendarListCalendarItems: (profileId: string, calendarId: string, limit = 5_000) =>
    invoke<CalendarItem[]>('calendar_list_calendar_items', { profileId, calendarId, limit }),
  calendarDeleteItem: (profileId: string, calendarId: string, itemId: string, deletedAt: string, operation: CalendarOperation) =>
    invoke<void>('calendar_delete_item', { profileId, calendarId, itemId, deletedAt, operation }),
  calendarSearchItems: (profileId: string, query: string, limit = 100) =>
    invoke<CalendarItem[]>('calendar_search_items', { profileId, query, limit }),
  calendarAcknowledgeOperations: (profileId: string, clientOperationIds: string[]) =>
    invoke<void>('calendar_acknowledge_operations', { profileId, clientOperationIds }),
  calendarReadSyncState: (profileId: string, originKey: string) =>
    invoke<CalendarSyncState | null>('calendar_read_sync_state', { profileId, originKey }),
  calendarWriteSyncState: (profileId: string, state: CalendarSyncState) =>
    invoke<void>('calendar_write_sync_state', { profileId, state }),
  calendarApplyRemoteChanges: (profileId: string, changes: CalendarRemoteChange[], state: CalendarSyncState) =>
    invoke<void>('calendar_apply_remote_changes', { profileId, changes, state }),
  calendarListPendingOperations: (profileId: string) =>
    invoke<CalendarOperation[]>('calendar_list_pending_operations', { profileId }),
  calendarListFailedOperations: (profileId: string) =>
    invoke<CalendarOperationFailure[]>('calendar_list_failed_operations', { profileId }),
  calendarMarkOperationFailed: (profileId: string, clientOperationId: string, error: string, attemptedAt: string) =>
    invoke<void>('calendar_mark_operation_failed', { profileId, clientOperationId, error, attemptedAt }),
  calendarRetryOperation: (profileId: string, clientOperationId: string) =>
    invoke<void>('calendar_retry_operation', { profileId, clientOperationId }),
  calendarDiscardOperation: (profileId: string, clientOperationId: string) =>
    invoke<void>('calendar_discard_operation', { profileId, clientOperationId }),
  calendarRemoveHostedCache: (profileId: string, serverUrl: string, userId: string) =>
    invoke<CalendarCleanupResult>('calendar_remove_hosted_cache', { profileId, serverUrl, userId }),
  calendarListMirrorGroups: (profileId: string) =>
    invoke<CalendarMirrorGroup[]>('calendar_list_mirror_groups', { profileId }),
  calendarSaveMirrorGroup: (profileId: string, group: CalendarMirrorGroup) =>
    invoke<void>('calendar_save_mirror_group', { profileId, group }),
  calendarDeleteMirrorGroup: (profileId: string, groupId: string) =>
    invoke<void>('calendar_delete_mirror_group', { profileId, groupId }),
  calendarListMirrorAnchors: (profileId: string, groupId: string) =>
    invoke<CalendarMirrorAnchor[]>('calendar_list_mirror_anchors', { profileId, groupId }),
  calendarSaveMirrorAnchors: (profileId: string, anchors: CalendarMirrorAnchor[]) =>
    invoke<void>('calendar_save_mirror_anchors', { profileId, anchors }),
  calendarListMirrorConflicts: (profileId: string, groupId?: string, includeResolved = false) =>
    invoke<CalendarMirrorConflict[]>('calendar_list_mirror_conflicts', { profileId, groupId: groupId ?? null, includeResolved }),
  calendarSaveMirrorConflict: (profileId: string, conflict: CalendarMirrorConflict) =>
    invoke<void>('calendar_save_mirror_conflict', { profileId, conflict }),
  calendarListMirrorItems: (profileId: string, calendarIds: string[], limit = 5_000) =>
    invoke<CalendarItem[]>('calendar_list_mirror_items', { profileId, calendarIds, limit }),

  // Native notification inbox and schedule ledger
  notificationReconcile: (
    profileId: string,
    category: NotificationCategory,
    entries: NotificationEnvelope[],
  ) => invoke<NotificationReconcileResult>('notification_reconcile', {
    profileId,
    category,
    entries,
  }),
  notificationCancelCategory: (profileId: string, category: NotificationCategory) =>
    invoke<number>('notification_cancel_category', { profileId, category }),
  notificationListInbox: (profileId: string, includeDismissed = false, limit = 200) =>
    invoke<NotificationRecord[]>('notification_list_inbox', { profileId, includeDismissed, limit }),
  notificationPreferencesGet: (profileId: string) =>
    invoke<NotificationPreferences>('notification_preferences_get', { profileId }),
  notificationPreferencesSave: (profileId: string, preferences: NotificationPreferences) =>
    invoke<NotificationPreferences>('notification_preferences_save', { profileId, preferences }),
  notificationMarkRead: (profileId: string, notificationId: string, read = true) =>
    invoke<void>('notification_mark_read', { profileId, notificationId, read }),
  notificationDismiss: (profileId: string, notificationId: string) =>
    invoke<void>('notification_dismiss', { profileId, notificationId }),
  notificationSnooze: (profileId: string, notificationId: string, minutes: number) =>
    invoke<NotificationRecord>('notification_snooze', { profileId, notificationId, minutes }),
  notificationMarkFailed: (profileId: string, notificationId: string, message: string) =>
    invoke<void>('notification_mark_failed', { profileId, notificationId, message }),
  notificationRetry: (profileId: string, notificationId: string) =>
    invoke<void>('notification_retry', { profileId, notificationId }),
  notificationCreateActionToken: (
    profileId: string,
    notificationId: string,
    action: NotificationAction,
  ) => invoke<NotificationActionToken>('notification_create_action_token', {
    profileId,
    notificationId,
    action,
  }),
  notificationConsumeActionToken: (profileId: string, token: string) =>
    invoke<ConsumedNotificationAction>('notification_consume_action_token', { profileId, token }),
  notificationCleanup: (profileId: string, retentionDays = 90) =>
    invoke<number>('notification_cleanup', { profileId, retentionDays }),
  notificationListReconciliationRequests: (profileId: string) =>
    invoke<NotificationReconciliationRequest[]>(
      'notification_list_reconciliation_requests',
      { profileId },
    ),
  notificationPermissionStatus: () =>
    invoke<NotificationPermissionStatus>('notification_permission_status'),
  notificationRequestPermission: () =>
    invoke<NotificationPermissionStatus>('notification_request_permission'),
  notificationSendTest: () =>
    invoke<void>('notification_send_test'),

  // Vault
  openVault: (path: string) => invoke<VaultMeta>('open_vault', { path }),
  createVault: (path: string, name: string, ownerUserId?: string, ownerUserName?: string, ownerUserColor?: string) =>
    invoke<VaultMeta>('create_vault', { path, name, ownerUserId: ownerUserId ?? null, ownerUserName: ownerUserName ?? null, ownerUserColor: ownerUserColor ?? null }),
  getRecentVaults: () => invoke<VaultMeta[]>('get_recent_vaults'),
  showOpenVaultDialog: async () => {
    const result = await open({
      directory: true,
      multiple: false,
      title: 'Open Vault',
    });
    return typeof result === 'string' ? result : null;
  },
  removeRecentVault: (path: string) => invoke<void>('remove_recent_vault', { path }),
  renameVault: (vaultPath: string, newName: string) => invoke<VaultMeta>('rename_vault', { vaultPath, newName }),
  exportVault: (vaultPath: string, destPath: string) => invoke<void>('export_vault', { vaultPath, destPath }),
  /** Resolve a vault-relative path to its absolute filesystem path (local only). */
  resolveVaultFilePath: (vaultPath: string, relativePath: string) =>
    invoke<string>('resolve_vault_file_path', { vaultPath, relativePath }),
  /** Reveal a file/folder in the OS file manager (local vaults only). */
  revealInFileManager: (absolutePath: string) => revealItemInDir(absolutePath),
  /** Prompt for a destination and return the chosen absolute path (or null). */
  showDownloadDialog: (defaultName: string) =>
    save({ title: 'Download a copy', defaultPath: defaultName }),
  /** Write base64-decoded bytes to a user-chosen absolute path. */
  writeDownloadedFile: (destinationPath: string, contentBase64: string) =>
    invoke<void>('write_downloaded_file', { destinationPath, contentBase64 }),
  /** Materialize bytes to a temp file (for dragging a hosted file out to the OS). */
  writeTempFileForDrag: (fileName: string, contentBase64: string) =>
    invoke<string>('write_temp_file_for_drag', { fileName, contentBase64 }),
  showSaveDialog: async (defaultName: string) =>
    save({
      title: 'Export Vault as ZIP',
      defaultPath: defaultName,
      filters: [{ name: 'ZIP Archive', extensions: ['zip'] }],
    }),

  // Encryption
  unlockVault: (vaultPath: string, password: string) => invoke<void>('unlock_vault', { vaultPath, password }),
  enableVaultEncryption: (vaultPath: string, password: string) => invoke<void>('enable_vault_encryption', { vaultPath, password }),
  disableVaultEncryption: (vaultPath: string, password: string) => invoke<void>('disable_vault_encryption', { vaultPath, password }),
  changeVaultPassword: (vaultPath: string, oldPassword: string, newPassword: string) => invoke<void>('change_vault_password', { vaultPath, oldPassword, newPassword }),

  // Files
  listVaultFiles: (vaultPath: string) => invoke<NoteFile[]>('list_vault_files', { vaultPath }),
  readNote: (vaultPath: string, relativePath: string) => invoke<NoteContent>('read_note', { vaultPath, relativePath }),
  readNoteAssetDataUrl: (vaultPath: string, relativePath: string) =>
    invoke<string>('read_note_asset_data_url', { vaultPath, relativePath }),
  readImageOverlay: (vaultPath: string, imageRelativePath: string) =>
    invoke<string | null>('read_image_overlay', { vaultPath, imageRelativePath }),
  writeImageOverlay: (vaultPath: string, imageRelativePath: string, content: string) =>
    invoke<void>('write_image_overlay', { vaultPath, imageRelativePath, content }),
  deleteImageOverlay: (vaultPath: string, imageRelativePath: string) =>
    invoke<void>('delete_image_overlay', { vaultPath, imageRelativePath }),
  readPdfSidecarState: (vaultPath: string, pdfRelativePath: string) =>
    invoke<PdfSidecarState>('read_pdf_sidecar_state', { vaultPath, pdfRelativePath }),
  writePdfSidecarState: (vaultPath: string, pdfRelativePath: string, state: PdfSidecarState) =>
    invoke<void>('write_pdf_sidecar_state', { vaultPath, pdfRelativePath, state }),
  readCachedDocumentPreviewDataUrl: (vaultPath: string, relativePath: string) =>
    invoke<string | null>('read_cached_document_preview_data_url', { vaultPath, relativePath }),
  writeCachedDocumentPreviewDataUrl: (vaultPath: string, relativePath: string, dataUrl: string) =>
    invoke<void>('write_cached_document_preview_data_url', { vaultPath, relativePath, dataUrl }),
  saveGeneratedImage: (
    vaultPath: string,
    sourceRelativePath: string,
    dataUrl: string,
    overwrite: boolean,
    suggestedFileName?: string,
  ) => invoke<string>('save_generated_image', {
    vaultPath,
    sourceRelativePath,
    dataUrl,
    overwrite,
    suggestedFileName: suggestedFileName ?? null,
  }),
  importAssetIntoVault: (vaultPath: string, sourcePath: string, targetFolder?: string) =>
    invoke<string>('import_asset_into_vault', { vaultPath, sourcePath, targetFolder: targetFolder ?? null }),
  readFileForUpload: (sourcePath: string) =>
    invoke<HostedUploadPayload>('read_file_for_upload', { sourcePath }),
  /** Multi-select desktop file picker filtered to the given extensions (for vault import). */
  showOpenFilesDialog: async (extensions: string[]) => {
    const result = await open({
      multiple: true,
      title: 'Add files to vault',
      filters: [{ name: 'Supported files', extensions }],
    });
    if (Array.isArray(result)) return result;
    return typeof result === 'string' ? [result] : null;
  },
  showCalendarImportDialog: async () => {
    const result = await open({
      multiple: false,
      title: 'Import iCalendar file',
      filters: [{ name: 'iCalendar', extensions: ['ics'] }],
    });
    return typeof result === 'string' ? result : null;
  },
  writeNote: (vaultPath: string, relativePath: string, content: string, expectedHash?: string, baseContent?: string) =>
    invoke<WriteResult>('write_note', {
      vaultPath,
      relativePath,
      content,
      expectedHash: expectedHash ?? null,
      baseContent: baseContent ?? null,
    }),
  createNote: (vaultPath: string, relativePath: string) => invoke<NoteFile>('create_note', { vaultPath, relativePath }),
  moveNoteToTrash: (
    vaultPath: string,
    relativePath: string,
    deletedByUserId?: string | null,
    deletedByUserName?: string | null,
    removeReferences?: boolean,
  ) =>
    invoke<TrashEntry>('move_note_to_trash', {
      vaultPath,
      relativePath,
      deletedByUserId: deletedByUserId ?? null,
      deletedByUserName: deletedByUserName ?? null,
      removeReferences: removeReferences ?? null,
    }),
  listTrashEntries: (vaultPath: string) => invoke<TrashEntry[]>('list_trash_entries', { vaultPath }),
  restoreTrashedItem: (vaultPath: string, entryId: string, targetRelativePath?: string | null) =>
    invoke<string>('restore_trashed_item', { vaultPath, entryId, targetRelativePath: targetRelativePath ?? null }),
  purgeTrashedItem: (vaultPath: string, entryId: string, removeReferences?: boolean) =>
    invoke<void>('purge_trashed_item', { vaultPath, entryId, removeReferences: removeReferences ?? null }),
  purgeAllTrash: (vaultPath: string) => invoke<void>('purge_all_trash', { vaultPath }),
  previewRenameMove: (vaultPath: string, oldPath: string, newPath: string) =>
    invoke<PathChangePreview>('preview_rename_move', { vaultPath, oldPath, newPath }),
  listFileReferences: (vaultPath: string, relativePath: string) =>
    invoke<FileReference[]>('list_file_references', { vaultPath, relativePath }),
  deleteNote: (vaultPath: string, relativePath: string, removeReferences?: boolean) =>
    invoke<void>('delete_note', { vaultPath, relativePath, removeReferences: removeReferences ?? null }),
  renameNote: (vaultPath: string, oldPath: string, newPath: string, updateReferences?: boolean) =>
    invoke<void>('rename_note', { vaultPath, oldPath, newPath, updateReferences: updateReferences ?? null }),
  createFolder: (vaultPath: string, relativePath: string) => invoke<void>('create_folder', { vaultPath, relativePath }),
  fetchLinkPreview: (url: string) => invoke<LinkPreviewData>('fetch_link_preview', { url }),
  fetchCalendarFeed: (url: string, etag?: string, lastModified?: string) =>
    invoke<CalendarFeedResponse>('fetch_calendar_feed', {
      url,
      etag: etag ?? null,
      lastModified: lastModified ?? null,
    }),
  listOcrLanguagePacks: () => invoke<OcrLanguagePack[]>('list_ocr_language_packs'),
  installOcrLanguagePack: (code: string) => invoke<OcrLanguagePack>('install_ocr_language_pack', { code }),
  removeOcrLanguagePack: (code: string) => invoke<OcrLanguagePack>('remove_ocr_language_pack', { code }),
  readOcrLanguagePackData: (code: string) => invoke<OcrLanguagePackData>('read_ocr_language_pack_data', { code }),
  recognizeImageDataUrl: (dataUrl: string, language?: string) =>
    invoke<string>('recognize_image_data_url', { dataUrl, language: language ?? null }),
  recognizeImageDataUrlWords: (dataUrl: string, language?: string) =>
    invoke<NativeOcrResult>('recognize_image_data_url_words', { dataUrl, language: language ?? null }),

  // Kanban templates
  listKanbanTemplates: (vaultPath?: string | null) =>
    invoke<KanbanTemplate[]>('list_kanban_templates', { vaultPath: vaultPath ?? null }),
  saveKanbanTemplate: (
    vaultPath: string | null | undefined,
    source: TemplateSource,
    templateName: string,
    board: KanbanBoard,
  ) => invoke<KanbanTemplate>('save_kanban_template', { vaultPath: vaultPath ?? null, source, templateName, board }),
  deleteKanbanTemplate: (vaultPath: string | null | undefined, source: TemplateSource, templateName: string) =>
    invoke<void>('delete_kanban_template', { vaultPath: vaultPath ?? null, source, templateName }),
  copyKanbanTemplate: (
    vaultPath: string | null | undefined,
    fromSource: TemplateSource,
    toSource: TemplateSource,
    templateName: string,
  ) => invoke<KanbanTemplate>('copy_kanban_template', { vaultPath: vaultPath ?? null, fromSource, toSource, templateName }),
  importKanbanTemplateFromFile: (
    vaultPath: string | null | undefined,
    targetSource: TemplateSource,
    filePath: string,
  ) => invoke<KanbanTemplate>('import_kanban_template_from_file', { vaultPath: vaultPath ?? null, targetSource, filePath }),
  exportKanbanTemplateToFile: (
    vaultPath: string | null | undefined,
    source: TemplateSource,
    templateName: string,
    filePath: string,
  ) => invoke<void>('export_kanban_template_to_file', { vaultPath: vaultPath ?? null, source, templateName, filePath }),
  applyKanbanTemplate: (
    vaultPath: string,
    source: TemplateSource,
    templateName: string,
    destinationRelativePath: string,
  ) => invoke<NoteFile>('apply_kanban_template', { vaultPath, source, templateName, destinationRelativePath }),
  createBlankKanbanTemplate: (
    vaultPath: string | null | undefined,
    source: TemplateSource,
    templateName: string,
  ) => invoke<KanbanTemplate>('create_blank_kanban_template', { vaultPath: vaultPath ?? null, source, templateName }),
  listKanbanFilterPresets: (vaultPath?: string | null) =>
    invoke<KanbanFilterPreset[]>('list_kanban_filter_presets', { vaultPath: vaultPath ?? null }),
  saveKanbanFilterPreset: (
    vaultPath: string | null | undefined,
    source: TemplateSource,
    presetName: string,
    spec: import('../types/kanban').KanbanFilterSpec,
  ) => invoke<KanbanFilterPreset>('save_kanban_filter_preset', { vaultPath: vaultPath ?? null, source, presetName, spec }),
  deleteKanbanFilterPreset: (vaultPath: string | null | undefined, source: TemplateSource, presetName: string) =>
    invoke<void>('delete_kanban_filter_preset', { vaultPath: vaultPath ?? null, source, presetName }),
  copyKanbanFilterPreset: (
    vaultPath: string | null | undefined,
    fromSource: TemplateSource,
    toSource: TemplateSource,
    presetName: string,
  ) => invoke<KanbanFilterPreset>('copy_kanban_filter_preset', { vaultPath: vaultPath ?? null, fromSource, toSource, presetName }),
  listKanbanAutomationPresets: (vaultPath?: string | null) =>
    invoke<KanbanAutomationPreset[]>('list_kanban_automation_presets', { vaultPath: vaultPath ?? null }),
  saveKanbanAutomationPreset: (
    vaultPath: string | null | undefined,
    source: TemplateSource,
    presetName: string,
    rule: import('../types/kanban').KanbanAutomationRule,
  ) => invoke<KanbanAutomationPreset>('save_kanban_automation_preset', { vaultPath: vaultPath ?? null, source, presetName, rule }),
  deleteKanbanAutomationPreset: (vaultPath: string | null | undefined, source: TemplateSource, presetName: string) =>
    invoke<void>('delete_kanban_automation_preset', { vaultPath: vaultPath ?? null, source, presetName }),
  copyKanbanAutomationPreset: (
    vaultPath: string | null | undefined,
    fromSource: TemplateSource,
    toSource: TemplateSource,
    presetName: string,
  ) => invoke<KanbanAutomationPreset>('copy_kanban_automation_preset', { vaultPath: vaultPath ?? null, fromSource, toSource, presetName }),
  listNoteSnippets: (vaultPath?: string | null) =>
    invoke<NoteSnippet[]>('list_note_snippets', { vaultPath: vaultPath ?? null }),
  saveNoteSnippet: (
    vaultPath: string | null | undefined,
    snippet: NoteSnippetDraft,
  ) => invoke<NoteSnippet>('save_note_snippet', {
    vaultPath: vaultPath ?? null,
    scope: snippet.scope,
    snippetId: snippet.id ?? null,
    name: snippet.name,
    description: snippet.description ?? null,
    category: snippet.category ?? null,
    body: snippet.body,
  }),
  deleteNoteSnippet: (
    vaultPath: string | null | undefined,
    scope: NoteSnippetScope,
    snippetId: string,
  ) => invoke<void>('delete_note_snippet', { vaultPath: vaultPath ?? null, scope, snippetId }),
  listLogicComponents: (vaultPath: string) =>
    invoke<LogicComponentTemplate[]>('list_logic_components', { vaultPath }),
  saveLogicComponent: (vaultPath: string, component: LogicComponentTemplate) =>
    invoke<LogicComponentTemplate>('save_logic_component', { vaultPath, component }),
  deleteLogicComponent: (vaultPath: string, componentId: string) =>
    invoke<void>('delete_logic_component', { vaultPath, componentId }),
  showOpenTemplateFileDialog: async () => {
    const result = await open({
      multiple: false,
      title: 'Import Kanban Template',
      filters: [{ name: 'Kanban Template', extensions: ['json', 'kanban-template'] }],
    });
    return typeof result === 'string' ? result : null;
  },
  showSaveTemplateFileDialog: async (defaultName: string) => {
    const result = await save({
      title: 'Export Kanban Template',
      defaultPath: defaultName,
      filters: [{ name: 'Kanban Template', extensions: ['json'] }],
    });
    return typeof result === 'string' ? result : null;
  },

  // Index
  buildNoteIndex: (vaultPath: string) => invoke<NoteMetadata[]>('build_note_index', { vaultPath }),
  getBacklinks: (vaultPath: string, relativePath: string) => invoke<string[]>('get_backlinks', { vaultPath, relativePath }),
  searchNotes: (vaultPath: string, query: string) => invoke<SearchResult[]>('search_notes', { vaultPath, query }),

  // Watcher
  watchVault: (vaultPath: string) => invoke<void>('watch_vault', { vaultPath }),
  unwatchVault: () => invoke<void>('unwatch_vault'),

  // First-party circuit simulation
  circuitSolveDc: (document: LogicDiagramDocument) =>
    invoke<CircuitDcResult>('circuit_solve_dc', { document }),
  circuitStartDc: (document: LogicDiagramDocument) =>
    invoke<string>('circuit_start_dc', { document }),
  circuitStartDcSweep: (document: LogicDiagramDocument) =>
    invoke<string>('circuit_start_dc_sweep', { document }),
  circuitStartTransient: (document: LogicDiagramDocument) =>
    invoke<string>('circuit_start_transient', { document }),
  circuitJobStatus: (jobId: string) =>
    invoke<CircuitJobStatus>('circuit_job_status', { jobId }),
  circuitCancelJob: (jobId: string) =>
    invoke<CircuitJobPhase>('circuit_cancel_job', { jobId }),
  circuitTakeJobResult: (jobId: string) =>
    invoke<CircuitJobOutcome | null>('circuit_take_job_result', { jobId }),
  circuitReadSweepChunk: (jobId: string, offset: number, limit: number) =>
    invoke<CircuitSweepChunk>('circuit_read_sweep_chunk', { jobId, offset, limit }),
  circuitReadTransientChunk: (jobId: string, offset: number, limit: number) =>
    invoke<CircuitTransientChunk>('circuit_read_transient_chunk', { jobId, offset, limit }),
  circuitDiscardJob: (jobId: string) =>
    invoke<void>('circuit_discard_job', { jobId }),

  // UI
  setUiZoom: (zoom: number) => invoke<void>('set_ui_zoom', { zoom }),
  hostOs: () => invoke<string>('host_os'),
  isAppImage: () => invoke<boolean>('is_appimage'),
  isFlatpak: () => invoke<boolean>('is_flatpak'),
  shouldDisableBlur: () => invoke<boolean>('should_disable_blur'),

  // Hosted server connection. The refresh token is kept in a per-platform
  // credential store; `persistAcrossReboots` only affects Linux (keyutils vs
  // Secret Service) — Windows/macOS always use their native durable keystore.
  connectServer: (serverUrl: string, username: string, password: string, allowInvalidCertificates = false, persistAcrossReboots = false) =>
    invoke<ServerConnectionStatus>('connect_server', { serverUrl, username, password, allowInvalidCertificates, persistAcrossReboots }),
  reauthenticateServer: (serverUrl: string, username: string, password: string, allowInvalidCertificates = false, persistAcrossReboots = false) =>
    invoke<ServerConnectionStatus>('reauthenticate_server', { serverUrl, username, password, allowInvalidCertificates, persistAcrossReboots }),
  reconnectServer: (serverUrl: string, allowInvalidCertificates = false, persistAcrossReboots = false) =>
    invoke<ServerConnectionStatus>('reconnect_server', { serverUrl, allowInvalidCertificates, persistAcrossReboots }),
  disconnectServer: (serverUrl: string) => invoke<void>('disconnect_server', { serverUrl }),
  /** One status per connected server; empty when no servers are connected. */
  serverConnectionStatuses: () => invoke<ServerConnectionStatus[]>('server_connection_statuses'),
  serverHasSavedSession: (serverUrl: string) => invoke<boolean>('server_has_saved_session', { serverUrl }),
  hostedVaultRequest: <T>(serverUrl: string, method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', path: string, body?: unknown) =>
    invoke<T>('hosted_vault_request', { serverUrl, method, path, body: body ?? null }),
  hostedCalendarRequest: <T>(serverUrl: string, method: 'GET' | 'POST' | 'PATCH' | 'DELETE', path: string, body?: unknown) =>
    invoke<T>('hosted_calendar_request', { serverUrl, method, path, body: body ?? null }),
  hostedVaultAssetDataUrl: (serverUrl: string, vaultId: string, fileId: string) =>
    invoke<string>('hosted_vault_asset_data_url', { serverUrl, vaultId, fileId }),
  hostedVaultUploadFile: <T>(serverUrl: string, vaultId: string, parentId: string | null, sourcePath: string) =>
    invoke<T>('hosted_vault_upload_file', { serverUrl, vaultId, parentId, sourcePath }),
  hostedUserDirectory: (serverUrl: string, query: string) =>
    invoke<UserDirectoryEntry[]>('hosted_user_directory', { serverUrl, query }),
  hostedVaultExportZip: (serverUrl: string, vaultId: string, destinationPath: string) =>
    invoke<void>('hosted_vault_export_zip', { serverUrl, vaultId, destinationPath }),
  hostedWsTicket: (serverUrl: string, vaultId: string) =>
    invoke<{ ticket: string; websocketUrl: string; protocolVersion: number | null }>(
      'hosted_ws_ticket',
      { serverUrl, vaultId },
    ),

  // Backend-proxied live-collaboration WebSocket. The socket is held in Rust so
  // it reuses the connected server's TLS configuration (including the untrusted
  // certificate opt-in) — the webview's own WebSocket cannot reach a self-signed
  // or hostname-mismatched server. Inbound frames arrive on `onEvent`.
  liveWsConnect: (serverUrl: string, websocketUrl: string, onEvent: Channel<LiveWsEvent>) =>
    invoke<number>('live_ws_connect', { serverUrl, websocketUrl, onEvent }),
  liveWsSend: (id: number, kind: 'text' | 'binary', data: string) =>
    invoke<void>('live_ws_send', { id, kind, data }),
  liveWsClose: (id: number) =>
    invoke<void>('live_ws_close', { id }),

  // Native hosted-vault replica store (offline sync)
  replicaSeed: (
    serverUrl: string,
    vaultId: string,
    vaultName: string,
    manifest: ReplicaManifest,
    syncState: ReplicaSyncState,
    role?: string | null,
    capabilities?: string[],
  ) => invoke<void>('replica_seed', {
    serverUrl,
    vaultId,
    vaultName,
    manifest,
    syncState,
    role: role ?? null,
    capabilities: capabilities ?? [],
  }),
  replicaList: () => invoke<ReplicaSummary[]>('replica_list'),
  replicaReadManifest: (serverUrl: string, vaultId: string) =>
    invoke<ReplicaManifest | null>('replica_read_manifest', { serverUrl, vaultId }),
  replicaReadSyncState: (serverUrl: string, vaultId: string) =>
    invoke<ReplicaSyncState>('replica_read_sync_state', { serverUrl, vaultId }),
  replicaWriteSyncState: (serverUrl: string, vaultId: string, syncState: ReplicaSyncState) =>
    invoke<void>('replica_write_sync_state', { serverUrl, vaultId, syncState }),
  replicaEnqueueOperation: (serverUrl: string, vaultId: string, operation: PendingOperation) =>
    invoke<void>('replica_enqueue_operation', { serverUrl, vaultId, operation }),
  replicaListPendingOperations: (serverUrl: string, vaultId: string) =>
    invoke<PendingOperation[]>('replica_list_pending_operations', { serverUrl, vaultId }),
  replicaUpdateOperationStatus: (
    serverUrl: string,
    vaultId: string,
    operationId: string,
    status: PendingOpStatus,
  ) => invoke<void>('replica_update_operation_status', { serverUrl, vaultId, operationId, status }),
  replicaRecordOperationFailure: (
    serverUrl: string,
    vaultId: string,
    operationId: string,
    failureCode: string,
    failureMessage: string,
  ) => invoke<void>('replica_record_operation_failure', {
    serverUrl,
    vaultId,
    operationId,
    failureCode,
    failureMessage,
  }),
  replicaRemoveOperation: (serverUrl: string, vaultId: string, operationId: string) =>
    invoke<void>('replica_remove_operation', { serverUrl, vaultId, operationId }),
  replicaRecordTombstone: (serverUrl: string, vaultId: string, tombstone: Tombstone) =>
    invoke<void>('replica_record_tombstone', { serverUrl, vaultId, tombstone }),
  replicaListTombstones: (serverUrl: string, vaultId: string) =>
    invoke<Tombstone[]>('replica_list_tombstones', { serverUrl, vaultId }),
  replicaRemoveTombstone: (serverUrl: string, vaultId: string, fileId: string) =>
    invoke<void>('replica_remove_tombstone', { serverUrl, vaultId, fileId }),
  replicaWriteLogicComponents: (serverUrl: string, vaultId: string, components: LogicComponentTemplate[]) =>
    invoke<void>('replica_write_logic_components', { serverUrl, vaultId, components }),
  replicaReadLogicComponents: (serverUrl: string, vaultId: string) =>
    invoke<LogicComponentTemplate[]>('replica_read_logic_components', { serverUrl, vaultId }),
  replicaCacheDocument: (serverUrl: string, vaultId: string, fileId: string, content: string) =>
    invoke<void>('replica_cache_document', { serverUrl, vaultId, fileId, content }),
  replicaReadCachedDocument: (serverUrl: string, vaultId: string, fileId: string) =>
    invoke<string | null>('replica_read_cached_document', { serverUrl, vaultId, fileId }),
  replicaCacheAsset: (serverUrl: string, vaultId: string, fileId: string, base64Content: string) =>
    invoke<void>('replica_cache_asset', { serverUrl, vaultId, fileId, base64Content }),
  replicaReadCachedAsset: (serverUrl: string, vaultId: string, fileId: string) =>
    invoke<string | null>('replica_read_cached_asset', { serverUrl, vaultId, fileId }),
  replicaCachedContentStatus: (
    serverUrl: string,
    vaultId: string,
    fileId: string,
    kind: 'document' | 'asset',
    expectedSha256?: string | null,
  ) => invoke<CachedContentStatus>('replica_cached_content_status', { serverUrl, vaultId, fileId, kind, expectedSha256 }),
  replicaCacheCrdtState: (serverUrl: string, vaultId: string, fileId: string, base64Content: string) =>
    invoke<void>('replica_cache_crdt_state', { serverUrl, vaultId, fileId, base64Content }),
  replicaReadCrdtState: (serverUrl: string, vaultId: string, fileId: string) =>
    invoke<string | null>('replica_read_crdt_state', { serverUrl, vaultId, fileId }),
  replicaClearCrdtState: (serverUrl: string, vaultId: string, fileId: string) =>
    invoke<void>('replica_clear_crdt_state', { serverUrl, vaultId, fileId }),
  replicaVerify: (serverUrl: string, vaultId: string) =>
    invoke<ReplicaIntegrityReport>('replica_verify', { serverUrl, vaultId }),
  replicaRebuild: (serverUrl: string, vaultId: string) =>
    invoke<ReplicaIntegrityReport>('replica_rebuild', { serverUrl, vaultId }),
  replicaCleanup: (serverUrl: string, vaultId: string, budgetBytes: number) =>
    invoke<CacheCleanupReport>('replica_cleanup', { serverUrl, vaultId, budgetBytes }),
  replicaDelete: (serverUrl: string, vaultId: string) =>
    invoke<void>('replica_delete', { serverUrl, vaultId }),

  // Update
  checkForUpdate: () => invoke<UpdateInfo>('check_for_update'),
  downloadAndInstall: () => invoke<void>('download_and_install_update'),

  // Collab — presence
  writePresence: (vaultPath: string, userId: string, entry: PresenceEntry) =>
    invoke<void>('write_presence', { vaultPath, userId, entry }),
  readAllPresence: (vaultPath: string) => invoke<PresenceEntry[]>('read_all_presence', { vaultPath }),
  clearPresence: (vaultPath: string, userId: string) => invoke<void>('clear_presence', { vaultPath, userId }),

  // Collab — vault config
  getVaultConfig: (vaultPath: string) => invoke<VaultConfig>('get_vault_config', { vaultPath }),
  registerKnownUser: (vaultPath: string, userId: string, userName: string, userColor: string) =>
    invoke<VaultConfig>('register_known_user', { vaultPath, userId, userName, userColor }),

  // Collab — chat
  sendChatMessage: (vaultPath: string, message: ChatMessage) =>
    invoke<void>('send_chat_message', { vaultPath, message }),
  readChatMessages: (vaultPath: string, limit: number) =>
    invoke<ChatMessage[]>('read_chat_messages', { vaultPath, limit }),

  // Collab — history
  createSnapshot: (
    vaultPath: string,
    relativePath: string,
    content: string,
    authorId: string,
    authorName: string,
    label?: string,
  ) => invoke<SnapshotMeta>('create_snapshot', { vaultPath, relativePath, content, authorId, authorName, label: label ?? null }),
  listSnapshots: (vaultPath: string, relativePath: string) =>
    invoke<SnapshotMeta[]>('list_snapshots', { vaultPath, relativePath }),
  readSnapshot: (vaultPath: string, relativePath: string, snapshotId: string) =>
    invoke<string>('read_snapshot', { vaultPath, relativePath, snapshotId }),
  deleteSnapshot: (vaultPath: string, relativePath: string, snapshotId: string) =>
    invoke<void>('delete_snapshot', { vaultPath, relativePath, snapshotId }),
  clearSnapshotHistory: (vaultPath: string, relativePath: string) =>
    invoke<void>('clear_snapshot_history', { vaultPath, relativePath }),
  restoreSnapshot: (
    vaultPath: string,
    relativePath: string,
    snapshotId: string,
    restoringUserId: string,
    restoringUserName: string,
  ) => invoke<WriteResult>('restore_snapshot', { vaultPath, relativePath, snapshotId, restoringUserId, restoringUserName }),

};
