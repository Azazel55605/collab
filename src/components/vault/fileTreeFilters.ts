import type { NoteFile } from '../../types/vault';

export type FileTypeFilter =
  'note' | 'canvas' | 'kanban' | 'sheet' | 'ink' | 'logic' | 'image' | 'pdf' | 'other';

export const FILE_TYPE_FILTERS: Array<{ id: FileTypeFilter; label: string }> = [
  { id: 'note', label: 'Notes' },
  { id: 'canvas', label: 'Canvases' },
  { id: 'kanban', label: 'Kanban boards' },
  { id: 'sheet', label: 'Spreadsheets' },
  { id: 'ink', label: 'Drawings' },
  { id: 'logic', label: 'Logic diagrams' },
  { id: 'image', label: 'Images' },
  { id: 'pdf', label: 'PDFs' },
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
  if (extension === 'logic') return 'logic';
  if (IMAGE_FILE_EXTENSIONS.has(extension)) return 'image';
  if (extension === 'pdf') return 'pdf';
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
