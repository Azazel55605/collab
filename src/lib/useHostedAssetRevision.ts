import { useEffect, useRef, useState } from 'react';

import type { VaultMeta } from '../types/vault';

import {
  onReplicaMutated,
  readCachedReplicaManifest,
  replicaMutationAffectsPath,
} from './vaultReplica';

/** Reload source bytes only after their revision changes and local overlays are safe. */
export function useHostedAssetRevision(
  vault: VaultMeta | null,
  path: string | null,
  canReload: boolean,
) {
  const serverUrl = vault?.kind === 'hosted' ? vault.serverUrl : null;
  const vaultId = vault?.kind === 'hosted' ? vault.hostedVaultId : null;
  const [revision, setRevision] = useState(0);
  const previousAllowed = useRef(canReload);
  const allowed = useRef(canReload);
  allowed.current = canReload;
  const checkRef = useRef<(() => void) | null>(null);
  useEffect(() => {
    if (!serverUrl || !vaultId || !path) return;
    let disposed = false;
    let generation = 0;
    let hash: unknown;
    let initialized = false;
    const check = (initial = false) => {
      const request = ++generation;
      void readCachedReplicaManifest({ serverUrl, hostedVaultId: vaultId })
        .then((manifest) => {
          if (disposed || request !== generation) return;
          const next = manifest?.files.find((file) => file.relativePath === path)?.currentRevision;
          const nextHash =
            next && typeof next === 'object'
              ? (next as { contentHash?: unknown }).contentHash
              : undefined;
          if (!nextHash) return;
          if (!initialized && initial) {
            hash = nextHash;
            initialized = true;
            return;
          }
          if (!allowed.current || hash === nextHash) return;
          hash = nextHash;
          initialized = true;
          setRevision((value) => value + 1);
        })
        .catch(() => {});
    };
    checkRef.current = check;
    check(true);
    const off = onReplicaMutated(
      (event) => {
        if (replicaMutationAffectsPath(event, path)) check();
      },
      { kinds: ['manifest'] },
    );
    return () => {
      disposed = true;
      checkRef.current = null;
      off();
    };
  }, [serverUrl, vaultId, path]);
  useEffect(() => {
    if (canReload && !previousAllowed.current) checkRef.current?.();
    previousAllowed.current = canReload;
  }, [canReload]);
  return revision;
}
