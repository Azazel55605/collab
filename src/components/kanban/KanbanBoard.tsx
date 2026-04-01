import { useState, useMemo } from 'react';
import {
  DndContext,
  DragOverlay,
  closestCorners,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from '@dnd-kit/core';
import { SortableContext, horizontalListSortingStrategy, arrayMove } from '@dnd-kit/sortable';
import { Plus, LayoutDashboard, CalendarDays, GanttChart } from 'lucide-react';
import { cn } from '../../lib/utils';
import { useKanbanContext } from '../../views/KanbanPage';
import { useCollabStore } from '../../store/collabStore';
import KanbanColumnView from './KanbanColumn';
import KanbanCardView from './KanbanCard';
import CalendarView from './CalendarView';
import TimelineView from './TimelineView';
import type { KanbanCard } from '../../types/kanban';

export default function KanbanBoardView() {
  const { board, updateBoard, relativePath } = useKanbanContext();
  const { peers } = useCollabStore();
  const [view, setView] = useState<'board' | 'calendar' | 'timeline'>('board');
  const [activeCard, setActiveCard] = useState<KanbanCard | null>(null);
  const [addingColumn, setAddingColumn] = useState(false);
  const [newColTitle, setNewColTitle] = useState('');

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
  );

  // Peers viewing this same board
  const boardPeers = useMemo(
    () => peers.filter(p => p.activeFile === relativePath),
    [peers, relativePath],
  );

  function findCardColumn(cardId: string) {
    return board.columns.find(col => col.cards.some(c => c.id === cardId));
  }

  function onDragStart({ active }: DragStartEvent) {
    const col = findCardColumn(active.id as string);
    setActiveCard(col?.cards.find(c => c.id === active.id) ?? null);
  }

  function onDragEnd({ active, over }: DragEndEvent) {
    setActiveCard(null);
    if (!over || active.id === over.id) return;

    const draggedId = active.id as string;
    const overId    = over.id as string;

    const srcCol = findCardColumn(draggedId);
    if (!srcCol) return;
    const srcIdx = srcCol.cards.findIndex(c => c.id === draggedId);

    // Determine destination: over a column header or over another card?
    const overIsColumn = board.columns.some(c => c.id === overId);
    const dstCol = overIsColumn
      ? board.columns.find(c => c.id === overId)!
      : findCardColumn(overId);
    if (!dstCol) return;

    const dstIdx = overIsColumn
      ? dstCol.cards.length
      : dstCol.cards.findIndex(c => c.id === overId);

    if (srcCol.id === dstCol.id) {
      // Same-column reorder
      updateBoard(prev => ({
        ...prev,
        columns: prev.columns.map(col =>
          col.id !== srcCol.id ? col : { ...col, cards: arrayMove(col.cards, srcIdx, dstIdx) },
        ),
      }));
    } else {
      // Cross-column move — auto-complete if destination column has it enabled
      const autoComplete = dstCol.autoComplete ?? false;
      updateBoard(prev => {
        const cols = prev.columns.map(c => ({ ...c, cards: [...c.cards] }));
        const src  = cols.find(c => c.id === srcCol.id)!;
        const dst  = cols.find(c => c.id === dstCol.id)!;
        const [card] = src.cards.splice(srcIdx, 1);
        const movedCard = autoComplete ? { ...card, isDone: true } : card;
        dst.cards.splice(dstIdx, 0, movedCard);
        return { ...prev, columns: cols };
      });
    }
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
      {view === 'board' && <div className="flex-1 overflow-x-auto overflow-y-hidden">
        <DndContext
          sensors={sensors}
          collisionDetection={closestCorners}
          onDragStart={onDragStart}
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
          </DragOverlay>
        </DndContext>
      </div>}
    </div>
  );
}
