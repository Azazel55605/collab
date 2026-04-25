import { EditorState } from '@codemirror/state';
import { describe, expect, it } from 'vitest';

import { buildMarkdownEditorTheme, buildMarkdownHighlightStyle } from './markdownEditorTheme';

describe('markdownEditorTheme', () => {
  it('creates a codemirror theme extension', () => {
    const state = EditorState.create({
      extensions: [buildMarkdownEditorTheme(true, 'monospace', 16)],
    });

    expect(state).toBeTruthy();
  });

  it('creates dark and light highlight styles', () => {
    expect(buildMarkdownHighlightStyle(true)).toBeTruthy();
    expect(buildMarkdownHighlightStyle(false)).toBeTruthy();
  });
});
