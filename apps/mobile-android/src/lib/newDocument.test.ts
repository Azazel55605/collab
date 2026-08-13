import { describe, expect, it } from 'vitest';

import { inspectInkContent } from './ink';
import { inspectSheetContent } from './sheet';
import { parseBoardContent } from './kanban';
import {
  NEW_DOCUMENT_TYPES,
  newDocumentBaseName,
  newDocumentFileName,
  newDocumentType,
} from './newDocument';

describe('NEW_DOCUMENT_TYPES', () => {
  it('offers exactly the types with a fully editable mobile screen', () => {
    // Creating a document the app can then only stare at is worse than not
    // offering it: `.canvas` and `.logic` open read-only on mobile.
    expect(NEW_DOCUMENT_TYPES.map((type) => type.kind)).toEqual([
      'note',
      'kanban',
      'sheet',
      'ink',
    ]);
  });

  it('gives every type a distinct extension and hosted document type', () => {
    const extensions = NEW_DOCUMENT_TYPES.map((type) => type.extension);
    expect(new Set(extensions).size).toBe(extensions.length);
    for (const type of NEW_DOCUMENT_TYPES) {
      expect(type.documentType).toBeTruthy();
      expect(type.label).toBeTruthy();
      expect(type.glyph).toBeTruthy();
    }
  });

  it('opens each new document in its own editor', () => {
    const opened = NEW_DOCUMENT_TYPES.map((type) => type.open('file-1'));
    expect(opened.map((sheet) => sheet && sheet.kind)).toEqual([
      'note',
      'kanban',
      'workbook',
      'drawing',
    ]);
  });
});

describe('initial content', () => {
  it('produces a document each editor can actually open', () => {
    // A new file that its own editor must refuse is the worst possible first
    // impression, so every type's starting content is parsed here.
    expect(newDocumentType('note').initialContent('Notes')).toBe('');

    const board = parseBoardContent(newDocumentType('kanban').initialContent('Board'));
    expect(board.columns.map((column) => column.title)).toEqual([
      'To do',
      'In progress',
      'Done',
    ]);

    const workbook = inspectSheetContent(
      newDocumentType('sheet').initialContent('Budget'),
      'Budget',
    );
    expect(workbook.support).toBe('supported');
    expect(workbook.document.worksheets.length).toBeGreaterThan(0);

    const drawing = inspectInkContent(newDocumentType('ink').initialContent('Ideas'));
    expect(drawing.support).toBe('supported');
    expect(drawing.warnings).toEqual([]);
    expect(drawing.document.pageOrder.length).toBe(1);
  });

  it('gives a new board columns, so there is somewhere to put a card', () => {
    const board = parseBoardContent(newDocumentType('kanban').initialContent('B'));
    expect(board.columns.length).toBeGreaterThan(0);
    expect(new Set(board.columns.map((column) => column.id)).size).toBe(board.columns.length);
  });

  it('names the document from what the user typed', () => {
    const drawing = inspectInkContent(newDocumentType('ink').initialContent('Sketchbook'));
    expect(drawing.document.name).toBe('Sketchbook');
  });
});

describe('newDocumentFileName', () => {
  it('adds the type extension', () => {
    expect(newDocumentFileName('note', 'Plan')).toBe('Plan.md');
    expect(newDocumentFileName('kanban', 'Roadmap')).toBe('Roadmap.kanban');
    expect(newDocumentFileName('sheet', 'Budget')).toBe('Budget.sheet');
    expect(newDocumentFileName('ink', 'Ideas')).toBe('Ideas.ink');
  });

  it('does not double an extension the user already typed', () => {
    expect(newDocumentFileName('note', 'Plan.md')).toBe('Plan.md');
    expect(newDocumentFileName('ink', 'Ideas.INK')).toBe('Ideas.INK');
  });

  it('keeps a dotted name intact rather than treating it as an extension', () => {
    // `report.2026` must not become `report.sheet`.
    expect(newDocumentFileName('sheet', 'report.2026')).toBe('report.2026.sheet');
  });

  it('trims and rejects an empty name', () => {
    expect(newDocumentFileName('note', '  Plan  ')).toBe('Plan.md');
    expect(() => newDocumentFileName('note', '   ')).toThrow(/note name/i);
    expect(() => newDocumentFileName('ink', '')).toThrow(/drawing name/i);
  });
});

describe('newDocumentBaseName', () => {
  it('strips the extension the file name carries', () => {
    expect(newDocumentBaseName('ink', 'Ideas.ink')).toBe('Ideas');
    expect(newDocumentBaseName('sheet', 'Budget.SHEET')).toBe('Budget');
    expect(newDocumentBaseName('note', 'Plan')).toBe('Plan');
  });
});

describe('newDocumentType', () => {
  it('throws for an unknown kind rather than returning undefined', () => {
    expect(() => newDocumentType('canvas' as never)).toThrow(/Unknown document type/);
  });
});
