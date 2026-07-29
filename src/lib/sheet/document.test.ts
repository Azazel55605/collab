import { describe, expect, it } from 'vitest';

import { SHEET_DOCUMENT_KIND, SHEET_LIMITS, SHEET_SCHEMA_VERSION } from '../../types/sheet';
import {
  SheetDocumentError,
  addWorksheet,
  countFormulaCells,
  countPopulatedCells,
  createEmptySheetDocument,
  inspectSheetDocumentText,
  normalizeSheetDocument,
  parseSheetDocument,
  removeWorksheet,
  renameWorksheet,
  serializeSheetDocument,
} from './document';

function baseWorkbook() {
  return {
    kind: SHEET_DOCUMENT_KIND,
    schemaVersion: SHEET_SCHEMA_VERSION,
    id: 'wb1',
    name: 'Book',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    activeWorksheetId: 'ws1',
    worksheets: [{
      id: 'ws1',
      name: 'Sheet1',
      rowOrder: ['r1', 'r2'],
      columnOrder: ['c1', 'c2'],
      cells: {
        'r1:c1': { value: 1, valueType: 'number' },
        'r2:c2': { formula: '=A1+1' },
      },
    }],
    styles: {},
  };
}

describe('createEmptySheetDocument', () => {
  it('creates an editable single-worksheet workbook', () => {
    const document = createEmptySheetDocument('Budget');
    expect(document.kind).toBe(SHEET_DOCUMENT_KIND);
    expect(document.schemaVersion).toBe(SHEET_SCHEMA_VERSION);
    expect(document.name).toBe('Budget');
    expect(document.worksheets).toHaveLength(1);
    expect(document.activeWorksheetId).toBe(document.worksheets[0].id);
    expect(countPopulatedCells(document)).toBe(0);
  });

  it('generates identities that are safe as cell-key components', () => {
    const worksheet = createEmptySheetDocument('Budget').worksheets[0];
    for (const id of [...worksheet.rowOrder, ...worksheet.columnOrder, worksheet.id]) {
      expect(id).not.toContain(':');
      expect(id.length).toBeGreaterThan(0);
    }
    expect(new Set(worksheet.rowOrder).size).toBe(worksheet.rowOrder.length);
  });
});

describe('round trips', () => {
  it('survives serialize -> parse unchanged', () => {
    const document = createEmptySheetDocument('Budget', { timestamp: '2026-01-01T00:00:00.000Z' });
    document.worksheets[0].cells[`${document.worksheets[0].rowOrder[0]}:${document.worksheets[0].columnOrder[0]}`] = {
      value: 'hello',
      valueType: 'text',
    };
    const reparsed = parseSheetDocument(serializeSheetDocument(document));
    expect(reparsed).toEqual(document);
    expect(serializeSheetDocument(reparsed)).toBe(serializeSheetDocument(document));
  });

  it('treats empty content as a new workbook rather than an error', () => {
    const inspection = inspectSheetDocumentText('', 'Fresh');
    expect(inspection.support).toBe('supported');
    expect(inspection.document.name).toBe('Fresh');
    expect(inspection.document.worksheets).toHaveLength(1);
  });

  it('preserves unknown fields at document, worksheet, and cell level', () => {
    const raw = baseWorkbook() as Record<string, unknown>;
    raw.futureTopLevel = { keep: true };
    (raw.worksheets as Record<string, unknown>[])[0].futureWorksheet = 42;
    ((raw.worksheets as Record<string, unknown>[])[0].cells as Record<string, Record<string, unknown>>)['r1:c1'].futureCell = 'x';

    const { document } = normalizeSheetDocument(raw);
    expect((document as unknown as Record<string, unknown>).futureTopLevel).toEqual({ keep: true });
    expect((document.worksheets[0] as unknown as Record<string, unknown>).futureWorksheet).toBe(42);
    expect((document.worksheets[0].cells['r1:c1'] as unknown as Record<string, unknown>).futureCell).toBe('x');
  });
});

describe('malformed input', () => {
  it('rejects non-JSON, non-objects, and the wrong document kind', () => {
    expect(() => inspectSheetDocumentText('{oops')).toThrow(SheetDocumentError);
    expect(() => inspectSheetDocumentText('[]')).toThrowError(/JSON object/);
    expect(() => inspectSheetDocumentText('{"kind":"logic-diagram","schemaVersion":1}'))
      .toThrowError(/collab-sheet/);
  });

  it('rejects a missing or invalid schema version', () => {
    const raw = baseWorkbook() as Record<string, unknown>;
    delete raw.schemaVersion;
    expect(() => normalizeSheetDocument(raw)).toThrowError(/schemaVersion/);

    expect(() => normalizeSheetDocument({ ...baseWorkbook(), schemaVersion: 1.5 }))
      .toThrowError(/schemaVersion/);
  });

  it('repairs rather than discards a workbook with broken identities', () => {
    const raw = baseWorkbook() as Record<string, unknown>;
    const worksheet = (raw.worksheets as Record<string, unknown>[])[0];
    worksheet.rowOrder = ['r1', 'r1', '', 'r:bad'];

    const { document, warnings } = normalizeSheetDocument(raw);
    const ids = document.worksheets[0].rowOrder;
    expect(ids).toHaveLength(4);
    expect(new Set(ids).size).toBe(4);
    expect(ids.every((id) => !id.includes(':'))).toBe(true);
    expect(warnings.join(' ')).toMatch(/row identifier/);
  });

  it('drops cells whose row or column no longer exists', () => {
    const raw = baseWorkbook() as Record<string, unknown>;
    const worksheet = (raw.worksheets as Record<string, unknown>[])[0];
    (worksheet.cells as Record<string, unknown>)['r9:c1'] = { value: 5 };
    (worksheet.cells as Record<string, unknown>)['malformed'] = { value: 5 };

    const { document, warnings } = normalizeSheetDocument(raw);
    expect(Object.keys(document.worksheets[0].cells).sort()).toEqual(['r1:c1', 'r2:c2']);
    expect(warnings.join(' ')).toMatch(/Dropped 2 cell/);
  });

  it('clears references to a missing style without losing the cell', () => {
    const raw = baseWorkbook() as Record<string, unknown>;
    const worksheet = (raw.worksheets as Record<string, unknown>[])[0];
    (worksheet.cells as Record<string, Record<string, unknown>>)['r1:c1'].styleId = 'gone';

    const { document, warnings } = normalizeSheetDocument(raw);
    expect(document.worksheets[0].cells['r1:c1'].value).toBe(1);
    expect(document.worksheets[0].cells['r1:c1'].styleId).toBeUndefined();
    expect(warnings.join(' ')).toMatch(/missing style/);
  });

  it('deduplicates worksheet names and identities', () => {
    const raw = baseWorkbook() as Record<string, unknown>;
    const worksheet = (raw.worksheets as Record<string, unknown>[])[0];
    raw.worksheets = [worksheet, { ...worksheet }];

    const { document } = normalizeSheetDocument(raw);
    expect(new Set(document.worksheets.map((sheet) => sheet.id)).size).toBe(2);
    expect(document.worksheets[1].name).toBe('Sheet1 (2)');
  });

  it('falls back to a worksheet when the workbook has none', () => {
    const { document, warnings } = normalizeSheetDocument({ ...baseWorkbook(), worksheets: [] });
    expect(document.worksheets).toHaveLength(1);
    expect(warnings.join(' ')).toMatch(/had none/);
  });

  it('repoints an activeWorksheetId that does not resolve', () => {
    const { document } = normalizeSheetDocument({ ...baseWorkbook(), activeWorksheetId: 'missing' });
    expect(document.activeWorksheetId).toBe(document.worksheets[0].id);
  });
});

describe('limits', () => {
  it('rejects a workbook with too many worksheets', () => {
    const worksheets = Array.from({ length: SHEET_LIMITS.worksheetsPerWorkbook + 1 }, (_, index) => ({
      id: `ws${index}`,
      name: `Sheet${index}`,
      rowOrder: ['r1'],
      columnOrder: ['c1'],
      cells: {},
    }));
    expect(() => normalizeSheetDocument({ ...baseWorkbook(), worksheets, activeWorksheetId: 'ws0' }))
      .toThrowError(/more than 200 worksheets/);
  });

  it('rejects a worksheet with too many rows', () => {
    const raw = baseWorkbook() as Record<string, unknown>;
    const worksheet = (raw.worksheets as Record<string, unknown>[])[0];
    worksheet.rowOrder = Array.from(
      { length: SHEET_LIMITS.rowsPerWorksheet + 1 },
      (_, index) => `r${index}`,
    );
    expect(() => normalizeSheetDocument(raw)).toThrow(SheetDocumentError);
  });
});

describe('newer schema versions', () => {
  it('reports them as read-only and leaves the document untouched', () => {
    const raw = { ...baseWorkbook(), schemaVersion: SHEET_SCHEMA_VERSION + 1, futureOnly: true };
    const inspection = normalizeSheetDocument(raw);
    expect(inspection.support).toBe('newer');
    expect(inspection.schemaVersion).toBe(SHEET_SCHEMA_VERSION + 1);
    expect(inspection.document as unknown as Record<string, unknown>).toBe(raw);
  });

  it('refuses to hand a newer workbook to an editing caller', () => {
    const text = JSON.stringify({ ...baseWorkbook(), schemaVersion: SHEET_SCHEMA_VERSION + 1 });
    expect(() => parseSheetDocument(text)).toThrowError(/cannot edit/);
  });
});

describe('worksheet operations', () => {
  it('adds worksheets with non-colliding names', () => {
    let document = createEmptySheetDocument('Book');
    document = addWorksheet(document, 'Sheet1');
    expect(document.worksheets.map((sheet) => sheet.name)).toEqual(['Sheet1', 'Sheet1 (2)']);
    expect(document.activeWorksheetId).toBe(document.worksheets[1].id);
  });

  it('renames a worksheet and rejects duplicates and empty names', () => {
    let document = addWorksheet(createEmptySheetDocument('Book'), 'Data');
    document = renameWorksheet(document, document.worksheets[0].id, 'Summary');
    expect(document.worksheets[0].name).toBe('Summary');
    expect(() => renameWorksheet(document, document.worksheets[0].id, 'Data')).toThrowError(/already has/);
    expect(() => renameWorksheet(document, document.worksheets[0].id, '   ')).toThrowError(/cannot be empty/);
  });

  it('removes a worksheet, repoints the active one, and keeps at least one', () => {
    let document = addWorksheet(createEmptySheetDocument('Book'), 'Data');
    const removedId = document.worksheets[1].id;
    document = removeWorksheet(document, removedId);
    expect(document.worksheets).toHaveLength(1);
    expect(document.activeWorksheetId).toBe(document.worksheets[0].id);
    expect(() => removeWorksheet(document, document.worksheets[0].id)).toThrowError(/at least one/);
  });

  it('drops named ranges belonging to a removed worksheet', () => {
    let document = addWorksheet(createEmptySheetDocument('Book'), 'Data');
    const target = document.worksheets[1];
    document.namedRanges = [{
      id: 'n1',
      name: 'Totals',
      worksheetId: target.id,
      range: {
        startRowId: target.rowOrder[0],
        startColumnId: target.columnOrder[0],
        endRowId: target.rowOrder[0],
        endColumnId: target.columnOrder[0],
      },
    }];
    document = removeWorksheet(document, target.id);
    expect(document.namedRanges).toBeUndefined();
  });
});

describe('counts', () => {
  it('reports populated and formula cells', () => {
    const { document } = normalizeSheetDocument(baseWorkbook());
    expect(countPopulatedCells(document)).toBe(2);
    expect(countFormulaCells(document)).toBe(1);
  });
});
