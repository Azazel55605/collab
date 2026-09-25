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
        loaded
        loading={false}
        error={null}
        onLoad={vi.fn()}
        onOpenReference={onOpenReference}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /Spec Doc/i }));
    expect(onOpenReference).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceRelativePath: 'Notes/alpha.md',
        referenceKind: 'note-markdown-link',
      }),
    );
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
        loaded
        loading={false}
        error={null}
        onLoad={vi.fn()}
        onOpenReference={vi.fn()}
      />,
    );

    expect(screen.getByText(/No references found/i)).toBeTruthy();
  });

  it('loads references only after an explicit request', () => {
    const onLoad = vi.fn();
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
        loaded={false}
        loading={false}
        error={null}
        onLoad={onLoad}
        onOpenReference={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /find references/i }));
    expect(onLoad).toHaveBeenCalledOnce();
  });
});
