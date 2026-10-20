import { expect, it } from 'vitest';

import type { NoteMetadata } from '../types/note';

import { useNoteIndexStore } from './noteIndexStore';

const note = (relativePath: string): NoteMetadata => ({
  relativePath,
  title: relativePath,
  tags: [],
  wikilinksOut: [],
  hash: 'h',
  modifiedAt: 1,
  wordCount: 1,
});
it('repairs a missed native delta using complete reconciled scopes and preserves unrelated identity', () => {
  const a = note('Docs/a.md'),
    deleted = note('Docs/deleted.md'),
    other = note('Other.md');
  useNoteIndexStore.setState({ notes: [a, deleted, other] });
  // Native state already removed deleted.md in an obsolete response which the
  // frontend correctly rejected. Its next delta has no newly removed paths.
  const next = { ...a, title: 'Updated' };
  useNoteIndexStore
    .getState()
    .applyDelta({ reconciledPaths: ['Docs'], removed: [], upserted: [next] });
  expect(useNoteIndexStore.getState().notes).toEqual([next, other]);
  expect(useNoteIndexStore.getState().notes[1]).toBe(other);
  useNoteIndexStore
    .getState()
    .applyDelta({ reconciledPaths: ['Docs/a.md'], removed: [], upserted: [] });
  expect(useNoteIndexStore.getState().notes).toEqual([other]);
});
