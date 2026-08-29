import { SearchQuery } from '@codemirror/search';
import { EditorSelection, EditorState } from '@codemirror/state';
import { describe, expect, it } from 'vitest';

import { getSearchMatchStats } from './editorSearchUtils';

describe('getSearchMatchStats', () => {
  it('counts total matches and detects the active match from the selection', () => {
    const state = EditorState.create({
      doc: 'alpha beta gamma beta',
      selection: EditorSelection.single(17, 21),
    });

    const stats = getSearchMatchStats(state, new SearchQuery({ search: 'beta' }));

    expect(stats).toEqual({ total: 2, current: 2 });
  });

  it('returns zero stats for empty queries', () => {
    const state = EditorState.create({ doc: 'alpha beta gamma' });

    const stats = getSearchMatchStats(state, new SearchQuery({ search: '' }));

    expect(stats).toEqual({ total: 0, current: 0 });
  });
});
