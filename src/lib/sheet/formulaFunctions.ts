export interface SheetFunctionDefinition {
  name: string;
  signature: string;
  category: 'aggregate' | 'logic' | 'math' | 'text' | 'date' | 'lookup';
  note?: string;
}

/**
 * Phase 3 baseline. This is intentionally narrower than every function the
 * engine happens to expose, so autocomplete and compatibility claims stay
 * stable across engine upgrades.
 */
export const SHEET_FUNCTIONS: readonly SheetFunctionDefinition[] = [
  { name: 'SUM', signature: 'SUM(value, ...)', category: 'aggregate' },
  { name: 'AVERAGE', signature: 'AVERAGE(value, ...)', category: 'aggregate' },
  { name: 'MIN', signature: 'MIN(value, ...)', category: 'aggregate' },
  { name: 'MAX', signature: 'MAX(value, ...)', category: 'aggregate' },
  { name: 'COUNT', signature: 'COUNT(value, ...)', category: 'aggregate' },
  { name: 'COUNTA', signature: 'COUNTA(value, ...)', category: 'aggregate' },
  { name: 'SUMIF', signature: 'SUMIF(range, criteria, [sum_range])', category: 'aggregate' },
  {
    name: 'SUMIFS',
    signature: 'SUMIFS(sum_range, criteria_range, criteria, ...)',
    category: 'aggregate',
  },
  { name: 'COUNTIF', signature: 'COUNTIF(range, criteria)', category: 'aggregate' },
  { name: 'COUNTIFS', signature: 'COUNTIFS(criteria_range, criteria, ...)', category: 'aggregate' },
  {
    name: 'AVERAGEIF',
    signature: 'AVERAGEIF(range, criteria, [average_range])',
    category: 'aggregate',
  },
  {
    name: 'AVERAGEIFS',
    signature: 'AVERAGEIFS(average_range, criteria_range, criteria, ...)',
    category: 'aggregate',
  },
  { name: 'IF', signature: 'IF(condition, true_value, false_value)', category: 'logic' },
  { name: 'IFS', signature: 'IFS(condition, value, ...)', category: 'logic' },
  { name: 'AND', signature: 'AND(value, ...)', category: 'logic' },
  { name: 'OR', signature: 'OR(value, ...)', category: 'logic' },
  { name: 'NOT', signature: 'NOT(value)', category: 'logic' },
  { name: 'IFERROR', signature: 'IFERROR(value, fallback)', category: 'logic' },
  { name: 'ROUND', signature: 'ROUND(number, digits)', category: 'math' },
  { name: 'ABS', signature: 'ABS(number)', category: 'math' },
  { name: 'MOD', signature: 'MOD(number, divisor)', category: 'math' },
  { name: 'SQRT', signature: 'SQRT(number)', category: 'math' },
  { name: 'POWER', signature: 'POWER(number, power)', category: 'math' },
  {
    name: 'CONCAT',
    signature: 'CONCAT(text, ...)',
    category: 'text',
    note: 'Range arguments are currently unsupported.',
  },
  { name: 'LEFT', signature: 'LEFT(text, [count])', category: 'text' },
  { name: 'RIGHT', signature: 'RIGHT(text, [count])', category: 'text' },
  { name: 'MID', signature: 'MID(text, start, count)', category: 'text' },
  { name: 'LEN', signature: 'LEN(text)', category: 'text' },
  { name: 'TRIM', signature: 'TRIM(text)', category: 'text' },
  { name: 'DATE', signature: 'DATE(year, month, day)', category: 'date' },
  { name: 'YEAR', signature: 'YEAR(value)', category: 'date' },
  { name: 'MONTH', signature: 'MONTH(value)', category: 'date' },
  { name: 'DAY', signature: 'DAY(value)', category: 'date' },
  { name: 'TODAY', signature: 'TODAY()', category: 'date' },
  { name: 'NOW', signature: 'NOW()', category: 'date' },
  { name: 'INDEX', signature: 'INDEX(range, row, [column])', category: 'lookup' },
  { name: 'MATCH', signature: 'MATCH(value, range, [match_type])', category: 'lookup' },
  {
    name: 'VLOOKUP',
    signature: 'VLOOKUP(value, range, column, [approximate])',
    category: 'lookup',
  },
  { name: 'HLOOKUP', signature: 'HLOOKUP(value, range, row, [approximate])', category: 'lookup' },
  {
    name: 'XLOOKUP',
    signature: 'XLOOKUP(value, lookup_range, result_range, [missing])',
    category: 'lookup',
  },
] as const;

export function formulaAutocompleteQuery(value: string): string | null {
  return formulaAutocompleteContext(value, value.length)?.query ?? null;
}

export interface FormulaAutocompleteContext {
  query: string;
  start: number;
  end: number;
}

export function formulaAutocompleteContext(
  value: string,
  cursor: number,
): FormulaAutocompleteContext | null {
  if (!value.startsWith('=')) return null;
  const boundedCursor = Math.max(1, Math.min(cursor, value.length));
  const beforeCursor = value.slice(0, boundedCursor);
  const match = /([A-Za-z][A-Za-z0-9_.]*)$/.exec(beforeCursor);
  if (match) {
    return {
      query: match[1].toUpperCase(),
      start: boundedCursor - match[1].length,
      end: boundedCursor,
    };
  }
  if (/[=(,+\-*/^&]$/.test(beforeCursor)) {
    return { query: '', start: boundedCursor, end: boundedCursor };
  }
  return null;
}

export function activeFormulaFunction(
  value: string,
  cursor: number,
): SheetFunctionDefinition | null {
  if (!value.startsWith('=')) return null;
  const source = value.slice(0, Math.max(0, Math.min(cursor, value.length)));
  const stack: string[] = [];
  let quoted = false;
  for (let index = 1; index < source.length; index += 1) {
    const character = source[index];
    if (character === '"') {
      if (quoted && source[index + 1] === '"') {
        index += 1;
      } else {
        quoted = !quoted;
      }
      continue;
    }
    if (quoted) continue;
    if (character === '(') {
      const name = /([A-Za-z][A-Za-z0-9_.]*)\s*$/.exec(source.slice(0, index))?.[1];
      stack.push(name?.toUpperCase() ?? '');
    } else if (character === ')') {
      stack.pop();
    }
  }
  const active = stack[stack.length - 1];
  return active ? (SHEET_FUNCTIONS.find((definition) => definition.name === active) ?? null) : null;
}

export function insertFormulaReference(
  value: string,
  reference: string,
  cursor = value.length,
): { value: string; cursor: number } {
  const at = Math.max(0, Math.min(cursor, value.length));
  const before = value.slice(0, at);
  const after = value.slice(at);
  const separator = before.length > 1 && /[A-Za-z0-9_$)'"]$/.test(before) ? ',' : '';
  const inserted = `${separator}${reference}`;
  return {
    value: `${before}${inserted}${after}`,
    cursor: at + inserted.length,
  };
}
