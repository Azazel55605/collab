import { useCallback, useEffect } from 'react';

import type { CanvasPickerMode } from './CanvasPickerDialog';
import type { Viewport } from '@xyflow/react';

const MIN_CANVAS_ZOOM = 0.2;
const MAX_CANVAS_ZOOM = 2.5;
const ZOOM_STEP = 1.15;

interface ReactFlowViewportApi {
  setViewport: (viewport: Viewport, options?: { duration?: number }) => void | Promise<unknown>;
  fitView: (options?: { duration?: number; padding?: number }) => Promise<unknown>;
  getViewport: () => Viewport;
}

interface UseCanvasViewportControlsOptions {
  reactFlow: ReactFlowViewportApi;
  viewport: Viewport;
  setViewport: (viewport: Viewport) => void;
  pickerMode: CanvasPickerMode;
  setPickerMode: (mode: CanvasPickerMode) => void;
  addTextNode: () => void;
  addWebNode: () => void;
  deleteSelection: () => void;
}

function isEditableTarget(target: EventTarget | null) {
  return target instanceof HTMLElement
    && target.matches('input, textarea, [contenteditable="true"], [contenteditable=""], [role="textbox"], [role="combobox"]');
}

export function useCanvasViewportControls({
  reactFlow,
  viewport,
  setViewport,
  pickerMode,
  setPickerMode,
  addTextNode,
  addWebNode,
  deleteSelection,
}: UseCanvasViewportControlsOptions) {
  const syncViewport = useCallback((nextViewport: Viewport, duration = 180) => {
    void reactFlow.setViewport(nextViewport, { duration });
    setViewport(nextViewport);
  }, [reactFlow, setViewport]);

  const panViewport = useCallback((deltaX: number, deltaY: number) => {
    syncViewport({
      x: viewport.x + deltaX,
      y: viewport.y + deltaY,
      zoom: viewport.zoom,
    });
  }, [syncViewport, viewport.x, viewport.y, viewport.zoom]);

  const adjustZoom = useCallback((direction: 1 | -1) => {
    const nextZoom = Math.min(MAX_CANVAS_ZOOM, Math.max(MIN_CANVAS_ZOOM, viewport.zoom * (direction > 0 ? ZOOM_STEP : 1 / ZOOM_STEP)));
    syncViewport({
      x: viewport.x,
      y: viewport.y,
      zoom: nextZoom,
    });
  }, [syncViewport, viewport.x, viewport.y, viewport.zoom]);

  const resetZoom = useCallback(() => {
    syncViewport({
      x: viewport.x,
      y: viewport.y,
      zoom: 1,
    });
  }, [syncViewport, viewport.x, viewport.y]);

  const fitCanvasView = useCallback(() => {
    void reactFlow.fitView({ duration: 180, padding: 0.12 }).then(() => {
      setViewport(reactFlow.getViewport());
    });
  }, [reactFlow, setViewport]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (isEditableTarget(event.target) || event.altKey) return;

      const zoomModifier = event.ctrlKey || event.metaKey;

      if (zoomModifier && (event.key === 'ArrowUp' || event.key === '+' || event.key === '=')) {
        event.preventDefault();
        adjustZoom(1);
        return;
      }

      if (zoomModifier && (event.key === 'ArrowDown' || event.key === '-')) {
        event.preventDefault();
        adjustZoom(-1);
        return;
      }

      if ((zoomModifier || !event.shiftKey) && event.key === '0') {
        event.preventDefault();
        resetZoom();
        return;
      }

      switch (event.key) {
        case 'n':
        case 'N':
          event.preventDefault();
          setPickerMode('note');
          break;
        case 'f':
          if (!event.shiftKey) {
            event.preventDefault();
            setPickerMode('file');
          }
          break;
        case 'F':
          event.preventDefault();
          fitCanvasView();
          break;
        case 't':
        case 'T':
          event.preventDefault();
          addTextNode();
          break;
        case 'w':
        case 'W':
          event.preventDefault();
          addWebNode();
          break;
        case 'ArrowUp':
          event.preventDefault();
          panViewport(0, 120);
          break;
        case 'ArrowDown':
          event.preventDefault();
          panViewport(0, -120);
          break;
        case 'ArrowLeft':
          event.preventDefault();
          panViewport(120, 0);
          break;
        case 'ArrowRight':
          event.preventDefault();
          panViewport(-120, 0);
          break;
        case 'Delete':
        case 'Backspace':
          event.preventDefault();
          deleteSelection();
          break;
        case 'Escape':
          if (pickerMode !== null) {
            event.preventDefault();
            setPickerMode(null);
          }
          break;
      }
    };

    document.addEventListener('keydown', handleKeyDown, { capture: true });
    return () => {
      document.removeEventListener('keydown', handleKeyDown, { capture: true } as EventListenerOptions);
    };
  }, [addTextNode, addWebNode, adjustZoom, deleteSelection, fitCanvasView, panViewport, pickerMode, resetZoom, setPickerMode]);

  return {
    adjustZoom,
    fitCanvasView,
    panViewport,
    resetZoom,
    syncViewport,
  };
}
