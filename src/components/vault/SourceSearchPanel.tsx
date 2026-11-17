import { useEffect, useState } from 'react';

import { FileCode2, Search } from 'lucide-react';

import { searchSourceFiles, type SourceSearchResult } from '../../lib/sourceSearch';
import { createVaultClient } from '../../lib/vaultClient';
import { useEditorStore } from '../../store/editorStore';
import { useUiStore } from '../../store/uiStore';
import type { VaultMeta } from '../../types/vault';
import { Input } from '../ui/input';

export function SourceSearchPanel({ vault }: { vault: VaultMeta }) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SourceSearchResult[]>([]);
  const [partial, setPartial] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);

  useEffect(() => {
    setResults([]);
    setPartial(false);
    setError(false);
    const ready = query.trim().length >= 2;
    setLoading(ready);
    if (!ready) return;

    const controller = new AbortController();
    const timeout = setTimeout(async () => {
      try {
        const page = await searchSourceFiles(createVaultClient(vault), query, controller.signal);
        if (controller.signal.aborted) return;
        setResults(page.results);
        setPartial(page.partial);
      } catch {
        if (!controller.signal.aborted) setError(true);
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    }, 300);
    return () => {
      controller.abort();
      clearTimeout(timeout);
    };
  }, [query, vault]);

  return (
    <>
      <div className="relative">
        <Search
          aria-hidden
          className="absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground"
        />
        <Input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Escape') setQuery('');
          }}
          placeholder="Search source files"
          aria-label="Search source files"
          maxLength={200}
          className="h-8 pl-8 text-[13px]"
        />
      </div>
      {loading && (
        <p role="status" className="text-xs text-muted-foreground">
          Searching source files…
        </p>
      )}
      {error && (
        <p role="alert" className="text-xs text-destructive">
          Source search failed.
        </p>
      )}
      {partial && (
        <p role="status" className="text-xs text-muted-foreground">
          Some files or matches were skipped because of search limits or file availability.
        </p>
      )}
      {!loading && !error && query.trim().length >= 2 && results.length === 0 && (
        <p className="text-xs text-muted-foreground">No results found</p>
      )}
      <div className="min-h-0 flex-1 overflow-y-auto">
        {results.map(({ relativePath, line, excerpt }) => (
          <button
            key={`${relativePath}:${line}`}
            title={relativePath}
            type="button"
            className="flex w-full flex-col gap-0.5 rounded-lg px-2 py-1.5 text-left hover:bg-sidebar-accent/60 focus-visible:ring-2 focus-visible:ring-ring/50"
            onClick={() => {
              const editor = useEditorStore.getState();
              editor.setPendingSearchJump({ relativePath, line, query: query.trim() });
              editor.openTab(relativePath, relativePath.split('/').pop() ?? relativePath, 'source');
              useUiStore.getState().setActiveView('editor');
            }}
          >
            <span className="flex w-full items-center gap-1.5 text-[13px]">
              <FileCode2 className="size-3.5 shrink-0 text-muted-foreground" />
              <span className="flex-1 truncate">{relativePath}</span>
              <span className="shrink-0 text-xs text-muted-foreground">Line {line}</span>
            </span>
            <span className="line-clamp-2 pl-5 text-xs text-muted-foreground">{excerpt}</span>
          </button>
        ))}
      </div>
    </>
  );
}
