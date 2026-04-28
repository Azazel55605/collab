import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { describe, expect, it } from 'vitest';

import {
  buildCalloutSnippet,
  buildReferencesSectionSnippet,
  insertOrNavigateFootnote,
  shouldOpenSlashMenu,
} from './noteAuthoring';
import { createSnippetSessionExtension } from './snippetEngine';

describe('noteAuthoring helpers', () => {
  it('builds callout and references snippets', () => {
    expect(buildCalloutSnippet('note')).toContain('::: note');
    expect(buildReferencesSectionSnippet()).toContain('## References');
  });

  it('inserts a footnote reference and definition', () => {
    const parent = document.createElement('div');
    const view = new EditorView({
      state: EditorState.create({
        doc: 'Paragraph text',
        extensions: [createSnippetSessionExtension()],
      }),
      parent,
    });

    insertOrNavigateFootnote(view);

    expect(view.state.doc.toString()).toContain('[^1]');
    expect(view.state.doc.toString()).toContain('[^1]:');
    view.destroy();
  });

  it('keeps slash commands out of fenced code and path-like text', () => {
    expect(shouldOpenSlashMenu('```\n/ca\n```', 6)).toBe(false);
    expect(shouldOpenSlashMenu('folder/path', 'folder/path'.length)).toBe(false);
    expect(shouldOpenSlashMenu('\n/callout', '\n/callout'.length)).toBe(true);
  });
});
