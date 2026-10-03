import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';

import DOMPurify from 'dompurify';

import type { DeckTransition } from '../../types/deck';

interface DeckPlaybackSurfaceProps {
  /** Sanitized slide SVG markup. */
  markup: string;
  /** Slide width / height. */
  aspect: number;
  blank: 'black' | 'white' | null;
  ended: boolean;
  /** Ink as SVG elements in slide units, and that coordinate space. */
  ink: string;
  inkViewBox: [number, number];
  /** Laser pointer at 0..1 of the slide, or null. */
  laser: { x: number; y: number } | null;
  /** Changes when the slide changes, to run the (motion-permitting) fade. */
  slideKey?: string;
  /** Changes when a build step begins, without replaying the slide transition. */
  animationKey?: string | number;
  /** Scoped rules for the current animation build. */
  animationCss?: string;
  transition?: DeckTransition;
  /** Layers above the slide that take pointer input (ink, laser, links). */
  children?: (box: { width: number; height: number }) => ReactNode;
  endMessage?: string;
}

function motionAllowed(): boolean {
  if (typeof document === 'undefined') return false;
  const motion = document.documentElement.dataset.motion;
  if (motion) return motion === 'on';
  return !(
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}

/**
 * One slide filling its container at its aspect ratio, with the playback
 * layers over it: ink, laser pointer, black or white screen, and the end
 * screen. Used by the slide show, the presenter view, and the audience window,
 * so all three draw the same thing.
 */
export function DeckPlaybackSurface({
  markup,
  aspect,
  blank,
  ended,
  ink,
  inkViewBox,
  laser,
  slideKey,
  animationKey,
  animationCss,
  transition,
  children,
  endMessage = 'End of slide show. Click or press Esc to exit.',
}: DeckPlaybackSurfaceProps) {
  const container = useRef<HTMLDivElement | null>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });

  useLayoutEffect(() => {
    const element = container.current;
    if (!element) return;
    const measure = () => setSize({ width: element.clientWidth, height: element.clientHeight });
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const box = useMemo(() => {
    const width = Math.min(size.width, size.height * aspect);
    return { width, height: aspect > 0 ? width / aspect : 0 };
  }, [aspect, size]);

  const inkMarkup = useMemo(
    () =>
      ink
        ? DOMPurify.sanitize(
            `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${inkViewBox[0]} ${inkViewBox[1]}" preserveAspectRatio="none" width="100%" height="100%">${ink}</svg>`,
            { USE_PROFILES: { svg: true } },
          )
        : '',
    [ink, inkViewBox],
  );
  const animate = motionAllowed();
  const transitionKind = transition?.kind ?? 'none';
  const transitionClass =
    animate && transitionKind !== 'none' ? ` deck-playback-${transitionKind}` : '';

  return (
    <div ref={container} className="relative flex size-full items-center justify-center">
      <div className="relative overflow-hidden" style={{ width: box.width, height: box.height }}>
        <div
          key={animate ? slideKey : undefined}
          className={`deck-playback-slide absolute inset-0${transitionClass}`}
          style={
            animate && transition?.durationMs
              ? ({ '--deck-transition-duration': `${transition.durationMs}ms` } as CSSProperties)
              : undefined
          }
        >
          {animationCss ? <style>{animationCss}</style> : null}
          <div
            key={animationKey}
            className="deck-playback-animation-scope size-full"
            // Sanitized by the caller (DOMPurify, SVG profile).
            dangerouslySetInnerHTML={{ __html: markup }}
          />
        </div>
        {inkMarkup && (
          <div
            className="pointer-events-none absolute inset-0"
            // Sanitized above.
            dangerouslySetInnerHTML={{ __html: inkMarkup }}
          />
        )}
        {laser && (
          <div
            className="pointer-events-none absolute size-3.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-red-500 shadow-[0_0_10px_4px_rgba(239,68,68,0.65)]"
            style={{ left: `${laser.x * 100}%`, top: `${laser.y * 100}%` }}
            data-testid="deck-laser"
          />
        )}
        {children?.(box)}
      </div>
      {blank && (
        <div
          className="absolute inset-0"
          style={{ background: blank === 'black' ? '#000' : '#fff' }}
          aria-label={blank === 'black' ? 'Black screen' : 'White screen'}
          role="img"
        />
      )}
      {ended && !blank && (
        <div className="absolute inset-0 flex items-start justify-center bg-black pt-8 text-sm text-white/70">
          {endMessage}
        </div>
      )}
    </div>
  );
}
