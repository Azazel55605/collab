import { useCallback, useEffect, useRef, useState } from 'react';

const IDLE_MS = 2200;

export function useFullscreenMediaDock(fullscreen: boolean, hasError: boolean) {
  const [visible, setVisible] = useState(true);
  const dock = useRef<HTMLDivElement>(null);
  const menuOpen = useRef(false);
  const timeout = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const reveal = useCallback(() => {
    setVisible(true);
    clearTimeout(timeout.current);
    if (!fullscreen || hasError) return;
    timeout.current = setTimeout(() => {
      if (
        !menuOpen.current &&
        !dock.current?.querySelector(':focus-visible') &&
        !dock.current?.matches(':hover')
      )
        setVisible(false);
    }, IDLE_MS);
  }, [fullscreen, hasError]);

  useEffect(() => {
    reveal();
    return () => clearTimeout(timeout.current);
  }, [reveal]);

  return {
    dock,
    show: !fullscreen || hasError || visible,
    reveal,
    onMenuOpenChange(open: boolean) {
      menuOpen.current = open;
      reveal();
    },
  };
}
