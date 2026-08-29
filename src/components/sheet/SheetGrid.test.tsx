import { useState } from 'react';

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createEmptySheetDocument } from '../../lib/sheet/document';
import { mergeSelection, setCell } from '../../lib/sheet/operations';
import {
  createSelection,
  extendSelection,
  normalizeRange,
  selectedCellCount,
  type SheetSelection,
  type SheetSelectionRange,
} from '../../lib/sheet/selection';
import { SHEET_DEFAULTS } from '../../types/sheet';
import type { SheetWorksheet } from '../../types/sheet';

import SheetGrid, { type SheetGridEditing, type SheetRemoteSelection } from './SheetGrid';

const { rowHeight, columnWidth, headerHeight, headerWidth } = SHEET_DEFAULTS;

function worksheetFixture(): SheetWorksheet {
  let document = createEmptySheetDocument('Book', {
    timestamp: '2026-01-01T00:00:00.000Z',
    worksheet: { name: 'Sheet1', rows: 50, columns: 20 },
  });
  const worksheetId = document.worksheets[0].id;
  document = setCell(
    document,
    worksheetId,
    { row: 0, column: 0 },
    { value: 'A1', valueType: 'text' },
  );
  document = setCell(
    document,
    worksheetId,
    { row: 1, column: 0 },
    { value: 5, valueType: 'number' },
  );
  document = setCell(
    document,
    worksheetId,
    { row: 2, column: 0 },
    { value: 7, valueType: 'number' },
  );
  return document.worksheets[0];
}

interface HarnessProps {
  worksheet?: SheetWorksheet;
  readOnly?: boolean;
  onCommit?: (position: { row: number; column: number }, text: string) => void;
  onClearSelection?: () => void;
  onResizeTrack?: (axis: 'row' | 'column', index: number, size: number) => void;
  onAutoSizeColumn?: (index: number) => void;
  onSelectionChange?: (selection: SheetSelection) => void;
  formulaReferenceMode?: boolean;
  onFormulaReferenceCommit?: (range: SheetSelectionRange) => void;
  onUndo?: () => void;
  onRedo?: () => void;
  onFillSelection?: (target: { row: number; column: number }) => void;
  remoteSelections?: SheetRemoteSelection[];
}

/** Drives the grid the way SheetView does, so tests exercise real state flow. */
function Harness({
  worksheet = worksheetFixture(),
  readOnly = false,
  onCommit = () => {},
  onClearSelection = () => {},
  onResizeTrack = () => {},
  onAutoSizeColumn = () => {},
  onSelectionChange,
  formulaReferenceMode,
  onFormulaReferenceCommit,
  onUndo,
  onRedo,
  onFillSelection,
  remoteSelections,
}: HarnessProps) {
  const [selection, setSelection] = useState<SheetSelection>(() =>
    createSelection({ row: 0, column: 0 }),
  );
  const [editing, setEditing] = useState<SheetGridEditing | null>(null);

  return (
    <>
      <div data-testid="selection-state">
        {`${selection.active.row},${selection.active.column},${selectedCellCount(selection)},${selection.kind}`}
      </div>
      <SheetGrid
        worksheet={worksheet}
        selection={selection}
        onSelectionChange={(next) => {
          setSelection(next);
          onSelectionChange?.(next);
        }}
        onCommit={onCommit}
        editing={editing}
        onEditingChange={setEditing}
        onClearSelection={onClearSelection}
        onResizeTrack={onResizeTrack}
        onAutoSizeColumn={onAutoSizeColumn}
        readOnly={readOnly}
        formulaReferenceMode={formulaReferenceMode}
        onFormulaReferenceCommit={onFormulaReferenceCommit}
        onUndo={onUndo}
        onRedo={onRedo}
        onFillSelection={onFillSelection}
        remoteSelections={remoteSelections}
      />
    </>
  );
}

/** Cell surface coordinates for a cell, given the default track sizes. */
function pointFor(row: number, column: number) {
  return {
    clientX: headerWidth + column * columnWidth + columnWidth / 2,
    clientY: headerHeight + row * rowHeight + rowHeight / 2,
  };
}

function selectionState() {
  return screen.getByTestId('selection-state').textContent ?? '';
}

function grid() {
  return screen.getByTestId('sheet-grid');
}

beforeEach(() => {
  // jsdom has no layout: give the sticky pane a real origin so pointer
  // coordinates map onto cells the way they do in a browser.
  Element.prototype.getBoundingClientRect = vi.fn(() => ({
    x: 0,
    y: 0,
    top: 0,
    left: 0,
    right: 1000,
    bottom: 800,
    width: 1000,
    height: 800,
    toJSON: () => ({}),
  })) as unknown as typeof Element.prototype.getBoundingClientRect;
});

afterEach(cleanup);

describe('SheetGrid rendering', () => {
  it('renders headers for the visible window only, not the whole grid', () => {
    render(<Harness />);

    const columnHeaders = screen.getAllByRole('columnheader');
    const rowHeaders = screen.getAllByRole('rowheader');

    // 20 columns fit in the fallback viewport, but 50 rows do not.
    expect(columnHeaders.length).toBeLessThanOrEqual(20);
    expect(rowHeaders.length).toBeLessThan(50);
    expect(columnHeaders[0]).toHaveProperty('ariaLabel', 'A');
    expect(rowHeaders[0]).toHaveProperty('ariaLabel', 'Row 1');
  });

  it('exposes grid semantics for assistive technology', () => {
    render(<Harness />);
    const element = grid();
    expect(element.getAttribute('role')).toBe('grid');
    expect(element.getAttribute('aria-rowcount')).toBe('50');
    expect(element.getAttribute('aria-colcount')).toBe('20');
  });

  it('renders remote collaborator selections without changing local selection', () => {
    render(
      <Harness
        remoteSelections={[
          {
            clientId: 7,
            name: 'Alice',
            color: '#3b82f6',
            active: { row: 2, column: 2 },
            ranges: [{ anchor: { row: 1, column: 1 }, focus: { row: 2, column: 2 } }],
          },
        ]}
      />,
    );

    expect(screen.getByText('Alice')).toBeTruthy();
    expect(selectionState()).toBe('0,0,1,cells');
  });

  it('paints a merged range as one outer cell without internal grid lines', () => {
    let document = createEmptySheetDocument('Book', {
      worksheet: { name: 'Sheet1', rows: 4, columns: 4 },
    });
    const worksheetId = document.worksheets[0].id;
    document = setCell(
      document,
      worksheetId,
      { row: 0, column: 0 },
      {
        value: 'Merged',
        valueType: 'text',
      },
    );
    document = mergeSelection(
      document,
      worksheetId,
      extendSelection(createSelection({ row: 0, column: 0 }), { row: 1, column: 1 }),
    );

    const strokeRect = vi.fn();
    const context = {
      clearRect: vi.fn(),
      fillRect: vi.fn(),
      strokeRect,
      setTransform: vi.fn(),
      save: vi.fn(),
      restore: vi.fn(),
      beginPath: vi.fn(),
      rect: vi.fn(),
      clip: vi.fn(),
      fillText: vi.fn(),
      moveTo: vi.fn(),
      lineTo: vi.fn(),
      stroke: vi.fn(),
      set fillStyle(_value: string) {},
      set strokeStyle(_value: string) {},
      set lineWidth(_value: number) {},
      set font(_value: string) {},
      set textBaseline(_value: string) {},
      set textAlign(_value: string) {},
    };
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(context as never);

    render(<Harness worksheet={document.worksheets[0]} />);

    expect(strokeRect).toHaveBeenCalledWith(0.5, 0.5, columnWidth * 2, rowHeight * 2);
    expect(strokeRect).not.toHaveBeenCalledWith(0.5, 0.5, columnWidth, rowHeight);
  });
});

describe('pointer selection', () => {
  it('selects a cell on pointer down', () => {
    render(<Harness />);
    fireEvent.pointerDown(screen.getByTestId('sheet-cell-surface'), {
      button: 0,
      ...pointFor(2, 3),
    });
    expect(selectionState()).toBe('2,3,1,cells');
  });

  it('extends the selection by dragging', () => {
    render(<Harness />);
    const surface = screen.getByTestId('sheet-cell-surface');
    fireEvent.pointerDown(surface, { button: 0, ...pointFor(1, 1) });
    fireEvent.pointerMove(surface, pointFor(3, 2));
    fireEvent.pointerUp(surface, pointFor(3, 2));
    // 3 rows x 2 columns
    expect(selectionState()).toBe('1,1,6,cells');
  });

  it('returns one completed range while formula reference mode is active', () => {
    const onFormulaReferenceCommit = vi.fn();
    render(<Harness formulaReferenceMode onFormulaReferenceCommit={onFormulaReferenceCommit} />);
    const surface = screen.getByTestId('sheet-cell-surface');
    fireEvent.pointerDown(surface, { button: 0, ...pointFor(1, 1) });
    fireEvent.pointerMove(surface, pointFor(3, 2));
    fireEvent.pointerUp(surface, pointFor(3, 2));

    expect(onFormulaReferenceCommit).toHaveBeenCalledWith({
      anchor: { row: 1, column: 1 },
      focus: { row: 3, column: 2 },
    });
    expect(selectionState()).toBe('0,0,1,cells');
  });

  it('maps pointer hits inside a merge to its top-left cell', () => {
    let document = createEmptySheetDocument('Book', {
      worksheet: { name: 'Sheet1', rows: 4, columns: 4 },
    });
    const worksheetId = document.worksheets[0].id;
    document = mergeSelection(
      document,
      worksheetId,
      extendSelection(createSelection({ row: 0, column: 0 }), { row: 1, column: 1 }),
    );
    render(<Harness worksheet={document.worksheets[0]} />);
    fireEvent.pointerDown(screen.getByTestId('sheet-cell-surface'), {
      button: 0,
      ...pointFor(1, 1),
    });
    expect(selectionState()).toBe('0,0,1,cells');
  });

  it('extends with shift-click and adds a disjoint range with ctrl-click', () => {
    render(<Harness />);
    const surface = screen.getByTestId('sheet-cell-surface');
    fireEvent.pointerDown(surface, { button: 0, ...pointFor(0, 0) });
    fireEvent.pointerDown(surface, { button: 0, shiftKey: true, ...pointFor(1, 1) });
    expect(selectionState()).toBe('0,0,4,cells');

    fireEvent.pointerDown(surface, { button: 0, ctrlKey: true, ...pointFor(5, 5) });
    expect(selectionState()).toBe('5,5,5,cells');
  });

  it('selects rows, columns, and all cells from the headers', () => {
    render(<Harness />);

    fireEvent.pointerDown(screen.getByRole('rowheader', { name: 'Row 3' }));
    expect(selectionState()).toBe('2,0,20,rows');

    fireEvent.pointerDown(screen.getByRole('columnheader', { name: 'B' }));
    expect(selectionState()).toBe('0,1,50,columns');

    fireEvent.click(screen.getByRole('button', { name: 'Select all cells' }));
    expect(selectionState()).toBe('0,0,1000,all');
  });
});

describe('keyboard navigation', () => {
  it('moves with arrows and extends with shift', () => {
    render(<Harness />);
    fireEvent.keyDown(grid(), { key: 'ArrowDown' });
    fireEvent.keyDown(grid(), { key: 'ArrowRight' });
    expect(selectionState()).toBe('1,1,1,cells');

    fireEvent.keyDown(grid(), { key: 'ArrowDown', shiftKey: true });
    expect(selectionState()).toBe('1,1,2,cells');
  });

  it('jumps across populated blocks with ctrl+arrow', () => {
    render(<Harness />);
    // A1:A3 are populated, so Ctrl+Down stops at A3 (row index 2).
    fireEvent.keyDown(grid(), { key: 'ArrowDown', ctrlKey: true });
    expect(selectionState()).toBe('2,0,1,cells');

    // Nothing else below: jump to the last row.
    fireEvent.keyDown(grid(), { key: 'ArrowDown', ctrlKey: true });
    expect(selectionState()).toBe('49,0,1,cells');
  });

  it('supports Home, End, PageDown, and Tab', () => {
    render(<Harness />);
    fireEvent.keyDown(grid(), { key: 'End' });
    expect(selectionState()).toBe('0,19,1,cells');

    fireEvent.keyDown(grid(), { key: 'Home' });
    expect(selectionState()).toBe('0,0,1,cells');

    fireEvent.keyDown(grid(), { key: 'PageDown' });
    expect(selectionState().startsWith('20,0')).toBe(true);

    fireEvent.keyDown(grid(), { key: 'End', ctrlKey: true });
    expect(selectionState()).toBe('49,19,1,cells');

    fireEvent.keyDown(grid(), { key: 'Home', ctrlKey: true });
    fireEvent.keyDown(grid(), { key: 'Tab' });
    expect(selectionState()).toBe('0,1,1,cells');
  });

  it('selects everything with ctrl+a using a layout-independent key', () => {
    render(<Harness />);
    fireEvent.keyDown(grid(), { key: 'a', ctrlKey: true });
    expect(selectionState()).toBe('0,0,1000,all');
  });

  it('clears the selection with Delete', () => {
    const onClearSelection = vi.fn();
    render(<Harness onClearSelection={onClearSelection} />);
    fireEvent.keyDown(grid(), { key: 'Delete' });
    expect(onClearSelection).toHaveBeenCalled();
  });

  it('routes undo and redo shortcuts to the workbook history', () => {
    const onUndo = vi.fn();
    const onRedo = vi.fn();
    render(<Harness onUndo={onUndo} onRedo={onRedo} />);

    fireEvent.keyDown(grid(), { key: 'z', ctrlKey: true });
    fireEvent.keyDown(grid(), { key: 'z', ctrlKey: true, shiftKey: true });
    fireEvent.keyDown(grid(), { key: 'y', ctrlKey: true });

    expect(onUndo).toHaveBeenCalledTimes(1);
    expect(onRedo).toHaveBeenCalledTimes(2);
  });
});

describe('cell editing', () => {
  it('starts an edit from a printable character and commits with Enter', () => {
    const onCommit = vi.fn();
    render(<Harness onCommit={onCommit} />);

    fireEvent.keyDown(grid(), { key: 'x' });
    const editor = screen.getByRole('textbox', { name: 'Cell editor' }) as HTMLInputElement;
    expect(editor.value).toBe('x');

    fireEvent.change(editor, { target: { value: '42' } });
    fireEvent.keyDown(editor, { key: 'Enter' });

    expect(onCommit).toHaveBeenCalledWith({ row: 0, column: 0 }, '42');
    // Enter advances to the cell below.
    expect(selectionState()).toBe('1,0,1,cells');
  });

  it('opens the existing value with F2 and cancels with Escape', () => {
    const onCommit = vi.fn();
    render(<Harness onCommit={onCommit} />);

    fireEvent.keyDown(grid(), { key: 'F2' });
    const editor = screen.getByRole('textbox', { name: 'Cell editor' }) as HTMLInputElement;
    expect(editor.value).toBe('A1');

    fireEvent.change(editor, { target: { value: 'changed' } });
    fireEvent.keyDown(editor, { key: 'Escape' });

    expect(onCommit).not.toHaveBeenCalled();
    expect(screen.queryByRole('textbox', { name: 'Cell editor' })).toBeNull();
  });

  it('opens an edit on double-click and commits sideways with Tab', () => {
    const onCommit = vi.fn();
    render(<Harness onCommit={onCommit} />);

    fireEvent.doubleClick(screen.getByTestId('sheet-cell-surface'), pointFor(1, 0));
    const editor = screen.getByRole('textbox', { name: 'Cell editor' }) as HTMLInputElement;
    expect(editor.value).toBe('5');

    fireEvent.change(editor, { target: { value: '9' } });
    fireEvent.keyDown(editor, { key: 'Tab' });
    expect(onCommit).toHaveBeenCalledWith({ row: 1, column: 0 }, '9');
    expect(selectionState()).toBe('1,1,1,cells');
  });

  it('offers formula IntelliSense inside the cell editor', () => {
    const onCommit = vi.fn();
    render(<Harness onCommit={onCommit} />);

    fireEvent.keyDown(grid(), { key: '=' });
    const editor = screen.getByRole('textbox', { name: 'Cell editor' }) as HTMLInputElement;
    fireEvent.change(editor, { target: { value: '=SU', selectionStart: 3 } });

    expect(screen.getByLabelText('Cell formula IntelliSense')).toBeTruthy();
    expect(screen.getByRole('listbox', { name: 'Formula suggestions' })).toBeTruthy();

    fireEvent.keyDown(editor, { key: 'Enter' });
    expect(editor.value).toBe('=SUM(');
    expect(onCommit).not.toHaveBeenCalled();
    expect(screen.getByText('SUM(value, ...)')).toBeTruthy();

    fireEvent.keyDown(editor, { key: 'Enter' });
    expect(onCommit).toHaveBeenCalledWith({ row: 0, column: 0 }, '=SUM(');
  });

  it('supports mouse selection from in-cell formula suggestions', () => {
    render(<Harness />);

    fireEvent.keyDown(grid(), { key: '=' });
    const editor = screen.getByRole('textbox', { name: 'Cell editor' }) as HTMLInputElement;
    fireEvent.change(editor, { target: { value: '=AV', selectionStart: 3 } });
    fireEvent.mouseDown(screen.getAllByRole('option')[0]);

    expect(editor.value).toBe('=AVERAGE(');
  });
});

describe('read-only behavior', () => {
  it('never opens an editor or reports a clear', () => {
    const onCommit = vi.fn();
    const onClearSelection = vi.fn();
    render(<Harness readOnly onCommit={onCommit} onClearSelection={onClearSelection} />);

    fireEvent.keyDown(grid(), { key: 'x' });
    fireEvent.keyDown(grid(), { key: 'Enter' });
    fireEvent.keyDown(grid(), { key: 'F2' });
    fireEvent.keyDown(grid(), { key: 'Delete' });
    fireEvent.doubleClick(screen.getByTestId('sheet-cell-surface'), pointFor(0, 0));

    expect(screen.queryByRole('textbox', { name: 'Cell editor' })).toBeNull();
    expect(onCommit).not.toHaveBeenCalled();
    expect(onClearSelection).not.toHaveBeenCalled();
    expect(grid().getAttribute('aria-readonly')).toBe('true');

    // Navigation still works — read-only is not inert.
    fireEvent.keyDown(grid(), { key: 'ArrowDown' });
    expect(selectionState()).toBe('1,0,1,cells');
  });
});

describe('header interactions', () => {
  it('reports a column resize drag', () => {
    const onResizeTrack = vi.fn();
    render(<Harness onResizeTrack={onResizeTrack} />);

    const handle = screen.getByRole('separator', { name: 'Resize column A' });
    fireEvent.pointerDown(handle, { clientX: 100, clientY: 0 });
    fireEvent.pointerMove(window, { clientX: 160, clientY: 0 });
    fireEvent.pointerUp(window, { clientX: 160, clientY: 0 });

    expect(onResizeTrack).toHaveBeenCalledWith('column', 0, columnWidth + 60);
  });

  it('clamps a resize to the minimum width', () => {
    const onResizeTrack = vi.fn();
    render(<Harness onResizeTrack={onResizeTrack} />);

    const handle = screen.getByRole('separator', { name: 'Resize column A' });
    fireEvent.pointerDown(handle, { clientX: 100, clientY: 0 });
    fireEvent.pointerMove(window, { clientX: -500, clientY: 0 });
    fireEvent.pointerUp(window, { clientX: -500, clientY: 0 });

    expect(onResizeTrack).toHaveBeenCalledWith('column', 0, 24);
  });

  it('auto-sizes a column on header double-click', () => {
    const onAutoSizeColumn = vi.fn();
    render(<Harness onAutoSizeColumn={onAutoSizeColumn} />);
    fireEvent.doubleClick(screen.getByRole('columnheader', { name: 'A' }));
    expect(onAutoSizeColumn).toHaveBeenCalledWith(0);
  });
});

describe('hidden and frozen tracks', () => {
  it('skips hidden rows when rendering headers', () => {
    const worksheet = worksheetFixture();
    const hidden: SheetWorksheet = {
      ...worksheet,
      rows: { [worksheet.rowOrder[1]]: { id: worksheet.rowOrder[1], hidden: true } },
    };
    render(<Harness worksheet={hidden} />);
    expect(screen.queryByRole('rowheader', { name: 'Row 2' })).toBeNull();
    expect(screen.getByRole('rowheader', { name: 'Row 1' })).toBeTruthy();
    expect(screen.getByRole('rowheader', { name: 'Row 3' })).toBeTruthy();
  });

  it('keeps frozen rows and columns rendered at the origin', () => {
    const worksheet = { ...worksheetFixture(), frozen: { rows: 2, columns: 1 } };
    render(<Harness worksheet={worksheet} />);
    expect(screen.getByRole('rowheader', { name: 'Row 1' })).toBeTruthy();
    expect(screen.getByRole('columnheader', { name: 'A' })).toBeTruthy();
  });
});

describe('selection geometry', () => {
  it('reports the fill-handle drag target', () => {
    const onFillSelection = vi.fn();
    render(<Harness onFillSelection={onFillSelection} />);

    const handle = screen.getByRole('button', { name: 'Fill selection' });
    fireEvent.pointerDown(handle, pointFor(0, 0));
    fireEvent.pointerMove(window, pointFor(3, 0));
    fireEvent.pointerUp(window, pointFor(3, 0));

    expect(onFillSelection).toHaveBeenCalledWith({ row: 3, column: 0 });
  });

  it('normalizes a backwards drag', () => {
    let captured: SheetSelection | null = null;
    render(
      <Harness
        onSelectionChange={(selection) => {
          captured = selection;
        }}
      />,
    );

    const surface = screen.getByTestId('sheet-cell-surface');
    fireEvent.pointerDown(surface, { button: 0, ...pointFor(4, 4) });
    fireEvent.pointerMove(surface, pointFor(2, 1));

    expect(captured).not.toBeNull();
    expect(normalizeRange(captured!.ranges[0])).toEqual({ top: 2, left: 1, bottom: 4, right: 4 });
  });
});
