import { useLayoutEffect, useState } from 'react';

/** The size of an element, following rotation and window resizes. */
export function useElementSize<T extends HTMLElement>(): [
  (node: T | null) => void,
  { width: number; height: number },
] {
  const [node, setNode] = useState<T | null>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  useLayoutEffect(() => {
    if (!node) return;
    const measure = () =>
      setSize((current) => {
        const width = Math.floor(node.clientWidth);
        const height = Math.floor(node.clientHeight);
        return current.width === width && current.height === height ? current : { width, height };
      });
    measure();
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', measure);
      return () => window.removeEventListener('resize', measure);
    }
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [node]);
  return [setNode, size];
}
