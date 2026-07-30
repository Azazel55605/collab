import { describe, expect, it } from 'vitest';

import { createEmptySheetDocument } from './document';
import { buildSheetRangePrintHtml, buildSheetRangeSvg } from './export';
import { activeWorksheet, mergeSelection, setCell } from './operations';
import { createSelection, extendSelection } from './selection';
import { applyStyleToSelection } from './styles';

describe('sheet range export', () => {
  it('renders styled values and escapes content in SVG', () => {
    let document = createEmptySheetDocument('Export', {
      timestamp: '2026-07-30T00:00:00.000Z',
      worksheet: { rows: 4, columns: 4 },
    });
    const worksheet = activeWorksheet(document);
    document = setCell(document, worksheet.id, { row: 0, column: 0 }, {
      value: '<Budget & plan>',
      valueType: 'text',
      note: 'Check',
    });
    document = applyStyleToSelection(
      document,
      worksheet.id,
      createSelection({ row: 0, column: 0 }),
      { bold: true, backgroundColor: '#ffeecc' },
    );
    const svg = buildSheetRangeSvg(
      document,
      activeWorksheet(document),
      createSelection({ row: 0, column: 0 }),
      { title: 'Export' },
    );
    expect(svg).toContain('&lt;Budget &amp;');
    expect(svg).not.toContain('<Budget');
    expect(svg).toContain('#ffeecc');
    expect(svg).toContain('font-weight="700"');
    expect(svg).toContain('#f59e0b');
  });

  it('uses row and column spans for merged cells in print output', () => {
    let document = createEmptySheetDocument('Print', {
      timestamp: '2026-07-30T00:00:00.000Z',
      worksheet: { rows: 4, columns: 4 },
    });
    const worksheet = activeWorksheet(document);
    const selection = extendSelection(createSelection({ row: 0, column: 0 }), { row: 1, column: 1 });
    document = mergeSelection(document, worksheet.id, selection);
    const html = buildSheetRangePrintHtml(document, activeWorksheet(document), selection);
    expect(html).toContain('rowspan="2"');
    expect(html).toContain('colspan="2"');
    expect(html).toContain('@page');
  });
});
