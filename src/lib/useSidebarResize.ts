import { useCallback, useEffect, useRef, useState } from 'react';

/** Local geometry during the gesture; one durable commit when it finishes. */
export function useSidebarResize(width: number, commit: (width: number) => void) {
  const element = useRef<HTMLDivElement>(null);
  const gesture = useRef<{
    x: number;
    width: number;
    latest: number;
    cursor: string;
    select: string;
  } | null>(null);
  const frame = useRef<number | null>(null);
  const [resizing, setResizing] = useState(false);
  const start = useCallback(
    (event: React.MouseEvent) => {
      if (event.button !== 0) return;
      event.preventDefault();
      gesture.current = {
        x: event.clientX,
        width,
        latest: width,
        cursor: document.body.style.cursor,
        select: document.body.style.userSelect,
      };
      setResizing(true);
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
    },
    [width],
  );
  useEffect(() => {
    const paint = () => {
      frame.current = null;
      if (gesture.current)
        element.current?.style.setProperty('--sidebar-width', `${gesture.current.latest}px`);
    };
    const move = (event: MouseEvent) => {
      const current = gesture.current;
      if (!current) return;
      current.latest = Math.min(400, Math.max(160, current.width + event.clientX - current.x));
      if (frame.current === null) frame.current = requestAnimationFrame(paint);
    };
    const finish = () => {
      const current = gesture.current;
      if (!current) return;
      if (frame.current !== null) cancelAnimationFrame(frame.current);
      paint();
      gesture.current = null;
      document.body.style.cursor = current.cursor;
      document.body.style.userSelect = current.select;
      setResizing(false);
      if (current.latest !== current.width) commit(current.latest);
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', finish);
    window.addEventListener('blur', finish);
    return () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', finish);
      window.removeEventListener('blur', finish);
      if (frame.current !== null) cancelAnimationFrame(frame.current);
      const current = gesture.current;
      if (current) {
        document.body.style.cursor = current.cursor;
        document.body.style.userSelect = current.select;
        gesture.current = null;
      }
    };
  }, [commit]);
  return { element, start, resizing };
}
