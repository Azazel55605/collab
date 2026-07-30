import type { SheetCell, SheetDocument, SheetWorksheet } from '../../types/sheet';
import { sheetCellKey } from '../../types/sheet';
import { columnIndex, columnLabel } from './address';
import { expandNamedRangesInFormula } from './namedRanges';

export interface ParsedFormulaEndpoint {
  column: number;
  row: number;
  absoluteColumn: boolean;
  absoluteRow: boolean;
}

export interface ParsedFormulaReference {
  start: number;
  end: number;
  source: string;
  sheetName: string | null;
  first: ParsedFormulaEndpoint;
  last: ParsedFormulaEndpoint | null;
}

const REFERENCE = /^(?:(?:'((?:[^']|'')+)'|([A-Za-z_][A-Za-z0-9_.]*))!)?(\$?)([A-Za-z]{1,3})(\$?)([1-9]\d*)(?::(\$?)([A-Za-z]{1,3})(\$?)([1-9]\d*))?/;

function identifierCharacter(character: string | undefined): boolean {
  return Boolean(character && /[A-Za-z0-9_.]/.test(character));
}

/**
 * Tokenizes only A1 references. Quoted formula strings are skipped, so text
 * such as `"A1"` is never mistaken for a dependency.
 */
export function parseFormulaReferences(formula: string): ParsedFormulaReference[] {
  const references: ParsedFormulaReference[] = [];
  let index = formula.startsWith('=') ? 1 : 0;
  let quoted = false;
  while (index < formula.length) {
    if (formula[index] === '"') {
      if (quoted && formula[index + 1] === '"') {
        index += 2;
        continue;
      }
      quoted = !quoted;
      index += 1;
      continue;
    }
    if (quoted || identifierCharacter(formula[index - 1])) {
      index += 1;
      continue;
    }
    const match = REFERENCE.exec(formula.slice(index));
    if (!match || identifierCharacter(formula[index + match[0].length])) {
      index += 1;
      continue;
    }
    const firstColumn = columnIndex(match[4]);
    const lastColumn = match[8] ? columnIndex(match[8]) : null;
    if (firstColumn === null || (match[8] && lastColumn === null)) {
      index += 1;
      continue;
    }
    references.push({
      start: index,
      end: index + match[0].length,
      source: match[0],
      sheetName: match[1]?.replace(/''/g, "'") ?? match[2] ?? null,
      first: {
        column: firstColumn,
        row: Number.parseInt(match[6], 10) - 1,
        absoluteColumn: match[3] === '$',
        absoluteRow: match[5] === '$',
      },
      last: match[8] ? {
        column: lastColumn!,
        row: Number.parseInt(match[10], 10) - 1,
        absoluteColumn: match[7] === '$',
        absoluteRow: match[9] === '$',
      } : null,
    });
    index += match[0].length;
  }
  return references;
}

function worksheetByName(document: SheetDocument, name: string): SheetWorksheet | null {
  return document.worksheets.find(
    (worksheet) => worksheet.name.toLocaleLowerCase() === name.toLocaleLowerCase(),
  ) ?? null;
}

function sheetPrefix(name: string): string {
  return /^[A-Za-z_][A-Za-z0-9_.]*$/.test(name)
    ? `${name}!`
    : `'${name.replace(/'/g, "''")}'!`;
}

function endpointText(endpoint: ParsedFormulaEndpoint, row: number, column: number): string {
  return `${endpoint.absoluteColumn ? '$' : ''}${columnLabel(column)}${endpoint.absoluteRow ? '$' : ''}${row + 1}`;
}

function survivingRange(
  before: SheetWorksheet,
  after: SheetWorksheet,
  first: ParsedFormulaEndpoint,
  last: ParsedFormulaEndpoint,
): { first: { row: number; column: number }; last: { row: number; column: number } } | null {
  const top = Math.min(first.row, last.row);
  const bottom = Math.max(first.row, last.row);
  const left = Math.min(first.column, last.column);
  const right = Math.max(first.column, last.column);
  const rows = before.rowOrder
    .slice(top, bottom + 1)
    .map((id) => after.rowOrder.indexOf(id))
    .filter((position) => position >= 0);
  const columns = before.columnOrder
    .slice(left, right + 1)
    .map((id) => after.columnOrder.indexOf(id))
    .filter((position) => position >= 0);
  if (rows.length === 0 || columns.length === 0) return null;
  return {
    first: { row: Math.min(...rows), column: Math.min(...columns) },
    last: { row: Math.max(...rows), column: Math.max(...columns) },
  };
}

function rewriteFormula(
  formula: string,
  sourceWorksheetId: string,
  before: SheetDocument,
  after: SheetDocument,
): string {
  const sourceBefore = before.worksheets.find((worksheet) => worksheet.id === sourceWorksheetId);
  if (!sourceBefore) return formula;
  const references = parseFormulaReferences(formula);
  if (references.length === 0) return formula;
  let output = '';
  let cursor = 0;
  for (const reference of references) {
    output += formula.slice(cursor, reference.start);
    const targetBefore = reference.sheetName
      ? worksheetByName(before, reference.sheetName)
      : sourceBefore;
    const targetAfter = targetBefore
      ? after.worksheets.find((worksheet) => worksheet.id === targetBefore.id)
      : null;
    if (!targetBefore || !targetAfter) {
      output += '#REF!';
      cursor = reference.end;
      continue;
    }
    const prefix = reference.sheetName ? sheetPrefix(targetAfter.name) : '';
    if (reference.last) {
      const range = survivingRange(targetBefore, targetAfter, reference.first, reference.last);
      output += range
        ? `${prefix}${endpointText(reference.first, range.first.row, range.first.column)}:${endpointText(reference.last, range.last.row, range.last.column)}`
        : '#REF!';
    } else {
      const rowId = targetBefore.rowOrder[reference.first.row];
      const columnId = targetBefore.columnOrder[reference.first.column];
      const row = rowId ? targetAfter.rowOrder.indexOf(rowId) : -1;
      const column = columnId ? targetAfter.columnOrder.indexOf(columnId) : -1;
      output += row >= 0 && column >= 0
        ? `${prefix}${endpointText(reference.first, row, column)}`
        : '#REF!';
    }
    cursor = reference.end;
  }
  return output + formula.slice(cursor);
}

/**
 * Rewrites every formula from stable identities after a structural mutation.
 * Literal cells are shared; only formula cells whose source changed are copied.
 */
export function rewriteDocumentFormulaReferences(
  before: SheetDocument,
  after: SheetDocument,
): SheetDocument {
  let changed = false;
  const worksheets = after.worksheets.map((worksheet) => {
    let worksheetChanged = false;
    const cells: Record<string, SheetCell> = { ...worksheet.cells };
    for (const [key, cell] of Object.entries(worksheet.cells)) {
      if (!cell.formula) continue;
      const formula = rewriteFormula(cell.formula, worksheet.id, before, after);
      if (formula === cell.formula) continue;
      cells[key] = { ...cell, formula };
      worksheetChanged = true;
    }
    if (!worksheetChanged) return worksheet;
    changed = true;
    return { ...worksheet, cells };
  });
  return changed ? { ...after, worksheets } : after;
}

/** Applies copy/fill offsets while respecting absolute and mixed references. */
export function translateFormulaReferences(
  formula: string,
  rowDelta: number,
  columnDelta: number,
): string {
  const references = parseFormulaReferences(formula);
  if (references.length === 0) return formula;
  let output = '';
  let cursor = 0;
  for (const reference of references) {
    output += formula.slice(cursor, reference.start);
    const translate = (endpoint: ParsedFormulaEndpoint) => ({
      row: endpoint.row + (endpoint.absoluteRow ? 0 : rowDelta),
      column: endpoint.column + (endpoint.absoluteColumn ? 0 : columnDelta),
    });
    const first = translate(reference.first);
    const last = reference.last ? translate(reference.last) : null;
    if (first.row < 0 || first.column < 0 || (last && (last.row < 0 || last.column < 0))) {
      output += '#REF!';
    } else {
      const prefix = reference.sheetName ? sheetPrefix(reference.sheetName) : '';
      output += `${prefix}${endpointText(reference.first, first.row, first.column)}`;
      if (reference.last && last) {
        output += `:${endpointText(reference.last, last.row, last.column)}`;
      }
    }
    cursor = reference.end;
  }
  return output + formula.slice(cursor);
}

export interface SheetFormulaDependency {
  worksheetId: string;
  rowId: string;
  columnId: string;
}

/** Expands precedents to stable cell identities for inspection/highlighting. */
export function formulaPrecedents(
  document: SheetDocument,
  sourceWorksheetId: string,
  formula: string,
  limit = 10_000,
): SheetFormulaDependency[] {
  const source = document.worksheets.find((worksheet) => worksheet.id === sourceWorksheetId);
  if (!source) return [];
  const found = new Map<string, SheetFormulaDependency>();
  for (const reference of parseFormulaReferences(
    expandNamedRangesInFormula(document, sourceWorksheetId, formula),
  )) {
    const target = reference.sheetName ? worksheetByName(document, reference.sheetName) : source;
    if (!target) continue;
    const last = reference.last ?? reference.first;
    const top = Math.max(0, Math.min(reference.first.row, last.row));
    const bottom = Math.min(target.rowOrder.length - 1, Math.max(reference.first.row, last.row));
    const left = Math.max(0, Math.min(reference.first.column, last.column));
    const right = Math.min(
      target.columnOrder.length - 1,
      Math.max(reference.first.column, last.column),
    );
    for (let row = top; row <= bottom; row += 1) {
      for (let column = left; column <= right; column += 1) {
        const rowId = target.rowOrder[row];
        const columnId = target.columnOrder[column];
        if (!rowId || !columnId) continue;
        const key = `${target.id}:${sheetCellKey(rowId, columnId)}`;
        found.set(key, { worksheetId: target.id, rowId, columnId });
        if (found.size >= limit) return [...found.values()];
      }
    }
  }
  return [...found.values()];
}

/** Bounded dependent inspection without expanding large referenced ranges. */
export function formulaDependsOn(
  document: SheetDocument,
  sourceWorksheetId: string,
  formula: string,
  target: SheetFormulaDependency,
): boolean {
  const source = document.worksheets.find((worksheet) => worksheet.id === sourceWorksheetId);
  const targetWorksheet = document.worksheets.find(
    (worksheet) => worksheet.id === target.worksheetId,
  );
  if (!source || !targetWorksheet) return false;
  const targetRow = targetWorksheet.rowOrder.indexOf(target.rowId);
  const targetColumn = targetWorksheet.columnOrder.indexOf(target.columnId);
  if (targetRow < 0 || targetColumn < 0) return false;
  return parseFormulaReferences(
    expandNamedRangesInFormula(document, sourceWorksheetId, formula),
  ).some((reference) => {
    const referencedWorksheet = reference.sheetName
      ? worksheetByName(document, reference.sheetName)
      : source;
    if (referencedWorksheet?.id !== target.worksheetId) return false;
    const last = reference.last ?? reference.first;
    return targetRow >= Math.min(reference.first.row, last.row)
      && targetRow <= Math.max(reference.first.row, last.row)
      && targetColumn >= Math.min(reference.first.column, last.column)
      && targetColumn <= Math.max(reference.first.column, last.column);
  });
}
