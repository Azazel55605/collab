import { useEffect, useState } from 'react';

import { ChevronDown, FileText, Folder as FolderIcon, Search } from 'lucide-react';

import { documentVaultIdentity } from '../../lib/documentPaneContext';
import { cn } from '../../lib/utils';
import { createVaultClient } from '../../lib/vaultClient';
import { useEditorStore } from '../../store/editorStore';
import { useNoteIndexStore } from '../../store/noteIndexStore';
import { useUiStore } from '../../store/uiStore';
import { useVaultStore } from '../../store/vaultStore';
import type { SearchResult } from '../../types/note';
import { Button } from '../ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '../ui/dropdown-menu';
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
  const [folder, setFolder] = useState<string | null>(null);
  const scope = vault ? documentVaultIdentity(vault) : null;
  useEffect(() => {
    setOffset(0);
    setFolder(null);
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

  const folderOf = (path: string) => {
    const index = path.lastIndexOf('/');
    return index === -1 ? '' : path.slice(0, index);
  };
  const folders = [...new Set(results.map((r) => folderOf(r.relativePath)))].sort();
  const shown =
    folder === null ? results : results.filter((r) => folderOf(r.relativePath) === folder);

  return (
    <div className="flex h-full flex-col gap-2 px-2.5 pb-2">
      <div className="relative">
        <Search
          size={14}
          className="absolute top-1/2 left-2.5 -translate-y-1/2 text-muted-foreground"
        />
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') setQuery('');
          }}
          placeholder="Search notes"
          aria-label="Search notes"
          className="h-8 pl-8 text-[13px]"
        />
      </div>
      {results.length > 0 && folders.length > 1 && (
        <div className="flex flex-wrap items-center gap-1.5">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                className={cn(
                  'flex h-6 items-center gap-1 rounded-full border px-2.5 text-[11.5px] transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring/50',
                  folder === null
                    ? 'border-border text-muted-foreground hover:bg-muted hover:text-foreground'
                    : 'border-primary/50 bg-primary/15 font-medium text-foreground',
                )}
              >
                <FolderIcon className="size-3" />
                {folder === null ? 'Any folder' : folder || 'Vault root'}
                <ChevronDown className="size-3" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="max-h-72 w-56 overflow-y-auto">
              <DropdownMenuItem onSelect={() => setFolder(null)}>Any folder</DropdownMenuItem>
              {folders.map((name) => (
                <DropdownMenuItem key={name} onSelect={() => setFolder(name)}>
                  <span className="truncate">{name || 'Vault root'}</span>
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
          {folder !== null && (
            <button
              type="button"
              onClick={() => setFolder(null)}
              className="text-[11.5px] text-muted-foreground hover:text-foreground"
            >
              Clear
            </button>
          )}
        </div>
      )}
      {indexing && (
        <p role="status" className="text-xs text-muted-foreground">
          Updating search index… {indexedCount} notes
        </p>
      )}
      {total > 0 && (
        <p className="px-1 text-[11.5px] text-muted-foreground">
          {total} result{total === 1 ? '' : 's'}
          {folder !== null && ` · ${shown.length} in this folder on this page`}
        </p>
      )}
      <div className="-mx-1 flex-1 space-y-0.5 overflow-y-auto">
        {shown.map((r) => (
          <button
            key={r.relativePath}
            onClick={() => {
              setPendingSearchJump({ relativePath: r.relativePath, query });
              openTab(r.relativePath, r.title, 'note');
              setActiveView('editor');
            }}
            className="flex w-full flex-col gap-0.5 rounded-lg px-2 py-1.5 text-left transition-colors app-motion-fast outline-none hover:bg-sidebar-accent/60 focus-visible:ring-2 focus-visible:ring-ring/50"
          >
            <span className="flex min-w-0 items-center gap-1.5 text-[13px]">
              <FileText className="size-3.5 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate font-medium">
                <Highlighted text={r.title} query={query} />
              </span>
              {folderOf(r.relativePath) && (
                <span className="max-w-[40%] shrink-0 truncate text-[11px] text-muted-foreground">
                  {folderOf(r.relativePath)}
                </span>
              )}
            </span>
            {r.excerpt && (
              <span className="line-clamp-2 pl-5 text-xs leading-snug text-muted-foreground">
                <Highlighted text={r.excerpt} query={query} />
              </span>
            )}
          </button>
        ))}
        {loading && (
          <p role="status" className="px-1 text-xs text-muted-foreground">
            Searching…
          </p>
        )}
        {error && (
          <p role="alert" className="px-1 text-xs text-destructive">
            {error}
          </p>
        )}
        {!indexing && !loading && !error && query.length >= 2 && results.length === 0 && (
          <p className="px-1 py-2 text-xs text-muted-foreground app-panel-enter">
            No results found
          </p>
        )}
      </div>
      {total > 50 && (
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

/** `text` with every case-insensitive occurrence of `query` marked. */
function Highlighted({ text, query }: { text: string; query: string }) {
  const needle = query.trim();
  if (needle.length < 2) return <>{text}</>;
  const lower = text.toLocaleLowerCase();
  const target = needle.toLocaleLowerCase();
  const parts: React.ReactNode[] = [];
  let from = 0;
  let index = lower.indexOf(target);
  while (index !== -1) {
    if (index > from) parts.push(text.slice(from, index));
    parts.push(
      <mark key={index} className="rounded-sm bg-primary/25 px-0.5 text-foreground">
        {text.slice(index, index + needle.length)}
      </mark>,
    );
    from = index + needle.length;
    index = lower.indexOf(target, from);
  }
  if (from < text.length) parts.push(text.slice(from));
  return <>{parts}</>;
}
