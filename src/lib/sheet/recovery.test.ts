/**
 * Phase 9 recovery matrix for `.sheet`.
 *
 * Covers the paths a workbook takes when something goes wrong between one
 * session and the next: autosave and reload, an unsynced edit surviving a
 * crash, a workbook written by a newer build, and a revision conflict. The
 * encryption half is native — the replica store encrypts cached content and
 * pending operations at rest (`src-tauri/src/replica/`), and `.sheet` inherits
 * that without a document-format opinion.
 */

import { describe, expect, it } from 'vitest';

import { sheetCellKey } from '../../types/sheet';
import { mergeSheetDocuments } from './collaboration';
import {
  SheetDocumentError,
  inspectSheetDocumentText,
  parseSheetDocument,
  serializeSheetDocument,
} from './document';
import { createDenseWorkbookFixture, createWorkbookFixture } from './fixture';
import { setCell } from './operations';

function workbook() {
  return createWorkbookFixture({ rows: 4, columns: 4, populatedRows: 2, populatedColumns: 2 });
}

describe('autosave and reload', () => {
  it('reloads exactly what it saved', () => {
    const document = createDenseWorkbookFixture(30, 8);
    const reloaded = parseSheetDocument(serializeSheetDocument(document));
    expect(serializeSheetDocument(reloaded)).toBe(serializeSheetDocument(document));
  });

  it('produces identical bytes for an unchanged workbook', () => {
    // Autosave must not churn revisions: saving twice without an edit has to
    // yield the same content, or every reload would create vault history.
    const document = workbook();
    expect(serializeSheetDocument(document)).toBe(serializeSheetDocument(document));
    const reloaded = parseSheetDocument(serializeSheetDocument(document));
    expect(serializeSheetDocument(reloaded)).toBe(serializeSheetDocument(document));
  });

  it('never persists a computed formula result', () => {
    // Formula source is authoritative. A cached value in the file would become
    // a second source of truth that survives a recovery with stale numbers.
    let document = workbook();
    document = setCell(document, 'ws1', { row: 3, column: 3 }, { formula: '=A1+B1' });
    const text = serializeSheetDocument(document);

    expect(text).toContain('"formula": "=A1+B1"');
    const cell = parseSheetDocument(text).worksheets[0].cells[sheetCellKey('r4', 'c4')];
    expect(cell.formula).toBe('=A1+B1');
    expect(cell.value).toBeUndefined();
  });
});

describe('crash recovery', () => {
  it('keeps an unsynced local edit when the server moved on', () => {
    // The replica keeps the last synced revision as the merge base, so an edit
    // made before the crash is replayed against the newer server revision
    // rather than being dropped or overwriting it.
    const base = workbook();
    const local = structuredClone(base);
    const server = structuredClone(base);
    local.worksheets[0].cells[sheetCellKey('r3', 'c1')] = { value: 'unsynced', valueType: 'text' };
    server.worksheets[0].cells[sheetCellKey('r1', 'c3')] = { value: 'server', valueType: 'text' };

    const result = mergeSheetDocuments(base, local, server);

    expect(result.conflicts).toEqual([]);
    expect(result.document.worksheets[0].cells[sheetCellKey('r3', 'c1')]?.value).toBe('unsynced');
    expect(result.document.worksheets[0].cells[sheetCellKey('r1', 'c3')]?.value).toBe('server');
  });

  it('recovers a partially written file as a reportable failure, not an empty workbook', () => {
    const text = serializeSheetDocument(workbook());
    const truncated = text.slice(0, Math.floor(text.length / 2));

    // Silently opening a blank grid here would let the next autosave overwrite
    // the recoverable bytes still on disk.
    expect(() => parseSheetDocument(truncated)).toThrow(SheetDocumentError);
  });
});

describe('schema upgrade', () => {
  it('opens a newer-schema workbook read-only instead of downgrading it', () => {
    const newer = JSON.stringify({ ...workbook(), schemaVersion: 99 });
    const inspection = inspectSheetDocumentText(newer);

    expect(inspection.support).toBe('newer');
    expect(() => parseSheetDocument(newer)).toThrow(SheetDocumentError);
  });

  it('preserves fields a newer build added, at every level', () => {
    const source = workbook() as unknown as Record<string, unknown>;
    source.futureWorkbookField = { note: 'from a later build' };
    const worksheet = (source.worksheets as Record<string, unknown>[])[0];
    worksheet.futureWorksheetField = ['keep', 'me'];
    (worksheet.cells as Record<string, Record<string, unknown>>)[sheetCellKey('r1', 'c1')]
      .futureCellField = 42;

    const round = parseSheetDocument(JSON.stringify(source)) as unknown as Record<string, unknown>;
    const roundWorksheet = (round.worksheets as Record<string, unknown>[])[0];

    expect(round.futureWorkbookField).toEqual({ note: 'from a later build' });
    expect(roundWorksheet.futureWorksheetField).toEqual(['keep', 'me']);
    expect(
      (roundWorksheet.cells as Record<string, Record<string, unknown>>)[sheetCellKey('r1', 'c1')]
        .futureCellField,
    ).toBe(42);
  });
});

describe('revision conflict', () => {
  it('reports an overlapping edit rather than silently picking a winner', () => {
    const base = workbook();
    const local = structuredClone(base);
    const remote = structuredClone(base);
    local.worksheets[0].cells[sheetCellKey('r1', 'c1')] = { value: 'mine', valueType: 'text' };
    remote.worksheets[0].cells[sheetCellKey('r1', 'c1')] = { value: 'theirs', valueType: 'text' };

    const result = mergeSheetDocuments(base, local, remote);

    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0].kind).toBe('overlapping-edit');
    // The path pinpoints the field, so the recovery UI can show what differs.
    expect(result.conflicts[0].path).toBe('/worksheets/ws1/cells/r1:c1/value');
    // A conflict still yields an openable workbook so the user can review it.
    expect(() => parseSheetDocument(serializeSheetDocument(result.document))).not.toThrow();
  });

  it('reports a structural conflict when a peer removed the worksheet being edited', () => {
    const base = workbook();
    const local = structuredClone(base);
    const remote = structuredClone(base);
    local.worksheets[0].cells[sheetCellKey('r1', 'c1')] = { value: 'edited', valueType: 'text' };
    remote.worksheets = [];

    const result = mergeSheetDocuments(base, local, remote);

    expect(result.conflicts.some((conflict) => conflict.kind === 'deleted-target')).toBe(true);
  });
});
