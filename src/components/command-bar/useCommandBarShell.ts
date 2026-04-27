import { useCallback, useEffect, useState } from 'react';

import { tauriCommands } from '../../lib/tauri';
import { completeNerdFontIconQuery } from '../../lib/nerdFontIcons';
import { useEditorStore } from '../../store/editorStore';
import { useNoteIndexStore } from '../../store/noteIndexStore';
import { useUiStore } from '../../store/uiStore';
import { useVaultStore } from '../../store/vaultStore';
import type { SearchResult } from '../../types/note';
import type { RenderCtx } from './commandBarActions';
import { detectMode, flattenFiles } from './commandBarUtils';
import { completeInsertQuery } from './snippets';

export function useCommandBarShell() {
  const [open, setOpen] = useState(false);
  const [input, setInput] = useState('');
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);

  const { vault, fileTree, refreshFileTree } = useVaultStore();
  const { notes } = useNoteIndexStore();
  const { openTab } = useEditorStore();
  const { activeView, setActiveView, openSettings, dateFormat } = useUiStore();

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && (event.key === 'k' || event.key === 'p')) {
        event.preventDefault();
        setOpen((current) => !current);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  useEffect(() => {
    const handler = (event: Event) => {
      const prefill = (event as CustomEvent<{ input?: string }>).detail?.input ?? '';
      setInput(prefill);
      setOpen(true);
    };
    window.addEventListener('cmdbar:open', handler);
    return () => window.removeEventListener('cmdbar:open', handler);
  }, []);

  useEffect(() => {
    if (!open) {
      setInput('');
      setSearchResults([]);
    }
  }, [open]);

  useEffect(() => {
    const mode = detectMode(input);
    if (mode.type !== 'search' || !vault || !mode.query) {
      setSearchResults([]);
      return;
    }
    const timer = window.setTimeout(async () => {
      try {
        const results = await tauriCommands.searchNotes(vault.path, mode.query);
        setSearchResults(results);
      } catch {
        // Silent fallback keeps the command bar responsive if IPC search fails.
      }
    }, 300);
    return () => window.clearTimeout(timer);
  }, [input, vault]);

  const close = useCallback(() => setOpen(false), []);

  const mode = detectMode(input);
  const files = flattenFiles(fileTree);
  const insertCompletion = mode.type === 'insert'
    ? (completeInsertQuery(mode.query) ?? completeNerdFontIconQuery(mode.query))
    : null;

  const ctx: RenderCtx = {
    notes,
    files,
    searchResults,
    activeView,
    vault,
    dateFormat,
    openTab,
    setActiveView,
    openSettings,
    refreshFileTree,
    setInput,
    close,
  };

  return {
    open,
    setOpen,
    input,
    setInput,
    mode,
    insertCompletion,
    ctx,
  };
}
