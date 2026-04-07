import { formatDate, type DateFormat } from '../../store/uiStore';

export interface Snippet {
  label: string;
  preview: string;
  text: string;
}

interface SnippetCommand {
  key: string;
  aliases: string[];
  label: string;
  preview: string;
  completeAs?: string;
  build: (query: string, dateFormat: DateFormat) => Snippet;
}

/** Build a markdown table with `cols` columns and `rows` data rows */
function buildTable(cols: number, rows: number): string {
  const header = '| ' + Array.from({ length: cols }, (_, i) => `Col ${i + 1}`).join(' | ') + ' |';
  const separator = '| ' + Array(cols).fill('---').join(' | ') + ' |';
  const dataRow = '| ' + Array(cols).fill('   ').join(' | ') + ' |';
  const body = Array(rows).fill(dataRow).join('\n');
  return [header, separator, body].join('\n');
}

const INSERT_COMMANDS: SnippetCommand[] = [
  {
    key: 'table',
    aliases: ['tbl'],
    label: 'Table',
    preview: 'table 3x4',
    build: (query) => {
      const match = query.match(/^table\s+(\d+)\s*[x×]\s*(\d+)/i);
      const cols = match ? Math.min(parseInt(match[1], 10), 10) : 3;
      const rows = match ? Math.min(parseInt(match[2], 10), 20) : 3;
      return {
        label: `Table ${cols}×${rows}`,
        preview: `${cols} cols, ${rows} rows`,
        text: buildTable(cols, rows),
      };
    },
  },
  {
    key: 'code',
    aliases: ['fence'],
    label: 'Code block',
    preview: 'code ts',
    build: (query) => {
      const match = query.match(/^code\s+(\S+)/i);
      const lang = match ? match[1] : '';
      return {
        label: lang ? `Code block (${lang})` : 'Code block',
        preview: lang ? `\`\`\`${lang}` : '```',
        text: `\`\`\`${lang}\n\n\`\`\``,
      };
    },
  },
  {
    key: 'link',
    aliases: ['wikilink', 'wiki'],
    label: 'Wikilink',
    preview: 'link Note Name',
    build: (query) => {
      const match = query.match(/^link\s+(.+)/i);
      const name = match ? match[1].trim() : '';
      return {
        label: name ? `Wikilink: ${name}` : 'Wikilink',
        preview: name ? `[[${name}]]` : '[[...]]',
        text: name ? `[[${name}]]` : '[[]]',
      };
    },
  },
  {
    key: 'date',
    aliases: ['today'],
    label: 'Today’s date',
    preview: 'date',
    build: (_query, dateFormat) => {
      const today = formatDate(new Date(), dateFormat);
      return {
        label: "Today's date",
        preview: today,
        text: today,
      };
    },
  },
  {
    key: 'heading',
    aliases: ['header', 'title'],
    label: 'Heading',
    preview: 'heading 2 My Title',
    build: (query) => {
      const match = query.match(/^(?:heading\s+([1-6])|h([1-6]))\s*(.*)/i);
      if (match) {
        const level = parseInt(match[1] ?? match[2], 10);
        const text = (match[3] ?? '').trim() || 'Heading';
        return {
          label: `H${level}: ${text}`,
          preview: `${'#'.repeat(level)} ${text}`,
          text: `${'#'.repeat(level)} ${text}`,
        };
      }
      return {
        label: 'Heading',
        preview: '## Heading',
        text: '## Heading',
      };
    },
  },
  {
    key: 'h1',
    aliases: [],
    label: 'Heading 1',
    preview: '# Heading',
    completeAs: 'h1 ',
    build: (query) => {
      const text = query.replace(/^h1\s*/i, '').trim() || 'Heading';
      return { label: `H1: ${text}`, preview: `# ${text}`, text: `# ${text}` };
    },
  },
  {
    key: 'h2',
    aliases: [],
    label: 'Heading 2',
    preview: '## Heading',
    completeAs: 'h2 ',
    build: (query) => {
      const text = query.replace(/^h2\s*/i, '').trim() || 'Heading';
      return { label: `H2: ${text}`, preview: `## ${text}`, text: `## ${text}` };
    },
  },
  {
    key: 'h3',
    aliases: [],
    label: 'Heading 3',
    preview: '### Heading',
    completeAs: 'h3 ',
    build: (query) => {
      const text = query.replace(/^h3\s*/i, '').trim() || 'Heading';
      return { label: `H3: ${text}`, preview: `### ${text}`, text: `### ${text}` };
    },
  },
  {
    key: 'h4',
    aliases: [],
    label: 'Heading 4',
    preview: '#### Heading',
    completeAs: 'h4 ',
    build: (query) => {
      const text = query.replace(/^h4\s*/i, '').trim() || 'Heading';
      return { label: `H4: ${text}`, preview: `#### ${text}`, text: `#### ${text}` };
    },
  },
  {
    key: 'h5',
    aliases: [],
    label: 'Heading 5',
    preview: '##### Heading',
    completeAs: 'h5 ',
    build: (query) => {
      const text = query.replace(/^h5\s*/i, '').trim() || 'Heading';
      return { label: `H5: ${text}`, preview: `##### ${text}`, text: `##### ${text}` };
    },
  },
  {
    key: 'h6',
    aliases: [],
    label: 'Heading 6',
    preview: '###### Heading',
    completeAs: 'h6 ',
    build: (query) => {
      const text = query.replace(/^h6\s*/i, '').trim() || 'Heading';
      return { label: `H6: ${text}`, preview: `###### ${text}`, text: `###### ${text}` };
    },
  },
  {
    key: 'hr',
    aliases: ['rule', 'divider'],
    label: 'Horizontal rule',
    preview: '---',
    build: () => ({
      label: 'Horizontal rule',
      preview: '---',
      text: '\n---\n',
    }),
  },
  {
    key: 'quote',
    aliases: ['blockquote'],
    label: 'Blockquote',
    preview: '> Quote text',
    build: (query) => {
      const match = query.match(/^(?:quote|blockquote)\s*(.*)/i);
      const text = (match?.[1] ?? '').trim() || 'Quote text';
      return {
        label: 'Blockquote',
        preview: `> ${text}`,
        text: `> ${text}`,
      };
    },
  },
  {
    key: 'checklist',
    aliases: ['todo', 'tasks'],
    label: 'Checklist',
    preview: '- [ ] …',
    build: (query) => {
      const match = query.match(/(\d+)/);
      const count = match ? Math.min(parseInt(match[1], 10), 20) : 3;
      const items = Array(count).fill('- [ ] ').join('\n');
      return {
        label: `Checklist (${count} items)`,
        preview: '- [ ] …',
        text: items,
      };
    },
  },
  {
    key: 'bold',
    aliases: ['strong'],
    label: 'Bold',
    preview: '**text**',
    build: () => ({
      label: 'Bold',
      preview: '**text**',
      text: '**bold text**',
    }),
  },
  {
    key: 'italic',
    aliases: ['em'],
    label: 'Italic',
    preview: '_text_',
    build: () => ({
      label: 'Italic',
      preview: '_text_',
      text: '_italic text_',
    }),
  },
  {
    key: 'strike',
    aliases: ['strikethrough'],
    label: 'Strikethrough',
    preview: '~~text~~',
    build: () => ({
      label: 'Strikethrough',
      preview: '~~text~~',
      text: '~~struck text~~',
    }),
  },
  {
    key: 'callout',
    aliases: ['note', 'info', 'warning'],
    label: 'Callout',
    preview: '> [!note]',
    build: (query) => {
      const match = query.match(/^callout\s+(\w+)/i);
      const kind = match ? match[1].toLowerCase() : 'note';
      const title = kind.charAt(0).toUpperCase() + kind.slice(1);
      return {
        label: `Callout (${kind})`,
        preview: `> [!${kind}] ${title}`,
        text: `> [!${kind}] ${title}\n> `,
      };
    },
  },
];

function matchesCommand(query: string, command: SnippetCommand) {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return [command.key, ...command.aliases, command.label.toLowerCase()].some((value) => value.startsWith(q));
}

export function completeInsertQuery(query: string): string | null {
  const trimmed = query.trimStart();
  if (!trimmed) return 'table ';

  const tokenMatch = trimmed.match(/^(\S+)(?:\s|$)/);
  if (!tokenMatch) return null;
  const token = tokenMatch[1].toLowerCase();
  const rest = trimmed.slice(token.length);
  if (rest.trim().length > 0) return null;
  if (/\s$/.test(trimmed)) return null;

  const keyMatches = INSERT_COMMANDS.filter((command) => command.key.startsWith(token));
  if (keyMatches.length === 1) {
    return keyMatches[0].completeAs ?? `${keyMatches[0].key} `;
  }

  const aliasMatches = INSERT_COMMANDS.filter((command) =>
    command.aliases.some((value) => value.startsWith(token))
  );
  if (aliasMatches.length !== 1) return null;

  return aliasMatches[0].completeAs ?? `${aliasMatches[0].key} `;
}

/**
 * Generate insert snippets from the raw command bar query.
 * Called only when `activeView === 'editor'`.
 */
export function generateSnippets(query: string, dateFormat: DateFormat): Snippet[] {
  const q = query.trim();
  const matched = INSERT_COMMANDS.filter((command) => matchesCommand(q, command));

  if (!q) {
    return INSERT_COMMANDS.map((command) => command.build(command.key, dateFormat));
  }

  const direct = INSERT_COMMANDS.find((command) =>
    [command.key, ...command.aliases].some((value) => q.toLowerCase().startsWith(value))
  );
  if (direct) {
    return [direct.build(q, dateFormat)];
  }

  return matched.map((command) => command.build(command.key, dateFormat));
}
