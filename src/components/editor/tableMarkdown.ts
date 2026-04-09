export type MarkdownTableAlignment = 'left' | 'center' | 'right';

export interface MarkdownTableModel {
  headers: string[];
  aligns: MarkdownTableAlignment[];
  rows: string[][];
}

function normalizeRow(row: string[], cols: number) {
  return Array.from({ length: cols }, (_, index) => row[index] ?? '');
}

function parseCells(line: string) {
  return line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((cell) => cell.trim());
}

function isAlignmentCell(cell: string) {
  return /^:?-{3,}:?$/.test(cell.trim());
}

export function createEmptyTable(cols = 3, rows = 3): MarkdownTableModel {
  return {
    headers: Array.from({ length: cols }, (_, index) => `Col ${index + 1}`),
    aligns: Array.from({ length: cols }, () => 'left' as const),
    rows: Array.from({ length: rows }, () => Array.from({ length: cols }, () => '')),
  };
}

export function parseMarkdownTable(markdown: string): MarkdownTableModel | null {
  const lines = markdown
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  if (lines.length < 2) return null;
  if (!lines.every((line) => /^\|.*\|$/.test(line))) return null;

  const headers = parseCells(lines[0]);
  const separator = parseCells(lines[1]);
  if (headers.length === 0 || headers.length !== separator.length) return null;
  if (!separator.every(isAlignmentCell)) return null;

  const aligns = separator.map<MarkdownTableAlignment>((cell) => {
    const trimmed = cell.trim();
    if (trimmed.startsWith(':') && trimmed.endsWith(':')) return 'center';
    if (trimmed.endsWith(':')) return 'right';
    return 'left';
  });

  const rows = lines.slice(2).map((line) => normalizeRow(parseCells(line), headers.length));
  return {
    headers,
    aligns,
    rows,
  };
}

export function renderMarkdownTable(model: MarkdownTableModel) {
  const cols = Math.max(model.headers.length, 1);
  const headers = normalizeRow(model.headers, cols).map((cell) => cell.trim() || ' ');
  const aligns = normalizeRow(model.aligns, cols).map((align) => {
    switch (align) {
      case 'center':
        return ':---:';
      case 'right':
        return '---:';
      default:
        return '---';
    }
  });
  const rows = model.rows.map((row) => normalizeRow(row, cols).map((cell) => cell.trim()));

  return [
    `| ${headers.join(' | ')} |`,
    `| ${aligns.join(' | ')} |`,
    ...rows.map((row) => `| ${row.join(' | ')} |`),
  ].join('\n');
}
