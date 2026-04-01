import { useState } from 'react';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import {
  MessageSquare, Paperclip, Calendar,
  ArrowUp, ArrowRight, ArrowDown, CheckCircle2, Circle, FolderInput,
} from 'lucide-react';
import { cn } from '../../lib/utils';
import { useKanbanContext } from '../../views/KanbanPage';
import { useUiStore, formatDate } from '../../store/uiStore';
import type { KanbanCard, KanbanColumn } from '../../types/kanban';
import CardDialog from './CardDialog';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '../ui/dialog';

const PRIORITY_BADGE: Record<NonNullable<KanbanCard['priority']>, { label: string; cls: string; icon: React.ReactNode }> = {
  high:   { label: 'High',   cls: 'bg-red-500/20 text-red-400 border-red-500/30',         icon: <ArrowUp    size={9} /> },
  medium: { label: 'Medium', cls: 'bg-yellow-500/20 text-yellow-400 border-yellow-500/30', icon: <ArrowRight size={9} /> },
  low:    { label: 'Low',    cls: 'bg-green-500/20 text-green-400 border-green-500/30',    icon: <ArrowDown  size={9} /> },
};

interface Props {
  card: KanbanCard;
  columnId: string;
  isOverlay?: boolean;
}

export default function KanbanCardView({ card, columnId, isOverlay }: Props) {
  const { knownUsers, updateBoard, board } = useKanbanContext();
  const { dateFormat } = useUiStore();
  const [dialogOpen,    setDialogOpen]    = useState(false);
  const [destPicker,    setDestPicker]    = useState<KanbanColumn[] | null>(null);

  const colColor = board.columns.find(c => c.id === columnId)?.color ?? '#64748b';

  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id: card.id });

  const style = isOverlay ? undefined : {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.35 : 1,
  };

  const isOverdue =
    card.dueDate ? new Date(card.dueDate + 'T23:59:59') < new Date() : false;

  const assignedUsers = knownUsers.filter(u => card.assignees.includes(u.userId));

  const checklistTotal   = card.checklist?.length ?? 0;
  const checklistDone    = card.checklist?.filter(i => i.checked).length ?? 0;
  const checklistPercent = checklistTotal > 0 ? (checklistDone / checklistTotal) * 100 : 0;

  function moveCardToDest(destColId: string) {
    updateBoard(prev => {
      const cols = prev.columns.map(c => ({ ...c, cards: [...c.cards] }));
      const src  = cols.find(c => c.id === columnId);
      const dst  = cols.find(c => c.id === destColId);
      if (!src || !dst) return prev;
      const idx = src.cards.findIndex(c => c.id === card.id);
      if (idx === -1) return prev;
      const [moved] = src.cards.splice(idx, 1);
      dst.cards.push({ ...moved, isDone: true });
      return { ...prev, columns: cols };
    });
    setDestPicker(null);
  }

  function toggleDone(e: React.MouseEvent) {
    e.stopPropagation();
    if (isOverlay) return;

    const willBeDone = !card.isDone;

    if (willBeDone) {
      const dests = board.columns.filter(c => c.isDoneDestination && c.id !== columnId);
      if (dests.length === 1) {
        moveCardToDest(dests[0].id);
        return;
      }
      if (dests.length > 1) {
        setDestPicker(dests);
        return;
      }
    }

    updateBoard(prev => ({
      ...prev,
      columns: prev.columns.map(col =>
        col.id !== columnId ? col : {
          ...col,
          cards: col.cards.map(c => c.id !== card.id ? c : { ...c, isDone: willBeDone }),
        },
      ),
    }));
  }

  return (
    <>
      {/* The whole card is the drag handle; distance:5 in sensor means plain clicks still fire */}
      <div
        ref={setNodeRef}
        style={style}
        {...attributes}
        {...listeners}
        className={cn(
          'relative bg-card border border-border/40 rounded-md',
          'hover:border-border/70 hover:shadow-sm transition-all select-none',
          isDragging ? 'cursor-grabbing' : 'cursor-grab',
          card.isDone && 'opacity-60',
          isOverlay && 'shadow-2xl rotate-1 border-primary/40 scale-105 cursor-grabbing',
        )}
        onClick={() => !isOverlay && setDialogOpen(true)}
      >
        <div className="p-2.5">
          {/* Priority badge + tags */}
          {(card.priority || card.tags.length > 0) && (
            <div className="flex flex-wrap items-center gap-1 mb-1.5">
              {card.priority && (() => {
                const p = PRIORITY_BADGE[card.priority];
                return (
                  <span className={cn('flex items-center gap-1 text-[10px] font-semibold px-1.5 py-0.5 rounded border leading-none', p.cls)}>
                    {p.icon}{p.label}
                  </span>
                );
              })()}
              {card.tags.slice(0, 3).map(tag => (
                <span key={tag} className="text-[10px] px-1.5 py-0.5 bg-primary/15 text-primary/80 rounded-full leading-none">
                  {tag}
                </span>
              ))}
              {card.tags.length > 3 && (
                <span className="text-[10px] px-1.5 py-0.5 bg-muted/60 text-muted-foreground rounded-full leading-none">
                  +{card.tags.length - 3}
                </span>
              )}
            </div>
          )}

          {/* Done toggle + title */}
          <div className="flex items-start gap-1.5">
            {/* stopPropagation on pointerDown so drag sensor doesn't activate on this button */}
            <button
              onPointerDown={e => e.stopPropagation()}
              onClick={toggleDone}
              className="shrink-0 mt-0.5 text-muted-foreground/40 transition-colors"
              style={card.isDone ? undefined : { '--tw-hover-color': colColor } as React.CSSProperties}
              onMouseEnter={e => !card.isDone && ((e.currentTarget as HTMLElement).style.color = colColor)}
              onMouseLeave={e => !card.isDone && ((e.currentTarget as HTMLElement).style.color = '')}
              title={card.isDone ? 'Mark incomplete' : 'Mark done'}
            >
              {card.isDone
                ? <CheckCircle2 size={14} style={{ color: colColor }} />
                : <Circle size={14} />
              }
            </button>
            <p className={cn(
              'text-sm text-foreground leading-snug line-clamp-3 break-words flex-1',
              card.isDone && 'line-through text-muted-foreground',
            )}>
              {card.title}
            </p>
          </div>

          {/* Checklist progress */}
          {checklistTotal > 0 && (
            <div className="mt-2 flex items-center gap-1.5">
              <div className="flex-1 h-1 bg-muted/40 rounded-full overflow-hidden">
                <div
                  className={cn('h-full rounded-full transition-all', checklistPercent < 100 && 'bg-primary/50')}
                  style={{
                    width: `${checklistPercent}%`,
                    backgroundColor: checklistPercent === 100 ? colColor : undefined,
                    opacity: checklistPercent === 100 ? 0.75 : undefined,
                  }}
                />
              </div>
              <span className="text-[10px] text-muted-foreground tabular-nums shrink-0">
                {checklistDone}/{checklistTotal}
              </span>
            </div>
          )}

          {/* Footer */}
          {(card.dueDate || card.relativePath || card.comments.length > 0 || assignedUsers.length > 0) && (
            <div className="flex items-center justify-between mt-2 gap-2">
              <div className="flex items-center gap-2 text-[11px] text-muted-foreground min-w-0">
                {card.dueDate && (
                  <span className={cn('flex items-center gap-1 shrink-0', isOverdue && !card.isDone && 'text-destructive')}>
                    <Calendar size={10} />
                    {formatDate(new Date(card.dueDate + 'T12:00:00'), dateFormat)}
                  </span>
                )}
                {card.relativePath && (
                  <span className="flex items-center gap-1 shrink-0" title={card.relativePath}>
                    <Paperclip size={10} />
                  </span>
                )}
                {card.comments.length > 0 && (
                  <span className="flex items-center gap-1 shrink-0">
                    <MessageSquare size={10} />
                    {card.comments.length}
                  </span>
                )}
              </div>
              {assignedUsers.length > 0 && (
                <div className="flex items-center -space-x-1 shrink-0">
                  {assignedUsers.slice(0, 3).map(u => (
                    <div
                      key={u.userId}
                      title={u.userName}
                      className="w-5 h-5 rounded-full flex items-center justify-center text-[9px] font-bold text-white border border-card"
                      style={{ backgroundColor: u.userColor }}
                    >
                      {u.userName[0]?.toUpperCase()}
                    </div>
                  ))}
                  {assignedUsers.length > 3 && (
                    <div className="w-5 h-5 rounded-full flex items-center justify-center text-[9px] font-semibold bg-muted text-muted-foreground border border-card">
                      +{assignedUsers.length - 3}
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {dialogOpen && (
        <CardDialog card={card} columnId={columnId} onClose={() => setDialogOpen(false)} />
      )}

      {/* Done-destination picker — shown when multiple done-destination columns exist */}
      {destPicker && (
        <Dialog open onOpenChange={() => setDestPicker(null)}>
          <DialogContent className="sm:max-w-xs w-full p-0 gap-0">
            <DialogHeader className="px-4 py-3 border-b border-border/30">
              <DialogTitle className="text-sm font-semibold flex items-center gap-2">
                <FolderInput size={13} className="text-blue-400" />
                Move to done column
              </DialogTitle>
            </DialogHeader>
            <div className="flex flex-col py-1">
              {destPicker.map(col => (
                <button
                  key={col.id}
                  onClick={() => moveCardToDest(col.id)}
                  className="flex items-center gap-2.5 px-4 py-2 text-sm text-left hover:bg-accent/40 transition-colors"
                >
                  <div className="w-2.5 h-2.5 rounded-full shrink-0" style={{ backgroundColor: col.color ?? '#64748b' }} />
                  <span className="flex-1 truncate">{col.title}</span>
                  <span className="text-[10px] text-muted-foreground tabular-nums">{col.cards.length}</span>
                </button>
              ))}
              <div className="border-t border-border/20 mt-1 pt-1">
                <button
                  onClick={() => {
                    setDestPicker(null);
                    updateBoard(prev => ({
                      ...prev,
                      columns: prev.columns.map(col =>
                        col.id !== columnId ? col : {
                          ...col,
                          cards: col.cards.map(c => c.id !== card.id ? c : { ...c, isDone: true }),
                        },
                      ),
                    }));
                  }}
                  className="w-full px-4 py-2 text-xs text-muted-foreground hover:text-foreground hover:bg-accent/30 transition-colors text-left"
                >
                  Keep here (just mark done)
                </button>
              </div>
            </div>
          </DialogContent>
        </Dialog>
      )}
    </>
  );
}
