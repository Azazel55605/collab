import { describe, expect, it } from 'vitest';

import {
  dedupeNestedSelection,
  describeIncompatibility,
  findIncompatibleFiles,
  isOpenableInApp,
} from './compatibility';
import type { HostedFileEntry } from './types';

function entry(overrides: Partial<HostedFileEntry> & { name: string }): HostedFileEntry {
  return {
    id: overrides.name,
    parentId: null,
    relativePath: overrides.name,
    kind: 'asset',
    documentType: null,
    state: 'active',
    currentRevision: null,
    createdAt: '2026-06-09T00:00:00Z',
    updatedAt: '2026-06-10T00:00:00Z',
    ...overrides,
    name: overrides.name,
  } as HostedFileEntry;
}

describe('vault entry compatibility', () => {
  it('treats folders and every editor-backed document as openable', () => {
    expect(isOpenableInApp(entry({ name: 'Notes', kind: 'folder' }))).toBe(true);
    for (const name of ['a.md', 'b.kanban', 'c.canvas', 'd.logic', 'e.sheet', 'f.svg']) {
      expect(isOpenableInApp(entry({ name, kind: 'document' }))).toBe(true);
    }
  });

  it('treats images and PDFs as openable assets', () => {
    for (const name of ['a.png', 'b.JPG', 'c.jpeg', 'd.gif', 'e.webp', 'f.avif', 'g.pdf']) {
      expect(isOpenableInApp(entry({ name }))).toBe(true);
    }
  });

  it('flags assets no client can open, and says why', () => {
    const archive = entry({ name: 'backup.zip' });
    expect(isOpenableInApp(archive)).toBe(false);
    expect(describeIncompatibility(archive)).toContain('.zip');

    const extensionless = entry({ name: 'LICENSE' });
    expect(isOpenableInApp(extensionless)).toBe(false);
    expect(describeIncompatibility(extensionless)).toContain('No file extension');

    // A document the server did classify stays openable even if the extension
    // list has not caught up.
    const classified = entry({ name: 'notes.unknown', kind: 'document', documentType: 'note' });
    expect(isOpenableInApp(classified)).toBe(true);
    expect(describeIncompatibility(classified)).toBeNull();
  });

  it('lists only active non-folder entries, largest first', () => {
    const revision = (sizeBytes: number) => ({
      id: 'r',
      sequence: 1,
      contentHash: 'h',
      sizeBytes,
      createdByDisplayName: 'Owner',
      createdAt: '2026-06-10T00:00:00Z',
    });
    const files = [
      entry({ name: 'small.zip', currentRevision: revision(10) }),
      entry({ name: 'big.mp4', currentRevision: revision(9_000) }),
      entry({ name: 'keep.png', currentRevision: revision(50) }),
      entry({ name: 'gone.zip', state: 'trashed', currentRevision: revision(999) }),
      entry({ name: 'Folder', kind: 'folder' }),
    ];

    expect(findIncompatibleFiles(files).map((file) => file.name)).toEqual(['big.mp4', 'small.zip']);
  });

  it('drops selected descendants of a selected folder', () => {
    const files = [
      entry({ name: 'Docs', id: 'folder', kind: 'folder' }),
      entry({ name: 'Deep', id: 'nested', kind: 'folder', parentId: 'folder' }),
      entry({ name: 'a.zip', id: 'child', parentId: 'nested' }),
      entry({ name: 'b.zip', id: 'loose' }),
    ];

    // Trashing the folder already takes the subtree, so only the folder and the
    // unrelated file are acted on.
    const result = dedupeNestedSelection(files, new Set(['folder', 'nested', 'child', 'loose']));
    expect(result.map((file) => file.id)).toEqual(['folder', 'loose']);

    // Without the ancestor selected, the descendant survives on its own.
    expect(dedupeNestedSelection(files, new Set(['child'])).map((file) => file.id)).toEqual([
      'child',
    ]);
  });

  it('does not loop on a cyclic parent chain', () => {
    const files = [
      entry({ name: 'a', id: 'a', kind: 'folder', parentId: 'b' }),
      entry({ name: 'b', id: 'b', kind: 'folder', parentId: 'a' }),
    ];
    expect(dedupeNestedSelection(files, new Set(['a'])).map((file) => file.id)).toEqual(['a']);
  });
});
