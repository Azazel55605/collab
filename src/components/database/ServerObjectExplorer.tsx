import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react';

import {
  ChevronDown,
  ChevronRight,
  Database,
  FileCode2,
  Folder,
  RefreshCw,
  Server,
  Table2,
} from 'lucide-react';

import { databaseError } from '../../lib/databaseErrors';
import { tauriCommands } from '../../lib/tauri';
import type { DatabaseMetadataItem, DatabaseMetadataRequest } from '../../types/database';
import { Button } from '../ui/button';

interface Scope {
  token: string;
  connectionId: string;
  catalog?: string;
  refreshVersion: string;
  schedule: (task: () => Promise<void>) => void;
}
type Kind = 'databases' | 'schemas' | 'objects' | 'columns' | 'indexes';

interface LoadedMetadata {
  items: DatabaseMetadataItem[];
  next: string | null;
  pages: number;
  version: string;
  key: string;
}

function requestFor(kind: Kind, parent: number, cursor: string | null): DatabaseMetadataRequest {
  if (kind === 'databases') return { kind, after: cursor ?? '' };
  const after = Number(cursor ?? 0);
  if (kind === 'objects') return { kind, schema_id: parent, after };
  if (kind === 'schemas') return { kind, after };
  return { kind, object_id: parent, after };
}

function MetadataList({
  token,
  connectionId,
  catalog,
  refreshVersion,
  schedule,
  kind,
  parent = 0,
  renderItem,
}: Scope & {
  kind: Kind;
  parent?: number;
  renderItem: (item: DatabaseMetadataItem, loadedVersion: string) => ReactNode;
}) {
  const [data, setData] = useState<LoadedMetadata>({
    items: [],
    next: null,
    pages: 0,
    version: '',
    key: '',
  });
  const lastLoaded = useRef(data);
  const [pageCount, setPageCount] = useState(1);
  const [attempt, setAttempt] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    setLoading(true);
    setError('');
    const key = JSON.stringify([token, connectionId, catalog, kind, parent, refreshVersion]);
    schedule(async () => {
      if (!active) return;
      const cached = lastLoaded.current;
      let current =
        cached.key === key
          ? cached
          : { items: [], next: null, pages: 0, version: refreshVersion, key };
      try {
        // On refresh, replay the pages already loaded with fresh cursors. Keep
        // the old branches mounted until the replacement list is ready.
        while (current.pages < pageCount && (current.pages === 0 || current.next)) {
          const request = requestFor(kind, parent, current.next);
          const page = catalog
            ? await tauriCommands.databaseMetadata(token, connectionId, null, request, catalog)
            : await tauriCommands.databaseMetadata(token, connectionId, null, request);
          if (!active) return;
          const items = new Map(current.items.map((item) => [item.id, item]));
          for (const item of page.items) items.set(item.id, item);
          current = {
            ...current,
            items: [...items.values()],
            next: page.next,
            pages: current.pages + 1,
          };
        }
        lastLoaded.current = current;
        setData(current);
      } catch (reason) {
        if (active) setError(databaseError(reason));
      } finally {
        if (active) setLoading(false);
      }
    });
    return () => {
      active = false;
    };
  }, [attempt, catalog, connectionId, kind, pageCount, parent, refreshVersion, schedule, token]);

  const { items, next, version } = data;
  return (
    <ul className="ms-3 space-y-0.5 border-s border-border/60 ps-2">
      {items.map((item) => (
        <li key={item.id}>{renderItem(item, version)}</li>
      ))}
      {loading ? (
        <li role="status" className="py-1 text-xs text-muted-foreground">
          Loading…
        </li>
      ) : null}
      {error ? (
        <li className="break-words py-1 text-xs">
          <p role="alert" className="text-destructive">
            {error}
          </p>
          <Button size="xs" variant="ghost" onClick={() => setAttempt((value) => value + 1)}>
            Retry
          </Button>
        </li>
      ) : !loading && items.length === 0 ? (
        <li className="py-1 text-xs text-muted-foreground">No visible {kind}.</li>
      ) : null}
      {!loading && !error && next ? (
        <li>
          <Button size="xs" variant="ghost" onClick={() => setPageCount(data.pages + 1)}>
            Load more {kind}
          </Button>
        </li>
      ) : null}
    </ul>
  );
}

function Branch({
  label,
  icon,
  detail,
  action,
  children,
}: {
  label: string;
  icon: ReactNode;
  detail?: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  const [expanded, setExpanded] = useState(false);
  const Chevron = expanded ? ChevronDown : ChevronRight;
  return (
    <>
      <div className="flex min-w-0 items-center gap-0.5">
        <Button
          size="xs"
          variant="ghost"
          aria-expanded={expanded}
          title={detail ? `${label} · ${detail}` : label}
          className="min-w-0 flex-1 justify-start gap-1.5 px-1"
          onClick={() => setExpanded((value) => !value)}
        >
          <Chevron className="text-muted-foreground" />
          {icon}
          <span className="truncate">{label}</span>
        </Button>
        {action}
      </div>
      {expanded ? children : null}
    </>
  );
}

function ObjectBranch({ scope, item }: { scope: Scope; item: DatabaseMetadataItem }) {
  return (
    <Branch
      label={item.name}
      detail={item.kind}
      icon={<Table2 className="text-muted-foreground" />}
    >
      <ul className="ms-3 space-y-0.5 border-s border-border/60 ps-2">
        {(['columns', 'indexes'] as const).map((kind) => (
          <li key={kind}>
            <Branch
              label={kind === 'columns' ? 'Columns' : 'Indexes'}
              icon={<Folder className="text-muted-foreground" />}
            >
              <MetadataList
                {...scope}
                kind={kind}
                parent={Number(item.id)}
                renderItem={(detail) => (
                  <div className="break-words py-1 text-xs">
                    {detail.name}
                    <span className="block text-muted-foreground">
                      {[detail.kind, detail.detail].filter(Boolean).join(' · ')}
                    </span>
                  </div>
                )}
              />
            </Branch>
          </li>
        ))}
      </ul>
    </Branch>
  );
}

export default function ServerObjectExplorer({
  token,
  connectionId,
  label,
  revision,
  onOpen,
  busy,
}: Pick<Scope, 'token' | 'connectionId'> & {
  label: string;
  revision: number;
  onOpen: (database: string) => void;
  busy: boolean;
}) {
  const [refresh, setRefresh] = useState(0);
  const pending = useRef(Promise.resolve());
  const schedule = useCallback((task: () => Promise<void>) => {
    // Each catalog request can open a short-lived database connection.
    pending.current = pending.current.then(task);
  }, []);
  return (
    <section aria-label="Server objects" className="space-y-1">
      <div className="flex min-w-0 items-center gap-2">
        <Server className="size-4 shrink-0 text-primary" aria-hidden />
        <h2 className="min-w-0 flex-1 truncate text-xs font-semibold" title={label}>
          {label}
        </h2>
        <Button
          size="icon-xs"
          variant="ghost"
          aria-label="Refresh server objects"
          title="Refresh server objects"
          onClick={() => setRefresh((value) => value + 1)}
        >
          <RefreshCw />
        </Button>
      </div>
      <MetadataList
        refreshVersion={`${revision}:${refresh}`}
        schedule={schedule}
        token={token}
        connectionId={connectionId}
        kind="databases"
        renderItem={(database, version) => {
          const scope = {
            token,
            connectionId,
            catalog: database.name,
            refreshVersion: version,
            schedule,
          };
          return (
            <Branch
              label={database.name}
              icon={<Database className="text-primary/75" />}
              action={
                <Button
                  size="icon-xs"
                  variant="ghost"
                  aria-label={`New query in ${database.name}`}
                  title={`New query in ${database.name}`}
                  disabled={busy}
                  onClick={() => onOpen(database.name)}
                >
                  <FileCode2 />
                </Button>
              }
            >
              <MetadataList
                {...scope}
                kind="schemas"
                renderItem={(schema, version) => (
                  <Branch label={schema.name} icon={<Folder className="text-muted-foreground" />}>
                    <MetadataList
                      {...scope}
                      refreshVersion={version}
                      kind="objects"
                      parent={Number(schema.id)}
                      renderItem={(item, version) => (
                        <ObjectBranch scope={{ ...scope, refreshVersion: version }} item={item} />
                      )}
                    />
                  </Branch>
                )}
              />
            </Branch>
          );
        }}
      />
    </section>
  );
}
