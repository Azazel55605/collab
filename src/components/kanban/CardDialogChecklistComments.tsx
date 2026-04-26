import {
  Check,
  CheckCircle2,
  Circle,
  LayoutDashboard,
  ListChecks,
  MessageSquare,
  Send,
  X,
} from 'lucide-react';

import { cn } from '../../lib/utils';
import type { KanbanBoard, KanbanCard } from '../../types/kanban';
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from '../ui/command';
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover';

type Props = {
  draft: KanbanCard;
  board: KanbanBoard;
  checklistInput: string;
  commentInput: string;
  cardPickerOpen: boolean;
  checklistDone: number;
  checklistTotal: number;
  myUserId: string;
  myUserName: string;
  myUserColor: string;
  setChecklistInput: (value: string) => void;
  setCommentInput: (value: string) => void;
  setCardPickerOpen: (open: boolean) => void;
  addChecklistItem: () => void;
  addChecklistItemFromCard: (cardId: string, title: string) => void;
  toggleChecklistItem: (itemId: string) => void;
  updateChecklistText: (itemId: string, text: string) => void;
  removeChecklistItem: (itemId: string) => void;
  resolveCardTitle: (cardId: string) => string;
  addComment: () => void;
  deleteComment: (commentId: string) => void;
};

export function CardDialogChecklistComments({
  draft,
  board,
  checklistInput,
  commentInput,
  cardPickerOpen,
  checklistDone,
  checklistTotal,
  myUserId,
  myUserName,
  myUserColor,
  setChecklistInput,
  setCommentInput,
  setCardPickerOpen,
  addChecklistItem,
  addChecklistItemFromCard,
  toggleChecklistItem,
  updateChecklistText,
  removeChecklistItem,
  resolveCardTitle,
  addComment,
  deleteComment,
}: Props) {
  return (
    <>
      <section>
        <label className="section-label flex items-center gap-1">
          <ListChecks size={11} />
          Checklist
          {checklistTotal > 0 && (
            <span className="ml-auto font-normal normal-case tracking-normal text-[11px] text-muted-foreground">
              {checklistDone}/{checklistTotal}
            </span>
          )}
        </label>

        {checklistTotal > 0 && (
          <div className="h-1.5 bg-muted/40 rounded-full overflow-hidden mb-2">
            <div
              className={cn('h-full rounded-full transition-all', checklistDone === checklistTotal ? 'bg-green-500/70' : 'bg-primary/50')}
              style={{ width: `${(checklistDone / checklistTotal) * 100}%` }}
            />
          </div>
        )}

        <div className="flex flex-col gap-1 mb-2">
          {draft.checklist.map((item) => (
            <div key={item.id} className="flex items-center gap-2 group/item">
              <button
                onClick={() => toggleChecklistItem(item.id)}
                className={cn(
                  'w-4 h-4 rounded border shrink-0 flex items-center justify-center transition-colors',
                  item.checked
                    ? 'bg-green-500/20 border-green-500/50 text-green-400'
                    : 'border-border/50 hover:border-primary/50',
                )}
                aria-label={item.checked ? `Mark ${item.text || item.cardRef || item.id} incomplete` : `Mark ${item.text || item.cardRef || item.id} complete`}
              >
                {item.checked && <Check size={9} />}
              </button>

              {item.cardRef ? (
                <span className={cn(
                  'flex-1 flex items-center gap-1 text-xs text-foreground/80',
                  item.checked && 'line-through text-muted-foreground',
                )}>
                  <LayoutDashboard size={10} className="shrink-0 text-muted-foreground/60" />
                  {resolveCardTitle(item.cardRef)}
                </span>
              ) : (
                <input
                  value={item.text}
                  onChange={(e) => updateChecklistText(item.id, e.target.value)}
                  className={cn(
                    'flex-1 text-xs bg-transparent focus:outline-none text-foreground/80',
                    item.checked && 'line-through text-muted-foreground',
                  )}
                />
              )}

              <button
                onClick={() => removeChecklistItem(item.id)}
                className="opacity-0 group-hover/item:opacity-100 text-muted-foreground/50 hover:text-destructive transition-all shrink-0"
                aria-label={`Remove checklist item ${item.text || item.cardRef || item.id}`}
              >
                <X size={10} />
              </button>
            </div>
          ))}
        </div>

        <div className="flex gap-1.5">
          <input
            value={checklistInput}
            onChange={(e) => setChecklistInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addChecklistItem(); } }}
            placeholder="Add subtask…"
            className="flex-1 bg-muted/25 border border-border/30 rounded text-xs text-foreground px-2.5 py-1.5 focus:outline-none focus:ring-1 focus:ring-primary/40 placeholder:text-muted-foreground/40"
          />
          <button
            onClick={addChecklistItem}
            className="text-xs px-2.5 py-1.5 bg-primary/15 hover:bg-primary/25 text-primary rounded transition-colors shrink-0"
          >
            Add
          </button>

          <Popover open={cardPickerOpen} onOpenChange={setCardPickerOpen}>
            <PopoverTrigger asChild>
              <button
                className="text-xs px-2 py-1.5 bg-muted/30 hover:bg-muted/50 text-muted-foreground hover:text-foreground rounded transition-colors shrink-0"
                title="Link a board card as subtask"
              >
                <LayoutDashboard size={12} />
              </button>
            </PopoverTrigger>
            <PopoverContent align="end" className="w-72 p-0">
              <Command>
                <CommandInput placeholder="Search board cards…" />
                <CommandList>
                  <CommandEmpty>No other cards found.</CommandEmpty>
                  {board.columns.map((col) => {
                    const eligible = col.cards.filter((c) => c.id !== draft.id);
                    if (eligible.length === 0) return null;
                    return (
                      <CommandGroup key={col.id} heading={col.title}>
                        {eligible.map((c) => (
                          <CommandItem
                            key={c.id}
                            value={c.title}
                            onSelect={() => addChecklistItemFromCard(c.id, c.title)}
                          >
                            {c.isDone
                              ? <CheckCircle2 size={12} className="text-green-400 shrink-0" />
                              : <Circle size={12} className="text-muted-foreground/50 shrink-0" />
                            }
                            <span className={cn('truncate', c.isDone && 'line-through text-muted-foreground')}>
                              {c.title}
                            </span>
                          </CommandItem>
                        ))}
                      </CommandGroup>
                    );
                  })}
                </CommandList>
              </Command>
            </PopoverContent>
          </Popover>
        </div>
      </section>

      <section>
        <label className="section-label flex items-center gap-1">
          <MessageSquare size={11} />
          Comments {draft.comments.length > 0 && `(${draft.comments.length})`}
        </label>

        {draft.comments.length > 0 && (
          <div className="flex flex-col gap-3 mb-3">
            {draft.comments.map((comment) => (
              <div key={comment.id} className="flex gap-2">
                <div
                  className="w-6 h-6 rounded-full flex items-center justify-center text-[10px] font-bold text-white shrink-0 mt-0.5"
                  style={{ backgroundColor: comment.userColor }}
                >
                  {comment.userName[0]?.toUpperCase()}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-baseline gap-2">
                    <span className="text-xs font-medium text-foreground">{comment.userName}</span>
                    <span className="text-[10px] text-muted-foreground/50">
                      {new Date(comment.timestamp).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
                    </span>
                    {comment.userId === myUserId && (
                      <button
                        onClick={() => deleteComment(comment.id)}
                        className="ml-auto text-muted-foreground/40 hover:text-destructive transition-colors"
                        aria-label={`Delete comment ${comment.content}`}
                      >
                        <X size={10} />
                      </button>
                    )}
                  </div>
                  <p className="text-xs text-foreground/80 mt-0.5 whitespace-pre-wrap break-words">{comment.content}</p>
                </div>
              </div>
            ))}
          </div>
        )}

        <div className="flex gap-2 items-start">
          <div
            className="w-6 h-6 rounded-full flex items-center justify-center text-[10px] font-bold text-white shrink-0 mt-1"
            style={{ backgroundColor: myUserColor }}
          >
            {myUserName[0]?.toUpperCase()}
          </div>
          <div className="flex-1">
            <textarea
              value={commentInput}
              onChange={(e) => setCommentInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); addComment(); } }}
              placeholder="Add comment… (Enter to post)"
              rows={2}
              className="w-full bg-muted/25 border border-border/30 rounded text-xs text-foreground p-2 resize-none focus:outline-none focus:ring-1 focus:ring-primary/40 placeholder:text-muted-foreground/40"
            />
            {commentInput.trim() && (
              <button onClick={addComment} className="mt-1 flex items-center gap-1 text-xs px-2.5 py-1 bg-primary/15 hover:bg-primary/25 text-primary rounded transition-colors">
                <Send size={10} /> Post
              </button>
            )}
          </div>
        </div>
      </section>
    </>
  );
}
