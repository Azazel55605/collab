import { useState, useMemo, useCallback, useRef } from 'react';
import {
  DndContext,
  DragOverlay,
  closestCorners,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent,
  type CollisionDetection,
} from '@dnd-kit/core';
import { SortableContext, horizontalListSortingStrategy, arrayMove } from '@dnd-kit/sortable';
import { Plus, LayoutDashboard, CalendarDays, GanttChart, Archive, ArchiveRestore } from 'lucide-react';
import { cn } from '../../lib/utils';
import { useKanbanContext } from '../../views/KanbanPage';
import { useCollabStore } from '../../store/collabStore';
import KanbanColumnView from './KanbanColumn';
import KanbanCardView from './KanbanCard';
import CalendarView from './CalendarView';
import TimelineView from './TimelineView';
import type { KanbanCard, KanbanColumn } from '../../types/kanban';

// ── Archive panel ─────────────────────────────────────────────────────────────

function ArchivePanel() {
  const { board, updateBoard } = useKanbanContext();

  const archivedGroups = board.columns
    .map(col => ({
      col,
      cards: col.cards.filter(c => c.archived),
    }))
    .filter(g => g.cards.length > 0);

  const totalArchived = archivedGroups.reduce((n, g) => n + g.cards.length, 0);

  function restoreCard(cardId: string, columnId: string) {
    updateBoard(prev => ({
      ...prev,
      columns: prev.columns.map(col =>
        col.id !== columnId ? col : {
          ...col,
          cards: col.cards.map(c =>
            c.id !== cardId ? c : { ...c, archived: undefined, archivedColumnId: undefined },
          ),
        },
      ),
    }));
  }

  return (
    <div className="border-t border-border/30 bg-muted/10 shrink-0 max-h-64 overflow-y-auto">
      <div className="flex items-center gap-2 px-4 py-2 border-b border-border/20 sticky top-0 bg-background/80 backdrop-blur-sm">
        <Archive size={12} className="text-muted-foreground" />
        <span className="text-xs font-medium text-muted-foreground">
          Archive — {totalArchived} {totalArchived === 1 ? 'card' : 'cards'}
        </span>
      </div>
      {totalArchived === 0 ? (
        <p className="text-xs text-muted-foreground/50 px-4 py-3">No archived cards.</p>
      ) : (
        <div className="p-4 flex flex-col gap-4">
          {archivedGroups.map(({ col, cards }) => (
            <div key={col.id}>
              <div className="flex items-center gap-1.5 mb-2">
                <div className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: col.color ?? '#64748b' }} />
                <span className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wide">{col.title}</span>
              </div>
              <div className="flex flex-col gap-1">
                {cards.map(card => (
                  <div
                    key={card.id}
                    className="flex items-center gap-2 px-2.5 py-1.5 rounded-md bg-card/40 border border-border/30 text-xs"
                  >
                    <span className="flex-1 truncate text-muted-foreground">{card.title}</span>
                    <button
                      onClick={() => restoreCard(card.id, col.id)}
                      className="flex items-center gap-1 shrink-0 text-[10px] text-muted-foreground/60 hover:text-foreground hover:bg-accent/50 px-1.5 py-0.5 rounded transition-colors"
                      title="Restore to column"
                    >
                      <ArchiveRestore size={10} />
                      Restore
                    </button>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Main board ────────────────────────────────────────────────────────────────

export default function KanbanBoardView() {
  const { board, updateBoard, relativePath } = useKanbanContext();
  const { peers } = useCollabStore();
  const [view, setView] = useState<'board' | 'calendar' | 'timeline'>('board');
  const [activeCard,   setActiveCard]   = useState<KanbanCard | null>(null);
  const [activeColumn, setActiveColumn] = useState<KanbanColumn | null>(null);
  const [addingColumn, setAddingColumn] = useState(false);
  const [newColTitle, setNewColTitle] = useState('');
  const [showArchive, setShowArchive] = useState(false);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
  );

  // Peers viewing this same board
  const boardPeers = useMemo(
    () => peers.filter(p => p.activeFile === relativePath),
    [peers, relativePath],
  );

  // Track which column the dragged card started in so we can apply autoComplete
  // correctly even after onDragOver has already moved the card cross-column.
  const dragStartColRef = useRef<string | null>(null);

  // Track the last droppable the pointer was over so we don't call updateBoard
  // on every mouse-move event — only when the cursor actually crosses to a
  // different droppable.  onDragOver fires at pointer-move frequency (60+ Hz)
  // but over.id only changes when entering a new droppable region.
  const lastOverIdRef = useRef<string | null>(null);

  // Custom collision detection: when dragging a COLUMN, restrict candidates to
  // other columns only.  Without this, closestCorners may return a card ID
  // (which is "closer" by bounding-rect math) — the horizontal SortableContext
  // can't find that ID in its column list and produces no animation transform.
  const collisionDetection: CollisionDetection = useCallback((args) => {
    if (activeColumn) {
      const colIds = new Set(board.columns.map(c => c.id));
      return closestCorners({
        ...args,
        droppableContainers: args.droppableContainers.filter(c => colIds.has(c.id as string)),
      });
    }
    return closestCorners(args);
  }, [activeColumn, board.columns]);

  function onDragStart({ active }: DragStartEvent) {
    const activeId = active.id as string;
    const isColDrag = board.columns.some(c => c.id === activeId);
    lastOverIdRef.current = null;
    if (isColDrag) {
      setActiveColumn(board.columns.find(c => c.id === activeId) ?? null);
      setActiveCard(null);
      dragStartColRef.current = null;
    } else {
      const col = board.columns.find(col => col.cards.some(c => c.id === activeId));
      setActiveCard(col?.cards.find(c => c.id === activeId) ?? null);
      setActiveColumn(null);
      dragStartColRef.current = col?.id ?? null;
    }
  }

  // Optimistically move cards cross-column during the drag so dnd-kit's
  // per-column SortableContext can animate the insertion in real time.
  // All reads use `prev` (functional update) to avoid stale-closure issues
  // when onDragOver fires faster than React can flush state.
  function onDragOver({ active, over }: DragOverEvent) {
    if (!over || active.id === over.id) return;
    const activeId = active.id as string;
    const overId   = over.id as string;
    if (board.columns.some(c => c.id === activeId)) return; // column drag — skip

    // Bail out early if the pointer is still over the same droppable — this
    // fires at pointer-move frequency so skipping unchanged events is critical.
    if (overId === lastOverIdRef.current) return;
    lastOverIdRef.current = overId;

    const overIsColumn = board.columns.some(c => c.id === overId);

    // Pre-check using current board state (may be slightly stale but good enough
    // to avoid calling updateBoard for the common same-column case).
    const srcColId = board.columns.find(col => col.cards.some(c => c.id === activeId))?.id;
    const dstColId = overIsColumn
      ? overId
      : board.columns.find(col => col.cards.some(c => c.id === overId))?.id;
    if (!srcColId || !dstColId || srcColId === dstColId) return;

    updateBoard(prev => {
      const srcCol = prev.columns.find(col => col.cards.some(c => c.id === activeId));
      const dstCol = overIsColumn
        ? prev.columns.find(c => c.id === overId)
        : prev.columns.find(col => col.cards.some(c => c.id === overId));

      if (!srcCol || !dstCol || srcCol.id === dstCol.id) return prev;

      const srcIdx = srcCol.cards.findIndex(c => c.id === activeId);
      const dstIdx = overIsColumn
        ? dstCol.cards.length
        : dstCol.cards.findIndex(c => c.id === overId);

      const srcCards = [...srcCol.cards];
      const [card] = srcCards.splice(srcIdx, 1);
      const dstCards = [...dstCol.cards];
      dstCards.splice(Math.max(0, dstIdx), 0, card);
      return {
        ...prev,
        columns: prev.columns.map(c => {
          if (c.id === srcCol.id) return { ...c, cards: srcCards };
          if (c.id === dstCol.id) return { ...c, cards: dstCards };
          return c; // preserve reference — unchanged columns won't cause re-renders
        }),
      };
    });
  }

  function onDragEnd({ active, over }: DragEndEvent) {
    const startColId = dragStartColRef.current;
    dragStartColRef.current = null;
    lastOverIdRef.current = null;
    setActiveCard(null);
    setActiveColumn(null);
    if (!over || active.id === over.id) return;

    const draggedId = active.id as string;
    const overId    = over.id as string;

    // ── Column reorder ──────────────────────────────────────────────────────
    // over.id may be a card inside the target column — resolve it to a column.
    if (board.columns.some(c => c.id === draggedId)) {
      updateBoard(prev => {
        const colIds = prev.columns.map(c => c.id);
        const targetColId = colIds.includes(overId)
          ? overId
          : prev.columns.find(col => col.cards.some(c => c.id === overId))?.id ?? null;
        if (!targetColId || targetColId === draggedId) return prev;
        const srcIdx = prev.columns.findIndex(c => c.id === draggedId);
        const dstIdx = prev.columns.findIndex(c => c.id === targetColId);
        return { ...prev, columns: arrayMove(prev.columns, srcIdx, dstIdx) };
      });
      return;
    }

    // ── Card reorder / cross-column commit ──────────────────────────────────
    // onDragOver may have already moved the card into the destination column.
    // We use a functional update so we read the latest state regardless.
    const overIsColumn = board.columns.some(c => c.id === overId);

    updateBoard(prev => {
      const srcCol = prev.columns.find(col => col.cards.some(c => c.id === draggedId));
      if (!srcCol) return prev;
      const srcIdx = srcCol.cards.findIndex(c => c.id === draggedId);

      const dstCol = overIsColumn
        ? prev.columns.find(c => c.id === overId)
        : prev.columns.find(col => col.cards.some(c => c.id === overId));
      if (!dstCol) return prev;

      const dstIdx = overIsColumn
        ? dstCol.cards.length
        : dstCol.cards.findIndex(c => c.id === overId);

      // Was this a genuine cross-column move (judged by original column at drag-start)?
      const wasCrossColumn = startColId !== null && startColId !== dstCol.id;
      const autoComplete   = dstCol.autoComplete ?? false;

      if (srcCol.id === dstCol.id) {
        // Card is already in the right column (moved by onDragOver) — final sort only.
        const reordered = arrayMove(srcCol.cards, srcIdx, dstIdx);
        const cards = wasCrossColumn && autoComplete
          ? reordered.map(c => c.id === draggedId ? { ...c, isDone: true } : c)
          : reordered;
        return {
          ...prev,
          columns: prev.columns.map(col => col.id !== srcCol.id ? col : { ...col, cards }),
        };
      }

      // Fallback: card wasn't moved by onDragOver (e.g., very fast drop).
      const srcCards = [...srcCol.cards];
      const [card] = srcCards.splice(srcIdx, 1);
      const dstCards = [...dstCol.cards];
      dstCards.splice(dstIdx, 0, autoComplete ? { ...card, isDone: true } : card);
      return {
        ...prev,
        columns: prev.columns.map(c => {
          if (c.id === srcCol.id) return { ...c, cards: srcCards };
          if (c.id === dstCol.id) return { ...c, cards: dstCards };
          return c;
        }),
      };
    });
  }

  function addColumn() {
    const title = newColTitle.trim() || 'New Column';
    updateBoard(prev => ({
      ...prev,
      columns: [...prev.columns, { id: crypto.randomUUID(), title, color: '#64748b', cards: [] }],
    }));
    setNewColTitle('');
    setAddingColumn(false);
  }

  const columnIds = board.columns.map(c => c.id);
  const totalCards = board.columns.reduce((n, c) => n + c.cards.length, 0);

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-2 border-b border-border/30 shrink-0">
        <span className="text-xs text-muted-foreground">
          {totalCards} {totalCards === 1 ? 'card' : 'cards'} across {board.columns.length} columns
        </span>

        <div className="flex items-center gap-3">
          {/* View toggle */}
          <div className="flex items-center bg-muted/30 rounded-md p-0.5 gap-0.5">
            <button
              onClick={() => setView('board')}
              className={cn(
                'flex items-center gap-1.5 px-2.5 py-1 rounded text-xs font-medium transition-colors',
                view === 'board'
                  ? 'bg-background text-foreground shadow-sm'
                  : 'text-muted-foreground hover:text-foreground',
              )}
            >
              <LayoutDashboard size={12} />
              Board
            </button>
            <button
              onClick={() => setView('calendar')}
              className={cn(
                'flex items-center gap-1.5 px-2.5 py-1 rounded text-xs font-medium transition-colors',
                view === 'calendar'
                  ? 'bg-background text-foreground shadow-sm'
                  : 'text-muted-foreground hover:text-foreground',
              )}
            >
              <CalendarDays size={12} />
              Calendar
            </button>
            <button
              onClick={() => setView('timeline')}
              className={cn(
                'flex items-center gap-1.5 px-2.5 py-1 rounded text-xs font-medium transition-colors',
                view === 'timeline'
                  ? 'bg-background text-foreground shadow-sm'
                  : 'text-muted-foreground hover:text-foreground',
              )}
            >
              <GanttChart size={12} />
              Timeline
            </button>
          </div>

          {/* Archive toggle — only shown in board view */}
          {view === 'board' && (
            <button
              onClick={() => setShowArchive(v => !v)}
              title={showArchive ? 'Hide archive' : 'Show archive'}
              className={cn(
                'flex items-center gap-1.5 px-2.5 py-1 rounded text-xs font-medium transition-colors',
                showArchive
                  ? 'bg-background text-foreground shadow-sm'
                  : 'text-muted-foreground hover:text-foreground hover:bg-accent/30',
              )}
            >
              <Archive size={12} />
              Archive
            </button>
          )}

          {boardPeers.length > 0 && (
            <div className="flex items-center gap-1" title="Also viewing this board">
              {boardPeers.map(p => (
                <div
                  key={p.userId}
                  title={p.userName}
                  className="w-6 h-6 rounded-full flex items-center justify-center text-[10px] font-bold text-white border-2 border-background"
                  style={{ backgroundColor: p.userColor }}
                >
                  {p.userName[0]?.toUpperCase()}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Calendar view */}
      {view === 'calendar' && <CalendarView />}

      {/* Timeline view */}
      {view === 'timeline' && <TimelineView />}

      {/* Board body — horizontal scroll */}
      {view === 'board' && <div className="flex-1 flex flex-col overflow-hidden">
        <div className="flex-1 overflow-x-auto overflow-y-hidden">
          <DndContext
            sensors={sensors}
            collisionDetection={collisionDetection}
            onDragStart={onDragStart}
            onDragOver={onDragOver}
            onDragEnd={onDragEnd}
          >
            <div className="flex gap-3 h-full p-4 w-max min-w-full items-start">
              <SortableContext items={columnIds} strategy={horizontalListSortingStrategy}>
                {board.columns.map(col => (
                  <KanbanColumnView key={col.id} column={col} />
                ))}
              </SortableContext>

              {/* Add column */}
              <div className="shrink-0 w-[272px]">
                {addingColumn ? (
                  <div className="bg-card/60 border border-border/50 rounded-lg p-2 flex flex-col gap-2">
                    <input
                      autoFocus
                      value={newColTitle}
                      onChange={e => setNewColTitle(e.target.value)}
                      onKeyDown={e => {
                        if (e.key === 'Enter') addColumn();
                        if (e.key === 'Escape') { setAddingColumn(false); setNewColTitle(''); }
                      }}
                      placeholder="Column title..."
                      className="w-full bg-transparent text-sm px-2 py-1 rounded border border-border/50 focus:outline-none focus:ring-1 focus:ring-primary/50 text-foreground placeholder:text-muted-foreground/40"
                    />
                    <div className="flex gap-2">
                      <button
                        onClick={addColumn}
                        className="flex-1 text-xs px-2 py-1 bg-primary/20 hover:bg-primary/30 text-primary rounded transition-colors"
                      >
                        Add column
                      </button>
                      <button
                        onClick={() => { setAddingColumn(false); setNewColTitle(''); }}
                        className="text-xs px-2 py-1 text-muted-foreground hover:text-foreground rounded transition-colors"
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                ) : (
                  <button
                    onClick={() => setAddingColumn(true)}
                    className="w-full flex items-center gap-2 px-3 py-2.5 rounded-lg text-sm text-muted-foreground hover:text-foreground hover:bg-accent/30 transition-colors border border-dashed border-border/40 hover:border-border/60"
                  >
                    <Plus size={14} />
                    Add column
                  </button>
                )}
              </div>
            </div>

            <DragOverlay dropAnimation={null}>
              {activeCard && (
                <KanbanCardView card={activeCard} columnId="" isOverlay />
              )}
              {activeColumn && (
                <div className="w-[272px] bg-card/80 border border-border/50 rounded-lg shadow-2xl opacity-90 px-3 py-2.5 flex items-center gap-2">
                  <div
                    className="w-3 h-3 rounded-full shrink-0"
                    style={{ backgroundColor: activeColumn.color ?? '#64748b' }}
                  />
                  <span className="text-sm font-semibold text-foreground truncate flex-1">
                    {activeColumn.title}
                  </span>
                  <span className="text-[11px] text-muted-foreground tabular-nums">
                    {activeColumn.cards.length}
                  </span>
                </div>
              )}
            </DragOverlay>
          </DndContext>
        </div>

        {/* Archive panel */}
        {showArchive && <ArchivePanel />}
      </div>}
    </div>
  );
}
