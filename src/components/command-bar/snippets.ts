import { formatDate, type DateFormat } from '../../store/uiStore';

export interface Snippet {
  label: string;
  preview: string;
  text: string;
}

/** Build a markdown table with `cols` columns and `rows` data rows */
function buildTable(cols: number, rows: number): string {
  const header    = '| ' + Array.from({ length: cols }, (_, i) => `Col ${i + 1}`).join(' | ') + ' |';
  const separator = '| ' + Array(cols).fill('---').join(' | ') + ' |';
  const dataRow   = '| ' + Array(cols).fill('   ').join(' | ') + ' |';
  const body      = Array(rows).fill(dataRow).join('\n');
  return [header, separator, body].join('\n');
}

/**
 * Generate insert snippets from the raw command bar query.
 * Called only when `activeView === 'editor'`.
 */
export function generateSnippets(query: string, dateFormat: DateFormat): Snippet[] {
  const q = query.trim();
  const ql = q.toLowerCase();
  const results: Snippet[] = [];

  // ── table NxM ──────────────────────────────────────────────────────────────
  const tableMatch = q.match(/^table\s+(\d+)\s*[x×]\s*(\d+)/i);
  if (tableMatch) {
    const cols = Math.min(parseInt(tableMatch[1]), 10);
    const rows = Math.min(parseInt(tableMatch[2]), 20);
    results.push({
      label:   `Table ${cols}×${rows}`,
      preview: `${cols} cols, ${rows} rows`,
      text:    buildTable(cols, rows),
    });
  } else if (ql.startsWith('table')) {
    // Hint: show a prompt for correct syntax
    results.push({
      label:   'Table — specify size (e.g. table 3x4)',
      preview: 'NxM',
      text:    buildTable(3, 3),
    });
  }

  // ── code <lang> ────────────────────────────────────────────────────────────
  if (ql.startsWith('code')) {
    const codeMatch = q.match(/^code\s+(\S+)/i);
    const lang = codeMatch ? codeMatch[1] : '';
    results.push({
      label:   lang ? `Code block (${lang})` : 'Code block',
      preview: lang ? `\`\`\`${lang}` : '```',
      text:    `\`\`\`${lang}\n\n\`\`\``,
    });
  }

  // ── link <note name> ───────────────────────────────────────────────────────
  if (ql.startsWith('link')) {
    const linkMatch = q.match(/^link\s+(.+)/i);
    const name = linkMatch ? linkMatch[1].trim() : '';
    results.push({
      label:   name ? `Wikilink: ${name}` : 'Wikilink (e.g. link Note Name)',
      preview: name ? `[[${name}]]` : '[[...]]',
      text:    name ? `[[${name}]]` : '[[]]',
    });
  }

  // ── date ───────────────────────────────────────────────────────────────────
  if (ql.startsWith('date')) {
    const today = formatDate(new Date(), dateFormat);
    results.push({
      label:   "Today's date",
      preview: today,
      text:    today,
    });
  }

  // ── heading <1-6> <text> ───────────────────────────────────────────────────
  if (ql.startsWith('heading') || ql.startsWith('h1') || ql.startsWith('h2') ||
      ql.startsWith('h3') || ql.startsWith('h4') || ql.startsWith('h5') || ql.startsWith('h6')) {
    const headingMatch = q.match(/^(?:heading\s+([1-6])|h([1-6]))\s*(.*)/i);
    if (headingMatch) {
      const level  = parseInt(headingMatch[1] ?? headingMatch[2]);
      const text   = (headingMatch[3] ?? '').trim() || 'Heading';
      const hashes = '#'.repeat(level);
      results.push({
        label:   `H${level}: ${text}`,
        preview: `${hashes} ${text}`,
        text:    `${hashes} ${text}`,
      });
    } else {
      results.push({
        label:   'Heading (e.g. heading 2 My Title  or  h2 My Title)',
        preview: '## …',
        text:    '## ',
      });
    }
  }

  // ── hr ─────────────────────────────────────────────────────────────────────
  if (ql === 'hr') {
    results.push({
      label:   'Horizontal rule',
      preview: '---',
      text:    '\n---\n',
    });
  }

  // ── blockquote ─────────────────────────────────────────────────────────────
  if (ql.startsWith('quote') || ql.startsWith('blockquote')) {
    const textMatch = q.match(/^(?:quote|blockquote)\s*(.*)/i);
    const text = (textMatch?.[1] ?? '').trim() || 'Quote text';
    results.push({
      label:   'Blockquote',
      preview: `> ${text}`,
      text:    `> ${text}`,
    });
  }

  // ── checklist ──────────────────────────────────────────────────────────────
  if (ql.startsWith('checklist') || ql.startsWith('todo')) {
    const countMatch = q.match(/(\d+)/);
    const count = countMatch ? Math.min(parseInt(countMatch[1]), 20) : 3;
    const items = Array(count).fill('- [ ] ').join('\n');
    results.push({
      label:   `Checklist (${count} items)`,
      preview: '- [ ] …',
      text:    items,
    });
  }

  return results;
}
