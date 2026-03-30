import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { tauriCommands } from '../lib/tauri';
import type { VaultMeta, NoteFile } from '../types/vault';

interface VaultState {
  vault: VaultMeta | null;
  isVaultLocked: boolean;
  fileTree: NoteFile[];
  recentVaults: VaultMeta[];
  isLoading: boolean;
  openVault: (path: string) => Promise<void>;
  unlockVault: (password: string) => Promise<void>;
  refreshFileTree: () => Promise<void>;
  closeVault: () => void;
  loadRecentVaults: () => Promise<void>;
  removeRecentVault: (path: string) => Promise<void>;
}

export const useVaultStore = create<VaultState>()(
  persist(
    (set, get) => ({
      vault: null,
      isVaultLocked: false,
      fileTree: [],
      recentVaults: [],
      isLoading: false,
      openVault: async (path) => {
        set({ isLoading: true });
        try {
          const vault = await tauriCommands.openVault(path);
          if (vault.isEncrypted) {
            // Don't load the file tree yet — wait for the password to be entered.
            set({ vault, isVaultLocked: true, fileTree: [], isLoading: false });
          } else {
            const fileTree = await tauriCommands.listVaultFiles(path);
            await tauriCommands.watchVault(path);
            set({ vault, isVaultLocked: false, fileTree, isLoading: false });
          }
        } catch (e) {
          set({ isLoading: false });
          throw e;
        }
      },
      unlockVault: async (password) => {
        const { vault } = get();
        if (!vault) return;
        await tauriCommands.unlockVault(vault.path, password);
        const fileTree = await tauriCommands.listVaultFiles(vault.path);
        await tauriCommands.watchVault(vault.path);
        set({ isVaultLocked: false, fileTree });
      },
      refreshFileTree: async () => {
        const { vault } = get();
        if (!vault) return;
        const fileTree = await tauriCommands.listVaultFiles(vault.path);
        set({ fileTree });
      },
      closeVault: () => {
        tauriCommands.unwatchVault().catch(() => {});
        set({ vault: null, isVaultLocked: false, fileTree: [] });
      },
      loadRecentVaults: async () => {
        const recentVaults = await tauriCommands.getRecentVaults();
        set({ recentVaults });
      },
      removeRecentVault: async (path) => {
        await tauriCommands.removeRecentVault(path);
        set((s) => ({ recentVaults: s.recentVaults.filter((v) => v.path !== path) }));
      },
    }),
    {
      name: 'vault-storage',
      partialize: (state) => ({ recentVaults: state.recentVaults }),
    }
  )
);
