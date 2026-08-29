import { useEffect, useRef, useState } from 'react';

import { getCurrentWebview } from '@tauri-apps/api/webview';
import { getCurrentWindow } from '@tauri-apps/api/window';

interface NativeDropPayload {
  type: 'enter' | 'over' | 'drop' | 'leave';
  paths?: string[];
  position?: { x: number; y: number };
}

function toClientPoint(position: { x: number; y: number }) {
  // Tauri drag-drop coordinates are physical pixels; convert to CSS pixels.
  const ratio = window.devicePixelRatio || 1;
  return { x: position.x / ratio, y: position.y / ratio };
}

/**
 * Subscribes to native OS file drag-and-drop and reports drops that land inside
 * the given container. Mirrors the editor's native-drop hit-testing so the same
 * desktop drag can target different surfaces (editor vs file tree) by position.
 * Returns whether files are currently hovering the container so callers can show
 * a drop highlight.
 */
export function useNativeFileDrop(
  containerRef: React.RefObject<HTMLElement | null>,
  onDropFiles: (paths: string[], point: { x: number; y: number }) => void,
  enabled = true,
): { isDraggingOver: boolean } {
  const [isDraggingOver, setIsDraggingOver] = useState(false);
  const onDropRef = useRef(onDropFiles);
  onDropRef.current = onDropFiles;
  const lastDropRef = useRef<{ key: string; at: number }>({ key: '', at: 0 });

  useEffect(() => {
    if (!enabled) return;
    let unlistenWebview: (() => void) | null = null;
    let unlistenWindow: (() => void) | null = null;
    let disposed = false;

    const isInsideContainer = (point: { x: number; y: number }) => {
      const el = containerRef.current;
      if (!el) return false;
      const rect = el.getBoundingClientRect();
      return (
        point.x >= rect.left &&
        point.x <= rect.right &&
        point.y >= rect.top &&
        point.y <= rect.bottom
      );
    };

    const handle = (payload: NativeDropPayload) => {
      if (payload.type === 'leave') {
        setIsDraggingOver(false);
        return;
      }
      if (!payload.position) return;
      const point = toClientPoint(payload.position);
      const inside = isInsideContainer(point);

      if (payload.type === 'enter' || payload.type === 'over') {
        setIsDraggingOver(inside);
        return;
      }

      if (payload.type === 'drop') {
        setIsDraggingOver(false);
        if (!inside || !payload.paths || payload.paths.length === 0) return;
        // The webview and window emitters can both fire for one drop; collapse them.
        const key = `${payload.paths.join('\n')}@@${Math.round(point.x)}:${Math.round(point.y)}`;
        const now = Date.now();
        if (key === lastDropRef.current.key && now - lastDropRef.current.at < 400) return;
        lastDropRef.current = { key, at: now };
        onDropRef.current(payload.paths, point);
      }
    };

    const subscribe = (
      source: {
        onDragDropEvent: (
          handler: (event: { payload: NativeDropPayload }) => void,
        ) => Promise<() => void>;
      },
      assign: (unlisten: () => void) => void,
      label: string,
    ) => {
      source
        .onDragDropEvent((event) => handle(event.payload))
        .then((unlisten) => {
          if (disposed) unlisten();
          else assign(unlisten);
        })
        .catch((err) =>
          console.error(`[useNativeFileDrop] failed to attach ${label} listener:`, err),
        );
    };

    // Guard against environments without a Tauri runtime (e.g. the test harness),
    // where acquiring the webview/window handle can throw synchronously.
    try {
      subscribe(
        getCurrentWebview(),
        (u) => {
          unlistenWebview = u;
        },
        'webview',
      );
      subscribe(
        getCurrentWindow(),
        (u) => {
          unlistenWindow = u;
        },
        'window',
      );
    } catch (err) {
      console.error('[useNativeFileDrop] native drag-drop unavailable:', err);
    }

    return () => {
      disposed = true;
      unlistenWebview?.();
      unlistenWindow?.();
    };
  }, [containerRef, enabled]);

  return { isDraggingOver };
}
