import { renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useImageInteractions } from './useImageInteractions';

describe('useImageInteractions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('creates a text overlay draft on pointer down in text mode', () => {
    const setOverlayItems = vi.fn();
    const setSelectedItemId = vi.fn();
    const setEditingTextId = vi.fn();

    const { result } = renderHook(() => useImageInteractions({
      viewportRef: { current: document.createElement('div') },
      textInputRefs: { current: {} },
      overlayDoc: { items: [] },
      dimensions: { width: 640, height: 480 },
      currentDimensions: { width: 640, height: 480 },
      additiveDisplayDimensions: { width: 320, height: 240 },
      rotatedDimensions: { width: 640, height: 480 },
      permanentEdits: { rotation: 0, crop: null, resizeWidth: null, resizeHeight: null, lockAspectRatio: true },
      cropMode: false,
      cropDraft: null,
      cropDragStart: null,
      cropInteraction: null,
      saveIntent: null,
      mode: 'additive',
      tool: 'text',
      overlayColor: '#38bdf8',
      fontSize: 20,
      strokeWidth: 4,
      lineStyle: 'solid',
      selectedItemId: null,
      editingTextId: null,
      textInteraction: null,
      arrowInteraction: null,
      setMode: vi.fn(),
      setTool: vi.fn(),
      setOverlayItems,
      setSelectedItemId,
      setEditingTextId,
      setDraftArrow: vi.fn(),
      setDraftStroke: vi.fn(),
      draftArrow: null,
      draftStroke: null,
      setPermanentEdits: vi.fn(),
      setCropMode: vi.fn(),
      setCropDraft: vi.fn(),
      setCropDragStart: vi.fn(),
      setCropInteraction: vi.fn(),
      setZoomPercent: vi.fn(),
      setTextInteraction: vi.fn(),
      setArrowInteraction: vi.fn(),
      createId: () => 'text-1',
    }));

    const currentTarget = document.createElement('div');
    currentTarget.getBoundingClientRect = () => ({ left: 0, top: 0, width: 200, height: 100, right: 200, bottom: 100, x: 0, y: 0, toJSON() { return {}; } });
    result.current.handleOverlayPointerDown({
      currentTarget,
      clientX: 50,
      clientY: 20,
    } as unknown as React.PointerEvent<HTMLDivElement>);

    expect(setOverlayItems).toHaveBeenCalled();
    expect(setSelectedItemId).toHaveBeenCalledWith('text-1');
    expect(setEditingTextId).toHaveBeenCalledWith('text-1');
  });

  it('resets zoom on Ctrl+0', () => {
    const viewport = document.createElement('div');
    document.body.appendChild(viewport);
    const setZoomPercent = vi.fn();

    renderHook(() => useImageInteractions({
      viewportRef: { current: viewport },
      textInputRefs: { current: {} },
      overlayDoc: { items: [] },
      dimensions: { width: 640, height: 480 },
      currentDimensions: { width: 640, height: 480 },
      additiveDisplayDimensions: { width: 320, height: 240 },
      rotatedDimensions: { width: 640, height: 480 },
      permanentEdits: { rotation: 0, crop: null, resizeWidth: null, resizeHeight: null, lockAspectRatio: true },
      cropMode: false,
      cropDraft: null,
      cropDragStart: null,
      cropInteraction: null,
      saveIntent: null,
      mode: 'view',
      tool: 'select',
      overlayColor: '#38bdf8',
      fontSize: 20,
      strokeWidth: 4,
      lineStyle: 'solid',
      selectedItemId: null,
      editingTextId: null,
      textInteraction: null,
      arrowInteraction: null,
      setMode: vi.fn(),
      setTool: vi.fn(),
      setOverlayItems: vi.fn(),
      setSelectedItemId: vi.fn(),
      setEditingTextId: vi.fn(),
      setDraftArrow: vi.fn(),
      setDraftStroke: vi.fn(),
      draftArrow: null,
      draftStroke: null,
      setPermanentEdits: vi.fn(),
      setCropMode: vi.fn(),
      setCropDraft: vi.fn(),
      setCropDragStart: vi.fn(),
      setCropInteraction: vi.fn(),
      setZoomPercent,
      setTextInteraction: vi.fn(),
      setArrowInteraction: vi.fn(),
      createId: () => 'id',
    }));

    document.dispatchEvent(new KeyboardEvent('keydown', { key: '0', ctrlKey: true, bubbles: true }));
    expect(setZoomPercent).toHaveBeenCalledWith(100);
    viewport.remove();
  });
});
