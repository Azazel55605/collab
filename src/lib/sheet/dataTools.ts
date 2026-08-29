import { SHEET_LIMITS, sheetCellKey } from '../../types/sheet';
import type {
  SheetCell,
  SheetColumnFilter,
  SheetDocument,
  SheetSortRule,
  SheetTable,
  SheetWorksheet,
} from '../../types/sheet';
import type { SheetFormulaComputedValue, SheetFormulaValueMap } from '../../types/sheetFormula';
import { sheetFormulaResultKey } from '../../types/sheetFormula';

import type { SheetPosition } from './address';
import { formatCellEditText } from './cellValue';
import { createSheetTableColumnId, createSheetTableId, SheetDocumentError } from './document';
import { translateFormulaReferences } from './formulaReferences';
import { getCell } from './operations';
import { normalizeRange, type SheetRectangle, type SheetSelection } from './selection';
import { resolveCellStyle } from './styles';

export function tableRectangle(
  worksheet: SheetWorksheet,
  table: SheetTable,
): SheetRectangle | null {
  const top = worksheet.rowOrder.indexOf(table.range.startRowId);
  const bottom = worksheet.rowOrder.indexOf(table.range.endRowId);
  const left = worksheet.columnOrder.indexOf(table.range.startColumnId);
  const right = worksheet.columnOrder.indexOf(table.range.endColumnId);
  if (top < 0 || bottom < 0 || left < 0 || right < 0) return null;
  return {
    top: Math.min(top, bottom),
    bottom: Math.max(top, bottom),
    left: Math.min(left, right),
    right: Math.max(left, right),
  };
}

function rectanglesOverlap(left: SheetRectangle, right: SheetRectangle): boolean {
  return (
    left.top <= right.bottom &&
    left.bottom >= right.top &&
    left.left <= right.right &&
    left.right >= right.left
  );
}

function sameRange(left: SheetTable['range'], right: SheetTable['range']): boolean {
  return (
    left.startRowId === right.startRowId &&
    left.endRowId === right.endRowId &&
    left.startColumnId === right.startColumnId &&
    left.endColumnId === right.endColumnId
  );
}

export function tableAtPosition(
  worksheet: SheetWorksheet,
  position: SheetPosition,
): SheetTable | null {
  return (
    (worksheet.tables ?? []).find((table) => {
      const rectangle = tableRectangle(worksheet, table);
      return (
        rectangle &&
        position.row >= rectangle.top &&
        position.row <= rectangle.bottom &&
        position.column >= rectangle.left &&
        position.column <= rectangle.right
      );
    }) ?? null
  );
}

function uniqueHeaderNames(
  worksheet: SheetWorksheet,
  rectangle: SheetRectangle,
  hasHeaderRow: boolean,
): string[] {
  const used = new Set<string>();
  return Array.from({ length: rectangle.right - rectangle.left + 1 }, (_, offset) => {
    const raw = hasHeaderRow
      ? formatCellEditText(
          getCell(worksheet, {
            row: rectangle.top,
            column: rectangle.left + offset,
          }),
        ).trim()
      : '';
    const base = raw || `Column ${offset + 1}`;
    let name = base;
    let suffix = 2;
    while (used.has(name.toLocaleLowerCase())) {
      name = `${base} ${suffix}`;
      suffix += 1;
    }
    used.add(name.toLocaleLowerCase());
    return name;
  });
}

export function createSheetTable(
  document: SheetDocument,
  worksheetId: string,
  selection: SheetSelection,
  name: string,
  hasHeaderRow = true,
): SheetDocument {
  const worksheet = document.worksheets.find((candidate) => candidate.id === worksheetId);
  if (!worksheet) return document;
  if (selection.kind !== 'cells' || selection.ranges.length !== 1) {
    throw new SheetDocumentError(
      'invalid-structure',
      'Select one rectangular cell range for the table.',
    );
  }
  if ((worksheet.tables?.length ?? 0) >= SHEET_LIMITS.tablesPerWorksheet) {
    throw new SheetDocumentError(
      'limit-exceeded',
      `A worksheet may not have more than ${SHEET_LIMITS.tablesPerWorksheet} tables.`,
    );
  }
  const trimmedName = name.trim();
  if (!trimmedName)
    throw new SheetDocumentError('invalid-structure', 'Table names cannot be empty.');
  if (
    (worksheet.tables ?? []).some(
      (table) => table.name.toLocaleLowerCase() === trimmedName.toLocaleLowerCase(),
    )
  ) {
    throw new SheetDocumentError(
      'invalid-structure',
      'Table names must be unique within a worksheet.',
    );
  }

  const rectangle = normalizeRange(selection.ranges[0]);
  for (const merge of worksheet.mergedRanges ?? []) {
    const top = worksheet.rowOrder.indexOf(merge.startRowId);
    const bottom = worksheet.rowOrder.indexOf(merge.endRowId);
    const left = worksheet.columnOrder.indexOf(merge.startColumnId);
    const right = worksheet.columnOrder.indexOf(merge.endColumnId);
    if (
      top >= 0 &&
      bottom >= 0 &&
      left >= 0 &&
      right >= 0 &&
      rectanglesOverlap(rectangle, {
        top: Math.min(top, bottom),
        bottom: Math.max(top, bottom),
        left: Math.min(left, right),
        right: Math.max(left, right),
      })
    ) {
      throw new SheetDocumentError('invalid-structure', 'Unmerge cells before creating a table.');
    }
  }
  for (const table of worksheet.tables ?? []) {
    const existing = tableRectangle(worksheet, table);
    if (existing && rectanglesOverlap(rectangle, existing)) {
      throw new SheetDocumentError('invalid-structure', 'Tables cannot overlap.');
    }
  }

  const headers = uniqueHeaderNames(worksheet, rectangle, hasHeaderRow);
  const table: SheetTable = {
    id: createSheetTableId(),
    name: trimmedName,
    hasHeaderRow,
    range: {
      startRowId: worksheet.rowOrder[rectangle.top],
      endRowId: worksheet.rowOrder[rectangle.bottom],
      startColumnId: worksheet.columnOrder[rectangle.left],
      endColumnId: worksheet.columnOrder[rectangle.right],
    },
    columns: headers.map((header, offset) => ({
      id: createSheetTableColumnId(),
      name: header,
      columnId: worksheet.columnOrder[rectangle.left + offset],
    })),
  };
  return {
    ...document,
    worksheets: document.worksheets.map((candidate) =>
      candidate.id === worksheetId
        ? { ...candidate, tables: [...(candidate.tables ?? []), table] }
        : candidate,
    ),
  };
}

export function removeSheetTable(
  document: SheetDocument,
  worksheetId: string,
  tableId: string,
): SheetDocument {
  return {
    ...document,
    worksheets: document.worksheets.map((worksheet) => {
      if (worksheet.id !== worksheetId) return worksheet;
      const tables = (worksheet.tables ?? []).filter((table) => table.id !== tableId);
      if (tables.length === (worksheet.tables?.length ?? 0)) return worksheet;
      const next = { ...worksheet };
      if (tables.length > 0) next.tables = tables;
      else delete next.tables;
      if (
        worksheet.filters?.range &&
        !tables.some((table) => sameRange(table.range, worksheet.filters!.range!))
      ) {
        return clearFilterState(next);
      }
      return next;
    }),
  };
}

function formulaValue(
  worksheet: SheetWorksheet,
  position: SheetPosition,
  values?: SheetFormulaValueMap,
): SheetFormulaComputedValue | undefined {
  const rowId = worksheet.rowOrder[position.row];
  const columnId = worksheet.columnOrder[position.column];
  return rowId && columnId
    ? values?.get(sheetFormulaResultKey(worksheet.id, rowId, columnId))
    : undefined;
}

function comparableValue(
  worksheet: SheetWorksheet,
  position: SheetPosition,
  values?: SheetFormulaValueMap,
): string | number | boolean | null {
  const computed = formulaValue(worksheet, position, values);
  if (computed) {
    if (computed.type === 'blank' || computed.type === 'error') return null;
    return computed.value;
  }
  return getCell(worksheet, position)?.value ?? null;
}

function rank(value: string | number | boolean | null): number {
  if (value === null || value === '') return 4;
  if (typeof value === 'number') return 0;
  if (typeof value === 'boolean') return 1;
  const date = Date.parse(value);
  return Number.isFinite(date) && /^\d{4}-\d{2}-\d{2}/.test(value) ? 0 : 2;
}

function compareValues(
  left: string | number | boolean | null,
  right: string | number | boolean | null,
): number {
  const leftRank = rank(left);
  const rightRank = rank(right);
  if (leftRank !== rightRank) return leftRank - rightRank;
  if (left === right) return 0;
  if (left === null || left === '') return 1;
  if (right === null || right === '') return -1;
  if (typeof left === 'number' && typeof right === 'number') return left - right;
  if (typeof left === 'boolean' && typeof right === 'boolean') return Number(left) - Number(right);
  if (
    typeof left === 'string' &&
    typeof right === 'string' &&
    /^\d{4}-\d{2}-\d{2}/.test(left) &&
    /^\d{4}-\d{2}-\d{2}/.test(right)
  ) {
    return Date.parse(left) - Date.parse(right);
  }
  return String(left).localeCompare(String(right), undefined, {
    numeric: true,
    sensitivity: 'base',
  });
}

export function sortSheetTable(
  document: SheetDocument,
  worksheetId: string,
  tableId: string,
  rules: SheetSortRule[],
  computedValues?: SheetFormulaValueMap,
): SheetDocument {
  const worksheet = document.worksheets.find((candidate) => candidate.id === worksheetId);
  const table = worksheet?.tables?.find((candidate) => candidate.id === tableId);
  if (!worksheet || !table || rules.length === 0) return document;
  const rectangle = tableRectangle(worksheet, table);
  if (!rectangle) return document;
  const dataTop = rectangle.top + (table.hasHeaderRow ? 1 : 0);
  const rowIndices = Array.from(
    { length: Math.max(0, rectangle.bottom - dataTop + 1) },
    (_, index) => dataTop + index,
  );
  const validRules = rules.filter((rule) =>
    table.columns.some((column) => column.columnId === rule.columnId),
  );
  if (validRules.length === 0) return document;
  const originalOrder = new Map(rowIndices.map((row, index) => [row, index]));
  rowIndices.sort((leftRow, rightRow) => {
    for (const rule of validRules) {
      const column = worksheet.columnOrder.indexOf(rule.columnId);
      const compared = compareValues(
        comparableValue(worksheet, { row: leftRow, column }, computedValues),
        comparableValue(worksheet, { row: rightRow, column }, computedValues),
      );
      if (compared !== 0) return rule.direction === 'ascending' ? compared : -compared;
    }
    return (originalOrder.get(leftRow) ?? 0) - (originalOrder.get(rightRow) ?? 0);
  });

  const cells = { ...worksheet.cells };
  const snapshots = new Map<number, Map<string, SheetCell | undefined>>();
  for (const row of rowIndices) {
    snapshots.set(
      row,
      new Map(
        table.columns.map((column) => [
          column.columnId,
          worksheet.cells[sheetCellKey(worksheet.rowOrder[row], column.columnId)],
        ]),
      ),
    );
  }
  rowIndices.forEach((sourceRow, destinationOffset) => {
    const destinationRow = dataTop + destinationOffset;
    for (const column of table.columns) {
      const destinationKey = sheetCellKey(worksheet.rowOrder[destinationRow], column.columnId);
      const source = snapshots.get(sourceRow)?.get(column.columnId);
      if (!source) {
        delete cells[destinationKey];
        continue;
      }
      const next = { ...source };
      if (next.formula) {
        next.formula = translateFormulaReferences(next.formula, destinationRow - sourceRow, 0);
      }
      cells[destinationKey] = next;
    }
  });

  const nextWorksheet: SheetWorksheet = {
    ...worksheet,
    cells,
    filters: {
      ...worksheet.filters,
      range: table.range,
      sortRules: validRules,
    },
  };
  return {
    ...document,
    worksheets: document.worksheets.map((candidate) =>
      candidate.id === worksheetId
        ? applyFilterVisibility(nextWorksheet, document.styles, computedValues)
        : candidate,
    ),
  };
}

const MAX_CLEANUP_CELLS = 100_000;

function cleanupRectangle(selection: SheetSelection): SheetRectangle {
  if (selection.kind !== 'cells' || selection.ranges.length !== 1) {
    throw new SheetDocumentError('invalid-structure', 'Select one rectangular cell range.');
  }
  const rectangle = normalizeRange(selection.ranges[0]);
  const count = (rectangle.bottom - rectangle.top + 1) * (rectangle.right - rectangle.left + 1);
  if (count > MAX_CLEANUP_CELLS) {
    throw new SheetDocumentError(
      'limit-exceeded',
      `Cleanup is limited to ${MAX_CLEANUP_CELLS.toLocaleString()} cells at once.`,
    );
  }
  return rectangle;
}

export function trimSheetText(
  document: SheetDocument,
  worksheetId: string,
  selection: SheetSelection,
): SheetDocument {
  const worksheet = document.worksheets.find((candidate) => candidate.id === worksheetId);
  if (!worksheet) return document;
  const rectangle = cleanupRectangle(selection);
  let next = document;
  for (let row = rectangle.top; row <= rectangle.bottom; row += 1) {
    for (let column = rectangle.left; column <= rectangle.right; column += 1) {
      const cell = getCell(worksheet, { row, column });
      if (cell?.formula || typeof cell?.value !== 'string') continue;
      const value = cell.value
        .replace(/\u00a0/g, ' ')
        .trim()
        .replace(/[ \t]+/g, ' ');
      if (value !== cell.value) {
        next = {
          ...next,
          worksheets: next.worksheets.map((candidate) => {
            if (candidate.id !== worksheetId) return candidate;
            const key = sheetCellKey(candidate.rowOrder[row], candidate.columnOrder[column]);
            return { ...candidate, cells: { ...candidate.cells, [key]: { ...cell, value } } };
          }),
        };
      }
    }
  }
  return next;
}

export function splitSheetTextToColumns(
  document: SheetDocument,
  worksheetId: string,
  selection: SheetSelection,
  delimiter = ',',
): SheetDocument {
  if (!delimiter) throw new SheetDocumentError('invalid-structure', 'Choose a delimiter.');
  const worksheet = document.worksheets.find((candidate) => candidate.id === worksheetId);
  if (!worksheet) return document;
  const rectangle = cleanupRectangle(selection);
  if (rectangle.left !== rectangle.right) {
    throw new SheetDocumentError('invalid-structure', 'Select one column to split.');
  }
  let next = document;
  for (let row = rectangle.top; row <= rectangle.bottom; row += 1) {
    const source = getCell(worksheet, { row, column: rectangle.left });
    if (source?.formula || typeof source?.value !== 'string') continue;
    const parts = source.value.split(delimiter);
    if (rectangle.left + parts.length > worksheet.columnOrder.length) {
      throw new SheetDocumentError(
        'limit-exceeded',
        'The split result exceeds the worksheet columns.',
      );
    }
    for (const [offset, part] of parts.entries()) {
      const columnId = worksheet.columnOrder[rectangle.left + offset];
      const rowId = worksheet.rowOrder[row];
      const key = sheetCellKey(rowId, columnId);
      const target = next.worksheets.find((candidate) => candidate.id === worksheetId)!;
      const existing = target.cells[key];
      next = {
        ...next,
        worksheets: next.worksheets.map((candidate) =>
          candidate.id === worksheetId
            ? {
                ...candidate,
                cells: {
                  ...candidate.cells,
                  [key]: {
                    ...(existing ?? {}),
                    value: part.trim(),
                    valueType: 'text',
                    formula: undefined,
                  },
                },
              }
            : candidate,
        ),
      };
    }
  }
  return next;
}

export function removeDuplicateSheetRows(
  document: SheetDocument,
  worksheetId: string,
  selection: SheetSelection,
): SheetDocument {
  const worksheet = document.worksheets.find((candidate) => candidate.id === worksheetId);
  if (!worksheet) return document;
  const rectangle = cleanupRectangle(selection);
  const seen = new Set<string>();
  const uniqueRows: number[] = [];
  for (let row = rectangle.top; row <= rectangle.bottom; row += 1) {
    const signature = JSON.stringify(
      Array.from({ length: rectangle.right - rectangle.left + 1 }, (_, offset) =>
        formatCellEditText(
          getCell(worksheet, {
            row,
            column: rectangle.left + offset,
          }),
        ),
      ),
    );
    if (seen.has(signature)) continue;
    seen.add(signature);
    uniqueRows.push(row);
  }
  if (uniqueRows.length === rectangle.bottom - rectangle.top + 1) return document;
  const cells = { ...worksheet.cells };
  for (
    let destinationRow = rectangle.top;
    destinationRow <= rectangle.bottom;
    destinationRow += 1
  ) {
    const sourceRow = uniqueRows[destinationRow - rectangle.top];
    for (let column = rectangle.left; column <= rectangle.right; column += 1) {
      const destinationKey = sheetCellKey(
        worksheet.rowOrder[destinationRow],
        worksheet.columnOrder[column],
      );
      if (sourceRow === undefined) {
        const validationId = cells[destinationKey]?.validationId;
        if (validationId) cells[destinationKey] = { validationId };
        else delete cells[destinationKey];
        continue;
      }
      const source =
        worksheet.cells[sheetCellKey(worksheet.rowOrder[sourceRow], worksheet.columnOrder[column])];
      const validationId = cells[destinationKey]?.validationId;
      const moved = source
        ? { ...source, validationId }
        : validationId
          ? { validationId }
          : undefined;
      if (moved?.formula) {
        moved.formula = translateFormulaReferences(moved.formula, destinationRow - sourceRow, 0);
      }
      if (moved) cells[destinationKey] = moved;
      else delete cells[destinationKey];
    }
  }
  return {
    ...document,
    worksheets: document.worksheets.map((candidate) =>
      candidate.id === worksheetId ? { ...candidate, cells } : candidate,
    ),
  };
}

function filterValueMatches(
  value: string | number | boolean | null,
  filter: SheetColumnFilter,
  colors: { backgroundColor: string | null; textColor: string | null },
): boolean {
  const blank = value === null || value === '';
  if (filter.hideBlanks && blank) return false;
  if (filter.includeValues && !filter.includeValues.some((candidate) => candidate === value))
    return false;
  if (
    filter.textContains &&
    !String(value ?? '')
      .toLocaleLowerCase()
      .includes(filter.textContains.toLocaleLowerCase())
  )
    return false;
  if (filter.numberMin !== undefined && (typeof value !== 'number' || value < filter.numberMin))
    return false;
  if (filter.numberMax !== undefined && (typeof value !== 'number' || value > filter.numberMax))
    return false;
  if (filter.dateFrom && (typeof value !== 'string' || value < filter.dateFrom)) return false;
  if (filter.dateTo && (typeof value !== 'string' || value > filter.dateTo)) return false;
  if (filter.backgroundColors && !filter.backgroundColors.includes(colors.backgroundColor ?? '')) {
    return false;
  }
  if (filter.textColors && !filter.textColors.includes(colors.textColor ?? '')) return false;
  return true;
}

function applyFilterVisibility(
  worksheet: SheetWorksheet,
  styles: SheetDocument['styles'],
  computedValues?: SheetFormulaValueMap,
): SheetWorksheet {
  const rows = { ...(worksheet.rows ?? {}) };
  for (const rowId of worksheet.rowOrder) {
    const row = rows[rowId];
    if (!row?.filterHidden) continue;
    const { filterHidden: _filterHidden, ...rest } = row;
    if (Object.keys(rest).length > 1) rows[rowId] = rest;
    else delete rows[rowId];
  }
  const range = worksheet.filters?.range;
  const rectangle = range
    ? tableRectangle(worksheet, {
        id: '',
        name: '',
        range,
        hasHeaderRow: false,
        columns: [],
      })
    : null;
  if (rectangle) {
    const activeRange = range!;
    const table = worksheet.tables?.find((candidate) => sameRange(candidate.range, activeRange));
    const dataTop = rectangle.top + (table?.hasHeaderRow ? 1 : 0);
    for (let row = dataTop; row <= rectangle.bottom; row += 1) {
      const visible = (worksheet.filters?.columnFilters ?? []).every((filter) => {
        const column = worksheet.columnOrder.indexOf(filter.columnId);
        return (
          column >= 0 &&
          filterValueMatches(comparableValue(worksheet, { row, column }, computedValues), filter, {
            backgroundColor:
              resolveCellStyle(styles, worksheet, { row, column }).backgroundColor ?? null,
            textColor: resolveCellStyle(styles, worksheet, { row, column }).color ?? null,
          })
        );
      });
      if (!visible) {
        const rowId = worksheet.rowOrder[row];
        rows[rowId] = { ...(rows[rowId] ?? { id: rowId }), filterHidden: true };
      }
    }
  }
  const next = { ...worksheet };
  if (Object.keys(rows).length > 0) next.rows = rows;
  else delete next.rows;
  return next;
}

function clearFilterState(worksheet: SheetWorksheet): SheetWorksheet {
  const next = { ...worksheet };
  delete next.filters;
  return applyFilterVisibility(next, {});
}

export function setSheetTableColumnFilter(
  document: SheetDocument,
  worksheetId: string,
  tableId: string,
  columnId: string,
  filter: SheetColumnFilter | null,
  computedValues?: SheetFormulaValueMap,
): SheetDocument {
  return {
    ...document,
    worksheets: document.worksheets.map((worksheet) => {
      if (worksheet.id !== worksheetId) return worksheet;
      const table = worksheet.tables?.find((candidate) => candidate.id === tableId);
      if (!table) return worksheet;
      const filters = (worksheet.filters?.columnFilters ?? []).filter(
        (candidate) => candidate.columnId !== columnId,
      );
      if (filter) filters.push(filter);
      return applyFilterVisibility(
        {
          ...worksheet,
          filters: {
            ...worksheet.filters,
            range: table.range,
            columnFilters: filters,
          },
        },
        document.styles,
        computedValues,
      );
    }),
  };
}

export function clearSheetTableFilters(
  document: SheetDocument,
  worksheetId: string,
): SheetDocument {
  return {
    ...document,
    worksheets: document.worksheets.map((worksheet) =>
      worksheet.id === worksheetId ? clearFilterState(worksheet) : worksheet,
    ),
  };
}

export function uniqueTableColumnValues(
  worksheet: SheetWorksheet,
  table: SheetTable,
  columnId: string,
  computedValues?: SheetFormulaValueMap,
): Array<string | number | boolean | null> {
  const rectangle = tableRectangle(worksheet, table);
  const column = worksheet.columnOrder.indexOf(columnId);
  if (!rectangle || column < rectangle.left || column > rectangle.right) return [];
  const start = rectangle.top + (table.hasHeaderRow ? 1 : 0);
  const values: Array<string | number | boolean | null> = [];
  for (let row = start; row <= rectangle.bottom; row += 1) {
    const value = comparableValue(worksheet, { row, column }, computedValues);
    if (!values.some((candidate) => candidate === value)) values.push(value);
  }
  return values.sort(compareValues);
}

export interface SheetTableColumnColors {
  backgroundColors: string[];
  textColors: string[];
}

export function uniqueTableColumnColors(
  document: SheetDocument,
  worksheet: SheetWorksheet,
  table: SheetTable,
  columnId: string,
): SheetTableColumnColors {
  const rectangle = tableRectangle(worksheet, table);
  const column = worksheet.columnOrder.indexOf(columnId);
  if (!rectangle || column < rectangle.left || column > rectangle.right) {
    return { backgroundColors: [], textColors: [] };
  }
  const backgroundColors = new Set<string>();
  const textColors = new Set<string>();
  const start = rectangle.top + (table.hasHeaderRow ? 1 : 0);
  for (let row = start; row <= rectangle.bottom; row += 1) {
    const style = resolveCellStyle(document.styles, worksheet, { row, column });
    if (style.backgroundColor) backgroundColors.add(style.backgroundColor);
    if (style.color) textColors.add(style.color);
  }
  return {
    backgroundColors: [...backgroundColors].sort(),
    textColors: [...textColors].sort(),
  };
}
