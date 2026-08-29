import { useCallback, useEffect, useMemo, useState } from 'react';

import { Loader2, ShieldCheck, SlidersHorizontal, Trash2, UserPlus } from 'lucide-react';
import { toast } from 'sonner';

import {
  CAPABILITY_GROUPS,
  capabilityLabel,
  MANAGEMENT_CAPABILITIES,
  sortCapabilityTokens,
} from '../../lib/capabilities';
import { useCollabIdentity } from '../../lib/collabIdentity';
import { createVaultClient, type VaultMembersCapability } from '../../lib/vaultClient';
import { useServerStore } from '../../store/serverStore';
import { useVaultStore } from '../../store/vaultStore';
import {
  type HostedVaultMember,
  type MemberRole,
  type PermissionTemplate,
  type UserDirectoryEntry,
  vaultCan,
  vaultKind,
} from '../../types/vault';
import { Button } from '../ui/button';
import { Checkbox } from '../ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../ui/dialog';
import { Input } from '../ui/input';
import { ScrollArea } from '../ui/scroll-area';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select';

const ROLE_OPTIONS: { value: MemberRole; label: string; hint: string }[] = [
  { value: 'viewer', label: 'Viewer', hint: 'Read-only access' },
  { value: 'editor', label: 'Editor', hint: 'Read and write content' },
  { value: 'admin', label: 'Admin', hint: 'Manage content and members' },
];

/** The capability set a plain role confers, mirroring `capabilities_for_role`. */
const ROLE_DEFAULT_CAPABILITIES: Record<MemberRole, string[]> = {
  viewer: ['vault.read', 'vault.search', 'vault.viewHistory', 'vault.viewActivity'],
  editor: [
    'vault.read',
    'vault.search',
    'vault.viewHistory',
    'vault.viewActivity',
    'file.create',
    'file.write',
    'file.move',
    'file.delete',
    'file.uploadAsset',
    'kanban.card.create',
    'kanban.card.editContent',
    'kanban.card.move',
    'kanban.card.comment',
    'kanban.card.delete',
    'kanban.card.archive',
    'kanban.column.manage',
    'pdf.comment',
    'pdf.annotate',
    'note.edit',
    'canvas.edit',
  ],
  admin: CAPABILITY_GROUPS.flatMap((group) =>
    group.capabilities.map((capability) => capability.token),
  ),
};

function initials(displayName: string): string {
  const parts = displayName.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

function RoleSelect({
  value,
  disabled,
  onChange,
}: {
  value: MemberRole;
  disabled?: boolean;
  onChange: (role: MemberRole) => void;
}) {
  return (
    <Select
      value={value}
      disabled={disabled}
      onValueChange={(next) => onChange(next as MemberRole)}
    >
      <SelectTrigger className="h-8 w-28 text-xs">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {ROLE_OPTIONS.map((option) => (
          <SelectItem key={option.value} value={option.value} className="text-xs">
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/** Renders a member's effective capabilities, summarized when the list is long. */
function CapabilityBadges({ member }: { member: HostedVaultMember }) {
  const tokens = member.owner
    ? ['Full access']
    : (member.capabilities ?? ROLE_DEFAULT_CAPABILITIES[member.role]);
  const source = member.owner
    ? null
    : member.templateName
      ? `Template: ${member.templateName}`
      : member.customCapabilities
        ? 'Custom'
        : `Role: ${member.role}`;
  const labels = member.owner ? ['Full access'] : tokens.map(capabilityLabel);
  const shown = labels.slice(0, 6);
  const extra = labels.length - shown.length;
  return (
    <div className="mt-1 flex flex-wrap items-center gap-1">
      {source && (
        <span className="rounded-full border border-primary/25 bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium text-primary">
          {source}
        </span>
      )}
      {shown.map((label) => (
        <span
          key={label}
          className="rounded-full border border-border/60 bg-muted/35 px-1.5 py-0.5 text-[10px] text-muted-foreground"
        >
          {label}
        </span>
      ))}
      {extra > 0 && (
        <span className="rounded-full border border-border/60 bg-muted/35 px-1.5 py-0.5 text-[10px] text-muted-foreground">
          +{extra} more
        </span>
      )}
    </div>
  );
}

type EditorMode = 'role' | 'template' | 'custom';

/**
 * Fine-grained permission editor for a single member. Lets a permission manager
 * pick the role default, a named template, or a custom capability set. When the
 * editor targets the current user, the two management capabilities stay locked on
 * so an admin cannot strip their own administrative permissions.
 */
function PermissionEditorDialog({
  member,
  members,
  isSelf,
  onClose,
  onSaved,
}: {
  member: HostedVaultMember;
  members: VaultMembersCapability;
  isSelf: boolean;
  onClose: () => void;
  onSaved: (updated: HostedVaultMember, wasSelf: boolean) => void;
}) {
  const initialMode: EditorMode = member.templateId
    ? 'template'
    : member.customCapabilities
      ? 'custom'
      : 'role';
  const [mode, setMode] = useState<EditorMode>(initialMode);
  const [templates, setTemplates] = useState<PermissionTemplate[] | null>(null);
  const [templateId, setTemplateId] = useState<string | null>(member.templateId ?? null);
  const [selected, setSelected] = useState<Set<string>>(
    () =>
      new Set(
        member.customCapabilities ?? member.capabilities ?? ROLE_DEFAULT_CAPABILITIES[member.role],
      ),
  );
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    members
      .listTemplates()
      .then((list) => {
        if (!cancelled) setTemplates(list);
      })
      .catch(() => {
        if (!cancelled) setTemplates([]);
      });
    return () => {
      cancelled = true;
    };
  }, [members]);

  const toggle = (token: string) => {
    // Self-lockout guard: the management capabilities cannot be removed from
    // yourself (mirrors the server-side guard).
    if (
      isSelf &&
      MANAGEMENT_CAPABILITIES.includes(token as (typeof MANAGEMENT_CAPABILITIES)[number])
    ) {
      return;
    }
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(token)) next.delete(token);
      else next.add(token);
      return next;
    });
  };

  // For the role/template modes, the resulting capability set is what those
  // grants confer; used to validate the self-lockout guard before saving.
  const resultingTokens = useMemo<string[]>(() => {
    if (mode === 'role') return ROLE_DEFAULT_CAPABILITIES[member.role];
    if (mode === 'template') {
      return templates?.find((template) => template.id === templateId)?.capabilities ?? [];
    }
    return sortCapabilityTokens(selected);
  }, [mode, member.role, templates, templateId, selected]);

  const selfLockoutBlocked =
    isSelf && !MANAGEMENT_CAPABILITIES.every((token) => resultingTokens.includes(token));

  const handleSave = async () => {
    if (selfLockoutBlocked) return;
    setSaving(true);
    try {
      let updated: HostedVaultMember;
      if (mode === 'role') {
        updated = await members.resetToRoleDefault(member.userId);
      } else if (mode === 'template') {
        if (!templateId) throw new Error('Select a template to assign.');
        updated = await members.setTemplate(member.userId, templateId);
      } else {
        updated = await members.setCapabilities(member.userId, sortCapabilityTokens(selected));
      }
      onSaved(updated, isSelf);
    } catch (e) {
      toast.error(`Failed to update permissions: ${e}`);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Permissions — {member.displayName}</DialogTitle>
          <DialogDescription>
            Choose how this member&apos;s capabilities are granted. The server enforces the
            effective capability tokens on every request.
          </DialogDescription>
        </DialogHeader>

        <div className="flex gap-1.5">
          {(
            [
              ['role', 'Role default'],
              ['template', 'Template'],
              ['custom', 'Custom'],
            ] as [EditorMode, string][]
          ).map(([value, label]) => (
            <Button
              key={value}
              type="button"
              size="sm"
              variant={mode === value ? 'default' : 'outline'}
              className="h-8 flex-1 text-xs"
              onClick={() => setMode(value)}
            >
              {label}
            </Button>
          ))}
        </div>

        {mode === 'role' && (
          <p className="rounded-md border border-border/50 bg-muted/20 p-3 text-xs text-muted-foreground">
            Uses the built-in capability set for the member&apos;s <b>{member.role}</b> role. Any
            custom override or template assignment is cleared.
          </p>
        )}

        {mode === 'template' && (
          <div className="space-y-2">
            {templates === null ? (
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Loader2 size={14} className="animate-spin" /> Loading templates…
              </div>
            ) : templates.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                No permission templates are available.
              </p>
            ) : (
              <Select value={templateId ?? ''} onValueChange={(value) => setTemplateId(value)}>
                <SelectTrigger className="h-9 text-sm">
                  <SelectValue placeholder="Select a template…" />
                </SelectTrigger>
                <SelectContent>
                  {templates.map((template) => (
                    <SelectItem key={template.id} value={template.id} className="text-sm">
                      {template.name}
                      {template.isBuiltin ? ' (built-in)' : ''}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
            {selfLockoutBlocked && (
              <p className="text-xs text-destructive">
                This template would remove your own management permissions.
              </p>
            )}
          </div>
        )}

        {mode === 'custom' && (
          <ScrollArea className="max-h-72 rounded-md border border-border/50 p-2">
            <div className="space-y-3">
              {CAPABILITY_GROUPS.map((group) => (
                <div key={group.domain}>
                  <p className="mb-1 text-[11px] font-semibold uppercase tracking-widest text-muted-foreground">
                    {group.domain}
                  </p>
                  <div className="grid grid-cols-2 gap-1">
                    {group.capabilities.map((capability) => {
                      const locked =
                        isSelf &&
                        MANAGEMENT_CAPABILITIES.includes(
                          capability.token as (typeof MANAGEMENT_CAPABILITIES)[number],
                        );
                      return (
                        <label
                          key={capability.token}
                          className="flex items-center gap-2 rounded px-1.5 py-1 text-xs hover:bg-accent/40"
                          title={
                            locked
                              ? 'You cannot remove your own management permissions.'
                              : undefined
                          }
                        >
                          <Checkbox
                            checked={selected.has(capability.token)}
                            disabled={locked}
                            onCheckedChange={() => toggle(capability.token)}
                            aria-label={capability.token}
                          />
                          <span className={locked ? 'text-muted-foreground' : ''}>
                            {capability.label}
                          </span>
                        </label>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
          </ScrollArea>
        )}

        <DialogFooter>
          <Button type="button" variant="ghost" size="sm" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button
            type="button"
            size="sm"
            onClick={() => void handleSave()}
            disabled={saving || selfLockoutBlocked || (mode === 'template' && !templateId)}
          >
            {saving && <Loader2 size={13} className="mr-1.5 animate-spin" />}
            Save permissions
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function HostedMembersPanel() {
  const vault = useVaultStore((state) => state.vault);
  const identity = useCollabIdentity();
  const loadHostedVaults = useServerStore((state) => state.loadHostedVaults);
  const members = useMemo<VaultMembersCapability | null>(
    () =>
      vault && vaultKind(vault) === 'hosted'
        ? (createVaultClient(vault).runtime.members ?? null)
        : null,
    [vault],
  );
  const canManageMembers = vaultCan(vault, 'vault.manageMembers');
  const canManagePermissions = vaultCan(vault, 'vault.managePermissions');

  const [list, setList] = useState<HostedVaultMember[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyUserId, setBusyUserId] = useState<string | null>(null);
  const [editing, setEditing] = useState<HostedVaultMember | null>(null);

  const [query, setQuery] = useState('');
  const [results, setResults] = useState<UserDirectoryEntry[]>([]);
  const [selected, setSelected] = useState<UserDirectoryEntry | null>(null);
  const [addRole, setAddRole] = useState<MemberRole>('editor');
  const [adding, setAdding] = useState(false);

  const refresh = useCallback(async () => {
    if (!members) return;
    try {
      setError(null);
      setList(await members.list());
    } catch (e) {
      setError(String(e));
    }
  }, [members]);

  useEffect(() => {
    setList(null);
    void refresh();
  }, [refresh]);

  // Debounced directory search for the add-member typeahead.
  useEffect(() => {
    if (!canManageMembers || !members) return;
    const term = query.trim();
    if (!term) {
      setResults([]);
      return;
    }
    let cancelled = false;
    const handle = window.setTimeout(() => {
      members
        .searchDirectory(term)
        .then((entries) => {
          if (!cancelled) setResults(entries);
        })
        .catch(() => {
          if (!cancelled) setResults([]);
        });
    }, 250);
    return () => {
      cancelled = true;
      window.clearTimeout(handle);
    };
  }, [query, canManageMembers, members]);

  const memberIds = useMemo(() => new Set((list ?? []).map((member) => member.userId)), [list]);

  const handleAdd = async () => {
    if (!canManageMembers || !members || !selected) return;
    setAdding(true);
    try {
      await members.add(selected.userId, addRole);
      toast.success(`Added ${selected.displayName}`);
      setSelected(null);
      setQuery('');
      setResults([]);
      await refresh();
    } catch (e) {
      toast.error(`Failed to add member: ${e}`);
    } finally {
      setAdding(false);
    }
  };

  const handleRemove = async (member: HostedVaultMember) => {
    if (!canManageMembers || !members) return;
    setBusyUserId(member.userId);
    try {
      await members.remove(member.userId);
      toast.success(`Removed ${member.displayName}`);
      await refresh();
    } catch (e) {
      toast.error(`Failed to remove member: ${e}`);
    } finally {
      setBusyUserId(null);
    }
  };

  const handlePermissionsSaved = async (_updated: HostedVaultMember, wasSelf: boolean) => {
    setEditing(null);
    toast.success('Permissions updated');
    // When the current user's own grant changed, refresh the open vault DTO so
    // capability-gated UI reflects the new permissions immediately.
    if (wasSelf && vault?.kind === 'hosted')
      await loadHostedVaults(vault.serverUrl).catch(() => {});
    await refresh();
  };

  if (!members) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        Connect to the hosted vault server to manage members.
      </div>
    );
  }

  return (
    <div className="flex h-full max-w-[36rem] flex-col gap-4">
      <div className="flex items-center gap-2">
        <div className="flex size-8 items-center justify-center rounded-lg border border-primary/25 bg-primary/10">
          <ShieldCheck size={15} className="text-primary" />
        </div>
        <div>
          <h3 className="text-sm font-medium text-foreground">Members &amp; permissions</h3>
          <p className="text-xs text-muted-foreground">
            Hosted access is server-authoritative. Invites and role changes require{' '}
            <span className="font-mono">vault.manageMembers</span>; fine-grained permissions require{' '}
            <span className="font-mono">vault.managePermissions</span>.
          </p>
        </div>
      </div>

      <div className="rounded-lg border border-border/50 bg-muted/20 p-3 text-xs text-muted-foreground">
        <p className="font-medium text-foreground">Permission grants</p>
        <p className="mt-1">
          A member&apos;s role provides a baseline capability set. Assign a permission template or a
          custom capability set to override that baseline; the server enforces the effective tokens
          on every request.
        </p>
        <p className="mt-1">
          {canManagePermissions
            ? 'You can edit fine-grained permissions for each member below.'
            : 'You do not currently have vault.managePermissions, so fine-grained grants are read-only here.'}
        </p>
      </div>

      {canManageMembers && (
        <div className="rounded-lg border border-border/50 p-3">
          <p className="mb-2 text-[11px] font-semibold uppercase tracking-widest text-muted-foreground">
            Add member
          </p>
          <div className="relative">
            <Input
              value={selected ? `${selected.displayName} (@${selected.username})` : query}
              onChange={(e) => {
                setSelected(null);
                setQuery(e.target.value);
              }}
              placeholder="Search users by name or username…"
              className="h-8 text-sm"
            />
            {!selected && results.length > 0 && (
              <ul className="absolute z-10 mt-1 max-h-48 w-full overflow-y-auto rounded-md border border-border/60 bg-popover shadow-lg">
                {results.map((entry) => {
                  const alreadyMember = memberIds.has(entry.userId);
                  return (
                    <li key={entry.userId}>
                      <button
                        type="button"
                        disabled={alreadyMember}
                        onClick={() => {
                          setSelected(entry);
                          setResults([]);
                        }}
                        className="flex w-full items-center justify-between gap-2 px-3 py-1.5 text-left text-sm hover:bg-accent/60 disabled:opacity-50"
                      >
                        <span className="truncate">
                          {entry.displayName}{' '}
                          <span className="text-muted-foreground">@{entry.username}</span>
                        </span>
                        {alreadyMember && (
                          <span className="text-[10px] text-muted-foreground">member</span>
                        )}
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
          <div className="mt-2 flex items-center gap-2">
            <RoleSelect value={addRole} onChange={setAddRole} />
            <Button
              size="sm"
              className="h-8 gap-1.5"
              disabled={!selected || adding}
              onClick={() => void handleAdd()}
            >
              {adding ? <Loader2 size={13} className="animate-spin" /> : <UserPlus size={13} />}
              Add
            </Button>
          </div>
        </div>
      )}

      {error && <p className="text-xs text-destructive">{error}</p>}

      <div className="min-h-0 flex-1 overflow-y-auto">
        {list === null ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 size={14} className="animate-spin" /> Loading members…
          </div>
        ) : list.length === 0 ? (
          <p className="text-sm text-muted-foreground">No members yet.</p>
        ) : (
          <ul className="flex flex-col gap-1">
            {list.map((member) => (
              <li
                key={member.userId}
                className="flex items-center gap-3 rounded-md border border-border/40 px-3 py-2"
              >
                <div className="flex size-8 shrink-0 items-center justify-center rounded-full bg-accent/60 text-[11px] font-semibold">
                  {initials(member.displayName)}
                </div>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-foreground">
                    {member.displayName}
                    {member.userId === identity.userId && (
                      <span className="ml-1 text-[10px] text-muted-foreground">(you)</span>
                    )}
                  </p>
                  <p className="truncate text-xs text-muted-foreground">@{member.username}</p>
                  <CapabilityBadges member={member} />
                </div>
                {member.owner ? (
                  <span className="rounded-full border border-primary/30 bg-primary/10 px-2.5 py-1 text-[11px] font-medium text-primary">
                    Owner
                  </span>
                ) : (
                  <>
                    {canManagePermissions && (
                      <Button
                        variant="ghost"
                        size="icon"
                        className="size-8 text-muted-foreground hover:text-foreground"
                        disabled={busyUserId === member.userId}
                        onClick={() => setEditing(member)}
                        aria-label={`Edit permissions for ${member.displayName}`}
                        title="Edit permissions"
                      >
                        <SlidersHorizontal size={14} />
                      </Button>
                    )}
                    {canManageMembers && (
                      <Button
                        variant="ghost"
                        size="icon"
                        className="size-8 text-muted-foreground hover:text-destructive"
                        disabled={busyUserId === member.userId}
                        onClick={() => void handleRemove(member)}
                        aria-label={`Remove ${member.displayName}`}
                      >
                        <Trash2 size={14} />
                      </Button>
                    )}
                  </>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>

      {editing && (
        <PermissionEditorDialog
          member={editing}
          members={members}
          isSelf={editing.userId === identity.userId}
          onClose={() => setEditing(null)}
          onSaved={(updated, wasSelf) => void handlePermissionsSaved(updated, wasSelf)}
        />
      )}
    </div>
  );
}
