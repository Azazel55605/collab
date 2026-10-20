import { useEffect, useRef } from 'react';

import { useNoteIndexStore } from '../store/noteIndexStore';
import type { VaultMeta } from '../types/vault';

import { subscribeToNativeReplicaSync } from './nativeReplicaSync';
import { listenSafely } from './nativeSubscription';
import { createVaultClient } from './vaultClient';
import { onReplicaMutated } from './vaultReplica';
import { coalescePaths } from './vaultTreeIndex';

/** Single flight plus a replaceable trailing batch. Pending paths are retained
 * until publication, including when an event invalidates an in-flight delta. */
export function useVaultNoteIndex(
  vault: VaultMeta | null,
  locked: boolean,
  refreshFiles: (paths?: string[]) => Promise<void>,
) {
  const inputs = useRef({ vault, refreshFiles });
  inputs.current = { vault, refreshFiles };
  const scope =
    vault?.kind === 'hosted' ? JSON.stringify([vault.serverUrl, vault.hostedVaultId]) : vault?.path;
  useEffect(() => {
    const { vault, refreshFiles } = inputs.current;
    const { setNotes, setIndexing, applyDelta } = useNoteIndexStore.getState();
    setNotes([]);
    setIndexing(false);
    if (!vault || locked) return;
    let disposed = false,
      requested = 0,
      running = false,
      initialized = false;
    let full = true,
      refreshPending = false;
    const pending = new Set<string>();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const client = createVaultClient(vault);
    const request = () => {
      if (running || disposed) return;
      running = true;
      setIndexing(true);
      void (async () => {
        try {
          while (!disposed) {
            const generation = requested;
            const paths = coalescePaths(pending);
            const rebuild = full || !initialized || !client.updateNoteIndex;
            try {
              if (refreshPending) await refreshFiles(full ? undefined : paths);
              if (disposed) return;
              if (rebuild) {
                const notes = await client.buildNoteIndex(refreshPending);
                if (!disposed && generation === requested) {
                  setNotes(notes);
                  initialized = true;
                }
              } else {
                const delta = await client.updateNoteIndex!(paths);
                if (!disposed && generation === requested) applyDelta(delta);
              }
              if (generation === requested) {
                full = false;
                refreshPending = false;
                pending.clear();
              }
            } catch {
              // An unknown gap requires reconciliation on the next event.
              full = true;
            }
            if (generation === requested || timer) break;
          }
        } finally {
          running = false;
          if (!disposed) setIndexing(false);
        }
      })();
    };
    const refresh = (paths?: string[]) => {
      requested++;
      refreshPending = true;
      if (!paths?.length || paths.includes('')) full = true;
      else paths.forEach((path) => pending.add(path));
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = undefined;
        request();
      }, 150);
    };
    const unsubscribers = [
      'vault:file-created',
      'vault:file-deleted',
      'vault:file-renamed',
      'vault:file-modified',
    ].map((name) =>
      listenSafely<{ path?: string; oldPath?: string; newPath?: string; vaultPath?: string }>(
        name,
        (event) => {
          const payload = event?.payload;
          if (payload?.vaultPath && payload.vaultPath !== vault.path) return;
          refresh(
            payload
              ? [payload.path, payload.oldPath, payload.newPath].filter(
                  (p): p is string => p !== undefined,
                )
              : undefined,
          );
        },
      ),
    );
    unsubscribers.push(
      onReplicaMutated(
        () => {
          if (vault.kind !== 'hosted') return;
          refresh(); // manifest-derived hosted metadata already uses the replica delta
        },
        { kinds: ['manifest', 'replica'] },
      ),
    );
    let nativeGeneration = -1;
    unsubscribers.push(
      listenSafely<{ vaultPath: string; generation: number; processed: number }>(
        'vault:index-progress',
        (event) => {
          if (event.payload.vaultPath !== vault.path || event.payload.generation < nativeGeneration)
            return;
          nativeGeneration = event.payload.generation;
          useNoteIndexStore.setState({ indexedCount: event.payload.processed });
        },
      ),
    );
    if (vault.kind === 'hosted') unsubscribers.push(subscribeToNativeReplicaSync(vault));
    request();
    return () => {
      disposed = true;
      if (timer) clearTimeout(timer);
      unsubscribers.forEach((off) => off());
    };
  }, [scope, locked]);
}
