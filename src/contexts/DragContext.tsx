import { createContext, type ReactNode, useCallback, useContext, useRef, useState } from 'react';

export interface DraggingTabInfo {
  relativePath: string;
  title: string;
  type: string;
}

export interface DragPoint {
  x: number;
  y: number;
}

/** Notified of the live pointer position during a drag (null while idle). */
type PointerSubscriber = (point: DragPoint | null) => void;
/** Consulted on drop; returns true if it consumed the drop at that point. */
type DropResolver = (point: DragPoint) => boolean;

interface DragContextValue {
  draggingTab: DraggingTabInfo | null;
  /** Begin a pointer-driven tab drag from a pointerdown on a tab. */
  startTabDrag: (tab: DraggingTabInfo, event: React.PointerEvent) => void;
  /** Imperatively clear an active drag (used for programmatic cancels). */
  setDraggingTab: (tab: DraggingTabInfo | null) => void;
  /** Subscribe to live pointer position during a drag; returns an unsubscribe fn. */
  subscribePointer: (subscriber: PointerSubscriber) => () => void;
  /** Register a drop resolver consulted on pointerup at the drop point. */
  registerDropResolver: (resolver: DropResolver) => () => void;
}

const noop = () => {};

const DragContext = createContext<DragContextValue>({
  draggingTab: null,
  startTabDrag: noop,
  setDraggingTab: noop,
  subscribePointer: () => noop,
  registerDropResolver: () => noop,
});

// Distance (in CSS px) the pointer must travel before a click becomes a drag.
const DRAG_THRESHOLD = 5;

/**
 * Tab dragging is implemented with pointer events rather than the HTML5
 * drag-and-drop API on purpose: on Windows the WebView2 runtime intercepts all
 * HTML5 drag operations (so it can deliver native OS file drops via Tauri's
 * `onDragDropEvent`), which prevents in-page `dragstart`/`dragover`/`drop` from
 * firing at all. Pointer events are not intercepted, so tab reorder and split
 * dropping work identically on Windows and Linux while native file import keeps
 * working. Do not reintroduce `draggable`/`dataTransfer` for tabs.
 */
export function DragProvider({ children }: { children: ReactNode }) {
  const [draggingTab, setDraggingTabState] = useState<DraggingTabInfo | null>(null);
  const pointerSubscribers = useRef<Set<PointerSubscriber>>(new Set());
  const dropResolvers = useRef<Set<DropResolver>>(new Set());

  const emitPointer = useCallback((point: DragPoint | null) => {
    pointerSubscribers.current.forEach((subscriber) => subscriber(point));
  }, []);

  const subscribePointer = useCallback((subscriber: PointerSubscriber) => {
    pointerSubscribers.current.add(subscriber);
    return () => {
      pointerSubscribers.current.delete(subscriber);
    };
  }, []);

  const registerDropResolver = useCallback((resolver: DropResolver) => {
    dropResolvers.current.add(resolver);
    return () => {
      dropResolvers.current.delete(resolver);
    };
  }, []);

  const setDraggingTab = useCallback(
    (tab: DraggingTabInfo | null) => {
      setDraggingTabState(tab);
      if (!tab) emitPointer(null);
    },
    [emitPointer],
  );

  const startTabDrag = useCallback(
    (tab: DraggingTabInfo, event: React.PointerEvent) => {
      // Only left-button drags; ignore middle/right (close, context menu).
      if (event.button !== 0) return;
      const startX = event.clientX;
      const startY = event.clientY;
      let started = false;

      const restoreSelection = () => {
        document.body.style.userSelect = '';
        document.body.style.cursor = '';
      };

      const cleanup = () => {
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        window.removeEventListener('pointercancel', onCancel);
      };

      const onMove = (e: PointerEvent) => {
        const point = { x: e.clientX, y: e.clientY };
        if (!started) {
          if (Math.hypot(e.clientX - startX, e.clientY - startY) < DRAG_THRESHOLD) return;
          started = true;
          document.body.style.userSelect = 'none';
          document.body.style.cursor = 'grabbing';
          setDraggingTabState(tab);
        }
        emitPointer(point);
      };

      const onUp = (e: PointerEvent) => {
        cleanup();
        if (started) {
          const point = { x: e.clientX, y: e.clientY };
          for (const resolver of dropResolvers.current) {
            if (resolver(point)) break;
          }
        }
        restoreSelection();
        setDraggingTabState(null);
        emitPointer(null);
      };

      const onCancel = () => {
        cleanup();
        restoreSelection();
        setDraggingTabState(null);
        emitPointer(null);
      };

      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
      window.addEventListener('pointercancel', onCancel);
    },
    [emitPointer],
  );

  return (
    <DragContext.Provider
      value={{ draggingTab, startTabDrag, setDraggingTab, subscribePointer, registerDropResolver }}
    >
      {children}
    </DragContext.Provider>
  );
}

export const useDragContext = () => useContext(DragContext);
