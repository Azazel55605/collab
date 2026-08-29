import { describe, expect, it } from 'vitest';

import type { NoteFile } from '../types/vault';

import { reconcileFileTreeIdentity } from './fileTreeIdentity';

function file(path: string, modifiedAt = 1, size = 10): NoteFile {
  return {
    relativePath: path,
    name: path.split('/').pop()!,
    extension: 'md',
    modifiedAt,
    size,
    isFolder: false,
  };
}

function folder(path: string, children: NoteFile[]): NoteFile {
  return {
    relativePath: path,
    name: path.split('/').pop()!,
    extension: '',
    modifiedAt: 1,
    size: 0,
    isFolder: true,
    children,
  };
}

/** A fresh tree with identical content, as `listFiles` returns after a refresh. */
function rebuild(nodes: NoteFile[]): NoteFile[] {
  return nodes.map((node) =>
    node.children ? { ...node, children: rebuild(node.children) } : { ...node },
  );
}

describe('file tree identity reconciliation', () => {
  it('reuses the previous tree when nothing changed', () => {
    const previous = [folder('Docs', [file('Docs/a.md'), file('Docs/b.md')]), file('root.md')];

    expect(reconcileFileTreeIdentity(previous, rebuild(previous))).toBe(previous);
  });

  it('gives new identity only to the changed node and its ancestors', () => {
    const previous = [
      folder('Docs', [
        folder('Docs/Deep', [file('Docs/Deep/a.md'), file('Docs/Deep/b.md')]),
        file('Docs/c.md'),
      ]),
      folder('Other', [file('Other/x.md')]),
    ];
    const next = rebuild(previous);
    next[0].children![0].children![1] = file('Docs/Deep/b.md', 2, 40);

    const result = reconcileFileTreeIdentity(previous, next);

    // The untouched sibling subtree keeps its identity, so its rows never
    // re-render.
    expect(result[1]).toBe(previous[1]);
    // The changed file and every ancestor of it are new, so those rows do.
    expect(result[0]).not.toBe(previous[0]);
    expect(result[0].children![0]).not.toBe(previous[0].children![0]);
    expect(result[0].children![0].children![1]).not.toBe(previous[0].children![0].children![1]);
    // Its unchanged sibling inside the same folder is still reused.
    expect(result[0].children![0].children![0]).toBe(previous[0].children![0].children![0]);
    expect(result[0].children![1]).toBe(previous[0].children![1]);
  });

  it('reflects added, removed, and renamed entries', () => {
    const previous = [folder('Docs', [file('Docs/a.md'), file('Docs/b.md')])];

    const added = reconcileFileTreeIdentity(previous, [
      folder('Docs', [file('Docs/a.md'), file('Docs/b.md'), file('Docs/c.md')]),
    ]);
    expect(added[0].children).toHaveLength(3);
    expect(added[0]).not.toBe(previous[0]);

    const removed = reconcileFileTreeIdentity(previous, [folder('Docs', [file('Docs/a.md')])]);
    expect(removed[0].children).toHaveLength(1);

    const renamed = reconcileFileTreeIdentity(previous, [
      folder('Docs', [file('Docs/a.md'), file('Docs/renamed.md')]),
    ]);
    expect(renamed[0].children![1].relativePath).toBe('Docs/renamed.md');
  });

  it('does not confuse a file with a folder at the same path', () => {
    const previous = [file('Notes')];
    const next = [folder('Notes', [file('Notes/a.md')])];

    const result = reconcileFileTreeIdentity(previous, next);

    expect(result[0].isFolder).toBe(true);
    expect(result[0].children).toHaveLength(1);
  });

  it('handles an empty previous tree and an emptied tree', () => {
    const next = [file('a.md')];
    expect(reconcileFileTreeIdentity(undefined, next)).toBe(next);
    expect(reconcileFileTreeIdentity([], next)).toBe(next);
    expect(reconcileFileTreeIdentity(next, [])).toEqual([]);
  });

  /**
   * The filesystem watcher refreshes the tree after every write, including the
   * autosave a note produces while typing. Reconciling a large vault has to stay
   * far cheaper than re-rendering it, or the optimization pays for itself twice.
   */
  it('reconciles a large vault well inside the watcher budget', () => {
    const build = () =>
      Array.from({ length: 48 }, (_, index) =>
        folder(
          `Folder${index}`,
          Array.from({ length: 32 }, (_, child) => file(`Folder${index}/note${child}.md`)),
        ),
      );
    const previous = build();

    const started = performance.now();
    const result = reconcileFileTreeIdentity(previous, build());
    const elapsed = performance.now() - started;

    expect(result).toBe(previous);
    // Generous ceiling: the measured cost is well under a millisecond, so an
    // ordinary slow machine passes and an order-of-magnitude regression fails.
    expect(elapsed).toBeLessThan(50);
  });
});
