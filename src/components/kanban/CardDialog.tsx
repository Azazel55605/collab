import { useEffect, useMemo, useRef, useState } from 'react';

import { CheckCircle2, Circle } from 'lucide-react';

import { cn } from '../../lib/utils';
import { useCollabStore } from '../../store/collabStore';
import { useEditorStore } from '../../store/editorStore';
import { useKanbanStore } from '../../store/kanbanStore';
import { useUiStore } from '../../store/uiStore';
import { useVaultStore } from '../../store/vaultStore';
import { getCardAttachmentPaths, type KanbanCard } from '../../types/kanban';
import type { NoteFile } from '../../types/vault';
import { useKanbanContext } from '../../views/KanbanPage';
import { Dialog, DialogContent } from '../ui/dialog';

import { CardDialogChecklistComments } from './CardDialogChecklistComments';
import { CardDialogMoveTagsPrompt } from './CardDialogMoveTagsPrompt';
import { CardDialogSidebar } from './CardDialogSidebar';
import { CardDialogTagsAttachments } from './CardDialogTagsAttachments';
import { useCardDialogActions } from './useCardDialogActions';
import { useCardDialogChecklistComments } from './useCardDialogChecklistComments';
import { useCardDialogDraftSession } from './useCardDialogDraftSession';

// ── Priority config ────────────────────────────────────────────────────────

const PRIORITIES: Array<{
  value: NonNullable<KanbanCard['priority']>;
  label: string;
  active: string;
  inactive: string;
}> = [
  {
    value: 'high',
    label: 'High',
    active: 'bg-red-500/20 text-red-400 border-red-500/40',
    inactive: 'text-muted-foreground border-border/30 hover:bg-accent/40',
  },
  {
    value: 'medium',
    label: 'Medium',
    active: 'bg-yellow-500/20 text-yellow-400 border-yellow-500/40',
    inactive: 'text-muted-foreground border-border/30 hover:bg-accent/40',
  },
  {
    value: 'low',
    label: 'Low',
    active: 'bg-green-500/20 text-green-400 border-green-500/40',
    inactive: 'text-muted-foreground border-border/30 hover:bg-accent/40',
  },
];

// ── Component ─────────────────────────────────────────────────────────────

interface Props {
  card: KanbanCard;
  columnId: string;
  onClose: () => void;
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
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico', 'avif'].includes(ext))
    return 'image';
  return 'note';
}

export default function CardDialog({ card: initialCard, columnId, onClose }: Props) {
  const { updateBoard, knownUsers, board, caps } = useKanbanContext();
  const { myUserId, myUserName, myUserColor } = useCollabStore();
  const { openTab } = useEditorStore();
  const { setActiveView, dateFormat } = useUiStore();
  const { fileTree } = useVaultStore();
  const { draft: storedDraft, updateDraft: storeUpdateDraft } = useKanbanStore();

  const [tagInput, setTagInput] = useState('');
  const [tagInputFocused, setTagInputFocused] = useState(false);
  const [startDateOpen, setStartDateOpen] = useState(false);
  const [dueDateOpen, setDueDateOpen] = useState(false);
  const [notePickerOpen, setNotePickerOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const {
    draft,
    setDraft,
    patchDraft,
    currentColumnId,
    setCurrentColumnId,
    currentColIdRef,
    cancelPendingFlush,
  } = useCardDialogDraftSession({
    initialCard,
    storedDraft,
    columnId,
    updateBoard,
    storeUpdateDraft,
  });
  const {
    moveTagsPrompt,
    setMoveTagsPrompt,
    deleteCard,
    moveToColumn,
    applyPromptTags,
    toggleArchive,
    toggleDone,
  } = useCardDialogActions({
    board,
    draft,
    myUserId,
    myUserName,
    setDraft,
    currentColIdRef,
    setCurrentColumnId,
    updateBoard,
    storeUpdateDraft,
    cancelPendingFlush,
    onClose,
  });
  const {
    commentInput,
    setCommentInput,
    checklistInput,
    setChecklistInput,
    cardPickerOpen,
    setCardPickerOpen,
    addChecklistItem,
    addChecklistItemFromCard,
    toggleChecklistItem,
    updateChecklistText,
    removeChecklistItem,
    resolveCardTitle,
    addComment,
    deleteComment,
    checklistDone,
    checklistTotal,
  } = useCardDialogChecklistComments({
    board,
    draft,
    patchDraft,
    myUserId,
    myUserName,
    myUserColor,
  });

  // Auto-resize title textarea
  const titleRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (titleRef.current) {
      titleRef.current.style.height = 'auto';
      titleRef.current.style.height = titleRef.current.scrollHeight + 'px';
    }
  }, [draft.title]);

  // ── Tags ─────────────────────────────────────────────────────────────────

  function addTag() {
    const t = tagInput.trim().replace(/,$/, '');
    if (!t || draft.tags.includes(t)) {
      setTagInput('');
      return;
    }
    patchDraft({ tags: [...draft.tags, t] });
    setTagInput('');
  }

  function removeTag(tag: string) {
    patchDraft({ tags: draft.tags.filter((t) => t !== tag) });
  }

  // ── Priority / due date / assignees ──────────────────────────────────────

  function togglePriority(p: NonNullable<KanbanCard['priority']>) {
    patchDraft({ priority: draft.priority === p ? undefined : p });
  }

  function toggleAssignee(userId: string) {
    const assignees = draft.assignees.includes(userId)
      ? draft.assignees.filter((id) => id !== userId)
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
    const name =
      path
        .split('/')
        .pop()
        ?.replace(/\.[^.]+$/, '') ?? path;
    const type = getTabTypeForPath(path);
    openTab(path, name, type);
    if (type === 'canvas') setActiveView('canvas');
    else if (type === 'kanban') setActiveView('kanban');
    else setActiveView('editor');
    onClose();
  }

  // ── Derived ───────────────────────────────────────────────────────────────
  const attachmentPaths = getCardAttachmentPaths(draft);
  const vaultFiles = useMemo(
    () =>
      collectVaultFiles(fileTree).sort((a, b) =>
        a.relativePath.localeCompare(b.relativePath, undefined, { sensitivity: 'base' }),
      ),
    [fileTree],
  );

  // All unique tags from the board (cards + column defaults), excluding ones already on this card
  const suggestedTags = useMemo(() => {
    const all = new Set<string>();
    for (const col of board.columns) {
      for (const c of col.cards) c.tags.forEach((t) => all.add(t));
      for (const t of col.defaultTags ?? []) all.add(t);
    }
    return [...all]
      .filter((t) => !draft.tags.includes(t))
      .filter((t) => !tagInput || t.toLowerCase().includes(tagInput.toLowerCase()))
      .sort();
  }, [board, draft.tags, tagInput]);

  const showTagSuggestions = tagInputFocused && suggestedTags.length > 0;

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-3xl w-full max-h-[90vh] overflow-hidden flex flex-col p-0 gap-0">
        {/* ── Title row ─────────────────────────────────────────────────── */}
        <div className="flex items-start gap-2.5 px-5 pt-5 pb-2 pr-12 shrink-0">
          {/* Done toggle */}
          <button
            onClick={toggleDone}
            disabled={!caps.editContent}
            className="shrink-0 mt-0 transition-colors disabled:cursor-default"
            title={draft.isDone ? 'Mark incomplete' : 'Mark done'}
          >
            {draft.isDone ? (
              <CheckCircle2 size={18} className="text-green-400" />
            ) : (
              <Circle size={18} className="text-muted-foreground/40 hover:text-green-400" />
            )}
          </button>

          <textarea
            ref={titleRef}
            value={draft.title}
            onChange={(e) => patchDraft({ title: e.target.value })}
            readOnly={!caps.editContent}
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
                onChange={(e) => patchDraft({ description: e.target.value || undefined })}
                readOnly={!caps.editContent}
                rows={6}
                placeholder="Add a description..."
                className="w-full bg-muted/25 border border-border/30 rounded-md text-sm text-foreground p-2.5 resize-none focus:outline-none focus:ring-1 focus:ring-primary/40 placeholder:text-muted-foreground/40"
              />
            </section>

            <CardDialogTagsAttachments
              caps={caps}
              draft={draft}
              tagInput={tagInput}
              suggestedTags={suggestedTags}
              showTagSuggestions={showTagSuggestions}
              attachmentPaths={attachmentPaths}
              vaultFiles={vaultFiles}
              notePickerOpen={notePickerOpen}
              setTagInput={setTagInput}
              setTagInputFocused={setTagInputFocused}
              setNotePickerOpen={setNotePickerOpen}
              addTag={addTag}
              removeTag={removeTag}
              patchDraft={patchDraft}
              addAttachment={addAttachment}
              removeAttachment={removeAttachment}
              openAttachment={openAttachment}
            />

            <CardDialogChecklistComments
              caps={caps}
              draft={draft}
              board={board}
              checklistInput={checklistInput}
              commentInput={commentInput}
              cardPickerOpen={cardPickerOpen}
              checklistDone={checklistDone}
              checklistTotal={checklistTotal}
              myUserId={myUserId}
              myUserName={myUserName}
              myUserColor={myUserColor}
              setChecklistInput={setChecklistInput}
              setCommentInput={setCommentInput}
              setCardPickerOpen={setCardPickerOpen}
              addChecklistItem={addChecklistItem}
              addChecklistItemFromCard={addChecklistItemFromCard}
              toggleChecklistItem={toggleChecklistItem}
              updateChecklistText={updateChecklistText}
              removeChecklistItem={removeChecklistItem}
              resolveCardTitle={resolveCardTitle}
              addComment={addComment}
              deleteComment={deleteComment}
            />
          </div>

          <CardDialogSidebar
            caps={caps}
            draft={draft}
            priorities={PRIORITIES}
            dateFormat={dateFormat}
            knownUsers={knownUsers}
            board={board}
            currentColumnId={currentColumnId}
            confirmDelete={confirmDelete}
            startDateOpen={startDateOpen}
            dueDateOpen={dueDateOpen}
            setStartDateOpen={setStartDateOpen}
            setDueDateOpen={setDueDateOpen}
            setConfirmDelete={setConfirmDelete}
            togglePriority={togglePriority}
            patchDraft={patchDraft}
            toggleAssignee={toggleAssignee}
            moveToColumn={moveToColumn}
            toggleArchive={toggleArchive}
            deleteCard={deleteCard}
          />
        </div>
      </DialogContent>

      <CardDialogMoveTagsPrompt
        draftTitle={draft.title}
        prompt={moveTagsPrompt}
        onClose={() => setMoveTagsPrompt(null)}
        onApplyOnce={() => applyPromptTags(false)}
        onAlwaysApply={() => applyPromptTags(true)}
      />
    </Dialog>
  );
}
