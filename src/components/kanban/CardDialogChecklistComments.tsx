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
import { FULL_KANBAN_CAPABILITIES, type KanbanCapabilities } from '../../views/KanbanPage';
import { Button } from '../ui/button';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '../ui/command';
import { Input } from '../ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover';
import { Textarea } from '../ui/textarea';

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
  caps?: KanbanCapabilities;
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
  caps = FULL_KANBAN_CAPABILITIES,
}: Props) {
  const secondaryFieldClass =
    'border-border/40 bg-background/55 text-foreground placeholder:text-muted-foreground/50';

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
              className={cn(
                'h-full rounded-full transition-all',
                checklistDone === checklistTotal ? 'bg-green-500/70' : 'bg-primary/50',
              )}
              style={{ width: `${(checklistDone / checklistTotal) * 100}%` }}
            />
          </div>
        )}

        <div className="flex flex-col gap-1 mb-2">
          {draft.checklist.map((item) => (
            <div key={item.id} className="flex items-center gap-2 group/item">
              <button
                onClick={() => toggleChecklistItem(item.id)}
                disabled={!caps.editContent}
                className={cn(
                  'w-4 h-4 rounded border shrink-0 flex items-center justify-center transition-colors',
                  item.checked
                    ? 'bg-green-500/20 border-green-500/50 text-green-400'
                    : 'border-border/50 hover:border-primary/50',
                )}
                aria-label={
                  item.checked
                    ? `Mark ${item.text || item.cardRef || item.id} incomplete`
                    : `Mark ${item.text || item.cardRef || item.id} complete`
                }
              >
                {item.checked && <Check size={9} />}
              </button>

              {item.cardRef ? (
                <span
                  className={cn(
                    'flex-1 flex items-center gap-1 text-xs text-foreground/80',
                    item.checked && 'line-through text-muted-foreground',
                  )}
                >
                  <LayoutDashboard size={10} className="shrink-0 text-muted-foreground/60" />
                  {resolveCardTitle(item.cardRef)}
                </span>
              ) : (
                <input
                  value={item.text}
                  onChange={(e) => updateChecklistText(item.id, e.target.value)}
                  readOnly={!caps.editContent}
                  className={cn(
                    'flex-1 text-xs bg-transparent focus:outline-none text-foreground/80',
                    item.checked && 'line-through text-muted-foreground',
                  )}
                />
              )}

              {caps.editContent && (
                <button
                  onClick={() => removeChecklistItem(item.id)}
                  className="opacity-0 group-hover/item:opacity-100 text-muted-foreground/50 hover:text-destructive transition-all shrink-0"
                  aria-label={`Remove checklist item ${item.text || item.cardRef || item.id}`}
                >
                  <X size={10} />
                </button>
              )}
            </div>
          ))}
        </div>

        {caps.editContent && (
          <div className="flex gap-1.5">
            <Input
              value={checklistInput}
              onChange={(e) => setChecklistInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  addChecklistItem();
                }
              }}
              placeholder="Add subtask…"
              className={cn('h-8 flex-1 text-xs', secondaryFieldClass)}
            />
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={addChecklistItem}
              className="text-xs shrink-0"
            >
              Add
            </Button>

            <Popover open={cardPickerOpen} onOpenChange={setCardPickerOpen}>
              <PopoverTrigger asChild>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="px-2 shrink-0"
                  title="Link a board card as subtask"
                >
                  <LayoutDashboard size={12} />
                </Button>
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
                              {c.isDone ? (
                                <CheckCircle2 size={12} className="text-green-400 shrink-0" />
                              ) : (
                                <Circle size={12} className="text-muted-foreground/50 shrink-0" />
                              )}
                              <span
                                className={cn(
                                  'truncate',
                                  c.isDone && 'line-through text-muted-foreground',
                                )}
                              >
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
        )}
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
                      {new Date(comment.timestamp).toLocaleString(undefined, {
                        month: 'short',
                        day: 'numeric',
                        hour: '2-digit',
                        minute: '2-digit',
                      })}
                    </span>
                    {comment.userId === myUserId && caps.comment && (
                      <button
                        onClick={() => deleteComment(comment.id)}
                        className="ml-auto text-muted-foreground/40 hover:text-destructive transition-colors"
                        aria-label={`Delete comment ${comment.content}`}
                      >
                        <X size={10} />
                      </button>
                    )}
                  </div>
                  <p className="text-xs text-foreground/80 mt-0.5 whitespace-pre-wrap break-words">
                    {comment.content}
                  </p>
                </div>
              </div>
            ))}
          </div>
        )}

        {caps.comment && (
          <div className="flex gap-2 items-start">
            <div
              className="w-6 h-6 rounded-full flex items-center justify-center text-[10px] font-bold text-white shrink-0 mt-1"
              style={{ backgroundColor: myUserColor }}
            >
              {myUserName[0]?.toUpperCase()}
            </div>
            <div className="flex-1">
              <Textarea
                value={commentInput}
                onChange={(e) => setCommentInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    addComment();
                  }
                }}
                placeholder="Add comment… (Enter to post)"
                rows={2}
                className={cn('min-h-16 resize-none text-xs', secondaryFieldClass)}
              />
              {commentInput.trim() && (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={addComment}
                  className="mt-1 h-7 gap-1 text-xs"
                >
                  <Send size={10} /> Post
                </Button>
              )}
            </div>
          </div>
        )}
      </section>
    </>
  );
}
