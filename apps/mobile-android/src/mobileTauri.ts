import { Channel, invoke } from '@tauri-apps/api/core';
import { open, save } from '@tauri-apps/plugin-dialog';
import { openUrl } from '@tauri-apps/plugin-opener';
import type { LogicDiagramDocument } from '../../../src/types/logicDiagram';
import type { CalendarCleanupResult, CalendarDefinition, CalendarItem, CalendarMirrorAnchor, CalendarMirrorConflict, CalendarMirrorGroup, CalendarOperation, CalendarOperationFailure, CalendarRemoteChange, CalendarSyncState } from '../../../src/types/calendar';
import type {
  CircuitDcResult,
  CircuitJobOutcome,
  CircuitJobPhase,
  CircuitJobStatus,
  CircuitSweepChunk,
  CircuitSweepResult,
  CircuitTransientChunk,
  CircuitTransientResult,
} from '../../../src/types/circuitRuntime';

export interface ServerHealthStatus {
  ok: boolean;
  serverUrl: string;
  message: string;
}

export function listProfileCalendars(profileId: string): Promise<CalendarDefinition[]> {
  return invoke('calendar_list', { profileId });
}

export function saveProfileCalendar(profileId: string, calendar: CalendarDefinition): Promise<void> {
  return invoke('calendar_save', { profileId, calendar });
}

export function saveProfileCalendarWithOperation(
  profileId: string,
  calendar: CalendarDefinition,
  operation: CalendarOperation,
): Promise<void> {
  return invoke('calendar_save_with_operation', { profileId, calendar, operation });
}

export function deleteProfileCalendar(
  profileId: string,
  calendarId: string,
  deletedAt: string,
  operation: CalendarOperation,
): Promise<void> {
  return invoke('calendar_delete', { profileId, calendarId, deletedAt, operation });
}

export function cleanupProfileCalendar(profileId: string, retentionDays = 90): Promise<CalendarCleanupResult> {
  return invoke('calendar_cleanup', { profileId, retentionDays });
}

export function listProfileCalendarItems(
  profileId: string,
  from: string,
  to: string,
  limit = 500,
  includeDeleted = false,
): Promise<CalendarItem[]> {
  return invoke('calendar_list_items', { profileId, from, to, limit, includeDeleted });
}

export function upsertProfileCalendarItem(
  profileId: string,
  item: CalendarItem,
  operation: CalendarOperation,
): Promise<void> {
  return invoke('calendar_upsert_item', { profileId, item, operation });
}

export function deleteProfileCalendarItem(
  profileId: string,
  calendarId: string,
  itemId: string,
  deletedAt: string,
  operation: CalendarOperation,
): Promise<void> {
  return invoke('calendar_delete_item', { profileId, calendarId, itemId, deletedAt, operation });
}

export function searchProfileCalendarItems(profileId: string, query: string, limit = 100): Promise<CalendarItem[]> {
  return invoke('calendar_search_items', { profileId, query, limit });
}

export function acknowledgeProfileCalendarOperations(profileId: string, clientOperationIds: string[]): Promise<void> {
  return invoke('calendar_acknowledge_operations', { profileId, clientOperationIds });
}

export function readProfileCalendarSyncState(profileId: string, originKey: string): Promise<CalendarSyncState | null> {
  return invoke('calendar_read_sync_state', { profileId, originKey });
}

export function writeProfileCalendarSyncState(profileId: string, state: CalendarSyncState): Promise<void> {
  return invoke('calendar_write_sync_state', { profileId, state });
}

export function applyProfileCalendarRemoteChanges(
  profileId: string,
  changes: CalendarRemoteChange[],
  state: CalendarSyncState,
): Promise<void> {
  return invoke('calendar_apply_remote_changes', { profileId, changes, state });
}

export function listProfileCalendarPendingOperations(profileId: string): Promise<CalendarOperation[]> {
  return invoke('calendar_list_pending_operations', { profileId });
}

export function listProfileCalendarFailedOperations(profileId: string): Promise<CalendarOperationFailure[]> {
  return invoke('calendar_list_failed_operations', { profileId });
}

export function markProfileCalendarOperationFailed(
  profileId: string,
  clientOperationId: string,
  error: string,
  attemptedAt: string,
): Promise<void> {
  return invoke('calendar_mark_operation_failed', { profileId, clientOperationId, error, attemptedAt });
}

export function retryProfileCalendarOperation(profileId: string, clientOperationId: string): Promise<void> {
  return invoke('calendar_retry_operation', { profileId, clientOperationId });
}

export function discardProfileCalendarOperation(profileId: string, clientOperationId: string): Promise<void> {
  return invoke('calendar_discard_operation', { profileId, clientOperationId });
}

export function removeHostedCalendarCache(
  profileId: string,
  serverUrl: string,
  userId: string,
): Promise<CalendarCleanupResult> {
  return invoke('calendar_remove_hosted_cache', { profileId, serverUrl, userId });
}

export function listProfileCalendarMirrorGroups(profileId: string): Promise<CalendarMirrorGroup[]> {
  return invoke('calendar_list_mirror_groups', { profileId });
}

export function saveProfileCalendarMirrorGroup(profileId: string, group: CalendarMirrorGroup): Promise<void> {
  return invoke('calendar_save_mirror_group', { profileId, group });
}

export function deleteProfileCalendarMirrorGroup(profileId: string, groupId: string): Promise<void> {
  return invoke('calendar_delete_mirror_group', { profileId, groupId });
}

export function listProfileCalendarMirrorAnchors(profileId: string, groupId: string): Promise<CalendarMirrorAnchor[]> {
  return invoke('calendar_list_mirror_anchors', { profileId, groupId });
}

export function saveProfileCalendarMirrorAnchors(profileId: string, anchors: CalendarMirrorAnchor[]): Promise<void> {
  return invoke('calendar_save_mirror_anchors', { profileId, anchors });
}

export function listProfileCalendarMirrorConflicts(
  profileId: string,
  groupId?: string,
  includeResolved = false,
): Promise<CalendarMirrorConflict[]> {
  return invoke('calendar_list_mirror_conflicts', { profileId, groupId: groupId ?? null, includeResolved });
}

export function saveProfileCalendarMirrorConflict(profileId: string, conflict: CalendarMirrorConflict): Promise<void> {
  return invoke('calendar_save_mirror_conflict', { profileId, conflict });
}

export function listProfileCalendarMirrorItems(profileId: string, calendarIds: string[], limit = 5_000): Promise<CalendarItem[]> {
  return invoke('calendar_list_mirror_items', { profileId, calendarIds, limit });
}

export function hostedCalendarRequest<T>(
  serverUrl: string,
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  path: string,
  body?: unknown,
): Promise<T> {
  return invoke('hosted_calendar_request', { serverUrl, method, path, body: body ?? null });
}

export interface ServerUser {
  id: string;
  username: string;
  displayName: string | null;
}

export interface UserDirectoryEntry {
  userId: string;
  username: string;
  displayName: string | null;
}

export function hostedUserDirectory(serverUrl: string, query: string): Promise<UserDirectoryEntry[]> {
  return invoke('hosted_user_directory', { serverUrl, query });
}

export function openExternalUrl(url: string): Promise<void> {
  return openUrl(url);
}

export interface ServerConnectionStatus {
  connected: boolean;
  serverUrl: string | null;
  allowInvalidCertificates: boolean;
  user: ServerUser | null;
  accessExpiresAt: string | null;
}

export type MemberRole = 'viewer' | 'editor' | 'admin';

export interface HostedVault {
  id: string;
  name: string;
  role: MemberRole;
  status: string;
  members: number;
  storageBytes: number;
  manifestSequence: number;
  updatedAt: string | null;
  capabilities: string[];
  requireOfflineCopy?: boolean;
}

export type HostedFileKind = 'document' | 'asset' | 'folder';

export interface HostedFileEntry {
  id: string;
  parentId: string | null;
  name: string;
  relativePath: string;
  kind: HostedFileKind;
  documentType: string | null;
  state: string;
  updatedAt: string | null;
  sizeBytes: number | null;
  contentHash: string | null;
  revisionSequence: number | null;
}

export interface HostedTextDocument {
  file: HostedFileEntry;
  content: string;
}

export interface WsTicket {
  ticket: string;
  websocketUrl: string;
  protocolVersion: number | null;
}

export type LiveWsEvent =
  | { type: 'text'; data: string }
  | { type: 'binary'; data: string }
  | { type: 'closed'; code: number | null };

/**
 * The native manifest as it crosses the IPC boundary — the raw server shape with
 * full `HostedFileEntry` fields. It is passed to `replica_seed` unchanged (the
 * Rust store deserializes the complete DTO) and returned from
 * `replica_read_manifest`. Use {@link parseFileEntries} on `files` for app logic.
 */
export interface RawHostedManifest {
  vaultId?: string;
  sequence: number;
  files: unknown[];
}

export type SyncStatus = 'idle' | 'syncing' | 'offline' | 'error';

export interface ReplicaSyncState {
  manifestSequence: number;
  lastSyncedAt: string | null;
  offlineAvailableAt?: string | null;
  status: SyncStatus;
}

export interface ReplicaSummary {
  serverUrl: string;
  vaultId: string;
  vaultName: string;
  manifestSequence: number;
  lastSyncedAt: string | null;
  status: SyncStatus;
  pendingCount: number;
  updatedAt: string;
  role: string | null;
  capabilities: string[];
}

export interface CachedContentStatus {
  present: boolean;
  matchesExpectedHash: boolean;
  actualSha256: string | null;
  sizeBytes: number | null;
}

export interface ConnectOptions {
  allowInvalidCertificates?: boolean;
  persistAcrossReboots?: boolean;
}

export interface HostedUploadPayload {
  name: string;
  mediaType: string;
  contentBase64: string;
  expectedHash: string;
}

export function checkServerHealth(
  serverUrl: string,
  allowInvalidCertificates = false,
): Promise<ServerHealthStatus> {
  return invoke('server_health_check', { serverUrl, allowInvalidCertificates });
}

export function loadConnectionStatuses(): Promise<ServerConnectionStatus[]> {
  return invoke('server_connection_statuses');
}

export function connectServer(
  serverUrl: string,
  username: string,
  password: string,
  options: ConnectOptions = {},
): Promise<ServerConnectionStatus> {
  return invoke('connect_server', {
    serverUrl,
    username,
    password,
    allowInvalidCertificates: options.allowInvalidCertificates ?? false,
    persistAcrossReboots: options.persistAcrossReboots ?? true,
  });
}

export function reconnectServer(
  serverUrl: string,
  options: ConnectOptions = {},
): Promise<ServerConnectionStatus> {
  return invoke('reconnect_server', {
    serverUrl,
    allowInvalidCertificates: options.allowInvalidCertificates ?? false,
    persistAcrossReboots: options.persistAcrossReboots ?? true,
  });
}

export function disconnectServer(serverUrl: string): Promise<void> {
  return invoke('disconnect_server', { serverUrl });
}

export function serverHasSavedSession(serverUrl: string): Promise<boolean> {
  return invoke('server_has_saved_session', { serverUrl });
}

export function mobileExitApp(): Promise<void> {
  return invoke('mobile_exit_app');
}

export function circuitStartDc(document: LogicDiagramDocument): Promise<string> {
  return invoke('circuit_start_dc', { document });
}

export function circuitStartDcSweep(document: LogicDiagramDocument): Promise<string> {
  return invoke('circuit_start_dc_sweep', { document });
}

export function circuitStartTransient(document: LogicDiagramDocument): Promise<string> {
  return invoke('circuit_start_transient', { document });
}

export function circuitJobStatus(jobId: string): Promise<CircuitJobStatus> {
  return invoke('circuit_job_status', { jobId });
}

export function circuitCancelJob(jobId: string): Promise<CircuitJobPhase> {
  return invoke('circuit_cancel_job', { jobId });
}

export function circuitTakeJobResult(jobId: string): Promise<CircuitJobOutcome | null> {
  return invoke('circuit_take_job_result', { jobId });
}

export function circuitReadSweepChunk(
  jobId: string,
  offset: number,
  limit: number,
): Promise<CircuitSweepChunk> {
  return invoke('circuit_read_sweep_chunk', { jobId, offset, limit });
}

export function circuitReadTransientChunk(
  jobId: string,
  offset: number,
  limit: number,
): Promise<CircuitTransientChunk> {
  return invoke('circuit_read_transient_chunk', { jobId, offset, limit });
}

export function circuitDiscardJob(jobId: string): Promise<void> {
  return invoke('circuit_discard_job', { jobId });
}

export type {
  CircuitDcResult,
  CircuitJobOutcome,
  CircuitJobPhase,
  CircuitJobStatus,
  CircuitSweepChunk,
  CircuitSweepResult,
  CircuitTransientChunk,
  CircuitTransientResult,
};

function asRecord(value: unknown, message: string): Record<string, unknown> {
  if (!value || typeof value !== 'object') throw new Error(message);
  return value as Record<string, unknown>;
}

function optString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function optNumber(value: unknown): number | null {
  return typeof value === 'number' ? value : null;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

export async function listHostedVaults(serverUrl: string): Promise<HostedVault[]> {
  const value = await invoke<unknown>('hosted_vault_request', {
    serverUrl,
    method: 'GET',
    path: '/api/v1/vaults',
    body: null,
  });
  if (!Array.isArray(value)) throw new Error('The server returned an invalid vault list.');
  return value.map((item) => {
    const entry = asRecord(item, 'The server returned an invalid vault entry.');
    if (typeof entry.id !== 'string' || typeof entry.name !== 'string') {
      throw new Error('The server returned an invalid vault entry.');
    }
    const role = optString(entry.role);
    return {
      id: entry.id,
      name: entry.name,
      role: role === 'admin' || role === 'editor' || role === 'viewer' ? role : 'viewer',
      status: optString(entry.status) ?? 'active',
      members: optNumber(entry.members) ?? 0,
      storageBytes: optNumber(entry.storageBytes) ?? 0,
      manifestSequence: optNumber(entry.manifestSequence) ?? 0,
      updatedAt: optString(entry.updatedAt),
      capabilities: stringArray(entry.capabilities),
      requireOfflineCopy: entry.requireOfflineCopy === true,
    };
  });
}

function parseFileEntry(item: unknown): HostedFileEntry {
  const entry = asRecord(item, 'The server returned an invalid file entry.');
  const kind = optString(entry.kind);
  const revision = entry.currentRevision;
  const revisionRecord =
    revision && typeof revision === 'object' ? (revision as Record<string, unknown>) : null;
  return {
    id: typeof entry.id === 'string' ? entry.id : '',
    parentId: optString(entry.parentId),
    name: typeof entry.name === 'string' ? entry.name : '(unnamed)',
    relativePath: optString(entry.relativePath) ?? '',
    kind: kind === 'document' || kind === 'asset' || kind === 'folder' ? kind : 'document',
    documentType: optString(entry.documentType),
    state: optString(entry.state) ?? 'active',
    updatedAt: optString(entry.updatedAt),
    sizeBytes: revisionRecord ? optNumber(revisionRecord.sizeBytes) : null,
    contentHash: revisionRecord ? optString(revisionRecord.contentHash) : null,
    revisionSequence: revisionRecord ? optNumber(revisionRecord.sequence) : null,
  };
}

export function parseFileEntries(value: unknown): HostedFileEntry[] {
  if (!Array.isArray(value)) throw new Error('The server returned an invalid file list.');
  return value.map(parseFileEntry);
}

export function hostedRequest<T>(
  serverUrl: string,
  method: string,
  path: string,
  body: unknown = null,
): Promise<T> {
  return invoke<T>('hosted_vault_request', { serverUrl, method, path, body });
}

export async function listVaultFiles(
  serverUrl: string,
  vaultId: string,
): Promise<HostedFileEntry[]> {
  return parseFileEntries(
    await invoke<unknown>('hosted_vault_request', {
      serverUrl,
      method: 'GET',
      path: `/api/v1/vaults/${vaultId}/files`,
      body: null,
    }),
  );
}

export function hostedAssetDataUrl(
  serverUrl: string,
  vaultId: string,
  fileId: string,
): Promise<string> {
  return invoke('hosted_vault_asset_data_url', { serverUrl, vaultId, fileId });
}

export async function showMobileOpenFiles(extensions: string[]): Promise<string[]> {
  const result = await open({
    multiple: true,
    title: 'Upload files',
    filters: [{ name: 'Supported files', extensions }],
  });
  if (Array.isArray(result)) return result;
  return typeof result === 'string' ? [result] : [];
}

export function showMobileSaveDialog(defaultName: string): Promise<string | null> {
  return save({ title: 'Download', defaultPath: defaultName });
}

export function downloadHostedEntry(
  serverUrl: string,
  vaultId: string,
  fileId: string,
  archive: boolean,
  destinationPath: string,
): Promise<void> {
  return invoke('hosted_vault_download_entry', {
    serverUrl,
    vaultId,
    fileId,
    archive,
    destinationPath,
  });
}

export function downloadHostedVault(
  serverUrl: string,
  vaultId: string,
  destinationPath: string,
): Promise<void> {
  return invoke('hosted_vault_export_zip', { serverUrl, vaultId, destinationPath });
}

export async function uploadHostedFile(
  serverUrl: string,
  vaultId: string,
  parentId: string | null,
  sourcePath: string,
): Promise<HostedFileEntry> {
  return parseFileEntry(await invoke('hosted_vault_upload_file', { serverUrl, vaultId, parentId, sourcePath }));
}

export function readFileForUpload(sourcePath: string): Promise<HostedUploadPayload> {
  return invoke('read_file_for_upload', { sourcePath });
}

export async function createHostedDocument(
  serverUrl: string,
  vaultId: string,
  parentId: string | null,
  name: string,
  documentType: 'note' | 'kanban' | 'canvas',
  content = '',
): Promise<HostedFileEntry> {
  const value = await hostedRequest<unknown>(serverUrl, 'POST', `/api/v1/vaults/${vaultId}/files`, {
    parentId,
    name,
    kind: 'document',
    documentType,
    content,
  });
  return parseFileEntry(value);
}

function parseHostedTextDocument(value: unknown): HostedTextDocument {
  const entry = asRecord(value, 'The server returned an invalid document.');
  if (typeof entry.content !== 'string') {
    throw new Error('The server returned an invalid document.');
  }
  return {
    file: parseFileEntry(entry.file),
    content: entry.content,
  };
}

export async function readHostedDocument(
  serverUrl: string,
  vaultId: string,
  fileId: string,
): Promise<HostedTextDocument> {
  return parseHostedTextDocument(
    await hostedRequest<unknown>(serverUrl, 'GET', `/api/v1/vaults/${vaultId}/files/${fileId}`),
  );
}

export async function writeHostedDocument(
  serverUrl: string,
  vaultId: string,
  fileId: string,
  expectedRevisionSequence: number,
  content: string,
): Promise<HostedTextDocument> {
  return parseHostedTextDocument(
    await hostedRequest<unknown>(
      serverUrl,
      'POST',
      `/api/v1/vaults/${vaultId}/files/${fileId}/revisions`,
      { expectedRevisionSequence, content },
    ),
  );
}

export function hostedWsTicket(serverUrl: string, vaultId: string): Promise<WsTicket> {
  return invoke('hosted_ws_ticket', { serverUrl, vaultId });
}

export function liveWsConnect(
  serverUrl: string,
  websocketUrl: string,
  onEvent: Channel<LiveWsEvent>,
): Promise<number> {
  return invoke('live_ws_connect', { serverUrl, websocketUrl, onEvent });
}

export function liveWsSend(id: number, kind: 'text' | 'binary', data: string): Promise<void> {
  return invoke('live_ws_send', { id, kind, data });
}

export function liveWsClose(id: number): Promise<void> {
  return invoke('live_ws_close', { id });
}

// ── Native replica store (offline availability) ─────────────────────────────

export function replicaList(): Promise<ReplicaSummary[]> {
  return invoke('replica_list');
}

export function replicaSeed(
  serverUrl: string,
  vaultId: string,
  vaultName: string,
  manifest: RawHostedManifest,
  syncState: ReplicaSyncState,
  role: string | null,
  capabilities: string[],
): Promise<void> {
  return invoke('replica_seed', {
    serverUrl,
    vaultId,
    vaultName,
    manifest,
    syncState,
    role,
    capabilities,
  });
}

export function replicaReadManifest(
  serverUrl: string,
  vaultId: string,
): Promise<RawHostedManifest | null> {
  return invoke('replica_read_manifest', { serverUrl, vaultId });
}

export function replicaReadSyncState(
  serverUrl: string,
  vaultId: string,
): Promise<ReplicaSyncState> {
  return invoke('replica_read_sync_state', { serverUrl, vaultId });
}

export function replicaWriteSyncState(
  serverUrl: string,
  vaultId: string,
  syncState: ReplicaSyncState,
): Promise<void> {
  return invoke('replica_write_sync_state', { serverUrl, vaultId, syncState });
}

export function replicaCachedContentStatus(
  serverUrl: string,
  vaultId: string,
  fileId: string,
  kind: string,
  expectedSha256: string | null,
): Promise<CachedContentStatus> {
  return invoke('replica_cached_content_status', {
    serverUrl,
    vaultId,
    fileId,
    kind,
    expectedSha256,
  });
}

export function replicaCacheDocument(
  serverUrl: string,
  vaultId: string,
  fileId: string,
  content: string,
): Promise<void> {
  return invoke('replica_cache_document', { serverUrl, vaultId, fileId, content });
}

export function replicaCacheCrdtState(
  serverUrl: string,
  vaultId: string,
  fileId: string,
  base64Content: string,
): Promise<void> {
  return invoke('replica_cache_crdt_state', { serverUrl, vaultId, fileId, base64Content });
}

export function replicaReadCrdtState(
  serverUrl: string,
  vaultId: string,
  fileId: string,
): Promise<string | null> {
  return invoke('replica_read_crdt_state', { serverUrl, vaultId, fileId });
}

export function replicaClearCrdtState(
  serverUrl: string,
  vaultId: string,
  fileId: string,
): Promise<void> {
  return invoke('replica_clear_crdt_state', { serverUrl, vaultId, fileId });
}

export function replicaReadCachedDocument(
  serverUrl: string,
  vaultId: string,
  fileId: string,
): Promise<string | null> {
  return invoke('replica_read_cached_document', { serverUrl, vaultId, fileId });
}

export function replicaReadCachedAsset(
  serverUrl: string,
  vaultId: string,
  fileId: string,
): Promise<string | null> {
  return invoke('replica_read_cached_asset', { serverUrl, vaultId, fileId });
}

export function replicaCacheAsset(
  serverUrl: string,
  vaultId: string,
  fileId: string,
  base64Content: string,
): Promise<void> {
  return invoke('replica_cache_asset', { serverUrl, vaultId, fileId, base64Content });
}

export function replicaDelete(serverUrl: string, vaultId: string): Promise<void> {
  return invoke('replica_delete', { serverUrl, vaultId });
}

// ── Pending-operation queue (offline writes) ─────────────────────────────────

export type PendingOpKind =
  | 'create'
  | 'edit'
  | 'rename'
  | 'move'
  | 'trash'
  | 'restore'
  | 'delete'
  | 'assetUpload';

export type PendingOpStatus = 'pending' | 'inflight' | 'failed';

/**
 * An append-only offline write queued in the native replica. Mirrors the desktop
 * `PendingOperation` shape so both clients replay through the same native store.
 * The notes MVP only produces `edit` operations; the type covers the full set so
 * the queue stays forward-compatible with Kanban/structural offline writes.
 */
export interface PendingOperation {
  id: string;
  kind: PendingOpKind;
  fileId: string | null;
  relativePath: string | null;
  payload: unknown;
  /** The manifest sequence the operation was authored against. */
  baseManifestSequence: number;
  createdAt: string;
  status: PendingOpStatus;
  failureCode?: string | null;
  failureMessage?: string | null;
}

export function replicaEnqueueOperation(
  serverUrl: string,
  vaultId: string,
  operation: PendingOperation,
): Promise<void> {
  return invoke('replica_enqueue_operation', { serverUrl, vaultId, operation });
}

export function replicaListPendingOperations(
  serverUrl: string,
  vaultId: string,
): Promise<PendingOperation[]> {
  return invoke('replica_list_pending_operations', { serverUrl, vaultId });
}

export function replicaUpdateOperationStatus(
  serverUrl: string,
  vaultId: string,
  operationId: string,
  status: PendingOpStatus,
): Promise<void> {
  return invoke('replica_update_operation_status', { serverUrl, vaultId, operationId, status });
}

export function replicaRecordOperationFailure(
  serverUrl: string,
  vaultId: string,
  operationId: string,
  failureCode: string,
  failureMessage: string,
): Promise<void> {
  return invoke('replica_record_operation_failure', {
    serverUrl,
    vaultId,
    operationId,
    failureCode,
    failureMessage,
  });
}

export function replicaRemoveOperation(
  serverUrl: string,
  vaultId: string,
  operationId: string,
): Promise<void> {
  return invoke('replica_remove_operation', { serverUrl, vaultId, operationId });
}
