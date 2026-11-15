import { useEffect, useState } from 'react';

import { toast } from 'sonner';

import { type KnownServer, knownServerFor } from '../../../lib/hostedServers';
import { isServerSessionExpired, useServerStore } from '../../../store/serverStore';
import { useVaultStore } from '../../../store/vaultStore';

export type ConnectionState = 'online' | 'expired' | 'offline';

/**
 * Connection health of the open hosted vault's server: online, session expired
 * or offline, with a reconnect that restores the session from the OS-stored
 * refresh token and falls back to signing in again.
 */
export function useServerConnection() {
  const vault = useVaultStore((state) => state.vault);
  const serverUrl = vault?.kind === 'hosted' ? vault.serverUrl : null;
  const status = useServerStore((state) =>
    serverUrl ? (state.connections[serverUrl]?.status ?? null) : null,
  );
  const reconnectInStore = useServerStore((state) => state.reconnect);
  const [reconnecting, setReconnecting] = useState(false);
  const [signInServer, setSignInServer] = useState<KnownServer | null>(null);
  // Time-based expiry does not emit a store change; re-evaluate periodically.
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!serverUrl) return;
    const interval = setInterval(() => setTick((value) => value + 1), 15000);
    return () => clearInterval(interval);
  }, [serverUrl]);

  let state: ConnectionState = 'offline';
  if (status?.connected === true) state = isServerSessionExpired(status) ? 'expired' : 'online';

  const reconnect = async () => {
    if (!serverUrl) return;
    setReconnecting(true);
    try {
      const allowInvalidCertificates =
        (status?.connected === true ? status.allowInvalidCertificates : undefined) ??
        knownServerFor(serverUrl)?.allowInvalidCertificates ??
        false;
      await reconnectInStore(serverUrl, allowInvalidCertificates);
      toast.success('Server session restored');
    } catch (reason) {
      const known = knownServerFor(serverUrl);
      if (known) {
        setSignInServer(known);
        toast.error(
          'The saved session could not be restored. Enter your password to sign in again.',
        );
      } else {
        toast.error(`Reconnect failed: ${reason}`);
      }
    } finally {
      setReconnecting(false);
    }
  };

  return {
    serverUrl,
    host: serverUrl ? new URL(serverUrl).host : null,
    state: serverUrl ? state : null,
    account:
      status?.connected === true
        ? status.user?.displayName || status.user?.username || null
        : (knownServerFor(serverUrl ?? '')?.username ?? null),
    reconnecting,
    reconnect,
    signInServer,
    setSignInServer,
  };
}

export type ServerConnectionModel = ReturnType<typeof useServerConnection>;
