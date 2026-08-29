import { describe, expect, it } from 'vitest';

import type { NoteFile } from '../types/vault';

import { resolveNoteAssetTarget } from './noteAssets';

const FILES: NoteFile[] = [
  {
    relativePath: 'Notes',
    name: 'Notes',
    extension: '',
    modifiedAt: 0,
    size: 0,
    isFolder: true,
    children: [
      {
        relativePath: 'Notes/local.png',
        name: 'local.png',
        extension: 'png',
        modifiedAt: 0,
        size: 0,
        isFolder: false,
      },
    ],
  },
  {
    relativePath: 'Pictures',
    name: 'Pictures',
    extension: '',
    modifiedAt: 0,
    size: 0,
    isFolder: true,
    children: [
      {
        relativePath: 'Pictures/Transformierte Struktur.png',
        name: 'Transformierte Struktur.png',
        extension: 'png',
        modifiedAt: 0,
        size: 0,
        isFolder: false,
      },
    ],
  },
];

describe('resolveNoteAssetTarget', () => {
  it('prefers an exact vault file match for wrapped image paths with spaces', () => {
    expect(
      resolveNoteAssetTarget('<Pictures/Transformierte Struktur.png>', 'Notes/demo.md', FILES),
    ).toEqual({
      kind: 'vault',
      value: 'Pictures/Transformierte Struktur.png',
    });
  });

  it('treats local image paths as vault-root-relative by default', () => {
    expect(resolveNoteAssetTarget('Folder/example.png', 'Notes/Sub/demo.md')).toEqual({
      kind: 'vault',
      value: 'Folder/example.png',
    });
  });

  it('resolves note-relative image paths when the vault file exists', () => {
    expect(resolveNoteAssetTarget('local.png', 'Notes/demo.md', FILES)).toEqual({
      kind: 'vault',
      value: 'Notes/local.png',
    });
  });

  it('normalizes parent segments while staying rooted at the vault', () => {
    expect(resolveNoteAssetTarget('../Pictures/example.png', 'Notes/Sub/demo.md')).toEqual({
      kind: 'vault',
      value: 'Pictures/example.png',
    });
  });
});
