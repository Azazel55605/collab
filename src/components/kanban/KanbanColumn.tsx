import { useState } from 'react';
import { useDroppable } from '@dnd-kit/core';
import { SortableContext, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { MoreHorizontal, Plus, Trash2, Pencil, CheckCircle2 } from 'lucide-react';
import { cn } from '../../lib/utils';
import { useKanbanContext } from '../../views/KanbanPage';
import type { KanbanColumn } from '../../types/kanban';
import KanbanCardView from './KanbanCard';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '../ui/dropdown-menu';
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover';

const COLUMN_COLORS = [
  '#6366f1', '#8b5cf6', '#ec4899', '#ef4444',
  '#f97316', '#eab308', '#22c55e', '#14b8a6',
  '#3b82f6', '#64748b',
];

interface Props {
  column: KanbanColumn;
}

export default function KanbanColumnView({ column }: Props) {
  const { updateBoard } = useKanbanContext();
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft,   setTitleDraft]   = useState(column.title);
  const [addingCard,   setAddingCard]   = useState(false);
  const [cardDraft,    setCardDraft]    = useState('');
  const [colorOpen,    setColorOpen]    = useState(false);

  const { setNodeRef, isOver } = useDroppable({ id: column.id });

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
              tags: [],
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

  const cardIds = column.cards.map(c => c.id);

  return (
    <div className="flex flex-col w-[272px] shrink-0" style={{ maxHeight: 'calc(100vh - 120px)' }}>
      {/* Column header */}
      <div className="flex items-center gap-1.5 px-2 pb-1.5 select-none">
        {/* Color swatch — portal-rendered picker */}
        <Popover open={colorOpen} onOpenChange={setColorOpen}>
          <PopoverTrigger asChild>
            <button
              className="w-3.5 h-3.5 rounded-full border border-white/15 hover:scale-125 transition-transform shrink-0 mt-0.5"
              style={{ backgroundColor: column.color ?? '#64748b' }}
            />
          </PopoverTrigger>
          <PopoverContent align="start" className="w-auto p-2.5 grid grid-cols-5 gap-2">
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
          </PopoverContent>
        </Popover>

        {/* Title */}
        {editingTitle ? (
          <input
            autoFocus
            value={titleDraft}
            onChange={e => setTitleDraft(e.target.value)}
            onBlur={renameColumn}
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

        {/* Auto-complete indicator */}
        {column.autoComplete && (
          <span title="Auto-marks done on drop">
            <CheckCircle2 size={12} className="text-green-400/70 shrink-0" />
          </span>
        )}

        {/* Card count */}
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
            <DropdownMenuItem onClick={toggleAutoComplete} className="text-xs">
              <CheckCircle2 size={11} className={cn('mr-2', column.autoComplete ? 'text-green-400' : 'text-muted-foreground')} />
              <span>Auto-mark done on drop</span>
              {column.autoComplete && (
                <span className="ml-auto text-[10px] text-green-400">On</span>
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
        ref={setNodeRef}
        className={cn(
          'flex flex-col flex-1 rounded-lg bg-muted/20 border border-border/30 transition-colors overflow-hidden',
          column.autoComplete && 'border-green-500/20',
          isOver && 'bg-primary/5 border-primary/30',
        )}
      >
        <div className="flex-1 overflow-y-auto">
          <SortableContext items={cardIds} strategy={verticalListSortingStrategy}>
            <div className="flex flex-col gap-1.5 p-1.5 min-h-[60px]">
              {column.cards.map(card => (
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
  );
}
