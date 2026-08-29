import { describe, expect, it } from 'vitest';

import { sheetCellKey } from '../../types/sheet';

import { mergeSheetDocuments, mergeStableIdentityOrder, sheetOperationId } from './collaboration';
import { createWorkbookFixture } from './fixture';

function workbook() {
  return createWorkbookFixture({
    rows: 3,
    columns: 3,
    populatedRows: 0,
    populatedColumns: 0,
  });
}

describe('sheet collaboration contract', () => {
  it('builds stable per-action idempotency keys', () => {
    expect(
      sheetOperationId({
        actorId: 'user@example.com',
        clientOperationId: 'paste-1',
        index: 4,
      }),
    ).toBe('sheet:user%40example.com:paste-1:4');
  });

  it('merges unrelated cell edits without a whole-document conflict', () => {
    const base = workbook();
    const local = structuredClone(base);
    const remote = structuredClone(base);
    local.worksheets[0].cells[sheetCellKey('r1', 'c1')] = { value: 10, valueType: 'number' };
    remote.worksheets[0].cells[sheetCellKey('r2', 'c2')] = { value: 20, valueType: 'number' };
    local.updatedAt = '2026-01-01T00:00:01.000Z';
    remote.updatedAt = '2026-01-01T00:00:02.000Z';

    const result = mergeSheetDocuments(base, local, remote);

    expect(result.conflicts).toEqual([]);
    expect(result.document.worksheets[0].cells[sheetCellKey('r1', 'c1')]?.value).toBe(10);
    expect(result.document.worksheets[0].cells[sheetCellKey('r2', 'c2')]?.value).toBe(20);
    expect(result.document.updatedAt).toBe(remote.updatedAt);
  });

  it('surfaces overlapping edits to the same stable cell', () => {
    const base = workbook();
    const local = structuredClone(base);
    const remote = structuredClone(base);
    local.worksheets[0].cells[sheetCellKey('r1', 'c1')] = { value: 'local', valueType: 'text' };
    remote.worksheets[0].cells[sheetCellKey('r1', 'c1')] = { value: 'remote', valueType: 'text' };

    const result = mergeSheetDocuments(base, local, remote);

    expect(result.conflicts).toContainEqual({
      kind: 'overlapping-edit',
      path: '/worksheets/ws1/cells/r1:c1',
    });
  });

  it('orders concurrent structural inserts deterministically', () => {
    const base = ['r1', 'r2'];
    const local = ['r1', 'local-row', 'r2'];
    const remote = ['r1', 'remote-row', 'r2'];

    expect(mergeStableIdentityOrder(base, local, remote)).toEqual([
      'r1',
      'local-row',
      'remote-row',
      'r2',
    ]);
    expect(mergeStableIdentityOrder(base, remote, local)).toEqual([
      'r1',
      'local-row',
      'remote-row',
      'r2',
    ]);
  });

  it('reports edit-versus-delete as a deleted target conflict', () => {
    const base = workbook();
    base.worksheets[0].cells[sheetCellKey('r1', 'c1')] = { value: 1, valueType: 'number' };
    const local = structuredClone(base);
    const remote = structuredClone(base);
    delete local.worksheets[0].cells[sheetCellKey('r1', 'c1')];
    remote.worksheets[0].cells[sheetCellKey('r1', 'c1')] = { value: 2, valueType: 'number' };

    const result = mergeSheetDocuments(base, local, remote);

    expect(result.conflicts).toContainEqual({
      kind: 'deleted-target',
      path: '/worksheets/ws1/cells/r1:c1',
    });
  });
});
