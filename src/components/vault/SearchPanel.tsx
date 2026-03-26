import { useState, useEffect } from 'react';
import { Search } from 'lucide-react';
import { Input } from '../ui/input';
import { useVaultStore } from '../../store/vaultStore';
import { useEditorStore } from '../../store/editorStore';
import { useUiStore } from '../../store/uiStore';
import { tauriCommands } from '../../lib/tauri';
import type { SearchResult } from '../../types/note';

export default function SearchPanel() {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchResult[]>([]);
  const { vault } = useVaultStore();
  const { openTab } = useEditorStore();
  const { setActiveView } = useUiStore();

  useEffect(() => {
    if (!vault || query.length < 2) {
      setResults([]);
      return;
    }
    const t = setTimeout(async () => {
      try {
        const r = await tauriCommands.searchNotes(vault.path, query);
        setResults(r);
      } catch {}
    }, 300);
    return () => clearTimeout(t);
  }, [query, vault?.path]);

  return (
    <div className="flex flex-col h-full p-2 gap-2">
      <div className="relative">
        <Search size={14} className="absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground" />
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
              openTab(r.relativePath, r.title, 'note');
              setActiveView('editor');
            }}
            className="w-full text-left px-2 py-1.5 rounded hover:bg-accent text-sm"
          >
            <div className="font-medium truncate">{r.title}</div>
            <div className="text-xs text-muted-foreground truncate">{r.excerpt}</div>
          </button>
        ))}
        {query.length >= 2 && results.length === 0 && (
          <p className="text-xs text-muted-foreground px-2">No results found</p>
        )}
      </div>
    </div>
  );
}
