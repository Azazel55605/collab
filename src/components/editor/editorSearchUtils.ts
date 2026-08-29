import { SearchQuery } from '@codemirror/search';
import type { EditorState, SelectionRange } from '@codemirror/state';

export interface SearchMatchStats {
  total: number;
  current: number;
}

function rangeEqualsSelection(from: number, to: number, selection: SelectionRange) {
  return selection.from === from && selection.to === to;
}

export function getSearchMatchStats(state: EditorState, query: SearchQuery): SearchMatchStats {
  if (!query.valid || !query.search) {
    return { total: 0, current: 0 };
  }

  const cursor = query.getCursor(state);
  const selection = state.selection.main;
  let total = 0;
  let current = 0;

  for (let next = cursor.next(); !next.done; next = cursor.next()) {
    total += 1;
    if (rangeEqualsSelection(next.value.from, next.value.to, selection)) {
      current = total;
    }
  }

  return { total, current };
}
