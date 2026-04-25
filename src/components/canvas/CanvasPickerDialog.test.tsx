import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { CanvasPickerDialog } from './CanvasPickerDialog';

describe('CanvasPickerDialog', () => {
  afterEach(() => {
    cleanup();
  });

  it('renders matching files and selects one when clicked', () => {
    const onSelect = vi.fn();

    render(
      <CanvasPickerDialog
        open
        mode="note"
        files={[
          {
            relativePath: 'Notes/alpha.md',
            name: 'alpha.md',
            extension: 'md',
            modifiedAt: 1,
            size: 1,
            isFolder: false,
          },
        ]}
        onOpenChange={vi.fn()}
        onSelect={onSelect}
      />,
    );

    expect(screen.getByText('Add note to canvas')).toBeTruthy();
    fireEvent.click(screen.getByText('alpha'));

    expect(onSelect).toHaveBeenCalledWith(
      expect.objectContaining({
        relativePath: 'Notes/alpha.md',
      }),
    );
  });
});
