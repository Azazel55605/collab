import type {
  AdminOverview,
  AdminBackupCommandResult,
  AdminBackupOverview,
  AdminBackupVerification,
  AdminServerSettings,
  AuditEvent,
  CreatedInvitation,
  HostedVaultActivityEvent,
  HostedVaultAdminDetail,
  HostedChatMessage,
  HostedFileEntry,
  HostedFileRevision,
  HostedVaultImportResult,
  HostedVaultMember,
  HostedVaultStorage,
  HostedVaultManifest,
  HostedVaultSummary,
  Invitation,
  LiveDebugState,
  MaintenanceReport,
  PermissionTemplate,
  ServerUser,
  UserGroup,
  UserGroupMember,
  VaultGrant,
} from './types';

interface DataResponse<T> {
  data: T;
}

interface ErrorResponse {
  error?: {
    message?: string;
    requestId?: string;
  };
}

function readCookie(name: string) {
  return document.cookie
    .split(';')
    .map((value) => value.trim().split('='))
    .find(([key]) => key === name)?.[1];
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body) headers.set('content-type', 'application/json');
  const csrf = readCookie('collab_csrf');
  if (csrf && init.method && init.method !== 'GET') headers.set('x-collab-csrf', csrf);
  const response = await fetch(path, { ...init, headers, credentials: 'same-origin' });
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as ErrorResponse;
    const suffix = body.error?.requestId ? ` (${body.error.requestId})` : '';
    throw new Error(`${body.error?.message ?? `Request failed with ${response.status}`}${suffix}`);
  }
  if (response.status === 204) return undefined as T;
  // Some 2xx endpoints (e.g. adding a group member) return an empty body; treat
  // a blank response as a void result instead of failing to parse JSON.
  const text = await response.text();
  if (!text) return undefined as T;
  return (JSON.parse(text) as DataResponse<T>).data;
}

async function apiBlob(path: string): Promise<Blob> {
  const response = await fetch(path, { credentials: 'same-origin' });
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as ErrorResponse;
    const suffix = body.error?.requestId ? ` (${body.error.requestId})` : '';
    throw new Error(`${body.error?.message ?? `Request failed with ${response.status}`}${suffix}`);
  }
  return response.blob();
}

export const serverApi = {
  bootstrapStatus: () => api<{ required: boolean }>('/api/v1/auth/bootstrap-status', { cache: 'no-store' }),
  bootstrap: (payload: Record<string, unknown>) =>
    api<{ user: ServerUser; csrfToken: string }>('/api/v1/auth/bootstrap', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  login: (payload: Record<string, unknown>) =>
    api<{ user: ServerUser; csrfToken: string }>('/api/v1/auth/login', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  acceptInvitation: (token: string, password: string) =>
    api<{ user: ServerUser; csrfToken: string }>(`/api/v1/auth/invitations/${encodeURIComponent(token)}/accept`, {
      method: 'POST',
      body: JSON.stringify({ password }),
    }),
  logout: () => api<void>('/api/v1/auth/logout', { method: 'POST' }),
  me: () => api<ServerUser>('/api/v1/users/me'),
  updateSelf: (payload: Record<string, unknown>) =>
    api<ServerUser>('/api/v1/users/me', { method: 'PATCH', body: JSON.stringify(payload) }),
  changeOwnPassword: (currentPassword: string, newPassword: string) =>
    api<void>('/api/v1/users/me/password', { method: 'POST', body: JSON.stringify({ currentPassword, newPassword }) }),
  uploadOwnAvatar: (mediaType: string, contentBase64: string) =>
    api<ServerUser>('/api/v1/users/me/avatar', { method: 'PUT', body: JSON.stringify({ mediaType, contentBase64 }) }),
  deleteOwnAvatar: () => api<ServerUser>('/api/v1/users/me/avatar', { method: 'DELETE' }),
  avatarUrl: (userId: string, updatedAt?: string | null) =>
    `/api/v1/users/${userId}/avatar${updatedAt ? `?v=${encodeURIComponent(updatedAt)}` : ''}`,
  overview: () => api<AdminOverview>('/api/v1/admin/overview'),
  settings: () => api<AdminServerSettings>('/api/v1/admin/settings'),
  updateSettings: (payload: Record<string, unknown>) =>
    api<AdminServerSettings>('/api/v1/admin/settings', { method: 'PATCH', body: JSON.stringify(payload) }),
  runMaintenance: () => api<MaintenanceReport>('/api/v1/admin/maintenance', { method: 'POST' }),
  liveDebug: () => api<LiveDebugState>('/api/v1/admin/live-debug'),
  setLiveDebug: (enabled: boolean) =>
    api<LiveDebugState>('/api/v1/admin/live-debug', { method: 'PUT', body: JSON.stringify({ enabled }) }),
  backups: () => api<AdminBackupOverview>('/api/v1/admin/backups'),
  updateBackupSettings: (payload: Record<string, unknown>) =>
    api<AdminBackupOverview>('/api/v1/admin/backups/settings', { method: 'PATCH', body: JSON.stringify(payload) }),
  runBackup: () => api<AdminBackupCommandResult>('/api/v1/admin/backups', { method: 'POST' }),
  verifyBackup: (name: string) =>
    api<AdminBackupVerification>(`/api/v1/admin/backups/${encodeURIComponent(name)}/verify`, { method: 'POST' }),
  restoreBackup: (name: string) =>
    api<AdminBackupCommandResult>(`/api/v1/admin/backups/${encodeURIComponent(name)}/restore`, {
      method: 'POST',
      body: JSON.stringify({ confirmation: 'restore' }),
    }),
  exportBackup: (name: string) =>
    apiBlob(`/api/v1/admin/backups/${encodeURIComponent(name)}/archive`),
  importBackup: (archiveBase64: string) =>
    api<AdminBackupOverview>('/api/v1/admin/backups/import', {
      method: 'POST',
      body: JSON.stringify({ archiveBase64 }),
    }),
  deleteBackup: (name: string) =>
    api<void>(`/api/v1/admin/backups/${encodeURIComponent(name)}`, { method: 'DELETE' }),
  users: () => api<ServerUser[]>('/api/v1/admin/users'),
  createUser: (payload: Record<string, unknown>) =>
    api<ServerUser>('/api/v1/admin/users', { method: 'POST', body: JSON.stringify(payload) }),
  updateUser: (id: string, payload: Record<string, unknown>) =>
    api<ServerUser>(`/api/v1/admin/users/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(payload),
    }),
  deleteUser: (id: string) => api<void>(`/api/v1/admin/users/${id}`, { method: 'DELETE' }),
  revokeSessions: (id: string) =>
    api<void>(`/api/v1/admin/users/${id}/revoke-sessions`, { method: 'POST' }),
  resetPassword: (id: string, newPassword: string) =>
    api<void>(`/api/v1/admin/users/${id}/reset-password`, {
      method: 'POST',
      body: JSON.stringify({ newPassword }),
    }),
  userActivity: (id: string) => api<AuditEvent[]>(`/api/v1/admin/users/${id}/activity`),
  invitations: () => api<Invitation[]>('/api/v1/admin/invitations'),
  createInvitation: (payload: Record<string, unknown>) =>
    api<CreatedInvitation>('/api/v1/admin/invitations', { method: 'POST', body: JSON.stringify(payload) }),
  revokeInvitation: (id: string) =>
    api<void>(`/api/v1/admin/invitations/${id}`, { method: 'DELETE' }),
  vaults: () => api<HostedVaultSummary[]>('/api/v1/admin/vaults'),
  createVault: (payload: Record<string, unknown>) =>
    api<{ id: string }>('/api/v1/vaults', { method: 'POST', body: JSON.stringify(payload) }),
  vaultDetail: (id: string) => api<HostedVaultAdminDetail>(`/api/v1/admin/vaults/${id}`),
  updateVault: (id: string, payload: Record<string, unknown>) =>
    api<HostedVaultAdminDetail>(`/api/v1/admin/vaults/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(payload),
    }),
  deleteVault: (id: string) => api<void>(`/api/v1/admin/vaults/${id}`, { method: 'DELETE' }),
  forceDeleteVault: (id: string) =>
    api<void>(`/api/v1/admin/vaults/${id}/force-delete`, { method: 'POST' }),
  vaultMembers: (id: string) => api<HostedVaultMember[]>(`/api/v1/admin/vaults/${id}/members`),
  addVaultMember: (id: string, payload: Record<string, unknown>) =>
    api<HostedVaultMember>(`/api/v1/admin/vaults/${id}/members`, {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  updateVaultMember: (id: string, userId: string, payload: Record<string, unknown>) =>
    api<HostedVaultMember>(`/api/v1/admin/vaults/${id}/members/${userId}`, {
      method: 'PATCH',
      body: JSON.stringify(payload),
    }),
  removeVaultMember: (id: string, userId: string) =>
    api<void>(`/api/v1/admin/vaults/${id}/members/${userId}`, { method: 'DELETE' }),
  vaultActivity: (id: string) => api<HostedVaultActivityEvent[]>(`/api/v1/admin/vaults/${id}/activity`),
  vaultChat: (id: string) => api<HostedChatMessage[]>(`/api/v1/vaults/${id}/chat?limit=100`),
  vaultStorage: (id: string) => api<HostedVaultStorage>(`/api/v1/vaults/${id}/storage`),
  vaultFiles: (id: string) => api<HostedVaultManifest>(`/api/v1/vaults/${id}/manifest`),
  fileRevisions: (vaultId: string, fileId: string) =>
    api<HostedFileRevision[]>(`/api/v1/vaults/${vaultId}/files/${fileId}/revisions`),
  downloadFile: (vaultId: string, fileId: string) =>
    apiBlob(`/api/v1/vaults/${vaultId}/files/${fileId}/content`),
  downloadFolder: (vaultId: string, fileId: string) =>
    apiBlob(`/api/v1/vaults/${vaultId}/files/${fileId}/archive`),
  moveFile: (vaultId: string, payload: Record<string, unknown>) =>
    api<{ resultManifestSequence: number }>(`/api/v1/vaults/${vaultId}/operations`, {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  restoreFileRevision: (vaultId: string, fileId: string, revisionId: string, expectedRevisionSequence: number) =>
    api<unknown>(`/api/v1/vaults/${vaultId}/files/${fileId}/revisions/${revisionId}`, {
      method: 'POST',
      body: JSON.stringify({ expectedRevisionSequence }),
    }),
  deleteFileRevision: (vaultId: string, fileId: string, revisionId: string) =>
    api<HostedFileRevision[]>(`/api/v1/vaults/${vaultId}/files/${fileId}/revisions/${revisionId}`, { method: 'DELETE' }),
  deleteFileRevisions: (vaultId: string, fileId: string, payload: { revisionIds?: string[]; all?: boolean }) =>
    api<HostedFileRevision[]>(`/api/v1/vaults/${vaultId}/files/${fileId}/revisions`, {
      method: 'DELETE',
      body: JSON.stringify(payload),
    }),
  importVault: (id: string, archiveBase64: string) =>
    api<HostedVaultImportResult>(`/api/v1/vaults/${id}/import`, {
      method: 'POST',
      body: JSON.stringify({ archiveBase64 }),
    }),
  exportVault: (id: string) => apiBlob(`/api/v1/vaults/${id}/export`),
  auditEvents: () => api<AuditEvent[]>('/api/v1/admin/audit-events'),

  // Permission templates
  templates: () => api<PermissionTemplate[]>('/api/v1/admin/templates'),
  createTemplate: (payload: Record<string, unknown>) =>
    api<PermissionTemplate>('/api/v1/admin/templates', { method: 'POST', body: JSON.stringify(payload) }),
  updateTemplate: (id: string, payload: Record<string, unknown>) =>
    api<PermissionTemplate>(`/api/v1/admin/templates/${id}`, { method: 'PATCH', body: JSON.stringify(payload) }),
  deleteTemplate: (id: string) => api<void>(`/api/v1/admin/templates/${id}`, { method: 'DELETE' }),

  // User groups
  groups: () => api<UserGroup[]>('/api/v1/admin/groups'),
  createGroup: (payload: Record<string, unknown>) =>
    api<UserGroup>('/api/v1/admin/groups', { method: 'POST', body: JSON.stringify(payload) }),
  updateGroup: (id: string, payload: Record<string, unknown>) =>
    api<UserGroup>(`/api/v1/admin/groups/${id}`, { method: 'PATCH', body: JSON.stringify(payload) }),
  deleteGroup: (id: string) => api<void>(`/api/v1/admin/groups/${id}`, { method: 'DELETE' }),
  groupMembers: (id: string) => api<UserGroupMember[]>(`/api/v1/admin/groups/${id}/members`),
  addGroupMember: (id: string, userId: string) =>
    api<void>(`/api/v1/admin/groups/${id}/members/${userId}`, { method: 'POST' }),
  removeGroupMember: (id: string, userId: string) =>
    api<void>(`/api/v1/admin/groups/${id}/members/${userId}`, { method: 'DELETE' }),

  // Vault grants
  vaultGrants: (id: string) => api<VaultGrant[]>(`/api/v1/admin/vaults/${id}/grants`),
  putVaultGrant: (id: string, subjectType: 'user' | 'group', subjectId: string, payload: Record<string, unknown>) =>
    api<VaultGrant>(`/api/v1/admin/vaults/${id}/grants/${subjectType}/${subjectId}`, {
      method: 'PUT',
      body: JSON.stringify(payload),
    }),
  deleteVaultGrant: (id: string, subjectType: 'user' | 'group', subjectId: string) =>
    api<void>(`/api/v1/admin/vaults/${id}/grants/${subjectType}/${subjectId}`, { method: 'DELETE' }),
};
