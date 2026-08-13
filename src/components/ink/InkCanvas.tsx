import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

import type { InkPage } from '../../types/ink';
import { INK_LIMITS, INK_UNITS_PER_PX } from '../../types/ink';
import { InkTileRenderer } from '../../lib/ink/renderer';
import type { InkRenderTarget, InkTileSurfaceFactory } from '../../lib/ink/renderer';
import { INK_TILE_SIZE } from '../../lib/ink/tiles';
import type { InkViewport } from '../../lib/ink/tiles';

/**
 * The tiled ink surface.
 *
 * Phase 2 is display and navigation only — pan, zoom, and page rendering. The
 * drawing tools land in Phase 3; this component is deliberately the place they
 * will attach, so the tile cache, the coordinate mapping, and the resize
 * handling are already in one place and already correct.
 *
 * Two canvases, not one: tiles are painted into offscreen canvases the renderer
 * caches and the visible canvas only composites them. That is what makes an
 * edit cost a tile repaint instead of a full redraw — Phase 0 measured 2.5 ms
 * against 31 ms on a 10,000-stroke page.
 */

/** Backing store for one cached tile. */
interface CanvasTile {
  canvas: HTMLCanvasElement;
}

function createTileFactory(): InkTileSurfaceFactory<CanvasTile> {
  return {
    create(pixelSize) {
      const canvas = document.createElement('canvas');
      canvas.width = pixelSize;
      canvas.height = pixelSize;
      const context = canvas.getContext('2d');
      if (!context) {
        // jsdom and headless environments have no 2D context. Returning a inert
        // target keeps rendering a no-op rather than throwing during a test.
        return { surface: { canvas }, target: NULL_TARGET };
      }
      return { surface: { canvas }, target: context as unknown as InkRenderTarget };
    },
  };
}

/** Absorbs paint calls where no canvas context exists. */
const NULL_TARGET: InkRenderTarget = {
  save() {},
  restore() {},
  setTransform() {},
  translate() {},
  scale() {},
  clearRect() {},
  fillRect() {},
  beginPath() {},
  moveTo() {},
  lineTo() {},
  closePath() {},
  fill() {},
  stroke() {},
  fillText() {},
  fillStyle: '',
  strokeStyle: '',
  lineWidth: 1,
  globalAlpha: 1,
  font: '',
};

export interface InkCanvasProps {
  page: InkPage | null;
  /** Ink-unit coordinate at the top-left of the surface. */
  originX: number;
  originY: number;
  zoom: number;
  onViewportChange: (next: { originX: number; originY: number; zoom: number }) => void;
  className?: string;
}

/** Wheel zoom step, per notch. Multiplicative so zooming feels even. */
const ZOOM_STEP = 1.15;

export default function InkCanvas({
  page,
  originX,
  originY,
  zoom,
  onViewportChange,
  className,
}: InkCanvasProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const rendererRef = useRef<InkTileRenderer<CanvasTile> | null>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const panRef = useRef<{ pointerId: number; x: number; y: number } | null>(null);

  rendererRef.current ??= new InkTileRenderer(createTileFactory());

  // A new document means every cached tile is stale.
  useEffect(() => {
    rendererRef.current?.invalidateAll();
  }, [page?.id]);

  // The scene changes identity on every edit; the cache keys off content, so
  // the whole cache is dropped rather than guessing which tiles moved. Phase 3
  // replaces this with targeted invalidation from the edit's own bounds, which
  // is what `invalidateMoved` exists for.
  useEffect(() => {
    rendererRef.current?.invalidateAll();
  }, [page?.scene]);

  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const observer = new ResizeObserver((entries) => {
      const rect = entries[0]?.contentRect;
      if (rect) setSize({ width: Math.floor(rect.width), height: Math.floor(rect.height) });
    });
    observer.observe(host);
    setSize({ width: host.clientWidth, height: host.clientHeight });
    return () => observer.disconnect();
  }, []);

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    const renderer = rendererRef.current;
    if (!canvas || !renderer || !page || size.width === 0 || size.height === 0) return;

    const ratio = window.devicePixelRatio || 1;
    if (canvas.width !== Math.floor(size.width * ratio)) {
      canvas.width = Math.floor(size.width * ratio);
    }
    if (canvas.height !== Math.floor(size.height * ratio)) {
      canvas.height = Math.floor(size.height * ratio);
    }

    const context = canvas.getContext('2d');
    if (!context) return;

    const unitsPerPixel = INK_UNITS_PER_PX / zoom;
    const viewport: InkViewport = {
      x: originX,
      y: originY,
      width: size.width * unitsPerPixel,
      height: size.height * unitsPerPixel,
      zoom,
    };

    context.setTransform(1, 0, 0, 1, 0, 0);
    context.clearRect(0, 0, canvas.width, canvas.height);

    const tiles = renderer.renderViewport(page.scene, viewport, page, ratio);
    for (const tile of tiles) {
      // Where the tile's ink-unit origin lands, in device pixels.
      const left = ((tile.bounds.minX - originX) / unitsPerPixel) * ratio;
      const top = ((tile.bounds.minY - originY) / unitsPerPixel) * ratio;
      const span = (INK_TILE_SIZE / unitsPerPixel) * ratio;
      context.drawImage(tile.surface.canvas, left, top, span, span);
    }
  }, [originX, originY, page, size.height, size.width, zoom]);

  useEffect(() => {
    let frame = requestAnimationFrame(() => {
      frame = 0;
      draw();
    });
    return () => {
      if (frame) cancelAnimationFrame(frame);
    };
  }, [draw]);

  const handleWheel = useCallback(
    (event: React.WheelEvent<HTMLDivElement>) => {
      event.preventDefault();
      const host = hostRef.current;
      if (!host) return;
      const rect = host.getBoundingClientRect();
      const pointerX = event.clientX - rect.left;
      const pointerY = event.clientY - rect.top;

      const next = Math.min(
        INK_LIMITS.maxZoom,
        Math.max(INK_LIMITS.minZoom, zoom * (event.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP)),
      );
      if (next === zoom) return;

      // Anchor the zoom under the cursor: the ink unit beneath the pointer must
      // stay beneath it, or zooming walks the drawing off screen.
      const before = INK_UNITS_PER_PX / zoom;
      const after = INK_UNITS_PER_PX / next;
      onViewportChange({
        originX: originX + pointerX * (before - after),
        originY: originY + pointerY * (before - after),
        zoom: next,
      });
    },
    [onViewportChange, originX, originY, zoom],
  );

  const handlePointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      // Middle button, or any button while space-less panning is the only tool
      // this phase has. Phase 3 routes this through the contact arbiter.
      panRef.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY };
      event.currentTarget.setPointerCapture(event.pointerId);
    },
    [],
  );

  const handlePointerMove = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      const pan = panRef.current;
      if (!pan || pan.pointerId !== event.pointerId) return;
      const unitsPerPixel = INK_UNITS_PER_PX / zoom;
      onViewportChange({
        originX: originX - (event.clientX - pan.x) * unitsPerPixel,
        originY: originY - (event.clientY - pan.y) * unitsPerPixel,
        zoom,
      });
      panRef.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY };
    },
    [onViewportChange, originX, originY, zoom],
  );

  const endPan = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (panRef.current?.pointerId !== event.pointerId) return;
    panRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }, []);

  return (
    <div
      ref={hostRef}
      className={className}
      data-testid="ink-canvas-host"
      // `touch-action: none` is required, or the browser scrolls instead of
      // delivering pointermove and a drag silently stops mid-gesture.
      style={{ touchAction: 'none', cursor: panRef.current ? 'grabbing' : 'grab' }}
      onWheel={handleWheel}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={endPan}
      onPointerCancel={endPan}
      onLostPointerCapture={endPan}
    >
      <canvas
        ref={canvasRef}
        style={{ width: '100%', height: '100%', display: 'block' }}
        aria-label={page?.name ? `Drawing page ${page.name}` : 'Drawing page'}
        role="img"
      />
    </div>
  );
}
