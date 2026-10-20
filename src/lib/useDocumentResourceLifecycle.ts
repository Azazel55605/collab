import { useLayoutEffect } from 'react';

import { useServerStore } from '../store/serverStore';
import { useVaultStore } from '../store/vaultStore';

import { documentVaultIdentity } from './documentPaneContext';
import { documentSessionRetention } from './documentSessionRetention';
import { clearDocumentReads } from './sharedDocumentResources';

/** Plaintext/session resources belong to one authorized vault lifetime. */
export function useDocumentResourceLifecycle() {
  useLayoutEffect(() => {
    let previous: string | null | undefined;
    const update = () => {
      const { vault, isVaultLocked } = useVaultStore.getState();
      let scope: string | null = !vault || isVaultLocked ? null : documentVaultIdentity(vault);
      if (vault?.kind === 'hosted') {
        const server = useServerStore.getState().connectionFor(vault.serverUrl);
        const membership = server?.hostedVaults.find((entry) => entry.id === vault.hostedVaultId);
        scope =
          scope &&
          server?.status.connected &&
          server.status.user?.status === 'active' &&
          membership?.status === 'active'
            ? JSON.stringify([scope, server.status.user.id, vault.role, vault.capabilities])
            : null;
      }
      if (scope === previous) return;
      previous = scope;
      documentSessionRetention.clear();
      clearDocumentReads();
    };
    update();
    const offVault = useVaultStore.subscribe(update);
    const offServer = useServerStore.subscribe(update);
    return () => {
      offVault();
      offServer();
      documentSessionRetention.clear();
      clearDocumentReads();
    };
  }, []);
}
