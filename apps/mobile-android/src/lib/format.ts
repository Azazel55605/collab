import type { MemberRole, HostedFileEntry } from '../mobileTauri';

export function formatBytes(bytes: number | null | undefined): string {
  if (bytes == null || bytes <= 0) return '—';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const rounded = value >= 10 || unit === 0 ? Math.round(value) : parseFloat(value.toFixed(1));
  return `${rounded} ${units[unit]}`;
}

export function formatRelativeTime(iso: string | null | undefined): string {
  if (!iso) return '';
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return '';
  const diff = Date.now() - then;
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;
  if (diff < minute) return 'just now';
  if (diff < hour) return `${Math.round(diff / minute)}m ago`;
  if (diff < day) return `${Math.round(diff / hour)}h ago`;
  if (diff < 30 * day) return `${Math.round(diff / day)}d ago`;
  return new Date(then).toLocaleDateString();
}

export const ROLE_LABEL: Record<MemberRole, string> = {
  admin: 'Admin',
  editor: 'Editor',
  viewer: 'Viewer',
};

export function isReadOnlyRole(role: MemberRole): boolean {
  return role === 'viewer';
}

export function fileExtension(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
}

export function fileEntryExtension(entry: HostedFileEntry): string {
  return fileExtension(entry.relativePath) || fileExtension(entry.name);
}

export type FileGlyph =
  | 'folder'
  | 'note'
  | 'kanban'
  | 'canvas'
  | 'logic'
  | 'sheet'
  | 'image'
  | 'pdf'
  | 'file';

export function fileGlyph(entry: HostedFileEntry): FileGlyph {
  if (entry.kind === 'folder') return 'folder';
  const ext = fileEntryExtension(entry);
  if (ext === 'md' || ext === 'markdown') return 'note';
  if (ext === 'kanban') return 'kanban';
  if (ext === 'canvas') return 'canvas';
  if (ext === 'logic') return 'logic';
  if (ext === 'sheet') return 'sheet';
  if (ext === 'pdf') return 'pdf';
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'apng', 'avif', 'ico'].includes(ext)) {
    return 'image';
  }
  return 'file';
}

/** Children of a folder (or the vault root when `parentId` is null), sorted
 * folders-first then alphabetically. */
export function childrenOf(files: HostedFileEntry[], parentId: string | null): HostedFileEntry[] {
  return childrenIndex(files).get(parentId) ?? [];
}

/** Builds the folder children lookup once per manifest. Folder navigation can
 * then read the current folder directly instead of filtering and sorting the
 * whole vault every time the user opens a folder. */
export function childrenIndex(files: HostedFileEntry[]): Map<string | null, HostedFileEntry[]> {
  const index = new Map<string | null, HostedFileEntry[]>();
  for (const file of files) {
    const bucket = index.get(file.parentId);
    if (bucket) {
      bucket.push(file);
    } else {
      index.set(file.parentId, [file]);
    }
  }
  const collator = new Intl.Collator(undefined, { sensitivity: 'base' });
  for (const children of index.values()) {
    children.sort((a, b) => {
      if (a.kind === 'folder' && b.kind !== 'folder') return -1;
      if (a.kind !== 'folder' && b.kind === 'folder') return 1;
      return collator.compare(a.name, b.name);
    });
  }
  return index;
}
