import type { HostedVaultMeta } from '../types/vault';

import { listenSafely } from './nativeSubscription';
import { emitReplicaMutated } from './vaultReplica';

interface NativeVaultSynced {
  serverUrl: string;
  vaultId: string;
  changed: number;
}

/** Publish autonomous native downloads to the open vault's existing safe refresh policy. */
export function subscribeToNativeReplicaSync(vault: HostedVaultMeta): () => void {
  return listenSafely<NativeVaultSynced>('background:vault-synced', ({ payload }) => {
    if (
      payload.changed <= 0 ||
      payload.serverUrl !== vault.serverUrl ||
      payload.vaultId !== vault.hostedVaultId
    )
      return;
    emitReplicaMutated({ kind: 'manifest' });
  });
}
