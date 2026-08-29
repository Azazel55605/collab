import { describe, expect, it } from 'vitest';

import type { NoteMetadata } from '../../types/note';

import { buildGraphData } from './GraphView';

function makeNote(
  overrides: Partial<NoteMetadata> & Pick<NoteMetadata, 'relativePath'>,
): NoteMetadata {
  return {
    relativePath: overrides.relativePath,
    title:
      overrides.title ??
      overrides.relativePath.split('/').pop()?.replace(/\.md$/i, '') ??
      overrides.relativePath,
    tags: overrides.tags ?? [],
    wikilinksOut: overrides.wikilinksOut ?? [],
    modifiedAt: overrides.modifiedAt ?? 0,
    wordCount: overrides.wordCount ?? 0,
    hash: overrides.hash ?? overrides.relativePath,
  };
}

describe('buildGraphData', () => {
  it('resolves path-style wikilinks and ignores ambiguous duplicate stems', () => {
    const notes = [
      makeNote({
        relativePath: 'Projects/Alpha.md',
        wikilinksOut: ['Refs/Shared', 'Unique'],
      }),
      makeNote({
        relativePath: 'Refs/Shared.md',
        title: 'Shared',
      }),
      makeNote({
        relativePath: 'Archive/Shared.md',
        title: 'Shared',
      }),
      makeNote({
        relativePath: 'Notes/Unique.md',
        title: 'Unique',
      }),
    ];

    const { links } = buildGraphData(notes);

    expect(links).toEqual([
      { source: 'Projects/Alpha.md', target: 'Refs/Shared.md' },
      { source: 'Projects/Alpha.md', target: 'Notes/Unique.md' },
    ]);
  });

  it('deduplicates repeated wikilinks to the same target', () => {
    const notes = [
      makeNote({
        relativePath: 'Source.md',
        wikilinksOut: ['Target', 'Target', 'Target.md'],
      }),
      makeNote({
        relativePath: 'Target.md',
      }),
    ];

    const { links } = buildGraphData(notes);

    expect(links).toEqual([{ source: 'Source.md', target: 'Target.md' }]);
  });
});
