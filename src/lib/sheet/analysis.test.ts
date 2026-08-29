import { describe, expect, it } from 'vitest';

import type { SheetChartKind } from '../../types/sheet';

import {
  buildSheetChartSvg,
  chartAccessibilitySummary,
  createChartFromSelection,
  groupedSheetSummary,
  pivotSheetSummary,
  stableRangeFromSelection,
} from './analysis';
import { createEmptySheetDocument } from './document';
import { deleteTracks, setCell, upsertSheetChart } from './operations';
import { createSelection } from './selection';

function fixture() {
  let document = createEmptySheetDocument('Analysis', {
    id: 'wb1',
    timestamp: '2026-01-01T00:00:00.000Z',
    worksheet: { id: 'ws1', rows: 8, columns: 4 },
  });
  const rows = [
    ['Region', 'Product', 'Revenue'],
    ['North', 'A', 10],
    ['North', 'B', 20],
    ['South', 'A', 30],
  ] as const;
  rows.forEach((row, rowIndex) =>
    row.forEach((value, column) => {
      document = setCell(
        document,
        'ws1',
        { row: rowIndex, column },
        {
          value,
          valueType: typeof value === 'number' ? 'number' : 'text',
        },
      );
    }),
  );
  return document;
}

describe('sheet charts and analysis', () => {
  it('renders every supported chart kind with an accessibility summary', () => {
    const document = fixture();
    const worksheet = document.worksheets[0];
    const selection = {
      ...createSelection({ row: 0, column: 0 }),
      ranges: [{ anchor: { row: 0, column: 0 }, focus: { row: 3, column: 2 } }],
    };
    const kinds: SheetChartKind[] = [
      'column',
      'bar',
      'line',
      'area',
      'pie',
      'scatter',
      'sparkline',
    ];
    for (const kind of kinds) {
      const chart = createChartFromSelection(worksheet, selection, kind, `${kind} chart`);
      const svg = buildSheetChartSvg(worksheet, chart);
      expect(svg).toContain('<svg');
      expect(svg).toContain('role="img"');
      expect(chartAccessibilitySummary(worksheet, chart)).toContain('series');
    }
  });

  it('keeps chart ranges stable across insertion and prunes deleted targets', () => {
    let document = fixture();
    const worksheet = document.worksheets[0];
    const selection = {
      ...createSelection({ row: 0, column: 0 }),
      ranges: [{ anchor: { row: 0, column: 0 }, focus: { row: 3, column: 2 } }],
    };
    const chart = createChartFromSelection(worksheet, selection, 'column');
    document = upsertSheetChart(document, worksheet.id, chart);
    const originalRange = document.worksheets[0].charts![0].series[0].valuesRange;

    document = deleteTracks(document, worksheet.id, 'row', 1, 1);
    expect(document.worksheets[0].charts![0].series[0].valuesRange.startRowId).toBe(
      originalRange.startRowId,
    );

    const anchorRow = document.worksheets[0].rowOrder.indexOf(chart.anchor.rowId);
    document = deleteTracks(document, worksheet.id, 'row', anchorRow, 1);
    expect(document.worksheets[0].charts).toBeUndefined();
  });

  it('builds grouped and pivot-style summaries within the selected stable range', () => {
    const worksheet = fixture().worksheets[0];
    const selection = {
      ...createSelection({ row: 1, column: 0 }),
      ranges: [{ anchor: { row: 1, column: 0 }, focus: { row: 3, column: 2 } }],
    };
    const range = stableRangeFromSelection(worksheet, selection)!;
    const grouped = groupedSheetSummary(
      worksheet,
      range,
      worksheet.columnOrder[0],
      worksheet.columnOrder[2],
    );
    expect(grouped).toContainEqual(
      expect.objectContaining({
        group: 'North',
        count: 2,
        sum: 30,
      }),
    );
    const pivot = pivotSheetSummary(
      worksheet,
      range,
      worksheet.columnOrder[0],
      worksheet.columnOrder[1],
      worksheet.columnOrder[2],
    );
    expect(pivot.values.get('South\u0000A')).toBe(30);
  });
});
