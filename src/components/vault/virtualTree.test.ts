import { expect, it } from 'vitest';

import type { NoteFile } from '../../types/vault';

import { TREE_ROW_HEIGHT, treeWindow, visibleTreeRows } from './virtualTree';

it('windows ten thousand visible rows with overscan and retains keyboard focus offscreen', () => {
  const files: NoteFile[] = Array.from({ length: 10000 }, (_, i) => ({
    relativePath: `Docs/${i}.md`,
    name: `${i}.md`,
    isFolder: false,
    size: 1,
    modifiedAt: 1,
    extension: 'md',
  }));
  const tree = [{ ...files[0], relativePath: 'Docs', isFolder: true, children: files }];
  const rows = visibleTreeRows(tree, new Set());
  expect(rows).toHaveLength(10001);
  expect(rows[10000]).toMatchObject({ depth: 1, position: 10000, siblings: 10000 });
  const window = treeWindow(rows.length, 5000 * TREE_ROW_HEIGHT, 600, 0);
  expect(window.length).toBeLessThan(41);
  expect(window).toContain(0);
  expect(window).toContain(5000);
  expect(visibleTreeRows(tree, new Set(['Docs']))).toHaveLength(1);
});
