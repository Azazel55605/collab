import { describe, expect, it } from 'vitest';

import {
  buildVaultLinkInsertText,
  getVaultWikilinkAutocompleteItems,
  resolveVaultRelativeLinkTarget,
  resolveVaultWikilinkTarget,
} from './vaultLinks';
import type { NoteFile } from '../types/vault';

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
        relativePath: 'Notes/alpha.md',
        name: 'alpha.md',
        extension: 'md',
        modifiedAt: 0,
        size: 1,
        isFolder: false,
      },
      {
        relativePath: 'Notes/beta.md',
        name: 'beta.md',
        extension: 'md',
        modifiedAt: 0,
        size: 1,
        isFolder: false,
      },
    ],
  },
  {
    relativePath: 'Docs',
    name: 'Docs',
    extension: '',
    modifiedAt: 0,
    size: 0,
    isFolder: true,
    children: [
      {
        relativePath: 'Docs/spec.pdf',
        name: 'spec.pdf',
        extension: 'pdf',
        modifiedAt: 0,
        size: 1,
        isFolder: false,
      },
      {
        relativePath: 'Docs/board.kanban',
        name: 'board.kanban',
        extension: 'kanban',
        modifiedAt: 0,
        size: 1,
        isFolder: false,
      },
      {
        relativePath: 'Docs/diagram.png',
        name: 'diagram.png',
        extension: 'png',
        modifiedAt: 0,
        size: 1,
        isFolder: false,
      },
      {
        relativePath: 'Docs/alpha.md',
        name: 'alpha.md',
        extension: 'md',
        modifiedAt: 0,
        size: 1,
        isFolder: false,
      },
    ],
  },
];

describe('vaultLinks', () => {
  it('resolves vault-relative markdown links to PDFs', () => {
    expect(resolveVaultRelativeLinkTarget('../Docs/spec.pdf', 'Notes/alpha.md', FILES)).toEqual({
      relativePath: 'Docs/spec.pdf',
      title: 'spec',
      type: 'pdf',
    });
  });

  it('resolves wikilinks to PDFs by file name', () => {
    expect(resolveVaultWikilinkTarget('spec.pdf', FILES)).toEqual({
      relativePath: 'Docs/spec.pdf',
      title: 'spec',
      type: 'pdf',
    });
  });

  it('keeps note stem wikilinks working', () => {
    expect(resolveVaultWikilinkTarget('alpha', FILES)).toEqual({
      relativePath: 'Notes/alpha.md',
      title: 'alpha',
      type: 'note',
    });
  });

  it('offers PDF and Kanban files in wikilink autocomplete but excludes images', () => {
    const items = getVaultWikilinkAutocompleteItems(FILES);
    expect(items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ label: 'alpha', insertText: 'alpha' }),
        expect.objectContaining({ label: 'spec.pdf', insertText: 'Docs/spec.pdf' }),
        expect.objectContaining({ label: 'board.kanban', insertText: 'Docs/board.kanban' }),
      ]),
    );
    expect(items.some((item) => item.label === 'diagram.png')).toBe(false);
  });

  it('builds markdown path links for non-note vault files', () => {
    expect(buildVaultLinkInsertText('Docs/spec.pdf', 'Notes/alpha.md', FILES)).toBe('[spec](../Docs/spec.pdf)');
  });

  it('keeps unique notes as stem wikilinks and falls back to full paths for duplicates', () => {
    expect(buildVaultLinkInsertText('Notes/beta.md', 'Docs/spec.pdf', FILES)).toBe('[[beta]]');
    expect(buildVaultLinkInsertText('Docs/alpha.md', 'Notes/alpha.md', FILES)).toBe('[[Docs/alpha.md]]');
  });
});
