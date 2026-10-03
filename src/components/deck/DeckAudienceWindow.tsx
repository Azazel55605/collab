import { useEffect, useMemo, useState } from 'react';

import DOMPurify from 'dompurify';

// This window does not load the app shell, so it brings the styles itself.
import '../../App.css';
import { AUDIENCE_QUERY, audienceEvents } from '../../lib/deck/presentWindow';
import type {
  AudienceKey,
  AudienceOverlayFrame,
  AudienceSlideFrame,
} from '../../lib/deck/presentWindow';

import { DeckPlaybackSurface } from './DeckPlaybackSurface';

/**
 * The slide show on a second display. It draws what the presenter sends and
 * forwards keys and clicks back; it has no document of its own.
 */
export function DeckAudienceWindow() {
  const query = new URLSearchParams(window.location.search);
  const session = query.get(AUDIENCE_QUERY) ?? 'unknown';
  const events = useMemo(() => audienceEvents(session), [session]);
  const [slide, setSlide] = useState<AudienceSlideFrame | null>(null);
  const [overlay, setOverlay] = useState<AudienceOverlayFrame | null>(null);

  useEffect(() => {
    let disposed = false;
    const unlisteners: Array<() => void> = [];
    void import('@tauri-apps/api/event').then(async ({ emit, listen }) => {
      const subscriptions = await Promise.all([
        listen<AudienceSlideFrame>(events.slide, (event) => setSlide(event.payload)),
        listen<AudienceOverlayFrame>(events.overlay, (event) => setOverlay(event.payload)),
      ]);
      if (disposed) {
        for (const unlisten of subscriptions) unlisten();
        return;
      }
      unlisteners.push(...subscriptions);
      void emit(events.ready);
    });

    const onKey = (event: KeyboardEvent) => {
      event.preventDefault();
      const key: AudienceKey = {
        key: event.key,
        ctrl: event.ctrlKey,
        meta: event.metaKey,
        alt: event.altKey,
        shift: event.shiftKey,
      };
      void import('@tauri-apps/api/event').then(({ emit }) => emit(events.key, key));
    };
    window.addEventListener('keydown', onKey);
    document.documentElement.style.background = '#000';
    document.body.style.background = '#000';
    document.body.style.cursor = 'none';
    return () => {
      disposed = true;
      for (const unlisten of unlisteners) unlisten();
      window.removeEventListener('keydown', onKey);
    };
  }, [events]);

  const markup = useMemo(
    () => (slide ? DOMPurify.sanitize(slide.svg, { USE_PROFILES: { svg: true } }) : ''),
    [slide],
  );

  const pointer = (action: 'next' | 'previous') =>
    void import('@tauri-apps/api/event').then(({ emit }) => emit(events.pointer, action));

  return (
    <div
      className="fixed inset-0 bg-black"
      onClick={() => pointer('next')}
      onContextMenu={(event) => {
        event.preventDefault();
        pointer('previous');
      }}
    >
      {slide && (
        <DeckPlaybackSurface
          markup={markup}
          aspect={slide.aspect}
          blank={slide.blank}
          ended={slide.ended}
          ink={overlay?.ink ?? ''}
          inkViewBox={overlay?.viewBox ?? [1, 1]}
          laser={overlay?.laser ?? null}
          slideKey={slide.slideKey}
          animationKey={slide.animationKey}
          animationCss={slide.animationCss}
          transition={slide.transition}
        />
      )}
    </div>
  );
}

export default DeckAudienceWindow;
