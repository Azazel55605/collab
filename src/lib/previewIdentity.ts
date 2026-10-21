import { useServerStore } from '../store/serverStore';
import { useVaultStore } from '../store/vaultStore';

import type { VaultClient } from './vaultClient';
import { vaultTreeIndex } from './vaultTreeIndex';

export function previewIdentity(client: VaultClient, path: string, variant: string) {
  const vault = client.vault;
  if (!vault) return JSON.stringify([client.id, path, variant]);
  const account =
    vault.kind === 'hosted'
      ? useServerStore.getState().statusFor(vault.serverUrl)?.user?.id
      : 'local';
  const state = useVaultStore.getState();
  const entry =
    state.vault?.id === vault.id ? vaultTreeIndex(state.fileTree).byPath.get(path) : undefined;
  return JSON.stringify([
    client.id,
    account,
    path,
    entry?.contentRevision,
    entry?.modifiedAt,
    entry?.size,
    variant,
  ]);
}
