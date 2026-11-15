import { describe, expect, it } from 'vitest';

import type { NoteFile } from '../../types/vault';

import { filterFileTreeByName } from './fileTreeFilters';

const file = (relativePath: string): NoteFile => {
  const name = relativePath.split('/').pop()!;
  return {
    relativePath,
    name,
    extension: name.split('.').pop() ?? '',
    modifiedAt: 0,
    size: 1,
    isFolder: false,
  };
};
const folder = (relativePath: string, children: NoteFile[]): NoteFile => ({
  relativePath,
  name: relativePath.split('/').pop()!,
  extension: '',
  modifiedAt: 0,
  size: 0,
  isFolder: true,
  children,
});

const tree = [
  folder('Meetings', [file('Meetings/Kickoff.md'), file('Meetings/Retro.md')]),
  folder('Projects', [folder('Projects/Media', [file('Projects/Media/Player.deck')])]),
  file('Kick list.md'),
];

const paths = (nodes: NoteFile[]): string[] =>
  nodes.flatMap((node) => [node.relativePath, ...paths(node.children ?? [])]);

describe('filterFileTreeByName', () => {
  it('keeps matching files and the folders leading to them, ignoring case', () => {
    expect(paths(filterFileTreeByName(tree, 'KICK'))).toEqual([
      'Meetings',
      'Meetings/Kickoff.md',
      'Kick list.md',
    ]);
    expect(paths(filterFileTreeByName(tree, 'player'))).toEqual([
      'Projects',
      'Projects/Media',
      'Projects/Media/Player.deck',
    ]);
  });

  it('keeps all contents of a folder whose own name matches', () => {
    expect(paths(filterFileTreeByName(tree, 'meet'))).toEqual([
      'Meetings',
      'Meetings/Kickoff.md',
      'Meetings/Retro.md',
    ]);
  });

  it('returns the tree unchanged for an empty query', () => {
    expect(filterFileTreeByName(tree, '  ')).toBe(tree);
  });
});
