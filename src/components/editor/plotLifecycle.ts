import { type RefObject, useEffect, useState, useSyncExternalStore } from 'react';

/** Three leases of at most two million physical pixels: six million in aggregate. */
export const PLOT_PIXEL_BUDGET = 2_000_000;
export const PLOT_RENDERER_LIMIT = 3;
const requests = new Map<symbol, number>();
const listeners = new Set<() => void>();
let sequence = 0;
const notify = () => {
  for (const listener of listeners) listener();
};
export function requestPlotLease(id: symbol) {
  requests.set(id, ++sequence);
  notify();
  return () => {
    requests.delete(id);
    notify();
  };
}
export function prioritizePlotLease(id: symbol) {
  if (requests.has(id)) {
    requests.set(id, ++sequence);
    notify();
  }
}
export function hasPlotLease(id: symbol) {
  return [...requests.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, PLOT_RENDERER_LIMIT)
    .some(([candidate]) => candidate === id);
}
export function usePlotVisibility(ref: RefObject<HTMLElement | null>) {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    let intersecting = typeof IntersectionObserver === 'undefined';
    const update = () => setVisible(intersecting && document.visibilityState !== 'hidden');
    const observer =
      typeof IntersectionObserver === 'undefined'
        ? null
        : new IntersectionObserver(([entry]) => {
            intersecting = entry.isIntersecting;
            update();
          });
    observer?.observe(node);
    document.addEventListener('visibilitychange', update);
    update();
    return () => {
      observer?.disconnect();
      document.removeEventListener('visibilitychange', update);
    };
  }, [ref]);
  return visible;
}
export function usePlotLease(visible: boolean) {
  const [id] = useState(() => Symbol('plot'));
  useEffect(() => (visible ? requestPlotLease(id) : undefined), [id, visible]);
  const active = useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    () => visible && hasPlotLease(id),
  );
  return { active, activate: () => prioritizePlotLease(id) };
}

/** Invalidation coalesces changes; an idle plot owns no animation frame. */
export function createPlotInvalidator(draw: () => void) {
  let frame: number | null = null;
  let disposed = false;
  return {
    invalidate() {
      if (!disposed && frame === null)
        frame = requestAnimationFrame(() => {
          frame = null;
          if (!disposed) draw();
        });
    },
    dispose() {
      disposed = true;
      if (frame !== null) cancelAnimationFrame(frame);
      frame = null;
    },
  };
}
