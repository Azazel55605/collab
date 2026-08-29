import { useEffect, useRef, useState } from 'react';

import {
  AlertTriangle,
  Check,
  ChevronRight,
  Clock,
  Download,
  Eye,
  EyeOff,
  FolderOpen,
  HardDriveDownload,
  Lock,
  LockOpen,
  Pencil,
  Plus,
  RefreshCw,
  Server,
  ShieldCheck,
  Trash2,
  Upload,
  Vault,
  WifiOff,
} from 'lucide-react';
import { toast } from 'sonner';

import { tauriCommands } from '../../lib/tauri';
import { cn } from '../../lib/utils';
import {
  createVaultClient,
  hasRuntimeCapability,
  requireRuntimeCapability,
} from '../../lib/vaultClient';
import {
  deleteHostedVaultReplica,
  listHostedVaultReplicas,
  type ReplicaSummary,
} from '../../lib/vaultReplica';
import { isEffectivelyConnected, useServerStore } from '../../store/serverStore';
import { syncRollup, useSyncStore } from '../../store/syncStore';
import { useUiStore } from '../../store/uiStore';
import { useVaultStore } from '../../store/vaultStore';
import {
  hostedVaultMeta,
  type HostedVaultMeta,
  type HostedVaultSummary,
  type MemberRole,
  vaultKind,
  type VaultKind,
  type VaultMeta,
} from '../../types/vault';
import { Button } from '../ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../ui/dialog';
import { Input } from '../ui/input';

import { HostedMembersPanel } from './HostedMembersPanel';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatDate(ms: number): string {
  if (!ms) return 'Never';
  const d = new Date(ms);
  const now = Date.now();
  const diff = now - ms;
  if (diff < 60_000) return 'Just now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  if (diff < 7 * 86_400_000) return `${Math.floor(diff / 86_400_000)}d ago`;
  return d.toLocaleDateString();
}

// ─── Create Vault Form ────────────────────────────────────────────────────────

function CreateVaultForm({ onDone }: { onDone: () => void }) {
  const { openVault } = useVaultStore();
  const [name, setName] = useState('');
  const [path, setPath] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const pickFolder = async () => {
    const p = await tauriCommands.showOpenVaultDialog();
    if (p) setPath(p);
  };

  const create = async () => {
    if (!path || !name.trim()) return;
    setBusy(true);
    try {
      const userId = localStorage.getItem('collab-user-id') ?? undefined;
      const userName = localStorage.getItem('collab-user-name') ?? undefined;
      await tauriCommands.createVault(path, name.trim(), userId, userName);
      await openVault(path);
      onDone();
      toast.success(`Vault "${name.trim()}" created`);
    } catch (e) {
      toast.error('Failed to create vault: ' + e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="p-4 rounded-lg border border-primary/30 bg-primary/5 space-y-3 app-fade-slide-in">
      <p className="text-sm font-medium text-foreground">New Vault</p>
      <Input
        ref={inputRef}
        placeholder="Vault name"
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') create();
          if (e.key === 'Escape') onDone();
        }}
        className="h-8 text-sm"
      />
      <Button
        type="button"
        variant="outline"
        onClick={pickFolder}
        className="w-full justify-start gap-2 h-9 bg-background/40 hover:bg-accent/60 text-sm font-normal app-motion-base"
      >
        <FolderOpen size={13} className="text-muted-foreground shrink-0" />
        <span className={cn('truncate', path ? 'text-foreground' : 'text-muted-foreground')}>
          {path ?? 'Pick folder…'}
        </span>
      </Button>
      <div className="flex gap-2 justify-end">
        <Button variant="ghost" size="sm" onClick={onDone} disabled={busy}>
          Cancel
        </Button>
        <Button size="sm" onClick={create} disabled={busy || !path || !name.trim()}>
          Create &amp; Open
        </Button>
      </div>
    </div>
  );
}

// ─── Vault Row ────────────────────────────────────────────────────────────────

interface VaultRowProps {
  meta: VaultMeta;
  isCurrent: boolean;
  onOpen: () => void;
  onRemove: () => void;
  onExport?: () => void;
  onRenameComplete: (newName: string) => void;
}

function VaultRow({
  meta,
  isCurrent,
  onOpen,
  onRemove,
  onExport,
  onRenameComplete,
}: VaultRowProps) {
  const [renaming, setRenaming] = useState(false);
  const [renameVal, setRenameVal] = useState(meta.name);
  const renameRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (renaming) renameRef.current?.select();
  }, [renaming]);

  const commitRename = () => {
    const trimmed = renameVal.trim();
    if (trimmed && trimmed !== meta.name) onRenameComplete(trimmed);
    setRenaming(false);
  };

  return (
    <div
      className={cn(
        'group flex w-full items-start gap-3 rounded-lg border px-3 py-3 transition-all app-motion-base',
        isCurrent
          ? 'border-primary/30 bg-primary/6'
          : 'border-transparent hover:border-border/50 hover:bg-accent/30',
      )}
    >
      {/* Vault icon */}
      <div
        className={cn(
          'w-8 h-8 rounded-md flex items-center justify-center shrink-0 border',
          isCurrent ? 'bg-primary/15 border-primary/25' : 'bg-muted/40 border-border/40',
        )}
      >
        <Vault size={14} className={isCurrent ? 'text-primary' : 'text-muted-foreground'} />
      </div>

      {/* Name + path */}
      <div className="min-w-0 flex-1">
        {renaming ? (
          <Input
            ref={renameRef}
            value={renameVal}
            onChange={(e) => setRenameVal(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commitRename();
              if (e.key === 'Escape') {
                setRenaming(false);
                setRenameVal(meta.name);
              }
            }}
            onBlur={commitRename}
            className="h-6 text-sm px-1.5 py-0"
          />
        ) : (
          <div className="flex items-center gap-1.5">
            <span className="text-sm font-medium text-foreground truncate">{meta.name}</span>
            {isCurrent && (
              <span className="text-[10px] font-medium px-1.5 py-0.5 rounded-full bg-primary/15 text-primary shrink-0">
                current
              </span>
            )}
          </div>
        )}
        <div className="mt-0.5 flex min-w-0 items-center gap-1.5 text-[11px] text-muted-foreground">
          <span className="min-w-0 max-w-[22rem] flex-1 truncate opacity-70">{meta.path}</span>
          <span className="shrink-0 opacity-50">·</span>
          <span className="shrink-0 flex items-center gap-1">
            <Clock size={9} />
            {formatDate(meta.lastOpened)}
          </span>
        </div>
      </div>

      {/* Actions */}
      <div className="ml-2 flex shrink-0 items-center gap-0.5 self-center border-l border-border/35 pl-3 opacity-0 transition-opacity app-motion-fast group-hover:opacity-100">
        {!isCurrent && (
          <button
            onClick={onOpen}
            title="Open vault"
            className="h-6 px-2 rounded text-[11px] font-medium text-primary hover:bg-primary/10 transition-colors app-motion-fast flex items-center gap-1"
          >
            Open <ChevronRight size={10} />
          </button>
        )}
        <button
          onClick={() => setRenaming(true)}
          title="Rename"
          className="w-6 h-6 flex items-center justify-center rounded text-muted-foreground hover:text-foreground hover:bg-accent/60 transition-colors app-motion-fast"
        >
          <Pencil size={12} />
        </button>
        {onExport && (
          <button
            onClick={onExport}
            title="Export as ZIP"
            className="w-6 h-6 flex items-center justify-center rounded text-muted-foreground hover:text-foreground hover:bg-accent/60 transition-colors app-motion-fast"
          >
            <Download size={12} />
          </button>
        )}
        <button
          onClick={onRemove}
          title="Remove from list"
          className="w-6 h-6 flex items-center justify-center rounded text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors app-motion-fast"
        >
          <Trash2 size={12} />
        </button>
      </div>
    </div>
  );
}

// ─── Hosted Vault Row ───────────────────────────────────────────────────────

function HostedVaultRow({
  summary,
  isCurrent,
  onOpen,
  onExport,
  offline = false,
  serverUrl,
  onRemoveOffline,
}: {
  summary: HostedVaultSummary;
  isCurrent: boolean;
  onOpen: () => void;
  onExport?: () => void;
  offline?: boolean;
  serverUrl?: string;
  onRemoveOffline?: () => void;
}) {
  return (
    <div
      className={cn(
        'group flex w-full items-start gap-3 rounded-lg border px-3 py-3 transition-all app-motion-base',
        isCurrent
          ? 'border-primary/30 bg-primary/6'
          : 'border-transparent hover:border-border/50 hover:bg-accent/30',
      )}
    >
      <div
        className={cn(
          'w-8 h-8 rounded-md flex items-center justify-center shrink-0 border',
          isCurrent
            ? 'bg-primary/15 border-primary/25'
            : offline
              ? 'bg-amber-500/10 border-amber-500/20'
              : 'bg-primary/10 border-primary/20',
        )}
      >
        {offline ? (
          <WifiOff size={14} className="text-amber-400" />
        ) : (
          <Server size={14} className="text-primary" />
        )}
      </div>

      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="text-sm font-medium text-foreground truncate">{summary.name}</span>
          {isCurrent && (
            <span className="text-[10px] font-medium px-1.5 py-0.5 rounded-full bg-primary/15 text-primary shrink-0">
              current
            </span>
          )}
          {offline && (
            <span className="text-[10px] font-medium px-1.5 py-0.5 rounded-full bg-amber-500/10 text-amber-400 shrink-0">
              offline copy
            </span>
          )}
        </div>
        <div className="mt-0.5 flex min-w-0 items-center gap-1.5 text-[11px] text-muted-foreground">
          <span className="shrink-0 capitalize">{summary.role}</span>
          <span className="shrink-0 opacity-50">·</span>
          {offline ? (
            <span className="min-w-0 truncate opacity-70">{serverUrl}</span>
          ) : (
            <>
              <span className="shrink-0">
                {summary.members} {summary.members === 1 ? 'member' : 'members'}
              </span>
              <span className="shrink-0 opacity-50">·</span>
              <span className="min-w-0 truncate opacity-70">{summary.ownerDisplayName}</span>
            </>
          )}
        </div>
      </div>

      {(!isCurrent || onExport || onRemoveOffline) && (
        <div className="ml-2 flex shrink-0 items-center gap-0.5 self-center border-l border-border/35 pl-3 opacity-0 transition-opacity app-motion-fast group-hover:opacity-100">
          {!isCurrent && (
            <button
              onClick={onOpen}
              title="Open hosted vault"
              className="h-6 px-2 rounded text-[11px] font-medium text-primary hover:bg-primary/10 transition-colors app-motion-fast flex items-center gap-1"
            >
              Open <ChevronRight size={10} />
            </button>
          )}
          {onExport && (
            <button
              onClick={onExport}
              title="Export as ZIP"
              className="w-6 h-6 flex items-center justify-center rounded text-muted-foreground hover:text-foreground hover:bg-accent/60 transition-colors app-motion-fast"
            >
              <Download size={12} />
            </button>
          )}
          {onRemoveOffline && (
            <button
              onClick={onRemoveOffline}
              title="Remove offline copy"
              className="w-6 h-6 flex items-center justify-center rounded text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors app-motion-fast"
            >
              <Trash2 size={12} />
            </button>
          )}
        </div>
      )}
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

function replicaToHostedVaultSummary(replica: ReplicaSummary): HostedVaultSummary {
  return {
    id: replica.vaultId,
    name: replica.vaultName,
    ownerUserId: '',
    ownerDisplayName: 'Offline copy',
    role: replicaRole(replica),
    status: 'active',
    manifestSequence: replica.manifestSequence,
    members: 0,
    storageBytes: 0,
    createdAt: replica.updatedAt,
    updatedAt: replica.updatedAt,
    capabilities: replica.capabilities ?? [],
  };
}

// ─── Vaults Tab ───────────────────────────────────────────────────────────────

function VaultsTab({
  onClose,
  onRequestRemove,
}: {
  onClose: () => void;
  onRequestRemove: (meta: VaultMeta) => void;
}) {
  const { vault, recentVaults, openVault, openHostedVault, loadRecentVaults, closeVault } =
    useVaultStore();
  const connections = useServerStore((state) => state.connections);
  const serverLoading = useServerStore((state) => state.isLoading);
  const refreshAll = useServerStore((state) => state.refreshAll);
  const loadHostedVaults = useServerStore((state) => state.loadHostedVaults);
  const createHostedVault = useServerStore((state) => state.createHostedVault);
  const [creating, setCreating] = useState(false);
  // The server URL whose "new hosted vault" input is open, or null.
  const [creatingForServer, setCreatingForServer] = useState<string | null>(null);
  const [hostedName, setHostedName] = useState('');
  const [hostedBusy, setHostedBusy] = useState(false);
  const [vaults, setVaults] = useState<VaultMeta[]>(recentVaults);
  const [offlineReplicas, setOfflineReplicas] = useState<ReplicaSummary[]>([]);

  const refreshOfflineReplicas = () => {
    listHostedVaultReplicas()
      .then(setOfflineReplicas)
      .catch(() => setOfflineReplicas([]));
  };

  useEffect(() => {
    loadRecentVaults().then(() => setVaults(useVaultStore.getState().recentVaults));
    // Pull the latest hosted inventory so connected users can open server vaults here too.
    refreshAll().catch(() => {});
    refreshOfflineReplicas();
  }, []);

  // Keep local list in sync with store
  useEffect(() => {
    setVaults(recentVaults);
  }, [recentVaults]);

  const localVaults = vaults.filter((meta) => vaultKind(meta) === 'local');
  const connectedServers = Object.values(connections).filter(
    (c) => c.status.connected && c.status.serverUrl,
  );
  const totalActiveHosted = connectedServers.reduce(
    (sum, c) => sum + c.hostedVaults.filter((hosted) => hosted.status === 'active').length,
    0,
  );
  const activeHostedKeys = new Set(
    connectedServers.flatMap((c) =>
      c.hostedVaults
        .filter((hosted) => hosted.status === 'active')
        .map((hosted) => `${c.status.serverUrl}|${hosted.id}`),
    ),
  );
  const offlineOnlyReplicas = offlineReplicas.filter(
    (replica) => !activeHostedKeys.has(`${replica.serverUrl}|${replica.vaultId}`),
  );
  const offlineReplicasByServer = Array.from(
    offlineOnlyReplicas.reduce((groups, replica) => {
      const group = groups.get(replica.serverUrl) ?? [];
      group.push(replica);
      groups.set(replica.serverUrl, group);
      return groups;
    }, new Map<string, ReplicaSummary[]>()),
  ).sort(([left], [right]) => left.localeCompare(right));
  const handleOpen = async (path: string) => {
    try {
      await openVault(path);
      onClose();
    } catch (e) {
      toast.error('Failed to open vault: ' + e);
    }
  };

  const handleOpenHosted = async (serverUrl: string, summary: HostedVaultSummary) => {
    try {
      await openHostedVault(hostedVaultMeta(serverUrl, summary));
      onClose();
    } catch (e) {
      toast.error('Failed to open hosted vault: ' + e);
    }
  };

  const handleOpenOfflineReplica = async (replica: ReplicaSummary) => {
    try {
      await openHostedVault(replicaToHostedVaultMeta(replica));
      onClose();
    } catch (e) {
      toast.error('Failed to open offline copy: ' + e);
    }
  };

  const handleRemoveOfflineReplica = async (replica: ReplicaSummary) => {
    const pendingText =
      replica.pendingCount > 0
        ? `\n\nThis offline copy has ${replica.pendingCount} pending local change${replica.pendingCount === 1 ? '' : 's'} that will be discarded.`
        : '';
    const confirmed = window.confirm(
      `Remove the offline copy of "${replica.vaultName}" from ${replica.serverUrl}?${pendingText}`,
    );
    if (!confirmed) return;
    try {
      await deleteHostedVaultReplica(replica);
      if (
        vault?.kind === 'hosted' &&
        vault.hostedVaultId === replica.vaultId &&
        vault.serverUrl === replica.serverUrl
      ) {
        closeVault();
      }
      refreshOfflineReplicas();
      toast.success(`Removed offline copy "${replica.vaultName}"`);
    } catch (e) {
      toast.error('Failed to remove offline copy: ' + e);
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
      onClose();
      toast.success(`Created hosted vault "${created.name}"`);
    } catch (e) {
      toast.error('Failed to create hosted vault: ' + e);
    } finally {
      setHostedBusy(false);
    }
  };

  const handleImport = async () => {
    try {
      const path = await tauriCommands.showOpenVaultDialog();
      if (!path) return;
      await openVault(path);
      onClose();
      toast.success('Vault imported');
    } catch (e) {
      toast.error('Failed to import vault: ' + e);
    }
  };

  const handleExport = async (meta: VaultMeta) => {
    try {
      const exporter = requireRuntimeCapability(createVaultClient(meta), 'archiveExport');
      const dest = await tauriCommands.showSaveDialog(`${meta.name}.zip`);
      if (!dest) return;
      await exporter.exportTo(dest);
      toast.success(`Exported "${meta.name}" to ${dest}`);
    } catch (e) {
      toast.error('Export failed: ' + e);
    }
  };

  const handleRename = async (meta: VaultMeta, newName: string) => {
    try {
      await tauriCommands.renameVault(meta.path, newName);
      setVaults((prev) => prev.map((v) => (v.path === meta.path ? { ...v, name: newName } : v)));
    } catch (e) {
      toast.error('Rename failed: ' + e);
    }
  };

  return (
    <div className="flex h-full w-full justify-start">
      <div className="flex h-full w-full max-w-[34rem] flex-col gap-3 pr-6">
        {/* Action bar */}
        <div className="flex gap-2 shrink-0">
          <Button
            size="sm"
            variant="outline"
            className="gap-1.5 text-xs h-8"
            onClick={() => setCreating((v) => !v)}
          >
            <Plus size={13} />
            New Vault
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="gap-1.5 text-xs h-8"
            onClick={handleImport}
          >
            <Upload size={13} />
            Import Folder
          </Button>
        </div>

        {/* Create form */}
        {creating && <CreateVaultForm onDone={() => setCreating(false)} />}

        {/* Vault list */}
        <div className="flex-1 overflow-y-auto min-h-0">
          {localVaults.length === 0 &&
            totalActiveHosted === 0 &&
            offlineOnlyReplicas.length === 0 &&
            !creating && (
              <div className="flex flex-col items-center justify-center py-12 gap-2 text-muted-foreground">
                <Vault size={32} className="opacity-20" />
                <p className="text-sm">No vaults yet. Create or import one.</p>
              </div>
            )}

          {/* Hosted vaults, grouped by connected server */}
          {connectedServers.map(({ status, hostedVaults }) => {
            const serverUrl = status.serverUrl!;
            const activeHostedVaults = hostedVaults.filter((hosted) => hosted.status === 'active');
            const canCreateHosted = isEffectivelyConnected(status);
            return (
              <div key={serverUrl} className="mb-4">
                <div className="mb-2 flex items-center justify-between">
                  <span className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-widest text-muted-foreground">
                    <Server size={11} />
                    Hosted · {serverUrl}
                  </span>
                  <div className="flex items-center gap-0.5">
                    {canCreateHosted && (
                      <button
                        onClick={() => {
                          setCreatingForServer((value) => (value === serverUrl ? null : serverUrl));
                          setHostedName('');
                        }}
                        title="New hosted vault"
                        className="w-6 h-6 flex items-center justify-center rounded text-muted-foreground hover:text-foreground hover:bg-accent/60 transition-colors app-motion-fast"
                      >
                        <Plus size={13} />
                      </button>
                    )}
                    <button
                      onClick={() =>
                        loadHostedVaults(serverUrl).catch((reason) => toast.error(String(reason)))
                      }
                      title="Refresh hosted vaults"
                      className="w-6 h-6 flex items-center justify-center rounded text-muted-foreground hover:text-foreground hover:bg-accent/60 transition-colors app-motion-fast"
                    >
                      <RefreshCw size={12} className={serverLoading ? 'animate-spin' : undefined} />
                    </button>
                  </div>
                </div>
                {creatingForServer === serverUrl && canCreateHosted && (
                  <div className="mb-2 flex items-center gap-2 rounded-lg border border-border/50 bg-card/30 p-2">
                    <Input
                      autoFocus
                      value={hostedName}
                      onChange={(e) => setHostedName(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') handleCreateHosted(serverUrl);
                        if (e.key === 'Escape') {
                          setCreatingForServer(null);
                          setHostedName('');
                        }
                      }}
                      placeholder="New hosted vault name"
                      className="h-7 text-sm"
                    />
                    <Button
                      size="sm"
                      className="h-7 gap-1 text-xs"
                      disabled={hostedBusy || !hostedName.trim()}
                      onClick={() => handleCreateHosted(serverUrl)}
                    >
                      <Check size={12} />
                      {hostedBusy ? 'Creating…' : 'Create'}
                    </Button>
                  </div>
                )}
                <div className="flex flex-col gap-2">
                  {activeHostedVaults.map((summary) => (
                    <HostedVaultRow
                      key={summary.id}
                      summary={summary}
                      isCurrent={
                        vault?.kind === 'hosted' &&
                        vault.hostedVaultId === summary.id &&
                        vault.serverUrl === serverUrl
                      }
                      onOpen={() => handleOpenHosted(serverUrl, summary)}
                      onExport={
                        summary.role === 'admin'
                          ? () => handleExport(hostedVaultMeta(serverUrl, summary))
                          : undefined
                      }
                    />
                  ))}
                  {!serverLoading && activeHostedVaults.length === 0 && (
                    <p className="py-2 text-center text-xs text-muted-foreground">
                      No hosted vaults available on this server.
                    </p>
                  )}
                </div>
              </div>
            );
          })}

          {/* Offline hosted replicas from any server */}
          {offlineReplicasByServer.map(([serverUrl, replicas]) => (
            <div key={serverUrl} className="mb-4">
              <div className="mb-2 flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-widest text-muted-foreground">
                <WifiOff size={11} />
                Offline copies · {serverUrl}
              </div>
              <div className="flex flex-col gap-2">
                {replicas.map((replica) => (
                  <HostedVaultRow
                    key={`${replica.serverUrl}|${replica.vaultId}`}
                    summary={replicaToHostedVaultSummary(replica)}
                    isCurrent={
                      vault?.kind === 'hosted' &&
                      vault.hostedVaultId === replica.vaultId &&
                      vault.serverUrl === replica.serverUrl
                    }
                    onOpen={() => handleOpenOfflineReplica(replica)}
                    offline
                    serverUrl={replica.serverUrl}
                    onRemoveOffline={() => handleRemoveOfflineReplica(replica)}
                  />
                ))}
              </div>
            </div>
          ))}

          {/* Local vaults */}
          {(localVaults.length > 0 ||
            connectedServers.length > 0 ||
            offlineOnlyReplicas.length > 0) && (
            <div className="mb-2 flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-widest text-muted-foreground">
              <Clock size={11} />
              Local
            </div>
          )}
          <div className="flex flex-col gap-2">
            {localVaults.map((meta) => {
              const client = createVaultClient(meta);
              return (
                <VaultRow
                  key={meta.path}
                  meta={meta}
                  isCurrent={vault?.path === meta.path}
                  onOpen={() => handleOpen(meta.path)}
                  onRemove={() => onRequestRemove(meta)}
                  onExport={
                    hasRuntimeCapability(client, 'archiveExport')
                      ? () => handleExport(meta)
                      : undefined
                  }
                  onRenameComplete={(newName) => handleRename(meta, newName)}
                />
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Hosted Permissions Tab ───────────────────────────────────────────────────

function HostedPermissionsTab() {
  return <HostedMembersPanel />;
}

function OfflineSyncTab() {
  const vault = useVaultStore((state) => state.vault);
  const hostedVault = vault && vaultKind(vault) === 'hosted' ? (vault as HostedVaultMeta) : null;
  const {
    status,
    lastSyncedAt,
    offlineAvailableAt,
    pending,
    failed,
    access,
    isSyncing,
    refresh,
    syncNow,
    makeAvailableOffline,
    removeReplica,
  } = useSyncStore();
  const [progress, setProgress] = useState<{ completed: number; total: number } | null>(null);
  const [removing, setRemoving] = useState(false);

  useEffect(() => {
    if (!hostedVault) return;
    refresh(hostedVault).catch(() => {});
  }, [hostedVault, refresh]);

  if (!hostedVault) {
    return (
      <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
        Offline sync is available for hosted vaults.
      </div>
    );
  }

  const rollup = syncRollup({ isSyncing, status, pending, failed });
  const lastSyncLabel = lastSyncedAt ? new Date(lastSyncedAt).toLocaleString() : 'Not synced yet';
  const offlineReadyLabel = offlineAvailableAt
    ? new Date(offlineAvailableAt).toLocaleString()
    : null;
  const accessLost = access !== 'ok';
  const progressLabel =
    progress && progress.total > 0
      ? `${progress.completed} / ${progress.total} files cached`
      : progress
        ? 'Preparing offline cache…'
        : null;

  const handleMakeOffline = async () => {
    setProgress({ completed: 0, total: 0 });
    try {
      const report = await makeAvailableOffline(hostedVault, (completed, total) => {
        setProgress({ completed, total });
      });
      toast.success(
        `Offline copy ready: ${report.documentsCached} documents and ${report.assetsCached} assets cached` +
          (report.alreadyCached ? ` (${report.alreadyCached} already cached)` : '') +
          (report.skipped ? ` (${report.skipped} skipped)` : ''),
      );
    } catch (error) {
      toast.error(`Could not prepare offline copy: ${error}`);
    } finally {
      setProgress(null);
    }
  };

  const handleSyncNow = async () => {
    try {
      await syncNow(hostedVault);
      toast.success('Hosted vault synced');
    } catch (error) {
      toast.error(`Sync failed: ${error}`);
    }
  };

  const handleRemoveReplica = async () => {
    setRemoving(true);
    try {
      await removeReplica(hostedVault);
      toast.success('Removed the local offline copy');
    } catch (error) {
      toast.error(`Could not remove offline copy: ${error}`);
    } finally {
      setRemoving(false);
    }
  };

  return (
    <div className="flex h-full flex-col gap-4 overflow-y-auto pr-1">
      <div className="rounded-lg border border-primary/25 bg-primary/5 p-4">
        <div className="flex items-start gap-3">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-primary/25 bg-primary/10 text-primary">
            <HardDriveDownload size={16} />
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-semibold text-foreground">Hosted offline sync</p>
            <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
              Hosted vaults keep an automatic local replica. Use this action to download active
              document and asset bodies now, so the vault stays useful before you lose connection.
            </p>
          </div>
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <div className="rounded-lg border border-border/50 bg-card/60 p-3">
          <p className="text-[11px] font-semibold uppercase tracking-widest text-muted-foreground">
            Status
          </p>
          <p className="mt-2 text-sm font-medium capitalize text-foreground">
            {accessLost ? access : rollup}
          </p>
          <p className="mt-1 text-xs text-muted-foreground">Last sync: {lastSyncLabel}</p>
          {offlineReadyLabel && (
            <p className="mt-1 text-xs text-primary">Offline copy ready: {offlineReadyLabel}</p>
          )}
        </div>
        <div className="rounded-lg border border-border/50 bg-card/60 p-3">
          <p className="text-[11px] font-semibold uppercase tracking-widest text-muted-foreground">
            Local changes
          </p>
          <p className="mt-2 text-sm font-medium text-foreground">{pending.length} pending</p>
          <p className="mt-1 text-xs text-muted-foreground">
            {failed.length} conflict{failed.length === 1 ? '' : 's'} need attention
          </p>
        </div>
      </div>

      {accessLost && (
        <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-xs text-muted-foreground">
          <p className="mb-1 flex items-center gap-1 font-medium text-destructive">
            <AlertTriangle size={13} /> Sync unavailable
          </p>
          Your access to this vault is no longer valid on the server. The local copy is kept until
          you remove it.
        </div>
      )}

      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          className="gap-1.5"
          disabled={isSyncing || accessLost || !!offlineAvailableAt}
          title={offlineAvailableAt ? 'This vault already has an offline copy.' : undefined}
          onClick={() => void handleMakeOffline()}
        >
          <HardDriveDownload size={13} />
          {progressLabel ?? (offlineAvailableAt ? 'Offline copy ready' : 'Make available offline')}
        </Button>
        <Button
          size="sm"
          variant="outline"
          className="gap-1.5"
          disabled={isSyncing || accessLost}
          onClick={() => void handleSyncNow()}
        >
          <RefreshCw size={13} className={isSyncing ? 'app-spin-soft' : undefined} />
          Sync now
        </Button>
        <Button
          size="sm"
          variant="ghost"
          className="ml-auto gap-1.5 text-muted-foreground hover:text-destructive"
          disabled={isSyncing || removing || pending.length > 0 || failed.length > 0}
          title={
            pending.length > 0 || failed.length > 0
              ? 'Resolve or discard unsynced changes before removing the offline copy.'
              : undefined
          }
          onClick={() => void handleRemoveReplica()}
        >
          <Trash2 size={13} />
          {removing ? 'Removing…' : 'Remove offline copy'}
        </Button>
      </div>

      <p className="text-[11px] leading-relaxed text-muted-foreground">
        The status-bar sync chip is still the quickest place to retry, discard, or inspect pending
        offline changes while you work.
      </p>
    </div>
  );
}

// ─── Main Modal ───────────────────────────────────────────────────────────────

// ─── Encryption Tab ───────────────────────────────────────────────────────────

function PasswordField({
  label,
  value,
  onChange,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
}) {
  const [show, setShow] = useState(false);
  return (
    <div>
      <label className="text-[11px] font-semibold text-muted-foreground uppercase tracking-widest mb-1.5 block">
        {label}
      </label>
      <div className="relative">
        <Input
          type={show ? 'text' : 'password'}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder ?? '••••••••'}
          className="h-8 text-sm pr-9"
        />
        <button
          type="button"
          onClick={() => setShow((v) => !v)}
          tabIndex={-1}
          className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
        >
          {show ? <EyeOff size={13} /> : <Eye size={13} />}
        </button>
      </div>
    </div>
  );
}

function EncryptionTab() {
  const { vault } = useVaultStore();
  const isEncrypted = vault?.isEncrypted ?? false;

  // Enable form
  const [newPw, setNewPw] = useState('');
  const [confirmPw, setConfirmPw] = useState('');
  const [enableBusy, setEnableBusy] = useState(false);

  // Change password form
  const [oldPw, setOldPw] = useState('');
  const [changePw, setChangePw] = useState('');
  const [changeConfirm, setChangeConfirm] = useState('');
  const [changeBusy, setChangeBusy] = useState(false);

  // Disable form
  const [disablePw, setDisablePw] = useState('');
  const [disableBusy, setDisableBusy] = useState(false);

  const handleEnable = async () => {
    if (!vault) return;
    if (!newPw) return toast.error('Enter a password');
    if (newPw !== confirmPw) return toast.error('Passwords do not match');
    if (newPw.length < 8) return toast.error('Password must be at least 8 characters');
    setEnableBusy(true);
    try {
      await requireRuntimeCapability(createVaultClient(vault), 'encryption').enable(newPw);
      // Update in-memory vault meta so the UI reflects the change
      useVaultStore.setState((s) => ({
        vault: s.vault ? { ...s.vault, isEncrypted: true } : s.vault,
      }));
      setNewPw('');
      setConfirmPw('');
      toast.success('Vault encryption enabled');
    } catch (e) {
      toast.error('Failed to enable encryption: ' + e);
    } finally {
      setEnableBusy(false);
    }
  };

  const handleChangePassword = async () => {
    if (!vault) return;
    if (!oldPw) return toast.error('Enter the current password');
    if (!changePw) return toast.error('Enter a new password');
    if (changePw !== changeConfirm) return toast.error('New passwords do not match');
    if (changePw.length < 8) return toast.error('New password must be at least 8 characters');
    setChangeBusy(true);
    try {
      await requireRuntimeCapability(createVaultClient(vault), 'encryption').changePassword(
        oldPw,
        changePw,
      );
      setOldPw('');
      setChangePw('');
      setChangeConfirm('');
      toast.success('Password changed');
    } catch (e) {
      toast.error('Failed to change password: ' + e);
    } finally {
      setChangeBusy(false);
    }
  };

  const handleDisable = async () => {
    if (!vault) return;
    if (!disablePw) return toast.error('Enter the current password to confirm');
    setDisableBusy(true);
    try {
      await requireRuntimeCapability(createVaultClient(vault), 'encryption').disable(disablePw);
      useVaultStore.setState((s) => ({
        vault: s.vault ? { ...s.vault, isEncrypted: false } : s.vault,
      }));
      setDisablePw('');
      toast.success('Vault encryption disabled');
    } catch (e) {
      toast.error('Failed to disable encryption: ' + e);
    } finally {
      setDisableBusy(false);
    }
  };

  if (!vault) {
    return (
      <div className="flex-1 flex items-center justify-center text-muted-foreground text-sm">
        No vault open
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-5 h-full overflow-y-auto pr-1">
      {/* Status banner */}
      <div
        className={cn(
          'flex items-center gap-2.5 px-3 py-2.5 rounded-lg border text-sm font-medium',
          isEncrypted
            ? 'bg-emerald-500/10 border-emerald-500/25 text-emerald-400'
            : 'bg-muted/40 border-border/50 text-muted-foreground',
        )}
      >
        {isEncrypted ? <Lock size={14} /> : <LockOpen size={14} />}
        {isEncrypted
          ? 'This vault is encrypted at rest (AES-256-GCM · Argon2id)'
          : 'This vault is not encrypted — files are stored in plaintext'}
      </div>

      {!isEncrypted && (
        /* ── Enable encryption ─────────────────────────────────────────────── */
        <div className="space-y-3">
          <p className="text-[11px] font-semibold text-muted-foreground uppercase tracking-widest">
            Enable Encryption
          </p>
          <p className="text-[12px] text-muted-foreground leading-relaxed">
            All note files will be encrypted with AES-256-GCM. The key is derived from your password
            using Argon2id — without the correct password the files cannot be read.{' '}
            <span className="text-foreground/70 font-medium">
              There is no recovery if you lose the password.
            </span>
          </p>
          <PasswordField label="New Password" value={newPw} onChange={setNewPw} />
          <PasswordField label="Confirm Password" value={confirmPw} onChange={setConfirmPw} />
          <Button
            size="sm"
            onClick={handleEnable}
            disabled={enableBusy || !newPw || !confirmPw}
            className="gap-1.5 w-full"
          >
            <Lock size={13} />
            {enableBusy ? 'Encrypting…' : 'Enable Encryption'}
          </Button>
        </div>
      )}

      {isEncrypted && (
        <>
          {/* ── Change password ───────────────────────────────────────────── */}
          <div className="space-y-3">
            <p className="text-[11px] font-semibold text-muted-foreground uppercase tracking-widest">
              Change Password
            </p>
            <PasswordField label="Current Password" value={oldPw} onChange={setOldPw} />
            <PasswordField label="New Password" value={changePw} onChange={setChangePw} />
            <PasswordField
              label="Confirm New Password"
              value={changeConfirm}
              onChange={setChangeConfirm}
            />
            <Button
              size="sm"
              variant="outline"
              onClick={handleChangePassword}
              disabled={changeBusy || !oldPw || !changePw || !changeConfirm}
              className="gap-1.5"
            >
              <Check size={13} />
              {changeBusy ? 'Re-encrypting…' : 'Change Password'}
            </Button>
          </div>

          {/* ── Disable encryption ────────────────────────────────────────── */}
          <div className="space-y-3 pt-3 border-t border-border/40">
            <p className="text-[11px] font-semibold text-destructive/70 uppercase tracking-widest">
              Danger Zone
            </p>
            <p className="text-[12px] text-muted-foreground">
              Decrypts all files and removes the encryption header. Files will be stored in
              plaintext.
            </p>
            <PasswordField label="Current Password" value={disablePw} onChange={setDisablePw} />
            <Button
              size="sm"
              variant="destructive"
              onClick={handleDisable}
              disabled={disableBusy || !disablePw}
              className="gap-1.5"
            >
              <LockOpen size={13} />
              {disableBusy ? 'Decrypting…' : 'Disable Encryption'}
            </Button>
          </div>
        </>
      )}
    </div>
  );
}

// ─── Tab list ─────────────────────────────────────────────────────────────────

type Tab = 'vaults' | 'permissions' | 'offline' | 'encryption';

const ALL_TABS: Record<Tab, { id: Tab; label: string; icon: React.ReactNode }> = {
  vaults: { id: 'vaults', label: 'Vaults', icon: <Vault size={14} /> },
  permissions: { id: 'permissions', label: 'Permissions', icon: <ShieldCheck size={14} /> },
  offline: { id: 'offline', label: 'Offline Sync', icon: <HardDriveDownload size={14} /> },
  encryption: { id: 'encryption', label: 'Encryption', icon: <Lock size={14} /> },
};

export function vaultManagerTabIds(kind: VaultKind): Tab[] {
  return kind === 'hosted' ? ['vaults', 'permissions', 'offline'] : ['vaults', 'encryption'];
}

export default function VaultManagerModal() {
  const { isVaultManagerOpen, closeVaultManager } = useUiStore();
  const { vault, closeVault, removeRecentVault } = useVaultStore();
  const [tab, setTab] = useState<Tab>('vaults');
  const [removeTarget, setRemoveTarget] = useState<VaultMeta | null>(null);
  const kind = vault ? vaultKind(vault) : 'local';
  const tabs = vaultManagerTabIds(kind).map((id) => ALL_TABS[id]);

  useEffect(() => {
    if (!vaultManagerTabIds(kind).includes(tab)) setTab('vaults');
  }, [kind, tab]);

  const confirmRemoveVault = async () => {
    if (!removeTarget) return;
    const isCurrent = vault?.path === removeTarget.path;
    try {
      if (isCurrent) {
        closeVault();
      }
      await removeRecentVault(removeTarget.path);
      toast.success(
        isCurrent
          ? `Closed and removed "${removeTarget.name}" from recents`
          : `Removed "${removeTarget.name}" from recents`,
      );
    } catch (error) {
      toast.error(`Failed to remove vault: ${error}`);
    } finally {
      setRemoveTarget(null);
    }
  };

  return (
    <>
      <Dialog
        open={!!removeTarget}
        onOpenChange={(open) => {
          if (!open) setRemoveTarget(null);
        }}
      >
        <DialogContent showCloseButton={false} className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Remove vault from recents?</DialogTitle>
            <DialogDescription>
              {removeTarget && vault?.path === removeTarget.path
                ? `"${removeTarget.name}" is currently open. Removing it from recents will also close the active vault.`
                : `This removes "${removeTarget?.name ?? ''}" from the recent vaults list.`}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="border-none bg-transparent -mx-0 -mb-0 px-0 pb-0">
            <Button variant="outline" onClick={() => setRemoveTarget(null)}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={() => void confirmRemoveVault()}>
              Remove
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={isVaultManagerOpen} onOpenChange={(open) => !open && closeVaultManager()}>
        <DialogContent className="sm:max-w-3xl w-full p-0 overflow-hidden glass-strong border-border/40 shadow-2xl shadow-black/60 gap-0">
          <DialogHeader className="px-5 pt-5 pb-0">
            <DialogTitle className="flex items-center gap-2 text-base font-semibold">
              <Vault size={16} className="text-primary" />
              Vault Manager
            </DialogTitle>
          </DialogHeader>

          <div className="flex h-[520px]">
            {/* Tab sidebar */}
            <nav className="w-44 shrink-0 border-r border-border/40 p-2 flex flex-col gap-0.5">
              {tabs.map(({ id, label, icon }) => (
                <button
                  key={id}
                  onClick={() => setTab(id)}
                  className={cn(
                    'flex items-center gap-2.5 px-3 py-2 rounded-md text-sm transition-all text-left',
                    tab === id
                      ? 'bg-primary/15 text-primary font-medium'
                      : 'text-muted-foreground hover:text-foreground hover:bg-accent/50',
                  )}
                >
                  {icon}
                  {label}
                </button>
              ))}
            </nav>

            {/* Tab content */}
            <div className="flex-1 min-w-0 overflow-y-auto p-5 flex flex-col">
              {tab === 'vaults' && (
                <VaultsTab onClose={closeVaultManager} onRequestRemove={setRemoveTarget} />
              )}
              {tab === 'permissions' && <HostedPermissionsTab />}
              {tab === 'offline' && <OfflineSyncTab />}
              {tab === 'encryption' && <EncryptionTab />}
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
