import { useEffect, useMemo } from 'react';

import { createPortal } from 'react-dom';

import DOMPurify from 'dompurify';

import type { DeckOutputPage } from '../../lib/deck/output';

interface DeckPrintHostProps {
  pages: DeckOutputPage[];
  /** Called once the print dialog has closed. */
  onDone: () => void;
}

const PRINT_CLASS = 'deck-printing';

async function fontsReady() {
  const fonts = document.fonts;
  if (!fonts) return;
  try {
    await Promise.race([fonts.ready, new Promise((resolve) => window.setTimeout(resolve, 1_500))]);
  } catch {
    // Font readiness is best-effort.
  }
}

/**
 * Prints output pages through the system print dialog.
 *
 * The pages are inline vector SVG (sanitized, as `DeckSlide`), one per printed
 * sheet at its exact size, so print is sharp at any resolution. The host is
 * invisible on screen; while it is mounted, print media shows only it.
 */
export function DeckPrintHost({ pages, onDone }: DeckPrintHostProps) {
  const size = pages[0] ? { width: pages[0].width, height: pages[0].height } : null;
  const markup = useMemo(
    () =>
      pages.map((page) =>
        DOMPurify.sanitize(page.svg(page.width, page.height), { USE_PROFILES: { svg: true } }),
      ),
    [pages],
  );

  useEffect(() => {
    let finished = false;
    const done = () => {
      if (finished) return;
      finished = true;
      document.body.classList.remove(PRINT_CLASS);
      onDone();
    };
    document.body.classList.add(PRINT_CLASS);
    window.addEventListener('afterprint', done, { once: true });
    let cancelled = false;
    void fontsReady().then(() => {
      if (cancelled) return;
      window.requestAnimationFrame(() => {
        if (cancelled) return;
        window.print();
      });
    });
    return () => {
      cancelled = true;
      window.removeEventListener('afterprint', done);
      document.body.classList.remove(PRINT_CLASS);
    };
  }, [onDone]);

  if (!size) return null;
  return createPortal(
    <div className="deck-print-host" aria-hidden="true">
      <style>{`@page { size: ${size.width}pt ${size.height}pt; margin: 0; }`}</style>
      {markup.map((html, index) => (
        <div
          key={index}
          className="deck-print-page"
          style={{ width: `${pages[index].width}pt`, height: `${pages[index].height}pt` }}
          // Sanitized above.
          dangerouslySetInnerHTML={{ __html: html }}
        />
      ))}
    </div>,
    document.body,
  );
}
