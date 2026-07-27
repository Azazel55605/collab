import { useEffect, useMemo, useState } from 'react';
import { KeyRound, Plus } from 'lucide-react';
import { toast } from 'sonner';
import { useServerStore } from '../../store/serverStore';
import { tauriCommands } from '../../lib/tauri';
import { knownServerFor, listKnownServers, type KnownServer } from '../../lib/hostedServers';
import { Button } from '../ui/button';
import { HostedLoginForm } from '../server/HostedLoginForm';
import { ReauthenticateServerDialog } from '../server/ReauthenticateServerDialog';
import { SectionLabel } from './settingsControls';

const ALWAYS_CREATE_OFFLINE_COPY_KEY = 'collab-hosted-always-create-offline-copy';

export default function SettingsServerSection() {
  const connections = useServerStore((state) => state.connections);
  const refreshAll = useServerStore((state) => state.refreshAll);
  const disconnectServer = useServerStore((state) => state.disconnect);
  const [alwaysCreateOfflineCopy, setAlwaysCreateOfflineCopy] = useState(
    () => localStorage.getItem(ALWAYS_CREATE_OFFLINE_COPY_KEY) === 'true',
  );
  // The persist-across-reboots preference only changes behavior on Linux
  // (keyutils vs Secret Service). Surface each server's saved value so it is
  // discoverable without reopening the login form.
  const [isLinux, setIsLinux] = useState(false);
  const [addingServer, setAddingServer] = useState(false);
  const [reauthServer, setReauthServer] = useState<KnownServer | null>(null);

  useEffect(() => {
    refreshAll().catch(() => {});
    void Promise.resolve()
      .then(() => tauriCommands.hostOs?.())
      .then((os) => setIsLinux(os === 'linux'))
      .catch(() => {});
  }, [refreshAll]);

  async function disconnect(serverUrl: string) {
    await disconnectServer(serverUrl);
    toast.success('Disconnected from server');
  }

  function toggleAlwaysCreateOfflineCopy() {
    const next = !alwaysCreateOfflineCopy;
    setAlwaysCreateOfflineCopy(next);
    localStorage.setItem(ALWAYS_CREATE_OFFLINE_COPY_KEY, String(next));
    toast.success(next ? 'Hosted vaults will be cached for offline use when opened.' : 'Automatic offline-copy creation disabled.');
  }

  const servers = useMemo(() => {
    const saved = listKnownServers();
    const savedUrls = new Set(saved.map((server) => server.serverUrl));
    return [
      ...saved.map((server) => ({ server, connection: connections[server.serverUrl] })),
      ...Object.values(connections)
        .filter(({ status }) => status.serverUrl && !savedUrls.has(status.serverUrl))
        .map((connection) => ({
          server: {
            serverUrl: connection.status.serverUrl!,
            username: connection.status.user?.username ?? '',
            allowInvalidCertificates: connection.status.allowInvalidCertificates,
            persistAcrossReboots: false,
          },
          connection,
        })),
    ];
  }, [connections]);

  return (
    <div className="space-y-5">
      <div>
        <SectionLabel>Hosted servers</SectionLabel>
        <p className="text-sm text-muted-foreground">
          Connect this desktop app to one or more Collab servers. The session is kept in memory; the refresh token is written to your operating system credential store only if you enable “stay signed in across reboots”.
        </p>
      </div>

      {servers.map(({ server, connection }) => {
        const status = connection?.status;
        const connected = status?.connected === true;
        const persistAcrossReboots = knownServerFor(server.serverUrl)?.persistAcrossReboots === true;
        return (
          <div key={server.serverUrl} className="space-y-3 rounded-lg border border-border/50 bg-card/40 p-4">
            <div>
              <p className="text-sm font-medium">{status?.user?.displayName ?? server.username}</p>
              <p className="text-xs text-muted-foreground">
                {connected ? status?.user?.username : 'Disconnected'} on {server.serverUrl}
              </p>
            </div>
            {server.allowInvalidCertificates && <p className="text-xs text-destructive">TLS certificate verification is disabled for this connection.</p>}
            {isLinux && (
              <p className="text-xs text-muted-foreground">
                {persistAcrossReboots
                  ? 'Staying signed in across reboots (refresh token stored durably in your system keyring).'
                  : 'Signed in until the next reboot only (no token written to disk). Enable “Keep me signed in across reboots” when signing in to persist it.'}
              </p>
            )}
            <div className="flex flex-wrap gap-2">
              <Button size="sm" variant="outline" className="gap-1.5" onClick={() => setReauthServer(server)}>
                <KeyRound size={14} />
                Sign in again
              </Button>
              <Button size="sm" variant="outline" onClick={() => disconnect(server.serverUrl)}>
                {connected ? 'Disconnect' : 'Remove server'}
              </Button>
            </div>
          </div>
        );
      })}

      {addingServer ? (
        <div className="space-y-2 rounded-lg border border-border/40 bg-card/30 p-3">
          <HostedLoginForm onConnected={() => setAddingServer(false)} />
          <Button size="sm" variant="ghost" onClick={() => setAddingServer(false)}>Cancel</Button>
        </div>
      ) : (
        <Button size="sm" variant="outline" className="gap-1" onClick={() => setAddingServer(true)}>
          <Plus size={14} />
          {servers.length === 0 ? 'Connect a server' : 'Add another server'}
        </Button>
      )}

      <div className="space-y-2 rounded-lg border border-border/50 bg-card/40 p-4">
        <SectionLabel>Offline copies</SectionLabel>
        <Button size="sm" variant={alwaysCreateOfflineCopy ? 'default' : 'outline'} onClick={toggleAlwaysCreateOfflineCopy}>
          {alwaysCreateOfflineCopy ? 'Always create offline copy: On' : 'Always create offline copy'}
        </Button>
        <p className="text-xs text-muted-foreground">
          When enabled, opening any hosted vault downloads its active documents and assets into the local replica automatically.
        </p>
      </div>
      <ReauthenticateServerDialog
        server={reauthServer}
        onOpenChange={(open) => { if (!open) setReauthServer(null); }}
      />
    </div>
  );
}
