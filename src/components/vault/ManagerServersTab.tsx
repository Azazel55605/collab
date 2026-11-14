import { useEffect, useMemo, useState } from 'react';

import { Plus } from 'lucide-react';

import { type KnownServer, listKnownServers } from '../../lib/hostedServers';
import { listHostedVaultReplicas, type ReplicaSummary } from '../../lib/vaultReplica';
import { useServerStore } from '../../store/serverStore';
import { useVaultStore } from '../../store/vaultStore';
import { HostedLoginForm } from '../server/HostedLoginForm';
import { ReauthenticateServerDialog } from '../server/ReauthenticateServerDialog';
import { Button } from '../ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '../ui/dialog';

import { ServerDetailsDialog } from './launcher/ServerDetailsDialog';
import { ServerStatusDot } from './launcher/ServerStatus';
import {
  buildServerEntries,
  buildVaultEntries,
  type ServerEntry,
  serverStatusLabel,
} from './launcher/vaultEntries';

/** Every server this device knows: status, account, vault count, details and sign-in. */
export function ManagerServersTab({ onNewVault }: { onNewVault: () => void }) {
  const connections = useServerStore((state) => state.connections);
  const recentVaults = useVaultStore((state) => state.recentVaults);
  const [replicas, setReplicas] = useState<ReplicaSummary[]>([]);
  const [detailsUrl, setDetailsUrl] = useState<string | null>(null);
  const [reauth, setReauth] = useState<KnownServer | null>(null);
  const [connecting, setConnecting] = useState(false);

  useEffect(() => {
    let cancelled = false;
    listHostedVaultReplicas()
      .then((list) => !cancelled && setReplicas(list))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const servers = useMemo(() => {
    const entries = buildVaultEntries({
      recentVaults,
      connections,
      replicas,
      hostedLastOpened: {},
    });
    return buildServerEntries({ connections, knownServers: listKnownServers(), entries });
  }, [connections, recentVaults, replicas]);
  const details = servers.find((server) => server.serverUrl === detailsUrl) ?? null;
  const signIn = (server: ServerEntry) => {
    if (server.known) setReauth(server.known);
  };

  return (
    <div className="flex h-full flex-col gap-4">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <h3 className="text-base font-semibold">Servers</h3>
          <p className="text-xs text-muted-foreground">
            Collab servers this device can reach, for hosted vaults, chats and databases.
          </p>
        </div>
        <Button size="sm" onClick={() => setConnecting(true)}>
          <Plus /> Connect server
        </Button>
      </div>

      {servers.length === 0 ? (
        <p className="rounded-xl border border-dashed border-border/70 px-4 py-8 text-center text-sm text-muted-foreground">
          No servers yet. Connect one to use hosted vaults.
        </p>
      ) : (
        <ul className="flex flex-col overflow-hidden rounded-xl border border-border/60 bg-card/30 p-1">
          {servers.map((server) => (
            <li
              key={server.serverUrl}
              className="flex items-center gap-3 rounded-lg px-3 py-2.5 transition-colors hover:bg-muted/50"
            >
              <ServerStatusDot state={server.state} />
              <div className="min-w-0 flex-1 leading-tight">
                <p className="truncate text-sm font-medium">{server.host}</p>
                <p className="truncate text-xs text-muted-foreground">
                  {serverStatusLabel(server)}
                  {server.account ? ` · ${server.account}` : ''}
                  {` · ${server.vaultCount} vault${server.vaultCount === 1 ? '' : 's'}`}
                  {server.offlineCount > 0 ? ` · ${server.offlineCount} offline` : ''}
                </p>
              </div>
              {server.state === 'signed-out' && server.known && (
                <Button size="sm" variant="outline" onClick={() => signIn(server)}>
                  Sign in
                </Button>
              )}
              <Button size="sm" variant="ghost" onClick={() => setDetailsUrl(server.serverUrl)}>
                Details
              </Button>
            </li>
          ))}
        </ul>
      )}

      <ServerDetailsDialog
        server={details}
        onOpenChange={(open) => !open && setDetailsUrl(null)}
        onSignIn={(server) => {
          setDetailsUrl(null);
          signIn(server);
        }}
        onNewVault={() => {
          setDetailsUrl(null);
          onNewVault();
        }}
      />
      <ReauthenticateServerDialog
        server={reauth}
        onOpenChange={(open) => {
          if (!open) setReauth(null);
        }}
      />
      <Dialog open={connecting} onOpenChange={setConnecting}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Connect a Collab server</DialogTitle>
            <DialogDescription>
              Sign in to open hosted vaults, chats and databases.
            </DialogDescription>
          </DialogHeader>
          <HostedLoginForm onConnected={() => setConnecting(false)} />
        </DialogContent>
      </Dialog>
    </div>
  );
}
