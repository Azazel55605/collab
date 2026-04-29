import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import FileReferencesPanel from './FileReferencesPanel';

describe('FileReferencesPanel', () => {
  it('renders references and opens the selected source on click', () => {
    const onOpenReference = vi.fn();
    render(
      <FileReferencesPanel
        selectedFile={{
          relativePath: 'Docs/spec.pdf',
          name: 'spec.pdf',
          extension: 'pdf',
          modifiedAt: 0,
          size: 1,
          isFolder: false,
        }}
        references={[
          {
            referencedRelativePath: 'Docs/spec.pdf',
            sourceRelativePath: 'Notes/alpha.md',
            sourceDocumentType: 'note',
            referenceKind: 'note-markdown-link',
            displayLabel: 'Spec Doc',
            context: 'Spec Doc -> ../Docs/spec.pdf',
          },
        ]}
        loading={false}
        error={null}
        onOpenReference={onOpenReference}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /Spec Doc/i }));
    expect(onOpenReference).toHaveBeenCalledWith(expect.objectContaining({
      sourceRelativePath: 'Notes/alpha.md',
      referenceKind: 'note-markdown-link',
    }));
  });

  it('shows an explicit empty state when no references exist', () => {
    render(
      <FileReferencesPanel
        selectedFile={{
          relativePath: 'Docs/spec.pdf',
          name: 'spec.pdf',
          extension: 'pdf',
          modifiedAt: 0,
          size: 1,
          isFolder: false,
        }}
        references={[]}
        loading={false}
        error={null}
        onOpenReference={vi.fn()}
      />,
    );

    expect(screen.getByText(/No references found/i)).toBeTruthy();
  });
});
