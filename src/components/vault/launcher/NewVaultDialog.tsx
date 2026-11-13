import { type FormEvent, type ReactNode, useEffect, useState } from 'react';

import { HardDrive, Loader2, Server } from 'lucide-react';
import { toast } from 'sonner';

import { tauriCommands } from '../../../lib/tauri';
import { cn } from '../../../lib/utils';
import { useServerStore } from '../../../store/serverStore';
import { useVaultStore } from '../../../store/vaultStore';
import { hostedVaultMeta } from '../../../types/vault';
import { Button } from '../../ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../../ui/dialog';
import { Input } from '../../ui/input';
import { Label } from '../../ui/label';

import type { ServerEntry } from './vaultEntries';

/** `'local'` for a folder on this device, otherwise the server URL to create on. */
export type NewVaultLocation = 'local' | string;

interface NewVaultDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  servers: ServerEntry[];
  initialLocation?: NewVaultLocation;
  onSignIn: (server: ServerEntry) => void;
}

export function NewVaultDialog({
  open,
  onOpenChange,
  servers,
  initialLocation = 'local',
  onSignIn,
}: NewVaultDialogProps) {
  const openVault = useVaultStore((state) => state.openVault);
  const openHostedVault = useVaultStore((state) => state.openHostedVault);
  const createHostedVault = useServerStore((state) => state.createHostedVault);
  const [location, setLocation] = useState<NewVaultLocation>(initialLocation);
  const [name, setName] = useState('');
  const [folder, setFolder] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setLocation(initialLocation);
    setName('');
    setFolder(null);
  }, [open, initialLocation]);

  const creatableServers = servers.filter((server) => server.canCreate);
  const signedOutServers = servers.filter((server) => !server.canCreate && server.known !== null);
  const isLocal = location === 'local';
  const canSubmit = !busy && name.trim().length > 0 && (!isLocal || folder !== null);

  const chooseFolder = async () => {
    try {
      const path = await tauriCommands.showOpenVaultDialog();
      if (!path) return;
      setFolder(path);
      if (!name.trim()) setName(path.split(/[\\/]/).filter(Boolean).pop() ?? '');
    } catch (reason) {
      toast.error(`Could not choose a folder: ${reason}`);
    }
  };

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!canSubmit) return;
    const vaultName = name.trim();
    setBusy(true);
    try {
      if (isLocal) {
        // collabStore initialises the identity on first run.
        const userId = localStorage.getItem('collab-user-id') ?? undefined;
        const userName = localStorage.getItem('collab-user-name') ?? undefined;
        await tauriCommands.createVault(folder!, vaultName, userId, userName);
        onOpenChange(false);
        await openVault(folder!);
      } else {
        const created = await createHostedVault(location, vaultName);
        onOpenChange(false);
        await openHostedVault(hostedVaultMeta(location, created));
      }
    } catch (reason) {
      toast.error(`Failed to create vault: ${reason}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(next) => !busy && onOpenChange(next)}>
      <DialogContent className="sm:max-w-md">
        <form onSubmit={submit} className="grid gap-5">
          <DialogHeader>
            <DialogTitle>New vault</DialogTitle>
            <DialogDescription>
              Choose where it lives. You can add people to hosted vaults later.
            </DialogDescription>
          </DialogHeader>

          <fieldset className="grid gap-2">
            <legend className="mb-2 text-[11px] font-semibold tracking-widest text-muted-foreground uppercase">
              Location
            </legend>
            <LocationOption
              selected={isLocal}
              onSelect={() => setLocation('local')}
              icon={<HardDrive size={15} />}
              title="This device"
              description="A folder on disk. Works fully offline."
            />
            {creatableServers.map((server) => (
              <LocationOption
                key={server.serverUrl}
                selected={location === server.serverUrl}
                onSelect={() => setLocation(server.serverUrl)}
                icon={<Server size={15} />}
                title={server.host}
                description="Hosted vault. Shared and synced through the server."
              />
            ))}
            {signedOutServers.map((server) => (
              <div
                key={server.serverUrl}
                className="flex items-center gap-3 rounded-lg border border-dashed border-border px-3 py-2.5"
              >
                <Server size={15} className="shrink-0 text-muted-foreground" />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-muted-foreground">
                    {server.host}
                  </p>
                  <p className="text-xs text-amber-600 dark:text-amber-400">Signed out</p>
                </div>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => onSignIn(server)}
                  aria-label={`Sign in to ${server.host}`}
                >
                  Sign in
                </Button>
              </div>
            ))}
          </fieldset>

          <div className="grid gap-1.5">
            <Label htmlFor="new-vault-name">Name</Label>
            <Input
              id="new-vault-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="e.g. Research notes"
              autoFocus={!isLocal}
            />
          </div>

          {isLocal && (
            <div className="grid gap-1.5">
              <span className="text-sm font-medium">Folder</span>
              <div className="flex gap-2">
                <span
                  className="flex h-8 min-w-0 flex-1 items-center truncate rounded-lg border border-border bg-muted/40 px-2.5 font-mono text-xs text-muted-foreground"
                  title={folder ?? undefined}
                >
                  {folder ?? 'No folder chosen'}
                </span>
                <Button type="button" variant="outline" onClick={chooseFolder}>
                  Choose…
                </Button>
              </div>
            </div>
          )}

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={!canSubmit}>
              {busy && <Loader2 className="animate-spin" />}
              Create vault
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function LocationOption({
  selected,
  onSelect,
  icon,
  title,
  description,
}: {
  selected: boolean;
  onSelect: () => void;
  icon: ReactNode;
  title: string;
  description: string;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      onClick={onSelect}
      className={cn(
        'flex w-full items-center gap-3 rounded-lg border px-3 py-2.5 text-left transition-colors app-motion-base outline-none focus-visible:ring-3 focus-visible:ring-ring/50',
        selected
          ? 'border-primary/60 bg-primary/10'
          : 'border-border hover:border-primary/30 hover:bg-muted/50',
      )}
    >
      <span
        className={cn(
          'flex size-4 shrink-0 items-center justify-center rounded-full border-2',
          selected ? 'border-primary' : 'border-muted-foreground/50',
        )}
        aria-hidden="true"
      >
        {selected && <span className="size-1.5 rounded-full bg-primary" />}
      </span>
      <span className={cn('shrink-0', selected ? 'text-primary' : 'text-muted-foreground')}>
        {icon}
      </span>
      <span className="min-w-0">
        <span className="block truncate text-sm font-medium">{title}</span>
        <span className="block text-xs text-muted-foreground">{description}</span>
      </span>
    </button>
  );
}
