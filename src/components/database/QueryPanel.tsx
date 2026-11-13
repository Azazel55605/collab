import { useEffect, useMemo, useRef, useState } from 'react';

import { FolderOpen, History, Play, Save, Square } from 'lucide-react';
import { toast } from 'sonner';

import {
  ensureQuery,
  executeQuery,
  idleStatus,
  updateQuery,
  useDatabaseQueries,
} from '../../lib/database/queryStore';
import { openTableEdit } from '../../lib/database/tableEditing';
import { exportResults } from '../../lib/database/values';
import { databaseError, databaseQueryError } from '../../lib/databaseErrors';
import { documentVaultIdentity } from '../../lib/documentPaneContext';
import { tauriCommands } from '../../lib/tauri';
import { createVaultClient } from '../../lib/vaultClient';
import { useVaultStore } from '../../store/vaultStore';
import type {
  DatabaseBinding,
  DatabaseEngine,
  DatabaseHistoryEntry,
  DatabaseSqliteFile,
} from '../../types/database';
import {
  DocumentToolStrip,
  DocumentTopBarButton,
  documentTopBarGroupClass,
  DocumentTopBarIconButton,
} from '../layout/DocumentTopBar';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '../ui/dialog';
import { Field, FieldLabel } from '../ui/field';
import { Input } from '../ui/input';
import { Tabs, TabsList, TabsTrigger } from '../ui/tabs';

import ResultGrid from './ResultGrid';
import SqlEditor, { type SqlEditorHandle, type SqlSchema } from './SqlEditor';
import TableEditDialog from './TableEditDialog';

export default function QueryPanel({
  token,
  binding,
  sqlite,
  engine = 'sql_server',
}: {
  token: string;
  binding: DatabaseBinding;
  sqlite?: DatabaseSqliteFile;
  engine?: DatabaseEngine;
}) {
  const maria = engine === 'maria_db';
  const tab = useDatabaseQueries((state) => state.tabs[binding.tab_id]);
  const vault = useVaultStore((state) => state.vault);
  const locked = useVaultStore((state) => state.isVaultLocked);
  const editor = useRef<SqlEditorHandle | null>(null);
  const [browse, setBrowse] = useState({
    schema: tab?.browse?.schema ?? (sqlite ? 'main' : maria ? binding.database : 'dbo'),
    table: tab?.browse?.table ?? '',
    filter_column: tab?.browse?.filter_column ?? '',
    filter_text: tab?.browse?.filter_text ?? '',
  });
  const [set, setSet] = useState('0');
  const [history, setHistory] = useState<DatabaseHistoryEntry[] | null>(null);
  const script = tab?.script ?? null;
  const [fileAction, setFileAction] = useState<'open' | 'save' | null>(null);
  const [path, setPath] = useState('query.sql');
  const [schema, setSchema] = useState<SqlSchema>({});
  const [cursor, setCursor] = useState('0:0');
  const [schemaCount, setSchemaCount] = useState(0);
  const [working, setWorking] = useState(false);
  const [confirmCommit, setConfirmCommit] = useState(false);
  useEffect(() => {
    ensureQuery(binding);
    void tauriCommands
      .databaseQueryStatus(token, binding)
      .then((status) => updateQuery(binding.tab_id, (tab) => ({ ...tab, status })))
      .catch(() => {});
  }, [token, binding]);
  const status = tab?.status ?? idleStatus;
  const running = !!tab?.receiving || ['running', 'cancelling', 'finishing'].includes(status.phase);
  const retired = ['retired', 'outcome_unknown'].includes(status.phase);
  const editingBusy = !!tab?.edit?.busy;
  const canControlTransaction = !running && !retired && !editingBusy;
  const result = tab?.results[Number(set)];
  const sets = useMemo(() => Object.keys(tab?.results ?? {}), [tab?.results]);
  const job = async (action: () => Promise<void>) => {
    setWorking(true);
    try {
      await action();
    } catch (error) {
      toast.error(databaseError(error));
    } finally {
      setWorking(false);
    }
  };
  const run = (selection: boolean) => {
    if (!tab || running || retired || editingBusy) return;
    void executeQuery(token, binding, selection ? editor.current?.selection() : undefined);
  };
  const completion = () =>
    void job(async () => {
      const page = await tauriCommands.databaseMetadata(token, binding.connection_id, binding, {
        kind: 'completion',
        after: cursor,
      });
      const next: SqlSchema = structuredClone(schema);
      for (const item of page.items) {
        if (!Object.prototype.hasOwnProperty.call(next, item.detail)) {
          Object.defineProperty(next, item.detail, { value: {}, enumerable: true });
        }
        const tables = next[item.detail];
        if (!Object.prototype.hasOwnProperty.call(tables, item.kind)) {
          Object.defineProperty(tables, item.kind, { value: [], enumerable: true });
        }
        tables[item.kind].push(item.name);
      }
      setSchema(next);
      setSchemaCount((v) => v + page.items.length);
      setCursor(page.next ?? '');
    });
  const file = async () => {
    if (!vault || locked || !tab) throw 'wrong_binding';
    if (!path.toLowerCase().endsWith('.sql')) throw 'invalid_parameter';
    const client = createVaultClient(vault);
    const identity = documentVaultIdentity(vault)!;
    if (fileAction === 'open') {
      if (tab.dirty) throw 'unresolved_session';
      const document = await client.readDocument(path);
      if (new TextEncoder().encode(document.content).length > 1024 * 1024) throw 'limit_reached';
      const current = useDatabaseQueries.getState().tabs[binding.tab_id];
      if (!current || current.sql !== tab.sql) throw 'unresolved_session';
      updateQuery(binding.tab_id, (t) => ({
        ...t,
        sql: document.content,
        dirty: false,
        script: { vaultId: identity, path, version: document.version, base: document.content },
      }));
    } else {
      let previous = script;
      if (!previous || previous.path !== path || previous.vaultId !== identity) {
        await client.createDocument(path);
        const document = await client.readDocument(path);
        previous = { vaultId: identity, path, version: document.version, base: document.content };
      }
      const saved = await client.writeDocument(path, tab.sql, previous.version, previous.base);
      if (saved.conflict) throw 'script_conflict';
      const nextScript = {
        ...previous,
        version: saved.version,
        base: saved.mergedContent ?? tab.sql,
      };
      updateQuery(binding.tab_id, (t) => ({
        ...t,
        script: nextScript,
        dirty: t.sql !== tab.sql,
        sql: t.sql === tab.sql ? (saved.mergedContent ?? tab.sql) : t.sql,
      }));
      toast.success(saved.offlineQueued ? 'SQL script queued for sync.' : 'SQL script saved.');
    }
    setFileAction(null);
  };
  useEffect(() => {
    if (
      tab &&
      !tab.receiving &&
      status.query_id &&
      sets.length === 0 &&
      (tab.counts.length || tab.messages.length)
    )
      setSet('messages');
  }, [tab, sets.length, status.query_id]);
  if (!tab) return <p className="p-4 text-sm text-muted-foreground">Opening query editor…</p>;
  return (
    <section
      className="flex min-h-0 flex-1 flex-col overflow-y-auto"
      aria-label="SQL query workspace"
    >
      <DocumentToolStrip className="shrink-0 border-b border-border/50">
        <div className={documentTopBarGroupClass}>
          <DocumentTopBarButton
            variant="default"
            disabled={running || retired || editingBusy || !tab.sql.trim()}
            onClick={() => run(false)}
            title="Run (Ctrl+Enter)"
          >
            <Play />
            {maria ? 'Run statement' : 'Run batch'}
          </DocumentTopBarButton>
          <DocumentTopBarButton
            disabled={running || retired || editingBusy || !tab.sql.trim()}
            onClick={() => run(true)}
          >
            Run selection
          </DocumentTopBarButton>
          {running && (
            <DocumentTopBarButton
              disabled={!status.query_id}
              onClick={() => {
                if (status.query_id)
                  void job(() =>
                    tauriCommands.databaseQueryCancel(token, binding, status.query_id!),
                  );
              }}
            >
              <Square /> Cancel query
            </DocumentTopBarButton>
          )}
        </div>
        <div className={documentTopBarGroupClass}>
          <Badge variant="outline">
            {status.phase} · Transaction {status.transaction}
          </Badge>
          {tab.dirty && <Badge variant="secondary">Unsaved SQL</Badge>}
          {status.transaction === 'none' && (
            <DocumentTopBarButton
              disabled={!canControlTransaction}
              onClick={() => void executeQuery(token, binding, undefined, 'begin')}
            >
              Begin transaction
            </DocumentTopBarButton>
          )}
          {status.transaction === 'open' && (
            <DocumentTopBarButton
              disabled={!canControlTransaction}
              onClick={() => setConfirmCommit(true)}
            >
              Commit transaction
            </DocumentTopBarButton>
          )}
          {['open', 'failed'].includes(status.transaction) && (
            <DocumentTopBarButton
              disabled={!canControlTransaction}
              onClick={() => void executeQuery(token, binding, undefined, 'rollback')}
            >
              Roll back transaction
            </DocumentTopBarButton>
          )}
        </div>
        <div className="flex-1" />
        <div className={documentTopBarGroupClass}>
          <DocumentTopBarIconButton
            aria-label="Session history"
            title="Session history"
            disabled={working || running}
            onClick={() =>
              void job(async () =>
                setHistory(await tauriCommands.databaseQueryHistory(token, binding)),
              )
            }
          >
            <History />
          </DocumentTopBarIconButton>
          <DocumentTopBarIconButton
            aria-label="Open .sql"
            title="Open .sql file"
            disabled={working || !vault || locked || running}
            onClick={() => {
              setPath(script?.path ?? 'query.sql');
              setFileAction('open');
            }}
          >
            <FolderOpen />
          </DocumentTopBarIconButton>
          <DocumentTopBarIconButton
            aria-label="Save .sql"
            title="Save as .sql file"
            disabled={working || !vault || locked}
            onClick={() => {
              setPath(script?.path ?? 'query.sql');
              setFileAction('save');
            }}
          >
            <Save />
          </DocumentTopBarIconButton>
          <DocumentTopBarButton
            disabled={working || running || !cursor || schemaCount >= 1000}
            onClick={completion}
            title="Load table and column names for autocompletion"
          >
            Completion schema ({schemaCount})
          </DocumentTopBarButton>
        </div>
      </DocumentToolStrip>
      <div
        className="flex shrink-0 items-center gap-2 overflow-x-auto px-2 pb-2"
        aria-label="Browse table or view"
      >
        <Input
          className="w-28"
          aria-label="Table schema"
          readOnly={maria}
          value={browse.schema}
          onChange={(event) => setBrowse((v) => ({ ...v, schema: event.target.value }))}
        />
        <Input
          className="w-40"
          aria-label="Table or view name"
          placeholder="Table or view"
          value={browse.table}
          onChange={(event) => setBrowse((v) => ({ ...v, table: event.target.value }))}
        />
        <Input
          className="w-36"
          aria-label="Filter column"
          placeholder="Filter column"
          value={browse.filter_column}
          onChange={(event) => setBrowse((v) => ({ ...v, filter_column: event.target.value }))}
        />
        <Input
          className="w-40"
          aria-label="Contains text"
          placeholder="Contains text"
          value={browse.filter_text}
          onChange={(event) => setBrowse((v) => ({ ...v, filter_text: event.target.value }))}
        />
        <Button
          size="sm"
          variant="outline"
          disabled={running || retired || editingBusy || !browse.table || !browse.schema}
          onClick={() =>
            void executeQuery(token, binding, undefined, false, {
              ...browse,
              filter_column: browse.filter_column || null,
            })
          }
        >
          Browse 500 rows
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={
            sqlite?.read_only ||
            !canControlTransaction ||
            status.transaction !== 'none' ||
            !!tab.edit ||
            !browse.table ||
            !browse.schema
          }
          onClick={() =>
            void openTableEdit(token, binding, {
              ...browse,
              filter_column: browse.filter_column || null,
            })
          }
        >
          Edit table rows
        </Button>
        {tab.edit?.visible === false && (
          <Button
            size="sm"
            variant="destructive"
            onClick={() =>
              updateQuery(binding.tab_id, (current) =>
                current.edit ? { ...current, edit: { ...current.edit, visible: true } } : current,
              )
            }
          >
            Review unresolved edit
          </Button>
        )}
      </div>
      {tab.browse && (
        <p className="shrink-0 px-3 pb-1 text-xs text-muted-foreground">
          Browsing {tab.browse.schema}.{tab.browse.table} · up to 500 rows
        </p>
      )}
      <p className="shrink-0 px-3 pb-2 text-xs text-muted-foreground">
        {script?.path ?? 'Untitled SQL'} · Ctrl/Cmd+Enter runs the selection, or the whole script
        when empty.{' '}
        {maria
          ? 'Run one MariaDB statement at a time. DDL may commit an open transaction. Grid editing requires a keyed, trigger-free InnoDB table.'
          : sqlite
            ? 'SQLite statements use semicolons. Result grids are read-only.'
            : 'SQL runs with your account’s permissions. Result grids are read-only. GO separates batches.'}
      </p>
      <div className="flex min-h-36 shrink-0 flex-col" style={{ height: '32%', maxHeight: 420 }}>
        <SqlEditor
          value={tab.sql}
          engine={engine}
          readOnly={running}
          schema={schema}
          handle={editor}
          onRun={() => run(true)}
          onSave={() => {
            if (!vault || locked) {
              toast.error('Open an unlocked vault to save SQL scripts.');
              return;
            }
            setPath(script?.path ?? 'query.sql');
            setFileAction('save');
          }}
          onChange={(value) =>
            updateQuery(binding.tab_id, (t) => ({ ...t, sql: value, dirty: true, error: null }))
          }
        />
      </div>
      {tab.error && (
        <div role="alert" className="shrink-0 px-3 py-2 text-sm text-destructive">
          {databaseQueryError(tab.error.code, engine)}
          {tab.error.server_code !== null && ` Database error ${tab.error.server_code}.`}
          {tab.error.outcome_unknown &&
            ' Outcome unknown. Verify the database before rerunning; no query is replayed automatically.'}
          {tab.error.source && (
            <Button
              size="sm"
              variant="ghost"
              onClick={() =>
                editor.current?.focusRange(
                  tab.error!.source!.start_utf16,
                  tab.error!.source!.end_utf16,
                )
              }
            >
              Show source
            </Button>
          )}
        </div>
      )}
      {tab.reason && tab.reason !== 'complete' && (
        <p role="status" className="shrink-0 px-3 py-2 text-sm text-muted-foreground">
          Stopped: {tab.reason.replace(/_/g, ' ')}. Results may be partial. Cancellation does not
          undo committed statements.
        </p>
      )}
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border/50 p-2">
        <Tabs value={set} onValueChange={setSet}>
          <TabsList aria-label="Query result sets">
            {sets.map((id) => (
              <TabsTrigger key={id} value={id}>
                Result {Number(id) + 1}
              </TabsTrigger>
            ))}
            <TabsTrigger value="messages">
              Messages ({tab.messages.length + tab.counts.length})
            </TabsTrigger>
          </TabsList>
        </Tabs>
        {result && (
          <>
            <span className="text-xs text-muted-foreground">
              {result.rows.length.toLocaleString()} loaded rows
            </span>
            <Button
              size="sm"
              variant="ghost"
              disabled={running || working}
              onClick={() =>
                void job(async () => {
                  await tauriCommands.databaseQueryExport(
                    token,
                    binding,
                    exportResults(result, false),
                    false,
                  );
                })
              }
            >
              Export loaded CSV
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={running || working}
              onClick={() =>
                void job(async () => {
                  await tauriCommands.databaseQueryExport(
                    token,
                    binding,
                    exportResults(result, true),
                    true,
                  );
                })
              }
            >
              Export typed JSON
            </Button>
          </>
        )}
      </div>
      {set === 'messages' ? (
        <div
          className="min-h-0 flex-1 overflow-auto p-3 font-mono text-xs"
          aria-label="Query messages"
        >
          {tab.messages.map((message, index) => (
            <pre key={index} className="whitespace-pre-wrap break-all">
              {message}
            </pre>
          ))}
          {tab.counts.map((count, index) => (
            <p key={`count:${index}`}>{count} rows affected</p>
          ))}
          {tab.messages.length === 0 && tab.counts.length === 0 && (
            <p className="text-muted-foreground">No server messages.</p>
          )}
        </div>
      ) : result ? (
        <ResultGrid key={`${status.query_id}:${set}`} result={result} />
      ) : (
        <p className="p-4 text-sm text-muted-foreground">
          Run SQL to display results. No statements run when a script is opened.
        </p>
      )}
      {tab.edit && tab.edit.visible !== false && (
        <TableEditDialog token={token} binding={binding} draft={tab.edit} />
      )}
      {confirmCommit && (
        <Dialog open onOpenChange={setConfirmCommit}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Commit this session’s transaction?</DialogTitle>
              <DialogDescription>
                Commit pending SQL changes on the pinned session.
                {engine === 'sql_server' &&
                  ' A nested transaction stays open until its outermost level is committed.'}
              </DialogDescription>
            </DialogHeader>
            <Button variant="outline" onClick={() => setConfirmCommit(false)}>
              Keep transaction open
            </Button>
            <Button
              disabled={!canControlTransaction || status.transaction !== 'open'}
              onClick={() => {
                setConfirmCommit(false);
                void executeQuery(token, binding, undefined, 'commit');
              }}
            >
              Confirm commit
            </Button>
          </DialogContent>
        </Dialog>
      )}
      {history && (
        <Dialog
          open
          onOpenChange={(open) => {
            if (!open) setHistory(null);
          }}
        >
          <DialogContent className="max-h-[85vh] overflow-auto">
            <DialogHeader>
              <DialogTitle>Session query history</DialogTitle>
              <DialogDescription>
                Memory only, up to 100 entries / 1 MiB. Selecting an entry loads text without
                executing it. Save or discard current SQL before replacing it.
              </DialogDescription>
            </DialogHeader>
            {history.map((entry, index) => (
              <Button
                key={index}
                variant="ghost"
                className="h-auto justify-start whitespace-pre-wrap break-all text-left font-mono text-xs"
                disabled={tab.dirty || running}
                onClick={() => {
                  updateQuery(binding.tab_id, (t) => ({
                    ...t,
                    sql: entry.sql,
                    dirty: true,
                    script: null,
                  }));
                  setHistory(null);
                }}
              >
                {entry.executed_at}
                <br />
                {entry.sql.slice(0, 500)}
              </Button>
            ))}
            <Button
              variant="outline"
              onClick={() =>
                void job(async () =>
                  setHistory(await tauriCommands.databaseQueryHistory(token, binding, true)),
                )
              }
            >
              Clear history
            </Button>
          </DialogContent>
        </Dialog>
      )}
      {fileAction && (
        <Dialog
          open
          onOpenChange={(open) => {
            if (!open) setFileAction(null);
          }}
        >
          <DialogContent>
            <DialogHeader>
              <DialogTitle>
                {fileAction === 'open' ? 'Open SQL script' : 'Save SQL script'}
              </DialogTitle>
              <DialogDescription>
                Relative to the current vault. SQL text can sync like other files; connection
                secrets, history and results stay local. Opening never executes. Use a new name for
                Save As.
              </DialogDescription>
            </DialogHeader>
            <Field>
              <FieldLabel htmlFor="sql-script-path">Vault relative .sql path</FieldLabel>
              <Input
                id="sql-script-path"
                value={path}
                onChange={(event) => setPath(event.target.value)}
              />
            </Field>
            <Button disabled={working} onClick={() => void job(file)}>
              {fileAction === 'open' ? 'Open script' : 'Save script'}
            </Button>
          </DialogContent>
        </Dialog>
      )}
    </section>
  );
}
