import { format } from 'date-fns';
import {
  Archive,
  ArchiveRestore,
  ArchiveX,
  Calendar,
  Columns2,
  Flag,
  Trash2,
  Users,
} from 'lucide-react';

import { formatDate } from '../../store/uiStore';
import type { KanbanBoard, KanbanCard } from '../../types/kanban';
import { cn } from '../../lib/utils';
import { Calendar as CalendarUI } from '../ui/calendar';
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select';

type PriorityOption = {
  value: NonNullable<KanbanCard['priority']>;
  label: string;
  active: string;
  inactive: string;
};

type KnownUser = {
  userId: string;
  userName: string;
  userColor: string;
};

type Props = {
  draft: KanbanCard;
  priorities: PriorityOption[];
  dateFormat: Parameters<typeof formatDate>[1];
  knownUsers: KnownUser[];
  board: KanbanBoard;
  currentColumnId: string;
  confirmDelete: boolean;
  startDateOpen: boolean;
  dueDateOpen: boolean;
  setStartDateOpen: (open: boolean) => void;
  setDueDateOpen: (open: boolean) => void;
  setConfirmDelete: (confirm: boolean) => void;
  togglePriority: (priority: NonNullable<KanbanCard['priority']>) => void;
  patchDraft: (changes: Partial<KanbanCard>) => void;
  toggleAssignee: (userId: string) => void;
  moveToColumn: (columnId: string) => void;
  toggleArchive: () => void;
  deleteCard: () => void;
};

export function CardDialogSidebar({
  draft,
  priorities,
  dateFormat: selectedDateFormat,
  knownUsers,
  board,
  currentColumnId,
  confirmDelete,
  startDateOpen,
  dueDateOpen,
  setStartDateOpen,
  setDueDateOpen,
  setConfirmDelete,
  togglePriority,
  patchDraft,
  toggleAssignee,
  moveToColumn,
  toggleArchive,
  deleteCard,
}: Props) {
  return (
    <div className="w-52 shrink-0 border-l border-border/30 overflow-y-auto px-4 py-3 flex flex-col gap-4">
      <section>
        <label className="section-label flex items-center gap-1"><Flag size={11} /> Priority</label>
        <div className="flex flex-col gap-1">
          {priorities.map((opt) => (
            <button
              key={opt.value}
              onClick={() => togglePriority(opt.value)}
              className={cn('text-xs px-2.5 py-1.5 rounded-md border text-left transition-all', draft.priority === opt.value ? opt.active : opt.inactive)}
            >
              {opt.label}
            </button>
          ))}
          {draft.priority && (
            <button onClick={() => patchDraft({ priority: undefined })} className="text-[10px] text-muted-foreground/50 hover:text-muted-foreground transition-colors mt-0.5">
              Clear priority
            </button>
          )}
        </div>
      </section>

      <section>
        <label className="section-label flex items-center gap-1"><Calendar size={11} /> Start date</label>
        <Popover open={startDateOpen} onOpenChange={setStartDateOpen}>
          <PopoverTrigger asChild>
            <button className={cn(
              'w-full flex items-center gap-1.5 px-2.5 py-1.5 rounded border text-xs text-left transition-colors',
              'bg-muted/25 border-border/30 hover:border-border/60 focus:outline-none',
              draft.startDate ? 'text-foreground' : 'text-muted-foreground/50',
            )}>
              <Calendar size={10} className="shrink-0" />
              {draft.startDate
                ? formatDate(new Date(draft.startDate + 'T12:00:00'), selectedDateFormat)
                : 'Pick a date'}
            </button>
          </PopoverTrigger>
          <PopoverContent align="end" className="w-auto p-0" sideOffset={4}>
            <CalendarUI
              mode="single"
              selected={draft.startDate ? new Date(draft.startDate + 'T12:00:00') : undefined}
              onSelect={(date) => {
                patchDraft({ startDate: date ? format(date, 'yyyy-MM-dd') : undefined });
                setStartDateOpen(false);
              }}
            />
          </PopoverContent>
        </Popover>
        {draft.startDate && (
          <button onClick={() => patchDraft({ startDate: undefined })} className="text-[10px] text-muted-foreground/50 hover:text-muted-foreground transition-colors mt-0.5">
            Clear
          </button>
        )}
        {!draft.startDate && !draft.dueDate && (
          <p className="text-[10px] text-muted-foreground/40 mt-0.5">No date — hidden from Calendar & Timeline</p>
        )}
      </section>

      <section>
        <label className="section-label flex items-center gap-1"><Calendar size={11} /> Due date</label>
        <Popover open={dueDateOpen} onOpenChange={setDueDateOpen}>
          <PopoverTrigger asChild>
            <button className={cn(
              'w-full flex items-center gap-1.5 px-2.5 py-1.5 rounded border text-xs text-left transition-colors',
              'bg-muted/25 border-border/30 hover:border-border/60 focus:outline-none',
              draft.dueDate ? 'text-foreground' : 'text-muted-foreground/50',
            )}>
              <Calendar size={10} className="shrink-0" />
              {draft.dueDate
                ? formatDate(new Date(draft.dueDate + 'T12:00:00'), selectedDateFormat)
                : 'Pick a date'}
            </button>
          </PopoverTrigger>
          <PopoverContent align="end" className="w-auto p-0" sideOffset={4}>
            <CalendarUI
              mode="single"
              selected={draft.dueDate ? new Date(draft.dueDate + 'T12:00:00') : undefined}
              onSelect={(date) => {
                patchDraft({ dueDate: date ? format(date, 'yyyy-MM-dd') : undefined });
                setDueDateOpen(false);
              }}
            />
          </PopoverContent>
        </Popover>
        {draft.dueDate && (
          <button onClick={() => patchDraft({ dueDate: undefined })} className="text-[10px] text-muted-foreground/50 hover:text-muted-foreground transition-colors mt-0.5">
            Clear date
          </button>
        )}
      </section>

      <section>
        <label className="section-label flex items-center gap-1"><Users size={11} /> Assignees</label>
        {knownUsers.length === 0 ? (
          <p className="text-[10px] text-muted-foreground/50 mt-1">No collaborators yet</p>
        ) : (
          <div className="flex flex-col gap-1">
            {knownUsers.map((user) => {
              const assigned = draft.assignees.includes(user.userId);
              return (
                <button
                  key={user.userId}
                  onClick={() => toggleAssignee(user.userId)}
                  className={cn('flex items-center gap-2 px-2 py-1 rounded-md text-xs transition-all text-left w-full', assigned ? 'bg-primary/15 text-foreground' : 'text-muted-foreground hover:bg-accent/40')}
                >
                  <div className="w-4 h-4 rounded-full flex items-center justify-center text-[9px] font-bold text-white shrink-0" style={{ backgroundColor: user.userColor }}>
                    {user.userName[0]?.toUpperCase()}
                  </div>
                  <span className="truncate flex-1">{user.userName}</span>
                  {assigned && <span className="text-primary text-[10px] shrink-0">✓</span>}
                </button>
              );
            })}
          </div>
        )}
      </section>

      <section>
        <label className="section-label flex items-center gap-1"><Columns2 size={11} /> Column</label>
        <Select value={currentColumnId} onValueChange={moveToColumn}>
          <SelectTrigger className="h-7 text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {board.columns.map((column) => (
              <SelectItem key={column.id} value={column.id} className="text-xs">
                <span className="flex items-center gap-1.5">
                  <span className="w-2 h-2 rounded-full shrink-0 inline-block" style={{ backgroundColor: column.color ?? '#64748b' }} />
                  {column.title}
                </span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </section>

      <section>
        <button
          onClick={toggleArchive}
          className={cn(
            'w-full flex items-center gap-1.5 text-xs px-2 py-1.5 rounded transition-colors',
            draft.archived
              ? 'text-amber-500 hover:text-amber-400 hover:bg-amber-500/10'
              : 'text-muted-foreground/50 hover:text-muted-foreground hover:bg-accent/30',
          )}
        >
          {draft.archived ? <ArchiveRestore size={12} /> : <Archive size={12} />}
          {draft.archived ? 'Restore from archive' : 'Archive card'}
        </button>
      </section>

      {draft.archived && (
        <section>
          <label className="section-label flex items-center gap-1"><ArchiveX size={11} /> Archive</label>
          <div className="rounded-lg border border-border/30 bg-muted/25 px-2.5 py-2 text-xs text-muted-foreground space-y-1.5">
            {draft.archivedAt && (
              <div className="flex items-start justify-between gap-3">
                <span className="shrink-0">Archived</span>
                <span className="text-right text-foreground/80">
                  {format(new Date(draft.archivedAt), 'PPp')}
                </span>
              </div>
            )}
            {draft.archivedByUserName && (
              <div className="flex items-start justify-between gap-3">
                <span className="shrink-0">By</span>
                <span className="text-right text-foreground/80">{draft.archivedByUserName}</span>
              </div>
            )}
          </div>
        </section>
      )}

      <section className="mt-auto pt-3 border-t border-border/20">
        {confirmDelete ? (
          <div className="flex flex-col gap-1.5">
            <p className="text-[11px] text-muted-foreground">Delete this card?</p>
            <div className="flex gap-1.5">
              <button
                onClick={deleteCard}
                className="flex-1 text-xs px-2 py-1.5 bg-destructive/20 hover:bg-destructive/30 text-destructive rounded transition-colors"
              >
                Yes, delete
              </button>
              <button
                onClick={() => setConfirmDelete(false)}
                className="text-xs px-2 py-1.5 text-muted-foreground hover:text-foreground rounded transition-colors"
              >
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <button
            onClick={() => setConfirmDelete(true)}
            className="w-full flex items-center gap-1.5 text-xs px-2 py-1.5 text-muted-foreground/50 hover:text-destructive hover:bg-destructive/10 rounded transition-colors"
          >
            <Trash2 size={12} />
            Delete card
          </button>
        )}
      </section>
    </div>
  );
}
