import { EditorState } from '@codemirror/state';
import { indentUnit } from '@codemirror/language';
import { EditorView } from '@codemirror/view';
import { afterEach, describe, expect, it } from 'vitest';

import {
  asciiArrowLigatures,
  handleTabKey,
  indentationConfig,
  indentVisualization,
} from './indentationPlugins';

describe('indentationPlugins', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('returns an empty indent visualization extension when both visuals are disabled', () => {
    expect(indentVisualization(false, false, 'spaces', 2)).toEqual([]);
  });

  it('configures indentation facets for spaces', () => {
    const state = EditorState.create({
      extensions: indentationConfig('spaces', 4),
    });

    expect(state.tabSize).toBe(4);
    expect(state.facet(indentUnit)).toBe('    ');
  });

  it('inserts one indent unit on tab with an empty selection', () => {
    const parent = document.createElement('div');
    document.body.append(parent);
    const view = new EditorView({
      parent,
      state: EditorState.create({
        doc: 'hello',
        extensions: indentationConfig('spaces', 2),
      }),
    });

    view.dispatch({ selection: { anchor: 0 } });
    expect(handleTabKey(view)).toBe(true);
    expect(view.state.doc.toString()).toBe('  hello');
  });

  it('provides codemirror extensions for ligatures when enabled', () => {
    expect(asciiArrowLigatures()).toBeTruthy();
  });
});
