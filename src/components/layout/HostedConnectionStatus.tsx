import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Cloud, CloudOff, RefreshCw } from 'lucide-react';
import { useVaultStore } from '../../store/vaultStore';
import { useServerStore, isServerSessionExpired } from '../../store/serverStore';
import { knownServerFor } from '../../lib/hostedServers';
import { cn } from '../../lib/utils';
import { ReauthenticateServerDialog } from '../server/ReauthenticateServerDialog';

type ConnectionState = 'online' | 'expired' | 'offline';

/**
 * Live connection-health indicator for the open hosted vault. Hidden for local
 * vaults. Surfaces token expiry and lost server sessions and offers an inline
 * reconnect that restores the session from the OS-stored refresh token.
 */
export default function HostedConnectionStatus() {
  const vault = useVaultStore((state) => state.vault);
  const serverUrl = vault?.kind === 'hosted' ? vault.serverUrl : null;
  const status = useServerStore((state) => (serverUrl ? state.connections[serverUrl]?.status ?? null : null));
  const reconnect = useServerStore((state) => state.reconnect);
  const [busy, setBusy] = useState(false);
  const [showReauthentication, setShowReauthentication] = useState(false);
  // Re-evaluate time-based expiry periodically since it does not emit a store change.
  const [, setTick] = useState(0);

  const isHosted = serverUrl != null;
  useEffect(() => {
    if (!isHosted) return;
    const interval = setInterval(() => setTick((value) => value + 1), 15000);
    return () => clearInterval(interval);
  }, [isHosted]);

  if (!vault || vault.kind !== 'hosted') return null;

  const onExpectedServer = status?.connected === true;
  let state: ConnectionState = 'offline';
  if (onExpectedServer) {
    state = isServerSessionExpired(status) ? 'expired' : 'online';
  }

  const handleReconnect = async () => {
    setBusy(true);
    try {
      const allowInvalidCertificates =
        (status?.connected === true ? status.allowInvalidCertificates : undefined) ??
        knownServerFor(vault.serverUrl)?.allowInvalidCertificates ??
        false;
      await reconnect(vault.serverUrl, allowInvalidCertificates);
      toast.success('Server session restored');
    } catch (reason) {
      if (knownServerFor(vault.serverUrl)) {
        setShowReauthentication(true);
        toast.error('The saved session could not be restored. Enter your password to sign in again.');
      } else {
        toast.error(`Reconnect failed: ${reason}`);
      }
    } finally {
      setBusy(false);
    }
  };

  if (state === 'online') {
    return (
      <span key={state} className="flex items-center gap-1 text-emerald-500/80 app-chip-change" title={`Connected to ${vault.serverUrl}`}>
        <Cloud size={11} />
        <span className="text-[10px]">Online</span>
      </span>
    );
  }

  const label = state === 'expired' ? 'Session expired' : 'Offline';
  const knownServer = knownServerFor(vault.serverUrl) ?? null;
  return (
    <>
      <button
        onClick={handleReconnect}
        disabled={busy}
        title={`${label} — reconnect to ${vault.serverUrl}`}
        className="flex items-center gap-1 text-amber-500/90 hover:text-amber-400 transition-colors app-motion-fast disabled:opacity-60"
      >
        <span key={`${state}:${busy ? 'busy' : 'idle'}`} className="flex items-center gap-1 app-chip-change">
          {busy ? (
            <RefreshCw size={11} className="app-spin-soft" />
          ) : (
            <CloudOff size={11} />
          )}
          <span className="text-[10px]">{busy ? 'Reconnecting…' : label}</span>
          {!busy && <RefreshCw size={9} className={cn('opacity-70')} />}
        </span>
      </button>
      <ReauthenticateServerDialog
        server={showReauthentication ? knownServer : null}
        onOpenChange={setShowReauthentication}
      />
    </>
  );
}
