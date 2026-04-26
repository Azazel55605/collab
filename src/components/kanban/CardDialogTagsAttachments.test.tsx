import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { KanbanCard } from '../../types/kanban';
import type { NoteFile } from '../../types/vault';
import { CardDialogTagsAttachments } from './CardDialogTagsAttachments';

const DRAFT: KanbanCard = {
  id: 'card-1',
  title: 'Card',
  tags: ['alpha'],
  assignees: [],
  comments: [],
  checklist: [],
  attachmentPaths: ['Docs/file.md'],
};

const VAULT_FILES: NoteFile[] = [
  {
    relativePath: 'Docs/file.md',
    name: 'file.md',
    extension: 'md',
    modifiedAt: 0,
    size: 1,
    isFolder: false,
  },
];

describe('CardDialogTagsAttachments', () => {
  it('handles tag actions and attachment open/remove actions', () => {
    const removeTag = vi.fn();
    const addTag = vi.fn();
    const setTagInput = vi.fn();
    const patchDraft = vi.fn();
    const openAttachment = vi.fn();
    const removeAttachment = vi.fn();

    render(
      <CardDialogTagsAttachments
        draft={DRAFT}
        tagInput="beta"
        suggestedTags={['beta']}
        showTagSuggestions
        attachmentPaths={['Docs/file.md']}
        vaultFiles={VAULT_FILES}
        notePickerOpen={false}
        setTagInput={setTagInput}
        setTagInputFocused={vi.fn()}
        setNotePickerOpen={vi.fn()}
        addTag={addTag}
        removeTag={removeTag}
        patchDraft={patchDraft}
        addAttachment={vi.fn()}
        removeAttachment={removeAttachment}
        openAttachment={openAttachment}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /remove tag alpha/i }));
    expect(removeTag).toHaveBeenCalledWith('alpha');

    fireEvent.keyDown(screen.getByPlaceholderText(/type tag, press enter/i), { key: 'Enter' });
    expect(addTag).toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'beta' }));
    expect(patchDraft).toHaveBeenCalledWith({ tags: ['alpha', 'beta'] });
    expect(setTagInput).toHaveBeenCalledWith('');

    fireEvent.click(screen.getByTitle('Open file'));
    expect(openAttachment).toHaveBeenCalledWith('Docs/file.md');

    fireEvent.click(screen.getByTitle('Remove attachment'));
    expect(removeAttachment).toHaveBeenCalledWith('Docs/file.md');
  });

  it('shows attached file choices and calls addAttachment from the picker', () => {
    const addAttachment = vi.fn();

    render(
      <CardDialogTagsAttachments
        draft={{ ...DRAFT, tags: [] }}
        tagInput=""
        suggestedTags={[]}
        showTagSuggestions={false}
        attachmentPaths={[]}
        vaultFiles={VAULT_FILES}
        notePickerOpen
        setTagInput={vi.fn()}
        setTagInputFocused={vi.fn()}
        setNotePickerOpen={vi.fn()}
        addTag={vi.fn()}
        removeTag={vi.fn()}
        patchDraft={vi.fn()}
        addAttachment={addAttachment}
        removeAttachment={vi.fn()}
        openAttachment={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByText('file'));
    expect(addAttachment).toHaveBeenCalledWith('Docs/file.md');
  });
});
