import { invoke } from '@tauri-apps/api/core';
import { getVersion } from '@tauri-apps/api/app';
import { open, save } from '@tauri-apps/plugin-dialog';

export const getAppVersion = getVersion;
import type { VaultMeta, NoteFile, NoteContent, WriteResult, VaultConfig, MemberRole } from '../types/vault';
import type { NoteMetadata, SearchResult } from '../types/note';
import type { PresenceEntry, ChatMessage, SnapshotMeta } from '../types/collab';
import type { UpdateInfo } from '../store/updateStore';

export const tauriCommands = {
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
  writeNote: (vaultPath: string, relativePath: string, content: string, expectedHash?: string) =>
    invoke<WriteResult>('write_note', { vaultPath, relativePath, content, expectedHash: expectedHash ?? null }),
  createNote: (vaultPath: string, relativePath: string) => invoke<NoteFile>('create_note', { vaultPath, relativePath }),
  deleteNote: (vaultPath: string, relativePath: string) => invoke<void>('delete_note', { vaultPath, relativePath }),
  renameNote: (vaultPath: string, oldPath: string, newPath: string) => invoke<void>('rename_note', { vaultPath, oldPath, newPath }),
  createFolder: (vaultPath: string, relativePath: string) => invoke<void>('create_folder', { vaultPath, relativePath }),

  // Index
  buildNoteIndex: (vaultPath: string) => invoke<NoteMetadata[]>('build_note_index', { vaultPath }),
  getBacklinks: (vaultPath: string, relativePath: string) => invoke<string[]>('get_backlinks', { vaultPath, relativePath }),
  searchNotes: (vaultPath: string, query: string) => invoke<SearchResult[]>('search_notes', { vaultPath, query }),

  // Watcher
  watchVault: (vaultPath: string) => invoke<void>('watch_vault', { vaultPath }),
  unwatchVault: () => invoke<void>('unwatch_vault'),

  // UI
  setUiZoom: (zoom: number) => invoke<void>('set_ui_zoom', { zoom }),
  isAppImage: () => invoke<boolean>('is_appimage'),
  isFlatpak: () => invoke<boolean>('is_flatpak'),
  shouldDisableBlur: () => invoke<boolean>('should_disable_blur'),

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
  updateVaultConfig: (vaultPath: string, requestingUserId: string, config: VaultConfig) =>
    invoke<void>('update_vault_config', { vaultPath, requestingUserId, config }),
  registerKnownUser: (vaultPath: string, userId: string, userName: string, userColor: string) =>
    invoke<VaultConfig>('register_known_user', { vaultPath, userId, userName, userColor }),
  claimVaultOwnership: (vaultPath: string, userId: string, userName: string) =>
    invoke<VaultConfig>('claim_vault_ownership', { vaultPath, userId, userName }),

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
  restoreSnapshot: (
    vaultPath: string,
    relativePath: string,
    snapshotId: string,
    restoringUserId: string,
    restoringUserName: string,
  ) => invoke<WriteResult>('restore_snapshot', { vaultPath, relativePath, snapshotId, restoringUserId, restoringUserName }),

  // Collab — permissions
  inviteMember: (vaultPath: string, requestingUserId: string, userId: string, role: MemberRole) =>
    invoke<VaultConfig>('invite_member', { vaultPath, requestingUserId, userId, role }),
  updateMemberRole: (vaultPath: string, requestingUserId: string, userId: string, role: MemberRole) =>
    invoke<VaultConfig>('update_member_role', { vaultPath, requestingUserId, userId, role }),
  removeMember: (vaultPath: string, requestingUserId: string, userId: string) =>
    invoke<VaultConfig>('remove_member', { vaultPath, requestingUserId, userId }),
};
