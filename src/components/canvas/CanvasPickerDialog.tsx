import { FileImage, FileText, Layout, LayoutDashboard } from 'lucide-react';

import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '../ui/command';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '../ui/dialog';
import type { NoteFile } from '../../types/vault';

const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico', 'avif']);

export type CanvasPickerMode = 'note' | 'file' | null;

function getNameWithoutExtension(name: string): string {
  return name.replace(/\.[^.]+$/, '');
}

function getFileIcon(file: Pick<NoteFile, 'extension'>) {
  const extension = file.extension.toLowerCase();
  if (IMAGE_EXTENSIONS.has(extension)) return <FileImage size={14} className="shrink-0 text-sky-400/80" />;
  if (extension === 'canvas') return <Layout size={14} className="shrink-0 text-blue-400/70" />;
  if (extension === 'kanban') return <LayoutDashboard size={14} className="shrink-0 text-emerald-400/70" />;
  return <FileText size={14} className="shrink-0 text-muted-foreground/70" />;
}

export function CanvasPickerDialog({
  open,
  mode,
  files,
  onOpenChange,
  onSelect,
}: {
  open: boolean;
  mode: CanvasPickerMode;
  files: NoteFile[];
  onOpenChange: (open: boolean) => void;
  onSelect: (file: NoteFile) => void;
}) {
  const title = mode === 'note' ? 'Add note to canvas' : 'Add file to canvas';

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg overflow-hidden p-0">
        <DialogHeader className="border-b border-border/50 px-4 py-3">
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription className="sr-only">
            Search vault items and choose one to add to the canvas.
          </DialogDescription>
        </DialogHeader>
        <Command className="rounded-none border-none bg-transparent">
          <CommandInput placeholder={mode === 'note' ? 'Search notes…' : 'Search files…'} />
          <CommandList className="max-h-[420px]">
            <CommandEmpty>No matching items.</CommandEmpty>
            <CommandGroup>
              {files.map((file) => (
                <CommandItem
                  key={file.relativePath}
                  value={`${file.name} ${file.relativePath}`}
                  onSelect={() => onSelect(file)}
                  className="gap-3 py-2"
                >
                  {getFileIcon(file)}
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm">{getNameWithoutExtension(file.name)}</div>
                    <div className="truncate text-[11px] text-muted-foreground">{file.relativePath}</div>
                  </div>
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </DialogContent>
    </Dialog>
  );
}
