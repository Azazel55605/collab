import { describe, expect, it, vi } from 'vitest';

import {
  insertAroundSelection,
  insertSnippetAtSelection,
  replaceEditorRange,
  toggleLinePrefix,
} from './useMarkdownEditorHandle';

function createMockView(text: string, from = 0, to = from) {
  let currentText = text;
  let selection = { from, to, head: to };
  const view = {
    state: {
      doc: {
        lineAt() {
          return { from: 0, to: currentText.length, text: currentText };
        },
      },
      selection: {
        main: selection,
      },
      sliceDoc(start: number, end: number) {
        return currentText.slice(start, end);
      },
    },
    dispatch(payload: { changes: { from: number; to?: number; insert?: string }; selection?: { anchor: number; head?: number } }) {
      const changeTo = payload.changes.to ?? payload.changes.from;
      const insert = payload.changes.insert ?? '';
      currentText = currentText.slice(0, payload.changes.from) + insert + currentText.slice(changeTo);
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
    getText() {
      return currentText;
    },
    getSelection() {
      return selection;
    },
  };

  return view as unknown as {
    state: {
      doc: { lineAt: (pos: number) => { from: number; to: number; text: string } };
      selection: { main: { from: number; to: number; head: number } };
      sliceDoc: (start: number, end: number) => string;
    };
    dispatch: (payload: { changes: { from: number; to?: number; insert?: string }; selection?: { anchor: number; head?: number } }) => void;
    focus: ReturnType<typeof vi.fn>;
    getText: () => string;
    getSelection: () => { from: number; to: number; head: number };
  };
}

describe('useMarkdownEditorHandle helpers', () => {
  it('wraps the selection with surrounding text', () => {
    const view = createMockView('hello', 0, 5);

    insertAroundSelection(view as never, '**', '**', 'bold text');

    expect(view.getText()).toBe('**hello**');
    expect(view.getSelection()).toEqual({ from: 2, to: 7, head: 7 });
    expect(view.focus).toHaveBeenCalled();
  });

  it('toggles a line prefix on and off', () => {
    const addView = createMockView('task', 0, 4);
    toggleLinePrefix(addView as never, '- ');
    expect(addView.getText()).toBe('- task');

    const removeView = createMockView('- task', 2, 6);
    toggleLinePrefix(removeView as never, '- ');
    expect(removeView.getText()).toBe('task');
  });

  it('inserts snippets and respects the cursor marker', () => {
    const view = createMockView('hello', 5, 5);

    insertSnippetAtSelection(view as never, '\n<cursor>world');

    expect(view.getText()).toBe('hello\nworld');
    expect(view.getSelection()).toEqual({ from: 6, to: 6, head: 6 });
  });

  it('replaces a range and moves the cursor to the end of the inserted text', () => {
    const view = createMockView('abcdef');

    replaceEditorRange(view as never, { from: 2, to: 4 }, 'ZZ');

    expect(view.getText()).toBe('abZZef');
    expect(view.getSelection()).toEqual({ from: 4, to: 4, head: 4 });
  });
});
