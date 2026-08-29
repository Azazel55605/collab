import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createEmptySheetDocument } from '../../../../src/lib/sheet/document';
import { activeWorksheet, setCell } from '../../../../src/lib/sheet/operations';
import type { HostedFileEntry } from '../mobileTauri';

import {
  clampSheetScale,
  inspectSheetContent,
  isSheetFile,
  readSheetWorkbook,
  saveSheetWorkbook,
  scaledDefaults,
  serializeSheet,
  SHEET_MOBILE_SCALE,
  workbookName,
} from './sheet';

const invoke = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...args: unknown[]) => invoke(...args) }));

const SERVER = 'https://collab.example.com';
const VAULT = 'v1';

const SHEET_FILE: HostedFileEntry = {
  id: 'sheet-1',
  parentId: null,
  name: 'Budget.sheet',
  relativePath: 'Budget.sheet',
  kind: 'document',
  documentType: 'sheet',
  state: 'active',
  updatedAt: null,
  sizeBytes: 120,
  contentHash: 'hash',
  revisionSequence: 3,
};

function workbook() {
  let document = createEmptySheetDocument('Budget', {
    timestamp: '2026-07-30T00:00:00.000Z',
    worksheet: { rows: 6, columns: 4 },
  });
  const sheetId = activeWorksheet(document).id;
  document = setCell(
    document,
    sheetId,
    { row: 0, column: 0 },
    { value: 'Rent', valueType: 'text' },
  );
  document = setCell(
    document,
    sheetId,
    { row: 0, column: 1 },
    { value: 1200, valueType: 'number' },
  );
  document = setCell(document, sheetId, { row: 1, column: 1 }, { formula: '=B1*2' });
  return document;
}

const CONTENT = serializeSheet(workbook());

describe('mobile sheet documents', () => {
  beforeEach(() => {
    invoke.mockReset();
  });

  it('recognizes workbooks by document type and extension', () => {
    expect(isSheetFile(SHEET_FILE)).toBe(true);
    expect(isSheetFile({ ...SHEET_FILE, documentType: null })).toBe(true);
    expect(
      isSheetFile({
        ...SHEET_FILE,
        name: 'Q3',
        relativePath: 'Finance/Q3.sheet',
        documentType: null,
      }),
    ).toBe(true);
    expect(
      isSheetFile({
        ...SHEET_FILE,
        name: 'Note.md',
        relativePath: 'Note.md',
        documentType: 'note',
      }),
    ).toBe(false);
    expect(isSheetFile({ ...SHEET_FILE, kind: 'asset' })).toBe(false);
  });

  it('strips the extension for the screen title', () => {
    expect(workbookName(SHEET_FILE)).toBe('Budget');
    expect(workbookName({ ...SHEET_FILE, name: '.sheet' })).toBe('.sheet');
  });

  it('parses through the shared inspector, keeping formulas authoritative', () => {
    const inspected = inspectSheetContent(CONTENT, 'Budget');
    expect(inspected.support).toBe('supported');
    const worksheet = activeWorksheet(inspected.document);
    const columnId = worksheet.columnOrder[1];
    expect(worksheet.cells[`${worksheet.rowOrder[1]}:${columnId}`]?.formula).toBe('=B1*2');
    // Computed values are never persisted.
    expect(CONTENT).not.toContain('2400');
  });

  it('opens a newer schema version read-only instead of normalizing it', () => {
    const newer = JSON.parse(CONTENT) as Record<string, unknown>;
    newer.schemaVersion = 99;
    const inspected = inspectSheetContent(JSON.stringify(newer), 'Budget');
    expect(inspected.support).toBe('newer');
    expect(inspected.schemaVersion).toBe(99);
  });

  it('surfaces malformed content as an error rather than an empty grid', () => {
    expect(() => inspectSheetContent('{not json', 'Budget')).toThrow(/valid JSON/i);
  });

  it('reads a workbook online and warms the replica cache', async () => {
    invoke.mockImplementation((command: string) => {
      if (command === 'hosted_vault_request') {
        return Promise.resolve({
          file: { ...SHEET_FILE, currentRevision: { sequence: 3 } },
          content: CONTENT,
        });
      }
      if (command === 'replica_cache_document') return Promise.resolve(null);
      return Promise.reject(new Error(`unhandled ${command}`));
    });

    const loaded = await readSheetWorkbook(SERVER, VAULT, SHEET_FILE, true);
    expect(loaded.source).toBe('network');
    expect(loaded.document.worksheets).toHaveLength(1);
    expect(invoke).toHaveBeenCalledWith(
      'replica_cache_document',
      expect.objectContaining({ fileId: 'sheet-1' }),
    );
  });

  it('falls back to the cached workbook when the server is unreachable', async () => {
    invoke.mockImplementation((command: string) => {
      if (command === 'hosted_vault_request') return Promise.reject(new Error('network error'));
      if (command === 'replica_read_cached_document') return Promise.resolve(CONTENT);
      return Promise.reject(new Error(`unhandled ${command}`));
    });

    const loaded = await readSheetWorkbook(SERVER, VAULT, SHEET_FILE, true);
    expect(loaded.source).toBe('cache');
    expect(activeWorksheet(loaded.document).rowOrder).toHaveLength(6);
  });

  it('reports a clear error when an offline workbook is not cached', async () => {
    invoke.mockImplementation((command: string) => {
      if (command === 'replica_read_cached_document') return Promise.resolve(null);
      return Promise.reject(new Error(`unhandled ${command}`));
    });

    await expect(readSheetWorkbook(SERVER, VAULT, SHEET_FILE, false)).rejects.toThrow(
      /not cached for offline reading/i,
    );
  });

  it('writes against the current revision and refreshes the offline cache', async () => {
    invoke.mockImplementation((command: string) => {
      if (command === 'hosted_vault_request') {
        return Promise.resolve({
          file: { ...SHEET_FILE, currentRevision: { sequence: 4 } },
          content: CONTENT,
        });
      }
      if (command === 'replica_cache_document') return Promise.resolve(null);
      return Promise.reject(new Error(`unhandled ${command}`));
    });

    const saved = await saveSheetWorkbook(SERVER, VAULT, SHEET_FILE, workbook());
    expect(saved.file.revisionSequence).toBe(4);
    expect(invoke).toHaveBeenCalledWith(
      'hosted_vault_request',
      expect.objectContaining({
        method: 'POST',
        path: `/api/v1/vaults/${VAULT}/files/${SHEET_FILE.id}/revisions`,
        body: expect.objectContaining({ expectedRevisionSequence: 3 }),
      }),
    );
  });

  it('bounds the pinch scale so a cell stays tappable and readable', () => {
    expect(clampSheetScale(0.1)).toBe(SHEET_MOBILE_SCALE.min);
    expect(clampSheetScale(9)).toBe(SHEET_MOBILE_SCALE.max);
    expect(clampSheetScale(Number.NaN)).toBe(SHEET_MOBILE_SCALE.default);
    expect(clampSheetScale(1.4)).toBe(1.4);
  });

  it('scales the worksheet defaults for the touch grid', () => {
    const worksheet = activeWorksheet(workbook());
    expect(scaledDefaults(worksheet, 2)).toEqual({ rowHeight: 48, columnWidth: 200 });
  });
});
