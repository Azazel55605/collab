import { useEffect, useRef, useState } from 'react';

import { Database, Download, MoreHorizontal, PanelLeft, Plug, Plus, Unplug, X } from 'lucide-react';

import ConnectionForm from '../components/database/ConnectionForm';
import MetadataExplorer from '../components/database/MetadataExplorer';
import QueryPanel from '../components/database/QueryPanel';
import SchemaEditor from '../components/database/SchemaEditor';
import ServerObjectExplorer from '../components/database/ServerObjectExplorer';
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
import { ConfirmDialog } from '../components/ui/confirm-dialog';
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

export default function DatabasePage({ sidebarOpen }: { sidebarOpen?: boolean }) {
  const owner = useCollabStore((state) => state.myUserId);
  const [standaloneSidebarOpen, setStandaloneSidebarOpen] = useState(true);
  return (
    <Workspace
      key={owner}
      owner={owner}
      sidebarOpen={sidebarOpen ?? standaloneSidebarOpen}
      onToggleSidebar={
        sidebarOpen === undefined ? () => setStandaloneSidebarOpen((open) => !open) : undefined
      }
    />
  );
}
function Workspace({
  owner,
  sidebarOpen,
  onToggleSidebar,
}: {
  owner: string;
  sidebarOpen: boolean;
  onToggleSidebar?: () => void;
}) {
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
  const profileConnected = workspace?.connections.some((live) => live.saved_id === profile?.id);
  const engine = sqlite ? 'sqlite' : (connection?.engine ?? 'sql_server');
  const certificateException =
    engine === 'sql_server' &&
    workspace?.profiles.find((saved) => saved.id === connection?.saved_id)
      ?.allow_untrusted_certificate;
  const objectConnection = engine === 'sql_server' ? connection : undefined;
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
    if (!workspace || !profile || profileConnected || busy) return;
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
  const removeConnection = (savedId: string) => {
    if (!workspace || busy) return;
    void perform(
      async () => {
        if (
          Object.values(useDatabaseQueries.getState().tabs).some(
            (t) =>
              workspace.connections.some(
                (live) => live.saved_id === savedId && live.id === t.binding.connection_id,
              ) && hasQueryDraft(t),
          )
        )
          throw 'unresolved_session';
        await tauriCommands.databaseRemove(workspace.token, savedId);
        return reload();
      },
      (state) => {
        setWorkspace(state);
        if (selected === savedId) {
          setSelected('');
          setPassword('');
        }
      },
    );
  };
  const browseConnection = (id: string) => {
    setConnectionId(id);
    if (tab?.connection_id !== id) {
      setActiveTab(null);
      setMetadata(false);
    }
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
              <Badge variant="outline">
                {certificateException ? 'TLS unverified' : 'TLS verified'}
              </Badge>
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
            {onToggleSidebar ? (
              <DocumentTopBarIconButton
                aria-label={sidebarOpen ? 'Hide database sidebar' : 'Show database sidebar'}
                title={sidebarOpen ? 'Hide database sidebar' : 'Show database sidebar'}
                aria-expanded={sidebarOpen}
                onClick={onToggleSidebar}
              >
                <PanelLeft />
              </DocumentTopBarIconButton>
            ) : null}
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
          frameClassName="[--workspace-sidebar-width:18rem]"
          className="flex min-h-0 flex-col border-r border-border/50 bg-sidebar"
          aria-label="Database connections and files"
        >
          <section
            aria-labelledby="database-connections-heading"
            className="flex max-h-[45%] shrink-0 flex-col border-b border-border/50"
          >
            <div className="flex shrink-0 items-center justify-between gap-2 px-3 pt-2">
              <h2 id="database-connections-heading" className={SECTION_HEADING}>
                Connections
              </h2>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <DocumentTopBarMenuButton
                    className="h-7 px-2 text-xs"
                    disabled={!workspace || busy}
                    aria-label="Open SQLite file"
                  >
                    SQLite
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
            <div className="min-h-0 space-y-2 overflow-y-auto px-3 pt-1 pb-3">
              {(workspace?.profiles.length ?? 0) > 1 ? (
                <Input
                  aria-label="Search connections"
                  placeholder="Filter connections…"
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                />
              ) : null}
              {workspace?.profiles.length === 0 ? (
                <p className="text-xs text-muted-foreground">
                  Add a SQL Server or MariaDB connection to get started.
                </p>
              ) : null}
              <ul className="space-y-0.5">
                {workspace?.profiles
                  .filter((p) =>
                    `${p.label} ${p.host} ${p.environment}`
                      .toLowerCase()
                      .includes((workspace.profiles.length > 1 ? search : '').toLowerCase()),
                  )
                  .map((p) => {
                    const live = workspace.connections.filter((item) => item.saved_id === p.id);
                    const active = live.find((item) => item.id === connection?.id) ?? live[0];
                    const isSelected =
                      selected === p.id || (!selected && connection?.saved_id === p.id);
                    return (
                      <li key={p.id}>
                        <div className="flex min-w-0 items-center gap-1">
                          <Button
                            aria-label={p.label}
                            aria-describedby={`database-status-${p.id}`}
                            aria-pressed={isSelected}
                            className="h-auto min-w-0 flex-1 justify-start gap-2.5 px-2 py-1.5"
                            variant={isSelected ? 'secondary' : 'ghost'}
                            disabled={busy}
                            onClick={() => {
                              setSelected(p.id);
                              setPassword('');
                              if (active) browseConnection(active.id);
                            }}
                          >
                            <span
                              aria-hidden="true"
                              className={cn(
                                'size-2 shrink-0 rounded-full',
                                active ? 'bg-emerald-500' : 'border-2 border-muted-foreground/50',
                              )}
                            />
                            <span className="flex min-w-0 flex-col items-start leading-tight">
                              <span className="max-w-full truncate">{p.label}</span>
                              <span
                                id={`database-status-${p.id}`}
                                className="max-w-full truncate text-[11px] font-normal text-muted-foreground"
                              >
                                {active ? 'Connected' : 'Disconnected'} · {p.environment}
                              </span>
                            </span>
                          </Button>
                          <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                              <Button
                                size="icon-xs"
                                variant="ghost"
                                aria-label={`Manage ${p.label}`}
                                disabled={busy}
                              >
                                <MoreHorizontal />
                              </Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end">
                              {live.length > 1
                                ? live.map((item, index) => (
                                    <DropdownMenuItem
                                      key={item.id}
                                      onSelect={() => {
                                        setSelected(p.id);
                                        setPassword('');
                                        browseConnection(item.id);
                                      }}
                                    >
                                      Browse connection {index + 1}
                                    </DropdownMenuItem>
                                  ))
                                : null}
                              <DropdownMenuItem onSelect={() => setForm(p)}>
                                Edit connection
                              </DropdownMenuItem>
                              <DropdownMenuItem onSelect={() => removeConnection(p.id)}>
                                Remove connection
                              </DropdownMenuItem>
                            </DropdownMenuContent>
                          </DropdownMenu>
                        </div>
                        {selected === p.id && !active ? (
                          <div className="space-y-2 px-2 py-2">
                            <p className="break-all text-xs text-muted-foreground">
                              {p.host}:{p.port}
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
                                placeholder={
                                  p.remember_password ? 'Use stored password' : 'SQL password'
                                }
                                value={password}
                                disabled={busy}
                                onChange={(event) => setPassword(event.target.value)}
                                onKeyDown={(event) => {
                                  if (event.key === 'Enter') connect(false);
                                }}
                              />
                            </Field>
                            <div className="flex gap-2">
                              <Button size="sm" disabled={busy} onClick={() => connect(false)}>
                                <Plug /> Connect
                              </Button>
                              <Button
                                size="sm"
                                variant="outline"
                                disabled={busy}
                                onClick={() => connect(true)}
                              >
                                Test
                              </Button>
                            </div>
                          </div>
                        ) : null}
                      </li>
                    );
                  })}
              </ul>
            </div>
          </section>
          <div className="min-h-0 flex-1 overflow-y-auto p-3">
            {workspace && objectConnection && (sidebarOpen || tab) ? (
              <ServerObjectExplorer
                key={objectConnection.id}
                token={workspace.token}
                connectionId={objectConnection.id}
                label={objectConnection.label}
                revision={schemaRevision}
                onOpen={open}
                busy={busy}
              />
            ) : null}
          </div>
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
          ) : workspace && objectConnection && sidebarOpen && !tab ? (
            <div className="flex flex-1 flex-col items-center justify-center gap-2 p-8 text-center">
              <Database className="size-8 text-muted-foreground" />
              <p className="text-sm text-muted-foreground">
                Open a query from a database in the sidebar.
              </p>
            </div>
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
        <ConfirmDialog
          open
          onOpenChange={setClosing}
          destructive
          title="Close database session?"
          description="Discard this tab’s SQL draft, staged row changes, results and history. Running work is stopped by closing the connection; uncommitted transactions are not committed. Already committed changes are not undone. If an outcome is unknown, verify the database before rerunning SQL."
          cancelLabel="Keep session"
          confirmLabel="Close session and discard"
          busy={busy}
          onConfirm={() =>
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
        />
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
