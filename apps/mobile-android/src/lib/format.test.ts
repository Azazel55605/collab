import { describe, expect, it } from 'vitest';

import type { HostedFileEntry } from '../mobileTauri';

import { childrenIndex, childrenOf, fileGlyph, formatBytes, isReadOnlyRole } from './format';

function file(partial: Partial<HostedFileEntry> & { id: string }): HostedFileEntry {
  return {
    parentId: null,
    name: partial.id,
    relativePath: partial.id,
    kind: 'document',
    documentType: null,
    state: 'active',
    updatedAt: null,
    sizeBytes: null,
    contentHash: null,
    revisionSequence: null,
    ...partial,
  };
}

describe('formatBytes', () => {
  it('scales units and handles empty values', () => {
    expect(formatBytes(0)).toBe('—');
    expect(formatBytes(null)).toBe('—');
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(2048)).toBe('2 KB');
    expect(formatBytes(1_500_000)).toBe('1.4 MB');
  });
});

describe('isReadOnlyRole', () => {
  it('is only true for viewers', () => {
    expect(isReadOnlyRole('viewer')).toBe(true);
    expect(isReadOnlyRole('editor')).toBe(false);
    expect(isReadOnlyRole('admin')).toBe(false);
  });
});

describe('fileGlyph', () => {
  it('maps kinds and extensions to glyphs', () => {
    expect(fileGlyph(file({ id: 'f', kind: 'folder', name: 'Notes' }))).toBe('folder');
    expect(fileGlyph(file({ id: 'n', name: 'plan.md' }))).toBe('note');
    expect(fileGlyph(file({ id: 'k', name: 'board.kanban' }))).toBe('kanban');
    expect(fileGlyph(file({ id: 'c', name: 'map.canvas' }))).toBe('canvas');
    expect(fileGlyph(file({ id: 'l', name: 'adder.logic' }))).toBe('logic');
    expect(fileGlyph(file({ id: 'lp', name: 'adder', relativePath: 'Diagrams/adder.logic' }))).toBe(
      'logic',
    );
    expect(fileGlyph(file({ id: 'p', name: 'doc.pdf' }))).toBe('pdf');
    expect(fileGlyph(file({ id: 'i', name: 'pic.png' }))).toBe('image');
    expect(fileGlyph(file({ id: 'x', name: 'data.bin' }))).toBe('file');
  });
});

describe('childrenOf', () => {
  const files = [
    file({ id: 'root-note', name: 'a.md', parentId: null }),
    file({ id: 'folder', name: 'Docs', kind: 'folder', parentId: null }),
    file({ id: 'child', name: 'b.md', parentId: 'folder' }),
  ];

  it('returns folder root children folders-first', () => {
    const root = childrenOf(files, null);
    expect(root.map((f) => f.id)).toEqual(['folder', 'root-note']);
  });

  it('returns nested folder children', () => {
    expect(childrenOf(files, 'folder').map((f) => f.id)).toEqual(['child']);
  });

  it('indexes all parents once for cheap folder lookups', () => {
    const index = childrenIndex(files);
    expect(index.get(null)?.map((f) => f.id)).toEqual(['folder', 'root-note']);
    expect(index.get('folder')?.map((f) => f.id)).toEqual(['child']);
  });
});
