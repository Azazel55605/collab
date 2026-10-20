import type { NoteFile } from '../types/vault';

const indexes = new WeakMap<NoteFile[], VaultTreeIndex>();
export interface VaultTreeIndex {
  all: NoteFile[];
  files: NoteFile[];
  byPath: Map<string, NoteFile>;
  foldedFiles: Map<string, NoteFile>;
  order: Map<NoteFile, number>;
}
/** Immutable tree arrays are the revision token; old trees can be collected. */
export function vaultTreeIndex(tree: NoteFile[]): VaultTreeIndex {
  const cached = indexes.get(tree);
  if (cached) return cached;
  const index: VaultTreeIndex = {
    all: [],
    files: [],
    byPath: new Map(),
    foldedFiles: new Map(),
    order: new Map(),
  };
  const pending = [...tree].reverse();
  while (pending.length) {
    const node = pending.pop()!;
    index.all.push(node);
    index.byPath.set(node.relativePath, node);
    if (!node.isFolder) {
      index.order.set(node, index.files.length);
      index.files.push(node);
      const folded = node.relativePath.toLowerCase();
      if (!index.foldedFiles.has(folded)) index.foldedFiles.set(folded, node);
    }
    if (node.children)
      for (let i = node.children.length - 1; i >= 0; i--) pending.push(node.children[i]);
  }
  indexes.set(tree, index);
  return index;
}

/** Replace only the ancestors of changed entries, preserving sibling identity. */
export function applyTreePaths(
  tree: NoteFile[],
  updates: Array<{ relativePath: string; node: NoteFile | null }>,
): NoteFile[] {
  let result = tree;
  for (const { relativePath, node } of updates) {
    const parts = relativePath.split('/');
    const replace = (siblings: NoteFile[], depth: number): NoteFile[] => {
      const path = parts.slice(0, depth + 1).join('/');
      const position = siblings.findIndex((entry) => entry.relativePath === path);
      if (depth === parts.length - 1) {
        if (position < 0 && !node) return siblings;
        const next = siblings.filter((entry) => entry.relativePath !== path);
        if (node) next.push(node);
        return next;
      }
      if (position < 0) throw new Error('Missing parent requires full reconciliation');
      const parent = siblings[position];
      const children = replace(parent.children ?? [], depth + 1);
      if (children === parent.children) return siblings;
      return siblings.map((entry, i) => (i === position ? { ...parent, children } : entry));
    };
    result = replace(result, 0);
  }
  return result;
}

export function coalescePaths(paths: Iterable<string>): string[] {
  const sorted = [...new Set(paths)].sort();
  const result: string[] = [];
  for (const path of sorted)
    if (!result.some((parent) => path === parent || path.startsWith(`${parent}/`)))
      result.push(path);
  return result;
}
