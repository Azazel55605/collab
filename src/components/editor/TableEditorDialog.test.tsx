import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { moveTableColumn, moveTableRow, TableEditorDialog } from './TableEditorDialog';
import type { MarkdownTableModel } from './tableMarkdown';

const MODEL: MarkdownTableModel = {
  headers: ['Name', 'Role', 'Team'],
  aligns: ['left', 'center', 'right'],
  rows: [
    ['Alpha', 'Owner', 'Core'],
    ['Beta', 'Editor', 'Docs'],
  ],
};

function createDataTransfer() {
  return {
    setData: vi.fn(),
    getData: vi.fn(),
    setDragImage: vi.fn(),
    clearData: vi.fn(),
    effectAllowed: '',
    dropEffect: '',
  };
}

describe('TableEditorDialog helpers', () => {
  it('moves a row together with its cell values', () => {
    const moved = moveTableRow(MODEL, 0, 1);
    expect(moved.rows).toEqual([
      ['Beta', 'Editor', 'Docs'],
      ['Alpha', 'Owner', 'Core'],
    ]);
  });

  it('moves a column together with headers, alignment, and row cells', () => {
    const moved = moveTableColumn(MODEL, 0, 2);
    expect(moved.headers).toEqual(['Role', 'Team', 'Name']);
    expect(moved.aligns).toEqual(['center', 'right', 'left']);
    expect(moved.rows).toEqual([
      ['Owner', 'Core', 'Alpha'],
      ['Editor', 'Docs', 'Beta'],
    ]);
  });
});

describe('TableEditorDialog', () => {
  it('reorders columns by drag and drop before applying', () => {
    const onApply = vi.fn();
    render(
      <TableEditorDialog
        open
        initialValue={MODEL}
        mode="edit"
        onOpenChange={vi.fn()}
        onApply={onApply}
      />,
    );

    const dataTransfer = createDataTransfer();
    const dragHandle = screen.getByRole('button', { name: 'Drag column 1' });
    const dropTarget = screen.getByRole('button', { name: 'Drag column 3' }).closest('div');
    expect(dropTarget).toBeTruthy();

    fireEvent.dragStart(dragHandle, { dataTransfer });
    fireEvent.dragOver(dropTarget!, { dataTransfer });
    fireEvent.drop(dropTarget!, { dataTransfer });
    fireEvent.click(screen.getByRole('button', { name: 'Update table' }));

    expect(onApply).toHaveBeenCalledWith(
      expect.objectContaining({
        headers: ['Role', 'Team', 'Name'],
        aligns: ['center', 'right', 'left'],
        rows: [
          ['Owner', 'Core', 'Alpha'],
          ['Editor', 'Docs', 'Beta'],
        ],
      }),
    );
  });

  it('reorders rows by drag and drop before applying', () => {
    const onApply = vi.fn();
    render(
      <TableEditorDialog
        open
        initialValue={MODEL}
        mode="edit"
        onOpenChange={vi.fn()}
        onApply={onApply}
      />,
    );

    const dataTransfer = createDataTransfer();
    const dragHandle = screen.getByRole('button', { name: 'Drag row 1' });
    const dropTarget = screen.getByRole('button', { name: 'Drag row 2' }).closest('div');
    expect(dropTarget).toBeTruthy();

    fireEvent.dragStart(dragHandle, { dataTransfer });
    fireEvent.dragOver(dropTarget!, { dataTransfer });
    fireEvent.drop(dropTarget!, { dataTransfer });
    fireEvent.click(screen.getByRole('button', { name: 'Update table' }));

    expect(onApply).toHaveBeenCalledWith(
      expect.objectContaining({
        rows: [
          ['Beta', 'Editor', 'Docs'],
          ['Alpha', 'Owner', 'Core'],
        ],
      }),
    );
  });

  it('deletes a specific column directly from the header controls', () => {
    const onApply = vi.fn();
    render(
      <TableEditorDialog
        open
        initialValue={MODEL}
        mode="edit"
        onOpenChange={vi.fn()}
        onApply={onApply}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Delete column 2' }));
    fireEvent.click(screen.getByRole('button', { name: 'Update table' }));

    expect(onApply).toHaveBeenCalledWith(
      expect.objectContaining({
        headers: ['Name', 'Team'],
        aligns: ['left', 'right'],
        rows: [
          ['Alpha', 'Core'],
          ['Beta', 'Docs'],
        ],
      }),
    );
  });

  it('deletes a specific row directly from the row controls', () => {
    const onApply = vi.fn();
    render(
      <TableEditorDialog
        open
        initialValue={MODEL}
        mode="edit"
        onOpenChange={vi.fn()}
        onApply={onApply}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Delete row 1' }));
    fireEvent.click(screen.getByRole('button', { name: 'Update table' }));

    expect(onApply).toHaveBeenCalledWith(
      expect.objectContaining({
        rows: [['Beta', 'Editor', 'Docs']],
      }),
    );
  });
});
