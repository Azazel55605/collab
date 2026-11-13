import { useEffect, useRef, useState } from 'react';

import { Database, Download, Plug, Plus, Unplug, X } from 'lucide-react';

import ConnectionForm from '../components/database/ConnectionForm';
import MetadataExplorer from '../components/database/MetadataExplorer';
import QueryPanel from '../components/database/QueryPanel';
import SchemaEditor from '../components/database/SchemaEditor';
import {
  DocumentMoreMenu,
  DocumentTopBar,
  DocumentTopBarButton,
  DocumentTopBarIconButton,
  DocumentTopBarMenuButton,
} from '../components/layout/DocumentTopBar';
import { WorkspaceSidebar } from '../components/layout/WorkspaceSidebar';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '../components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '../components/ui/dropdown-menu';
import { Field, FieldLabel } from '../components/ui/field';
import { Input } from '../components/ui/input';
import { Tabs, TabsList, TabsTrigger } from '../components/ui/tabs';
import {
  executeQuery,
  forgetQuery,
  hasQueryDraft,
  syncQueryTabs,
  useDatabaseQueries,
} from '../lib/database/queryStore';
import { databaseError } from '../lib/databaseErrors';
import { tauriCommands } from '../lib/tauri';
import { cn } from '../lib/utils';
import { useCollabStore } from '../store/collabStore';
import type { DatabaseConnection, DatabaseWorkspace, SqliteOpenMode } from '../types/database';

const SECTION_HEADING = 'text-[11px] font-semibold tracking-widest text-muted-foreground uppercase';

export default function DatabasePage({ sidebarOpen = true }: { sidebarOpen?: boolean }) {
  const owner = useCollabStore((state) => state.myUserId);
  return <Workspace key={owner} owner={owner} sidebarOpen={sidebarOpen} />;
}
function Workspace({ owner, sidebarOpen }: { owner: string; sidebarOpen: boolean }) {
  const [workspace, setWorkspace] = useState<DatabaseWorkspace | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [selected, setSelected] = useState('');
  const [activeTab, setActiveTab] = useState<string | null>(null);
  const [metadata, setMetadata] = useState(false);
  const [schemaRevision, setSchemaRevision] = useState(0);
  const [schemaTarget, setSchemaTarget] = useState<{
    tabId: string;
    schema: string;
    table: string;
  } | null>(null);
  const editActive = useDatabaseQueries((state) => !!state.tabs[activeTab ?? '']?.edit);
  const queryReceiving = useDatabaseQueries((state) => !!state.tabs[activeTab ?? '']?.receiving);
  const [closing, setClosing] = useState(false);
  const queryStatus = useDatabaseQueries((state) => state.tabs[activeTab ?? '']?.status);
  const [connectionId, setConnectionId] = useState('');
  const [search, setSearch] = useState('');
  const [password, setPassword] = useState('');
  const [form, setForm] = useState<DatabaseConnection | null | undefined>(undefined);
  const generation = useRef(0);
  useEffect(() => {
    const version = ++generation.current;
    void tauriCommands
      .databaseActivate(owner)
      .then((result) => {
        if (generation.current === version) setWorkspace(result);
      })
      .catch((error) => {
        if (generation.current === version) setError(databaseError(error));
      });
    return () => {
      generation.current = version + 1;
    };
  }, [owner]);
  useEffect(() => {
    if (workspace) syncQueryTabs(owner, workspace);
  }, [owner, workspace]);
  useEffect(() => {
    const keys = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.defaultPrevented) return;
      if (event.key.toLowerCase() === 'w') {
        event.preventDefault();
        if (workspace?.tabs.some((tab) => tab.tab_id === activeTab)) setClosing(true);
      }
      if (event.key === 'Tab') {
        event.preventDefault();
        const tabs = workspace?.tabs ?? [];
        if (tabs.length) {
          const current = tabs.findIndex((tab) => tab.tab_id === activeTab);
          const next = (current + (event.shiftKey ? -1 : 1) + tabs.length) % tabs.length;
          setActiveTab(tabs[next].tab_id);
          setMetadata(false);
        }
      }
    };
    document.addEventListener('keydown', keys, { capture: true });
    return () => document.removeEventListener('keydown', keys, { capture: true });
  }, [workspace, activeTab]);
  const perform = async <T,>(job: () => Promise<T>, apply?: (value: T) => void) => {
    const version = generation.current;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const result = await job();
      if (generation.current === version) apply?.(result);
    } catch (error) {
      if (generation.current === version) {
        setError(databaseError(error));
        try {
          const current = await reload();
          if (generation.current === version) setWorkspace(current);
        } catch {
          /* Preserve the safe original error. */
        }
      }
    } finally {
      if (generation.current === version) setBusy(false);
    }
  };
  const reload = () => tauriCommands.databaseActivate(owner);
  const profile = workspace?.profiles.find((p) => p.id === selected);
  const tab = workspace?.tabs.find((t) => t.tab_id === activeTab) ?? null;
  const sqlite = workspace?.sqlite_files?.find((file) => file.binding.tab_id === tab?.tab_id);
  const connection = workspace?.connections.find(
    (c) => c.id === (tab?.connection_id ?? connectionId),
  );
  const engine = sqlite ? 'sqlite' : (connection?.engine ?? 'sql_server');
  const mariaCapabilities = connection?.maria_capabilities;
  const canEditSchema =
    !!tab &&
    !sqlite?.read_only &&
    !editActive &&
    !queryReceiving &&
    !busy &&
    (!queryStatus || (queryStatus.phase === 'idle' && queryStatus.transaction === 'none'));
  const editSchema = (schema: string, table: string) => {
    if (tab && canEditSchema) setSchemaTarget({ tabId: tab.tab_id, schema, table });
  };
  const connect = (testOnly: boolean) => {
    if (!workspace || !profile) return;
    const secret = password || undefined;
    setPassword('');
    void perform(
      async () => {
        const connected = await tauriCommands.databaseConnect(
          workspace.token,
          profile.id,
          secret,
          testOnly,
        );
        return { connected, state: await reload() };
      },
      ({ connected, state }) => {
        setWorkspace(state);
        if (testOnly) setNotice('Connection test passed. The test session has been closed.');
        else {
          setConnectionId(connected.id);
          setActiveTab(null);
        }
      },
    );
  };
  const pickSqlite = (mode: SqliteOpenMode) => {
    if (!workspace || busy) return;
    void perform(
      async () => {
        const file = await tauriCommands.databaseSqlitePick(workspace.token, mode);
        return file ? { file, state: await reload() } : null;
      },
      (result) => {
        if (!result) return;
        setWorkspace(result.state);
        setActiveTab(result.file.binding.tab_id);
        setMetadata(false);
      },
    );
  };
  const open = (database: string) => {
    if (!workspace || !connection || busy) return;
    void perform(
      async () => {
        const binding = await tauriCommands.databaseOpenTab(
          workspace.token,
          connection.id,
          database,
        );
        return { binding, state: await reload() };
      },
      ({ binding, state }) => {
        setWorkspace(state);
        setActiveTab(binding.tab_id);
        setMetadata(false);
      },
    );
  };
  return (
    <main className="flex h-full min-h-0 flex-col" aria-label="Databases workspace">
      <DocumentTopBar
        title="Databases"
        icon={<Database />}
        subtitle={
          sqlite
            ? `${sqlite.label} · SQLite`
            : connection
              ? `${connection.label} · ${tab?.database ?? connection.database} · ${connection.environment}`
              : 'SQL Server, MariaDB and local SQLite files'
        }
        status={
          sqlite && workspace ? (
            <div className="flex flex-wrap items-center gap-1.5">
              <Badge variant="outline">{sqlite.read_only ? 'Read-only' : 'Read/write'}</Badge>
              <Badge variant="secondary">Transaction {queryStatus?.transaction ?? 'none'}</Badge>
            </div>
          ) : connection ? (
            <div className="flex flex-wrap items-center gap-1.5">
              <Badge variant="outline">TLS verified</Badge>
              {mariaCapabilities && (
                <Badge
                  variant="secondary"
                  title={`SQL mode ${mariaCapabilities.sql_mode} · ${mariaCapabilities.collation}`}
                >
                  {mariaCapabilities.version} ·{' '}
                  {mariaCapabilities.innodb ? 'InnoDB available' : 'InnoDB unavailable'}
                </Badge>
              )}
              <Badge variant="secondary">
                {tab
                  ? `Session pinned · Transaction ${queryStatus?.transaction ?? 'none'}`
                  : 'Metadata session'}
              </Badge>
            </div>
          ) : undefined
        }
        meta={
          <>
            <DocumentTopBarButton
              variant="default"
              disabled={!workspace || busy}
              onClick={() => setForm(null)}
            >
              <Plus />
              New connection
            </DocumentTopBarButton>
            {(sqlite && workspace) || connection ? (
              <DocumentMoreMenu label="More database actions">
                {sqlite && workspace ? (
                  <DropdownMenuItem
                    disabled={
                      busy || queryStatus?.phase !== 'idle' || queryStatus.transaction !== 'none'
                    }
                    onSelect={() =>
                      void perform(
                        () => tauriCommands.databaseSqliteBackup(workspace.token, sqlite.binding),
                        (saved) => {
                          if (saved) setNotice('SQLite backup saved.');
                        },
                      )
                    }
                  >
                    <Download /> Save SQLite backup…
                  </DropdownMenuItem>
                ) : null}
                {connection ? (
                  <DropdownMenuItem
                    disabled={busy}
                    onSelect={() => {
                      if (workspace)
                        void perform(async () => {
                          if (
                            Object.values(useDatabaseQueries.getState().tabs).some(
                              (t) => t.binding.connection_id === connection.id && hasQueryDraft(t),
                            )
                          )
                            throw 'unresolved_session';
                          await tauriCommands.databaseDisconnect(workspace.token, connection.id);
                          return reload();
                        }, setWorkspace);
                    }}
                  >
                    <Unplug /> Disconnect {connection.label}
                  </DropdownMenuItem>
                ) : null}
              </DocumentMoreMenu>
            ) : null}
          </>
        }
      />
      <div className="flex min-h-0 flex-1">
        <WorkspaceSidebar
          open={sidebarOpen}
          frameClassName="[--workspace-sidebar-width:16rem]"
          className="flex flex-col gap-3 overflow-auto border-r border-border/50 bg-sidebar p-3"
          aria-label="Database connections and files"
        >
          <Input
            aria-label="Search connections"
            placeholder="Filter connections…"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
          <div className="flex items-center justify-between">
            <h2 className={SECTION_HEADING}>SQLite files</h2>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <DocumentTopBarMenuButton
                  className="h-7 px-2 text-xs"
                  disabled={!workspace || busy}
                  aria-label="Open SQLite file"
                >
                  Open
                </DocumentTopBarMenuButton>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onSelect={() => pickSqlite('read_write')}>
                  Open SQLite…
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => pickSqlite('read_only')}>
                  Open SQLite read-only…
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem onSelect={() => pickSqlite('create')}>
                  Create SQLite…
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
          <div className="flex items-center justify-between">
            <h2 className={SECTION_HEADING}>Connections</h2>
            <DocumentTopBarIconButton
              aria-label="New connection"
              title="New connection"
              className="size-7"
              disabled={!workspace || busy}
              onClick={() => setForm(null)}
            >
              <Plus />
            </DocumentTopBarIconButton>
          </div>
          {workspace?.profiles
            .filter((p) =>
              `${p.label} ${p.host} ${p.environment}`.toLowerCase().includes(search.toLowerCase()),
            )
            .map((p) => (
              <Button
                key={p.id}
                aria-label={p.label}
                className="h-auto justify-start gap-2.5 py-1.5"
                variant={selected === p.id ? 'secondary' : 'ghost'}
                disabled={busy}
                onClick={() => {
                  setSelected(p.id);
                  setPassword('');
                }}
              >
                <span
                  aria-hidden="true"
                  className={cn(
                    'size-2 shrink-0 rounded-full',
                    workspace.connections.some((c) => c.saved_id === p.id)
                      ? 'bg-emerald-500'
                      : 'border-2 border-muted-foreground/50',
                  )}
                />
                <span className="flex min-w-0 flex-col items-start leading-tight">
                  <span className="max-w-full truncate">{p.label}</span>
                  <span className="max-w-full truncate text-[11px] font-normal text-muted-foreground">
                    {p.environment}
                  </span>
                </span>
              </Button>
            ))}
          {workspace?.profiles.length === 0 && (
            <p className="text-xs text-muted-foreground">
              Add a SQL Server or MariaDB connection to get started.
            </p>
          )}
          {profile && (
            <>
              <p className="break-all text-xs text-muted-foreground">
                {profile.host}:{profile.port} · {profile.environment}
              </p>
              <Field>
                <FieldLabel htmlFor="database-connect-password">
                  Password for this connection
                </FieldLabel>
                <Input
                  id="database-connect-password"
                  type="password"
                  autoComplete="off"
                  maxLength={4096}
                  placeholder={profile.remember_password ? 'Use stored password' : 'SQL password'}
                  value={password}
                  disabled={busy}
                  onChange={(event) => setPassword(event.target.value)}
                />
              </Field>
              <div className="flex flex-wrap gap-2">
                <Button size="sm" disabled={busy} onClick={() => connect(false)}>
                  <Plug />
                  Connect
                </Button>
                <Button size="sm" variant="outline" disabled={busy} onClick={() => connect(true)}>
                  Test
                </Button>
                <Button size="sm" variant="ghost" disabled={busy} onClick={() => setForm(profile)}>
                  Edit
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={busy}
                  onClick={() => {
                    if (workspace)
                      void perform(
                        async () => {
                          if (
                            Object.values(useDatabaseQueries.getState().tabs).some(
                              (t) =>
                                workspace.connections.some(
                                  (c) =>
                                    c.saved_id === profile.id && c.id === t.binding.connection_id,
                                ) && hasQueryDraft(t),
                            )
                          )
                            throw 'unresolved_session';
                          await tauriCommands.databaseRemove(workspace.token, profile.id);
                          return reload();
                        },
                        (state) => {
                          setWorkspace(state);
                          setSelected('');
                        },
                      );
                  }}
                >
                  Remove
                </Button>
              </div>
            </>
          )}
          {(workspace?.connections.length ?? 0) > 0 && (
            <h2 className={cn(SECTION_HEADING, 'mt-2')}>Connected</h2>
          )}
          {workspace?.connections.map((c) => (
            <Button
              key={c.id}
              variant={connectionId === c.id ? 'secondary' : 'ghost'}
              className="h-auto justify-start gap-2.5 py-1.5"
              aria-label={`${c.label} · Browse databases`}
              disabled={busy}
              onClick={() => {
                setConnectionId(c.id);
                setActiveTab(null);
              }}
            >
              <span aria-hidden="true" className="size-2 shrink-0 rounded-full bg-emerald-500" />
              <span className="flex min-w-0 flex-col items-start leading-tight">
                <span className="max-w-full truncate">{c.label}</span>
                <span className="text-[11px] font-normal text-muted-foreground">
                  Browse databases
                </span>
              </span>
            </Button>
          ))}
        </WorkspaceSidebar>
        <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
          {busy && (
            <p role="status" className="px-4 py-2 text-sm text-muted-foreground">
              Working…
            </p>
          )}
          {error && (
            <p role="alert" className="px-4 py-2 text-sm text-destructive">
              {error}
            </p>
          )}
          {notice && (
            <p role="status" className="px-4 py-2 text-sm text-muted-foreground">
              {notice}
            </p>
          )}
          {workspace && workspace.tabs.length > 0 && (
            <Tabs
              value={tab?.tab_id ?? ''}
              onValueChange={(id) => {
                setActiveTab(id);
                setMetadata(false);
              }}
              className="shrink-0 overflow-x-auto p-2"
            >
              <TabsList aria-label="Database sessions">
                {workspace.tabs.map((t) => (
                  <TabsTrigger key={t.tab_id} value={t.tab_id}>
                    {workspace.sqlite_files?.find((file) => file.binding.tab_id === t.tab_id)
                      ?.label ??
                      `${workspace.connections.find((c) => c.id === t.connection_id)?.label ?? 'SQL Server'} · ${t.database}`}
                  </TabsTrigger>
                ))}
              </TabsList>
            </Tabs>
          )}
          {tab && workspace && (
            <div className="flex items-center justify-between gap-2 border-b border-border/50 px-4 py-2">
              <p className="text-xs text-muted-foreground">
                {sqlite
                  ? 'Changes apply to the selected local SQLite file.'
                  : 'This session stays pinned to its connection and database.'}
              </p>
              <Button
                size="sm"
                variant="ghost"
                disabled={!canEditSchema}
                onClick={() => editSchema(engine === 'sql_server' ? 'dbo' : tab.database, '')}
              >
                Edit schema…
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setMetadata((value) => !value)}>
                {metadata ? 'SQL editor' : 'Browse metadata'}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                aria-label="Close database session"
                disabled={busy}
                onClick={() => setClosing(true)}
              >
                <X />
              </Button>
            </div>
          )}
          {workspace && tab && !metadata ? (
            <QueryPanel
              key={`${tab.tab_id}:${schemaRevision}`}
              token={workspace.token}
              binding={tab}
              engine={engine}
              sqlite={sqlite}
            />
          ) : workspace && (connection || sqlite) ? (
            <MetadataExplorer
              key={`${sqlite?.binding.connection_id ?? connection?.id}:${tab?.tab_id ?? 'databases'}:${schemaRevision}`}
              token={workspace.token}
              connectionId={sqlite?.binding.connection_id ?? connection?.id ?? ''}
              engine={engine}
              binding={tab}
              onOpen={open}
              onEditSchema={canEditSchema ? editSchema : undefined}
              onBrowse={
                tab
                  ? (schema, table) => {
                      setMetadata(false);
                      void executeQuery(workspace.token, tab, undefined, false, {
                        schema,
                        table,
                        filter_column: null,
                        filter_text: '',
                      });
                    }
                  : undefined
              }
            />
          ) : (
            <div className="flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center">
              <Database size={32} className="text-muted-foreground" />
              <h2 className="text-lg font-semibold">Your database workspace</h2>
              <p className="max-w-md text-sm text-muted-foreground">
                Connect to SQL Server or MariaDB, or open a local SQLite database to browse its
                schema, run SQL and edit table rows.
              </p>
              {!workspace && !error && (
                <p role="status" className="text-sm text-muted-foreground">
                  Opening workspace…
                </p>
              )}
            </div>
          )}
        </div>
      </div>
      {schemaTarget && workspace && tab?.tab_id === schemaTarget.tabId && (
        <SchemaEditor
          token={workspace.token}
          binding={tab}
          engine={engine}
          target={schemaTarget}
          onClose={() => setSchemaTarget(null)}
          onApplied={() => {
            setSchemaTarget(null);
            setSchemaRevision((revision) => revision + 1);
            setNotice('Schema change applied.');
          }}
        />
      )}
      {closing && workspace && tab && (
        <Dialog open onOpenChange={setClosing}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Close database session?</DialogTitle>
              <DialogDescription>
                Discard this tab’s SQL draft, staged row changes, results and history. Running work
                is stopped by closing the connection; uncommitted transactions are not committed.
                Already committed changes are not undone. If an outcome is unknown, verify the
                database before rerunning SQL.
              </DialogDescription>
            </DialogHeader>
            <Button variant="outline" onClick={() => setClosing(false)}>
              Keep session
            </Button>
            <Button
              variant="destructive"
              disabled={busy}
              onClick={() =>
                void perform(
                  async () => {
                    await tauriCommands.databaseCloseTab(workspace.token, tab, true);
                    return reload();
                  },
                  (state) => {
                    forgetQuery(tab.tab_id);
                    setWorkspace(state);
                    setActiveTab(null);
                    setClosing(false);
                  },
                )
              }
            >
              Close session and discard
            </Button>
          </DialogContent>
        </Dialog>
      )}
      {form !== undefined && workspace && (
        <ConnectionForm
          key={form?.id ?? 'new'}
          initial={form}
          durable={workspace.durable_credentials}
          busy={busy}
          onClose={() => setForm(undefined)}
          onSave={(config, password) =>
            void perform(
              async () => {
                if (
                  Object.values(useDatabaseQueries.getState().tabs).some(
                    (t) =>
                      workspace.connections.some(
                        (c) => c.saved_id === config.id && c.id === t.binding.connection_id,
                      ) && hasQueryDraft(t),
                  )
                )
                  throw 'unresolved_session';
                const saved = await tauriCommands.databaseSave(workspace.token, config, password);
                return { saved, state: await reload() };
              },
              ({ saved, state }) => {
                setWorkspace(state);
                setSelected(saved.id);
                setPassword(config.remember_password ? '' : (password ?? ''));
                setForm(undefined);
              },
            )
          }
        />
      )}
    </main>
  );
}
