import type { NoteFile } from '../types/vault';

/**
 * Rebuilds a file tree so unchanged nodes keep their previous object identity.
 *
 * `listFiles` returns a brand-new tree on every read, and the filesystem watcher
 * triggers one after every file change — including the autosave a note write
 * produces while typing. Because every node object was new, the whole sidebar
 * tree re-rendered each time, which on a large vault is hundreds of milliseconds
 * of work for a tree that usually did not change at all.
 *
 * Preserving identity lets the memoized rows skip re-rendering: only the nodes
 * that actually changed, and their ancestors, get new objects. A folder keeps
 * its previous identity only when its own fields *and* every descendant are
 * unchanged, so a change deep in a subtree still propagates to the rows that
 * need to re-render.
 *
 * Both trees are assumed to be in the same sort order, which
 * `sortFileTreeAlphabetically` guarantees.
 */
export function reconcileFileTreeIdentity(
  previous: NoteFile[] | undefined,
  next: NoteFile[],
): NoteFile[] {
  if (!previous?.length) return next;
  const previousByPath = new Map(previous.map((node) => [node.relativePath, node]));

  let changed = previous.length !== next.length;
  const reconciled = next.map((node, index) => {
    const before = previousByPath.get(node.relativePath);
    const merged = reconcileNode(before, node);
    if (merged !== previous[index]) changed = true;
    return merged;
  });
  // The sibling list itself is reused when nothing in it moved or changed, so an
  // untouched folder's `children` array keeps its identity too.
  return changed ? reconciled : previous;
}

function reconcileNode(previous: NoteFile | undefined, next: NoteFile): NoteFile {
  if (!previous || !sameNodeFields(previous, next)) {
    return next.children
      ? { ...next, children: reconcileFileTreeIdentity(previous?.children, next.children) }
      : next;
  }
  if (!next.children) {
    // A folder that lost its children, or a file: identical fields and no
    // children on either side means the previous object still describes it.
    return previous.children ? next : previous;
  }
  const children = reconcileFileTreeIdentity(previous.children, next.children);
  return children === previous.children ? previous : { ...next, children };
}

function sameNodeFields(left: NoteFile, right: NoteFile): boolean {
  return (
    left.relativePath === right.relativePath
    && left.name === right.name
    && left.extension === right.extension
    && left.modifiedAt === right.modifiedAt
    && left.size === right.size
    && left.isFolder === right.isFolder
  );
}
