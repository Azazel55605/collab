import type { NoteFile } from '../../types/vault';

export const TREE_ROW_HEIGHT = 28;
export function visibleTreeRows(tree: NoteFile[], collapsed: Set<string>) {
  const rows: Array<{ node: NoteFile; depth: number; position: number; siblings: number }> = [];
  const pending = tree
    .map((node, i) => ({ node, depth: 0, position: i + 1, siblings: tree.length }))
    .reverse();
  while (pending.length) {
    const row = pending.pop()!;
    rows.push(row);
    const children = row.node.children;
    if (children && !collapsed.has(row.node.relativePath)) {
      for (let i = children.length - 1; i >= 0; i--)
        pending.push({
          node: children[i],
          depth: row.depth + 1,
          position: i + 1,
          siblings: children.length,
        });
    }
  }
  return rows;
}
export function treeWindow(count: number, scrollTop: number, height: number, pinnedIndex = -1) {
  const start = Math.max(0, Math.floor(scrollTop / TREE_ROW_HEIGHT) - 8);
  const end = Math.min(count, Math.ceil((scrollTop + height) / TREE_ROW_HEIGHT) + 8);
  const indexes = Array.from({ length: Math.max(0, end - start) }, (_, i) => start + i);
  if (pinnedIndex >= 0 && pinnedIndex < count && !indexes.includes(pinnedIndex))
    indexes.push(pinnedIndex);
  return indexes;
}
