/**
 * Snapshots of a `.sheet` range for deck charts and tables.
 *
 * A deck never queries a workbook on its own. A person picks a range; the
 * values are read once and stored in the deck as ordinary chart data or
 * table text, together with the range they came from (for charts, in
 * `DeckChartElement.source`). "Refresh" repeats the read explicitly. The
 * workbook's formulas are evaluated by the caller through the same engine
 * the spreadsheet uses, so a snapshot shows exactly what the sheet shows.
 */
import { DECK_LIMITS } from '../../types/deck';
import type { DeckChartElement, DeckChartSeries } from '../../types/deck';
import type { SheetDocument, SheetWorksheet } from '../../types/sheet';
import { sheetFormulaResultKey } from '../../types/sheetFormula';
import type { SheetFormulaValueMap } from '../../types/sheetFormula';
import { columnLabel, parseA1Range } from '../sheet/address';
import { formatNumber } from '../sheet/cellValue';

export type SnapshotValue = number | string | null;

export interface SheetRangeReference {
  /** Worksheet name, or null for the first visible worksheet. */
  worksheet: string | null;
  start: { row: number; column: number };
  end: { row: number; column: number };
}

/** The largest range a snapshot reads: a chart's own limits, plus a header row and column. */
export const SNAPSHOT_MAX_ROWS = DECK_LIMITS.chartPointsPerSeries + 1;
export const SNAPSHOT_MAX_COLUMNS = Math.max(DECK_LIMITS.chartSeries, DECK_LIMITS.tableColumns) + 1;

/** Parses `A1:D5`, `Sheet1!A1:D5`, or `'Q3 Sales'!A1:D5`. */
export function parseSheetRange(reference: string): SheetRangeReference | null {
  const text = reference.trim();
  const bang = text.lastIndexOf('!');
  let worksheet: string | null = null;
  let range = text;
  if (bang >= 0) {
    const name = text.slice(0, bang).trim();
    range = text.slice(bang + 1);
    worksheet = /^'.*'$/.test(name) ? name.slice(1, -1).replace(/''/g, "'") : name;
    if (!worksheet) return null;
  }
  const parsed = parseA1Range(range);
  return parsed ? { worksheet, start: parsed.start, end: parsed.end } : null;
}

/** Formats a reference the way `parseSheetRange` reads it back. */
export function formatSheetRange(reference: SheetRangeReference): string {
  const cell = (position: { row: number; column: number }) =>
    `${columnLabel(position.column)}${position.row + 1}`;
  const range = `${cell(reference.start)}:${cell(reference.end)}`;
  if (!reference.worksheet) return range;
  const name = /^[A-Za-z0-9_]+$/.test(reference.worksheet)
    ? reference.worksheet
    : `'${reference.worksheet.replace(/'/g, "''")}'`;
  return `${name}!${range}`;
}

function findWorksheet(document: SheetDocument, name: string | null): SheetWorksheet {
  const worksheet = name
    ? document.worksheets.find((entry) => entry.name.toLowerCase() === name.toLowerCase())
    : (document.worksheets.find((entry) => !entry.hidden) ?? document.worksheets[0]);
  if (!worksheet) {
    throw new Error(
      name ? `The workbook has no worksheet named “${name}”.` : 'The workbook is empty.',
    );
  }
  return worksheet;
}

/**
 * Reads a range as a grid of values: numbers stay numbers, everything else is
 * its text, and empty cells are null. Formula cells take their computed
 * value from `computed`; without one they read as empty.
 */
export function readSheetRange(
  document: SheetDocument,
  reference: SheetRangeReference,
  computed: SheetFormulaValueMap = new Map(),
): { worksheet: SheetWorksheet; grid: SnapshotValue[][] } {
  const worksheet = findWorksheet(document, reference.worksheet);
  const rows = reference.end.row - reference.start.row + 1;
  const columns = reference.end.column - reference.start.column + 1;
  if (rows > SNAPSHOT_MAX_ROWS || columns > SNAPSHOT_MAX_COLUMNS) {
    throw new Error(
      `That range is too large to place on a slide (at most ${SNAPSHOT_MAX_ROWS} rows and ${SNAPSHOT_MAX_COLUMNS} columns).`,
    );
  }
  const grid: SnapshotValue[][] = [];
  for (let row = reference.start.row; row <= reference.end.row; row += 1) {
    const line: SnapshotValue[] = [];
    const rowId = worksheet.rowOrder[row];
    for (let column = reference.start.column; column <= reference.end.column; column += 1) {
      const columnId = worksheet.columnOrder[column];
      const cell = rowId && columnId ? worksheet.cells[`${rowId}:${columnId}`] : undefined;
      if (!cell) {
        line.push(null);
        continue;
      }
      if (cell.formula) {
        const value = computed.get(sheetFormulaResultKey(worksheet.id, rowId!, columnId!));
        if (!value || value.type === 'blank') line.push(null);
        else if (value.type === 'number') line.push(value.value);
        else if (value.type === 'boolean') line.push(value.value ? 'TRUE' : 'FALSE');
        else line.push(String(value.value));
        continue;
      }
      const value = cell.value;
      if (value === undefined || value === null || value === '') line.push(null);
      else if (typeof value === 'number') line.push(value);
      else if (typeof value === 'boolean') line.push(value ? 'TRUE' : 'FALSE');
      else line.push(value);
    }
    grid.push(line);
  }
  return { worksheet, grid };
}

/** A grid value as table text. */
export function snapshotText(value: SnapshotValue): string {
  if (value === null) return '';
  return typeof value === 'number' ? formatNumber(value) : value;
}

export interface ChartData {
  categories: string[];
  series: Array<{ name: string; values: number[] }>;
  /** Cells that were not numbers and were drawn as 0. */
  nonNumeric: number;
}

const isNumber = (value: SnapshotValue): value is number =>
  typeof value === 'number' && Number.isFinite(value);

/**
 * A grid as chart data, the way spreadsheet charts read a range: the first
 * row names the series and the first column names the categories — each only
 * when it holds text rather than numbers. Series run down the columns.
 */
export function gridToChartData(grid: SnapshotValue[][]): ChartData {
  if (grid.length === 0 || grid[0].length === 0) {
    return { categories: [], series: [], nonNumeric: 0 };
  }
  const headerRow = grid[0].slice(1).some((value) => value !== null && !isNumber(value));
  const headerColumn = grid
    .slice(headerRow ? 1 : 0)
    .some((row) => row[0] !== null && !isNumber(row[0]));
  const body = grid.slice(headerRow ? 1 : 0);
  const firstValueColumn = headerColumn ? 1 : 0;
  const columnCount = grid[0].length - firstValueColumn;
  let nonNumeric = 0;
  const series = Array.from(
    { length: Math.min(columnCount, DECK_LIMITS.chartSeries) },
    (_, index) => {
      const column = firstValueColumn + index;
      const header = headerRow ? grid[0][column] : null;
      return {
        name:
          header !== null && header !== undefined ? snapshotText(header) : `Series ${index + 1}`,
        values: body.slice(0, DECK_LIMITS.chartPointsPerSeries).map((row) => {
          const value = row[column];
          if (isNumber(value)) return value;
          if (value !== null && value !== undefined) nonNumeric += 1;
          return 0;
        }),
      };
    },
  );
  const categories = body
    .slice(0, DECK_LIMITS.chartPointsPerSeries)
    .map((row, index) => (headerColumn ? snapshotText(row[0] ?? null) : String(index + 1)));
  return { categories, series, nonNumeric };
}

/**
 * New chart data on an existing chart. Series keep their ids and colours
 * when a series of the same name (or, failing that, position) existed.
 */
export function applyChartData(
  chart: DeckChartElement,
  data: Pick<ChartData, 'categories' | 'series'>,
  nextId: (prefix: string) => string,
): DeckChartElement {
  const byName = new Map(chart.series.map((series) => [series.name, series]));
  const used = new Set<string>();
  const series: DeckChartSeries[] = data.series.map((entry, index) => {
    const previous =
      (byName.has(entry.name) && !used.has(byName.get(entry.name)!.id)
        ? byName.get(entry.name)
        : undefined) ??
      (chart.series[index] && !used.has(chart.series[index].id) ? chart.series[index] : undefined);
    if (previous) used.add(previous.id);
    return {
      id: previous?.id ?? nextId('series'),
      name: entry.name.slice(0, DECK_LIMITS.nameLength),
      values: entry.values.map((value) => (Number.isFinite(value) ? value : 0)),
      ...(previous?.color ? { color: previous.color } : {}),
    };
  });
  return {
    ...chart,
    categories: data.categories.map((category) => category.slice(0, DECK_LIMITS.nameLength)),
    series,
  };
}
