import { useState } from 'react';

import { KeyRound, LogOut, Plus, RefreshCw } from 'lucide-react';
import { toast } from 'sonner';

import { useServerStore } from '../../../store/serverStore';
import { Button } from '../../ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '../../ui/dialog';

import { ServerStatusDot } from './ServerStatus';
import { type ServerEntry, serverStatusLabel } from './vaultEntries';

interface ServerDetailsDialogProps {
  server: ServerEntry | null;
  onOpenChange: (open: boolean) => void;
  onSignIn: (server: ServerEntry) => void;
  onNewVault: (server: ServerEntry) => void;
}

/** Per-server actions that used to sit on every server header of the start screen. */
export function ServerDetailsDialog({
  server,
  onOpenChange,
  onSignIn,
  onNewVault,
}: ServerDetailsDialogProps) {
  const loadHostedVaults = useServerStore((state) => state.loadHostedVaults);
  const disconnect = useServerStore((state) => state.disconnect);
  const isServerLoading = useServerStore((state) => state.isLoading);
  const [busy, setBusy] = useState(false);

  const refresh = async (target: ServerEntry) => {
    try {
      await loadHostedVaults(target.serverUrl);
    } catch (reason) {
      toast.error(String(reason));
    }
  };

  const logOut = async (target: ServerEntry) => {
    setBusy(true);
    try {
      await disconnect(target.serverUrl);
      toast.success('Disconnected from server');
      onOpenChange(false);
    } catch (reason) {
      toast.error(`Failed to disconnect: ${reason}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={server !== null} onOpenChange={onOpenChange}>
      {server && (
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <ServerStatusDot state={server.state} />
              {server.host}
            </DialogTitle>
            <DialogDescription className="font-mono text-xs break-all">
              {server.serverUrl}
            </DialogDescription>
          </DialogHeader>

          <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-1.5 text-sm">
            <dt className="text-muted-foreground">Status</dt>
            <dd>{serverStatusLabel(server)}</dd>
            {server.account && (
              <>
                <dt className="text-muted-foreground">
                  {server.state === 'connected' ? 'Signed in as' : 'Account'}
                </dt>
                <dd className="truncate">{server.account}</dd>
              </>
            )}
            <dt className="text-muted-foreground">Vaults</dt>
            <dd>
              {server.vaultCount} hosted
              {server.offlineCount > 0 && ` · ${server.offlineCount} offline`}
            </dd>
          </dl>

          {server.state === 'offline-only' && (
            <p className="text-xs text-muted-foreground">
              This server isn't saved on this device. Its offline copies stay available; remove them
              from a vault's menu.
            </p>
          )}

          <div className="flex flex-wrap justify-end gap-2">
            {server.state === 'connected' && (
              <>
                <Button variant="outline" onClick={() => logOut(server)} disabled={busy}>
                  <LogOut />
                  Log out
                </Button>
                <Button
                  variant="outline"
                  onClick={() => refresh(server)}
                  disabled={isServerLoading}
                >
                  <RefreshCw className={isServerLoading ? 'animate-spin' : undefined} />
                  Refresh vaults
                </Button>
                {server.canCreate && (
                  <Button onClick={() => onNewVault(server)}>
                    <Plus />
                    New hosted vault
                  </Button>
                )}
              </>
            )}
            {!server.canCreate && server.state !== 'offline-only' && server.known && (
              <Button onClick={() => onSignIn(server)}>
                <KeyRound />
                Sign in
              </Button>
            )}
          </div>
        </DialogContent>
      )}
    </Dialog>
  );
}
