import { SHEET_LIMITS } from '../../types/sheet';
import type { SheetCell, SheetDocument, SheetWorksheet } from '../../types/sheet';
import type { SheetPosition } from './address';
import { SheetDocumentError } from './document';
import { translateFormulaReferences } from './formulaReferences';
import { getCell, mergedRangeAt, setCell } from './operations';
import {
  createSelection,
  normalizeRange,
  rectangleContains,
  type SheetRectangle,
  type SheetSelection,
} from './selection';
import {
  applyStyleToSelection,
  clearStylesFromSelection,
  resolveCellStyle,
} from './styles';

export interface SheetFillResult {
  document: SheetDocument;
  selection: SheetSelection;
}

function positiveModulo(value: number, divisor: number): number {
  return ((value % divisor) + divisor) % divisor;
}

function expandedRectangle(source: SheetRectangle, target: SheetPosition): SheetRectangle {
  return {
    top: Math.min(source.top, target.row),
    left: Math.min(source.left, target.column),
    bottom: Math.max(source.bottom, target.row),
    right: Math.max(source.right, target.column),
  };
}

function numericSeries(
  worksheet: SheetWorksheet,
  source: SheetRectangle,
  axis: 'row' | 'column',
): { first: number; step: number; origin: number } | null {
  const length = axis === 'row'
    ? source.bottom - source.top + 1
    : source.right - source.left + 1;
  if (length < 2) return null;
  const values: number[] = [];
  for (let offset = 0; offset < length; offset += 1) {
    const position = axis === 'row'
      ? { row: source.top + offset, column: source.left }
      : { row: source.top, column: source.left + offset };
    const cell = getCell(worksheet, position);
    if (typeof cell?.value !== 'number' || cell.formula) return null;
    values.push(cell.value);
  }
  const step = values[1] - values[0];
  if (values.some((value, index) => index > 0 && value !== values[0] + step * index)) return null;
  return { first: values[0], step, origin: axis === 'row' ? source.top : source.left };
}

function dateSeries(
  worksheet: SheetWorksheet,
  source: SheetRectangle,
  axis: 'row' | 'column',
): { first: number; step: number; origin: number; valueType: SheetCell['valueType'] } | null {
  const length = axis === 'row'
    ? source.bottom - source.top + 1
    : source.right - source.left + 1;
  if (length < 2) return null;
  const values: number[] = [];
  let valueType: SheetCell['valueType'];
  for (let offset = 0; offset < length; offset += 1) {
    const position = axis === 'row'
      ? { row: source.top + offset, column: source.left }
      : { row: source.top, column: source.left + offset };
    const cell = getCell(worksheet, position);
    if (cell?.formula || typeof cell?.value !== 'string'
      || (cell.valueType !== 'date' && cell.valueType !== 'datetime')) return null;
    valueType ??= cell.valueType;
    if (cell.valueType !== valueType) return null;
    const time = Date.parse(cell.valueType === 'date' ? `${cell.value}T00:00:00Z` : `${cell.value}Z`);
    if (!Number.isFinite(time)) return null;
    values.push(time);
  }
  const step = values[1] - values[0];
  if (values.some((value, index) => index > 0 && value !== values[0] + step * index)) return null;
  return {
    first: values[0],
    step,
    origin: axis === 'row' ? source.top : source.left,
    valueType,
  };
}

function seriesCell(
  worksheet: SheetWorksheet,
  source: SheetRectangle,
  destination: SheetPosition,
): SheetCell | null {
  const vertical = source.left === source.right
    && (destination.row < source.top || destination.row > source.bottom);
  const horizontal = source.top === source.bottom
    && (destination.column < source.left || destination.column > source.right);
  if (!vertical && !horizontal) return null;
  const axis = vertical ? 'row' : 'column';
  const coordinate = vertical ? destination.row : destination.column;
  const numeric = numericSeries(worksheet, source, axis);
  if (numeric) {
    return {
      value: numeric.first + numeric.step * (coordinate - numeric.origin),
      valueType: 'number',
    };
  }
  const date = dateSeries(worksheet, source, axis);
  if (date) {
    const next = new Date(date.first + date.step * (coordinate - date.origin));
    return {
      value: date.valueType === 'date'
        ? next.toISOString().slice(0, 10)
        : next.toISOString().replace(/Z$/, ''),
      valueType: date.valueType,
    };
  }
  return null;
}

function sourcePositionFor(
  source: SheetRectangle,
  destination: SheetPosition,
): SheetPosition {
  const rows = source.bottom - source.top + 1;
  const columns = source.right - source.left + 1;
  return {
    row: source.top + positiveModulo(destination.row - source.top, rows),
    column: source.left + positiveModulo(destination.column - source.left, columns),
  };
}

/** Extends the active selection through the target using spreadsheet fill semantics. */
export function fillSheetSelection(
  document: SheetDocument,
  worksheetId: string,
  selection: SheetSelection,
  target: SheetPosition,
): SheetFillResult {
  if (selection.kind !== 'cells' || selection.ranges.length === 0) {
    return { document, selection };
  }
  const worksheet = document.worksheets.find((candidate) => candidate.id === worksheetId);
  if (!worksheet) return { document, selection };
  const source = normalizeRange(selection.ranges[selection.ranges.length - 1]);
  if (rectangleContains(source, target)) return { document, selection };
  const expanded = expandedRectangle(source, target);
  const cellCount = (expanded.bottom - expanded.top + 1) * (expanded.right - expanded.left + 1);
  if (cellCount > SHEET_LIMITS.populatedCellsPerWorksheet) {
    throw new SheetDocumentError(
      'limit-exceeded',
      `Fill is limited to ${SHEET_LIMITS.populatedCellsPerWorksheet.toLocaleString()} cells at once.`,
    );
  }

  let next = document;
  for (let row = expanded.top; row <= expanded.bottom; row += 1) {
    for (let column = expanded.left; column <= expanded.right; column += 1) {
      const destination = { row, column };
      if (rectangleContains(source, destination)) continue;
      if (mergedRangeAt(worksheet, destination)) {
        throw new SheetDocumentError(
          'invalid-structure',
          'Unmerge destination cells before filling into them.',
        );
      }
      const sourcePosition = sourcePositionFor(source, destination);
      const sourceCell = getCell(worksheet, sourcePosition);
      const continued = seriesCell(worksheet, source, destination);
      let filledCell: SheetCell | null = continued;
      if (!filledCell && sourceCell) {
        const { styleId: _styleId, note: _note, ...content } = sourceCell;
        filledCell = { ...content };
        if (filledCell.formula) {
          filledCell.formula = translateFormulaReferences(
            filledCell.formula,
            destination.row - sourcePosition.row,
            destination.column - sourcePosition.column,
          );
        }
      }
      next = setCell(next, worksheetId, destination, filledCell);
      next = clearStylesFromSelection(next, worksheetId, createSelection(destination));
      const style = resolveCellStyle(document.styles, worksheet, sourcePosition);
      if (Object.keys(style).length > 0) {
        next = applyStyleToSelection(next, worksheetId, createSelection(destination), style);
      }
    }
  }

  return {
    document: next,
    selection: {
      ranges: [{
        anchor: { row: expanded.top, column: expanded.left },
        focus: { row: expanded.bottom, column: expanded.right },
      }],
      active: selection.active,
      kind: 'cells',
    },
  };
}
