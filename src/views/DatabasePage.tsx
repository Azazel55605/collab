import { useEffect, useRef, useState } from 'react';

import { Database, Plug, Plus, X } from 'lucide-react';

import ConnectionForm from '../components/database/ConnectionForm';
import MetadataExplorer from '../components/database/MetadataExplorer';
import { DocumentTopBar, DocumentTopBarButton } from '../components/layout/DocumentTopBar';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { Field, FieldLabel } from '../components/ui/field';
import { Input } from '../components/ui/input';
import { Tabs, TabsList, TabsTrigger } from '../components/ui/tabs';
import { databaseError } from '../lib/databaseErrors';
import { tauriCommands } from '../lib/tauri';
import { useCollabStore } from '../store/collabStore';
import { useUiStore } from '../store/uiStore';
import type { DatabaseConnection, DatabaseWorkspace } from '../types/database';

export default function DatabasePage() {
  const owner = useCollabStore((state) => state.myUserId);
  return <Workspace key={owner} owner={owner} />;
}
function Workspace({ owner }: { owner: string }) {
  const [workspace, setWorkspace] = useState<DatabaseWorkspace | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [selected, setSelected] = useState('');
  const [activeTab, setActiveTab] = useState<string | null>(null);
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
  const connection = workspace?.connections.find(
    (c) => c.id === (tab?.connection_id ?? connectionId),
  );
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
      },
    );
  };
  return (
    <main className="flex h-full min-h-0 flex-col" aria-label="Databases workspace">
      <DocumentTopBar
        title="Databases"
        icon={<Database size={18} />}
        subtitle={
          connection
            ? `${connection.label} · ${tab?.database ?? connection.database} · ${connection.environment}`
            : 'SQL Server connections for your local profile'
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
          connection ? (
            <>
              <Badge variant="outline">TLS verified</Badge>
              <Badge variant="secondary">
                {tab ? 'Session pinned · No transaction' : 'Metadata session'}
              </Badge>
              <DocumentTopBarButton
                disabled={busy}
                onClick={() => {
                  if (workspace)
                    void perform(async () => {
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
        <aside
          className="flex w-64 shrink-0 flex-col gap-3 overflow-auto border-r border-border/50 bg-sidebar p-3"
          aria-label="Database connections"
        >
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
              Add a SQL Server connection to get started. No vault is required.
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
        </aside>
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
              onValueChange={setActiveTab}
              className="shrink-0 overflow-x-auto p-2"
            >
              <TabsList aria-label="Database sessions">
                {workspace.tabs.map((t) => (
                  <TabsTrigger key={t.tab_id} value={t.tab_id}>
                    {workspace.connections.find((c) => c.id === t.connection_id)?.label} ·{' '}
                    {t.database}
                  </TabsTrigger>
                ))}
              </TabsList>
            </Tabs>
          )}
          {tab && workspace && (
            <div className="flex items-center justify-between gap-2 border-b border-border/50 px-4 py-2">
              <p className="text-xs text-muted-foreground">
                This session stays on its connection and database. Query editing and execution are
                not available yet.
              </p>
              <Button
                size="sm"
                variant="ghost"
                aria-label="Close database session"
                disabled={busy}
                onClick={() =>
                  void perform(
                    async () => {
                      await tauriCommands.databaseCloseTab(workspace.token, tab);
                      return reload();
                    },
                    (state) => {
                      setWorkspace(state);
                      setActiveTab(null);
                    },
                  )
                }
              >
                <X />
              </Button>
            </div>
          )}
          {workspace && connection ? (
            <MetadataExplorer
              key={`${connection.id}:${tab?.tab_id ?? 'databases'}`}
              token={workspace.token}
              connectionId={connection.id}
              binding={tab}
              onOpen={open}
            />
          ) : (
            <div className="flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center">
              <Database size={32} className="text-muted-foreground" />
              <h2 className="text-lg font-semibold">Your database workspace</h2>
              <p className="max-w-md text-sm text-muted-foreground">
                Connect to SQL Server to browse databases, schemas, tables, views, columns and
                indexes. Passwords stay separate from your vaults.
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
