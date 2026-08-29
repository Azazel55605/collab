import { create } from 'zustand';
import { persist } from 'zustand/middleware';

import { reconcileFileTreeIdentity } from '../lib/fileTreeIdentity';
import { tauriCommands } from '../lib/tauri';
import { createVaultClient, requireRuntimeCapability } from '../lib/vaultClient';
import {
  cleanupReplicaCache,
  makeHostedVaultAvailableOffline,
  seedReplicaFromManifest,
} from '../lib/vaultReplica';
import {
  hostedVaultMeta,
  type HostedVaultMeta,
  type HostedVaultSummary,
  type NoteFile,
  vaultCan,
  type VaultMeta,
} from '../types/vault';

const ALWAYS_CREATE_OFFLINE_COPY_KEY = 'collab-hosted-always-create-offline-copy';

interface VaultState {
  vault: VaultMeta | null;
  isVaultLocked: boolean;
  fileTree: NoteFile[];
  recentVaults: VaultMeta[];
  lastOpenedVaultPath: string | null;
  isLoading: boolean;
  openVault: (path: string) => Promise<void>;
  openHostedVault: (vault: HostedVaultMeta) => Promise<void>;
  unlockVault: (password: string) => Promise<void>;
  refreshFileTree: () => Promise<void>;
  refreshHostedVaultMetadata: (serverUrl: string, summaries: HostedVaultSummary[]) => void;
  closeVault: () => void;
  loadRecentVaults: () => Promise<void>;
  removeRecentVault: (path: string) => Promise<void>;
}

function compareNoteFilesAlphabetically(left: NoteFile, right: NoteFile) {
  if (left.isFolder !== right.isFolder) return left.isFolder ? -1 : 1;
  const nameOrder = left.name.localeCompare(right.name, undefined, {
    sensitivity: 'base',
    numeric: true,
  });
  if (nameOrder !== 0) return nameOrder;
  return left.relativePath.localeCompare(right.relativePath, undefined, {
    sensitivity: 'base',
    numeric: true,
  });
}

function sameStringArray(left?: string[], right?: string[]) {
  const leftValues = left ?? [];
  const rightValues = right ?? [];
  if (leftValues.length !== rightValues.length) return false;
  return leftValues.every((value, index) => value === rightValues[index]);
}

export function sortFileTreeAlphabetically(nodes: NoteFile[]): NoteFile[] {
  return [...nodes]
    .map((node) => ({
      ...node,
      children: node.children ? sortFileTreeAlphabetically(node.children) : node.children,
    }))
    .sort(compareNoteFilesAlphabetically);
}

function isLikelyFlatpakVaultAccessError(error: unknown) {
  const message = String(error ?? '').toLowerCase();
  return (
    message.includes('cannot open vault path') &&
    (message.includes('no such file or directory') || message.includes('os error 2'))
  );
}

export const useVaultStore = create<VaultState>()(
  persist(
    (set, get) => ({
      vault: null,
      isVaultLocked: false,
      fileTree: [],
      recentVaults: [],
      lastOpenedVaultPath: null,
      isLoading: false,
      openVault: async (path) => {
        const attemptOpenVault = async (vaultPath: string) => {
          const previousVault = get().vault;
          if (previousVault) {
            await createVaultClient(previousVault)
              .runtime.watch?.stop()
              .catch(() => {});
          }
          const vault = await tauriCommands.openVault(vaultPath);
          const client = createVaultClient(vault);
          if (vault.isEncrypted) {
            // Don't load the file tree yet — wait for the password to be entered.
            set({
              vault,
              isVaultLocked: true,
              fileTree: [],
              isLoading: false,
              lastOpenedVaultPath: vaultPath,
            });
            return;
          }

          const fileTree = sortFileTreeAlphabetically(await client.listFiles());
          await client.runtime.watch?.start();
          set({
            vault,
            isVaultLocked: false,
            fileTree,
            isLoading: false,
            lastOpenedVaultPath: vaultPath,
          });
        };

        set({ isLoading: true });
        try {
          await attemptOpenVault(path);
        } catch (e) {
          if (
            (await tauriCommands.isFlatpak().catch(() => false)) &&
            isLikelyFlatpakVaultAccessError(e)
          ) {
            const reauthorizedPath = await tauriCommands.showOpenVaultDialog().catch(() => null);
            if (!reauthorizedPath) {
              set({ isLoading: false });
              return;
            }
            await attemptOpenVault(reauthorizedPath);
            return;
          }

          set({ isLoading: false });
          throw e;
        }
      },
      openHostedVault: async (vault) => {
        set({ isLoading: true });
        try {
          const previousVault = get().vault;
          if (previousVault) {
            await createVaultClient(previousVault)
              .runtime.watch?.stop()
              .catch(() => {});
          }
          const fileTree = sortFileTreeAlphabetically(await createVaultClient(vault).listFiles());
          const shouldCreateOfflineCopy =
            vaultCan(vault, 'vault.offlineCopy') &&
            (vault.requireOfflineCopy === true ||
              localStorage.getItem(ALWAYS_CREATE_OFFLINE_COPY_KEY) === 'true');
          const prepareOfflineCopy = shouldCreateOfflineCopy
            ? makeHostedVaultAvailableOffline(vault)
            : seedReplicaFromManifest(vault).then(() => cleanupReplicaCache(vault));
          prepareOfflineCopy.catch((error) => {
            console.warn(
              shouldCreateOfflineCopy
                ? 'Failed to prepare hosted-vault offline copy:'
                : 'Failed to seed hosted-vault replica:',
              error,
            );
          });
          set({
            vault,
            isVaultLocked: false,
            fileTree,
            isLoading: false,
            // Hosted vault reopening requires a restored server session and is
            // handled by the hosted picker rather than the local path restore.
            lastOpenedVaultPath: null,
          });
        } catch (error) {
          set({ isLoading: false });
          throw error;
        }
      },
      unlockVault: async (password) => {
        const { vault } = get();
        if (!vault) return;
        const client = createVaultClient(vault);
        await requireRuntimeCapability(client, 'encryption').unlock(password);
        const fileTree = sortFileTreeAlphabetically(await client.listFiles());
        await client.runtime.watch?.start();
        set({ isVaultLocked: false, fileTree });
      },
      refreshFileTree: async () => {
        const { vault, fileTree: previous } = get();
        if (!vault) return;
        const listed = sortFileTreeAlphabetically(await createVaultClient(vault).listFiles());
        // Unchanged nodes keep their identity so the sidebar's memoized rows can
        // skip re-rendering; the watcher fires this after every file write.
        set({ fileTree: reconcileFileTreeIdentity(previous, listed) });
      },
      refreshHostedVaultMetadata: (serverUrl, summaries) => {
        const vault = get().vault;
        if (!vault || vault.kind !== 'hosted' || vault.serverUrl !== serverUrl) return;
        const summary = summaries.find((candidate) => candidate.id === vault.hostedVaultId);
        if (!summary) return;
        const next = hostedVaultMeta(serverUrl, summary);
        if (
          vault.name === next.name &&
          vault.role === next.role &&
          vault.requireOfflineCopy === next.requireOfflineCopy &&
          sameStringArray(vault.capabilities, next.capabilities)
        ) {
          return;
        }
        set({
          vault: {
            ...vault,
            name: next.name,
            role: next.role,
            capabilities: next.capabilities,
            requireOfflineCopy: next.requireOfflineCopy,
          },
        });
      },
      closeVault: () => {
        const vault = get().vault;
        if (vault)
          createVaultClient(vault)
            .runtime.watch?.stop()
            .catch(() => {});
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
      partialize: (state) => ({
        recentVaults: state.recentVaults,
        lastOpenedVaultPath: state.lastOpenedVaultPath,
      }),
    },
  ),
);
