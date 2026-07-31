/**
 * Phase 9 accessibility validation for the canvas-painted grid.
 *
 * The canvas carries no text, so these tests are the guarantee that assistive
 * technology still gets the active cell, the selection shape, and a fully
 * keyboard-driven editing path. See `lib/sheet/accessibility.ts`.
 */

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useState } from 'react';

import type { SheetWorksheet } from '../../types/sheet';
import { createEmptySheetDocument } from '../../lib/sheet/document';
import { setCell } from '../../lib/sheet/operations';
import { createSelection, type SheetSelection } from '../../lib/sheet/selection';
import SheetGrid, { type SheetGridEditing } from './SheetGrid';

function worksheetFixture(): SheetWorksheet {
  let document = createEmptySheetDocument('Book', {
    timestamp: '2026-01-01T00:00:00.000Z',
    worksheet: { name: 'Sheet1', rows: 20, columns: 8 },
  });
  const worksheetId = document.worksheets[0].id;
  document = setCell(document, worksheetId, { row: 0, column: 0 }, { value: 'Rent', valueType: 'text' });
  document = setCell(document, worksheetId, { row: 0, column: 1 }, { value: 1240, valueType: 'number' });
  document = setCell(document, worksheetId, { row: 1, column: 0 }, { formula: '=B1*2' });
  return document.worksheets[0];
}

function Harness({
  readOnly = false,
  onCommit = () => {},
}: { readOnly?: boolean; onCommit?: (position: { row: number; column: number }, text: string) => void }) {
  const [selection, setSelection] = useState<SheetSelection>(() => createSelection({ row: 0, column: 0 }));
  const [editing, setEditing] = useState<SheetGridEditing | null>(null);
  return (
    <SheetGrid
      worksheet={worksheetFixture()}
      selection={selection}
      onSelectionChange={setSelection}
      onCommit={onCommit}
      editing={editing}
      onEditingChange={setEditing}
      onClearSelection={() => {}}
      onResizeTrack={() => {}}
      onAutoSizeColumn={() => {}}
      readOnly={readOnly}
    />
  );
}

function grid() {
  return screen.getByTestId('sheet-grid');
}

function announcement() {
  return screen.getByTestId('sheet-grid-announcement').textContent ?? '';
}

beforeEach(() => {
  Element.prototype.getBoundingClientRect = vi.fn(() => ({
    x: 0, y: 0, top: 0, left: 0, right: 1000, bottom: 800, width: 1000, height: 800,
    toJSON: () => ({}),
  })) as unknown as typeof Element.prototype.getBoundingClientRect;
});

afterEach(cleanup);

describe('screen-reader semantics', () => {
  it('points aria-activedescendant at a real gridcell describing the active cell', () => {
    render(<Harness />);

    const id = grid().getAttribute('aria-activedescendant');
    expect(id).toBeTruthy();
    const cell = document.getElementById(id as string);
    expect(cell?.getAttribute('role')).toBe('gridcell');
    expect(cell?.getAttribute('aria-colindex')).toBe('1');
    expect(cell?.textContent).toContain('A1, Rent');
    expect(cell?.parentElement?.getAttribute('aria-rowindex')).toBe('1');
  });

  it('follows the cursor as the keyboard moves it', () => {
    render(<Harness />);

    fireEvent.keyDown(grid(), { key: 'ArrowRight' });
    const cell = document.getElementById(grid().getAttribute('aria-activedescendant') as string);
    expect(cell?.getAttribute('aria-colindex')).toBe('2');
    expect(cell?.textContent).toContain('B1, 1240');
  });

  it('reads the formula source when the cursor lands on a formula cell', () => {
    render(<Harness />);

    fireEvent.keyDown(grid(), { key: 'ArrowDown' });
    const cell = document.getElementById(grid().getAttribute('aria-activedescendant') as string);
    expect(cell?.textContent).toContain('formula =B1*2');
  });

  it('announces the cell under the cursor through a polite live region', () => {
    render(<Harness />);

    const region = screen.getByTestId('sheet-grid-announcement');
    expect(region.getAttribute('aria-live')).toBe('polite');
    expect(region.getAttribute('role')).toBe('status');
    expect(announcement()).toContain('A1, Rent');

    fireEvent.keyDown(grid(), { key: 'ArrowRight' });
    expect(announcement()).toContain('B1, 1240');
  });

  it('announces the shape of a range instead of every cell in it', () => {
    render(<Harness />);

    fireEvent.keyDown(grid(), { key: 'ArrowDown', shiftKey: true });
    fireEvent.keyDown(grid(), { key: 'ArrowRight', shiftKey: true });

    expect(announcement()).toContain('2 by 2 range selected');
    expect(announcement()).toContain('A1 to B2');
  });

  it('announces that a read-only grid cannot be typed into', () => {
    render(<Harness readOnly />);

    expect(announcement()).toContain('read only');
    expect(grid().getAttribute('aria-readonly')).toBe('true');
    const cell = document.getElementById(grid().getAttribute('aria-activedescendant') as string);
    expect(cell?.getAttribute('aria-readonly')).toBe('true');
  });
});

describe('keyboard-only operation', () => {
  it('is reachable by Tab and takes focus without a pointer', () => {
    render(<Harness />);
    expect(grid().getAttribute('tabindex')).toBe('0');
    grid().focus();
    expect(document.activeElement).toBe(grid());
  });

  it('navigates, edits, and commits a cell without any pointer event', () => {
    const onCommit = vi.fn();
    render(<Harness onCommit={onCommit} />);

    grid().focus();
    fireEvent.keyDown(grid(), { key: 'ArrowDown' });
    fireEvent.keyDown(grid(), { key: 'ArrowRight' });
    // Typing a printable character opens the editor on the active cell.
    fireEvent.keyDown(grid(), { key: '9' });

    const editor = screen.getByLabelText('Cell editor') as HTMLInputElement;
    // Focus moves into the editor so the next keystrokes go where the user looks.
    expect(document.activeElement).toBe(editor);
    fireEvent.change(editor, { target: { value: '99' } });
    fireEvent.keyDown(editor, { key: 'Enter' });

    expect(onCommit).toHaveBeenCalledWith({ row: 1, column: 1 }, '99');
  });

  it('cancels an edit with Escape and returns focus to the grid', () => {
    const onCommit = vi.fn();
    render(<Harness onCommit={onCommit} />);

    grid().focus();
    fireEvent.keyDown(grid(), { key: 'F2' });
    const editor = screen.getByLabelText('Cell editor');
    fireEvent.keyDown(editor, { key: 'Escape' });

    expect(screen.queryByLabelText('Cell editor')).toBeNull();
    expect(onCommit).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(grid());
  });

  it('keeps every binding layout-independent', () => {
    // Punctuation and physical-position bindings break on non-US layouts, so
    // the grid must not depend on `event.code` or symbol keys.
    render(<Harness />);
    fireEvent.keyDown(grid(), { code: 'Slash' });
    expect(screen.queryByLabelText('Cell editor')).toBeNull();
  });
});
