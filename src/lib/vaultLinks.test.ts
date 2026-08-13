import { describe, expect, it } from 'vitest';

import {
  buildVaultLinkInsertText,
  getVaultDocumentTabType,
  getVaultDocumentView,
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
        relativePath: 'Docs/budget.sheet',
        name: 'budget.sheet',
        extension: 'sheet',
        modifiedAt: 0,
        size: 1,
        isFolder: false,
      },
      {
        relativePath: 'Docs/adder.logic',
        name: 'adder.logic',
        extension: 'logic',
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

  it('resolves vault-relative markdown links to logic diagrams', () => {
    expect(resolveVaultRelativeLinkTarget('../Docs/adder.logic', 'Notes/alpha.md', FILES)).toEqual({
      relativePath: 'Docs/adder.logic',
      title: 'adder',
      type: 'logic',
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

  it('offers PDF, Kanban, and logic files in wikilink autocomplete but excludes images', () => {
    const items = getVaultWikilinkAutocompleteItems(FILES);
    expect(items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ label: 'alpha', insertText: 'Notes/alpha.md' }),
        expect.objectContaining({ label: 'spec.pdf', insertText: 'Docs/spec.pdf' }),
        expect.objectContaining({ label: 'board.kanban', insertText: 'Docs/board.kanban' }),
        expect.objectContaining({ label: 'adder.logic', insertText: 'Docs/adder.logic' }),
      ]),
    );
    expect(items.some((item) => item.label === 'diagram.png')).toBe(false);
  });

  it('builds markdown path links for non-note vault files', () => {
    expect(buildVaultLinkInsertText('Docs/spec.pdf', 'Notes/alpha.md', FILES)).toBe('[spec](../Docs/spec.pdf)');
  });

  it('builds note slash-links with full vault paths and readable aliases', () => {
    expect(buildVaultLinkInsertText('Notes/beta.md', 'Docs/spec.pdf', FILES)).toBe('[[Notes/beta.md|beta]]');
    expect(buildVaultLinkInsertText('Docs/alpha.md', 'Notes/alpha.md', FILES)).toBe('[[Docs/alpha.md|alpha]]');
  });

  it('keeps unique note autocomplete items as stems and duplicate notes as full paths', () => {
    const items = getVaultWikilinkAutocompleteItems(FILES);
    expect(items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ label: 'beta', insertText: 'beta' }),
        expect.objectContaining({ label: 'alpha', detail: 'Notes', insertText: 'Notes/alpha.md' }),
        expect.objectContaining({ label: 'alpha', detail: 'Docs', insertText: 'Docs/alpha.md' }),
      ]),
    );
  });
});

describe('ink drawings', () => {
  it('routes .ink paths to the ink tab type', () => {
    expect(getVaultDocumentTabType('Sketches/idea.ink')).toBe('ink');
    expect(getVaultDocumentTabType('Sketches/IDEA.INK')).toBe('ink');
    expect(getVaultDocumentView('ink')).toBe('editor');
  });

  it('does not confuse an .ink drawing with an .svg vector file', () => {
    // Both are drawings; only one is the editable ink document.
    expect(getVaultDocumentTabType('Sketches/idea.svg')).toBe('image');
    expect(getVaultDocumentTabType('Sketches/idea.ink')).toBe('ink');
  });
});

describe('spreadsheet documents', () => {
  it('routes .sheet paths to the sheet tab type', () => {
    expect(getVaultDocumentTabType('Docs/budget.sheet')).toBe('sheet');
    expect(getVaultDocumentTabType('Docs/BUDGET.SHEET')).toBe('sheet');
    expect(getVaultDocumentView('sheet')).toBe('editor');
  });

  it('resolves markdown links to spreadsheets', () => {
    expect(resolveVaultRelativeLinkTarget('../Docs/budget.sheet', 'Notes/alpha.md', FILES)).toEqual({
      relativePath: 'Docs/budget.sheet',
      title: 'budget',
      type: 'sheet',
    });
  });

  it('labels spreadsheets in wikilink autocomplete', () => {
    const items = getVaultWikilinkAutocompleteItems(FILES);
    expect(items).toContainEqual(
      expect.objectContaining({ label: 'budget.sheet', insertText: 'Docs/budget.sheet', detail: 'Docs · Spreadsheet' }),
    );
  });
});
