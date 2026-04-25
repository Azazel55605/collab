import { renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { useCanvasViewportControls } from './useCanvasViewportControls';

describe('useCanvasViewportControls', () => {
  it('adjusts zoom through the shared viewport updater', () => {
    const setViewport = vi.fn();
    const reactFlow = {
      setViewport: vi.fn(),
      fitView: vi.fn(async () => {}),
      getViewport: vi.fn(() => ({ x: 0, y: 0, zoom: 1 })),
    };

    const { result } = renderHook(() => useCanvasViewportControls({
      reactFlow,
      viewport: { x: 10, y: 20, zoom: 1 },
      setViewport,
      pickerMode: null,
      setPickerMode: vi.fn(),
      addTextNode: vi.fn(),
      addWebNode: vi.fn(),
      deleteSelection: vi.fn(),
    }));

    result.current.adjustZoom(1);

    expect(reactFlow.setViewport).toHaveBeenCalledWith(
      { x: 10, y: 20, zoom: 1.15 },
      { duration: 180 },
    );
    expect(setViewport).toHaveBeenCalledWith({ x: 10, y: 20, zoom: 1.15 });
  });

  it('handles keyboard shortcuts for picker mode and delete actions', () => {
    const setPickerMode = vi.fn();
    const addTextNode = vi.fn();
    const deleteSelection = vi.fn();

    renderHook(() => useCanvasViewportControls({
      reactFlow: {
        setViewport: vi.fn(),
        fitView: vi.fn(async () => {}),
        getViewport: vi.fn(() => ({ x: 0, y: 0, zoom: 1 })),
      },
      viewport: { x: 0, y: 0, zoom: 1 },
      setViewport: vi.fn(),
      pickerMode: null,
      setPickerMode,
      addTextNode,
      addWebNode: vi.fn(),
      deleteSelection,
    }));

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'n', bubbles: true, cancelable: true }));
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 't', bubbles: true, cancelable: true }));
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true, cancelable: true }));

    expect(setPickerMode).toHaveBeenCalledWith('note');
    expect(addTextNode).toHaveBeenCalled();
    expect(deleteSelection).toHaveBeenCalled();
  });

  it('fits the canvas and syncs the resulting viewport', async () => {
    const setViewport = vi.fn();
    const reactFlow = {
      setViewport: vi.fn(),
      fitView: vi.fn(async () => {}),
      getViewport: vi.fn(() => ({ x: 12, y: 34, zoom: 0.8 })),
    };

    const { result } = renderHook(() => useCanvasViewportControls({
      reactFlow,
      viewport: { x: 0, y: 0, zoom: 1 },
      setViewport,
      pickerMode: null,
      setPickerMode: vi.fn(),
      addTextNode: vi.fn(),
      addWebNode: vi.fn(),
      deleteSelection: vi.fn(),
    }));

    result.current.fitCanvasView();

    await waitFor(() => {
      expect(setViewport).toHaveBeenCalledWith({ x: 12, y: 34, zoom: 0.8 });
    });
  });
});
