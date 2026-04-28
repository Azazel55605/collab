import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { describe, expect, it } from 'vitest';

import { createSnippetSessionExtension, insertSnippetTemplate, parseSnippetTemplate } from './snippetEngine';

describe('snippetEngine', () => {
  it('parses placeholders and cursor markers', () => {
    const parsed = parseSnippetTemplate('Hello <placeholder:Name>\n<cursor>');

    expect(parsed.text).toBe('Hello Name\n');
    expect(parsed.placeholders).toEqual([{ from: 6, to: 10 }]);
    expect(parsed.cursorPos).toBe(11);
  });

  it('inserts snippet text and selects the first placeholder', () => {
    const parent = document.createElement('div');
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
  });
});
