import { type KeyboardEvent, type ReactNode, useEffect, useMemo, useRef, useState } from 'react';

import {
  CircleAlert,
  CloudOff,
  Folder,
  FolderOpen,
  MoreHorizontal,
  Plus,
  Search,
  Server,
  X,
} from 'lucide-react';
import { toast } from 'sonner';

import { type KnownServer, listKnownServers } from '../../lib/hostedServers';
import { readHostedVaultLastOpened } from '../../lib/hostedVaultActivity';
import { tauriCommands } from '../../lib/tauri';
import { cn } from '../../lib/utils';
import {
  deleteHostedVaultReplica,
  listHostedVaultReplicas,
  type ReplicaSummary,
} from '../../lib/vaultReplica';
import { useServerStore } from '../../store/serverStore';
import { useVaultStore } from '../../store/vaultStore';
import { hostedVaultMeta } from '../../types/vault';
import { HostedLoginForm } from '../server/HostedLoginForm';
import { ReauthenticateServerDialog } from '../server/ReauthenticateServerDialog';
import { Button } from '../ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '../ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '../ui/dropdown-menu';
import { Input } from '../ui/input';

import { LauncherRail } from './launcher/LauncherRail';
import { NewVaultDialog, type NewVaultLocation } from './launcher/NewVaultDialog';
import { ServerDetailsDialog } from './launcher/ServerDetailsDialog';
import {
  buildServerEntries,
  buildVaultEntries,
  filterVaultEntries,
  formatLastOpened,
  replicaToHostedVaultMeta,
  type ServerEntry,
  type VaultEntry,
  type VaultEntryKind,
  type VaultKindFilter,
} from './launcher/vaultEntries';

const KIND_FILTERS: { id: VaultKindFilter; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'local', label: 'This device' },
  { id: 'hosted', label: 'Hosted' },
  { id: 'offline', label: 'Offline copies' },
];

const RECENT_CARD_COUNT = 3;

/**
 * The start screen shown while no vault is open: a navigation rail (vaults,
 * chats, databases, servers) beside one searchable list of every vault the user
 * can open, whatever its kind.
 */
export default function VaultPicker() {
  const {
    openVault,
    openHostedVault,
    loadRecentVaults,
    removeRecentVault,
    recentVaults,
    isLoading,
  } = useVaultStore();
  const connections = useServerStore((state) => state.connections);
  const isServerLoading = useServerStore((state) => state.isLoading);
  const serverError = useServerStore((state) => state.error);
  const refreshAll = useServerStore((state) => state.refreshAll);

  const [replicas, setReplicas] = useState<ReplicaSummary[]>([]);
  const [kindFilter, setKindFilter] = useState<VaultKindFilter>('all');
  const [serverFilter, setServerFilter] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const [searchFocused, setSearchFocused] = useState(false);
  const [bannerDismissed, setBannerDismissed] = useState(false);
  const [newVault, setNewVault] = useState<{ open: boolean; location: NewVaultLocation }>({
    open: false,
    location: 'local',
  });
  const [detailsServerUrl, setDetailsServerUrl] = useState<string | null>(null);
  const [reauthServer, setReauthServer] = useState<KnownServer | null>(null);
  const [showAddServer, setShowAddServer] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);

  const refreshReplicas = () => {
    listHostedVaultReplicas()
      .then(setReplicas)
      .catch(() => setReplicas([]));
  };

  useEffect(() => {
    loadRecentVaults();
    refreshAll().catch(() => {});
    refreshReplicas();
  }, []);

  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        searchRef.current?.focus();
        searchRef.current?.select();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  const entries = useMemo(
    () =>
      buildVaultEntries({
        recentVaults,
        connections,
        replicas,
        // Re-read whenever the inputs change; the record is tiny.
        hostedLastOpened: readHostedVaultLastOpened(),
      }),
    [recentVaults, connections, replicas],
  );
  const servers = useMemo(
    () => buildServerEntries({ connections, knownServers: listKnownServers(), entries }),
    [connections, entries],
  );
  const activeServerFilter =
    serverFilter && servers.some((server) => server.serverUrl === serverFilter)
      ? serverFilter
      : null;
  const scoped = useMemo(
    () => filterVaultEntries(entries, { kind: 'all', serverUrl: activeServerFilter, query: '' }),
    [entries, activeServerFilter],
  );
  const visible = useMemo(
    () => filterVaultEntries(entries, { kind: kindFilter, serverUrl: activeServerFilter, query }),
    [entries, kindFilter, activeServerFilter, query],
  );
  const recent = useMemo(
    () => entries.filter((entry) => entry.lastOpened !== null).slice(0, RECENT_CARD_COUNT),
    [entries],
  );
  const signedOut = servers.filter((server) => server.state === 'signed-out' && server.known);
  const detailsServer = servers.find((server) => server.serverUrl === detailsServerUrl) ?? null;
  const isFirstRun = entries.length === 0 && servers.length === 0;
  const showRecent =
    recent.length > 0 && kindFilter === 'all' && !activeServerFilter && !query.trim();

  useEffect(() => {
    setActiveIndex(0);
  }, [kindFilter, activeServerFilter, query]);

  const openEntry = async (entry: VaultEntry) => {
    try {
      if (entry.kind === 'local' && entry.local) await openVault(entry.local.path);
      else if (entry.kind === 'hosted' && entry.hosted && entry.serverUrl)
        await openHostedVault(hostedVaultMeta(entry.serverUrl, entry.hosted));
      else if (entry.replica) await openHostedVault(replicaToHostedVaultMeta(entry.replica));
    } catch (reason) {
      toast.error(`Failed to open "${entry.name}": ${reason}`);
    }
  };

  const removeOfflineCopy = async (replica: ReplicaSummary) => {
    const pendingText =
      replica.pendingCount > 0
        ? `\n\nThis offline copy has ${replica.pendingCount} pending local change${replica.pendingCount === 1 ? '' : 's'} that will be discarded.`
        : '';
    if (
      !window.confirm(
        `Remove the offline copy of "${replica.vaultName}" from ${replica.serverUrl}?${pendingText}`,
      )
    )
      return;
    try {
      await deleteHostedVaultReplica(replica);
      refreshReplicas();
      toast.success(`Removed offline copy "${replica.vaultName}"`);
    } catch (reason) {
      toast.error(`Could not remove offline copy: ${reason}`);
    }
  };

  const removeFromList = async (entry: VaultEntry) => {
    if (!entry.local) return;
    try {
      await removeRecentVault(entry.local.path);
    } catch (reason) {
      toast.error(`Could not remove "${entry.name}" from the list: ${reason}`);
    }
  };

  const openFolder = async () => {
    try {
      const path = await tauriCommands.showOpenVaultDialog();
      if (path) await openVault(path);
    } catch (reason) {
      toast.error(`Failed to open vault: ${reason}`);
    }
  };

  const signIn = (server: ServerEntry) => {
    if (server.known) setReauthServer(server.known);
  };

  const toggleServerFilter = (serverUrl: string) =>
    setServerFilter((current) => (current === serverUrl ? null : serverUrl));

  const onSearchKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setActiveIndex((index) => Math.min(index + 1, Math.max(visible.length - 1, 0)));
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActiveIndex((index) => Math.max(index - 1, 0));
    } else if (event.key === 'Enter') {
      const entry = visible[activeIndex];
      if (entry) {
        event.preventDefault();
        void openEntry(entry);
      }
    } else if (event.key === 'Escape' && query) {
      event.preventDefault();
      setQuery('');
    }
  };

  const kindCounts: Record<VaultKindFilter, number> = {
    all: scoped.length,
    local: scoped.filter((entry) => entry.kind === 'local').length,
    hosted: scoped.filter((entry) => entry.kind === 'hosted').length,
    offline: scoped.filter((entry) => entry.kind === 'offline').length,
  };

  return (
    <div className="vault-bg flex h-screen min-h-0 flex-col overflow-hidden text-foreground md:flex-row">
      <LauncherRail
        current="vaults"
        serverPanel={{
          servers,
          serverFilter: activeServerFilter,
          onToggleServer: toggleServerFilter,
          onServerDetails: (server) => setDetailsServerUrl(server.serverUrl),
          onAddServer: () => setShowAddServer(true),
        }}
      />

      <main className="flex min-h-0 min-w-0 flex-1 flex-col gap-5 overflow-y-auto px-4 py-5 sm:px-6 md:px-9 md:py-7">
        <header className="flex flex-wrap items-center gap-2.5 app-fade-slide-in">
          <h1 className="mr-auto text-xl font-semibold tracking-tight">Vaults</h1>
          {!isFirstRun && (
            <label className="relative flex min-w-48 flex-[0_1_20rem] items-center">
              <span className="sr-only">Search vaults</span>
              <Search
                size={14}
                className="pointer-events-none absolute left-2.5 text-muted-foreground"
                aria-hidden="true"
              />
              <Input
                ref={searchRef}
                type="search"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                onKeyDown={onSearchKeyDown}
                onFocus={() => setSearchFocused(true)}
                onBlur={() => setSearchFocused(false)}
                placeholder="Search vaults and servers"
                className="h-9 pr-14 pl-8"
                aria-controls="vault-list"
              />
              <kbd
                aria-hidden="true"
                className="pointer-events-none absolute right-2 rounded border border-border px-1 font-mono text-[10px] text-muted-foreground"
              >
                Ctrl K
              </kbd>
            </label>
          )}
          <Button variant="outline" size="lg" onClick={openFolder} disabled={isLoading}>
            <FolderOpen />
            Open folder
          </Button>
          <Button
            size="lg"
            onClick={() => setNewVault({ open: true, location: 'local' })}
            disabled={isLoading}
          >
            <Plus />
            New vault
          </Button>
        </header>

        {signedOut.length > 0 && !bannerDismissed && (
          <SignedOutBanner
            servers={signedOut}
            onSignIn={signIn}
            onDismiss={() => setBannerDismissed(true)}
          />
        )}
        {serverError && <p className="text-xs text-destructive">{serverError}</p>}

        {isFirstRun ? (
          <FirstRun
            onCreate={() => setNewVault({ open: true, location: 'local' })}
            onOpenFolder={openFolder}
            onConnect={() => setShowAddServer(true)}
          />
        ) : (
          <>
            {showRecent && (
              <section aria-labelledby="recent-vaults-heading" className="grid gap-2.5">
                <SectionHeading id="recent-vaults-heading">Jump back in</SectionHeading>
                <div className="grid grid-cols-[repeat(auto-fill,minmax(13rem,1fr))] gap-3">
                  {recent.map((entry) => (
                    <button
                      key={entry.key}
                      type="button"
                      onClick={() => openEntry(entry)}
                      disabled={isLoading}
                      className="flex flex-col items-start gap-3 rounded-xl border border-border/70 bg-card/60 px-4 py-3.5 text-left transition-colors app-motion-base outline-none hover:border-primary/40 hover:bg-primary/5 focus-visible:ring-3 focus-visible:ring-ring/50"
                    >
                      <span className="flex w-full items-center justify-between">
                        <KindIcon kind={entry.kind} size="lg" />
                        <span className="text-xs text-muted-foreground">
                          {formatLastOpened(entry.lastOpened)}
                        </span>
                      </span>
                      <span className="w-full min-w-0">
                        <span className="block truncate text-[15px] font-semibold">
                          {entry.name}
                        </span>
                        <span className="block truncate text-xs text-muted-foreground">
                          {entry.location}
                        </span>
                      </span>
                    </button>
                  ))}
                </div>
              </section>
            )}

            <section
              aria-labelledby="all-vaults-heading"
              className="flex min-h-48 flex-1 flex-col gap-2.5"
            >
              <div className="flex flex-wrap items-center gap-2">
                <SectionHeading id="all-vaults-heading" className="mr-2">
                  All vaults
                </SectionHeading>
                {KIND_FILTERS.map((filter) => (
                  <button
                    key={filter.id}
                    type="button"
                    aria-pressed={kindFilter === filter.id}
                    onClick={() => setKindFilter(filter.id)}
                    className={cn(
                      'h-7 rounded-full border px-3 text-xs transition-colors app-motion-base outline-none focus-visible:ring-3 focus-visible:ring-ring/50',
                      kindFilter === filter.id
                        ? 'border-primary/60 bg-primary/15 font-medium text-foreground'
                        : 'border-border text-muted-foreground hover:bg-muted hover:text-foreground',
                    )}
                  >
                    {filter.label}{' '}
                    <span className="text-muted-foreground">{kindCounts[filter.id]}</span>
                  </button>
                ))}
                {activeServerFilter && (
                  <button
                    type="button"
                    onClick={() => setServerFilter(null)}
                    className="ml-auto flex h-7 items-center gap-1.5 rounded-full border border-border bg-card/60 pr-2 pl-3 text-xs outline-none hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50"
                    aria-label={`Clear server filter ${servers.find((s) => s.serverUrl === activeServerFilter)?.host ?? ''}`}
                  >
                    <span className="text-muted-foreground">Server</span>
                    {servers.find((s) => s.serverUrl === activeServerFilter)?.host}
                    <X size={12} aria-hidden="true" />
                  </button>
                )}
              </div>

              {/* The list scrolls inside its card so the header and recent cards stay in view. */}
              <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-border/70 bg-card/40">
                <div
                  aria-hidden="true"
                  className="hidden grid-cols-[minmax(0,2.2fr)_minmax(0,1.6fr)_minmax(0,1.2fr)_7rem_2rem] gap-4 px-5 pt-3 pb-1.5 text-[11px] font-semibold tracking-wider text-muted-foreground uppercase lg:grid"
                >
                  <span>Name</span>
                  <span>Location</span>
                  <span>Access</span>
                  <span>Opened</span>
                  <span />
                </div>
                <ul
                  id="vault-list"
                  aria-label="Vaults"
                  className="grid min-h-0 flex-1 content-start gap-0.5 overflow-y-auto overscroll-contain p-1.5"
                >
                  {visible.map((entry, index) => (
                    <VaultRow
                      key={entry.key}
                      entry={entry}
                      highlighted={searchFocused && index === activeIndex}
                      disabled={isLoading || (entry.kind === 'hosted' && isServerLoading)}
                      onOpen={() => openEntry(entry)}
                      onRemoveFromList={() => removeFromList(entry)}
                      onRemoveOfflineCopy={() => entry.replica && removeOfflineCopy(entry.replica)}
                      onServerDetails={() =>
                        entry.serverUrl && setDetailsServerUrl(entry.serverUrl)
                      }
                    />
                  ))}
                </ul>
                {visible.length === 0 && (
                  <p className="px-4 py-9 text-center text-sm text-muted-foreground">
                    {entries.length === 0
                      ? 'No vaults yet. Create one or open a folder.'
                      : 'No vaults match these filters.'}
                  </p>
                )}
              </div>
            </section>

            <footer className="mt-auto hidden flex-wrap gap-4 text-xs text-muted-foreground sm:flex">
              <span>
                <kbd className="font-mono">↑ ↓</kbd> move
              </span>
              <span>
                <kbd className="font-mono">Enter</kbd> open
              </span>
              <span>
                <kbd className="font-mono">Ctrl K</kbd> search
              </span>
              <span className="ml-auto">Local-first · hosted collaboration is optional</span>
            </footer>
          </>
        )}
      </main>

      <NewVaultDialog
        open={newVault.open}
        initialLocation={newVault.location}
        servers={servers}
        onOpenChange={(open) => setNewVault((current) => ({ ...current, open }))}
        onSignIn={signIn}
      />
      <ServerDetailsDialog
        server={detailsServer}
        onOpenChange={(open) => !open && setDetailsServerUrl(null)}
        onSignIn={(server) => {
          setDetailsServerUrl(null);
          signIn(server);
        }}
        onNewVault={(server) => {
          setDetailsServerUrl(null);
          setNewVault({ open: true, location: server.serverUrl });
        }}
      />
      <ReauthenticateServerDialog
        server={reauthServer}
        onOpenChange={(open) => {
          if (!open) setReauthServer(null);
        }}
      />
      <Dialog open={showAddServer} onOpenChange={setShowAddServer}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Connect a Collab server</DialogTitle>
            <DialogDescription>
              Sign in to open hosted vaults, chats and databases.
            </DialogDescription>
          </DialogHeader>
          <HostedLoginForm onConnected={() => setShowAddServer(false)} />
        </DialogContent>
      </Dialog>
    </div>
  );
}

function SectionHeading({
  id,
  className,
  children,
}: {
  id: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <h2
      id={id}
      className={cn(
        'text-xs font-semibold tracking-wider text-muted-foreground uppercase',
        className,
      )}
    >
      {children}
    </h2>
  );
}

function KindIcon({ kind, size = 'sm' }: { kind: VaultEntryKind; size?: 'sm' | 'lg' }) {
  const Icon = kind === 'local' ? Folder : kind === 'hosted' ? Server : CloudOff;
  return (
    <span
      aria-hidden="true"
      className={cn(
        'flex shrink-0 items-center justify-center rounded-md border',
        size === 'lg' ? 'size-8' : 'size-7',
        kind === 'local' && 'border-border bg-muted text-muted-foreground',
        kind === 'hosted' && 'border-primary/20 bg-primary/10 text-primary',
        kind === 'offline' &&
          'border-amber-500/25 bg-amber-500/10 text-amber-600 dark:text-amber-400',
      )}
    >
      <Icon size={size === 'lg' ? 15 : 13} />
    </span>
  );
}

function VaultRow({
  entry,
  highlighted,
  disabled,
  onOpen,
  onRemoveFromList,
  onRemoveOfflineCopy,
  onServerDetails,
}: {
  entry: VaultEntry;
  highlighted: boolean;
  disabled: boolean;
  onOpen: () => void;
  onRemoveFromList: () => void;
  onRemoveOfflineCopy: () => void;
  onServerDetails: () => void;
}) {
  return (
    <li
      className={cn(
        'group relative grid grid-cols-[minmax(0,1fr)_auto_2rem] items-center gap-4 rounded-lg px-3.5 py-2 transition-colors app-motion-base hover:bg-muted/60 lg:grid-cols-[minmax(0,2.2fr)_minmax(0,1.6fr)_minmax(0,1.2fr)_7rem_2rem]',
        highlighted && 'bg-muted/70',
      )}
    >
      {/* The name button stretches over the row so the whole row opens the vault. */}
      <button
        type="button"
        onClick={onOpen}
        disabled={disabled}
        className="flex min-w-0 items-center gap-3 text-left outline-none after:absolute after:inset-0 after:rounded-lg focus-visible:after:ring-3 focus-visible:after:ring-ring/50"
      >
        <KindIcon kind={entry.kind} />
        <span className="truncate font-medium">{entry.name}</span>
        {entry.pendingCount > 0 && (
          <span className="shrink-0 rounded-full bg-amber-500/15 px-2 py-px text-[11px] font-medium text-amber-700 dark:text-amber-300">
            {entry.pendingCount} pending
          </span>
        )}
      </button>
      <span
        className="hidden truncate font-mono text-xs text-muted-foreground lg:block"
        title={entry.location}
      >
        {entry.location}
      </span>
      <span className="hidden truncate text-[13px] text-muted-foreground lg:block">
        {entry.detail}
      </span>
      <span className="text-[13px] text-muted-foreground">
        {formatLastOpened(entry.lastOpened)}
      </span>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={`More actions for ${entry.name}`}
            className="relative z-10 opacity-0 group-hover:opacity-100 focus-visible:opacity-100 aria-expanded:opacity-100"
          >
            <MoreHorizontal />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onSelect={onOpen} disabled={disabled}>
            Open
          </DropdownMenuItem>
          {entry.serverUrl && (
            <DropdownMenuItem onSelect={onServerDetails}>Server details</DropdownMenuItem>
          )}
          {entry.kind === 'local' && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={onRemoveFromList}>Remove from list</DropdownMenuItem>
            </>
          )}
          {entry.kind === 'offline' && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem variant="destructive" onSelect={onRemoveOfflineCopy}>
                Remove offline copy
              </DropdownMenuItem>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
    </li>
  );
}

function SignedOutBanner({
  servers,
  onSignIn,
  onDismiss,
}: {
  servers: ServerEntry[];
  onSignIn: (server: ServerEntry) => void;
  onDismiss: () => void;
}) {
  const [first] = servers;
  const copies = servers.reduce((sum, server) => sum + server.offlineCount, 0);
  const copiesText =
    copies > 0 ? ` ${copies} offline cop${copies === 1 ? 'y is' : 'ies are'} still available.` : '';
  return (
    <div
      role="status"
      className="flex flex-wrap items-center gap-3 rounded-xl border border-amber-500/30 bg-amber-500/10 px-3.5 py-2.5"
    >
      <CircleAlert
        size={16}
        className="shrink-0 text-amber-600 dark:text-amber-400"
        aria-hidden="true"
      />
      <p className="min-w-60 flex-1 text-[13px]">
        {servers.length === 1 ? (
          <>
            <strong className="font-semibold">{first.host}</strong> is signed out. Its vaults are
            hidden.
          </>
        ) : (
          <>{servers.length} servers are signed out. Their vaults are hidden.</>
        )}
        {copiesText}
      </p>
      {servers.map((server) => (
        <Button
          key={server.serverUrl}
          size="sm"
          variant="outline"
          onClick={() => onSignIn(server)}
          aria-label={`Sign in to ${server.host}`}
        >
          {servers.length === 1 ? 'Sign in' : `Sign in to ${server.host}`}
        </Button>
      ))}
      <Button variant="ghost" size="icon-sm" onClick={onDismiss} aria-label="Dismiss">
        <X />
      </Button>
    </div>
  );
}

function FirstRun({
  onCreate,
  onOpenFolder,
  onConnect,
}: {
  onCreate: () => void;
  onOpenFolder: () => void;
  onConnect: () => void;
}) {
  const choices = [
    {
      title: 'Create a vault',
      description: 'Start fresh in a new folder on this device.',
      icon: <Plus size={19} />,
      onClick: onCreate,
      primary: true,
    },
    {
      title: 'Open a folder',
      description: 'Use an existing vault or a folder of Markdown files.',
      icon: <FolderOpen size={19} />,
      onClick: onOpenFolder,
      primary: false,
    },
    {
      title: 'Connect a server',
      description: 'Sign in to open shared vaults, chats and databases.',
      icon: <Server size={19} />,
      onClick: onConnect,
      primary: false,
    },
  ];
  return (
    <section
      aria-labelledby="first-run-heading"
      className="mx-auto my-auto grid w-full max-w-3xl gap-6 py-8 app-fade-scale-in"
    >
      <div>
        <h2 id="first-run-heading" className="text-2xl font-semibold tracking-tight">
          Set up your first vault
        </h2>
        <p className="mt-1.5 text-sm text-muted-foreground">
          A vault is a folder of notes, boards and files. Keep it on this device, or put it on a
          Collab server to work on it together.
        </p>
      </div>
      <div className="grid grid-cols-[repeat(auto-fit,minmax(13rem,1fr))] gap-3.5">
        {choices.map((choice) => (
          <button
            key={choice.title}
            type="button"
            onClick={choice.onClick}
            className={cn(
              'flex flex-col items-start gap-3.5 rounded-xl border p-5 text-left transition-colors app-motion-base outline-none focus-visible:ring-3 focus-visible:ring-ring/50',
              choice.primary
                ? 'border-primary/50 bg-primary/10 hover:bg-primary/15'
                : 'border-border bg-card/60 hover:border-primary/40 hover:bg-primary/5',
            )}
          >
            <span
              className={cn(
                'flex size-10 items-center justify-center rounded-lg',
                choice.primary
                  ? 'bg-primary text-primary-foreground'
                  : 'bg-muted text-muted-foreground',
              )}
            >
              {choice.icon}
            </span>
            <span>
              <span className="block text-base font-semibold">{choice.title}</span>
              <span className="mt-0.5 block text-[13px] text-muted-foreground">
                {choice.description}
              </span>
            </span>
          </button>
        ))}
      </div>
      <p className="text-xs text-muted-foreground">
        Everything stays local unless you choose a server.
      </p>
    </section>
  );
}
