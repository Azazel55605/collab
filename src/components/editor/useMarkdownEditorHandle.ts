import type { MutableRefObject } from 'react';
import { useImperativeHandle } from 'react';
import type { EditorView } from '@codemirror/view';

import type { ParsedCodeBlockAtCursor } from './codeBlockUtils';
import { insertOrNavigateFootnote } from './noteAuthoring';
import { insertSnippetTemplate } from './snippetEngine';

type SelectionRange = { from: number; to: number };

export function insertAroundSelection(
  view: EditorView,
  before: string,
  after: string,
  placeholder: string,
) {
  const { from, to } = view.state.selection.main;
  const selected = view.state.sliceDoc(from, to);
  const text = selected.length ? before + selected + after : before + placeholder + after;
  const selStart = from + before.length;
  const selEnd = selStart + (selected.length || placeholder.length);
  view.dispatch({
    changes: { from, to, insert: text },
    selection: { anchor: selStart, head: selEnd },
  });
  view.focus();
}

export function toggleLinePrefix(view: EditorView, prefix: string) {
  const { from, to } = view.state.selection.main;
  const line = view.state.doc.lineAt(from);
  const existing = view.state.sliceDoc(line.from, line.from + prefix.length);
  if (existing === prefix) {
    const nextAnchor = Math.max(line.from, from - prefix.length);
    const nextHead = Math.max(line.from, to - prefix.length);
    view.dispatch({
      changes: { from: line.from, to: line.from + prefix.length },
      selection: { anchor: nextAnchor, head: nextHead },
    });
  } else {
    view.dispatch({
      changes: { from: line.from, insert: prefix },
      selection: { anchor: from + prefix.length, head: to + prefix.length },
    });
  }
  view.focus();
}

export function insertSnippetAtSelection(view: EditorView, text: string) {
  insertSnippetTemplate(view, text);
}

export function replaceEditorRange(view: EditorView, range: SelectionRange, text: string) {
  view.dispatch({
    changes: { from: range.from, to: range.to, insert: text },
    selection: { anchor: range.from + text.length },
  });
  view.focus();
}

type MarkdownEditorHandleShape = {
  insertAround: (before: string, after: string, placeholder: string) => void;
  insertLine: (prefix: string) => void;
  insertSnippet: (text: string) => void;
  insertFootnote: () => void;
  focus: () => void;
  replaceRange: (from: number, to: number, text: string) => void;
  moveCursorToEnd: () => void;
  getTableAtCursor: () => { from: number; to: number; text: string } | null;
  getMathBlockAtCursor: () => { from: number; to: number; text: string } | null;
  getCodeBlockAtCursor: () => ParsedCodeBlockAtCursor | null;
};

type UseMarkdownEditorHandleArgs = {
  ref: React.Ref<MarkdownEditorHandleShape>;
  viewRef: MutableRefObject<EditorView | null>;
  getTableAtCursor: (view: EditorView) => { from: number; to: number; text: string } | null;
  getMathBlockAtCursor: (view: EditorView) => { from: number; to: number; text: string } | null;
  getCodeBlockAtCursor: (view: EditorView) => ParsedCodeBlockAtCursor | null;
};

export function useMarkdownEditorHandle({
  ref,
  viewRef,
  getTableAtCursor,
  getMathBlockAtCursor,
  getCodeBlockAtCursor,
}: UseMarkdownEditorHandleArgs) {
  useImperativeHandle(ref, () => ({
    insertAround(before, after, placeholder) {
      const view = viewRef.current;
      if (!view) return;
      insertAroundSelection(view, before, after, placeholder);
    },

    insertLine(prefix) {
      const view = viewRef.current;
      if (!view) return;
      toggleLinePrefix(view, prefix);
    },

    insertSnippet(text) {
      const view = viewRef.current;
      if (!view) return;
      insertSnippetAtSelection(view, text);
    },

    insertFootnote() {
      const view = viewRef.current;
      if (!view) return;
      insertOrNavigateFootnote(view);
    },

    focus() {
      viewRef.current?.focus();
    },

    replaceRange(from, to, text) {
      const view = viewRef.current;
      if (!view) return;
      replaceEditorRange(view, { from, to }, text);
    },

    moveCursorToEnd() {
      const view = viewRef.current;
      if (!view) return;
      const end = view.state.doc.length;
      view.dispatch({
        selection: { anchor: end, head: end },
      });
      view.focus();
    },

    getTableAtCursor() {
      const view = viewRef.current;
      if (!view) return null;
      return getTableAtCursor(view);
    },

    getMathBlockAtCursor() {
      const view = viewRef.current;
      if (!view) return null;
      return getMathBlockAtCursor(view);
    },

    getCodeBlockAtCursor() {
      const view = viewRef.current;
      if (!view) return null;
      return getCodeBlockAtCursor(view);
    },
  }), [getCodeBlockAtCursor, getMathBlockAtCursor, getTableAtCursor, viewRef]);
}
