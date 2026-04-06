import { useState, useMemo, useRef, useEffect } from 'react';
import { useSortable, SortableContext, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import {
  MoreHorizontal, Plus, Trash2, Pencil, CheckCircle2,
  GripHorizontal, ArrowUpDown, ArrowUp, ArrowDown,
  CalendarOff, Check, Tag, X, FolderInput,
} from 'lucide-react';
import { cn } from '../../lib/utils';
import { useKanbanContext } from '../../views/KanbanPage';
import type { KanbanColumn, ColumnSortField } from '../../types/kanban';
import KanbanCardView from './KanbanCard';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '../ui/dropdown-menu';
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '../ui/dialog';
import { Input } from '../ui/input';

const COLUMN_COLORS = [
  '#6366f1', '#8b5cf6', '#ec4899', '#ef4444',
  '#f97316', '#eab308', '#22c55e', '#14b8a6',
  '#3b82f6', '#64748b',
];

const PRIORITY_ORDER: Record<string, number> = { high: 0, medium: 1, low: 2 };

const SORT_FIELDS: { field: ColumnSortField; label: string }[] = [
  { field: 'none',      label: 'Manual (default)' },
  { field: 'name',      label: 'Name' },
  { field: 'priority',  label: 'Priority' },
  { field: 'createdAt', label: 'Creation date' },
  { field: 'startDate', label: 'Start date' },
  { field: 'dueDate',   label: 'Due date' },
  { field: 'assignees', label: 'Assignees' },
];

interface Props {
  column: KanbanColumn;
}

export default function KanbanColumnView({ column }: Props) {
  const { updateBoard, knownUsers } = useKanbanContext();
  const [editingTitle,     setEditingTitle]     = useState(false);
  const [titleDraft,       setTitleDraft]       = useState(column.title);
  const titleInputRef  = useRef<HTMLInputElement>(null);
  // Guards against onBlur firing while Radix UI restores focus to the trigger
  // after the dropdown closes. Set to true only after the focus delay elapses.
  const renameReadyRef = useRef(false);

  // When editingTitle becomes true (from any trigger), wait for Radix UI's
  // dropdown-close focus-restoration to finish before focusing the input.
  // 150 ms is long enough to outlast Radix's async focus-return logic.
  useEffect(() => {
    if (editingTitle) {
      renameReadyRef.current = false;
      const t = setTimeout(() => {
        renameReadyRef.current = true;
        titleInputRef.current?.focus();
      }, 150);
      return () => clearTimeout(t);
    } else {
      renameReadyRef.current = false;
    }
  }, [editingTitle]);
  const [addingCard,       setAddingCard]       = useState(false);
  const [cardDraft,        setCardDraft]        = useState('');
  const [colorOpen,        setColorOpen]        = useState(false);
  const [hexDraft,         setHexDraft]         = useState('');
  const [defaultTagsOpen,  setDefaultTagsOpen]  = useState(false);
  const [tagInput,         setTagInput]         = useState('');

  const {
    setNodeRef,
    attributes,
    listeners,
    transform,
    transition,
    isDragging,
    isOver,
  } = useSortable({ id: column.id });

  const style = {
    maxHeight: 'calc(100vh - 120px)',
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.45 : undefined,
    zIndex: isDragging ? 10 : undefined,
  };

  function renameColumn() {
    const title = titleDraft.trim() || column.title;
    setEditingTitle(false);
    if (title === column.title) return;
    updateBoard(prev => ({
      ...prev,
      columns: prev.columns.map(c => c.id === column.id ? { ...c, title } : c),
    }));
  }

  function setColor(color: string) {
    setColorOpen(false);
    updateBoard(prev => ({
      ...prev,
      columns: prev.columns.map(c => c.id === column.id ? { ...c, color } : c),
    }));
  }

  function deleteColumn() {
    updateBoard(prev => ({
      ...prev,
      columns: prev.columns.filter(c => c.id !== column.id),
    }));
  }

  function toggleAutoComplete() {
    updateBoard(prev => ({
      ...prev,
      columns: prev.columns.map(c =>
        c.id === column.id ? { ...c, autoComplete: !c.autoComplete } : c,
      ),
    }));
  }

  function toggleHideFromTimeline() {
    updateBoard(prev => ({
      ...prev,
      columns: prev.columns.map(c =>
        c.id === column.id ? { ...c, hideFromTimeline: !c.hideFromTimeline } : c,
      ),
    }));
  }

  function toggleIsDoneDestination() {
    updateBoard(prev => ({
      ...prev,
      columns: prev.columns.map(c =>
        c.id === column.id ? { ...c, isDoneDestination: !c.isDoneDestination } : c,
      ),
    }));
  }

  function setSort(field: ColumnSortField) {
    updateBoard(prev => ({
      ...prev,
      columns: prev.columns.map(c => {
        if (c.id !== column.id) return c;
        if (field === 'none') return { ...c, sort: undefined };
        const dir = c.sort?.field === field && c.sort.dir === 'asc' ? 'desc' : 'asc';
        return { ...c, sort: { field, dir } };
      }),
    }));
  }

  function addDefaultTag() {
    const t = tagInput.trim();
    if (!t || (column.defaultTags ?? []).includes(t)) { setTagInput(''); return; }
    updateBoard(prev => ({
      ...prev,
      columns: prev.columns.map(c =>
        c.id !== column.id ? c : { ...c, defaultTags: [...(c.defaultTags ?? []), t] },
      ),
    }));
    setTagInput('');
  }

  function removeDefaultTag(tag: string) {
    updateBoard(prev => ({
      ...prev,
      columns: prev.columns.map(c =>
        c.id !== column.id ? c : { ...c, defaultTags: (c.defaultTags ?? []).filter(t => t !== tag) },
      ),
    }));
  }

  function addCard() {
    const title = cardDraft.trim();
    if (!title) { setAddingCard(false); return; }
    updateBoard(prev => ({
      ...prev,
      columns: prev.columns.map(c => {
        if (c.id !== column.id) return c;
        return {
          ...c,
          cards: [
            ...c.cards,
            {
              id: crypto.randomUUID(),
              title,
              assignees: [],
              tags: [...(c.defaultTags ?? [])],
              comments: [],
              checklist: [],
              createdAt: Date.now(),
              isDone: column.autoComplete ? true : undefined,
            },
          ],
        };
      }),
    }));
    setCardDraft('');
    setAddingCard(false);
  }

  // Sorted cards — archived cards are hidden from the board view
  const sortedCards = useMemo(() => {
    const sort = column.sort;
    const activeCards = column.cards.filter(c => !c.archived);
    if (!sort || sort.field === 'none') return activeCards;
    const cards = [...activeCards];
    cards.sort((a, b) => {
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
          const aName = knownUsers.find(u => a.assignees[0] === u.userId)?.userName ?? a.assignees[0] ?? '';
          const bName = knownUsers.find(u => b.assignees[0] === u.userId)?.userName ?? b.assignees[0] ?? '';
          cmp = aName.localeCompare(bName);
          break;
        }
      }
      return sort.dir === 'asc' ? cmp : -cmp;
    });
    return cards;
  }, [column.cards, column.sort, knownUsers]);

  const cardIds    = sortedCards.map(c => c.id);
  const activeSort = column.sort && column.sort.field !== 'none' ? column.sort : null;

  return (
    <>
      <div
        ref={setNodeRef}
        style={style}
        className="flex flex-col w-[272px] shrink-0"
      >
        {/* Column header */}
        <div className="flex items-center gap-1.5 px-2 pb-1.5 select-none">
          {/* Drag handle */}
          <button
            {...attributes}
            {...listeners}
            className="text-muted-foreground/30 hover:text-muted-foreground/70 transition-colors cursor-grab active:cursor-grabbing shrink-0 touch-none"
            title="Drag to reorder column"
          >
            <GripHorizontal size={13} />
          </button>

          {/* Color swatch */}
          <Popover
            open={colorOpen}
            onOpenChange={(o) => {
              setColorOpen(o);
              if (o) setHexDraft(column.color ?? '#64748b');
            }}
          >
            <PopoverTrigger asChild>
              <button
                className="w-3.5 h-3.5 rounded-full border border-white/15 hover:scale-125 transition-transform shrink-0 mt-0.5"
                style={{ backgroundColor: column.color ?? '#64748b' }}
              />
            </PopoverTrigger>
            <PopoverContent align="start" className="w-auto p-2.5 flex flex-col gap-2">
              {/* Preset swatches */}
              <div className="grid grid-cols-5 gap-2">
                {COLUMN_COLORS.map(c => (
                  <button
                    key={c}
                    onClick={() => setColor(c)}
                    className={cn(
                      'w-7 h-7 rounded-full border border-white/10 hover:scale-110 transition-transform',
                      column.color === c && 'ring-2 ring-white/60 ring-offset-1 ring-offset-popover',
                    )}
                    style={{ backgroundColor: c }}
                  />
                ))}
              </div>

              {/* Custom hex input */}
              <div className="border-t border-border/40 pt-2 flex items-center gap-2">
                <div
                  className="w-6 h-6 shrink-0 rounded-md border border-white/15"
                  style={{ backgroundColor: /^#[0-9a-f]{6}$/i.test(hexDraft) ? hexDraft : (column.color ?? '#64748b') }}
                />
                <Input
                  value={hexDraft}
                  onChange={e => setHexDraft(e.target.value)}
                  onKeyDown={e => {
                    if (e.key === 'Enter') {
                      const v = hexDraft.trim();
                      if (/^#[0-9a-f]{6}$/i.test(v)) setColor(v);
                    }
                  }}
                  onBlur={() => {
                    const v = hexDraft.trim();
                    if (/^#[0-9a-f]{6}$/i.test(v)) setColor(v);
                  }}
                  placeholder="#rrggbb"
                  className="h-7 w-28 font-mono text-xs px-2"
                  maxLength={7}
                  spellCheck={false}
                />
              </div>
            </PopoverContent>
          </Popover>

          {/* Title */}
          {editingTitle ? (
            <input
              ref={titleInputRef}
              value={titleDraft}
              onChange={e => setTitleDraft(e.target.value)}
              onBlur={() => { if (renameReadyRef.current) renameColumn(); }}
              onKeyDown={e => {
                if (e.key === 'Enter') renameColumn();
                if (e.key === 'Escape') { setTitleDraft(column.title); setEditingTitle(false); }
              }}
              className="flex-1 bg-transparent text-sm font-semibold text-foreground border-b border-primary/60 focus:outline-none min-w-0"
            />
          ) : (
            <button
              onDoubleClick={() => { setEditingTitle(true); setTitleDraft(column.title); }}
              className="flex-1 text-left text-sm font-semibold text-foreground truncate"
            >
              {column.title}
            </button>
          )}

          {/* Indicators */}
          {activeSort && (
            <span title={`Sorted by ${activeSort.field} (${activeSort.dir})`} className="shrink-0">
              {activeSort.dir === 'asc'
                ? <ArrowUp size={11} className="text-primary/60" />
                : <ArrowDown size={11} className="text-primary/60" />}
            </span>
          )}
          {column.isDoneDestination && (
            <span title="Done cards destination">
              <FolderInput size={11} className="text-blue-400/70 shrink-0" />
            </span>
          )}
          {column.hideFromTimeline && (
            <span title="Hidden from Calendar & Timeline">
              <CalendarOff size={11} className="text-muted-foreground/50 shrink-0" />
            </span>
          )}
          {column.autoComplete && (
            <span title="Auto-marks done on drop">
              <CheckCircle2 size={12} className="shrink-0" style={{ color: column.color ?? '#64748b', opacity: 0.7 }} />
            </span>
          )}

          <span className="text-[11px] text-muted-foreground shrink-0 tabular-nums">
            {column.cards.length}
          </span>

          {/* Column menu */}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button className="w-6 h-6 flex items-center justify-center rounded text-muted-foreground/50 hover:text-foreground hover:bg-accent/50 transition-colors shrink-0">
                <MoreHorizontal size={13} />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-52">
              <DropdownMenuItem
                onClick={() => { setEditingTitle(true); setTitleDraft(column.title); }}
                className="text-xs"
              >
                <Pencil size={11} className="mr-2" /> Rename
              </DropdownMenuItem>

              <DropdownMenuSeparator />

              {/* Sort submenu */}
              <DropdownMenuSub>
                <DropdownMenuSubTrigger className="text-xs">
                  <ArrowUpDown size={11} className="mr-2" />
                  Sort by
                  {activeSort && (
                    <span className="ml-auto text-[10px] text-primary/70 capitalize">
                      {activeSort.field}
                    </span>
                  )}
                </DropdownMenuSubTrigger>
                <DropdownMenuSubContent className="w-48">
                  {SORT_FIELDS.map(({ field, label }) => {
                    const isActive = field === 'none' ? !activeSort : activeSort?.field === field;
                    const dir = isActive && field !== 'none' ? activeSort!.dir : null;
                    return (
                      <DropdownMenuItem key={field} onClick={() => setSort(field)} className="text-xs">
                        <span className="flex-1">{label}</span>
                        {isActive && field === 'none' && <Check size={11} className="text-primary/70" />}
                        {dir === 'asc'  && <ArrowUp   size={11} className="text-primary/70" />}
                        {dir === 'desc' && <ArrowDown  size={11} className="text-primary/70" />}
                      </DropdownMenuItem>
                    );
                  })}
                </DropdownMenuSubContent>
              </DropdownMenuSub>

              <DropdownMenuSeparator />

              <DropdownMenuItem onClick={toggleAutoComplete} className="text-xs">
                <CheckCircle2 size={11} className={cn('mr-2', column.autoComplete ? 'text-green-400' : 'text-muted-foreground')} />
                Auto-mark done on drop
                {column.autoComplete && <span className="ml-auto text-[10px] text-green-400">On</span>}
              </DropdownMenuItem>

              <DropdownMenuItem onClick={toggleIsDoneDestination} className="text-xs">
                <FolderInput size={11} className={cn('mr-2', column.isDoneDestination ? 'text-blue-400' : 'text-muted-foreground')} />
                Done cards destination
                {column.isDoneDestination && <span className="ml-auto text-[10px] text-blue-400">On</span>}
              </DropdownMenuItem>

              <DropdownMenuItem onClick={toggleHideFromTimeline} className="text-xs">
                <CalendarOff size={11} className={cn('mr-2', column.hideFromTimeline ? 'text-amber-400' : 'text-muted-foreground')} />
                Hide from Calendar & Timeline
                {column.hideFromTimeline && <span className="ml-auto text-[10px] text-amber-400">On</span>}
              </DropdownMenuItem>

              <DropdownMenuItem
                onClick={() => setDefaultTagsOpen(true)}
                className="text-xs"
              >
                <Tag size={11} className={cn('mr-2', (column.defaultTags?.length ?? 0) > 0 ? 'text-primary/70' : 'text-muted-foreground')} />
                Default tags
                {(column.defaultTags?.length ?? 0) > 0 && (
                  <span className="ml-auto text-[10px] text-primary/70">{column.defaultTags!.length}</span>
                )}
              </DropdownMenuItem>

              <DropdownMenuSeparator />
              <DropdownMenuItem
                onClick={deleteColumn}
                className="text-xs text-destructive focus:text-destructive"
              >
                <Trash2 size={11} className="mr-2" /> Delete column
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>

        {/* Cards area */}
        <div
          className={cn(
            'flex flex-col flex-1 rounded-lg bg-muted/20 border border-border/30 transition-colors overflow-hidden',
            isOver && !isDragging && 'bg-primary/5 border-primary/30',
          )}
          style={
            !isOver && (column.autoComplete || column.isDoneDestination)
              ? { borderColor: `${column.color ?? '#64748b'}30` }
              : undefined
          }
        >
          <div className="flex-1 overflow-y-auto">
            <SortableContext items={cardIds} strategy={verticalListSortingStrategy}>
              <div className="flex flex-col gap-1.5 p-1.5 min-h-[60px]">
                {sortedCards.map(card => (
                  <KanbanCardView key={card.id} card={card} columnId={column.id} />
                ))}
              </div>
            </SortableContext>
          </div>

          {/* Add card */}
          <div className="p-1.5 shrink-0">
            {addingCard ? (
              <div className="flex flex-col gap-1.5">
                <textarea
                  autoFocus
                  value={cardDraft}
                  onChange={e => setCardDraft(e.target.value)}
                  onKeyDown={e => {
                    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); addCard(); }
                    if (e.key === 'Escape') { setAddingCard(false); setCardDraft(''); }
                  }}
                  placeholder="Card title..."
                  rows={2}
                  className="w-full bg-card text-sm px-2 py-1.5 rounded-md border border-border/50 focus:outline-none focus:ring-1 focus:ring-primary/50 resize-none text-foreground placeholder:text-muted-foreground/40"
                />
                <div className="flex gap-1.5">
                  <button
                    onClick={addCard}
                    className="flex-1 text-xs px-2 py-1 bg-primary/20 hover:bg-primary/30 text-primary rounded-md transition-colors"
                  >
                    Add card
                  </button>
                  <button
                    onClick={() => { setAddingCard(false); setCardDraft(''); }}
                    className="text-xs px-2 py-1 text-muted-foreground hover:text-foreground rounded-md transition-colors"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            ) : (
              <button
                onClick={() => setAddingCard(true)}
                className="w-full flex items-center gap-1.5 px-2 py-1.5 rounded-md text-xs text-muted-foreground hover:text-foreground hover:bg-accent/40 transition-colors"
              >
                <Plus size={12} />
                Add card
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Default tags dialog */}
      <Dialog open={defaultTagsOpen} onOpenChange={setDefaultTagsOpen}>
        <DialogContent className="sm:max-w-sm w-full p-0 gap-0">
          <DialogHeader className="px-4 py-3 border-b border-border/30">
            <DialogTitle className="text-sm font-semibold flex items-center gap-2">
              <Tag size={13} className="text-primary/70" />
              Default tags — <span className="font-normal text-muted-foreground">{column.title}</span>
            </DialogTitle>
          </DialogHeader>
          <div className="px-4 py-3 flex flex-col gap-3">
            <p className="text-xs text-muted-foreground/70">
              These tags are automatically added to every new card created in this column.
            </p>

            {/* Current tags */}
            {(column.defaultTags?.length ?? 0) > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {column.defaultTags!.map(tag => (
                  <span
                    key={tag}
                    className="flex items-center gap-1 text-xs px-2 py-0.5 bg-primary/15 text-primary/80 rounded-full"
                  >
                    {tag}
                    <button
                      onClick={() => removeDefaultTag(tag)}
                      className="hover:text-primary ml-0.5"
                    >
                      <X size={9} />
                    </button>
                  </span>
                ))}
              </div>
            )}

            {/* Add tag input */}
            <div className="flex gap-2">
              <input
                value={tagInput}
                onChange={e => setTagInput(e.target.value)}
                onKeyDown={e => {
                  if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); addDefaultTag(); }
                }}
                placeholder="Add tag, press Enter"
                className="flex-1 bg-muted/25 border border-border/30 rounded text-xs text-foreground px-2.5 py-1.5 focus:outline-none focus:ring-1 focus:ring-primary/40 placeholder:text-muted-foreground/40"
              />
              <button
                onClick={addDefaultTag}
                className="text-xs px-3 py-1.5 bg-primary/15 hover:bg-primary/25 text-primary rounded transition-colors"
              >
                Add
              </button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
