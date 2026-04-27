import type { ActiveView } from '../../store/uiStore';
import type { NoteFile } from '../../types/vault';

export type Mode =
  | { type: 'search'; query: string }
  | { type: 'math'; expr: string }
  | { type: 'action'; query: string }
  | { type: 'tag'; tag: string }
  | { type: 'fileType'; ext: string }
  | { type: 'nameSearch'; query: string }
  | { type: 'insert'; query: string };

export function detectMode(raw: string): Mode {
  const s = raw.trimStart();

  if (s.startsWith('=')) return { type: 'math', expr: s.slice(1).trim() };
  if (s.startsWith('>')) return { type: 'action', query: s.slice(1).trim() };

  const tagColon = s.match(/^tag:(.*)$/i);
  if (tagColon) return { type: 'tag', tag: tagColon[1].trim() };
  if (s.startsWith('#')) return { type: 'tag', tag: s.slice(1) };

  const shortTypeMatch = s.match(/^:(md|kanban|canvas)/i);
  if (shortTypeMatch) return { type: 'fileType', ext: shortTypeMatch[1].toLowerCase() };
  const typeMatch = s.match(/^type:(md|kanban|canvas)/i);
  if (typeMatch) return { type: 'fileType', ext: typeMatch[1].toLowerCase() };

  const nameMatch = s.match(/^name:(.*)$/i);
  if (nameMatch) return { type: 'nameSearch', query: nameMatch[1].trim() };

  if (s.startsWith('/')) return { type: 'insert', query: s.slice(1).trim() };
  const insertMatch = s.match(/^insert:(.*)$/i);
  if (insertMatch) return { type: 'insert', query: insertMatch[1].trim() };

  if (/^(table\b|code\b|link\b|mdlink\b|url\b|image\b|img\b|date\b|math\b|equation\b|icon\b|icons\b|glyph\b|symbol\b|heading\b|h[1-6]\b|hr$|quote\b|blockquote\b|checklist\b|todo\b)/i.test(s)) {
    return { type: 'insert', query: s };
  }

  return { type: 'search', query: s };
}

export function getTabType(relativePath: string): 'note' | 'canvas' | 'kanban' | 'image' | 'pdf' {
  if (/\.(png|jpg|jpeg|gif|webp|svg|bmp|ico|avif)$/i.test(relativePath)) return 'image';
  if (/\.pdf$/i.test(relativePath)) return 'pdf';
  if (relativePath.endsWith('.kanban')) return 'kanban';
  if (relativePath.endsWith('.canvas')) return 'canvas';
  return 'note';
}

export function getViewForType(type: 'note' | 'canvas' | 'kanban' | 'image' | 'pdf'): ActiveView {
  if (type === 'kanban') return 'kanban';
  if (type === 'canvas') return 'canvas';
  return 'editor';
}

export function flattenFiles(nodes: NoteFile[]): NoteFile[] {
  const flat: NoteFile[] = [];

  const visit = (items: NoteFile[]) => {
    for (const item of items) {
      if (item.isFolder) {
        if (item.children?.length) visit(item.children);
        continue;
      }
      flat.push(item);
    }
  };

  visit(nodes);
  return flat;
}

export const MODE_PLACEHOLDER: Record<Mode['type'], string> = {
  search: 'Search notes…',
  math: 'Math — e.g. =sqrt(2)*pi',
  action: 'Action — e.g. > new note My Note',
  tag: 'Filter by tag…',
  fileType: 'Type filter — e.g. :md or type:kanban',
  nameSearch: 'Search by name…',
  insert: 'Insert — e.g. / or /table 3x4',
};
