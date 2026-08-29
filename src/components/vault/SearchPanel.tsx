import { useEffect, useState } from 'react';

import { Search } from 'lucide-react';

import { cn } from '../../lib/utils';
import { createVaultClient } from '../../lib/vaultClient';
import { useEditorStore } from '../../store/editorStore';
import { useUiStore } from '../../store/uiStore';
import { useVaultStore } from '../../store/vaultStore';
import type { SearchResult } from '../../types/note';
import { Input } from '../ui/input';

export default function SearchPanel() {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchResult[]>([]);
  const { vault } = useVaultStore();
  const { openTab, setPendingSearchJump } = useEditorStore();
  const { setActiveView } = useUiStore();

  useEffect(() => {
    if (!vault || query.length < 2) {
      setResults([]);
      return;
    }
    const t = setTimeout(async () => {
      try {
        const r = await createVaultClient(vault).search(query);
        setResults(r);
      } catch {}
    }, 300);
    return () => clearTimeout(t);
  }, [query, vault?.path]);

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
              'app-list-item-enter',
              'hover:border-border hover:bg-accent/30',
            )}
          >
            <div className="font-medium truncate">{r.title}</div>
            <div className="text-xs text-muted-foreground truncate">{r.excerpt}</div>
          </button>
        ))}
        {query.length >= 2 && results.length === 0 && (
          <p className="rounded-lg border border-border/40 bg-card/20 px-3 py-2 text-xs text-muted-foreground app-panel-enter">
            No results found
          </p>
        )}
      </div>
    </div>
  );
}
