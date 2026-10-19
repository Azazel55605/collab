import { expect, it } from 'vitest';

import { nativeDropFolderAtPoint } from './nativeDropTarget';

it('uses the actual visible row and its folder, including drops onto files', () => {
  const tree = document.createElement('div');
  tree.innerHTML =
    '<div data-tree-drop-folder="Notes"></div><div data-tree-drop-folder="Notes/Child"></div>';
  for (const [index, row] of Array.from(tree.children).entries()) {
    row.getBoundingClientRect = () =>
      ({ left: 10, right: 210, top: 100 + index * 30, bottom: 130 + index * 30 }) as DOMRect;
  }
  expect(nativeDropFolderAtPoint(tree, { x: 100, y: 110 })).toBe('Notes');
  expect(nativeDropFolderAtPoint(tree, { x: 100, y: 130 })).toBe('Notes/Child');
  expect(nativeDropFolderAtPoint(tree, { x: 500, y: 130 })).toBeUndefined();
});
