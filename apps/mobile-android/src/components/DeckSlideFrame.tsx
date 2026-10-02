/**
 * One slide fitted to the space it is given, with touch: pinch to zoom about
 * the fingers, drag to pan a zoomed slide, double-tap to zoom in or back to
 * fit, and a horizontal swipe at fit to change slides.
 *
 * The slide's SVG is drawn once at the fitted size; zoom and pan are a CSS
 * transform, so a pinch never re-renders the scene. The rules (bounds, pan
 * limits, zoom about a point) are the pure helpers in `lib/deck.ts`.
 */
import { useCallback, useRef } from 'react';
import type { ReactNode, PointerEvent as ReactPointerEvent } from 'react';

import { DeckSlide } from '../../../../src/components/deck/DeckSlide';
import { swipeCommand } from '../../../../src/lib/deck/playback';
import type { ResolvedSlide } from '../../../../src/lib/deck/resolve';
import type { DeckTextMeasurer } from '../../../../src/lib/deck/textLayout';
import type { DeckAssetRef } from '../../../../src/types/deck';
import {
  clampDeckPan,
  DECK_MOBILE_ZOOM,
  type DeckViewport,
  FIT_VIEWPORT,
  fitDeckSlide,
  zoomDeckAbout,
} from '../lib/deck';

import { useElementSize } from './useElementSize';

const TAP_SLOP = 10;
const DOUBLE_TAP_MS = 300;

type Gesture =
  | { kind: 'none' }
  | {
      kind: 'pan';
      startX: number;
      startY: number;
      start: DeckViewport;
      moved: boolean;
      lastX: number;
      lastY: number;
    }
  | {
      kind: 'pinch';
      startDistance: number;
      centerX: number;
      centerY: number;
      start: DeckViewport;
    };

interface DeckSlideFrameProps {
  slide: ResolvedSlide;
  measurer: DeckTextMeasurer;
  resolveAsset: (asset: DeckAssetRef) => string | null;
  /** Zoom and pan; `null` when the frame does not zoom (presenting). */
  viewport: DeckViewport | null;
  onViewportChange?: (viewport: DeckViewport) => void;
  onSwipe?: (direction: 'next' | 'previous') => void;
  /** A single tap, with where it landed across the frame (0 left, 1 right). */
  onTap?: (fractionX: number) => void;
  className?: string;
  children?: ReactNode;
}

export function DeckSlideFrame({
  slide,
  measurer,
  resolveAsset,
  viewport,
  onViewportChange,
  onSwipe,
  onTap,
  className,
  children,
}: DeckSlideFrameProps) {
  const [setFrame, frameSize] = useElementSize<HTMLDivElement>();
  const frameRef = useRef<HTMLDivElement | null>(null);
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const gesture = useRef<Gesture>({ kind: 'none' });
  const lastTap = useRef<{ at: number; x: number; y: number } | null>(null);
  const fit = fitDeckSlide(frameSize.width, frameSize.height, slide.width / slide.height);
  const view = viewport ?? FIT_VIEWPORT;
  const viewRef = useRef(view);
  viewRef.current = view;

  const ref = useCallback(
    (node: HTMLDivElement | null) => {
      frameRef.current = node;
      setFrame(node);
    },
    [setFrame],
  );

  /** A point relative to the frame's centre. */
  const local = (clientX: number, clientY: number) => {
    const rect = frameRef.current?.getBoundingClientRect();
    return {
      x: clientX - (rect?.left ?? 0) - (rect?.width ?? 0) / 2,
      y: clientY - (rect?.top ?? 0) - (rect?.height ?? 0) / 2,
    };
  };

  const startPan = (x: number, y: number) => {
    gesture.current = {
      kind: 'pan',
      startX: x,
      startY: y,
      start: viewRef.current,
      moved: false,
      lastX: x,
      lastY: y,
    };
  };

  const startPinch = () => {
    const [a, b] = [...pointers.current.values()];
    const center = local((a.x + b.x) / 2, (a.y + b.y) / 2);
    gesture.current = {
      kind: 'pinch',
      startDistance: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)),
      centerX: center.x,
      centerY: center.y,
      start: viewRef.current,
    };
  };

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    try {
      event.currentTarget.setPointerCapture?.(event.pointerId);
    } catch {
      // A pointer the platform already released cannot be captured; the
      // gesture still works from the events this element receives.
    }
    pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (pointers.current.size === 1) startPan(event.clientX, event.clientY);
    else if (pointers.current.size === 2 && viewport) startPinch();
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!pointers.current.has(event.pointerId)) return;
    pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    const current = gesture.current;
    if (current.kind === 'pinch' && pointers.current.size >= 2 && viewport) {
      const [a, b] = [...pointers.current.values()];
      const distance = Math.hypot(a.x - b.x, a.y - b.y);
      const center = local((a.x + b.x) / 2, (a.y + b.y) / 2);
      const zoomed = zoomDeckAbout(
        current.start,
        (current.start.zoom * distance) / current.startDistance,
        current.centerX,
        current.centerY,
        fit.width,
        fit.height,
      );
      onViewportChange?.(
        clampDeckPan(
          {
            ...zoomed,
            panX: zoomed.panX + center.x - current.centerX,
            panY: zoomed.panY + center.y - current.centerY,
          },
          fit.width,
          fit.height,
        ),
      );
    } else if (current.kind === 'pan') {
      const dx = event.clientX - current.startX;
      const dy = event.clientY - current.startY;
      current.lastX = event.clientX;
      current.lastY = event.clientY;
      if (Math.hypot(dx, dy) > TAP_SLOP) current.moved = true;
      if (viewport && current.start.zoom > DECK_MOBILE_ZOOM.min) {
        onViewportChange?.(
          clampDeckPan(
            { ...current.start, panX: current.start.panX + dx, panY: current.start.panY + dy },
            fit.width,
            fit.height,
          ),
        );
      }
    }
  };

  const onPointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!pointers.current.delete(event.pointerId)) return;
    const current = gesture.current;
    if (current.kind === 'pinch') {
      // One finger left on the glass carries on as a pan from here.
      const [rest] = [...pointers.current.values()];
      if (rest) {
        startPan(rest.x, rest.y);
        if (gesture.current.kind === 'pan') gesture.current.moved = true;
      } else gesture.current = { kind: 'none' };
      return;
    }
    gesture.current = { kind: 'none' };
    if (current.kind !== 'pan' || event.type === 'pointercancel') return;
    const dx = event.clientX - current.startX;
    const dy = event.clientY - current.startY;
    if (current.moved) {
      if (current.start.zoom <= DECK_MOBILE_ZOOM.min) {
        const swipe = swipeCommand(dx, dy);
        if (swipe) onSwipe?.(swipe.type);
      }
      return;
    }
    const rect = frameRef.current?.getBoundingClientRect();
    const fraction =
      rect && rect.width > 0
        ? Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width))
        : 0.5;
    if (!viewport) {
      onTap?.(fraction);
      return;
    }
    const now = event.timeStamp || performance.now();
    const previous = lastTap.current;
    if (
      previous &&
      now - previous.at < DOUBLE_TAP_MS &&
      Math.hypot(event.clientX - previous.x, event.clientY - previous.y) < TAP_SLOP * 3
    ) {
      lastTap.current = null;
      const point = local(event.clientX, event.clientY);
      onViewportChange?.(
        viewRef.current.zoom > DECK_MOBILE_ZOOM.min
          ? FIT_VIEWPORT
          : zoomDeckAbout(
              viewRef.current,
              DECK_MOBILE_ZOOM.doubleTap,
              point.x,
              point.y,
              fit.width,
              fit.height,
            ),
      );
      return;
    }
    lastTap.current = { at: now, x: event.clientX, y: event.clientY };
    onTap?.(fraction);
  };

  return (
    <div
      ref={ref}
      className={`deck-frame${className ? ` ${className}` : ''}`}
      data-testid="deck-frame"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
    >
      {fit.width > 0 && (
        <div
          className="deck-frame-slide"
          style={{
            width: fit.width,
            height: fit.height,
            transform: `translate(${view.panX}px, ${view.panY}px) scale(${view.zoom})`,
          }}
        >
          <DeckSlide
            slide={slide}
            width={fit.width}
            measurer={measurer}
            resolveAsset={resolveAsset}
            label={`Slide ${slide.number}`}
          />
        </div>
      )}
      {children}
    </div>
  );
}
