import { EditorView, keymap } from '@codemirror/view';
import { describe, expect, it } from 'vitest';

import { indentationConfig } from './indentationPlugins';
import {
  buildMarkdownEditorInitialExtensions,
  buildMarkdownEditorReconfigureEffects,
  createMarkdownEditorCompartments,
  createMarkdownEditorState,
} from './markdownEditorViewConfig';

describe('markdownEditorViewConfig', () => {
  it('creates five initial compartment extensions and reconfigure effects', () => {
    const compartments = createMarkdownEditorCompartments();
    const compartmentExtensions = {
      themeExtension: [],
      highlightExtension: [],
      indentationExtension: indentationConfig('spaces', 2),
      indentVisualExtension: [],
      colorPreviewExtension: [],
      contentAttrsExtension: [],
    };

    expect(buildMarkdownEditorInitialExtensions(compartments, compartmentExtensions)).toHaveLength(6);
    expect(buildMarkdownEditorReconfigureEffects(compartments, compartmentExtensions)).toHaveLength(6);
  });

  it('builds an editor state with the provided content and indentation config', () => {
    const compartments = createMarkdownEditorCompartments();
    const state = createMarkdownEditorState({
      content: '# hello',
      compartments,
      compartmentExtensions: {
        themeExtension: [],
        highlightExtension: [],
        indentationExtension: indentationConfig('spaces', 4),
        indentVisualExtension: [],
        colorPreviewExtension: [],
        contentAttrsExtension: [],
      },
      wikiAutocompleteOverride: [],
      slashCommandOverride: () => null,
      linkClickHandler: [],
      saveKeymap: keymap.of([]),
      updateListener: EditorView.updateListener.of(() => {}),
      livePreviewExtension: [],
    });

    expect(state.doc.toString()).toBe('# hello');
    expect(state.tabSize).toBe(4);
  });
});
