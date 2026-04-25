import type { MutableRefObject } from 'react';
import type { EditorView } from '@codemirror/view';

import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '../ui/context-menu';
import {
  insertAroundSelection,
} from './useMarkdownEditorHandle';

type ClipboardLike = {
  writeText: (text: string) => Promise<void> | void;
  readText: () => Promise<string>;
};

export function cutEditorSelection(view: EditorView, clipboard: ClipboardLike = navigator.clipboard) {
  const { from, to } = view.state.selection.main;
  const text = view.state.sliceDoc(from, to);
  if (!text) return false;
  void clipboard.writeText(text);
  view.dispatch({ changes: { from, to, insert: '' } });
  view.focus();
  return true;
}

export function copyEditorSelection(view: EditorView, clipboard: Pick<ClipboardLike, 'writeText'> = navigator.clipboard) {
  const { from, to } = view.state.selection.main;
  void clipboard.writeText(view.state.sliceDoc(from, to));
  return true;
}

export async function pasteClipboardAtCursor(
  view: EditorView,
  clipboard: Pick<ClipboardLike, 'readText'> = navigator.clipboard,
) {
  const text = await clipboard.readText();
  const { from, to } = view.state.selection.main;
  view.dispatch({ changes: { from, to, insert: text }, selection: { anchor: from + text.length } });
  view.focus();
  return text;
}

export function selectAllInEditor(view: EditorView) {
  view.dispatch({ selection: { anchor: 0, head: view.state.doc.length } });
  view.focus();
  return true;
}

export function addTagsLineEvent(target: Window = window) {
  target.dispatchEvent(new CustomEvent('tag:add-tags-line'));
}

export function wrapBoldSelection(view: EditorView) {
  const { from, to } = view.state.selection.main;
  const sel = view.state.sliceDoc(from, to) || 'bold text';
  insertAroundSelection(view, '**', '**', sel);
}

export function wrapItalicSelection(view: EditorView) {
  const { from, to } = view.state.selection.main;
  const sel = view.state.sliceDoc(from, to) || 'italic text';
  insertAroundSelection(view, '_', '_', sel);
}

export function wrapStrikethroughSelection(view: EditorView) {
  const { from, to } = view.state.selection.main;
  const sel = view.state.sliceDoc(from, to) || 'strikethrough';
  insertAroundSelection(view, '~~', '~~', sel);
}

type Props = {
  containerRef: MutableRefObject<HTMLDivElement | null>;
  viewRef: MutableRefObject<EditorView | null>;
};

export function MarkdownEditorContextMenu({ containerRef, viewRef }: Props) {
  const withView = (fn: (view: EditorView) => void | Promise<void>) => () => {
    const view = viewRef.current;
    if (!view) return;
    void fn(view);
  };

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div ref={containerRef} className="absolute inset-0 cm-editor-container" />
      </ContextMenuTrigger>
      <ContextMenuContent className="w-44">
        <ContextMenuItem className="text-xs" onSelect={withView((view) => { cutEditorSelection(view); })}>
          Cut <span className="ml-auto text-muted-foreground">⌘X</span>
        </ContextMenuItem>
        <ContextMenuItem className="text-xs" onSelect={withView((view) => { copyEditorSelection(view); })}>
          Copy <span className="ml-auto text-muted-foreground">⌘C</span>
        </ContextMenuItem>
        <ContextMenuItem className="text-xs" onSelect={withView(async (view) => { await pasteClipboardAtCursor(view); })}>
          Paste <span className="ml-auto text-muted-foreground">⌘V</span>
        </ContextMenuItem>
        <ContextMenuItem className="text-xs" onSelect={withView((view) => { selectAllInEditor(view); })}>
          Select all <span className="ml-auto text-muted-foreground">⌘A</span>
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem className="text-xs" onSelect={withView((view) => { wrapBoldSelection(view); })}>
          Bold <span className="ml-auto text-muted-foreground">⌘B</span>
        </ContextMenuItem>
        <ContextMenuItem className="text-xs" onSelect={withView((view) => { wrapItalicSelection(view); })}>
          Italic <span className="ml-auto text-muted-foreground">⌘I</span>
        </ContextMenuItem>
        <ContextMenuItem className="text-xs" onSelect={withView((view) => { wrapStrikethroughSelection(view); })}>
          Strikethrough <span className="ml-auto text-muted-foreground">⌘⇧X</span>
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem className="text-xs" onSelect={() => { addTagsLineEvent(); }}>
          Add tags line
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}
