import { useCallback, useEffect, useRef, useState } from 'react';

import { syntaxTree } from '@codemirror/language';
import type { EditorState } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';
import { Braces, ChevronsUpDown, X } from 'lucide-react';

import { Button } from '../ui/button';

import { revealSourceRange, type SourceSymbol, sourceSymbols } from './sourceEditorTools';

export function useSourceOutline(view: React.RefObject<EditorView | null>, open: boolean) {
  const [symbols, setSymbols] = useState<SourceSymbol[]>([]);
  const last = useRef<EditorState | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const refresh = useCallback(
    (editor: EditorView) => {
      if (!open) return;
      const previous = last.current;
      if (previous?.doc === editor.state.doc && syntaxTree(previous) === syntaxTree(editor.state))
        return;
      last.current = editor.state;
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setSymbols(sourceSymbols(editor.state)), 180);
    },
    [open],
  );

  useEffect(() => {
    last.current = null;
    if (view.current) refresh(view.current);
    return () => clearTimeout(timer.current);
  }, [refresh, view]);

  return { symbols, refresh };
}

export function SourceOutline({
  symbols,
  editor,
  onClose,
}: {
  symbols: SourceSymbol[];
  editor: React.RefObject<EditorView | null>;
  onClose: () => void;
}) {
  return (
    <aside
      aria-label="Source outline"
      className="flex w-48 shrink-0 flex-col border-l bg-background sm:w-56"
    >
      <div className="flex items-center gap-1 border-b px-2 py-1">
        <ChevronsUpDown aria-hidden className="size-3.5 text-muted-foreground" />
        <h2 className="flex-1 text-xs font-medium">Outline</h2>
        <Button variant="ghost" size="icon-sm" aria-label="Close outline" onClick={onClose}>
          <X />
        </Button>
      </div>
      <div className="min-h-0 overflow-y-auto p-1">
        {symbols.length === 0 && (
          <p className="p-2 text-xs text-muted-foreground">No symbols found</p>
        )}
        {symbols.map(({ name, line, from, to }) => (
          <button
            key={from}
            type="button"
            title={name}
            className="flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-left text-xs hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring"
            onClick={() => {
              if (editor.current) revealSourceRange(editor.current, from, to);
            }}
          >
            <Braces aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
            <span className="flex-1 truncate font-mono">{name}</span>
            <span className="text-muted-foreground">{line}</span>
          </button>
        ))}
      </div>
    </aside>
  );
}
