import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { createEmptySheetDocument } from '../../../../src/lib/sheet/document';
import { activeWorksheet, setCell, setFrozen } from '../../../../src/lib/sheet/operations';
import { createSelection, type SheetSelection } from '../../../../src/lib/sheet/selection';
import type { SheetDocument } from '../../../../src/types/sheet';

import { SheetTouchGrid } from './SheetTouchGrid';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));

class ResizeObserverMock {
  observe() {}
  disconnect() {}
}
Object.defineProperty(globalThis, 'ResizeObserver', {
  configurable: true,
  value: ResizeObserverMock,
});

function fixture(rows: number, columns: number): SheetDocument {
  let workbook = createEmptySheetDocument('Grid', {
    timestamp: '2026-07-30T00:00:00.000Z',
    worksheet: { rows, columns },
  });
  const sheetId = activeWorksheet(workbook).id;
  workbook = setCell(
    workbook,
    sheetId,
    { row: 0, column: 0 },
    { value: 'Origin', valueType: 'text' },
  );
  return workbook;
}

function renderGrid(
  workbook: SheetDocument,
  selection: SheetSelection = createSelection({ row: 0, column: 0 }),
  overrides: Partial<Parameters<typeof SheetTouchGrid>[0]> = {},
) {
  const onSelectionChange = vi.fn();
  const onActivateCell = vi.fn();
  const onLongPressCell = vi.fn();
  const view = render(
    <SheetTouchGrid
      document={workbook}
      worksheet={activeWorksheet(workbook)}
      selection={selection}
      onSelectionChange={onSelectionChange}
      onActivateCell={onActivateCell}
      onLongPressCell={onLongPressCell}
      {...overrides}
    />,
  );
  return { view, onSelectionChange, onActivateCell, onLongPressCell };
}

function cellCount(): number {
  return document.querySelectorAll('[data-cell]').length;
}

describe('mobile touch grid', () => {
  it('renders only the viewport window, not the logical grid', () => {
    // 1,000,000 x 16,384 is the schema limit; the DOM must stay tiny.
    renderGrid(fixture(1_000_000, 16_384));
    const rendered = cellCount();
    expect(rendered).toBeGreaterThan(0);
    // A 360 x 480 fallback viewport at 24 px rows / 100 px columns plus overscan.
    expect(rendered).toBeLessThan(400);
    expect(screen.getByRole('grid').getAttribute('aria-rowcount')).toBe('1000000');
    expect(screen.getByRole('grid').getAttribute('aria-colcount')).toBe('16384');
  });

  it('keeps frozen rows and columns rendered while the window scrolls away', () => {
    const workbook = fixture(500, 40);
    const frozen = setFrozen(workbook, activeWorksheet(workbook).id, { rows: 1, columns: 1 });
    renderGrid(frozen);
    const grid = screen.getByRole('grid');

    fireEvent.scroll(grid, { target: { scrollTop: 4_000, scrollLeft: 2_000 } });
    // The frozen row/column headers and their cells survive the scroll.
    expect(document.querySelector('[data-cell="0,0"]')).not.toBeNull();
    expect(screen.getByRole('button', { name: '1' })).not.toBeNull();
    expect(screen.getByRole('button', { name: 'A' })).not.toBeNull();
  });

  it('selects a tapped cell and activates the already-active one', () => {
    const { onSelectionChange, onActivateCell } = renderGrid(fixture(50, 10));
    const grid = screen.getByRole('grid');

    // Row 2, column 1 in the fallback geometry (24 px rows, 100 px columns).
    fireEvent.touchStart(grid, { touches: [{ clientX: 150, clientY: 90 }] });
    fireEvent.touchEnd(grid, { changedTouches: [{ clientX: 150, clientY: 90 }] });
    expect(onSelectionChange).toHaveBeenCalledWith(
      expect.objectContaining({ active: { row: 2, column: 1 } }),
    );
    expect(onActivateCell).not.toHaveBeenCalled();

    // Tapping the active cell (A1) opens the editor instead of reselecting.
    fireEvent.touchStart(grid, { touches: [{ clientX: 60, clientY: 30 }] });
    fireEvent.touchEnd(grid, { changedTouches: [{ clientX: 60, clientY: 30 }] });
    expect(onActivateCell).toHaveBeenCalledWith({ row: 0, column: 0 });
  });

  it('extends the selection by dragging the end handle', () => {
    const { onSelectionChange } = renderGrid(fixture(50, 10));
    const handle = screen.getByLabelText('Extend selection end');

    fireEvent.touchStart(handle, { touches: [{ clientX: 60, clientY: 30 }] });
    fireEvent.touchMove(handle, { touches: [{ clientX: 250, clientY: 90 }] });

    expect(onSelectionChange).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'cells',
        ranges: [{ anchor: { row: 0, column: 0 }, focus: { row: 2, column: 2 } }],
      }),
    );
  });

  it('reports a pinch as a bounded scale change', () => {
    const onScaleChange = vi.fn();
    renderGrid(fixture(50, 10), createSelection({ row: 0, column: 0 }), {
      scale: 1,
      onScaleChange,
    });
    const grid = screen.getByRole('grid');

    fireEvent.touchStart(grid, {
      touches: [
        { clientX: 100, clientY: 100 },
        { clientX: 200, clientY: 100 },
      ],
    });
    fireEvent.touchMove(grid, {
      touches: [
        { clientX: 60, clientY: 100 },
        { clientX: 260, clientY: 100 },
      ],
    });

    expect(onScaleChange).toHaveBeenCalledWith(2);

    // Beyond the maximum, the scale clamps rather than growing without bound.
    fireEvent.touchMove(grid, {
      touches: [
        { clientX: 0, clientY: 100 },
        { clientX: 2_000, clientY: 100 },
      ],
    });
    expect(onScaleChange).toHaveBeenLastCalledWith(2.4);
  });

  it('long-pressing selects the cell and asks for its actions', () => {
    vi.useFakeTimers();
    try {
      const { onSelectionChange, onLongPressCell } = renderGrid(fixture(50, 10));
      const grid = screen.getByRole('grid');
      fireEvent.touchStart(grid, { touches: [{ clientX: 150, clientY: 90 }] });
      vi.advanceTimersByTime(420);
      expect(onSelectionChange).toHaveBeenCalledWith(
        expect.objectContaining({ active: { row: 2, column: 1 } }),
      );
      expect(onLongPressCell).toHaveBeenCalledWith({ row: 2, column: 1 });
    } finally {
      vi.useRealTimers();
    }
  });
});
