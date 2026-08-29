import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { describe, expect, it } from 'vitest';

import {
  createSnippetSessionExtension,
  insertSnippetTemplate,
  parseSnippetTemplate,
} from './snippetEngine';

describe('snippetEngine', () => {
  it('parses placeholders and cursor markers', () => {
    const parsed = parseSnippetTemplate('Hello <placeholder:Name>\n<cursor>');

    expect(parsed.text).toBe('Hello Name\n');
    expect(parsed.placeholders).toEqual([{ from: 6, to: 10 }]);
    expect(parsed.cursorPos).toBe(11);
  });

  it('inserts snippet text and selects the first placeholder', () => {
    const parent = document.createElement('div');
    document.body.appendChild(parent);
    const view = new EditorView({
      state: EditorState.create({
        doc: '',
        extensions: [createSnippetSessionExtension()],
      }),
      parent,
    });

    insertSnippetTemplate(view, '## <placeholder:Title>\n<cursor>');

    expect(view.state.doc.toString()).toBe('## Title\n');
    expect(view.state.selection.main.from).toBe(3);
    expect(view.state.selection.main.to).toBe(8);
    view.destroy();
    parent.remove();
  });

  it('tabs to the next placeholder after replacing and extending the current placeholder text', () => {
    const parent = document.createElement('div');
    document.body.appendChild(parent);
    const view = new EditorView({
      state: EditorState.create({
        doc: '',
        extensions: [createSnippetSessionExtension()],
      }),
      parent,
    });

    insertSnippetTemplate(
      view,
      '\\frac{<placeholder:numerator>}{<placeholder:denominator>}<cursor>',
    );
    view.dispatch({
      changes: {
        from: view.state.selection.main.from,
        to: view.state.selection.main.to,
        insert: '1',
      },
      selection: { anchor: view.state.selection.main.from + 1 },
    });
    view.dispatch({
      changes: {
        from: view.state.selection.main.from,
        to: view.state.selection.main.to,
        insert: '2',
      },
      selection: { anchor: view.state.selection.main.from + 1 },
    });

    const event = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
    view.contentDOM.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
    expect(view.state.doc.toString()).toBe('\\frac{12}{denominator}');
    expect(view.state.sliceDoc(view.state.selection.main.from, view.state.selection.main.to)).toBe(
      'denominator',
    );
    view.destroy();
    parent.remove();
  });
});
