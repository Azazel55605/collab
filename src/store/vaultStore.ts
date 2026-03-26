import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { tauriCommands } from '../lib/tauri';
import type { VaultMeta, NoteFile } from '../types/vault';

interface VaultState {
  vault: VaultMeta | null;
  fileTree: NoteFile[];
  recentVaults: VaultMeta[];
  isLoading: boolean;
  openVault: (path: string) => Promise<void>;
  refreshFileTree: () => Promise<void>;
  closeVault: () => void;
  loadRecentVaults: () => Promise<void>;
}

export const useVaultStore = create<VaultState>()(
  persist(
    (set, get) => ({
      vault: null,
      fileTree: [],
      recentVaults: [],
      isLoading: false,
      openVault: async (path) => {
        set({ isLoading: true });
        try {
          const vault = await tauriCommands.openVault(path);
          const fileTree = await tauriCommands.listVaultFiles(path);
          await tauriCommands.watchVault(path);
          set({ vault, fileTree, isLoading: false });
        } catch (e) {
          set({ isLoading: false });
          throw e;
        }
      },
      refreshFileTree: async () => {
        const { vault } = get();
        if (!vault) return;
        const fileTree = await tauriCommands.listVaultFiles(vault.path);
        set({ fileTree });
      },
      closeVault: () => {
        tauriCommands.unwatchVault().catch(() => {});
        set({ vault: null, fileTree: [] });
      },
      loadRecentVaults: async () => {
        const recentVaults = await tauriCommands.getRecentVaults();
        set({ recentVaults });
      },
    }),
    {
      name: 'vault-storage',
      partialize: (state) => ({ recentVaults: state.recentVaults }),
    }
  )
);
