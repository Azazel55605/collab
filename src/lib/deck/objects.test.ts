import { describe, expect, it } from 'vitest';

import { DECK_LIMITS, DECK_SHAPE_GEOMETRIES } from '../../types/deck';
import type { DeckChartElement, DeckDocument, DeckTableElement } from '../../types/deck';
import type { SheetDocument } from '../../types/sheet';
import { sheetFormulaResultKey } from '../../types/sheetFormula';
import { createEmptySheetDocument } from '../sheet/document';

import { createDeckDocument } from './document';
import {
  deckAssetFolder,
  embedPreviewName,
  markdownExcerpt,
  notePreviewSvg,
  slideExportMarkdown,
  slideExportName,
  svgDataUrl,
} from './embeds';
import {
  createChartElement,
  createEmbedElement,
  createImageElement,
  createInsertedElement,
  createTableElement,
} from './insert';
import { addElements, groupElements } from './operations';
import { resolveSlide } from './resolve';
import type { ResolvedTableItem } from './resolve';
import {
  applyChartData,
  formatSheetRange,
  gridToChartData,
  parseSheetRange,
  readSheetRange,
} from './sheetSnapshot';
import { renderSlideSvg } from './svg';
import {
  cellAtPoint,
  cellKey,
  deleteTableColumns,
  deleteTableRows,
  fitTableRows,
  insertTableColumns,
  insertTableRows,
  setCellContent,
  tableSize,
} from './tables';
import { createApproximateMeasurer } from './textLayout';
import { moveLineEndpoint, resizeSelection, slideGeometry } from './transform';
import { validateDeck } from './validate';

const NOW = '2026-09-30T00:00:00.000Z';
const measurer = createApproximateMeasurer();

function counter() {
  let count = 0;
  return (prefix: string) => `${prefix}-${++count}`;
}

function deck(): DeckDocument {
  return createDeckDocument({ id: 'd', name: 'Talk', now: NOW });
}

function withElements(elements: Parameters<typeof addElements>[2]): DeckDocument {
  return addElements(deck(), 'slide-1', elements).result;
}

describe('inserted objects', () => {
  it('creates every preset shape, lines, and arrows as valid content', () => {
    const elements = [
      ...DECK_SHAPE_GEOMETRIES.map((geometry) =>
        createInsertedElement(deck(), `s-${geometry}`, geometry),
      ),
      createInsertedElement(deck(), 'line', 'line'),
      createInsertedElement(deck(), 'arrow', 'arrow'),
    ];
    const document = withElements(elements);
    expect(validateDeck(document).ok).toBe(true);
    const arrow = document.slides['slide-1'].elements.arrow;
    expect(arrow.type === 'line' && arrow.endArrow).toBe('triangle');
    expect(renderSlideSvg(resolveSlide(document, 'slide-1'), { measurer })).toContain('star');
  });

  it('fits a large image inside the slide at its aspect ratio', () => {
    const image = createImageElement(deck(), 'img', {
      path: 'Pictures/photo.png',
      mediaType: 'image/png',
      pixelWidth: 4_000,
      pixelHeight: 1_000,
    });
    expect(image.frame!.width).toBeLessThanOrEqual(deck().size.width * 0.6);
    expect(image.frame!.width / image.frame!.height).toBeCloseTo(4, 1);
    const small = createImageElement(deck(), 'small', {
      path: 'Pictures/icon.png',
      mediaType: 'image/png',
      pixelWidth: 32,
      pixelHeight: 32,
    });
    // Never enlarged past its own pixels.
    expect(small.frame!.width).toBe(32 * 75);
    expect(validateDeck(withElements([image, small])).ok).toBe(true);
  });

  it('creates a styled table, a chart, and a linked document', () => {
    const next = counter();
    const table = createTableElement(deck(), 't', 3, 4, next);
    const chart = createChartElement(deck(), 'c', 'bar', next);
    const embed = createEmbedElement(deck(), 'e', 'Notes/Plan.md', undefined);
    const document = withElements([table, chart, embed]);
    expect(validateDeck(document).ok).toBe(true);
    expect(tableSize(table)).toEqual({ width: table.frame!.width, height: table.frame!.height });
    const header = table.cells[cellKey(table.rowOrder[0], table.columnOrder[0])];
    expect(header.fill).toEqual({ kind: 'solid', color: { kind: 'theme', token: 'accent1' } });
    const svg = renderSlideSvg(resolveSlide(document, 'slide-1'), { measurer });
    // The linked document shows a card, never a broken image.
    expect(svg).toContain('Notes/Plan.md');
    expect(svg).not.toContain('Missing image');
    expect(() => createTableElement(deck(), 'huge', 500, 64, next)).toThrow(/cells/);
  });

  it('refuses to nest groups past the depth limit', () => {
    let document = withElements([
      createInsertedElement(deck(), 'a', 'rect'),
      createInsertedElement(deck(), 'b', 'rect'),
    ]);
    let top = 'a';
    let other = 'b';
    for (let depth = 1; depth <= DECK_LIMITS.groupDepth; depth += 1) {
      const id = `g${depth}`;
      document = groupElements(document, 'slide-1', [top, other], id, undefined).result;
      const extra = `x${depth}`;
      document = addElements(document, 'slide-1', [
        createInsertedElement(document, extra, 'rect'),
      ]).result;
      top = id;
      other = extra;
    }
    expect(() => groupElements(document, 'slide-1', [top, other], 'too-deep', undefined)).toThrow(
      /nested at most/,
    );
  });
});

describe('tables', () => {
  const table = (): DeckTableElement => createTableElement(deck(), 't', 3, 3, counter());

  it('inserts rows styled like the body, never like the header', () => {
    const next = insertTableRows(table(), 1, 2, counter());
    expect(next.rowOrder).toHaveLength(5);
    const added = next.cells[cellKey(next.rowOrder[1], next.columnOrder[0])];
    expect(added.fill).toBeUndefined();
    expect(next.frame!.height).toBe(tableSize(next).height);
  });

  it('inserts and deletes columns, keeping the frame equal to the tracks', () => {
    let next = insertTableColumns(table(), 3, 1, counter());
    expect(next.columnOrder).toHaveLength(4);
    expect(next.frame!.width).toBe(tableSize(next).width);
    next = deleteTableColumns(next, [next.columnOrder[0]]);
    expect(next.columnOrder).toHaveLength(3);
    expect(() => deleteTableColumns(next, next.columnOrder)).toThrow(/at least one column/);
  });

  it('shrinks merged cells when a spanned row goes', () => {
    const base = table();
    const anchor = cellKey(base.rowOrder[0], base.columnOrder[0]);
    const merged = {
      ...base,
      cells: { ...base.cells, [anchor]: { ...base.cells[anchor], rowSpan: 3 } },
    };
    const next = deleteTableRows(merged, [merged.rowOrder[1]]);
    expect(next.cells[anchor].rowSpan).toBe(2);
    const grown = insertTableRows(merged, 1, 1, counter());
    expect(grown.cells[anchor].rowSpan).toBe(4);
    expect(deleteTableRows(merged, [merged.rowOrder[0]]).headerRow).toBe(false);
  });

  it('scales rows and columns when the table is resized', () => {
    const document = withElements([table()]);
    const geometry = slideGeometry(document, 'slide-1');
    const updaters = resizeSelection(geometry, ['t'], 'se', { x: 9_000, y: 3_000 }, false);
    const resized = updaters.t(document.slides['slide-1'].elements.t) as DeckTableElement;
    expect(tableSize(resized)).toEqual({
      width: resized.frame!.width,
      height: resized.frame!.height,
    });
  });

  it('finds the cell under a point and grows rows to fit their text', () => {
    let current = table();
    const key = cellKey(current.rowOrder[1], current.columnOrder[1]);
    current = setCellContent(current, key, {
      paragraphs: [{ id: 'p', runs: [{ kind: 'text', text: 'word '.repeat(80) }] }],
    });
    const document = withElements([current]);
    const item = resolveSlide(document, 'slide-1').items.find(
      (entry) => entry.id === 't',
    ) as ResolvedTableItem;
    const cell = item.cells.find(
      (entry) => entry.rowId === current.rowOrder[1] && entry.columnId === current.columnOrder[1],
    )!;
    expect(cellAtPoint(item, { x: cell.x + 10, y: cell.y + 10 })).toEqual({
      rowId: current.rowOrder[1],
      columnId: current.columnOrder[1],
    });
    const fitted = fitTableRows(current, item, measurer);
    expect(fitted.rowHeights[current.rowOrder[1]]).toBeGreaterThan(
      current.rowHeights[current.rowOrder[1]],
    );
    expect(fitted.rowHeights[current.rowOrder[0]]).toBe(current.rowHeights[current.rowOrder[0]]);
  });
});

describe('sheet snapshots', () => {
  function workbook(): SheetDocument {
    const document = createEmptySheetDocument('Sales');
    const worksheet = document.worksheets[0];
    worksheet.name = 'Q3 Sales';
    const put = (row: number, column: number, value: string | number, formula?: string) => {
      const key = `${worksheet.rowOrder[row]}:${worksheet.columnOrder[column]}`;
      worksheet.cells[key] = formula ? { formula } : { value };
    };
    put(0, 1, 'North');
    put(0, 2, 'South');
    put(1, 0, 'Jan');
    put(1, 1, 10);
    put(1, 2, 5);
    put(2, 0, 'Feb');
    put(2, 1, 12);
    put(2, 2, 0, '=B3/2');
    return document;
  }

  it('parses and formats range references, quoting sheet names', () => {
    const reference = parseSheetRange("'Q3 Sales'!C3:A1");
    expect(reference).toEqual({
      worksheet: 'Q3 Sales',
      start: { row: 0, column: 0 },
      end: { row: 2, column: 2 },
    });
    expect(formatSheetRange(reference!)).toBe("'Q3 Sales'!A1:C3");
    expect(parseSheetRange('B2')).toEqual({
      worksheet: null,
      start: { row: 1, column: 1 },
      end: { row: 1, column: 1 },
    });
    expect(parseSheetRange('not a range')).toBeNull();
  });

  it('reads values with computed formulas and turns them into chart data', () => {
    const document = workbook();
    const worksheet = document.worksheets[0];
    const computed = new Map([
      [
        sheetFormulaResultKey(worksheet.id, worksheet.rowOrder[2], worksheet.columnOrder[2]),
        { type: 'number' as const, value: 6 },
      ],
    ]);
    const { grid } = readSheetRange(document, parseSheetRange("'Q3 Sales'!A1:C3")!, computed);
    expect(grid).toEqual([
      [null, 'North', 'South'],
      ['Jan', 10, 5],
      ['Feb', 12, 6],
    ]);
    const data = gridToChartData(grid);
    expect(data).toEqual({
      categories: ['Jan', 'Feb'],
      series: [
        { name: 'North', values: [10, 12] },
        { name: 'South', values: [5, 6] },
      ],
      nonNumeric: 0,
    });
    expect(() => readSheetRange(document, parseSheetRange('Nope!A1:B2')!)).toThrow(/no worksheet/);
    expect(() => readSheetRange(document, parseSheetRange('A1:B5000')!)).toThrow(/too large/);
  });

  it('keeps series ids and colours across a refresh', () => {
    const next = counter();
    const chart = createChartElement(deck(), 'c', 'column', next) as DeckChartElement;
    chart.series[1] = { ...chart.series[1], color: { kind: 'rgb', value: '#ff0000' } };
    const refreshed = applyChartData(
      chart,
      {
        categories: ['A'],
        series: [
          { name: 'Last year', values: [1] },
          { name: 'New', values: [2] },
        ],
      },
      next,
    );
    expect(refreshed.series[0]).toMatchObject({
      id: chart.series[1].id,
      color: { value: '#ff0000' },
    });
    // A series matching neither by name nor by a free position is new.
    expect(chart.series.map((series) => series.id)).not.toContain(refreshed.series[1].id);
  });
});

describe('linked documents and slide exports', () => {
  it('reduces markdown to readable lines', () => {
    expect(
      markdownExcerpt(
        '---\ntitle: x\n---\n# Heading\n\n\n- **bold** item\n- [ ] task\n[link](http://a) and [[Page|alias]]\n```\ncode\n```\n![img](a.png)',
      ),
    ).toEqual(['Heading', '', '• bold item', '☐ task', 'link and alias', 'code', '[img]']);
  });

  it('builds an escaped, self-contained preview', () => {
    const svg = notePreviewSvg('<Plan>', 'a <script>alert(1)</script> & more');
    expect(svg).toContain('&lt;Plan&gt;');
    expect(svg).not.toContain('<script');
    expect(svg).not.toMatch(/href=/);
    expect(svgDataUrl('<svg>ü</svg>')).toBe(`data:image/svg+xml;base64,${btoa('<svg>Ã¼</svg>')}`);
  });

  it('names generated files stably beside the deck', () => {
    expect(deckAssetFolder('Talks/Q3 review.deck')).toBe('Talks/Q3 review assets');
    expect(deckAssetFolder('Top.deck')).toBe('Top assets');
    expect(slideExportName('slide-1')).toBe('slide-slide-1.svg');
    expect(embedPreviewName('el/1')).toBe('preview-el-1.svg');
    expect(
      slideExportMarkdown('Talks/Q3 review assets/slide-slide-1.svg', 'Talks/Q3 review.deck', 2),
    ).toBe(
      '![Slide 2 of Q3 review](<Talks/Q3 review assets/slide-slide-1.svg>)\n[Open Q3 review](<Talks/Q3 review.deck>)',
    );
  });
});

describe('line endpoints', () => {
  it('moves one end, snapping to 45° with Shift', () => {
    const line = createInsertedElement(deck(), 'l', 'line');
    const document = withElements([line]);
    const geometry = slideGeometry(document, 'slide-1');
    if (line.type !== 'line') throw new Error('expected a line');
    const free = moveLineEndpoint(geometry, 'l', 'to', {
      x: line.from.x + 1_000,
      y: line.from.y + 1_100,
    });
    expect((free.l(line) as typeof line).to).toEqual({
      x: line.from.x + 1_000,
      y: line.from.y + 1_100,
    });
    const snapped = moveLineEndpoint(
      geometry,
      'l',
      'to',
      { x: line.from.x + 1_000, y: line.from.y + 1_100 },
      { constrain: true },
    );
    const end = (snapped.l(line) as typeof line).to;
    expect(Math.abs(end.x - line.from.x)).toBe(Math.abs(end.y - line.from.y));
  });
});
