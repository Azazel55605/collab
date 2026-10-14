import { useEffect, useRef, useState } from 'react';

import { getCurrentWebview } from '@tauri-apps/api/webview';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { toast } from 'sonner';

import { resolveNativeDropPoint } from '../../lib/nativeDropCoordinates';

interface NativeDropPayload {
  type: 'enter' | 'over' | 'drop' | 'leave';
  paths?: string[];
  position?: { x: number; y: number };
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
  scope?: string,
): { isDraggingOver: boolean } {
  const [isDraggingOver, setIsDraggingOver] = useState(false);
  const onDropRef = useRef(onDropFiles);
  onDropRef.current = onDropFiles;
  const lastDropRef = useRef<{ key: string; at: number }>({ key: '', at: 0 });

  useEffect(() => {
    setIsDraggingOver(false);
    if (!enabled) return;
    let unlistenWebview: (() => void) | null = null;
    let unlistenWindow: (() => void) | null = null;
    let disposed = false;
    let positionGeneration = 0;

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
      if (disposed) return;
      const generation = ++positionGeneration;
      if (payload.type === 'leave') {
        setIsDraggingOver(false);
        return;
      }
      if (!payload.position) return;
      if (payload.type === 'drop') setIsDraggingOver(false);
      void resolveNativeDropPoint(
        payload.position,
        payload.type === 'drop' || payload.type === 'enter',
      )
        .then((point) => {
          if (disposed || (payload.type !== 'drop' && generation !== positionGeneration)) return;
          const inside = isInsideContainer(point);
          if (payload.type === 'enter' || payload.type === 'over') {
            setIsDraggingOver(inside);
            return;
          }
          if (payload.type === 'drop') {
            if (!inside || !payload.paths?.length) return;
            const key = payload.paths.join('\n');
            const now = Date.now();
            if (key === lastDropRef.current.key && now - lastDropRef.current.at < 400) return;
            lastDropRef.current = { key, at: now };
            onDropRef.current(payload.paths, point);
          }
        })
        .catch((error) => {
          if (disposed) return;
          console.error('[useNativeFileDrop] could not map drop position:', error);
          if (payload.type === 'drop') {
            toast.error('Could not determine the file drop target. Please try again.');
          } else if (generation === positionGeneration) {
            setIsDraggingOver(false);
          }
        });
    };

    const subscribe = (
      source: {
        onDragDropEvent: (
          handler: (event: { payload: NativeDropPayload }) => void,
        ) => Promise<() => void>;
      },
      assign: (unlisten: () => void) => void,
      label: string,
      fallback?: () => void,
    ) => {
      source
        .onDragDropEvent((event) => handle(event.payload))
        .then((unlisten) => {
          if (disposed) unlisten();
          else assign(unlisten);
        })
        .catch((err) => {
          console.error(`[useNativeFileDrop] failed to attach ${label} listener:`, err);
          if (!disposed) fallback?.();
        });
    };

    // Guard against environments without a Tauri runtime (e.g. the test harness),
    // where acquiring the webview/window handle can throw synchronously.
    const subscribeWindow = () => {
      try {
        subscribe(
          getCurrentWindow(),
          (u) => {
            unlistenWindow = u;
          },
          'window',
        );
      } catch (error) {
        console.error('[useNativeFileDrop] window fallback unavailable:', error);
      }
    };
    try {
      // One coordinate source per drag. Window and webview events must not race
      // to import the same paths into different hit targets.
      subscribe(
        getCurrentWebview(),
        (u) => {
          unlistenWebview = u;
        },
        'webview',
        subscribeWindow,
      );
    } catch (err) {
      console.error('[useNativeFileDrop] webview drag-drop unavailable:', err);
      try {
        subscribeWindow();
      } catch (fallbackError) {
        console.error('[useNativeFileDrop] window fallback unavailable:', fallbackError);
      }
    }

    return () => {
      disposed = true;
      unlistenWebview?.();
      unlistenWindow?.();
    };
  }, [containerRef, enabled, scope]);

  return { isDraggingOver };
}
