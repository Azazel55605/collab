import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { useImageInteractions } from './useImageInteractions';

function options() {
  return {
    viewportRef: { current: document.createElement('div') },
    currentDimensions: { width: 640, height: 480 },
    rotatedDimensions: { width: 640, height: 480 },
    permanentEdits: {
      rotation: 0 as const,
      crop: null,
      resizeWidth: null,
      resizeHeight: null,
      lockAspectRatio: true,
    },
    cropMode: false,
    cropDraft: null,
    cropDragStart: null,
    cropInteraction: null,
    dialogOpen: false,
    setMode: vi.fn(),
    setPermanentEdits: vi.fn(),
    setCropMode: vi.fn(),
    setCropDraft: vi.fn(),
    setCropDragStart: vi.fn(),
    setCropInteraction: vi.fn(),
    setZoomPercent: vi.fn(),
  };
}

describe('useImageInteractions', () => {
  it('starts a crop from the current transformed bounds', () => {
    const input = options();
    const { result } = renderHook(() => useImageInteractions(input));

    act(() => result.current.beginCrop());

    expect(input.setMode).toHaveBeenCalledWith('permanent');
    expect(input.setCropMode).toHaveBeenCalledWith(true);
    expect(input.setCropDraft).toHaveBeenCalledWith({ x: 0, y: 0, width: 640, height: 480 });
  });

  it('resets zoom on Ctrl+0', () => {
    const input = options();
    document.body.appendChild(input.viewportRef.current);
    renderHook(() => useImageInteractions(input));

    act(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: '0', ctrlKey: true })));

    expect(input.setZoomPercent).toHaveBeenCalledWith(100);
  });
});
