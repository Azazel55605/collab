import type { Completion, CompletionSource } from '@codemirror/autocomplete';
import type { EditorView } from '@codemirror/view';

import { useNoteSnippetStore } from '../../store/noteSnippetStore';
import { useVaultStore } from '../../store/vaultStore';
import type { NoteSnippet } from '../../types/noteSnippet';
import {
  buildVaultLinkInsertText,
  flattenVaultFiles,
  getVaultDocumentTabType,
  getVaultDocumentTitle,
} from '../../lib/vaultLinks';
import { buildCalloutSnippet, buildReferencesSectionSnippet, insertOrNavigateFootnote, insertSnippetReference, shouldOpenSlashMenu } from './noteAuthoring';
import { insertSnippetTemplate } from './snippetEngine';

type SlashCommandItem = {
  label: string;
  detail?: string;
  type?: Completion['type'];
  keywords?: string[];
  apply: (view: EditorView) => void;
};

function createBaseCommands(): SlashCommandItem[] {
  return [
    { label: 'Heading 1', detail: 'Large section heading', type: 'text', keywords: ['h1 title'], apply: (view) => insertSnippetTemplate(view, '# <placeholder:Heading>\n<cursor>') },
    { label: 'Heading 2', detail: 'Medium section heading', type: 'text', keywords: ['h2 title'], apply: (view) => insertSnippetTemplate(view, '## <placeholder:Heading>\n<cursor>') },
    { label: 'Heading 3', detail: 'Small section heading', type: 'text', keywords: ['h3 title'], apply: (view) => insertSnippetTemplate(view, '### <placeholder:Heading>\n<cursor>') },
    { label: 'Bullet List', detail: 'Unordered list starter', type: 'text', keywords: ['list bullets'], apply: (view) => insertSnippetTemplate(view, '- <placeholder:List item>\n<cursor>') },
    { label: 'Ordered List', detail: 'Numbered list starter', type: 'text', keywords: ['list numbered'], apply: (view) => insertSnippetTemplate(view, '1. <placeholder:List item>\n<cursor>') },
    { label: 'Task List', detail: 'Checklist starter', type: 'text', keywords: ['tasks checklist'], apply: (view) => insertSnippetTemplate(view, '- [ ] <placeholder:Task>\n<cursor>') },
    { label: 'Blockquote', detail: 'Quoted block', type: 'text', keywords: ['quote'], apply: (view) => insertSnippetTemplate(view, '> <placeholder:Quoted text>\n<cursor>') },
    { label: 'Divider', detail: 'Horizontal rule', type: 'text', keywords: ['separator hr rule'], apply: (view) => insertSnippetTemplate(view, '\n---\n<cursor>') },
    { label: 'Table', detail: 'Basic 3-column table', type: 'text', keywords: ['grid table'], apply: (view) => insertSnippetTemplate(view, '| <placeholder:Column 1> | <placeholder:Column 2> | <placeholder:Column 3> |\n| --- | --- | --- |\n| <placeholder:Value 1> | <placeholder:Value 2> | <placeholder:Value 3> |\n<cursor>') },
    { label: 'Code Block', detail: 'Fenced code block', type: 'text', keywords: ['code fenced'], apply: (view) => insertSnippetTemplate(view, '```<placeholder:language>\n<placeholder:code>\n```\n<cursor>') },
    { label: 'Math Block', detail: 'LaTeX math block', type: 'text', keywords: ['math latex'], apply: (view) => insertSnippetTemplate(view, '$$\n<placeholder:expression>\n$$\n<cursor>') },
    { label: 'Link', detail: 'Markdown link', type: 'text', keywords: ['url hyperlink'], apply: (view) => insertSnippetTemplate(view, '[<placeholder:link text>](<placeholder:https://example.com>)<cursor>') },
    { label: 'Image', detail: 'Markdown image', type: 'text', keywords: ['picture asset'], apply: (view) => insertSnippetTemplate(view, '![<placeholder:alt text>](<placeholder:Pictures/example.png>)<cursor>') },
    { label: 'Callout: Note', detail: 'Styled note callout', type: 'text', keywords: ['admonition note'], apply: (view) => insertSnippetTemplate(view, buildCalloutSnippet('note')) },
    { label: 'Callout: Tip', detail: 'Styled tip callout', type: 'text', keywords: ['admonition tip'], apply: (view) => insertSnippetTemplate(view, buildCalloutSnippet('tip')) },
    { label: 'Callout: Warning', detail: 'Styled warning callout', type: 'text', keywords: ['admonition warning'], apply: (view) => insertSnippetTemplate(view, buildCalloutSnippet('warning')) },
    { label: 'Callout: Danger', detail: 'Styled danger callout', type: 'text', keywords: ['admonition danger'], apply: (view) => insertSnippetTemplate(view, buildCalloutSnippet('danger')) },
    { label: 'Callout: Info', detail: 'Styled info callout', type: 'text', keywords: ['admonition info'], apply: (view) => insertSnippetTemplate(view, buildCalloutSnippet('info')) },
    { label: 'Footnote', detail: 'Insert or jump to a footnote', type: 'text', keywords: ['citation note reference'], apply: (view) => { void insertOrNavigateFootnote(view); } },
    { label: 'References Section', detail: 'Simple references scaffold', type: 'text', keywords: ['citation bibliography sources'], apply: (view) => insertSnippetTemplate(view, buildReferencesSectionSnippet()) },
  ];
}

function snippetToCommand(snippet: NoteSnippet): SlashCommandItem {
  return {
    label: `Snippet: ${snippet.name}`,
    detail: snippet.description ?? snippet.category ?? (snippet.scope === 'vault' ? 'Vault snippet' : 'App snippet'),
    type: 'text',
    keywords: [snippet.category ?? '', snippet.scope],
    apply: (view) => insertSnippetReference(view, snippet),
  };
}

function createVaultFileCommands(currentDocumentRelativePath: string): SlashCommandItem[] {
  const fileTree = useVaultStore.getState().fileTree;
  return flattenVaultFiles(fileTree).map((file) => {
    const type = getVaultDocumentTabType(file.relativePath);
    const folder = file.relativePath.includes('/')
      ? file.relativePath.split('/').slice(0, -1).join('/')
      : undefined;
    const detail = [folder, type === 'note' ? 'Note' : type === 'pdf' ? 'PDF' : type === 'canvas' ? 'Canvas' : type === 'kanban' ? 'Kanban' : 'Image']
      .filter(Boolean)
      .join(' · ');
    return {
      label: `Link: ${type === 'note' ? getVaultDocumentTitle(file.relativePath) : file.name}`,
      detail,
      type: 'text',
      keywords: [file.relativePath, file.name, type, 'vault file'],
      apply: (view) => insertSnippetTemplate(
        view,
        `${buildVaultLinkInsertText(file.relativePath, currentDocumentRelativePath, fileTree)}<cursor>`,
      ),
    };
  });
}

function matchesCommand(item: SlashCommandItem, query: string) {
  if (!query) return true;
  const haystack = [item.label, item.detail ?? '', ...(item.keywords ?? [])].join(' ').toLowerCase();
  return haystack.includes(query.toLowerCase());
}

function toCompletion(item: SlashCommandItem): Completion {
  return {
    label: item.label,
    detail: item.detail,
    type: item.type,
    apply(view: EditorView, _completion: Completion, applyFrom: number, applyTo: number) {
      view.dispatch({ changes: { from: applyFrom, to: applyTo, insert: '' } });
      item.apply(view);
    },
  };
}

export function createSlashCommandSource(currentDocumentRelativePath: string): CompletionSource {
  return (context) => {
    const before = context.matchBefore(/\/[A-Za-z0-9:_ -]*$/);
    if (!before) return null;
    if (before.from === before.to && !context.explicit) return null;
    const cursor = context.pos;
    const content = context.state.doc.toString();
    if (!shouldOpenSlashMenu(content, cursor)) return null;

    const query = before.text.slice(1).trim();
    const commands = [
      ...createBaseCommands(),
      ...createVaultFileCommands(currentDocumentRelativePath),
      ...useNoteSnippetStore.getState().snippets.map(snippetToCommand),
    ].filter((item) => matchesCommand(item, query));

    return {
      from: before.from,
      to: before.to,
      filter: false,
      options: commands.map((item) => toCompletion(item)),
    };
  };
}
