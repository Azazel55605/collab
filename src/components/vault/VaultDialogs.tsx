import { useEffect, useRef, useState } from 'react';
import { Trash2, FilePlus, FolderPlus, Pencil, Layout, LayoutDashboard } from 'lucide-react';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle,
  DialogDescription, DialogFooter,
} from '../ui/dialog';
import { Button } from '../ui/button';
import { Input } from '../ui/input';

// ─── Confirm delete ───────────────────────────────────────────────────────────

interface ConfirmDeleteProps {
  open: boolean;
  name: string;
  isFolder: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmDeleteDialog({ open, name, isFolder, onConfirm, onCancel }: ConfirmDeleteProps) {
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
            {' '}will be permanently deleted.
            {isFolder && ' All notes inside will also be deleted.'}
            {' '}This cannot be undone.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter className="border-none bg-transparent -mx-0 -mb-0 px-0 pb-0">
          <Button variant="outline" onClick={onCancel}>Cancel</Button>
          <Button variant="destructive" onClick={onConfirm} autoFocus>Delete</Button>
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
