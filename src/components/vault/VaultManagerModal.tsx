import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Vault, FolderOpen, Plus, Download, Upload, Trash2, Pencil,
  Check, X, ChevronRight, Clock, ShieldCheck, Lock, LockOpen, Eye, EyeOff,
  Crown, Shield, UserPlus,
} from 'lucide-react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '../ui/dialog';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../ui/select';
import { cn } from '../../lib/utils';
import { useVaultStore } from '../../store/vaultStore';
import { useUiStore } from '../../store/uiStore';
import { useCollabStore } from '../../store/collabStore';
import { tauriCommands } from '../../lib/tauri';
import { createCollabTransport } from '../../lib/collabTransport';
import type { VaultMeta, VaultConfig, MemberRole } from '../../types/vault';
import { toast } from 'sonner';

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

const ROLE_LABELS: Record<MemberRole, string> = {
  viewer: 'Viewer',
  editor: 'Editor',
  admin: 'Admin',
};

// ─── Create Vault Form ────────────────────────────────────────────────────────

function CreateVaultForm({ onDone }: { onDone: () => void }) {
  const { openVault } = useVaultStore();
  const [name, setName] = useState('');
  const [path, setPath] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { inputRef.current?.focus(); }, []);

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
        onKeyDown={(e) => { if (e.key === 'Enter') create(); if (e.key === 'Escape') onDone(); }}
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
        <Button variant="ghost" size="sm" onClick={onDone} disabled={busy}>Cancel</Button>
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
  onExport: () => void;
  onRenameComplete: (newName: string) => void;
}

function VaultRow({ meta, isCurrent, onOpen, onRemove, onExport, onRenameComplete }: VaultRowProps) {
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
        'group flex max-w-[min(100%,42rem)] items-center gap-3 px-3 py-3 rounded-lg border transition-all app-motion-base',
        isCurrent
          ? 'border-primary/30 bg-primary/6'
          : 'border-transparent hover:border-border/50 hover:bg-accent/30',
      )}
    >
      {/* Vault icon */}
      <div className={cn(
        'w-8 h-8 rounded-md flex items-center justify-center shrink-0 border',
        isCurrent ? 'bg-primary/15 border-primary/25' : 'bg-muted/40 border-border/40',
      )}>
        <Vault size={14} className={isCurrent ? 'text-primary' : 'text-muted-foreground'} />
      </div>

      {/* Name + path */}
      <div className="flex-1 min-w-0">
        {renaming ? (
          <Input
            ref={renameRef}
            value={renameVal}
            onChange={(e) => setRenameVal(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commitRename();
              if (e.key === 'Escape') { setRenaming(false); setRenameVal(meta.name); }
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
          <span className="min-w-0 flex-1 truncate opacity-70">{meta.path}</span>
          <span className="shrink-0 opacity-50">·</span>
          <span className="shrink-0 flex items-center gap-1">
            <Clock size={9} />
            {formatDate(meta.lastOpened)}
          </span>
        </div>
      </div>

      {/* Actions */}
      <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity app-motion-fast shrink-0">
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
        <button
          onClick={onExport}
          title="Export as ZIP"
          className="w-6 h-6 flex items-center justify-center rounded text-muted-foreground hover:text-foreground hover:bg-accent/60 transition-colors app-motion-fast"
        >
          <Download size={12} />
        </button>
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

// ─── Vaults Tab ───────────────────────────────────────────────────────────────

function VaultsTab({
  onClose,
  onRequestRemove,
}: {
  onClose: () => void;
  onRequestRemove: (meta: VaultMeta) => void;
}) {
  const { vault, recentVaults, openVault, loadRecentVaults } = useVaultStore();
  const [creating, setCreating] = useState(false);
  const [vaults, setVaults] = useState<VaultMeta[]>(recentVaults);

  useEffect(() => {
    loadRecentVaults().then(() => setVaults(useVaultStore.getState().recentVaults));
  }, []);

  // Keep local list in sync with store
  useEffect(() => { setVaults(recentVaults); }, [recentVaults]);

  const handleOpen = async (path: string) => {
    try {
      await openVault(path);
      onClose();
    } catch (e) {
      toast.error('Failed to open vault: ' + e);
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
      const dest = await tauriCommands.showSaveDialog(`${meta.name}.zip`);
      if (!dest) return;
      await tauriCommands.exportVault(meta.path, dest);
      toast.success(`Exported "${meta.name}" to ${dest}`);
    } catch (e) {
      toast.error('Export failed: ' + e);
    }
  };

  const handleRename = async (meta: VaultMeta, newName: string) => {
    try {
      await tauriCommands.renameVault(meta.path, newName);
      setVaults((prev) => prev.map((v) => v.path === meta.path ? { ...v, name: newName } : v));
    } catch (e) {
      toast.error('Rename failed: ' + e);
    }
  };

  return (
    <div className="flex flex-col gap-3 h-full">
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
      <div className="flex-1 overflow-y-auto space-y-2 min-h-0 pr-3">
        {vaults.length === 0 && !creating && (
          <div className="flex flex-col items-center justify-center py-12 gap-2 text-muted-foreground">
            <Vault size={32} className="opacity-20" />
            <p className="text-sm">No vaults yet. Create or import one.</p>
          </div>
        )}
        {vaults.map((meta) => (
          <VaultRow
            key={meta.path}
            meta={meta}
            isCurrent={vault?.path === meta.path}
            onOpen={() => handleOpen(meta.path)}
            onRemove={() => onRequestRemove(meta)}
            onExport={() => handleExport(meta)}
            onRenameComplete={(newName) => handleRename(meta, newName)}
          />
        ))}
      </div>
    </div>
  );
}

// ─── Permissions Tab ──────────────────────────────────────────────────────────

const ROLE_ICONS: Record<MemberRole, React.ReactNode> = {
  viewer: <Eye size={11} />,
  editor: <Shield size={11} />,
  admin:  <Crown size={11} />,
};

function PermissionsTab() {
  const { vault, recentVaults } = useVaultStore();
  const { myUserId } = useCollabStore();
  const [selectedPath, setSelectedPath] = useState<string>(vault?.path ?? '');
  const [config, setConfig] = useState<VaultConfig | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState<string | null>(null); // userId currently being updated
  const transport = useMemo(
    () => (selectedPath ? createCollabTransport(selectedPath) : null),
    [selectedPath],
  );

  const selectedPathRef = useRef(selectedPath);
  useEffect(() => { selectedPathRef.current = selectedPath; }, [selectedPath]);

  const loadConfig = async (path: string) => {
    if (!path) return;
    setLoading(true);
    try {
      const pathTransport = createCollabTransport(path);
      setConfig(await pathTransport.readVaultConfig());
    }
    catch { setConfig(null); }
    finally { setLoading(false); }
  };

  useEffect(() => { loadConfig(selectedPath); }, [selectedPath]);

  // Stay in sync with real-time permission changes from other windows
  useEffect(() => {
    if (!transport) return;
    const unsub = transport.onConfigChanged(() => {
      void transport.readVaultConfig().then(setConfig).catch(() => {});
    });
    return () => { unsub(); };
  }, [transport]);

  const isOwner = config?.owner === myUserId;
  const isAdmin = isOwner || (config?.members?.some((m) => m.userId === myUserId && m.role === 'admin') ?? false);

  const getMember = (userId: string) => config?.members?.find((m) => m.userId === userId);

  const handleSetRole = async (userId: string, role: MemberRole) => {
    if (!selectedPath) return;
    setBusy(userId);
    try {
      const existing = getMember(userId);
      const updated = existing
        ? await tauriCommands.updateMemberRole(selectedPath, myUserId, userId, role)
        : await tauriCommands.inviteMember(selectedPath, myUserId, userId, role);
      setConfig(updated);
    } catch (e) {
      toast.error(String(e));
    } finally {
      setBusy(null);
    }
  };

  const handleRemove = async (userId: string) => {
    if (!selectedPath) return;
    setBusy(userId);
    try {
      setConfig(await tauriCommands.removeMember(selectedPath, myUserId, userId));
    } catch (e) {
      toast.error(String(e));
    } finally {
      setBusy(null);
    }
  };

  const knownUsers = config?.knownUsers ?? [];
  const availableRoles: MemberRole[] = isOwner ? ['viewer', 'editor', 'admin'] : ['viewer', 'editor'];

  return (
    <div className="flex flex-col gap-4 h-full">
      {/* Vault selector */}
      <div className="shrink-0">
        <label className="text-[11px] font-semibold text-muted-foreground uppercase tracking-widest mb-1.5 block">
          Vault
        </label>
        <Select value={selectedPath} onValueChange={setSelectedPath}>
          <SelectTrigger className="w-full h-8 bg-background/60">
            <SelectValue placeholder="Select vault" />
          </SelectTrigger>
          <SelectContent>
            {recentVaults.map((v) => (
              <SelectItem key={v.path} value={v.path}>{v.name}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {loading && (
        <div className="flex-1 flex items-center justify-center text-muted-foreground text-sm">Loading…</div>
      )}

      {!loading && config && (
        <div className="flex-1 overflow-y-auto min-h-0 space-y-4 pr-1">
          {/* Access level notice for non-admins */}
          {!isAdmin && (
            <div className="flex items-center gap-2 px-3 py-2.5 rounded-lg bg-muted/40 border border-border/40 text-xs text-muted-foreground">
              <Shield size={13} className="shrink-0" />
              You have read-only access to this vault's member list. Only admins can change roles.
            </div>
          )}

          {/* User list */}
          <div className="space-y-1">
            {knownUsers.length === 0 ? (
              <p className="text-sm text-muted-foreground py-4 text-center">
                No collaborators have accessed this vault yet.
              </p>
            ) : (
              knownUsers.map((u) => {
                const member = getMember(u.userId);
                const isThisOwner = config.owner === u.userId;
                const isSelf = u.userId === myUserId;
                const isBusy = busy === u.userId;
                const currentRole = member?.role ?? null;

                return (
                  <div key={u.userId} className="flex items-center gap-2.5 px-3 py-2 rounded-lg hover:bg-muted/30">
                    {/* Avatar */}
                    <div
                      className="w-7 h-7 rounded-full flex-shrink-0 flex items-center justify-center text-xs font-semibold text-white"
                      style={{ backgroundColor: u.userColor }}
                    >
                      {u.userName.slice(0, 1).toUpperCase()}
                    </div>

                    {/* Name */}
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-1.5">
                        <span className="text-sm font-medium truncate">{u.userName}</span>
                        {isSelf && <span className="text-[10px] text-muted-foreground">(you)</span>}
                        {isThisOwner && <Crown size={11} className="text-amber-400 shrink-0" />}
                      </div>
                      <p className="text-[10px] text-muted-foreground font-mono truncate">{u.userId.slice(0, 8)}…</p>
                    </div>

                    {/* Controls */}
                    {isThisOwner ? (
                      <span className="text-[10px] px-2 py-0.5 rounded-full bg-amber-500/15 text-amber-400 font-medium">
                        Owner
                      </span>
                    ) : isAdmin ? (
                      <div className="flex items-center gap-1.5">
                        <Select
                          value={currentRole ?? 'none'}
                          onValueChange={(value) => {
                            if (value === 'none') return;
                            handleSetRole(u.userId, value as MemberRole);
                          }}
                          disabled={isBusy || isSelf}
                        >
                          <SelectTrigger className="h-7 min-w-28 text-xs bg-background/60">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {currentRole === null && <SelectItem value="none">No access</SelectItem>}
                            {availableRoles.map((r) => (
                              <SelectItem key={r} value={r}>{ROLE_LABELS[r]}</SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                        {currentRole !== null && !isSelf && (
                          <Button
                            onClick={() => handleRemove(u.userId)}
                            disabled={isBusy}
                            variant="ghost"
                            size="icon"
                            className="size-6 text-muted-foreground hover:text-destructive hover:bg-destructive/10"
                            title="Remove access"
                          >
                            {isBusy ? <span className="w-3 h-3 border border-current border-t-transparent rounded-full animate-spin" /> : <X size={11} />}
                          </Button>
                        )}
                        {currentRole === null && !isSelf && (
                          <Button
                            onClick={() => handleSetRole(u.userId, 'editor')}
                            disabled={isBusy}
                            variant="outline"
                            size="sm"
                            className="h-6 gap-1 px-2 text-[10px] text-primary border-primary/30 hover:bg-primary/10"
                          >
                            <UserPlus size={10} /> Add
                          </Button>
                        )}
                      </div>
                    ) : (
                      /* Read-only role badge for non-admins */
                      currentRole ? (
                        <span className="flex items-center gap-1 text-[10px] px-2 py-0.5 rounded-full border border-border/50 text-muted-foreground">
                          {ROLE_ICONS[currentRole]}
                          {ROLE_LABELS[currentRole]}
                        </span>
                      ) : (
                        <span className="text-[10px] text-muted-foreground">No access</span>
                      )
                    )}
                  </div>
                );
              })
            )}
          </div>

          {/* Role legend */}
          <div className="p-3 rounded-lg bg-muted/30 border border-border/40 text-[12px] text-muted-foreground space-y-1">
            <p><span className="font-medium text-foreground">Viewer</span> — read-only access</p>
            <p><span className="font-medium text-foreground">Editor</span> — can create, edit, and delete notes</p>
            <p><span className="font-medium text-foreground">Admin</span> — full access + manage member roles</p>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Main Modal ───────────────────────────────────────────────────────────────

// ─── Encryption Tab ───────────────────────────────────────────────────────────

function PasswordField({
  label, value, onChange, placeholder,
}: { label: string; value: string; onChange: (v: string) => void; placeholder?: string }) {
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
      await tauriCommands.enableVaultEncryption(vault.path, newPw);
      // Update in-memory vault meta so the UI reflects the change
      useVaultStore.setState((s) => ({
        vault: s.vault ? { ...s.vault, isEncrypted: true } : s.vault,
      }));
      setNewPw(''); setConfirmPw('');
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
      await tauriCommands.changeVaultPassword(vault.path, oldPw, changePw);
      setOldPw(''); setChangePw(''); setChangeConfirm('');
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
      await tauriCommands.disableVaultEncryption(vault.path, disablePw);
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
      <div className={cn(
        'flex items-center gap-2.5 px-3 py-2.5 rounded-lg border text-sm font-medium',
        isEncrypted
          ? 'bg-emerald-500/10 border-emerald-500/25 text-emerald-400'
          : 'bg-muted/40 border-border/50 text-muted-foreground',
      )}>
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
            All note files will be encrypted with AES-256-GCM. The key is derived
            from your password using Argon2id — without the correct password the
            files cannot be read. <span className="text-foreground/70 font-medium">There is no recovery if you lose the password.</span>
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
            <PasswordField label="Confirm New Password" value={changeConfirm} onChange={setChangeConfirm} />
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
              Decrypts all files and removes the encryption header. Files will be stored in plaintext.
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

type Tab = 'vaults' | 'permissions' | 'encryption';

const TABS: { id: Tab; label: string; icon: React.ReactNode }[] = [
  { id: 'vaults',      label: 'Vaults',      icon: <Vault size={14} /> },
  { id: 'permissions', label: 'Permissions',  icon: <ShieldCheck size={14} /> },
  { id: 'encryption',  label: 'Encryption',   icon: <Lock size={14} /> },
];

export default function VaultManagerModal() {
  const { isVaultManagerOpen, closeVaultManager } = useUiStore();
  const { vault, closeVault, removeRecentVault } = useVaultStore();
  const [tab, setTab] = useState<Tab>('vaults');
  const [removeTarget, setRemoveTarget] = useState<VaultMeta | null>(null);

  const confirmRemoveVault = async () => {
    if (!removeTarget) return;
    const isCurrent = vault?.path === removeTarget.path;
    try {
      if (isCurrent) {
        closeVault();
      }
      await removeRecentVault(removeTarget.path);
      toast.success(isCurrent ? `Closed and removed "${removeTarget.name}" from recents` : `Removed "${removeTarget.name}" from recents`);
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
      onOpenChange={(open) => { if (!open) setRemoveTarget(null); }}
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
          <Button variant="outline" onClick={() => setRemoveTarget(null)}>Cancel</Button>
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
          <nav className="w-48 shrink-0 border-r border-border/40 p-2 flex flex-col gap-0.5">
            {TABS.map(({ id, label, icon }) => (
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
            {tab === 'vaults' && <VaultsTab onClose={closeVaultManager} onRequestRemove={setRemoveTarget} />}
            {tab === 'permissions' && <PermissionsTab />}
            {tab === 'encryption' && <EncryptionTab />}
          </div>
        </div>
      </DialogContent>
    </Dialog>
    </>
  );
}
