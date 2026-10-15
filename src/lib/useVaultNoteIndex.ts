import { useEffect, useRef } from 'react';

import { useNoteIndexStore } from '../store/noteIndexStore';
import type { VaultMeta } from '../types/vault';

import { subscribeToNativeReplicaSync } from './nativeReplicaSync';
import { listenSafely } from './nativeSubscription';
import { createVaultClient } from './vaultClient';
import { onReplicaMutated } from './vaultReplica';

/** One index job per mounted vault scope; obsolete results never reach the store. */
export function useVaultNoteIndex(
  vault: VaultMeta | null,
  locked: boolean,
  refreshFiles: () => Promise<void>,
) {
  const inputs = useRef({ vault, refreshFiles });
  inputs.current = { vault, refreshFiles };
  const scope =
    vault?.kind === 'hosted' ? JSON.stringify([vault.serverUrl, vault.hostedVaultId]) : vault?.path;
  useEffect(() => {
    const { vault, refreshFiles } = inputs.current;
    const { setNotes, setIndexing } = useNoteIndexStore.getState();
    setNotes([]);
    setIndexing(false);
    if (!vault || locked) return;
    let disposed = false;
    let requested = 0;
    let running = false;
    let refreshPending = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const client = createVaultClient(vault);
    const request = (refresh = false) => {
      requested++;
      refreshPending ||= refresh;
      if (running) return;
      running = true;
      setIndexing(true);
      void (async () => {
        try {
          while (!disposed) {
            const generation = requested;
            const refresh = refreshPending;
            refreshPending = false;
            try {
              if (refresh) await refreshFiles();
              if (disposed) return;
              const notes = await client.buildNoteIndex();
              if (!disposed && generation === requested) setNotes(notes);
            } catch {
              /* A later event can retry; never publish another scope's notes. */
            }
            if (generation === requested || timer) break;
          }
        } finally {
          running = false;
          if (!disposed) setIndexing(false);
        }
      })();
    };
    const refresh = () => {
      // Invalidate the in-flight read immediately, before the debounce fires.
      requested++;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = undefined;
        request(true);
      }, 150);
    };
    request();
    const unsubscribers = [
      'vault:file-created',
      'vault:file-deleted',
      'vault:file-renamed',
      'vault:file-modified',
    ].map((event) => listenSafely(event, refresh));
    unsubscribers.push(onReplicaMutated(refresh, { kinds: ['manifest', 'replica'] }));
    if (vault.kind === 'hosted') unsubscribers.push(subscribeToNativeReplicaSync(vault));
    return () => {
      disposed = true;
      if (timer) clearTimeout(timer);
      unsubscribers.forEach((off) => off());
    };
  }, [scope, locked]);
}
