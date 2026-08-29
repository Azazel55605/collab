import { describe, expect, it } from 'vitest';

import type { NoteFile } from '../types/vault';

import { isTextDocumentPath, nextAvailableCopyPath } from './vaultDuplicate';

function file(relativePath: string): NoteFile {
  return {
    relativePath,
    name: relativePath.split('/').pop() ?? relativePath,
    extension: relativePath.split('.').pop() ?? '',
    modifiedAt: 0,
    size: 1,
    isFolder: false,
  };
}

describe('isTextDocumentPath', () => {
  it('accepts text-backed document types and rejects binary assets', () => {
    for (const path of [
      'a.md',
      'a.canvas',
      'a.kanban',
      'a.logic',
      'a.sheet',
      'a.svg',
      'Docs/B.SHEET',
    ]) {
      expect(isTextDocumentPath(path)).toBe(true);
    }
    for (const path of ['a.png', 'a.pdf', 'a', 'a.zip']) {
      expect(isTextDocumentPath(path)).toBe(false);
    }
  });
});

describe('nextAvailableCopyPath', () => {
  it('appends "copy" beside the source, keeping the extension', () => {
    expect(nextAvailableCopyPath('Docs/budget.sheet', [])).toBe('Docs/budget copy.sheet');
    expect(nextAvailableCopyPath('notes.md', [])).toBe('notes copy.md');
  });

  it('counts up past existing copies, case-insensitively', () => {
    const existing = [file('Docs/budget copy.sheet'), file('Docs/Budget Copy 2.sheet')];
    expect(nextAvailableCopyPath('Docs/budget.sheet', existing)).toBe('Docs/budget copy 3.sheet');
  });

  it('handles names without an extension', () => {
    expect(nextAvailableCopyPath('Docs/README', [])).toBe('Docs/README copy');
  });
});
