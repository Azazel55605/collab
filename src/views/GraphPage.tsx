import { memo, useCallback, useState } from 'react';

import { Waypoints } from 'lucide-react';

import GraphView from '../components/graph/GraphView';
import { DocumentTopBar } from '../components/layout/DocumentTopBar';
import { cn } from '../lib/utils';
import { useEditorStore } from '../store/editorStore';
import { useNoteIndexStore } from '../store/noteIndexStore';
import { useUiStore } from '../store/uiStore';
import type { NoteMetadata } from '../types/note';

interface Props {
  /** Override node-click behaviour — grid cells use this to load the note into the same cell */
  onNodeClick?: (relativePath: string, title: string) => void;
}

function GraphPage({ onNodeClick }: Props = {}) {
  const notes = useNoteIndexStore((state) => state.notes);
  const openTab = useEditorStore((state) => state.openTab);
  const setActiveView = useUiStore((state) => state.setActiveView);

  const defaultNodeClick = useCallback(
    (relativePath: string, title: string) => {
      openTab(relativePath, title, 'note');
      setActiveView('editor');
    },
    [openTab, setActiveView],
  );

  const handleNodeClick = onNodeClick ?? defaultNodeClick;

  // Inside a grid cell the cell header names the view; standalone it gets the shared header.
  if (onNodeClick) {
    return (
      <div className="w-full h-full app-fade-slide-in">
        <GraphView notes={notes} onNodeClick={handleNodeClick} />
      </div>
    );
  }
  return <StandaloneGraph notes={notes} onNodeClick={handleNodeClick} />;
}

function StandaloneGraph({
  notes,
  onNodeClick,
}: {
  notes: NoteMetadata[];
  onNodeClick: (relativePath: string, title: string) => void;
}) {
  const activeTabPath = useEditorStore((state) => state.activeTabPath);
  const activeNote = notes.find((note) => note.relativePath === activeTabPath) ?? null;
  // null = whole vault; otherwise the note whose neighbourhood is shown.
  const [focusPath, setFocusPath] = useState<string | null>(null);
  const focusNote = notes.find((note) => note.relativePath === focusPath) ?? null;
  const aroundTarget = focusNote ?? activeNote;

  return (
    <div className="flex h-full w-full flex-col app-fade-slide-in">
      <DocumentTopBar
        title="Graph"
        subtitle={focusNote ? `Around ${focusNote.title}` : 'Whole vault'}
        icon={<Waypoints />}
        status={
          <span className="text-xs text-muted-foreground">
            {notes.length} {notes.length === 1 ? 'note' : 'notes'}
          </span>
        }
        meta={
          <div
            role="group"
            aria-label="Graph scope"
            className="flex rounded-lg border border-border/70 bg-muted/40 p-0.5"
          >
            {(
              [
                ['vault', 'Whole vault'],
                ['note', 'Around this note'],
              ] as const
            ).map(([scope, label]) => {
              const active = scope === 'vault' ? !focusPath : Boolean(focusPath);
              return (
                <button
                  key={scope}
                  type="button"
                  aria-pressed={active}
                  disabled={scope === 'note' && !aroundTarget}
                  title={
                    scope === 'note' && !aroundTarget
                      ? 'Open a note first, or pick one in the graph'
                      : undefined
                  }
                  onClick={() =>
                    setFocusPath(scope === 'vault' ? null : (aroundTarget?.relativePath ?? null))
                  }
                  className={cn(
                    'h-7 rounded-md px-2.5 text-[13px] text-muted-foreground transition-colors app-motion-base outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50',
                    active && 'bg-background text-foreground shadow-sm',
                  )}
                >
                  {label}
                </button>
              );
            })}
          </div>
        }
      />
      <div className="min-h-0 flex-1">
        <GraphView
          notes={notes}
          onNodeClick={onNodeClick}
          focusPath={focusPath}
          onFocus={setFocusPath}
        />
      </div>
    </div>
  );
}

export default memo(GraphPage);
