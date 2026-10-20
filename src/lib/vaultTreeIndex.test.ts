import { describe, expect, it } from 'vitest';

import type { NoteFile } from '../types/vault';

import { applyTreePaths, coalescePaths, vaultTreeIndex } from './vaultTreeIndex';

const file = (relativePath: string): NoteFile => ({
  relativePath,
  name: relativePath.split('/').pop()!,
  extension: 'md',
  modifiedAt: 1,
  size: 1,
  isFolder: false,
});
describe('revision-scoped path maps', () => {
  it('shares lookups and replaces only affected ancestry, including removal and new paths', () => {
    const a = file('Docs/a.md'),
      b = file('Docs/b.md'),
      other = file('other.md');
    const tree = [{ ...file('Docs'), isFolder: true, children: [a, b] }, other];
    const first = vaultTreeIndex(tree);
    expect(vaultTreeIndex(tree)).toBe(first);
    expect(first.foldedFiles.get('docs/a.md')).toBe(a);
    const replacement = { ...a, size: 2 };
    const next = applyTreePaths(tree, [
      { relativePath: a.relativePath, node: replacement },
      { relativePath: b.relativePath, node: null },
      { relativePath: 'Docs/c.md', node: file('Docs/c.md') },
    ]);
    expect(next[1]).toBe(other);
    expect(next[0]).not.toBe(tree[0]);
    expect(vaultTreeIndex(next).byPath.get(a.relativePath)).toBe(replacement);
    expect(vaultTreeIndex(next).byPath.has(b.relativePath)).toBe(false);
    expect(first.byPath.get(a.relativePath)).toBe(a);
    expect(coalescePaths(['Docs/a.md', 'Docs', 'Other/a.md', 'Docs/b.md', 'Docs'])).toEqual([
      'Docs',
      'Other/a.md',
    ]);
  });
  it('requires reconciliation when a new ancestor is missing', () => {
    expect(() =>
      applyTreePaths([], [{ relativePath: 'New/a.md', node: file('New/a.md') }]),
    ).toThrow('Missing parent');
  });
});
