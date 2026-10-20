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

it('retains unchanged graph/adjacency identity and invalidates ambiguous targets when notes change', async () => {
  const { createGraphDataBuilder } = await import('./graphData');
  const build = createGraphDataBuilder();
  const source = makeNote({ relativePath: 'Source.md', wikilinksOut: ['Target'] });
  const target = makeNote({ relativePath: 'Target.md' });
  const initial = build([source, target]);
  expect(build([{ ...source, hash: 'new text only' }, target])).toBe(initial);
  const changed = build([source, { ...target, tags: ['tag'] }]);
  expect(changed.nodes[0]).toBe(initial.nodes[0]);
  expect(changed.links[0]).toBe(initial.links[0]);
  const ambiguous = build([source, target, makeNote({ relativePath: 'Folder/Target.md' })]);
  // Exact root-relative stem still wins over an ambiguous basename.
  expect(ambiguous.links).toHaveLength(1);
  const renamed = build([source, { ...target, relativePath: 'Other.md', title: 'Other' }]);
  expect(renamed.links).toHaveLength(0);
});

it('bounds dense graph edges without unstable data on an unchanged refresh', async () => {
  const { createGraphDataBuilder, GRAPH_LINK_LIMIT } = await import('./graphData');
  const build = createGraphDataBuilder();
  const notes = Array.from({ length: 500 }, (_, index) =>
    makeNote({
      relativePath: `${index}.md`,
      wikilinksOut: Array.from({ length: 20 }, (_, offset) => `${(index + offset + 1) % 500}`),
    }),
  );
  const graph = build(notes);
  expect(graph.nodes).toHaveLength(500);
  expect(graph.links).toHaveLength(GRAPH_LINK_LIMIT);
  expect(build([...notes])).toBe(graph);
});
