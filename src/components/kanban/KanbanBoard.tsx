import { useEffect, useState, useMemo, useCallback, useRef } from 'react';
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
import {
  Plus,
  LayoutDashboard,
  CalendarDays,
  GanttChart,
  Archive,
  ArchiveRestore,
  Clock3,
  ArrowUp,
  ArrowDown,
  ArrowUpDown,
  Check,
  Search,
  MoreHorizontal,
  Flag,
  Users,
  Calendar,
} from 'lucide-react';
import { cn } from '../../lib/utils';
import { useKanbanContext } from '../../views/KanbanPage';
import { useCollabStore } from '../../store/collabStore';
import { useKanbanStore } from '../../store/kanbanStore';
import { formatDate, useUiStore } from '../../store/uiStore';
import KanbanColumnView from './KanbanColumn';
import KanbanCardView from './KanbanCard';
import CalendarView from './CalendarView';
import TimelineView from './TimelineView';
import {
  getCardAttachmentPaths,
  getMissingColumnDefaultTags,
  mergeUniqueTags,
  syncChecklistReferences,
  type ColumnSortField,
  type KanbanCard,
  type KanbanColumn,
} from '../../types/kanban';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '../ui/dialog';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '../ui/dropdown-menu';
import {
  DocumentTopBar,
  documentTopBarGroupClass,
  getDocumentBaseName,
  getDocumentFolderPath,
} from '../layout/DocumentTopBar';
import CardDialog from './CardDialog';

interface MoveTagsPromptState {
  cardId: string;
  cardTitle: string;
  columnId: string;
  columnTitle: string;
  missingTags: string[];
}

const PRIORITY_ORDER: Record<string, number> = { high: 0, medium: 1, low: 2 };
const PRIORITY_BADGES: Record<'high' | 'medium' | 'low', { label: string; cls: string }> = {
  high: { label: 'High', cls: 'bg-red-500/20 text-red-400 border-red-500/30' },
  medium: { label: 'Medium', cls: 'bg-yellow-500/20 text-yellow-400 border-yellow-500/30' },
  low: { label: 'Low', cls: 'bg-green-500/20 text-green-400 border-green-500/30' },
};
const SORT_FIELDS: { field: ColumnSortField; label: string }[] = [
  { field: 'none', label: 'Manual (default)' },
  { field: 'name', label: 'Name' },
  { field: 'priority', label: 'Priority' },
  { field: 'createdAt', label: 'Creation date' },
  { field: 'startDate', label: 'Start date' },
  { field: 'dueDate', label: 'Due date' },
  { field: 'assignees', label: 'Assignees' },
];

function archiveSearchText(card: KanbanCard) {
  return [
    card.title,
    card.description,
    ...card.tags,
    ...getCardAttachmentPaths(card),
    ...card.checklist.map((item) => item.text),
    ...card.comments.map((comment) => comment.content),
    card.archivedByUserName,
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
}

function sortCards(cards: KanbanCard[], column: KanbanColumn, knownUsers: Array<{ userId: string; userName: string }>) {
  const sort = column.sort;
  if (!sort || sort.field === 'none') return cards;
  const next = [...cards];
  next.sort((a, b) => {
    let cmp = 0;
    switch (sort.field) {
      case 'name':
        cmp = a.title.localeCompare(b.title);
        break;
      case 'priority': {
        const pa = PRIORITY_ORDER[a.priority ?? ''] ?? 3;
        const pb = PRIORITY_ORDER[b.priority ?? ''] ?? 3;
        cmp = pa - pb;
        break;
      }
      case 'createdAt':
        cmp = (a.createdAt ?? 0) - (b.createdAt ?? 0);
        break;
      case 'startDate':
        cmp = (a.startDate ?? '').localeCompare(b.startDate ?? '');
        break;
      case 'dueDate':
        cmp = (a.dueDate ?? '').localeCompare(b.dueDate ?? '');
        break;
      case 'assignees': {
        const aName = knownUsers.find((user) => a.assignees[0] === user.userId)?.userName ?? a.assignees[0] ?? '';
        const bName = knownUsers.find((user) => b.assignees[0] === user.userId)?.userName ?? b.assignees[0] ?? '';
        cmp = aName.localeCompare(bName);
        break;
      }
    }
    return sort.dir === 'asc' ? cmp : -cmp;
  });
  return next;
}

function clearArchivedState(card: KanbanCard) {
  return {
    ...card,
    archived: undefined,
    archivedColumnId: undefined,
    archivedAt: undefined,
    archivedByUserId: undefined,
    archivedByUserName: undefined,
  };
}

function ArchiveView({ onOpenCard }: { onOpenCard: (card: KanbanCard, columnId: string) => void }) {
  const { board, updateBoard, knownUsers } = useKanbanContext();
  const { dateFormat } = useUiStore();
  const [searchQuery, setSearchQuery] = useState('');
  const normalizedQuery = searchQuery.trim().toLowerCase();

  function setColumnSort(columnId: string, field: ColumnSortField) {
    updateBoard((prev) => ({
      ...prev,
      columns: prev.columns.map((column) => {
        if (column.id !== columnId) return column;
        if (field === 'none') return { ...column, sort: undefined };
        const dir = column.sort?.field === field && column.sort.dir === 'asc' ? 'desc' : 'asc';
        return { ...column, sort: { field, dir } };
      }),
    }));
  }

  const archivedGroups = board.columns
    .map((col) => ({
      col,
      cards: sortCards(
        col.cards
          .filter((card) => card.archived)
          .filter((card) => !normalizedQuery || archiveSearchText(card).includes(normalizedQuery)),
        col,
        knownUsers,
      ),
    }))
    .filter((group) => group.cards.length > 0);

  const totalArchived = archivedGroups.reduce((count, group) => count + group.cards.length, 0);

  function restoreCard(cardId: string, columnId: string) {
    updateBoard((prev) => ({
      ...prev,
      columns: prev.columns.map((col) =>
        col.id !== columnId
          ? col
          : {
              ...col,
              cards: col.cards.map((card) => (card.id !== cardId ? card : clearArchivedState(card))),
            },
      ),
    }));
  }

  if (totalArchived === 0) {
    return (
      <div className="flex-1 flex items-center justify-center px-6">
        <div className="rounded-2xl border border-dashed border-border/50 bg-muted/10 px-6 py-8 text-center">
          <Archive size={24} className="mx-auto mb-3 text-muted-foreground/50" />
          <p className="text-sm font-medium text-foreground">
            {normalizedQuery ? 'No archived cards match this search' : 'Archive is empty'}
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            {normalizedQuery ? 'Try a different title, tag, checklist, or attachment term.' : 'Archived cards will show up here.'}
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto px-4 py-4">
      <div className="mb-4 sticky top-0 z-10 bg-background/90 backdrop-blur-sm-webkit pb-3">
        <div className="relative max-w-md">
          <Search size={14} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground/60" />
          <Input
            value={searchQuery}
            onChange={(event) => setSearchQuery(event.target.value)}
            placeholder="Search archived cards..."
            className="h-9 pl-9 text-sm"
          />
        </div>
      </div>

      <div className="grid gap-4">
        {archivedGroups.map(({ col, cards }) => (
          <section key={col.id} className="rounded-2xl border border-border/40 bg-card/30 overflow-hidden">
            <div className="flex items-center justify-between gap-3 border-b border-border/30 px-4 py-3">
              <div className="flex items-center gap-2">
                <div className="h-2.5 w-2.5 rounded-full shrink-0" style={{ backgroundColor: col.color ?? '#64748b' }} />
                <span className="text-sm font-semibold text-foreground">{col.title}</span>
                {col.sort && col.sort.field !== 'none' && (
                  <span title={`Sorted by ${col.sort.field} (${col.sort.dir})`} className="shrink-0">
                    {col.sort.dir === 'asc'
                      ? <ArrowUp size={11} className="text-primary/60" />
                      : <ArrowDown size={11} className="text-primary/60" />}
                  </span>
                )}
              </div>
              <div className="flex items-center gap-2">
                <span className="text-xs text-muted-foreground">
                  {cards.length} {cards.length === 1 ? 'archived card' : 'archived cards'}
                </span>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <button
                      type="button"
                      className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground/60 transition-colors hover:bg-accent/50 hover:text-foreground"
                      aria-label={`Sort archived cards in ${col.title}`}
                    >
                      <MoreHorizontal size={13} />
                    </button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="w-52">
                    <DropdownMenuSub>
                      <DropdownMenuSubTrigger className="text-xs">
                        <ArrowUpDown size={11} className="mr-2" />
                        Sort by
                        {col.sort && col.sort.field !== 'none' && (
                          <span className="ml-auto text-[10px] text-primary/70 capitalize">
                            {col.sort.field}
                          </span>
                        )}
                      </DropdownMenuSubTrigger>
                      <DropdownMenuSubContent className="w-48">
                        {SORT_FIELDS.map(({ field, label }) => {
                          const isActive = field === 'none' ? !col.sort || col.sort.field === 'none' : col.sort?.field === field;
                          const dir = isActive && field !== 'none' ? col.sort?.dir : null;
                          return (
                            <DropdownMenuItem key={field} onClick={() => setColumnSort(col.id, field)} className="text-xs">
                              <span className="flex-1">{label}</span>
                              {isActive && field === 'none' && <Check size={11} className="text-primary/70" />}
                              {dir === 'asc' && <ArrowUp size={11} className="text-primary/70" />}
                              {dir === 'desc' && <ArrowDown size={11} className="text-primary/70" />}
                            </DropdownMenuItem>
                          );
                        })}
                      </DropdownMenuSubContent>
                    </DropdownMenuSub>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            </div>

            <div className="divide-y divide-border/20">
              {cards.map((card) => {
                const attachments = getCardAttachmentPaths(card);
                const assigneeNames = card.assignees
                  .map((userId) => knownUsers.find((user) => user.userId === userId)?.userName ?? userId)
                  .filter(Boolean);
                return (
                  <div key={card.id} className="flex items-start gap-3 px-4 py-3">
                    <button
                      type="button"
                      onClick={() => onOpenCard(card, col.id)}
                      className="flex-1 min-w-0 text-left rounded-lg transition-colors hover:bg-accent/25 px-2 py-1.5 -mx-2 -my-1.5"
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <p className="text-sm font-medium text-foreground truncate">{card.title}</p>
                          <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                            {card.archivedAt && (
                              <span className="flex items-center gap-1">
                                <Clock3 size={11} />
                                {new Date(card.archivedAt).toLocaleString()}
                              </span>
                            )}
                            {card.archivedByUserName && <span>Archived by {card.archivedByUserName}</span>}
                            {card.priority && (
                              <span
                                className={cn(
                                  'inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5 font-medium capitalize',
                                  PRIORITY_BADGES[card.priority].cls,
                                )}
                              >
                                <Flag size={11} />
                                {PRIORITY_BADGES[card.priority].label}
                              </span>
                            )}
                            {assigneeNames.length > 0 && (
                              <span className="flex items-center gap-1">
                                <Users size={11} />
                                {assigneeNames.join(', ')}
                              </span>
                            )}
                            {card.startDate && (
                              <span className="flex items-center gap-1">
                                <Calendar size={11} />
                                Start {formatDate(new Date(`${card.startDate}T12:00:00`), dateFormat)}
                              </span>
                            )}
                            {card.dueDate && (
                              <span className="flex items-center gap-1">
                                <Calendar size={11} />
                                Due {formatDate(new Date(`${card.dueDate}T12:00:00`), dateFormat)}
                              </span>
                            )}
                            {attachments.length > 0 && <span>{attachments.length} attachment{attachments.length === 1 ? '' : 's'}</span>}
                            {card.checklist.length > 0 && (
                              <span>{card.checklist.filter((item) => item.checked).length}/{card.checklist.length} tasks</span>
                            )}
                          </div>
                        </div>
                        <span className="shrink-0 text-[11px] text-muted-foreground">Open</span>
                      </div>
                    </button>

                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="h-8 gap-1.5 text-xs"
                      onClick={() => restoreCard(card.id, col.id)}
                    >
                      <ArchiveRestore size={12} />
                      Restore
                    </Button>
                  </div>
                );
              })}
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}

// ── Main board ────────────────────────────────────────────────────────────────

export default function KanbanBoardView() {
  const { board, updateBoard, relativePath } = useKanbanContext();
  const { peers } = useCollabStore();
  const { boardPath, cardId: editingCardId, columnId: editingColumnId, clearEditing, setEditing } = useKanbanStore();
  const boardViewportRef = useRef<HTMLDivElement | null>(null);
  const [view, setView] = useState<'board' | 'calendar' | 'timeline' | 'archive'>('board');
  const [activeCard,   setActiveCard]   = useState<KanbanCard | null>(null);
  const [activeColumn, setActiveColumn] = useState<KanbanColumn | null>(null);
  const [addingColumn, setAddingColumn] = useState(false);
  const [newColTitle, setNewColTitle] = useState('');
  const [moveTagsPrompt, setMoveTagsPrompt] = useState<MoveTagsPromptState | null>(null);

  useEffect(() => {
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<MoveTagsPromptState>).detail;
      if (!detail) return;
      setMoveTagsPrompt(detail);
    };

    window.addEventListener('kanban:prompt-move-tags', handler);
    return () => window.removeEventListener('kanban:prompt-move-tags', handler);
  }, []);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
  );

  // Peers viewing this same board
  const boardPeers = useMemo(
    () => peers.filter(p => p.activeFile === relativePath),
    [peers, relativePath],
  );
  const archivedCount = useMemo(
    () => board.columns.reduce((count, column) => count + column.cards.filter((card) => card.archived).length, 0),
    [board.columns],
  );
  const archivedEditingCard = useMemo(() => {
    if (boardPath !== relativePath || !editingCardId || !editingColumnId) return null;
    const column = board.columns.find((entry) => entry.id === editingColumnId);
    const card = column?.cards.find((entry) => entry.id === editingCardId);
    return card?.archived ? { card, columnId: editingColumnId } : null;
  }, [board.columns, boardPath, editingCardId, editingColumnId, relativePath]);

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

    let promptRequest: MoveTagsPromptState | null = null;

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

      const finalizeMovedCard = (card: KanbanCard) => {
        if (!wasCrossColumn) return card;

        const missingTags = getMissingColumnDefaultTags(card, dstCol);
        if (missingTags.length === 0) {
          return autoComplete ? { ...card, isDone: true } : card;
        }

        if (dstCol.autoApplyDefaultTagsOnMove) {
          return {
            ...card,
            isDone: autoComplete ? true : card.isDone,
            tags: mergeUniqueTags(card.tags, missingTags),
          };
        }

        promptRequest = {
          cardId: card.id,
          cardTitle: card.title,
          columnId: dstCol.id,
          columnTitle: dstCol.title,
          missingTags,
        };
        return autoComplete ? { ...card, isDone: true } : card;
      };

      if (srcCol.id === dstCol.id) {
        // Card is already in the right column (moved by onDragOver) — final sort only.
        const reordered = arrayMove(srcCol.cards, srcIdx, dstIdx);
        const cards = reordered.map((card) => (
          card.id === draggedId ? finalizeMovedCard(card) : card
        ));
        const nextBoard = {
          ...prev,
          columns: prev.columns.map(col => col.id !== srcCol.id ? col : { ...col, cards }),
        };
        const movedCard = cards.find((card) => card.id === draggedId);
        return movedCard ? syncChecklistReferences(nextBoard, draggedId, movedCard.isDone ?? false) : nextBoard;
      }

      // Fallback: card wasn't moved by onDragOver (e.g., very fast drop).
      const srcCards = [...srcCol.cards];
      const [card] = srcCards.splice(srcIdx, 1);
      const dstCards = [...dstCol.cards];
      const movedCard = finalizeMovedCard(card);
      dstCards.splice(dstIdx, 0, movedCard);
      const nextBoard = {
        ...prev,
        columns: prev.columns.map(c => {
          if (c.id === srcCol.id) return { ...c, cards: srcCards };
          if (c.id === dstCol.id) return { ...c, cards: dstCards };
          return c;
        }),
      };
      return syncChecklistReferences(nextBoard, draggedId, movedCard.isDone ?? false);
    });

    if (promptRequest) {
      setMoveTagsPrompt(promptRequest);
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

  const scrollBoardBy = (deltaX: number) => {
    const viewport = boardViewportRef.current;
    if (!viewport) return;
    viewport.scrollBy({ left: deltaX, behavior: 'smooth' });
  };

  useEffect(() => {
    const isEditableTarget = (target: EventTarget | null) => (
      target instanceof HTMLElement
      && target.matches('input, textarea, [contenteditable="true"], [contenteditable=""], [role="textbox"], [role="combobox"]')
    );

    const handleKeyDown = (event: KeyboardEvent) => {
      if (isEditableTarget(event.target) || event.altKey) return;

      switch (event.key) {
        case '1':
          event.preventDefault();
          setView('board');
          break;
        case '2':
          event.preventDefault();
          setView('calendar');
          break;
        case '3':
          event.preventDefault();
          setView('timeline');
          break;
        case '4':
          event.preventDefault();
          setView('archive');
          break;
        case 'b':
        case 'B':
          event.preventDefault();
          setView('board');
          break;
        case 'c':
        case 'C':
          event.preventDefault();
          setView('calendar');
          break;
        case 't':
        case 'T':
          event.preventDefault();
          setView('timeline');
          break;
        case 'a':
        case 'A':
          event.preventDefault();
          setView('archive');
          break;
        case 'n':
        case 'N':
          if (view === 'board') {
            event.preventDefault();
            setAddingColumn(true);
          }
          break;
        case 'ArrowRight':
          if (view === 'board') {
            event.preventDefault();
            scrollBoardBy(220);
          }
          break;
        case 'ArrowLeft':
          if (view === 'board') {
            event.preventDefault();
            scrollBoardBy(-220);
          }
          break;
        case 'Home':
          if (view === 'board') {
            event.preventDefault();
            boardViewportRef.current?.scrollTo({ left: 0, behavior: 'smooth' });
          }
          break;
        case 'End':
          if (view === 'board') {
            event.preventDefault();
            const viewport = boardViewportRef.current;
            if (viewport) {
              viewport.scrollTo({ left: viewport.scrollWidth, behavior: 'smooth' });
            }
          }
          break;
        case 'Escape':
          if (addingColumn) {
            event.preventDefault();
            setAddingColumn(false);
            setNewColTitle('');
          }
          break;
      }
    };

    document.addEventListener('keydown', handleKeyDown, { capture: true });
    return () => {
      document.removeEventListener('keydown', handleKeyDown, { capture: true } as EventListenerOptions);
    };
  }, [addingColumn, view]);

  const applyPromptTags = useCallback((prompt: MoveTagsPromptState, enableAutoApply: boolean) => {
    updateBoard((prev) => ({
      ...prev,
      columns: prev.columns.map((column) => {
        if (column.id !== prompt.columnId) return column;
        return {
          ...column,
          autoApplyDefaultTagsOnMove: enableAutoApply ? true : column.autoApplyDefaultTagsOnMove,
          cards: column.cards.map((card) => (
            card.id !== prompt.cardId
              ? card
              : { ...card, tags: mergeUniqueTags(card.tags, prompt.missingTags) }
          )),
        };
      }),
    }));
    setMoveTagsPrompt(null);
  }, [updateBoard]);

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <DocumentTopBar
        title={getDocumentBaseName(relativePath, 'Board')}
        subtitle={getDocumentFolderPath(relativePath)}
        icon={<LayoutDashboard size={15} />}
        meta={
          <>
            <span className="shrink-0 text-xs text-muted-foreground">
              {totalCards} {totalCards === 1 ? 'card' : 'cards'} across {board.columns.length} columns
            </span>
            <span className="shrink-0 text-xs text-muted-foreground">
              {archivedCount} archived
            </span>
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
          </>
        }
        secondary={
          <>
            <div className={documentTopBarGroupClass}>
              <button
                onClick={() => setView('board')}
                className={cn(
                  'flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-medium transition-colors',
                  view === 'board'
                    ? 'bg-accent text-accent-foreground'
                    : 'text-muted-foreground hover:text-foreground',
                )}
              >
                <LayoutDashboard size={12} />
                Board
              </button>
              <button
                onClick={() => setView('calendar')}
                className={cn(
                  'flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-medium transition-colors',
                  view === 'calendar'
                    ? 'bg-accent text-accent-foreground'
                    : 'text-muted-foreground hover:text-foreground',
                )}
              >
                <CalendarDays size={12} />
                Calendar
              </button>
              <button
                onClick={() => setView('timeline')}
                className={cn(
                  'flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-medium transition-colors',
                  view === 'timeline'
                    ? 'bg-accent text-accent-foreground'
                    : 'text-muted-foreground hover:text-foreground',
                )}
              >
                <GanttChart size={12} />
                Timeline
              </button>
              <button
                onClick={() => setView('archive')}
                className={cn(
                  'flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-medium transition-colors',
                  view === 'archive'
                    ? 'bg-accent text-accent-foreground'
                    : 'text-muted-foreground hover:text-foreground',
                )}
              >
                <Archive size={12} />
                Archive
                {archivedCount > 0 && (
                  <span className="rounded-full bg-background/70 px-1.5 py-0.5 text-[10px] leading-none">
                    {archivedCount}
                  </span>
                )}
              </button>
            </div>

            {view === 'board' && (
              <>
                <div className={documentTopBarGroupClass}>
                  <button
                    onClick={() => setAddingColumn(true)}
                    className="flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
                  >
                    <Plus size={12} />
                    Add column
                  </button>
                </div>
              </>
            )}
          </>
        }
      />

      {/* Calendar view */}
      {view === 'calendar' && <CalendarView />}

      {/* Timeline view */}
      {view === 'timeline' && <TimelineView />}

      {/* Archive view */}
      {view === 'archive' && (
        <ArchiveView
          onOpenCard={(card, columnId) => {
            setEditing(relativePath, card.id, columnId, card);
          }}
        />
      )}

      {/* Board body — horizontal scroll */}
      {view === 'board' && <div className="flex-1 flex flex-col overflow-hidden">
        <div ref={boardViewportRef} className="flex-1 overflow-x-auto overflow-y-hidden">
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
      </div>}

      {archivedEditingCard && (
        <CardDialog
          card={archivedEditingCard.card}
          columnId={archivedEditingCard.columnId}
          onClose={clearEditing}
        />
      )}

      <Dialog open={moveTagsPrompt !== null} onOpenChange={(open) => !open && setMoveTagsPrompt(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Apply column tags?</DialogTitle>
          </DialogHeader>
          {moveTagsPrompt && (
            <div className="space-y-3 text-sm">
              <p className="text-muted-foreground">
                <span className="text-foreground font-medium">{moveTagsPrompt.cardTitle}</span> was moved to{' '}
                <span className="text-foreground font-medium">{moveTagsPrompt.columnTitle}</span>.
              </p>
              <p className="text-muted-foreground">
                This column has default tags that are not yet on the card:
              </p>
              <div className="flex flex-wrap gap-1.5">
                {moveTagsPrompt.missingTags.map((tag) => (
                  <span key={tag} className="rounded-full bg-primary/15 px-2 py-0.5 text-xs text-primary/80">
                    {tag}
                  </span>
                ))}
              </div>
            </div>
          )}
          <DialogFooter className="gap-2 sm:justify-between">
            <Button variant="ghost" onClick={() => setMoveTagsPrompt(null)}>
              Not now
            </Button>
            <div className="flex gap-2">
              <Button
                variant="outline"
                onClick={() => moveTagsPrompt && applyPromptTags(moveTagsPrompt, false)}
              >
                Apply once
              </Button>
              <Button
                onClick={() => moveTagsPrompt && applyPromptTags(moveTagsPrompt, true)}
              >
                Always apply here
              </Button>
            </div>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
