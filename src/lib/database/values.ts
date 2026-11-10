import type { DatabaseValue } from '../../types/database';

import type { ResultSet } from './queryStore';

export function valueText(value: DatabaseValue): string {
  switch (value.kind) {
    case 'null':
      return 'NULL';
    case 'integer':
    case 'decimal':
      return value.decimal;
    case 'float':
      return value.round_trip_decimal;
    case 'binary':
      return value.base64;
    case 'date':
    case 'time':
    case 'date_time':
      return value.iso8601;
    case 'truncated':
      return `${value.preview} … [truncated]`;
    case 'opaque':
      return value.display;
    case 'boolean':
      return String(value.value);
    default:
      return value.value;
  }
}
export function exportResults(result: ResultSet, json: boolean) {
  if (json) return JSON.stringify({ columns: result.columns, rows: result.rows });
  const quote = (text: string) => `"${text.replace(/"/g, '""')}"`;
  const cell = (value: DatabaseValue) => {
    let text = valueText(value);
    if (
      !['integer', 'decimal', 'float', 'boolean', 'null'].includes(value.kind) &&
      /^[=+\-@\t\r]/.test(text)
    )
      text = `'${text}`;
    return quote(text);
  };
  return [
    result.columns.map((c) => quote(/^[=+\-@\t\r]/.test(c.name) ? `'${c.name}` : c.name)).join(','),
    ...result.rows.map((row) => row.map(cell).join(',')),
  ].join('\r\n');
}
