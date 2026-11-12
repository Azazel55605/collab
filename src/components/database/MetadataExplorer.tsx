import { useEffect, useRef, useState } from 'react';

import { databaseError } from '../../lib/databaseErrors';
import { tauriCommands } from '../../lib/tauri';
import type {
  DatabaseBinding,
  DatabaseEngine,
  DatabaseMetadataPage,
  DatabaseMetadataRequest,
} from '../../types/database';
import { Button } from '../ui/button';

export default function MetadataExplorer({
  token,
  connectionId,
  binding,
  onOpen,
  onBrowse,
  engine = 'sql_server',
}: {
  token: string;
  engine?: DatabaseEngine;
  connectionId: string;
  binding: DatabaseBinding | null;
  onOpen: (database: string) => void;
  onBrowse?: (schema: string, table: string) => void;
}) {
  const sqlite = engine === 'sqlite';
  const initial: DatabaseMetadataRequest = !binding
    ? { kind: 'databases', after: '' }
    : engine === 'maria_db'
      ? { kind: 'maria_tables', after: '' }
      : { kind: 'schemas', after: 0 };
  const [trail, setTrail] = useState<{ title: string; request: DatabaseMetadataRequest }[]>([
    {
      title: !binding ? 'Databases' : engine === 'maria_db' ? binding.database : 'Schemas',
      request: initial,
    },
  ]);
  const [page, setPage] = useState<DatabaseMetadataPage | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const sequence = useRef(0);
  const current = trail[trail.length - 1];
  useEffect(() => {
    const version = ++sequence.current;
    setLoading(true);
    setPage(null);
    setError('');
    void tauriCommands
      .databaseMetadata(token, connectionId, binding, current.request)
      .then((result) => {
        if (sequence.current === version) setPage(result);
      })
      .catch((error) => {
        if (sequence.current === version) setError(databaseError(error));
      })
      .finally(() => {
        if (sequence.current === version) setLoading(false);
      });
    return () => {
      sequence.current = version + 1;
    };
  }, [token, connectionId, binding, current]);
  const navigate = (title: string, request: DatabaseMetadataRequest) =>
    setTrail((previous) => [...previous.slice(-19), { title, request }]);
  return (
    <section
      aria-label="Database metadata"
      className="flex min-h-0 flex-1 flex-col gap-3 overflow-auto p-4"
    >
      <div className="flex items-center gap-2">
        <Button
          variant="outline"
          size="sm"
          disabled={trail.length === 1 || loading}
          onClick={() => setTrail((previous) => previous.slice(0, -1))}
        >
          Back
        </Button>
        <h2 className="text-sm font-semibold">{current.title}</h2>
        <Button
          variant="ghost"
          size="sm"
          disabled={loading}
          onClick={() => setTrail((previous) => [...previous.slice(0, -1), { ...current }])}
        >
          Refresh metadata
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        {sqlite
          ? 'Schema objects in the selected SQLite file.'
          : 'Only objects visible to your SQL account are listed.'}{' '}
        Metadata is loaded one page at a time.
      </p>
      {loading && (
        <p role="status" className="text-sm text-muted-foreground">
          Loading metadata…
        </p>
      )}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      {page?.items.length === 0 && (
        <p className="text-sm text-muted-foreground">
          {sqlite
            ? 'No objects in this schema.'
            : 'No visible objects. Your account permissions may hide metadata.'}
        </p>
      )}
      {page && (
        <div className="flex flex-col gap-1">
          {page.items.map((item) => (
            <div
              key={item.id}
              className="flex flex-wrap items-center gap-2 rounded-lg border border-border/50 px-3 py-2"
            >
              <span className="min-w-0 flex-1 break-all text-sm">{item.name}</span>
              <span className="text-xs text-muted-foreground">{item.kind}</span>
              {item.detail && (
                <span className="w-full text-xs text-muted-foreground">{item.detail}</span>
              )}
              {current.request.kind === 'databases' && (
                <Button size="sm" variant="outline" onClick={() => onOpen(item.name)}>
                  Open session
                </Button>
              )}
              {current.request.kind === 'schemas' && (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() =>
                    navigate(item.name, { kind: 'objects', schema_id: Number(item.id), after: 0 })
                  }
                >
                  Browse objects
                </Button>
              )}
              {(current.request.kind === 'objects' || current.request.kind === 'maria_tables') && (
                <>
                  {onBrowse && (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => onBrowse(current.title, item.name)}
                    >
                      Browse rows
                    </Button>
                  )}
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() =>
                      navigate(
                        `${item.name} · Columns`,
                        engine === 'maria_db'
                          ? { kind: 'maria_columns', table: item.name, after: 0 }
                          : { kind: 'columns', object_id: Number(item.id), after: 0 },
                      )
                    }
                  >
                    Columns
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() =>
                      navigate(
                        `${item.name} · Indexes`,
                        engine === 'maria_db'
                          ? { kind: 'maria_indexes', table: item.name, after: '' }
                          : { kind: 'indexes', object_id: Number(item.id), after: 0 },
                      )
                    }
                  >
                    Indexes
                  </Button>
                </>
              )}
            </div>
          ))}
        </div>
      )}
      {page?.next && (
        <Button
          className="self-start"
          variant="outline"
          disabled={loading}
          onClick={() => {
            const next = page.next!;
            navigate(current.title, {
              ...current.request,
              after: typeof current.request.after === 'string' ? next : Number(next),
            } as DatabaseMetadataRequest);
          }}
        >
          Next page
        </Button>
      )}
    </section>
  );
}
