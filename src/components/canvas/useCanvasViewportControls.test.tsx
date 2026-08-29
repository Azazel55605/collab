import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { useCanvasViewportControls } from './useCanvasViewportControls';

function Harness({ onDuplicateSelection }: { onDuplicateSelection: () => void }) {
  useCanvasViewportControls({
    reactFlow: {
      setViewport: vi.fn(),
      fitView: vi.fn(async () => {}),
      getViewport: () => ({ x: 0, y: 0, zoom: 1 }),
    },
    viewport: { x: 0, y: 0, zoom: 1 },
    setViewport: vi.fn(),
    pickerMode: null,
    setPickerMode: vi.fn(),
    addTextNode: vi.fn(),
    addWebNode: vi.fn(),
    duplicateSelection: onDuplicateSelection,
    deleteSelection: vi.fn(),
  });

  return null;
}

describe('useCanvasViewportControls', () => {
  afterEach(() => {
    cleanup();
  });

  it('duplicates the current selection on ctrl+d', () => {
    const onDuplicateSelection = vi.fn();
    render(<Harness onDuplicateSelection={onDuplicateSelection} />);

    document.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'd', ctrlKey: true, bubbles: true }),
    );

    expect(onDuplicateSelection).toHaveBeenCalledTimes(1);
  });
});
