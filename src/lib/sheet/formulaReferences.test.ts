import { describe, expect, it } from 'vitest';

import { createEmptySheetDocument, renameWorksheet } from './document';
import {
  formulaDependsOn,
  formulaPrecedents,
  parseFormulaReferences,
  translateFormulaReferences,
} from './formulaReferences';
import { createSheetNamedRange } from './namedRanges';
import { deleteTracks, getCell, insertTracks, moveTracks, setCell } from './operations';

function workbook() {
  return createEmptySheetDocument('Formula fixture', {
    timestamp: '2026-07-29T00:00:00.000Z',
    worksheet: { name: 'Input Data', rows: 8, columns: 8 },
  });
}

describe('formula reference parsing', () => {
  it('parses mixed, range, and quoted cross-sheet references but skips strings', () => {
    const references = parseFormulaReferences('=$A1+B$2+\'Input Data\'!$C$3:D4+"A1"');
    expect(references.map((reference) => reference.source)).toEqual([
      '$A1',
      'B$2',
      "'Input Data'!$C$3:D4",
    ]);
    expect(references[0].first).toMatchObject({
      absoluteColumn: true,
      absoluteRow: false,
    });
    expect(references[2].last).toMatchObject({ row: 3, column: 3 });
  });

  it('translates only relative axes during fill or copy', () => {
    expect(translateFormulaReferences('=$A1+B$2+$C$3', 2, 3)).toBe('=$A3+E$2+$C$3');
    expect(translateFormulaReferences('=A1', -1, 0)).toBe('=#REF!');
  });
});

describe('structural formula rewriting', () => {
  it('keeps references attached to stable cells across insert and move', () => {
    let document = workbook();
    const worksheet = document.worksheets[0];
    document = setCell(document, worksheet.id, { row: 0, column: 3 }, { formula: '=A1+$B$2' });

    document = insertTracks(document, worksheet.id, 'row', 0, 1);
    expect(getCell(document.worksheets[0], { row: 1, column: 3 })?.formula).toBe('=A2+$B$3');

    document = moveTracks(document, worksheet.id, 'column', 0, 1, 3);
    expect(getCell(document.worksheets[0], { row: 1, column: 2 })?.formula).toBe('=D2+$A$3');
  });

  it('shrinks ranges and emits a stable reference error for deleted cells', () => {
    let document = workbook();
    const worksheet = document.worksheets[0];
    document = setCell(
      document,
      worksheet.id,
      { row: 0, column: 4 },
      { formula: '=SUM(A1:A4)+B2' },
    );
    document = deleteTracks(document, worksheet.id, 'row', 1, 1);
    expect(getCell(document.worksheets[0], { row: 0, column: 4 })?.formula).toBe(
      '=SUM(A1:A3)+#REF!',
    );
  });

  it('rewrites explicit worksheet names on rename', () => {
    let document = workbook();
    const worksheet = document.worksheets[0];
    document = setCell(
      document,
      worksheet.id,
      { row: 0, column: 1 },
      {
        formula: "='Input Data'!A1",
      },
    );
    document = renameWorksheet(document, worksheet.id, 'Renamed');
    expect(getCell(document.worksheets[0], { row: 0, column: 1 })?.formula).toBe('=Renamed!A1');
  });

  it('expands precedents for inspection without losing stable identities', () => {
    const document = workbook();
    const worksheet = document.worksheets[0];
    const dependencies = formulaPrecedents(document, worksheet.id, '=SUM(A1:B2)');
    expect(dependencies).toHaveLength(4);
    expect(dependencies[0]).toMatchObject({
      worksheetId: worksheet.id,
      rowId: worksheet.rowOrder[0],
      columnId: worksheet.columnOrder[0],
    });
    expect(formulaDependsOn(document, worksheet.id, '=SUM(A1:B2)', dependencies[3])).toBe(true);
    expect(formulaPrecedents(document, worksheet.id, '=A1:H8', 5)).toHaveLength(5);
  });

  it('resolves named ranges for precedent and dependency inspection', () => {
    let document = workbook();
    const worksheet = document.worksheets[0];
    document = createSheetNamedRange(
      document,
      worksheet.id,
      {
        ranges: [
          {
            anchor: { row: 1, column: 1 },
            focus: { row: 2, column: 2 },
          },
        ],
        active: { row: 1, column: 1 },
        kind: 'cells',
      },
      'Inputs',
      'workbook',
    );
    const precedents = formulaPrecedents(document, worksheet.id, '=SUM(Inputs)');
    expect(precedents).toHaveLength(4);
    expect(formulaDependsOn(document, worksheet.id, '=SUM(Inputs)', precedents[3])).toBe(true);
  });
});
