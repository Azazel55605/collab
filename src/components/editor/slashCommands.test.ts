import { CompletionContext } from '@codemirror/autocomplete';
import { EditorState } from '@codemirror/state';
import { describe, expect, it } from 'vitest';

import { createSlashCommandSource } from './slashCommands';
import { useNoteSnippetStore } from '../../store/noteSnippetStore';
import { useVaultStore } from '../../store/vaultStore';

describe('slashCommands', () => {
  it('offers base slash commands in normal text', async () => {
    const source = createSlashCommandSource('Notes/current.md');
    const state = EditorState.create({ doc: '/cal' });
    const result = await source(new CompletionContext(state, 4, true));

    expect(result?.options.some((option: { label: string }) => option.label === 'Callout: Note')).toBe(true);
  });

  it('includes stored note snippets in the slash menu', async () => {
    useNoteSnippetStore.setState({
      snippets: [
        {
          id: 'snippet-1',
          name: 'Meeting Notes',
          description: 'Agenda and action items',
          scope: 'vault',
          category: 'Meetings',
          body: '## <placeholder:Meeting>\n<cursor>',
          updatedAt: 1,
        },
      ],
      isLoading: false,
    } as never);

    const source = createSlashCommandSource('Notes/current.md');
    const state = EditorState.create({ doc: '/meet' });
    const result = await source(new CompletionContext(state, 5, true));

    expect(result?.options.some((option: { label: string }) => option.label === 'Snippet: Meeting Notes')).toBe(true);
  });

  it('does not open inside fenced code blocks', async () => {
    const source = createSlashCommandSource('Notes/current.md');
    const state = EditorState.create({ doc: '```\n/meet\n```' });
    const result = await source(new CompletionContext(state, 8, true));

    expect(result).toBeNull();
  });

  it('offers vault file link commands', async () => {
    useVaultStore.setState({
      fileTree: [
        {
          relativePath: 'Docs',
          name: 'Docs',
          extension: '',
          modifiedAt: 0,
          size: 0,
          isFolder: true,
          children: [
            {
              relativePath: 'Docs/spec.pdf',
              name: 'spec.pdf',
              extension: 'pdf',
              modifiedAt: 0,
              size: 1,
              isFolder: false,
            },
          ],
        },
      ],
    } as never);

    const source = createSlashCommandSource('Notes/current.md');
    const state = EditorState.create({ doc: '/spec' });
    const result = await source(new CompletionContext(state, 5, true));

    expect(result?.options.some((option: { label: string }) => option.label === 'Link: spec.pdf')).toBe(true);
  });
});
