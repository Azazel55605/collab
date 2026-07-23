import { useEffect, useMemo, useState } from 'react';
import { FolderOpen, Plus, Clock, ArrowRight, Server, RefreshCw, Check, LogIn, LogOut, ChevronDown, WifiOff, Trash2 } from 'lucide-react';
import { AppLogo } from '../ui/AppLogo';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { Separator } from '../ui/separator';
import { useVaultStore } from '../../store/vaultStore';
import { useServerStore, isEffectivelyConnected } from '../../store/serverStore';
import { tauriCommands } from '../../lib/tauri';
import { hostedVaultMeta, vaultKind, type HostedVaultMeta, type HostedVaultSummary, type MemberRole } from '../../types/vault';
import { deleteHostedVaultReplica, listHostedVaultReplicas, type ReplicaSummary } from '../../lib/vaultReplica';
import { HostedLoginForm } from '../server/HostedLoginForm';
import { toast } from 'sonner';

export default function VaultPicker() {
  const { openVault, openHostedVault, loadRecentVaults, recentVaults, isLoading } = useVaultStore();
  const connections = useServerStore((state) => state.connections);
  const isServerLoading = useServerStore((state) => state.isLoading);
  const error = useServerStore((state) => state.error);
  const refreshAll = useServerStore((state) => state.refreshAll);
  const loadHostedVaults = useServerStore((state) => state.loadHostedVaults);
  const createHostedVault = useServerStore((state) => state.createHostedVault);
  const disconnect = useServerStore((state) => state.disconnect);
  // The server URL whose "new hosted vault" input is open, or null.
  const [creatingForServer, setCreatingForServer] = useState<string | null>(null);
  const [hostedName, setHostedName] = useState('');
  const [hostedBusy, setHostedBusy] = useState(false);
  const [showLogin, setShowLogin] = useState(false);
  const [offlineReplicas, setOfflineReplicas] = useState<ReplicaSummary[]>([]);
  const connectedServers = useMemo(
    () => Object.values(connections).filter((c) => c.status.connected && c.status.serverUrl),
    [connections],
  );
  const localRecentVaults = recentVaults.filter((vault) => vaultKind(vault) === 'local').slice(0, 5);

  const refreshOfflineReplicas = () => {
    listHostedVaultReplicas().then(setOfflineReplicas).catch(() => setOfflineReplicas([]));
  };

  useEffect(() => {
    loadRecentVaults();
    refreshAll().catch(() => {});
    refreshOfflineReplicas();
  }, []);

  const activeHostedKeys = useMemo(
    () =>
      new Set(
        connectedServers.flatMap((c) =>
          c.hostedVaults.filter((v) => v.status === 'active').map((v) => `${c.status.serverUrl}|${v.id}`),
        ),
      ),
    [connectedServers],
  );
  const offlineOnlyReplicas = useMemo(
    () => offlineReplicas.filter((replica) => !activeHostedKeys.has(`${replica.serverUrl}|${replica.vaultId}`)),
    [offlineReplicas, activeHostedKeys],
  );
  const offlineReplicasByServer = useMemo(() => {
    const groups = new Map<string, ReplicaSummary[]>();
    for (const replica of offlineOnlyReplicas) {
      const group = groups.get(replica.serverUrl) ?? [];
      group.push(replica);
      groups.set(replica.serverUrl, group);
    }
    return Array.from(groups.entries()).sort(([left], [right]) => left.localeCompare(right));
  }, [offlineOnlyReplicas]);

  const openHosted = async (serverUrl: string, summary: HostedVaultSummary) => {
    try {
      await openHostedVault(hostedVaultMeta(serverUrl, summary));
    } catch (reason) {
      toast.error(`Failed to open hosted vault: ${reason}`);
    }
  };

  const openOfflineReplica = async (replica: ReplicaSummary) => {
    try {
      await openHostedVault(replicaToHostedVaultMeta(replica));
    } catch (reason) {
      toast.error(`Failed to open offline copy: ${reason}`);
    }
  };

  const removeOfflineReplica = async (replica: ReplicaSummary) => {
    const pendingText = replica.pendingCount > 0
      ? `\n\nThis offline copy has ${replica.pendingCount} pending local change${replica.pendingCount === 1 ? '' : 's'} that will be discarded.`
      : '';
    const confirmed = window.confirm(
      `Remove the offline copy of "${replica.vaultName}" from ${replica.serverUrl}?${pendingText}`,
    );
    if (!confirmed) return;
    try {
      await deleteHostedVaultReplica(replica);
      refreshOfflineReplicas();
      toast.success(`Removed offline copy "${replica.vaultName}"`);
    } catch (reason) {
      toast.error(`Could not remove offline copy: ${reason}`);
    }
  };

  const handleCreateHosted = async (serverUrl: string) => {
    const name = hostedName.trim();
    if (!name) return;
    setHostedBusy(true);
    try {
      const created = await createHostedVault(serverUrl, name);
      setHostedName('');
      setCreatingForServer(null);
      await openHostedVault(hostedVaultMeta(serverUrl, created));
    } catch (reason) {
      toast.error(`Failed to create hosted vault: ${reason}`);
    } finally {
      setHostedBusy(false);
    }
  };

  const handleDisconnect = async (serverUrl: string) => {
    try {
      await disconnect(serverUrl);
      toast.success('Disconnected from server');
    } catch (reason) {
      toast.error(`Failed to disconnect: ${reason}`);
    }
  };

  const handleOpenDialog = async () => {
    try {
      const path = await tauriCommands.showOpenVaultDialog();
      if (path) await openVault(path);
    } catch (e) {
      toast.error('Failed to open vault: ' + e);
    }
  };

  const handleCreateVault = async () => {
    try {
      const path = await tauriCommands.showOpenVaultDialog();
      if (!path) return;
      const name = prompt('Vault name:', 'My Vault');
      if (!name) return;
      // Read identity from localStorage — collabStore initialises these on first run
      const userId = localStorage.getItem('collab-user-id') ?? undefined;
      const userName = localStorage.getItem('collab-user-name') ?? undefined;
      await tauriCommands.createVault(path, name, userId, userName);
      await openVault(path);
    } catch (e) {
      toast.error('Failed to create vault: ' + e);
    }
  };

  return (
    <div className="vault-bg flex h-screen min-h-0 justify-center overflow-hidden text-foreground">
      <div className="relative flex h-full min-h-0 w-full max-w-2xl flex-col px-4 py-4 sm:py-6">
        {/* Logo block */}
        <div className="mb-4 shrink-0 text-center app-fade-slide-in sm:mb-6">
          <div className="mb-2.5 inline-flex size-12 items-center justify-center rounded-lg border border-primary/20 bg-primary/15 glow-primary-sm app-fade-scale-in">
            <AppLogo size={25} className="text-primary" />
          </div>
          <h1 className="text-2xl font-bold text-foreground">collab</h1>
          <p className="mt-1 text-xs text-muted-foreground">Your collaborative knowledge base</p>
        </div>

        {/* Glass card */}
        <div className="vault-picker-glass glass flex min-h-0 flex-1 flex-col overflow-hidden rounded-lg shadow-xl shadow-black/10 app-fade-scale-in">
          <div className="grid shrink-0 gap-2.5 border-b border-border/50 p-4 sm:grid-cols-2">
            <Button
              onClick={handleOpenDialog}
              disabled={isLoading}
              className="h-11 gap-2 text-sm font-medium bg-primary hover:bg-primary/90 text-primary-foreground shadow-lg shadow-primary/20 transition-all app-motion-base"
            >
              <FolderOpen size={16} />
              Open Existing Vault
            </Button>
            <Button
              onClick={handleCreateVault}
              variant="outline"
              disabled={isLoading}
              className="h-11 gap-2 border-border/60 bg-card/50 text-sm font-medium transition-all hover:bg-accent app-motion-base"
            >
              <Plus size={16} />
              Create New Vault
            </Button>
          </div>

          <div
            role="region"
            aria-label="Vaults and servers"
            className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-4"
          >
            <div className="mb-3 flex items-center gap-2">
              <Separator className="flex-1 bg-border/40" />
              <span className="flex shrink-0 items-center gap-1 text-[11px] uppercase tracking-widest text-muted-foreground">
                <Server size={10} />
                Hosted
              </span>
              <Separator className="flex-1 bg-border/40" />
            </div>

            <div className="space-y-3">
            {connectedServers.map(({ status, hostedVaults }) => {
              const serverUrl = status.serverUrl!;
              const activeHostedVaults = hostedVaults.filter((vault) => vault.status === 'active');
              const canCreateHosted = isEffectivelyConnected(status);
              return (
                <div key={serverUrl} className="space-y-2">
                  <div className="flex items-center justify-between gap-3 rounded-lg border border-border/40 bg-card/30 px-3 py-2">
                    <div className="min-w-0">
                      <p className="truncate text-xs font-medium">{status.user?.displayName}</p>
                      <p className="truncate text-[10px] text-muted-foreground">{serverUrl}</p>
                    </div>
                    <div className="flex items-center gap-1">
                      {canCreateHosted && (
                        <Button
                          size="icon"
                          variant="ghost"
                          className="size-7"
                          onClick={() => { setCreatingForServer((value) => (value === serverUrl ? null : serverUrl)); setHostedName(''); }}
                          title="New hosted vault"
                        >
                          <Plus size={13} />
                        </Button>
                      )}
                      <Button
                        size="icon"
                        variant="ghost"
                        className="size-7"
                        disabled={isServerLoading}
                        onClick={() => loadHostedVaults(serverUrl).catch((reason) => toast.error(String(reason)))}
                        title="Refresh hosted vaults"
                      >
                        <RefreshCw size={12} className={isServerLoading ? 'animate-spin' : undefined} />
                      </Button>
                      <Button
                        size="icon"
                        variant="ghost"
                        className="size-7"
                        onClick={() => handleDisconnect(serverUrl)}
                        title="Log out of server"
                      >
                        <LogOut size={13} />
                      </Button>
                    </div>
                  </div>
                  {creatingForServer === serverUrl && canCreateHosted && (
                    <div className="flex items-center gap-2 rounded-lg border border-border/40 bg-card/30 px-2 py-2">
                      <Input
                        autoFocus
                        value={hostedName}
                        onChange={(e) => setHostedName(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') handleCreateHosted(serverUrl);
                          if (e.key === 'Escape') { setCreatingForServer(null); setHostedName(''); }
                        }}
                        placeholder="New hosted vault name"
                        className="h-7 text-sm"
                      />
                      <Button size="sm" className="h-7 gap-1 text-xs" disabled={hostedBusy || !hostedName.trim()} onClick={() => handleCreateHosted(serverUrl)}>
                        <Check size={12} />
                        {hostedBusy ? 'Creating…' : 'Create'}
                      </Button>
                    </div>
                  )}
                  {activeHostedVaults.map((vault) => (
                    <button
                      key={vault.id}
                      onClick={() => openHosted(serverUrl, vault)}
                      disabled={isLoading || isServerLoading}
                      className="group flex w-full items-center gap-3 rounded-lg border border-transparent px-3 py-2.5 text-left transition-all app-motion-base hover:border-primary/25 hover:bg-primary/5"
                    >
                      <div className="flex size-7 shrink-0 items-center justify-center rounded-md border border-primary/20 bg-primary/10">
                        <Server size={12} className="text-primary" />
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-sm font-medium text-foreground">{vault.name}</div>
                        <div className="truncate text-[11px] text-muted-foreground">
                          {vault.role} · {vault.members} members · {vault.ownerDisplayName}
                        </div>
                      </div>
                      <ArrowRight size={13} className="shrink-0 text-muted-foreground opacity-0 transition-all app-motion-base group-hover:translate-x-0.5 group-hover:opacity-60" />
                    </button>
                  ))}
                  {!isServerLoading && activeHostedVaults.length === 0 && (
                    <p className="py-2 text-center text-xs text-muted-foreground">No active hosted vaults on this server.</p>
                  )}
                </div>
              );
            })}
            {error && <p className="text-xs text-destructive">{error}</p>}

            {showLogin ? (
              <div className="space-y-3 rounded-lg border border-border/40 bg-card/30 p-3">
                <HostedLoginForm onConnected={() => setShowLogin(false)} />
                <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => setShowLogin(false)}>Cancel</Button>
              </div>
            ) : (
              <button
                onClick={() => setShowLogin(true)}
                className="flex w-full items-center gap-3 rounded-lg border border-dashed border-border/60 px-3 py-3 text-left transition-colors hover:border-primary/30 hover:bg-primary/5"
              >
                <LogIn size={14} className="text-muted-foreground" />
                <div className="flex-1">
                  <p className="text-sm font-medium">{connectedServers.length === 0 ? 'Connect a Collab server' : 'Add another server'}</p>
                  <p className="text-[11px] text-muted-foreground">Sign in to open hosted vaults.</p>
                </div>
                <ChevronDown size={14} className="text-muted-foreground" />
              </button>
            )}
          </div>

            {offlineReplicasByServer.length > 0 && (
              <div className="mt-3 space-y-3">
              {offlineReplicasByServer.map(([serverUrl, replicas]) => (
                <div key={serverUrl} className="space-y-1">
                  <div className="flex items-center gap-1.5 px-1 text-[10px] uppercase tracking-widest text-muted-foreground">
                    <WifiOff size={10} />
                    Offline copies · {serverUrl}
                  </div>
                  {replicas.map((replica) => (
                    <div
                      key={`${replica.serverUrl}|${replica.vaultId}`}
                      className="group flex w-full items-center gap-3 rounded-lg border border-transparent px-3 py-2.5 text-left transition-all app-motion-base hover:border-amber-500/25 hover:bg-amber-500/5"
                    >
                      <div className="flex size-7 shrink-0 items-center justify-center rounded-md border border-amber-500/20 bg-amber-500/10">
                        <WifiOff size={12} className="text-amber-400" />
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-sm font-medium text-foreground">{replica.vaultName}</div>
                        <div className="truncate text-[11px] text-muted-foreground">
                          offline copy · {replicaRole(replica)} · {replica.pendingCount} pending
                        </div>
                      </div>
                      <button
                        type="button"
                        onClick={() => openOfflineReplica(replica)}
                        disabled={isLoading}
                        className="flex h-7 items-center gap-1 rounded px-2 text-[11px] font-medium text-primary transition-colors hover:bg-primary/10"
                        title="Open offline copy"
                      >
                        Open <ArrowRight size={11} />
                      </button>
                      <button
                        type="button"
                        onClick={() => removeOfflineReplica(replica)}
                        disabled={isLoading}
                        className="flex size-7 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive"
                        title="Remove offline copy"
                        aria-label={`Remove offline copy ${replica.vaultName}`}
                      >
                        <Trash2 size={12} />
                      </button>
                    </div>
                  ))}
                </div>
              ))}
              </div>
            )}

            {localRecentVaults.length > 0 && (
              <>
                <div className="mb-3 mt-5 flex items-center gap-2">
                  <Separator className="flex-1 bg-border/40" />
                  <span className="flex shrink-0 items-center gap-1 text-[11px] uppercase tracking-widest text-muted-foreground">
                    <Clock size={10} />
                    Recent
                  </span>
                  <Separator className="flex-1 bg-border/40" />
                </div>

                <div className="space-y-1">
                  {localRecentVaults.map((v) => (
                    <button
                      key={v.id}
                      onClick={() => openVault(v.path)}
                      disabled={isLoading}
                      className="group flex w-full items-center gap-3 rounded-lg border border-transparent px-3 py-2.5 text-left transition-all hover:border-border/50 hover:bg-accent/60 app-motion-base"
                    >
                      <div className="flex size-7 shrink-0 items-center justify-center rounded-md border border-primary/15 bg-primary/10">
                        <div className="size-2 rounded-sm bg-primary/70" />
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-sm font-medium text-foreground">{v.name}</div>
                        <div className="truncate text-[11px] text-muted-foreground opacity-70">{v.path}</div>
                      </div>
                      <ArrowRight
                        size={13}
                        className="shrink-0 text-muted-foreground opacity-0 transition-all group-hover:translate-x-0.5 group-hover:opacity-60 app-motion-base"
                      />
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>
        </div>

        <p className="mt-3 shrink-0 text-center text-[11px] text-muted-foreground/60">
          Local-first vaults · Optional hosted collaboration
        </p>
      </div>
    </div>
  );
}

function replicaRole(replica: ReplicaSummary): MemberRole {
  return replica.role === 'admin' || replica.role === 'editor' || replica.role === 'viewer'
    ? replica.role
    : 'viewer';
}

function replicaToHostedVaultMeta(replica: ReplicaSummary): HostedVaultMeta {
  return {
    kind: 'hosted',
    id: replica.vaultId,
    hostedVaultId: replica.vaultId,
    serverUrl: replica.serverUrl,
    name: replica.vaultName,
    path: `hosted://${replica.vaultId}`,
    lastOpened: Date.parse(replica.updatedAt) || Date.now(),
    isEncrypted: false,
    role: replicaRole(replica),
    capabilities: replica.capabilities ?? [],
  };
}
