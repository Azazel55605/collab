import { SHEET_LIMITS } from '../../types/sheet';
import type {
  SheetConditionalFormat,
  SheetConditionalFormatKind,
  SheetDocument,
  SheetRange,
  SheetStyle,
  SheetWorksheet,
} from '../../types/sheet';
import type { SheetFormulaValueMap } from '../../types/sheetFormula';
import { sheetFormulaResultKey } from '../../types/sheetFormula';

import type { SheetPosition } from './address';
import { createSheetConditionalFormatId, SheetDocumentError } from './document';
import { conditionalFormulaExpressionId, ruleFormulaValue } from './formulaRules';
import { getCell } from './operations';
import { normalizeRange, type SheetSelection } from './selection';
import { pruneUnusedSheetStyles, registerSheetStyle } from './styles';
import { stableRangeFromSelection } from './validation';

const MAX_CONDITIONAL_FORMAT_CELLS = 100_000;

export interface SheetConditionalFormatDraft {
  kind: SheetConditionalFormatKind;
  operator?: SheetConditionalFormat['operator'];
  values?: (string | number)[];
  formula?: string;
  style?: SheetStyle;
  colorScale?: SheetConditionalFormat['colorScale'];
}

function cellCount(selection: SheetSelection): number {
  return selection.ranges.reduce((total, range) => {
    const rectangle = normalizeRange(range);
    return total + (rectangle.bottom - rectangle.top + 1) * (rectangle.right - rectangle.left + 1);
  }, 0);
}

export function applySheetConditionalFormat(
  document: SheetDocument,
  worksheetId: string,
  selection: SheetSelection,
  draft: SheetConditionalFormatDraft,
): SheetDocument {
  const worksheet = document.worksheets.find((candidate) => candidate.id === worksheetId);
  if (!worksheet) return document;
  if ((worksheet.conditionalFormats?.length ?? 0) >= SHEET_LIMITS.conditionalFormatsPerWorksheet) {
    throw new SheetDocumentError(
      'limit-exceeded',
      `A worksheet may not have more than ${SHEET_LIMITS.conditionalFormatsPerWorksheet} conditional formats.`,
    );
  }
  if (cellCount(selection) > MAX_CONDITIONAL_FORMAT_CELLS) {
    throw new SheetDocumentError(
      'limit-exceeded',
      `Conditional formatting is limited to ${MAX_CONDITIONAL_FORMAT_CELLS.toLocaleString()} selected cells.`,
    );
  }
  if (draft.kind === 'formula' && cellCount(selection) > 10_000) {
    throw new SheetDocumentError(
      'limit-exceeded',
      'Formula-based formatting is limited to 10,000 cells per rule.',
    );
  }
  const ranges = selection.ranges.flatMap((_, index) => {
    const selected = stableRangeFromSelection(worksheet, {
      ...selection,
      ranges: [selection.ranges[index]],
    });
    return selected ? [selected] : [];
  });
  if (ranges.length === 0) return document;

  const registered = draft.style
    ? registerSheetStyle(document, draft.style)
    : { document, styleId: undefined };
  const rule: SheetConditionalFormat = {
    id: createSheetConditionalFormatId(),
    kind: draft.kind,
    ranges,
    operator: draft.operator,
    values: draft.values,
    formula: draft.formula,
    styleId: registered.styleId,
    colorScale: draft.colorScale,
  };
  return {
    ...registered.document,
    worksheets: registered.document.worksheets.map((candidate) =>
      candidate.id === worksheetId
        ? { ...candidate, conditionalFormats: [...(candidate.conditionalFormats ?? []), rule] }
        : candidate,
    ),
  };
}

export function removeSheetConditionalFormat(
  document: SheetDocument,
  worksheetId: string,
  formatId: string,
): SheetDocument {
  const next = {
    ...document,
    worksheets: document.worksheets.map((worksheet) => {
      if (worksheet.id !== worksheetId) return worksheet;
      const conditionalFormats = (worksheet.conditionalFormats ?? []).filter(
        (format) => format.id !== formatId,
      );
      if (conditionalFormats.length === (worksheet.conditionalFormats?.length ?? 0))
        return worksheet;
      const updated = { ...worksheet };
      if (conditionalFormats.length > 0) updated.conditionalFormats = conditionalFormats;
      else delete updated.conditionalFormats;
      return updated;
    }),
  };
  return pruneUnusedSheetStyles(next);
}

function rangeRectangle(
  worksheet: SheetWorksheet,
  range: SheetRange,
): { top: number; bottom: number; left: number; right: number } | null {
  const top = worksheet.rowOrder.indexOf(range.startRowId);
  const bottom = worksheet.rowOrder.indexOf(range.endRowId);
  const left = worksheet.columnOrder.indexOf(range.startColumnId);
  const right = worksheet.columnOrder.indexOf(range.endColumnId);
  if (top < 0 || bottom < 0 || left < 0 || right < 0) return null;
  return {
    top: Math.min(top, bottom),
    bottom: Math.max(top, bottom),
    left: Math.min(left, right),
    right: Math.max(left, right),
  };
}

function valueAt(
  worksheet: SheetWorksheet,
  position: SheetPosition,
  computedValues?: SheetFormulaValueMap,
): string | number | boolean | null {
  const rowId = worksheet.rowOrder[position.row];
  const columnId = worksheet.columnOrder[position.column];
  const computed =
    rowId && columnId
      ? computedValues?.get(sheetFormulaResultKey(worksheet.id, rowId, columnId))
      : undefined;
  if (computed?.type === 'number' || computed?.type === 'text' || computed?.type === 'boolean') {
    return computed.value;
  }
  return getCell(worksheet, position)?.value ?? null;
}

function compare(value: string | number | boolean | null, rule: SheetConditionalFormat): boolean {
  const first = rule.values?.[0];
  const second = rule.values?.[1];
  if (rule.operator === 'contains') {
    return String(value ?? '')
      .toLocaleLowerCase()
      .includes(String(first ?? '').toLocaleLowerCase());
  }
  const left = typeof value === 'number' ? value : String(value ?? '');
  const right = typeof left === 'number' ? Number(first) : String(first ?? '');
  if (rule.operator === 'equal') return left === right;
  if (rule.operator === 'notEqual') return left !== right;
  if (rule.operator === 'greater') return left > right;
  if (rule.operator === 'greaterOrEqual') return left >= right;
  if (rule.operator === 'less') return left < right;
  if (rule.operator === 'lessOrEqual') return left <= right;
  if (rule.operator === 'between') {
    const upper = typeof left === 'number' ? Number(second) : String(second ?? '');
    return left >= right && left <= upper;
  }
  return false;
}

function valueKey(value: string | number | boolean | null): string | null {
  return value === null || value === '' ? null : `${typeof value}:${String(value)}`;
}

function parseHex(color: string): [number, number, number] | null {
  const match = /^#([0-9a-f]{6})$/i.exec(color);
  return match
    ? [
        Number.parseInt(match[1].slice(0, 2), 16),
        Number.parseInt(match[1].slice(2, 4), 16),
        Number.parseInt(match[1].slice(4, 6), 16),
      ]
    : null;
}

function interpolateColor(from: string, to: string, amount: number): string {
  const start = parseHex(from);
  const end = parseHex(to);
  if (!start || !end) return amount < 0.5 ? from : to;
  const channel = (index: number) =>
    Math.round(start[index] + (end[index] - start[index]) * amount);
  return `rgb(${channel(0)}, ${channel(1)}, ${channel(2)})`;
}

interface PreparedRule {
  rule: SheetConditionalFormat;
  rectangles: NonNullable<ReturnType<typeof rangeRectangle>>[];
  counts: Map<string, number>;
  minimum?: number;
  maximum?: number;
}

export function createConditionalFormatEvaluator(
  styles: SheetDocument['styles'],
  worksheet: SheetWorksheet,
  computedValues?: SheetFormulaValueMap,
): (position: SheetPosition) => SheetStyle {
  const prepared: PreparedRule[] = (worksheet.conditionalFormats ?? []).map((rule) => {
    const rectangles = rule.ranges.flatMap((range) => {
      const rectangle = rangeRectangle(worksheet, range);
      return rectangle ? [rectangle] : [];
    });
    const counts = new Map<string, number>();
    let minimum: number | undefined;
    let maximum: number | undefined;
    if (
      rule.kind === 'duplicateValues' ||
      rule.kind === 'uniqueValues' ||
      rule.kind === 'colorScale'
    ) {
      let visited = 0;
      for (const rectangle of rectangles) {
        for (let row = rectangle.top; row <= rectangle.bottom; row += 1) {
          for (let column = rectangle.left; column <= rectangle.right; column += 1) {
            visited += 1;
            if (visited > MAX_CONDITIONAL_FORMAT_CELLS) break;
            const value = valueAt(worksheet, { row, column }, computedValues);
            const key = valueKey(value);
            if (key) counts.set(key, (counts.get(key) ?? 0) + 1);
            if (typeof value === 'number') {
              minimum = minimum === undefined ? value : Math.min(minimum, value);
              maximum = maximum === undefined ? value : Math.max(maximum, value);
            }
          }
          if (visited > MAX_CONDITIONAL_FORMAT_CELLS) break;
        }
        if (visited > MAX_CONDITIONAL_FORMAT_CELLS) break;
      }
    }
    return { rule, rectangles, counts, minimum, maximum };
  });

  return (position) => {
    let result: SheetStyle = {};
    for (const item of prepared) {
      if (
        !item.rectangles.some(
          (rectangle) =>
            position.row >= rectangle.top &&
            position.row <= rectangle.bottom &&
            position.column >= rectangle.left &&
            position.column <= rectangle.right,
        )
      )
        continue;
      const value = valueAt(worksheet, position, computedValues);
      let matches = false;
      if (item.rule.kind === 'comparison') matches = compare(value, item.rule);
      if (item.rule.kind === 'formula') {
        const computed = ruleFormulaValue(
          computedValues,
          worksheet,
          conditionalFormulaExpressionId(item.rule.id, worksheet, position),
        );
        matches =
          computed?.type === 'boolean'
            ? computed.value
            : computed?.type === 'number' && computed.value !== 0;
      }
      if (item.rule.kind === 'duplicateValues' || item.rule.kind === 'uniqueValues') {
        const count = item.counts.get(valueKey(value) ?? '') ?? 0;
        matches = item.rule.kind === 'duplicateValues' ? count > 1 : count === 1;
      }
      if (item.rule.kind === 'colorScale' && typeof value === 'number') {
        const stops = item.rule.colorScale ?? [];
        const first = stops[0];
        const last = stops[stops.length - 1];
        if (first && last && item.minimum !== undefined && item.maximum !== undefined) {
          const amount =
            item.maximum === item.minimum
              ? 0.5
              : Math.max(0, Math.min(1, (value - item.minimum) / (item.maximum - item.minimum)));
          result = {
            ...result,
            backgroundColor: interpolateColor(first.color, last.color, amount),
          };
        }
      } else if (matches && item.rule.styleId && styles[item.rule.styleId]) {
        result = { ...result, ...styles[item.rule.styleId] };
      }
    }
    return result;
  };
}
