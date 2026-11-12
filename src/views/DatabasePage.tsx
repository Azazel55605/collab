import { useEffect, useRef, useState } from 'react';

import { Database, Plug, Plus, X } from 'lucide-react';

import ConnectionForm from '../components/database/ConnectionForm';
import MetadataExplorer from '../components/database/MetadataExplorer';
import QueryPanel from '../components/database/QueryPanel';
import { DocumentTopBar, DocumentTopBarButton } from '../components/layout/DocumentTopBar';
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
import { useCollabStore } from '../store/collabStore';
import { useUiStore } from '../store/uiStore';
import type { DatabaseConnection, DatabaseWorkspace, SqliteOpenMode } from '../types/database';

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
        icon={<Database size={18} />}
        subtitle={
          sqlite
            ? `${sqlite.label} · SQLite`
            : connection
              ? `${connection.label} · ${tab?.database ?? connection.database} · ${connection.environment}`
              : 'SQL Server, MariaDB and local SQLite files'
        }
        meta={
          <>
            <DocumentTopBarButton onClick={() => useUiStore.getState().setActiveView('editor')}>
              Back to files
            </DocumentTopBarButton>
            <DocumentTopBarButton disabled={!workspace || busy} onClick={() => setForm(null)}>
              <Plus />
              New connection
            </DocumentTopBarButton>
          </>
        }
        secondary={
          sqlite && workspace ? (
            <>
              <Badge variant="outline">{sqlite.read_only ? 'Read-only' : 'Read/write'}</Badge>
              <Badge variant="secondary">Transaction {queryStatus?.transaction ?? 'none'}</Badge>
              <DocumentTopBarButton
                disabled={
                  busy || queryStatus?.phase !== 'idle' || queryStatus.transaction !== 'none'
                }
                onClick={() =>
                  void perform(
                    () => tauriCommands.databaseSqliteBackup(workspace.token, sqlite.binding),
                    (saved) => {
                      if (saved) setNotice('SQLite backup saved.');
                    },
                  )
                }
              >
                Save backup…
              </DocumentTopBarButton>
            </>
          ) : connection ? (
            <>
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
              <DocumentTopBarButton
                disabled={busy}
                onClick={() => {
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
                Disconnect {connection.label}
              </DocumentTopBarButton>
            </>
          ) : undefined
        }
      />
      <div className="flex min-h-0 flex-1">
        <WorkspaceSidebar
          open={sidebarOpen}
          frameClassName="[--workspace-sidebar-width:16rem]"
          className="flex flex-col gap-3 overflow-auto border-r border-border/50 bg-sidebar p-3"
          aria-label="Database connections and files"
        >
          <h2 className="text-xs font-semibold text-muted-foreground">SQLite files</h2>
          <Button
            variant="outline"
            size="sm"
            disabled={!workspace || busy}
            onClick={() => pickSqlite('read_write')}
          >
            Open SQLite…
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={!workspace || busy}
            onClick={() => pickSqlite('read_only')}
          >
            Open SQLite read-only…
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={!workspace || busy}
            onClick={() => pickSqlite('create')}
          >
            Create SQLite…
          </Button>
          <Input
            aria-label="Search connections"
            placeholder="Search connections…"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
          <h2 className="text-xs font-semibold text-muted-foreground">Saved connections</h2>
          {workspace?.profiles
            .filter((p) =>
              `${p.label} ${p.host} ${p.environment}`.toLowerCase().includes(search.toLowerCase()),
            )
            .map((p) => (
              <Button
                key={p.id}
                className="justify-start truncate"
                variant={selected === p.id ? 'secondary' : 'ghost'}
                disabled={busy}
                onClick={() => {
                  setSelected(p.id);
                  setPassword('');
                }}
              >
                {p.label}
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
          <h2 className="mt-3 text-xs font-semibold text-muted-foreground">Active connections</h2>
          {workspace?.connections.map((c) => (
            <Button
              key={c.id}
              variant={connectionId === c.id ? 'secondary' : 'ghost'}
              className="h-auto flex-col items-start gap-1 py-2"
              aria-label={`${c.label} · Browse databases`}
              disabled={busy}
              onClick={() => {
                setConnectionId(c.id);
                setActiveTab(null);
              }}
            >
              <span className="max-w-full truncate">{c.label}</span>
              <span className="text-[11px] text-muted-foreground">Browse databases</span>
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
              key={tab.tab_id}
              token={workspace.token}
              binding={tab}
              engine={engine}
              sqlite={sqlite}
            />
          ) : workspace && (connection || sqlite) ? (
            <MetadataExplorer
              key={`${sqlite?.binding.connection_id ?? connection?.id}:${tab?.tab_id ?? 'databases'}`}
              token={workspace.token}
              connectionId={sqlite?.binding.connection_id ?? connection?.id ?? ''}
              engine={engine}
              binding={tab}
              onOpen={open}
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
