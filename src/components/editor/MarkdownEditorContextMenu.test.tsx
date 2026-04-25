import { describe, expect, it, vi } from 'vitest';

import {
  addTagsLineEvent,
  copyEditorSelection,
  cutEditorSelection,
  pasteClipboardAtCursor,
  selectAllInEditor,
  wrapBoldSelection,
  wrapItalicSelection,
  wrapStrikethroughSelection,
} from './MarkdownEditorContextMenu';

function createMockView(text: string, from = 0, to = from) {
  let currentText = text;
  let selection = { from, to, head: to };
  const view = {
    state: {
      doc: {
        get length() {
          return currentText.length;
        },
      },
      selection: {
        main: selection,
      },
      sliceDoc(start: number, end: number) {
        return currentText.slice(start, end);
      },
    },
    dispatch(payload: { changes?: { from: number; to?: number; insert?: string }; selection?: { anchor: number; head?: number } }) {
      if (payload.changes) {
        const changeTo = payload.changes.to ?? payload.changes.from;
        const insert = payload.changes.insert ?? '';
        currentText = currentText.slice(0, payload.changes.from) + insert + currentText.slice(changeTo);
      }
      if (payload.selection) {
        selection = {
          from: payload.selection.anchor,
          to: payload.selection.head ?? payload.selection.anchor,
          head: payload.selection.head ?? payload.selection.anchor,
        };
        this.state.selection.main = selection;
      }
    },
    focus: vi.fn(),
    getText: () => currentText,
    getSelection: () => selection,
  };

  return view as unknown as {
    state: {
      doc: { length: number };
      selection: { main: { from: number; to: number; head: number } };
      sliceDoc: (start: number, end: number) => string;
    };
    dispatch: (payload: { changes?: { from: number; to?: number; insert?: string }; selection?: { anchor: number; head?: number } }) => void;
    focus: ReturnType<typeof vi.fn>;
    getText: () => string;
    getSelection: () => { from: number; to: number; head: number };
  };
}

describe('MarkdownEditorContextMenu helpers', () => {
  it('cuts and copies editor selections through the clipboard', async () => {
    const clipboard = {
      writeText: vi.fn(),
      readText: vi.fn(async () => ''),
    };
    const cutView = createMockView('hello', 1, 4);
    expect(cutEditorSelection(cutView as never, clipboard)).toBe(true);
    expect(clipboard.writeText).toHaveBeenCalledWith('ell');
    expect(cutView.getText()).toBe('ho');

    const copyView = createMockView('hello', 0, 5);
    expect(copyEditorSelection(copyView as never, clipboard)).toBe(true);
    expect(clipboard.writeText).toHaveBeenLastCalledWith('hello');
  });

  it('pastes clipboard text and selects all', async () => {
    const clipboard = {
      readText: vi.fn(async () => 'XYZ'),
    };
    const pasteView = createMockView('hello', 5, 5);
    await pasteClipboardAtCursor(pasteView as never, clipboard);
    expect(pasteView.getText()).toBe('helloXYZ');

    const selectView = createMockView('abcdef', 2, 4);
    expect(selectAllInEditor(selectView as never)).toBe(true);
    expect(selectView.getSelection()).toEqual({ from: 0, to: 6, head: 6 });
  });

  it('wraps selections for bold, italic, and strikethrough', () => {
    const boldView = createMockView('hello', 0, 5);
    wrapBoldSelection(boldView as never);
    expect(boldView.getText()).toBe('**hello**');

    const italicView = createMockView('hello', 0, 5);
    wrapItalicSelection(italicView as never);
    expect(italicView.getText()).toBe('_hello_');

    const strikeView = createMockView('hello', 0, 5);
    wrapStrikethroughSelection(strikeView as never);
    expect(strikeView.getText()).toBe('~~hello~~');
  });

  it('dispatches the add-tags-line event', () => {
    const target = new EventTarget();
    const listener = vi.fn();
    target.addEventListener('tag:add-tags-line', listener as EventListener);

    addTagsLineEvent(target as never);

    expect(listener).toHaveBeenCalledTimes(1);
  });
});
