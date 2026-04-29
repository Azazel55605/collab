import { useEffect, useRef, useState } from 'react';
import { Trash2, FilePlus, FolderPlus, Pencil, Layout, LayoutDashboard } from 'lucide-react';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle,
  DialogDescription, DialogFooter,
} from '../ui/dialog';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { Checkbox } from '../ui/checkbox';
import type { PathChangePreview, TrashEntry } from '../../types/vault';

// ─── Confirm delete ───────────────────────────────────────────────────────────

interface ConfirmDeleteProps {
  open: boolean;
  name: string;
  isFolder: boolean;
  primaryActionLabel?: string;
  showReferenceOption?: boolean;
  removeReferences?: boolean;
  onRemoveReferencesChange?: (value: boolean) => void;
  onMoveToTrash?: () => void;
  onDeletePermanently?: () => void;
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmDeleteDialog({
  open,
  name,
  isFolder,
  primaryActionLabel = 'Delete',
  showReferenceOption = false,
  removeReferences = false,
  onRemoveReferencesChange,
  onMoveToTrash,
  onDeletePermanently,
  onConfirm,
  onCancel,
}: ConfirmDeleteProps) {
  const hasTrashFlow = !!onMoveToTrash;
  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onCancel(); }}>
      <DialogContent showCloseButton={false} className="max-w-sm">
        <DialogHeader>
          <div className="flex items-center gap-3 mb-1">
            <span className="flex items-center justify-center w-9 h-9 rounded-full bg-destructive/15 text-destructive shrink-0">
              <Trash2 size={16} />
            </span>
            <DialogTitle>Delete {isFolder ? 'folder' : 'note'}?</DialogTitle>
          </div>
          <DialogDescription>
            <span className="font-medium text-foreground">"{name}"</span>
            {hasTrashFlow ? (
              <>
                {' '}will be moved to the vault trash.
                {isFolder && ' Everything inside it will move to trash too.'}
                {' '}You can restore it later until it is permanently purged.
              </>
            ) : (
              <>
                {' '}will be permanently deleted.
                {isFolder && ' All notes inside will also be deleted.'}
                {' '}This cannot be undone.
              </>
            )}
          </DialogDescription>
        </DialogHeader>
        {showReferenceOption && onRemoveReferencesChange && (
          <label className="flex items-start gap-3 rounded-lg border border-border/50 bg-muted/20 px-3 py-2.5">
            <Checkbox
              checked={removeReferences}
              onCheckedChange={(checked) => onRemoveReferencesChange(checked === true)}
              className="mt-0.5"
            />
            <div className="space-y-1">
              <div className="text-sm font-medium text-foreground">Also remove file references</div>
              <div className="text-xs text-muted-foreground">
                Update notes, boards, and canvases that link to this {isFolder ? 'folder' : 'file'} by removing the affected references as part of this delete action. If you move it to trash, those references will not be restored automatically.
              </div>
            </div>
          </label>
        )}
        <DialogFooter className="border-none bg-transparent -mx-0 -mb-0 px-0 pb-0">
          <Button variant="outline" onClick={onCancel}>Cancel</Button>
          {onMoveToTrash ? (
            <>
              <Button variant="outline" onClick={onMoveToTrash} autoFocus>Move to Trash</Button>
              <Button variant="destructive" onClick={onDeletePermanently ?? onConfirm}>{primaryActionLabel}</Button>
            </>
          ) : (
            <Button variant="destructive" onClick={onConfirm} autoFocus>{primaryActionLabel}</Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── Input (create / rename) ──────────────────────────────────────────────────

type InputDialogVariant = 'create-note' | 'create-folder' | 'rename' | 'create-canvas' | 'create-kanban' | 'create-template';

const VARIANT_META: Record<InputDialogVariant, {
  icon: React.ReactNode;
  title: string;
  label: string;
  placeholder: string;
  confirm: string;
}> = {
  'create-note': {
    icon: <FilePlus size={16} />,
    title: 'New note',
    label: 'Note name',
    placeholder: 'Untitled',
    confirm: 'Create',
  },
  'create-folder': {
    icon: <FolderPlus size={16} />,
    title: 'New folder',
    label: 'Folder name',
    placeholder: 'Folder',
    confirm: 'Create',
  },
  'rename': {
    icon: <Pencil size={16} />,
    title: 'Rename',
    label: 'New name',
    placeholder: '',
    confirm: 'Rename',
  },
  'create-canvas': {
    icon: <Layout size={16} />,
    title: 'New canvas board',
    label: 'Board name',
    placeholder: 'Untitled Canvas',
    confirm: 'Create',
  },
  'create-kanban': {
    icon: <LayoutDashboard size={16} />,
    title: 'New kanban board',
    label: 'Board name',
    placeholder: 'Untitled Board',
    confirm: 'Create',
  },
  'create-template': {
    icon: <LayoutDashboard size={16} />,
    title: 'Save as template',
    label: 'Template name',
    placeholder: 'Sprint Board',
    confirm: 'Save',
  },
};

interface InputDialogProps {
  open: boolean;
  variant: InputDialogVariant;
  initialValue?: string;
  onConfirm: (value: string) => void;
  onCancel: () => void;
}

export function InputDialog({ open, variant, initialValue = '', onConfirm, onCancel }: InputDialogProps) {
  const [value, setValue] = useState(initialValue);
  const inputRef = useRef<HTMLInputElement>(null);
  const meta = VARIANT_META[variant];

  // Reset + focus when opened
  useEffect(() => {
    if (open) {
      setValue(initialValue);
      // Select the name part (without extension) for rename
      setTimeout(() => {
        const el = inputRef.current;
        if (!el) return;
        el.focus();
        const dotIndex = initialValue.lastIndexOf('.');
        el.setSelectionRange(0, dotIndex > 0 ? dotIndex : initialValue.length);
      }, 50);
    }
  }, [open, initialValue]);

  const submit = () => {
    const trimmed = value.trim();
    if (!trimmed) return;
    onConfirm(trimmed);
  };

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onCancel(); }}>
      <DialogContent showCloseButton={false} className="max-w-sm">
        <DialogHeader>
          <div className="flex items-center gap-3 mb-1">
            <span className="flex items-center justify-center w-9 h-9 rounded-full bg-primary/15 text-primary shrink-0">
              {meta.icon}
            </span>
            <DialogTitle>{meta.title}</DialogTitle>
          </div>
        </DialogHeader>

        <div className="flex flex-col gap-1.5">
          <label className="text-xs font-medium text-muted-foreground">{meta.label}</label>
          <Input
            ref={inputRef}
            value={value}
            placeholder={meta.placeholder}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') submit();
              if (e.key === 'Escape') onCancel();
            }}
          />
        </div>

        <DialogFooter className="border-none bg-transparent -mx-0 -mb-0 px-0 pb-0">
          <Button variant="outline" onClick={onCancel}>Cancel</Button>
          <Button onClick={submit} disabled={!value.trim()}>{meta.confirm}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

interface RenameMovePreviewDialogProps {
  open: boolean;
  preview: PathChangePreview | null;
  affectedOpenTabs: string[];
  onConfirm: () => void;
  onCancel: () => void;
}

export function RenameMovePreviewDialog({
  open,
  preview,
  affectedOpenTabs,
  onConfirm,
  onCancel,
}: RenameMovePreviewDialogProps) {
  const affectedReferencePaths = preview?.affectedReferencePaths ?? [];
  const blocked = preview?.blockedReason;

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) onCancel(); }}>
      <DialogContent showCloseButton={false} className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Review rename / move</DialogTitle>
          <DialogDescription>
            Confirm the path change before the app rewrites references and retargets open tabs.
          </DialogDescription>
        </DialogHeader>

        {preview && (
          <div className="space-y-4 text-sm">
            <div className="rounded-lg border border-border/60 bg-muted/20 px-3 py-2.5">
              <div className="font-medium text-foreground">{preview.oldRelativePath}</div>
              <div className="text-xs text-muted-foreground mt-1">→ {preview.newRelativePath}</div>
              <div className="mt-2 flex flex-wrap gap-2 text-[11px] text-muted-foreground">
                <span className="rounded-full border border-border/60 px-2 py-0.5">{preview.operation}</span>
                <span className="rounded-full border border-border/60 px-2 py-0.5">{preview.itemKind}</span>
                <span className="rounded-full border border-border/60 px-2 py-0.5">
                  {preview.itemKind === 'folder' ? `${preview.nestedItemCount} nested items` : 'single file'}
                </span>
              </div>
            </div>

            {blocked ? (
              <div className="rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                {blocked}
              </div>
            ) : null}

            <div className="grid gap-3 sm:grid-cols-2">
              <div className="rounded-lg border border-border/60 px-3 py-2.5">
                <div className="text-xs font-medium text-muted-foreground">Open tabs to retarget</div>
                <div className="mt-1 text-lg font-semibold text-foreground">{affectedOpenTabs.length}</div>
              </div>
              <div className="rounded-lg border border-border/60 px-3 py-2.5">
                <div className="text-xs font-medium text-muted-foreground">References to rewrite</div>
                <div className="mt-1 text-lg font-semibold text-foreground">{affectedReferencePaths.length}</div>
              </div>
            </div>

            {affectedReferencePaths.length > 0 && (
              <div className="rounded-lg border border-border/60 px-3 py-2.5">
                <div className="text-xs font-medium text-muted-foreground mb-2">Affected documents</div>
                <div className="max-h-40 overflow-y-auto space-y-1 text-xs">
                  {affectedReferencePaths.slice(0, 12).map((path) => (
                    <div key={path} className="truncate text-foreground/85">{path}</div>
                  ))}
                  {affectedReferencePaths.length > 12 && (
                    <div className="text-muted-foreground">
                      +{affectedReferencePaths.length - 12} more
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>
        )}

        <DialogFooter className="border-none bg-transparent -mx-0 -mb-0 px-0 pb-0">
          <Button variant="outline" onClick={onCancel}>Cancel</Button>
          <Button onClick={onConfirm} disabled={!preview || !!blocked}>Apply</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

interface RestoreTrashDialogProps {
  open: boolean;
  entry: TrashEntry | null;
  targetPath: string;
  onTargetPathChange: (value: string) => void;
  onConfirm: () => void;
  onCancel: () => void;
}

export function RestoreTrashDialog({
  open,
  entry,
  targetPath,
  onTargetPathChange,
  onConfirm,
  onCancel,
}: RestoreTrashDialogProps) {
  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) onCancel(); }}>
      <DialogContent showCloseButton={false} className="max-w-md">
        <DialogHeader>
          <DialogTitle>Restore item</DialogTitle>
          <DialogDescription>
            {entry?.restoreConflict
              ? 'The original path is occupied. Choose a restore path for this item.'
              : 'Restore this item to its original location or adjust the path first.'}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="rounded-lg border border-border/60 bg-muted/20 px-3 py-2">
            <div className="text-xs font-medium text-muted-foreground">Original path</div>
            <div className="mt-1 text-sm text-foreground break-all">{entry?.originalRelativePath}</div>
          </div>
          <label className="flex flex-col gap-1.5">
            <span className="text-xs font-medium text-muted-foreground">Restore to</span>
            <Input value={targetPath} onChange={(event) => onTargetPathChange(event.target.value)} />
          </label>
        </div>
        <DialogFooter className="border-none bg-transparent -mx-0 -mb-0 px-0 pb-0">
          <Button variant="outline" onClick={onCancel}>Cancel</Button>
          <Button onClick={onConfirm} disabled={!targetPath.trim()}>Restore</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
