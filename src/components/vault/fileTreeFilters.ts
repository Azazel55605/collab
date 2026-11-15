import { CAPTION_EXTENSIONS, mediaKind } from '../../lib/mediaFiles';
import { SQLITE_EXTENSIONS } from '../../lib/sqliteFiles';
import type { NoteFile } from '../../types/vault';

export type FileTypeFilter =
  | 'note'
  | 'canvas'
  | 'kanban'
  | 'sheet'
  | 'ink'
  | 'deck'
  | 'logic'
  | 'image'
  | 'pdf'
  | 'audio'
  | 'video'
  | 'captions'
  | 'sqlite'
  | 'other';

export const FILE_TYPE_FILTERS: Array<{ id: FileTypeFilter; label: string }> = [
  { id: 'note', label: 'Notes' },
  { id: 'canvas', label: 'Canvases' },
  { id: 'kanban', label: 'Kanban boards' },
  { id: 'sheet', label: 'Spreadsheets' },
  { id: 'ink', label: 'Drawings' },
  { id: 'deck', label: 'Presentations' },
  { id: 'logic', label: 'Logic diagrams' },
  { id: 'image', label: 'Images' },
  { id: 'pdf', label: 'PDFs' },
  { id: 'video', label: 'Videos' },
  { id: 'audio', label: 'Audio' },
  { id: 'captions', label: 'Captions' },
  { id: 'sqlite', label: 'SQLite databases' },
  { id: 'other', label: 'Other files' },
];

const NOTE_FILE_EXTENSIONS = new Set(['md', 'markdown', 'txt']);
const IMAGE_FILE_EXTENSIONS = new Set([
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

export function getFileTypeFilter(node: Pick<NoteFile, 'extension'>): FileTypeFilter {
  const extension = node.extension.toLowerCase();
  if (NOTE_FILE_EXTENSIONS.has(extension)) return 'note';
  if (extension === 'canvas') return 'canvas';
  if (extension === 'kanban') return 'kanban';
  if (extension === 'sheet') return 'sheet';
  if (extension === 'ink') return 'ink';
  if (extension === 'deck') return 'deck';
  if (extension === 'logic') return 'logic';
  if (IMAGE_FILE_EXTENSIONS.has(extension)) return 'image';
  if (extension === 'pdf') return 'pdf';
  const media = mediaKind(extension);
  if (media) return media;
  if (CAPTION_EXTENSIONS.includes(extension)) return 'captions';
  if (SQLITE_EXTENSIONS.includes(extension)) return 'sqlite';
  return 'other';
}

export function filterFileTreeByType(
  nodes: NoteFile[],
  filters: ReadonlySet<FileTypeFilter>,
): NoteFile[] {
  if (filters.size === 0) return nodes;

  const filtered: NoteFile[] = [];
  for (const node of nodes) {
    if (node.isFolder) {
      const children = filterFileTreeByType(node.children ?? [], filters);
      if (children.length > 0) filtered.push({ ...node, children });
      continue;
    }
    if (filters.has(getFileTypeFilter(node))) filtered.push(node);
  }
  return filtered;
}

/**
 * Keeps files whose name contains `query` (case-insensitive) and the folders
 * leading to them. A folder whose own name matches keeps all of its contents.
 */
export function filterFileTreeByName(nodes: NoteFile[], query: string): NoteFile[] {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return nodes;
  const filtered: NoteFile[] = [];
  for (const node of nodes) {
    const matches = node.name.toLocaleLowerCase().includes(needle);
    if (node.isFolder) {
      if (matches) {
        filtered.push(node);
        continue;
      }
      const children = filterFileTreeByName(node.children ?? [], needle);
      if (children.length > 0) filtered.push({ ...node, children });
      continue;
    }
    if (matches) filtered.push(node);
  }
  return filtered;
}
