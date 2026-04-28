import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { NoteSnippetsDialog } from './NoteSnippetsDialog';

const loadSnippets = vi.fn();
const saveSnippet = vi.fn();
const deleteSnippet = vi.fn();

vi.mock('../../store/vaultStore', () => ({
  useVaultStore: () => ({
    vault: { path: '/vault', name: 'Vault' },
  }),
}));

vi.mock('../../store/noteSnippetStore', () => ({
  useNoteSnippetStore: () => ({
    snippets: [
      {
        id: 'meeting',
        name: 'Meeting Notes',
        description: 'Reusable meeting outline',
        scope: 'vault',
        category: 'Meetings',
        body: '# <placeholder:Title>\n<cursor>',
        updatedAt: '2026-04-28T12:00:00.000Z',
      },
    ],
    isLoading: false,
    loadSnippets,
    saveSnippet,
    deleteSnippet,
  }),
}));

describe('NoteSnippetsDialog', () => {
  beforeEach(() => {
    loadSnippets.mockReset();
    saveSnippet.mockReset();
    deleteSnippet.mockReset();
  });

  it('loads snippets when opened and inserts an existing snippet', () => {
    const onInsert = vi.fn();
    const onOpenChange = vi.fn();

    render(<NoteSnippetsDialog open onOpenChange={onOpenChange} onInsert={onInsert} />);

    expect(loadSnippets).toHaveBeenCalledWith('/vault');
    expect(screen.getByText('Meeting Notes')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Insert' }));

    expect(onInsert).toHaveBeenCalledWith('# <placeholder:Title>\n<cursor>');
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('allows drafting a new snippet and inserting the draft body', () => {
    const onInsert = vi.fn();

    render(<NoteSnippetsDialog open onOpenChange={vi.fn()} onInsert={onInsert} />);

    fireEvent.change(screen.getByPlaceholderText('Meeting notes'), {
      target: { value: 'Daily Log' },
    });
    fireEvent.change(screen.getByDisplayValue('<placeholder:Snippet content><cursor>'), {
      target: { value: '## <placeholder:Date>\n\n- <cursor>' },
    });

    fireEvent.click(screen.getByRole('button', { name: 'Insert draft' }));

    expect(onInsert).toHaveBeenCalledWith('## <placeholder:Date>\n\n- <cursor>');
    expect(screen.getByDisplayValue('Daily Log')).toBeTruthy();
  });
});
