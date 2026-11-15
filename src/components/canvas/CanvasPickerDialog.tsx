import { useEffect, useState } from 'react';

import { FileImage, FileText, Layout, LayoutDashboard } from 'lucide-react';

import type { NoteFile } from '../../types/vault';
import { PickerDialog, PickerRow } from '../ui/picker-dialog';

const IMAGE_EXTENSIONS = new Set([
  'png',
  'jpg',
  'jpeg',
  'gif',
  'webp',
  'svg',
  'bmp',
  'ico',
  'avif',
]);

export type CanvasPickerMode = 'note' | 'file' | 'linked-path' | null;

function getNameWithoutExtension(name: string): string {
  return name.replace(/\.[^.]+$/, '');
}

function getFileIcon(file: Pick<NoteFile, 'extension'>) {
  const extension = file.extension.toLowerCase();
  if (IMAGE_EXTENSIONS.has(extension))
    return <FileImage size={14} className="shrink-0 text-sky-400/80" />;
  if (extension === 'canvas') return <Layout size={14} className="shrink-0 text-blue-400/70" />;
  if (extension === 'kanban')
    return <LayoutDashboard size={14} className="shrink-0 text-emerald-400/70" />;
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
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  useEffect(() => {
    if (open) setQuery('');
  }, [open]);
  const title =
    mode === 'note'
      ? 'Add note to canvas'
      : mode === 'linked-path'
        ? 'Select linked vault file'
        : 'Add file to canvas';
  const needle = query.trim().toLowerCase();
  const shown = needle
    ? files.filter((file) => `${file.name} ${file.relativePath}`.toLowerCase().includes(needle))
    : files;
  const folderOf = (path: string) =>
    path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : 'Vault root';
  return (
    <PickerDialog
      open={open}
      onOpenChange={onOpenChange}
      size="m"
      icon={mode === 'note' ? <FileText /> : <Layout />}
      title={title}
      description="Search the vault and choose one."
      query={query}
      onQueryChange={setQuery}
      searchPlaceholder={mode === 'note' ? 'Search notes' : 'Search files'}
      groups={[{ items: shown }]}
      getKey={(file) => file.relativePath}
      selectedKey={selected}
      onSelect={setSelected}
      renderItem={(file) => (
        <PickerRow
          icon={getFileIcon(file)}
          title={getNameWithoutExtension(file.name)}
          detail={folderOf(file.relativePath)}
        />
      )}
      onPick={onSelect}
      pickLabel={(file) =>
        file
          ? `${mode === 'linked-path' ? 'Link' : 'Add'} ${getNameWithoutExtension(file.name)}`
          : mode === 'linked-path'
            ? 'Link'
            : 'Add'
      }
      emptyText="No matching items."
      className="h-[min(560px,calc(100vh-2rem))]"
    />
  );
}
