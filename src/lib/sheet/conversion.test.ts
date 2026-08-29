import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { SheetFormulaValueMap } from '../../types/sheetFormula';
import { sheetFormulaResultKey } from '../../types/sheetFormula';
import type { NoteFile } from '../../types/vault';
import type { VaultClient } from '../vaultClient';

import {
  computedValuesForExport,
  defaultExportFileName,
  exportWorkbookFile,
  importWorkbookFile,
  nextAvailableWorkbookPath,
} from './conversion';
import { createWorkbookFixture } from './fixture';
import { setCell } from './operations';

const sheetConvertImport = vi.fn();
const sheetConvertExport = vi.fn();
const showDownloadDialog = vi.fn();

vi.mock('../tauri', () => ({
  tauriCommands: {
    sheetConvertImport: (...args: unknown[]) => sheetConvertImport(...args),
    sheetConvertExport: (...args: unknown[]) => sheetConvertExport(...args),
    showDownloadDialog: (...args: unknown[]) => showDownloadDialog(...args),
  },
}));

function file(relativePath: string): NoteFile {
  return { name: relativePath.split('/').pop() ?? '', relativePath, isFolder: false } as NoteFile;
}

function client() {
  const createDocument = vi.fn(async () => {});
  const readDocument = vi.fn(async () => ({ content: '', version: 'v1' }));
  const writeDocument = vi.fn(async () => ({ version: 'v2' }));
  return {
    createDocument,
    readDocument,
    writeDocument,
  } as unknown as VaultClient & {
    createDocument: typeof createDocument;
    readDocument: typeof readDocument;
    writeDocument: typeof writeDocument;
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('nextAvailableWorkbookPath', () => {
  it('uses the source name when nothing collides', () => {
    expect(nextAvailableWorkbookPath(undefined, 'Budget', [])).toBe('Budget.sheet');
    expect(nextAvailableWorkbookPath('Finance', 'Budget', [])).toBe('Finance/Budget.sheet');
  });

  it('counts up rather than overwriting an existing workbook', () => {
    // A conversion must never replace a workbook the user already has.
    const existing = [file('Budget.sheet'), file('Budget 2.sheet')];
    expect(nextAvailableWorkbookPath(undefined, 'Budget', existing)).toBe('Budget 3.sheet');
  });

  it('compares case-insensitively, the way vault paths are matched elsewhere', () => {
    expect(nextAvailableWorkbookPath(undefined, 'Budget', [file('budget.sheet')])).toBe(
      'Budget 2.sheet',
    );
  });
});

describe('importWorkbookFile', () => {
  it('creates a new .sheet document from the native conversion', async () => {
    sheetConvertImport.mockResolvedValue({
      document: '{"kind":"collab-sheet"}',
      suggestedName: 'Budget',
      report: { notes: [], truncated: false },
    });
    const vault = client();

    const outcome = await importWorkbookFile(vault, '/tmp/Budget.xlsx', {
      workbookId: 'wb-1',
      timestamp: '2026-01-01T00:00:00.000Z',
    });

    expect(sheetConvertImport).toHaveBeenCalledWith(
      '/tmp/Budget.xlsx',
      'wb-1',
      '2026-01-01T00:00:00.000Z',
      undefined,
    );
    expect(outcome.relativePath).toBe('Budget.sheet');
    expect(vault.createDocument).toHaveBeenCalledWith('Budget.sheet');
    // Written as the first real revision, using the created version as the base.
    expect(vault.writeDocument).toHaveBeenCalledWith(
      'Budget.sheet',
      '{"kind":"collab-sheet"}',
      'v1',
      '',
    );
  });

  it('returns the report so the caller can surface it', async () => {
    const report = {
      notes: [
        { severity: 'unsupported' as const, feature: 'Formula function', detail: 'x', count: 2 },
      ],
      truncated: false,
    };
    sheetConvertImport.mockResolvedValue({ document: '{}', suggestedName: 'B', report });
    const outcome = await importWorkbookFile(client(), '/tmp/B.csv');
    expect(outcome.report).toBe(report);
  });

  it('places the workbook in the requested folder without colliding', async () => {
    sheetConvertImport.mockResolvedValue({
      document: '{}',
      suggestedName: 'Data',
      report: { notes: [], truncated: false },
    });
    const outcome = await importWorkbookFile(client(), '/tmp/Data.csv', {
      targetFolder: 'Imports',
      existingFiles: [file('Imports/Data.sheet')],
    });
    expect(outcome.relativePath).toBe('Imports/Data 2.sheet');
  });

  it('passes CSV options through to the native converter', async () => {
    sheetConvertImport.mockResolvedValue({
      document: '{}',
      suggestedName: 'D',
      report: { notes: [], truncated: false },
    });
    await importWorkbookFile(client(), '/tmp/D.csv', {
      importOptions: { delimiter: ';', inferTypes: false },
      workbookId: 'wb',
      timestamp: 't',
    });
    expect(sheetConvertImport).toHaveBeenCalledWith('/tmp/D.csv', 'wb', 't', {
      delimiter: ';',
      inferTypes: false,
    });
  });
});

describe('computedValuesForExport', () => {
  function workbookWithFormula() {
    const document = createWorkbookFixture({
      rows: 3,
      columns: 3,
      populatedRows: 1,
      populatedColumns: 1,
    });
    return setCell(document, 'ws1', { row: 1, column: 1 }, { formula: '=A1*2' });
  }

  it('flattens evaluated formula results into the wire shape', () => {
    const document = workbookWithFormula();
    const computed: SheetFormulaValueMap = new Map([
      [sheetFormulaResultKey('ws1', 'r2', 'c2'), { type: 'number', value: 4 }],
    ]);

    expect(computedValuesForExport(document, computed)).toEqual([
      { key: 'ws1:r2:c2', kind: 'number', number: 4 },
    ]);
  });

  it('carries text, boolean, and error results', () => {
    const document = workbookWithFormula();
    for (const [value, expected] of [
      [{ type: 'text', value: 'hi' } as const, { key: 'ws1:r2:c2', kind: 'text', text: 'hi' }],
      [
        { type: 'boolean', value: true } as const,
        { key: 'ws1:r2:c2', kind: 'boolean', boolean: true },
      ],
      [
        { type: 'error', value: '#REF!' } as const,
        { key: 'ws1:r2:c2', kind: 'error', text: '#REF!' },
      ],
    ] as const) {
      const computed: SheetFormulaValueMap = new Map([
        [sheetFormulaResultKey('ws1', 'r2', 'c2'), value],
      ]);
      expect(computedValuesForExport(document, computed)).toEqual([expected]);
    }
  });

  it('ignores cells that are not formulas', () => {
    // Literal values are already in the document; sending them again would let
    // a stale computed map override what the user actually typed.
    const document = workbookWithFormula();
    const computed: SheetFormulaValueMap = new Map([
      [sheetFormulaResultKey('ws1', 'r1', 'c1'), { type: 'number', value: 999 }],
    ]);
    expect(computedValuesForExport(document, computed)).toEqual([]);
  });

  it('returns nothing when the engine has not produced values yet', () => {
    expect(computedValuesForExport(workbookWithFormula(), undefined)).toEqual([]);
  });
});

describe('exportWorkbookFile', () => {
  const document = createWorkbookFixture({
    rows: 2,
    columns: 2,
    populatedRows: 1,
    populatedColumns: 1,
  });

  it('names the file after the workbook', () => {
    expect(defaultExportFileName(document, 'xlsx')).toBe('Fixture workbook.xlsx');
    expect(defaultExportFileName({ ...document, name: '  ' }, 'csv')).toBe('Workbook.csv');
  });

  it('does nothing when the destination dialog is dismissed', async () => {
    showDownloadDialog.mockResolvedValue(null);
    expect(await exportWorkbookFile(document, 'xlsx')).toBeNull();
    expect(sheetConvertExport).not.toHaveBeenCalled();
  });

  it('writes to the chosen destination and returns the report', async () => {
    showDownloadDialog.mockResolvedValue('/tmp/Out.xlsx');
    const result = {
      path: '/tmp/Out.xlsx',
      bytesWritten: 12,
      report: { notes: [], truncated: false },
    };
    sheetConvertExport.mockResolvedValue(result);

    expect(await exportWorkbookFile(document, 'xlsx')).toBe(result);
    const [documentText, target, format] = sheetConvertExport.mock.calls[0];
    expect(target).toBe('/tmp/Out.xlsx');
    expect(format).toBe('xlsx');
    // The serialized document is sent, never a path to the open file — the
    // exported copy must not become the workbook's backing file.
    expect(JSON.parse(documentText as string).kind).toBe('collab-sheet');
  });
});
