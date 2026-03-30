import { invoke } from '@tauri-apps/api/core';
import type { VaultMeta, NoteFile, NoteContent, WriteResult, VaultConfig } from '../types/vault';
import type { NoteMetadata, SearchResult } from '../types/note';
import type { PresenceEntry } from '../types/collab';

export const tauriCommands = {
  // Vault
  openVault: (path: string) => invoke<VaultMeta>('open_vault', { path }),
  createVault: (path: string, name: string) => invoke<VaultMeta>('create_vault', { path, name }),
  getRecentVaults: () => invoke<VaultMeta[]>('get_recent_vaults'),
  showOpenVaultDialog: () => invoke<string | null>('show_open_vault_dialog'),

  // Files
  listVaultFiles: (vaultPath: string) => invoke<NoteFile[]>('list_vault_files', { vaultPath }),
  readNote: (vaultPath: string, relativePath: string) => invoke<NoteContent>('read_note', { vaultPath, relativePath }),
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

  // Collab
  writePresence: (vaultPath: string, userId: string, entry: PresenceEntry) =>
    invoke<void>('write_presence', { vaultPath, userId, entry }),
  readAllPresence: (vaultPath: string) => invoke<PresenceEntry[]>('read_all_presence', { vaultPath }),
  clearPresence: (vaultPath: string, userId: string) => invoke<void>('clear_presence', { vaultPath, userId }),
  getVaultConfig: (vaultPath: string) => invoke<VaultConfig>('get_vault_config', { vaultPath }),
  updateVaultConfig: (vaultPath: string, config: VaultConfig) =>
    invoke<void>('update_vault_config', { vaultPath, config }),
};
