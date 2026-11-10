import { history, undo } from '@codemirror/commands';
import { Compartment, EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { describe, expect, it } from 'vitest';

import { DEFAULT_NOTE_PAGE_SETTINGS } from '../../lib/notePageLayout';

import { noteEditorPagination, planEditorPages } from './noteEditorPagination';

describe('editable note pages', () => {
  it('keeps blocks that fit together and pads to the next content area', () => {
    expect(
      planEditorPages(
        [
          { from: 0, to: 10, height: 60 },
          { from: 11, to: 20, height: 40 },
          { from: 21, to: 30, height: 30 },
        ],
        100,
        20,
        () => '',
      ),
    ).toEqual([{ from: 21, height: 68, page: 1 }]);
  });
  it('fragments a long source line without introducing document characters', () => {
    const text = 'a word '.repeat(100);
    const breaks = planEditorPages(
      [{ from: 0, to: text.length, height: 350 }],
      100,
      20,
      (from, to) => text.slice(from, to),
    );
    expect(breaks).toHaveLength(3);
    expect(breaks.every((gap) => text[gap.from - 1] === ' ')).toBe(true);
    expect(breaks.map((gap) => gap.from)).toEqual(
      [...breaks.map((gap) => gap.from)].sort((a, b) => a - b),
    );
  });
  it('preserves selection, undo history and the document when changing layout', () => {
    const layout = new Compartment();
    const view = new EditorView({
      state: EditorState.create({
        doc: 'original note',
        extensions: [history(), layout.of([])],
      }),
      parent: document.body,
    });
    try {
      view.dispatch({ changes: { from: 13, insert: ' edited' }, selection: { anchor: 20 } });
      view.dispatch({
        effects: layout.reconfigure(noteEditorPagination(DEFAULT_NOTE_PAGE_SETTINGS)),
      });
      expect(view.state.doc.toString()).toBe('original note edited');
      expect(view.state.selection.main.head).toBe(20);
      view.dispatch({ effects: layout.reconfigure([]) });
      expect(undo(view)).toBe(true);
      expect(view.state.doc.toString()).toBe('original note');
    } finally {
      view.destroy();
    }
  });
});
