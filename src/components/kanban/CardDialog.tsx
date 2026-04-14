import { useState, useRef, useEffect, useMemo, useCallback } from 'react';
import { format } from 'date-fns';
import {
  X, Paperclip, Calendar, Tag, Users, MessageSquare,
  Trash2, Flag, ExternalLink, Send, ListChecks,
  LayoutDashboard, Check, Circle, CheckCircle2, ChevronDown, Archive, ArchiveRestore, Columns2,
} from 'lucide-react';
import { cn } from '../../lib/utils';
import { useKanbanContext } from '../../views/KanbanPage';
import { useKanbanStore } from '../../store/kanbanStore';
import { useCollabStore } from '../../store/collabStore';
import { useEditorStore } from '../../store/editorStore';
import { useUiStore, formatDate } from '../../store/uiStore';
import { useVaultStore } from '../../store/vaultStore';
import {
  getCardAttachmentPaths,
  getMissingColumnDefaultTags,
  mergeUniqueTags,
  setCardDoneState,
  type KanbanCard,
  type KanbanComment,
  type ChecklistItem,
} from '../../types/kanban';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '../ui/dialog';
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover';
import { Calendar as CalendarUI } from '../ui/calendar';
import {
  Command, CommandEmpty, CommandGroup, CommandInput,
  CommandItem, CommandList,
} from '../ui/command';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '../ui/select';
import { Button } from '../ui/button';
import type { NoteFile } from '../../types/vault';

// ── Priority config ────────────────────────────────────────────────────────

const PRIORITIES: Array<{
  value: NonNullable<KanbanCard['priority']>;
  label: string;
  active: string;
  inactive: string;
}> = [
  { value: 'high',   label: 'High',   active: 'bg-red-500/20 text-red-400 border-red-500/40',         inactive: 'text-muted-foreground border-border/30 hover:bg-accent/40' },
  { value: 'medium', label: 'Medium', active: 'bg-yellow-500/20 text-yellow-400 border-yellow-500/40', inactive: 'text-muted-foreground border-border/30 hover:bg-accent/40' },
  { value: 'low',    label: 'Low',    active: 'bg-green-500/20 text-green-400 border-green-500/40',    inactive: 'text-muted-foreground border-border/30 hover:bg-accent/40' },
];

// ── Component ─────────────────────────────────────────────────────────────

interface Props {
  card: KanbanCard;
  columnId: string;
  onClose: () => void;
}

interface MoveTagsPromptState {
  destinationColumnId: string;
  destinationColumnTitle: string;
  missingTags: string[];
}

function collectVaultFiles(nodes: NoteFile[]): NoteFile[] {
  const files: NoteFile[] = [];
  for (const node of nodes) {
    if (node.isFolder) {
      if (node.children) files.push(...collectVaultFiles(node.children));
      continue;
    }
    files.push(node);
  }
  return files;
}

function getTabTypeForPath(path: string): 'note' | 'canvas' | 'kanban' | 'image' | 'pdf' {
  const ext = path.split('.').pop()?.toLowerCase() ?? '';
  if (ext === 'canvas') return 'canvas';
  if (ext === 'kanban') return 'kanban';
  if (ext === 'pdf') return 'pdf';
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico', 'avif'].includes(ext)) return 'image';
  return 'note';
}

export default function CardDialog({ card: initialCard, columnId, onClose }: Props) {
  const { updateBoard, knownUsers, board } = useKanbanContext();
  const { myUserId, myUserName, myUserColor } = useCollabStore();
  const { openTab }       = useEditorStore();
  const { setActiveView, dateFormat } = useUiStore();
  const { fileTree }      = useVaultStore();
  const { draft: storedDraft, updateDraft: storeUpdateDraft } = useKanbanStore();

  // Restore in-progress edits if the user navigated away while this card was open.
  const [draft, setDraft] = useState<KanbanCard>(() => {
    const base = storedDraft && storedDraft.id === initialCard.id ? storedDraft : initialCard;
    return {
      ...base,
      checklist: base.checklist ?? [],
      attachmentPaths: getCardAttachmentPaths(base),
      relativePath: getCardAttachmentPaths(base)[0],
    };
  });
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const [tagInput,        setTagInput]        = useState('');
  const [tagInputFocused, setTagInputFocused] = useState(false);
  const [commentInput,    setCommentInput]     = useState('');
  const [checklistInput,  setChecklistInput]   = useState('');
  const [startDateOpen,   setStartDateOpen]    = useState(false);
  const [dueDateOpen,     setDueDateOpen]      = useState(false);
  const [notePickerOpen,  setNotePickerOpen]   = useState(false);
  const [cardPickerOpen,  setCardPickerOpen]   = useState(false);
  const [confirmDelete,   setConfirmDelete]    = useState(false);
  const [currentColumnId, setCurrentColumnId] = useState(columnId);
  const [moveTagsPrompt, setMoveTagsPrompt] = useState<MoveTagsPromptState | null>(null);
  const currentColIdRef = useRef(columnId); // kept in sync so flushDraft closure always has the right id

  // Auto-resize title textarea
  const titleRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (titleRef.current) {
      titleRef.current.style.height = 'auto';
      titleRef.current.style.height = titleRef.current.scrollHeight + 'px';
    }
  }, [draft.title]);

  // ── Board flush ──────────────────────────────────────────────────────────

  function flushDraft(d: KanbanCard) {
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    const colId = currentColIdRef.current;
    saveTimerRef.current = setTimeout(() => {
      updateBoard(prev => ({
        ...prev,
        columns: prev.columns.map(col =>
          col.id !== colId ? col : {
            ...col,
            cards: col.cards.map(c => c.id !== d.id ? c : d),
          },
        ),
      }));
    }, 300);
  }

  const patchDraft = useCallback((changes: Partial<KanbanCard>) => {
    setDraft(prev => {
      const next = { ...prev, ...changes };
      flushDraft(next);
      storeUpdateDraft(next); // keep store in sync so view switches don't lose edits
      return next;
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storeUpdateDraft]);

  function deleteCard() {
    updateBoard(prev => ({
      ...prev,
      columns: prev.columns.map(col =>
        col.id !== currentColIdRef.current ? col : {
          ...col,
          cards: col.cards.filter(c => c.id !== draft.id),
        },
      ),
    }));
    onClose();
  }

  function moveToColumn(newColId: string) {
    if (newColId === currentColIdRef.current) return;
    const srcColId = currentColIdRef.current;
    const destinationColumn = board.columns.find((col) => col.id === newColId);
    // Cancel any pending draft flush to avoid writing to the old column after the move
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    let promptRequest: MoveTagsPromptState | null = null;
    updateBoard(prev => {
      const srcCol = prev.columns.find(c => c.id === srcColId);
      const dstCol = prev.columns.find(c => c.id === newColId);
      if (!srcCol || !dstCol) return prev;
      const card = srcCol.cards.find(c => c.id === draft.id);
      if (!card) return prev;
      const missingTags = getMissingColumnDefaultTags(draft, dstCol);
      const shouldAutoApplyTags = dstCol.autoApplyDefaultTagsOnMove;
      if (missingTags.length > 0 && !shouldAutoApplyTags) {
        promptRequest = {
          destinationColumnId: dstCol.id,
          destinationColumnTitle: dstCol.title,
          missingTags,
        };
      }
      const movedCard = {
        ...draft,
        isDone: dstCol.autoComplete ? true : draft.isDone,
        tags: shouldAutoApplyTags ? mergeUniqueTags(draft.tags, missingTags) : draft.tags,
      };
      const nextBoard = {
        ...prev,
        columns: prev.columns.map(col => {
          if (col.id === srcColId) return { ...col, cards: col.cards.filter(c => c.id !== draft.id) };
          if (col.id === newColId) return { ...col, cards: [...col.cards, movedCard] };
          return col;
        }),
      };
      return setCardDoneState(nextBoard, draft.id, movedCard.isDone ?? false);
    });
    currentColIdRef.current = newColId;
    setCurrentColumnId(newColId);
    setDraft((prev) => {
      const next = {
        ...prev,
        isDone: destinationColumn?.autoComplete ? true : prev.isDone,
        tags: destinationColumn?.autoApplyDefaultTagsOnMove
          ? mergeUniqueTags(prev.tags, getMissingColumnDefaultTags(prev, destinationColumn))
          : prev.tags,
      };
      storeUpdateDraft(next);
      return next;
    });
    if (promptRequest) {
      setMoveTagsPrompt(promptRequest);
    }
  }

  function applyPromptTags(enableAutoApply: boolean) {
    if (!moveTagsPrompt) return;
    updateBoard((prev) => ({
      ...prev,
      columns: prev.columns.map((column) => {
        if (column.id !== moveTagsPrompt.destinationColumnId) return column;
        return {
          ...column,
          autoApplyDefaultTagsOnMove: enableAutoApply ? true : column.autoApplyDefaultTagsOnMove,
          cards: column.cards.map((entry) => (
            entry.id !== draft.id
              ? entry
              : { ...entry, tags: mergeUniqueTags(entry.tags, moveTagsPrompt.missingTags) }
          )),
        };
      }),
    }));
    setDraft((prev) => ({ ...prev, tags: mergeUniqueTags(prev.tags, moveTagsPrompt.missingTags) }));
    setMoveTagsPrompt(null);
  }

  function toggleArchive() {
    const isArchived = draft.archived;
    const colId = currentColIdRef.current;
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    updateBoard(prev => ({
      ...prev,
      columns: prev.columns.map(col =>
        col.id !== colId ? col : {
          ...col,
          cards: col.cards.map(c =>
            c.id !== draft.id ? c : {
              ...c,
              archived: isArchived ? undefined : true,
              archivedColumnId: isArchived ? undefined : colId,
            },
          ),
        },
      ),
    }));
    onClose();
  }

  // ── Done ─────────────────────────────────────────────────────────────────

  function toggleDone() {
    const nextIsDone = !draft.isDone;
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    updateBoard((prev) => setCardDoneState(prev, draft.id, nextIsDone));
    setDraft((prev) => {
      const next = { ...prev, isDone: nextIsDone };
      storeUpdateDraft(next);
      return next;
    });
  }

  // ── Tags ─────────────────────────────────────────────────────────────────

  function addTag() {
    const t = tagInput.trim().replace(/,$/, '');
    if (!t || draft.tags.includes(t)) { setTagInput(''); return; }
    patchDraft({ tags: [...draft.tags, t] });
    setTagInput('');
  }

  function removeTag(tag: string) {
    patchDraft({ tags: draft.tags.filter(t => t !== tag) });
  }

  // ── Priority / due date / assignees ──────────────────────────────────────

  function togglePriority(p: NonNullable<KanbanCard['priority']>) {
    patchDraft({ priority: draft.priority === p ? undefined : p });
  }

  function toggleAssignee(userId: string) {
    const assignees = draft.assignees.includes(userId)
      ? draft.assignees.filter(id => id !== userId)
      : [...draft.assignees, userId];
    patchDraft({ assignees });
  }

  // ── Attachments ───────────────────────────────────────────────────────────

  function setAttachmentPaths(paths: string[]) {
    const nextPaths = [...new Set(paths)];
    patchDraft({
      attachmentPaths: nextPaths.length > 0 ? nextPaths : undefined,
      relativePath: nextPaths[0],
    });
  }

  function addAttachment(path: string) {
    setNotePickerOpen(false);
    if (!path) return;
    setAttachmentPaths([...getCardAttachmentPaths(draft), path]);
  }

  function removeAttachment(path: string) {
    setAttachmentPaths(getCardAttachmentPaths(draft).filter((item) => item !== path));
  }

  function openAttachment(path: string) {
    const name = path.split('/').pop()?.replace(/\.[^.]+$/, '') ?? path;
    const type = getTabTypeForPath(path);
    openTab(path, name, type);
    if (type === 'canvas') setActiveView('canvas');
    else if (type === 'kanban') setActiveView('kanban');
    else setActiveView('editor');
    onClose();
  }

  // ── Checklist ─────────────────────────────────────────────────────────────

  function addChecklistItem() {
    const text = checklistInput.trim();
    if (!text) return;
    const item: ChecklistItem = { id: crypto.randomUUID(), text, checked: false };
    patchDraft({ checklist: [...draft.checklist, item] });
    setChecklistInput('');
  }

  function addChecklistItemFromCard(cardId: string, cardTitle: string) {
    setCardPickerOpen(false);
    const item: ChecklistItem = {
      id: crypto.randomUUID(),
      text: cardTitle,
      checked: false,
      cardRef: cardId,
    };
    patchDraft({ checklist: [...draft.checklist, item] });
  }

  function toggleChecklistItem(id: string) {
    patchDraft({
      checklist: draft.checklist.map(i => i.id === id ? { ...i, checked: !i.checked } : i),
    });
  }

  function updateChecklistText(id: string, text: string) {
    patchDraft({
      checklist: draft.checklist.map(i => i.id === id ? { ...i, text } : i),
    });
  }

  function removeChecklistItem(id: string) {
    patchDraft({ checklist: draft.checklist.filter(i => i.id !== id) });
  }

  // Resolve card title from the board (for cardRef items)
  function resolveCardTitle(cardId: string): string {
    for (const col of board.columns) {
      const found = col.cards.find(c => c.id === cardId);
      if (found) return found.title;
    }
    return '(deleted card)';
  }

  // ── Comments ──────────────────────────────────────────────────────────────

  function addComment() {
    const content = commentInput.trim();
    if (!content) return;
    const comment: KanbanComment = {
      id: crypto.randomUUID(),
      userId: myUserId, userName: myUserName, userColor: myUserColor,
      content,
      timestamp: Date.now(),
    };
    setCommentInput('');
    patchDraft({ comments: [...draft.comments, comment] });
  }

  function deleteComment(id: string) {
    patchDraft({ comments: draft.comments.filter(c => c.id !== id) });
  }

  // ── Derived ───────────────────────────────────────────────────────────────

  const checklistDone  = draft.checklist.filter(i => i.checked).length;
  const checklistTotal = draft.checklist.length;
  const attachmentPaths = getCardAttachmentPaths(draft);
  const vaultFiles = useMemo(
    () => collectVaultFiles(fileTree).sort((a, b) => a.relativePath.localeCompare(b.relativePath, undefined, { sensitivity: 'base' })),
    [fileTree],
  );

  // All unique tags from the board (cards + column defaults), excluding ones already on this card
  const suggestedTags = useMemo(() => {
    const all = new Set<string>();
    for (const col of board.columns) {
      for (const c of col.cards) c.tags.forEach(t => all.add(t));
      for (const t of col.defaultTags ?? []) all.add(t);
    }
    return [...all]
      .filter(t => !draft.tags.includes(t))
      .filter(t => !tagInput || t.toLowerCase().includes(tagInput.toLowerCase()))
      .sort();
  }, [board, draft.tags, tagInput]);

  const showTagSuggestions = tagInputFocused && suggestedTags.length > 0;


  return (
    <Dialog open onOpenChange={open => !open && onClose()}>
      <DialogContent className="sm:max-w-3xl w-full max-h-[90vh] overflow-hidden flex flex-col p-0 gap-0">

        {/* ── Title row ─────────────────────────────────────────────────── */}
        <div className="flex items-start gap-2.5 px-5 pt-5 pb-2 pr-12 shrink-0">
          {/* Done toggle */}
          <button
            onClick={toggleDone}
            className="shrink-0 mt-0 transition-colors"
            title={draft.isDone ? 'Mark incomplete' : 'Mark done'}
          >
            {draft.isDone
              ? <CheckCircle2 size={18} className="text-green-400" />
              : <Circle size={18} className="text-muted-foreground/40 hover:text-green-400" />
            }
          </button>

          <textarea
            ref={titleRef}
            value={draft.title}
            onChange={e => patchDraft({ title: e.target.value })}
            rows={1}
            placeholder="Card title"
            className={cn(
              'flex-1 bg-transparent text-lg font-semibold text-foreground resize-none focus:outline-none leading-tight overflow-hidden min-w-0 p-0',
              draft.isDone && 'line-through text-muted-foreground',
            )}
          />
        </div>

        {/* ── Body ──────────────────────────────────────────────────────── */}
        <div className="flex flex-1 min-h-0">
          {/* Main column */}
          <div className="flex-1 overflow-y-auto px-5 py-3 flex flex-col gap-4 min-w-0">

            {/* Description */}
            <section>
              <label className="section-label">Description</label>
              <textarea
                value={draft.description ?? ''}
                onChange={e => patchDraft({ description: e.target.value || undefined })}
                rows={6}
                placeholder="Add a description..."
                className="w-full bg-muted/25 border border-border/30 rounded-md text-sm text-foreground p-2.5 resize-none focus:outline-none focus:ring-1 focus:ring-primary/40 placeholder:text-muted-foreground/40"
              />
            </section>

            {/* Tags */}
            <section>
              <label className="section-label flex items-center gap-1"><Tag size={11} /> Tags</label>
              <div className="flex flex-wrap gap-1.5 mb-2">
                {draft.tags.map(tag => (
                  <span key={tag} className="flex items-center gap-1 text-xs px-2 py-0.5 bg-primary/15 text-primary/80 rounded-full">
                    {tag}
                    <button onClick={() => removeTag(tag)} className="hover:text-primary ml-0.5"><X size={9} /></button>
                  </span>
                ))}
              </div>
              <div className="relative flex gap-2">
                <div className="flex-1 relative">
                  <input
                    value={tagInput}
                    onChange={e => setTagInput(e.target.value)}
                    onFocus={() => setTagInputFocused(true)}
                    onBlur={() => setTimeout(() => setTagInputFocused(false), 150)}
                    onKeyDown={e => {
                      if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); addTag(); }
                      if (e.key === 'Escape') setTagInputFocused(false);
                    }}
                    placeholder="Type tag, press Enter"
                    className="w-full bg-muted/25 border border-border/30 rounded text-xs text-foreground px-2.5 py-1.5 focus:outline-none focus:ring-1 focus:ring-primary/40 placeholder:text-muted-foreground/40"
                  />
                  {showTagSuggestions && (
                    <div className="absolute top-full left-0 right-0 mt-1 z-50 bg-popover border border-border/50 rounded-md shadow-lg overflow-hidden max-h-40 overflow-y-auto">
                      {suggestedTags.map(tag => (
                        <button
                          key={tag}
                          onMouseDown={e => e.preventDefault()}
                          onClick={() => {
                            patchDraft({ tags: [...draft.tags, tag] });
                            setTagInput('');
                            setTagInputFocused(false);
                          }}
                          className="w-full text-left text-xs px-2.5 py-1.5 hover:bg-accent/60 transition-colors text-foreground/80"
                        >
                          {tag}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
                <button onClick={addTag} className="text-xs px-3 py-1.5 bg-primary/15 hover:bg-primary/25 text-primary rounded transition-colors shrink-0">
                  Add
                </button>
              </div>
            </section>

            {/* Attachments — Command picker via Popover portal */}
            <section>
              <label className="section-label flex items-center gap-1">
                <Paperclip size={11} />
                Attachments
                {attachmentPaths.length > 0 && (
                  <span className="ml-auto font-normal normal-case tracking-normal text-[11px] text-muted-foreground">
                    {attachmentPaths.length}
                  </span>
                )}
              </label>

              {attachmentPaths.length > 0 && (
                <div className="flex flex-col gap-1.5 mb-2">
                  {attachmentPaths.map((path) => (
                    <div key={path} className="flex items-center gap-2 rounded border border-border/30 bg-muted/20 px-2.5 py-1.5">
                      <Paperclip size={11} className="shrink-0 text-primary/70" />
                      <span className="flex-1 truncate font-mono text-xs text-foreground" title={path}>{path}</span>
                      <span className="shrink-0 rounded-full bg-primary/12 px-1.5 py-0.5 text-[10px] text-primary/80">
                        Attached
                      </span>
                      <button
                        onClick={() => openAttachment(path)}
                        className="flex items-center gap-1 text-xs px-2 py-1 bg-primary/15 hover:bg-primary/25 text-primary rounded transition-colors shrink-0"
                        title="Open file"
                      >
                        <ExternalLink size={11} />
                      </button>
                      <button
                        onClick={() => removeAttachment(path)}
                        className="flex items-center gap-1 text-xs px-2 py-1 text-muted-foreground hover:text-foreground rounded transition-colors shrink-0"
                        title="Remove attachment"
                      >
                        <X size={11} />
                      </button>
                    </div>
                  ))}
                </div>
              )}

              <div className="flex gap-2">
                <Popover open={notePickerOpen} onOpenChange={setNotePickerOpen}>
                  <PopoverTrigger asChild>
                    <button className={cn(
                      'flex-1 flex items-center justify-between gap-2 px-2.5 py-1.5 rounded border text-xs text-left transition-colors',
                      'bg-muted/25 border-border/30 hover:border-border/60 focus:outline-none focus:ring-1 focus:ring-primary/40',
                      'text-muted-foreground/60',
                    )}>
                      <span className="truncate">Add file…</span>
                      <ChevronDown size={11} className="shrink-0 text-muted-foreground/50" />
                    </button>
                  </PopoverTrigger>
                  <PopoverContent align="start" className="w-80 p-0">
                    <Command>
                      <CommandInput placeholder="Search vault files…" />
                      <CommandList>
                        <CommandEmpty>No files found.</CommandEmpty>
                        <CommandGroup>
                          {vaultFiles.map((file) => (
                            <CommandItem
                              key={file.relativePath}
                              value={`${file.relativePath} ${file.name}`}
                              onSelect={() => addAttachment(file.relativePath)}
                            >
                              <span className="font-medium truncate">{file.name.replace(/\.[^.]+$/, '')}</span>
                              {attachmentPaths.includes(file.relativePath) && (
                                <span className="rounded-full bg-primary/12 px-1.5 py-0.5 text-[10px] text-primary/80 shrink-0">
                                  Attached
                                </span>
                              )}
                              <span className="ml-auto text-[10px] text-muted-foreground/60 font-mono truncate max-w-[120px]">
                                {file.relativePath}
                              </span>
                            </CommandItem>
                          ))}
                        </CommandGroup>
                      </CommandList>
                    </Command>
                  </PopoverContent>
                </Popover>
              </div>
            </section>

            {/* Checklist */}
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

              {/* Progress bar */}
              {checklistTotal > 0 && (
                <div className="h-1.5 bg-muted/40 rounded-full overflow-hidden mb-2">
                  <div
                    className={cn('h-full rounded-full transition-all', checklistDone === checklistTotal ? 'bg-green-500/70' : 'bg-primary/50')}
                    style={{ width: `${(checklistDone / checklistTotal) * 100}%` }}
                  />
                </div>
              )}

              {/* Items */}
              <div className="flex flex-col gap-1 mb-2">
                {draft.checklist.map(item => (
                  <div key={item.id} className="flex items-center gap-2 group/item">
                    <button
                      onClick={() => toggleChecklistItem(item.id)}
                      className={cn(
                        'w-4 h-4 rounded border shrink-0 flex items-center justify-center transition-colors',
                        item.checked
                          ? 'bg-green-500/20 border-green-500/50 text-green-400'
                          : 'border-border/50 hover:border-primary/50',
                      )}
                    >
                      {item.checked && <Check size={9} />}
                    </button>

                    {item.cardRef ? (
                      // Card reference — show icon + resolved title (read-only text)
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
                        onChange={e => updateChecklistText(item.id, e.target.value)}
                        className={cn(
                          'flex-1 text-xs bg-transparent focus:outline-none text-foreground/80',
                          item.checked && 'line-through text-muted-foreground',
                        )}
                      />
                    )}

                    <button
                      onClick={() => removeChecklistItem(item.id)}
                      className="opacity-0 group-hover/item:opacity-100 text-muted-foreground/50 hover:text-destructive transition-all shrink-0"
                    >
                      <X size={10} />
                    </button>
                  </div>
                ))}
              </div>

              {/* Add checklist item */}
              <div className="flex gap-1.5">
                <input
                  value={checklistInput}
                  onChange={e => setChecklistInput(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); addChecklistItem(); } }}
                  placeholder="Add subtask…"
                  className="flex-1 bg-muted/25 border border-border/30 rounded text-xs text-foreground px-2.5 py-1.5 focus:outline-none focus:ring-1 focus:ring-primary/40 placeholder:text-muted-foreground/40"
                />
                <button
                  onClick={addChecklistItem}
                  className="text-xs px-2.5 py-1.5 bg-primary/15 hover:bg-primary/25 text-primary rounded transition-colors shrink-0"
                >
                  Add
                </button>

                {/* Link a board card */}
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
                        {board.columns.map(col => {
                          const eligible = col.cards.filter(c => c.id !== draft.id);
                          if (eligible.length === 0) return null;
                          return (
                            <CommandGroup key={col.id} heading={col.title}>
                              {eligible.map(c => (
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

            {/* Comments */}
            <section>
              <label className="section-label flex items-center gap-1">
                <MessageSquare size={11} />
                Comments {draft.comments.length > 0 && `(${draft.comments.length})`}
              </label>

              {draft.comments.length > 0 && (
                <div className="flex flex-col gap-3 mb-3">
                  {draft.comments.map(comment => (
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
                            <button onClick={() => deleteComment(comment.id)} className="ml-auto text-muted-foreground/40 hover:text-destructive transition-colors">
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
                    onChange={e => setCommentInput(e.target.value)}
                    onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); addComment(); } }}
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
          </div>

          {/* ── Sidebar: metadata ────────────────────────────────────────── */}
          <div className="w-52 shrink-0 border-l border-border/30 overflow-y-auto px-4 py-3 flex flex-col gap-4">

            {/* Priority */}
            <section>
              <label className="section-label flex items-center gap-1"><Flag size={11} /> Priority</label>
              <div className="flex flex-col gap-1">
                {PRIORITIES.map(opt => (
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

            {/* Start date */}
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
                      ? formatDate(new Date(draft.startDate + 'T12:00:00'), dateFormat)
                      : 'Pick a date'}
                  </button>
                </PopoverTrigger>
                <PopoverContent align="end" className="w-auto p-0" sideOffset={4}>
                  <CalendarUI
                    mode="single"
                    selected={draft.startDate ? new Date(draft.startDate + 'T12:00:00') : undefined}
                    onSelect={d => {
                      patchDraft({ startDate: d ? format(d, 'yyyy-MM-dd') : undefined });
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

            {/* Due date */}
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
                      ? formatDate(new Date(draft.dueDate + 'T12:00:00'), dateFormat)
                      : 'Pick a date'}
                  </button>
                </PopoverTrigger>
                <PopoverContent align="end" className="w-auto p-0" sideOffset={4}>
                  <CalendarUI
                    mode="single"
                    selected={draft.dueDate ? new Date(draft.dueDate + 'T12:00:00') : undefined}
                    onSelect={d => {
                      patchDraft({ dueDate: d ? format(d, 'yyyy-MM-dd') : undefined });
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

            {/* Assignees */}
            <section>
              <label className="section-label flex items-center gap-1"><Users size={11} /> Assignees</label>
              {knownUsers.length === 0 ? (
                <p className="text-[10px] text-muted-foreground/50 mt-1">No collaborators yet</p>
              ) : (
                <div className="flex flex-col gap-1">
                  {knownUsers.map(user => {
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

            {/* Column (category) */}
            <section>
              <label className="section-label flex items-center gap-1"><Columns2 size={11} /> Column</label>
              <Select value={currentColumnId} onValueChange={moveToColumn}>
                <SelectTrigger className="h-7 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {board.columns.map(col => (
                    <SelectItem key={col.id} value={col.id} className="text-xs">
                      <span className="flex items-center gap-1.5">
                        <span className="w-2 h-2 rounded-full shrink-0 inline-block" style={{ backgroundColor: col.color ?? '#64748b' }} />
                        {col.title}
                      </span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </section>

            {/* Archive */}
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

            {/* Delete — bottom of sidebar */}
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
        </div>
      </DialogContent>

      {moveTagsPrompt && (
        <Dialog open onOpenChange={() => setMoveTagsPrompt(null)}>
          <DialogContent className="sm:max-w-md">
            <DialogHeader>
              <DialogTitle>Apply column tags?</DialogTitle>
            </DialogHeader>
            <div className="space-y-3 text-sm">
              <p className="text-muted-foreground">
                <span className="font-medium text-foreground">{draft.title}</span> was moved to{' '}
                <span className="font-medium text-foreground">{moveTagsPrompt.destinationColumnTitle}</span>.
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
            <DialogFooter className="gap-2 sm:justify-between">
              <Button variant="ghost" onClick={() => setMoveTagsPrompt(null)}>
                Not now
              </Button>
              <div className="flex gap-2">
                <Button variant="outline" onClick={() => applyPromptTags(false)}>
                  Apply once
                </Button>
                <Button onClick={() => applyPromptTags(true)}>
                  Always apply here
                </Button>
              </div>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </Dialog>
  );
}
