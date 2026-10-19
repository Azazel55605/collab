import { useEffect } from 'react';

import { useServerStore } from '../store/serverStore';
import { useVaultStore } from '../store/vaultStore';

import { setOcrCacheContext } from './ocrCache';

/** Keep disposable recognized text inside the current authorized vault lifetime. */
export function useOcrCacheLifecycle() {
  useEffect(() => {
    const update = () => {
      const { vault, isVaultLocked } = useVaultStore.getState();
      if (!vault || isVaultLocked) {
        setOcrCacheContext(null);
        return;
      }
      if (vault.kind !== 'hosted') {
        setOcrCacheContext(JSON.stringify(['local', vault.path]));
        return;
      }
      const server = useServerStore.getState().connectionFor(vault.serverUrl);
      const connection = server?.status;
      const membership = server?.hostedVaults.find((entry) => entry.id === vault.hostedVaultId);
      setOcrCacheContext(
        connection?.connected &&
          connection.user?.status === 'active' &&
          membership?.status === 'active'
          ? JSON.stringify([
              vault.serverUrl,
              connection.user.id,
              vault.hostedVaultId,
              vault.role,
              vault.capabilities,
            ])
          : null,
      );
    };
    update();
    const offVault = useVaultStore.subscribe(update);
    const offServer = useServerStore.subscribe(update);
    return () => {
      offVault();
      offServer();
      setOcrCacheContext(null);
    };
  }, []);
}
