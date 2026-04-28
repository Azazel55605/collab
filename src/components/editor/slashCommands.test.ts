import { CompletionContext } from '@codemirror/autocomplete';
import { EditorState } from '@codemirror/state';
import { describe, expect, it } from 'vitest';

import { createSlashCommandSource } from './slashCommands';
import { useNoteSnippetStore } from '../../store/noteSnippetStore';

describe('slashCommands', () => {
  it('offers base slash commands in normal text', async () => {
    const source = createSlashCommandSource();
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

    const source = createSlashCommandSource();
    const state = EditorState.create({ doc: '/meet' });
    const result = await source(new CompletionContext(state, 5, true));

    expect(result?.options.some((option: { label: string }) => option.label === 'Snippet: Meeting Notes')).toBe(true);
  });

  it('does not open inside fenced code blocks', async () => {
    const source = createSlashCommandSource();
    const state = EditorState.create({ doc: '```\n/meet\n```' });
    const result = await source(new CompletionContext(state, 8, true));

    expect(result).toBeNull();
  });
});
