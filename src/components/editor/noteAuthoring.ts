import type { EditorView } from '@codemirror/view';

import { insertSnippetTemplate } from './snippetEngine';
import type { NoteSnippet } from '../../types/noteSnippet';

const CALLOUT_TITLES: Record<'note' | 'tip' | 'warning' | 'danger' | 'info', string> = {
  note: 'Note',
  tip: 'Tip',
  warning: 'Warning',
  danger: 'Danger',
  info: 'Info',
};

export function buildCalloutSnippet(type: keyof typeof CALLOUT_TITLES) {
  return `::: ${type} <placeholder:${CALLOUT_TITLES[type]}>\n<placeholder:Write your ${type} here>\n:::\n<cursor>`;
}

export function buildReferencesSectionSnippet() {
  return '## References\n\n- [<placeholder:Author, Title>](<placeholder:https://example.com>)\n<cursor>';
}

function nextFootnoteId(content: string) {
  const matches = [...content.matchAll(/\[\^([^\]]+)\]/g)];
  let max = 0;
  for (const match of matches) {
    const value = Number(match[1]);
    if (Number.isFinite(value)) max = Math.max(max, value);
  }
  return String(max + 1 || 1);
}

function findFootnoteContext(content: string, cursor: number) {
  const lines = content.split('\n');
  let offset = 0;
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex];
    const from = offset;
    const to = offset + line.length;
    if (cursor >= from && cursor <= to) {
      const refMatch = [...line.matchAll(/\[\^([^\]]+)\]/g)].find((match) => {
        const start = from + (match.index ?? 0);
        const end = start + match[0].length;
        return cursor >= start && cursor <= end;
      });
      if (refMatch) {
        return { type: 'ref' as const, id: refMatch[1] };
      }
      const defMatch = line.match(/^\[\^([^\]]+)\]:/);
      if (defMatch) {
        return { type: 'def' as const, id: defMatch[1] };
      }
      return null;
    }
    offset = to + 1;
  }
  return null;
}

function findDefinitionRange(content: string, id: string) {
  const lines = content.split('\n');
  let offset = 0;
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex];
    if (line.startsWith(`[^${id}]:`)) {
      const start = offset;
      let end = offset + line.length;
      for (let nextIndex = lineIndex + 1; nextIndex < lines.length; nextIndex += 1) {
        const nextLine = lines[nextIndex];
        if (!nextLine.startsWith('  ') && !nextLine.startsWith('\t')) break;
        end += 1 + nextLine.length;
      }
      return { from: start, to: end };
    }
    offset += line.length + 1;
  }
  return null;
}

export function insertOrNavigateFootnote(view: EditorView) {
  const cursor = view.state.selection.main.from;
  const content = view.state.doc.toString();
  const context = findFootnoteContext(content, cursor);

  if (context) {
    const definition = findDefinitionRange(content, context.id);
    if (definition) {
      view.dispatch({
        selection: { anchor: definition.from, head: definition.to },
      });
      view.focus();
      return true;
    }
  }

  const id = nextFootnoteId(content);
  const current = view.state.selection.main;
  const selected = view.state.sliceDoc(current.from, current.to);
  const bodyValue = selected.length > 0 ? selected : 'Footnote text';
  const insert = `[^${id}]\n\n[^${id}]: <placeholder:${bodyValue}><cursor>`;
  insertSnippetTemplate(view, insert);
  return true;
}

export function insertSnippetReference(view: EditorView, snippet: NoteSnippet) {
  insertSnippetTemplate(view, snippet.body);
}

export function isCursorInsideFencedCode(content: string, cursor: number) {
  const before = content.slice(0, cursor).split('\n');
  let inside = false;
  for (const line of before) {
    const trimmed = line.trim();
    if (/^(```|~~~)/.test(trimmed)) {
      inside = !inside;
    }
  }
  return inside;
}

export function isCursorInsideInlineCode(content: string, cursor: number) {
  const lineStart = content.lastIndexOf('\n', Math.max(0, cursor - 1)) + 1;
  const lineEnd = content.indexOf('\n', cursor);
  const line = content.slice(lineStart, lineEnd === -1 ? content.length : lineEnd);
  const cursorOnLine = cursor - lineStart;
  const before = line.slice(0, cursorOnLine);
  const backticks = before.match(/`/g)?.length ?? 0;
  return backticks % 2 === 1;
}

export function shouldOpenSlashMenu(content: string, cursor: number) {
  if (isCursorInsideFencedCode(content, cursor) || isCursorInsideInlineCode(content, cursor)) {
    return false;
  }
  const slashIndex = content.lastIndexOf('/', cursor - 1);
  if (slashIndex < 0) return false;
  if (slashIndex > 0) {
    const previous = content[slashIndex - 1];
    if (/[A-Za-z0-9._-]/.test(previous)) {
      return false;
    }
  }
  return true;
}
