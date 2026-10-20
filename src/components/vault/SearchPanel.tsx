import { useEffect, useState } from 'react';

import { Search } from 'lucide-react';

import { documentVaultIdentity } from '../../lib/documentPaneContext';
import { cn } from '../../lib/utils';
import { createVaultClient } from '../../lib/vaultClient';
import { useEditorStore } from '../../store/editorStore';
import { useNoteIndexStore } from '../../store/noteIndexStore';
import { useUiStore } from '../../store/uiStore';
import { useVaultStore } from '../../store/vaultStore';
import type { SearchResult } from '../../types/note';
import { Button } from '../ui/button';
import { Input } from '../ui/input';

export default function SearchPanel() {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchResult[]>([]);
  const vault = useVaultStore((state) => state.vault);
  const locked = useVaultStore((state) => state.isVaultLocked);
  const openTab = useEditorStore((state) => state.openTab);
  const setPendingSearchJump = useEditorStore((state) => state.setPendingSearchJump);
  const setActiveView = useUiStore((state) => state.setActiveView);
  const notes = useNoteIndexStore((state) => state.notes);
  const indexing = useNoteIndexStore((state) => state.isIndexing);
  const indexedCount = useNoteIndexStore((state) => state.indexedCount);
  const [offset, setOffset] = useState(0);
  const [total, setTotal] = useState(0);
  const [nextOffset, setNextOffset] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const scope = vault ? documentVaultIdentity(vault) : null;
  useEffect(() => {
    setOffset(0);
  }, [query, scope, notes]);

  useEffect(() => {
    if (!vault || locked || query.length < 2) {
      setResults([]);
      setTotal(0);
      setNextOffset(null);
      setLoading(false);
      setError(null);
      return;
    }
    let cancelled = false;
    setResults([]);
    setTotal(0);
    setNextOffset(null);
    setError(null);
    setLoading(true);
    const t = setTimeout(async () => {
      try {
        const client = createVaultClient(vault);
        const page = client.searchPage
          ? await client.searchPage(query, offset, 50)
          : await client.search(query).then((rows) => ({
              results: rows.slice(offset, offset + 50),
              total: rows.length,
              nextOffset: offset + 50 < rows.length ? offset + 50 : null,
            }));
        if (!cancelled) {
          setResults(page.results);
          setTotal(page.total);
          setNextOffset(page.nextOffset);
        }
      } catch {
        if (!cancelled) {
          setResults([]);
          setError('Search failed. Please try again.');
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [query, scope, locked, offset, notes]);

  return (
    <div className="flex flex-col h-full p-2 gap-2">
      <div className="relative">
        <Search
          size={14}
          className="absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground"
        />
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search notes..."
          className="pl-7 h-8 text-sm"
        />
      </div>
      {indexing && (
        <p role="status" className="text-xs text-muted-foreground">
          Updating search index… {indexedCount} notes
        </p>
      )}
      <div className="flex-1 overflow-y-auto space-y-1">
        {results.map((r) => (
          <button
            key={r.relativePath}
            onClick={() => {
              setPendingSearchJump({ relativePath: r.relativePath, query });
              openTab(r.relativePath, r.title, 'note');
              setActiveView('editor');
            }}
            className={cn(
              'w-full rounded-xl border border-border/40 bg-card/20 px-2.5 py-2 text-left text-sm transition-colors app-motion-fast',
              'hover:border-border hover:bg-accent/30',
            )}
          >
            <div className="font-medium truncate">{r.title}</div>
            <div className="text-xs text-muted-foreground truncate">{r.excerpt}</div>
          </button>
        ))}
        {loading && (
          <p role="status" className="text-xs text-muted-foreground">
            Searching…
          </p>
        )}
        {error && (
          <p role="alert" className="text-xs text-destructive">
            {error}
          </p>
        )}
        {!indexing && !loading && !error && query.length >= 2 && results.length === 0 && (
          <p className="rounded-lg border border-border/40 bg-card/20 px-3 py-2 text-xs text-muted-foreground app-panel-enter">
            No results found
          </p>
        )}
      </div>
      {total > 0 && (
        <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
          <Button
            variant="ghost"
            size="sm"
            disabled={loading || offset === 0}
            onClick={() => setOffset(Math.max(0, offset - 50))}
          >
            Previous
          </Button>
          <span>
            {offset + 1}–{Math.min(offset + 50, total)} of {total}
          </span>
          <Button
            variant="ghost"
            size="sm"
            disabled={loading || nextOffset === null}
            onClick={() => nextOffset !== null && setOffset(nextOffset)}
          >
            Next
          </Button>
        </div>
      )}
    </div>
  );
}
