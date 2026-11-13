import { useCallback, useEffect, useRef, useState } from 'react';

const IDLE_MS = 2200;

/**
 * Shows media controls on activity and hides them after a short idle period.
 * Hiding only happens while `autoHide` is set (video playing) and no error is
 * shown; an open menu, keyboard focus or a hovered dock keeps them visible.
 */
export function useFullscreenMediaDock(autoHide: boolean, hasError: boolean) {
  const [visible, setVisible] = useState(true);
  const dock = useRef<HTMLDivElement>(null);
  const menuOpen = useRef(false);
  const timeout = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const reveal = useCallback(() => {
    setVisible(true);
    clearTimeout(timeout.current);
    if (!autoHide || hasError) return;
    timeout.current = setTimeout(() => {
      if (
        !menuOpen.current &&
        !dock.current?.querySelector(':focus-visible') &&
        !dock.current?.matches(':hover')
      )
        setVisible(false);
    }, IDLE_MS);
  }, [autoHide, hasError]);

  useEffect(() => {
    reveal();
    return () => clearTimeout(timeout.current);
  }, [reveal]);

  return {
    dock,
    show: !autoHide || hasError || visible,
    reveal,
    onMenuOpenChange(open: boolean) {
      menuOpen.current = open;
      reveal();
    },
  };
}
