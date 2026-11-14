import {
  useEffect,
  useState,
} from 'react';

import {
  CircuitBoard,
  FilePlus,
  FolderPlus,
  Layout,
  LayoutDashboard,
  Pencil,
  PenLine,
  Presentation,
  Table2,
  Trash2,
  Undo2,
} from 'lucide-react';

import type { PathChangePreview, TrashEntry } from '../../types/vault';
import { ChoiceCard, ChoiceGroup } from '../ui/app-dialog';
import { Button } from '../ui/button';
import { Checkbox } from '../ui/checkbox';
import { ConfirmDialog } from '../ui/confirm-dialog';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../ui/dialog';
import { Input } from '../ui/input';
import {
  FormDialog,
  FormField,
  PromptDialog,
} from '../ui/form-dialog';

// ─── Confirm delete ───────────────────────────────────────────────────────────

interface ConfirmDeleteProps {
  open: boolean;
  name: string;
  isFolder: boolean;
  itemCount?: number;
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
  itemCount = 1,
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
  const isMultiple = itemCount > 1;
  const [mode, setMode] = useState<'trash' | 'delete'>('trash');
  useEffect(() => {
    if (open) setMode('trash');
  }, [open]);
  const what = isMultiple ? `${itemCount} items` : `“${name}”`;
  const kind = isFolder ? 'folder' : 'file';
  const permanent = !hasTrashFlow || mode === 'delete';
  return (
    <ConfirmDialog
      open={open}
      onOpenChange={(next) => !next && onCancel()}
      destructive={permanent}
      tone={permanent ? 'danger' : 'warning'}
      icon={<Trash2 />}
      title={isMultiple ? `Delete ${itemCount} items?` : `Delete ${isFolder ? 'folder' : 'note'}?`}
      description={
        hasTrashFlow
          ? `${what} can go to the vault trash, where ${isMultiple ? 'they stay' : 'it stays'} restorable, or be deleted for good.`
          : `${what} will be permanently deleted.${!isMultiple && isFolder ? ' Everything inside it is deleted too.' : ''} This cannot be undone.`
      }
      confirmLabel={hasTrashFlow && mode === 'trash' ? 'Move to Trash' : primaryActionLabel}
      onConfirm={() => {
        if (hasTrashFlow && mode === 'trash') onMoveToTrash?.();
        else (onDeletePermanently ?? onConfirm)();
      }}
    >
      {hasTrashFlow || (showReferenceOption && onRemoveReferencesChange) ? (
        <>
          {hasTrashFlow && (
            <ChoiceGroup
              value={mode}
              onValueChange={(value) => setMode(value as 'trash' | 'delete')}
              aria-label="How to delete"
            >
              <ChoiceCard
                value="trash"
                title="Move to trash"
                description={`Restore ${isMultiple ? 'them' : 'it'} any time until the trash is emptied${!isMultiple && isFolder ? '; the contents go too' : ''}`}
              />
              <ChoiceCard
                value="delete"
                title="Delete permanently"
                description={`Gone for good${!isMultiple && isFolder ? ', with everything inside' : ''}; cannot be undone`}
              />
            </ChoiceGroup>
          )}
          {showReferenceOption && onRemoveReferencesChange && (
            <label className="flex items-start gap-2.5 rounded-[10px] border border-border px-3 py-2.5">
              <Checkbox
                checked={removeReferences}
                onCheckedChange={(checked) => onRemoveReferencesChange(checked === true)}
                className="mt-0.5"
              />
              <span className="space-y-0.5">
                <span className="block text-[13px] font-medium">
                  Also remove links to this {kind}
                </span>
                <span className="block text-xs text-muted-foreground">
                  Notes, boards and canvases that link here are updated. Restoring from the trash
                  does not bring those links back.
                </span>
              </span>
            </label>
          )}
        </>
      ) : undefined}
    </ConfirmDialog>
  );
}

// ─── Input (create / rename) ──────────────────────────────────────────────────

type InputDialogVariant =
  | 'create-note'
  | 'create-folder'
  | 'rename'
  | 'create-canvas'
  | 'create-kanban'
  | 'create-logic'
  | 'create-sheet'
  | 'create-ink'
  | 'create-deck'
  | 'create-template';

const VARIANT_META: Record<
  InputDialogVariant,
  {
    icon: React.ReactNode;
    title: string;
    label: string;
    placeholder: string;
    confirm: string;
  }
> = {
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
  rename: {
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
  'create-logic': {
    icon: <CircuitBoard size={16} />,
    title: 'New logic diagram',
    label: 'Diagram name',
    placeholder: 'Logic Diagram',
    confirm: 'Create',
  },
  'create-sheet': {
    icon: <Table2 size={16} />,
    title: 'New spreadsheet',
    label: 'Spreadsheet name',
    placeholder: 'Untitled Spreadsheet',
    confirm: 'Create',
  },
  'create-ink': {
    icon: <PenLine size={16} />,
    title: 'New drawing',
    label: 'Drawing name',
    placeholder: 'Untitled Drawing',
    confirm: 'Create',
  },
  'create-deck': {
    icon: <Presentation size={16} />,
    title: 'New presentation',
    label: 'Presentation name',
    placeholder: 'Untitled Presentation',
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

export function InputDialog({
  open,
  variant,
  initialValue = '',
  onConfirm,
  onCancel,
}: InputDialogProps) {
  const meta = VARIANT_META[variant];
  return (
    <PromptDialog
      open={open}
      onOpenChange={(next) => !next && onCancel()}
      icon={meta.icon}
      title={meta.title}
      label={meta.label}
      placeholder={meta.placeholder}
      initialValue={initialValue}
      selectBaseName={variant === 'rename'}
      submitLabel={meta.confirm}
      onSubmit={onConfirm}
    />
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
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onCancel();
      }}
    >
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
                <span className="rounded-full border border-border/60 px-2 py-0.5">
                  {preview.operation}
                </span>
                <span className="rounded-full border border-border/60 px-2 py-0.5">
                  {preview.itemKind}
                </span>
                <span className="rounded-full border border-border/60 px-2 py-0.5">
                  {preview.itemKind === 'folder'
                    ? `${preview.nestedItemCount} nested items`
                    : 'single file'}
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
                <div className="text-xs font-medium text-muted-foreground">
                  Open tabs to retarget
                </div>
                <div className="mt-1 text-lg font-semibold text-foreground">
                  {affectedOpenTabs.length}
                </div>
              </div>
              <div className="rounded-lg border border-border/60 px-3 py-2.5">
                <div className="text-xs font-medium text-muted-foreground">
                  References to rewrite
                </div>
                <div className="mt-1 text-lg font-semibold text-foreground">
                  {affectedReferencePaths.length}
                </div>
              </div>
            </div>

            {affectedReferencePaths.length > 0 && (
              <div className="rounded-lg border border-border/60 px-3 py-2.5">
                <div className="text-xs font-medium text-muted-foreground mb-2">
                  Affected documents
                </div>
                <div className="max-h-40 overflow-y-auto space-y-1 text-xs">
                  {affectedReferencePaths.slice(0, 12).map((path) => (
                    <div key={path} className="truncate text-foreground/85">
                      {path}
                    </div>
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
          <Button variant="outline" onClick={onCancel}>
            Cancel
          </Button>
          <Button onClick={onConfirm} disabled={!preview || !!blocked}>
            Apply
          </Button>
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
    <FormDialog
      open={open}
      onOpenChange={(next) => !next && onCancel()}
      size="s"
      icon={<Undo2 />}
      title="Restore item"
      description={
        entry?.restoreConflict
          ? 'Something else is at the original place now. Choose where to restore it.'
          : 'It goes back to where it was, or to another path you choose.'
      }
      submitLabel="Restore"
      submitDisabled={!targetPath.trim()}
      onSubmit={onConfirm}
    >
      <FormField label="Original path">
        <p className="rounded-lg border border-border/60 bg-muted/30 px-3 py-2 font-mono text-xs break-all">
          {entry?.originalRelativePath}
        </p>
      </FormField>
      <FormField label="Restore to" htmlFor="restore-target">
        <Input
          id="restore-target"
          autoFocus
          value={targetPath}
          onChange={(event) => onTargetPathChange(event.target.value)}
          className="h-9 font-mono text-[13px]"
        />
      </FormField>
    </FormDialog>
  );
}
