/**
 * Touch and pen drawing surface for the mobile companion app (Phase 4).
 *
 * Rendering, capture, hit testing, and the tool model all come from the shared
 * `src/lib/ink/` modules — this component only decides how a phone renders and
 * touches that model:
 *
 * - **One finger pans, two fingers pinch, the pen draws.** That is the default
 *   because a finger is how you move a page and a pen is how you mark it.
 *   Finger drawing is an explicit setting for devices with no pen.
 * - **Palm rejection** runs through the shared `InkContactArbiter`, so the
 *   policy is identical to desktop and is tested once. It is best-effort by
 *   design: where Android or the digitizer rejects a palm the contact never
 *   arrives, and that remains authoritative.
 * - **Pinch zoom is anchored** between the two fingers, so the page does not
 *   slide out from under the gesture.
 * - Committed ink is painted through the shared tile cache; the stroke under
 *   the pen lives on a second canvas that is cleared each frame.
 */
import {
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

import { INK_LIGHT_PALETTE, resolveInkColor } from '../../../../src/lib/ink/colors';
import type { InkColorPalette } from '../../../../src/lib/ink/colors';
import {
  InkContactArbiter,
  isBarrelButton,
  isEraserEnd,
  readingsFromEvent,
  toInkUnits,
} from '../../../../src/lib/ink/pointer';
import type { InkInputSettings, InkPointerEventLike } from '../../../../src/lib/ink/pointer';
import { InkTileRenderer } from '../../../../src/lib/ink/renderer';
import type { InkRenderTarget, InkTileSurfaceFactory } from '../../../../src/lib/ink/renderer';
import { captureStroke } from '../../../../src/lib/ink/samples';
import type { InkPointerReading } from '../../../../src/lib/ink/samples';
import { outlineStroke } from '../../../../src/lib/ink/stroke';
import { INK_TILE_SIZE } from '../../../../src/lib/ink/tiles';
import type { InkViewport } from '../../../../src/lib/ink/tiles';
import { INK_DEFAULT_PEN_BUTTONS, penButtonTool } from '../../../../src/lib/ink/tools';
import type { InkToolState } from '../../../../src/lib/ink/tools';
import type { InkInteraction, LivePeer } from '../../../../src/lib/liveAwareness';
import type { InkPage, InkSample } from '../../../../src/types/ink';
import { INK_UNITS_PER_PX } from '../../../../src/types/ink';
import { clampInkScale } from '../lib/ink';

interface CanvasTile {
  canvas: HTMLCanvasElement;
}

/** Absorbs paint calls where no 2D context exists (jsdom). */
const NULL_TARGET: InkRenderTarget = {
  save() {},
  restore() {},
  setTransform() {},
  translate() {},
  scale() {},
  rotate() {},
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

function createTileFactory(): InkTileSurfaceFactory<CanvasTile> {
  return {
    create(pixelSize) {
      const canvas = document.createElement('canvas');
      canvas.width = pixelSize;
      canvas.height = pixelSize;
      const context = canvas.getContext('2d');
      return {
        surface: { canvas },
        target: (context as unknown as InkRenderTarget) ?? NULL_TARGET,
      };
    },
  };
}

/**
 * Cached tile budget on a phone.
 *
 * Well under the desktop default: Android reclaims aggressively, and a drawing
 * that survives a memory warning by dropping *derived* tiles loses nothing —
 * they regenerate from the vector data.
 */
const MOBILE_TILE_BUDGET_BYTES = 24 * 1024 * 1024;

export interface InkTouchCanvasProps {
  page: InkPage | null;
  originX: number;
  originY: number;
  zoom: number;
  tool: InkToolState;
  inputSettings: InkInputSettings;
  readOnly: boolean;
  colorPalette?: InkColorPalette;
  onViewportChange: (next: { originX: number; originY: number; zoom: number }) => void;
  onCommitStroke: (samples: InkSample[]) => void;
  onErase: (path: Array<{ x: number; y: number }>, radius: number) => void;
  remotePeers?: LivePeer[];
  onInkAwareness?: (interaction: Pick<InkInteraction, 'cursor' | 'preview'>) => void;
}

type Gesture =
  | { kind: 'none' }
  | { kind: 'draw'; pointerId: number; readings: InkPointerReading[]; startedAt: number }
  | { kind: 'erase'; pointerId: number; path: Array<{ x: number; y: number }> }
  | { kind: 'pan'; pointerId: number; clientX: number; clientY: number }
  | {
      kind: 'pinch';
      pointers: [number, number];
      distance: number;
      /** Midpoint in client coordinates, so the zoom stays anchored. */
      centreX: number;
      centreY: number;
    };

export function InkTouchCanvas({
  page,
  originX,
  originY,
  zoom,
  tool,
  inputSettings,
  readOnly,
  colorPalette = INK_LIGHT_PALETTE,
  onViewportChange,
  onCommitStroke,
  onErase,
  remotePeers = [],
  onInkAwareness,
}: InkTouchCanvasProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const tileCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const liveCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const rendererRef = useRef<InkTileRenderer<CanvasTile> | null>(null);
  const arbiterRef = useRef(new InkContactArbiter(inputSettings));
  const gestureRef = useRef<Gesture>({ kind: 'none' });
  const activePointers = useRef(new Map<number, { x: number; y: number }>());
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [liveVersion, setLiveVersion] = useState(0);

  rendererRef.current ??= new InkTileRenderer(createTileFactory(), {
    budgetBytes: MOBILE_TILE_BUDGET_BYTES,
  });

  useEffect(() => {
    arbiterRef.current.updateSettings(inputSettings);
  }, [inputSettings]);

  useEffect(() => {
    rendererRef.current?.setRenderOptions({ colors: colorPalette });
  }, [colorPalette]);

  useEffect(() => {
    rendererRef.current?.invalidateAll();
  }, [page?.scene, page?.id]);

  // Android reclaims memory by trimming the process rather than telling the
  // page. Dropping the derived tile cache when the app is backgrounded gives
  // that memory back without losing a single stroke.
  useEffect(() => {
    const onHidden = () => {
      if (document.visibilityState === 'hidden') {
        rendererRef.current?.invalidateAll();
        arbiterRef.current.reset();
        gestureRef.current = { kind: 'none' };
        activePointers.current.clear();
      }
    };
    document.addEventListener('visibilitychange', onHidden);
    return () => document.removeEventListener('visibilitychange', onHidden);
  }, []);

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

  const unitsPerPixel = INK_UNITS_PER_PX / zoom;

  const toDocument = useCallback(
    (clientX: number, clientY: number) => {
      const rect = hostRef.current?.getBoundingClientRect();
      return toInkUnits(
        { offsetX: clientX - (rect?.left ?? 0), offsetY: clientY - (rect?.top ?? 0) },
        { originX, originY, zoom },
      );
    },
    [originX, originY, zoom],
  );

  const toScreen = useCallback(
    (x: number, y: number) => ({
      x: (x - originX) / unitsPerPixel,
      y: (y - originY) / unitsPerPixel,
    }),
    [originX, originY, unitsPerPixel],
  );

  const drawTiles = useCallback(() => {
    const canvas = tileCanvasRef.current;
    const renderer = rendererRef.current;
    if (!canvas || !renderer || !page || size.width === 0) return;

    const ratio = window.devicePixelRatio || 1;
    canvas.width = Math.floor(size.width * ratio);
    canvas.height = Math.floor(size.height * ratio);
    const context = canvas.getContext('2d');
    if (!context) return;

    const viewport: InkViewport = {
      x: originX,
      y: originY,
      width: size.width * unitsPerPixel,
      height: size.height * unitsPerPixel,
      zoom,
    };
    context.setTransform(1, 0, 0, 1, 0, 0);
    context.clearRect(0, 0, canvas.width, canvas.height);

    for (const tile of renderer.renderViewport(page.scene, viewport, page, ratio)) {
      const left = ((tile.bounds.minX - originX) / unitsPerPixel) * ratio;
      const top = ((tile.bounds.minY - originY) / unitsPerPixel) * ratio;
      const span = (INK_TILE_SIZE / unitsPerPixel) * ratio;
      context.drawImage(tile.surface.canvas, left, top, span, span);
    }
  }, [originX, originY, page, size.height, size.width, unitsPerPixel, zoom]);

  useEffect(() => {
    const frame = requestAnimationFrame(drawTiles);
    return () => cancelAnimationFrame(frame);
  }, [drawTiles]);

  const drawLive = useCallback(() => {
    const canvas = liveCanvasRef.current;
    if (!canvas || size.width === 0) return;
    const ratio = window.devicePixelRatio || 1;
    if (canvas.width !== Math.floor(size.width * ratio)) {
      canvas.width = Math.floor(size.width * ratio);
      canvas.height = Math.floor(size.height * ratio);
    }
    const context = canvas.getContext('2d');
    if (!context) return;

    context.setTransform(1, 0, 0, 1, 0, 0);
    context.clearRect(0, 0, canvas.width, canvas.height);
    context.setTransform(ratio, 0, 0, ratio, 0, 0);

    for (const peer of remotePeers) {
      if (!peer.user) continue;
      const preview = peer.ink?.preview;
      if (!preview || preview.pageId !== page?.id || preview.samples.length === 0) continue;
      const outline = outlineStroke(preview.samples, preview.brush);
      if (outline.length < 3) continue;
      context.beginPath();
      const first = toScreen(outline[0].x, outline[0].y);
      context.moveTo(first.x, first.y);
      for (let index = 1; index < outline.length; index += 1) {
        const point = toScreen(outline[index].x, outline[index].y);
        context.lineTo(point.x, point.y);
      }
      context.closePath();
      context.fillStyle = peer.user.color;
      context.globalAlpha = preview.brush.opacity * 0.8;
      context.fill();
    }

    for (const peer of remotePeers) {
      if (!peer.user) continue;
      const cursor = peer.ink?.cursor;
      if (!cursor || peer.ink?.activePageId !== page?.id) continue;
      const point = toScreen(cursor.x, cursor.y);
      context.beginPath();
      context.arc(point.x, point.y, 5, 0, Math.PI * 2);
      context.fillStyle = peer.user.color;
      context.globalAlpha = 1;
      context.fill();
      context.font = '12px sans-serif';
      context.fillText(peer.user.name, point.x + 9, point.y - 7);
    }

    const gesture = gestureRef.current;
    if (gesture.kind !== 'draw' || gesture.readings.length === 0) {
      context.globalAlpha = 1;
      return;
    }

    const samples: InkSample[] = gesture.readings.map((reading) => ({
      x: reading.x,
      y: reading.y,
      ...(reading.pressure === undefined ? {} : { pressure: Math.round(reading.pressure * 4095) }),
    }));
    const outline = outlineStroke(samples, tool.brush);
    if (outline.length < 3) return;

    context.beginPath();
    const first = toScreen(outline[0].x, outline[0].y);
    context.moveTo(first.x, first.y);
    for (let index = 1; index < outline.length; index += 1) {
      const point = toScreen(outline[index].x, outline[index].y);
      context.lineTo(point.x, point.y);
    }
    context.closePath();
    context.fillStyle = resolveInkColor(tool.brush.color, colorPalette);
    context.globalAlpha = tool.brush.opacity;
    context.fill();
    context.globalAlpha = 1;
  }, [colorPalette, page?.id, remotePeers, size.height, size.width, toScreen, tool.brush]);

  useEffect(() => {
    const frame = requestAnimationFrame(drawLive);
    return () => cancelAnimationFrame(frame);
  }, [drawLive, liveVersion]);

  const bump = () => setLiveVersion((version) => version + 1);

  const asPointerEvent = (event: ReactPointerEvent<HTMLDivElement>): InkPointerEventLike => {
    const rect = hostRef.current?.getBoundingClientRect();
    return {
      pointerId: event.pointerId,
      pointerType: event.pointerType,
      isPrimary: event.isPrimary,
      buttons: event.buttons,
      button: event.button,
      pressure: event.pressure,
      tiltX: event.tiltX,
      tiltY: event.tiltY,
      twist: (event as unknown as { twist?: number }).twist,
      width: (event as unknown as { width?: number }).width,
      height: (event as unknown as { height?: number }).height,
      offsetX: event.clientX - (rect?.left ?? 0),
      offsetY: event.clientY - (rect?.top ?? 0),
      timeStamp: event.timeStamp,
    };
  };

  const onPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const native = asPointerEvent(event);
      const role = arbiterRef.current.down(native);
      activePointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });

      if (role === 'reject') return;
      event.currentTarget.setPointerCapture?.(event.pointerId);

      // A second finger turns a pan into a pinch. A pen contact is never part
      // of a pinch — a hand resting while writing must not zoom the page.
      if (event.pointerType === 'touch' && activePointers.current.size === 2) {
        const entries = [...activePointers.current.entries()];
        const [a, b] = entries;
        gestureRef.current = {
          kind: 'pinch',
          pointers: [a[0], b[0]],
          distance: Math.hypot(a[1].x - b[1].x, a[1].y - b[1].y),
          centreX: (a[1].x + b[1].x) / 2,
          centreY: (a[1].y + b[1].y) / 2,
        };
        bump();
        return;
      }

      let effective = tool.tool;
      if (native.pointerType === 'pen') {
        if (isEraserEnd(native)) {
          effective = penButtonTool(INK_DEFAULT_PEN_BUTTONS.eraserEnd) ?? effective;
        } else if (isBarrelButton(native)) {
          effective = penButtonTool(INK_DEFAULT_PEN_BUTTONS.barrel) ?? effective;
        }
      }
      if (role === 'erase') effective = 'eraser';
      if (role === 'navigate') effective = 'pan';
      if (readOnly && effective !== 'pan') effective = 'pan';

      const point = toDocument(event.clientX, event.clientY);
      onInkAwareness?.({ cursor: point, preview: null });
      if (effective === 'eraser') {
        gestureRef.current = { kind: 'erase', pointerId: event.pointerId, path: [point] };
      } else if (effective === 'pen') {
        gestureRef.current = {
          kind: 'draw',
          pointerId: event.pointerId,
          startedAt: event.timeStamp,
          readings: readingsFromEvent(native, { originX, originY, zoom }, event.timeStamp),
        };
      } else {
        gestureRef.current = {
          kind: 'pan',
          pointerId: event.pointerId,
          clientX: event.clientX,
          clientY: event.clientY,
        };
      }
      bump();
    },
    [onInkAwareness, originX, originY, readOnly, toDocument, tool.tool, zoom],
  );

  const onPointerMove = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (activePointers.current.has(event.pointerId)) {
        activePointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
      }
      const gesture = gestureRef.current;
      if (gesture.kind === 'none') return;

      if (gesture.kind === 'pinch') {
        const a = activePointers.current.get(gesture.pointers[0]);
        const b = activePointers.current.get(gesture.pointers[1]);
        if (!a || !b) return;

        const distance = Math.hypot(a.x - b.x, a.y - b.y);
        if (distance <= 0 || gesture.distance <= 0) return;
        const next = clampInkScale(zoom * (distance / gesture.distance));

        const rect = hostRef.current?.getBoundingClientRect();
        const centreX = (a.x + b.x) / 2 - (rect?.left ?? 0);
        const centreY = (a.y + b.y) / 2 - (rect?.top ?? 0);
        const previousCentreX = gesture.centreX - (rect?.left ?? 0);
        const previousCentreY = gesture.centreY - (rect?.top ?? 0);

        // Anchor the zoom under the fingers *and* follow their midpoint, so a
        // pinch that also drags moves the page with it.
        const after = INK_UNITS_PER_PX / next;
        onViewportChange({
          originX: originX + previousCentreX * unitsPerPixel - centreX * after,
          originY: originY + previousCentreY * unitsPerPixel - centreY * after,
          zoom: next,
        });

        gesture.distance = distance;
        gesture.centreX = (a.x + b.x) / 2;
        gesture.centreY = (a.y + b.y) / 2;
        return;
      }

      const native = asPointerEvent(event);
      if (arbiterRef.current.move(native) === 'reject') return;
      if (gesture.pointerId !== event.pointerId) return;

      if (gesture.kind === 'pan') {
        onViewportChange({
          originX: originX - (event.clientX - gesture.clientX) * unitsPerPixel,
          originY: originY - (event.clientY - gesture.clientY) * unitsPerPixel,
          zoom,
        });
        gesture.clientX = event.clientX;
        gesture.clientY = event.clientY;
        return;
      }
      if (gesture.kind === 'draw') {
        const coalesced = (event.nativeEvent as PointerEvent).getCoalescedEvents?.() ?? [];
        const rect = hostRef.current?.getBoundingClientRect();
        const entries = (
          coalesced.length > 0 ? coalesced : [event.nativeEvent as PointerEvent]
        ).map((entry) => ({
          pointerId: entry.pointerId,
          pointerType: entry.pointerType,
          isPrimary: entry.isPrimary,
          buttons: entry.buttons,
          pressure: entry.pressure,
          tiltX: entry.tiltX,
          tiltY: entry.tiltY,
          offsetX: entry.clientX - (rect?.left ?? 0),
          offsetY: entry.clientY - (rect?.top ?? 0),
          timeStamp: entry.timeStamp,
        }));
        for (const entry of entries) {
          gesture.readings.push(
            ...readingsFromEvent(entry, { originX, originY, zoom }, gesture.startedAt),
          );
        }
        const samples: InkSample[] = gesture.readings.slice(-128).map((reading) => ({
          x: reading.x,
          y: reading.y,
          ...(reading.pressure === undefined
            ? {}
            : { pressure: Math.round(reading.pressure * 4095) }),
        }));
        onInkAwareness?.({
          cursor: toDocument(event.clientX, event.clientY),
          preview: page ? { pageId: page.id, brush: tool.brush, samples } : null,
        });
        bump();
        return;
      }
      if (gesture.kind === 'erase') {
        gesture.path.push(toDocument(event.clientX, event.clientY));
        bump();
      }
    },
    [
      onInkAwareness,
      onViewportChange,
      originX,
      originY,
      page,
      toDocument,
      tool.brush,
      unitsPerPixel,
      zoom,
    ],
  );

  const endGesture = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>, cancelled: boolean) => {
      activePointers.current.delete(event.pointerId);
      arbiterRef.current.up(asPointerEvent(event));

      const gesture = gestureRef.current;
      if (gesture.kind === 'none') return;
      if (gesture.kind === 'pinch') {
        if (gesture.pointers.includes(event.pointerId)) gestureRef.current = { kind: 'none' };
        return;
      }
      if (gesture.pointerId !== event.pointerId) return;
      gestureRef.current = { kind: 'none' };
      onInkAwareness?.({ cursor: toDocument(event.clientX, event.clientY), preview: null });

      if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }

      // A cancelled gesture commits nothing: the platform took the pointer
      // away, which happens constantly on Android, and the user did not finish.
      if (!cancelled) {
        if (gesture.kind === 'draw') {
          const samples = captureStroke(gesture.readings, {
            streamline: tool.brush.streamline,
          });
          if (samples.length > 0) onCommitStroke(samples);
        } else if (gesture.kind === 'erase' && gesture.path.length > 0) {
          onErase(gesture.path, tool.eraserRadius);
        }
      }
      bump();
    },
    [onCommitStroke, onErase, onInkAwareness, toDocument, tool.brush.streamline, tool.eraserRadius],
  );

  const cursorHint = useMemo(() => {
    if (readOnly) return 'ink-canvas-readonly';
    return `ink-canvas-${tool.tool}`;
  }, [readOnly, tool.tool]);

  return (
    <div
      ref={hostRef}
      className={`ink-canvas ${cursorHint}`}
      data-testid="ink-touch-canvas"
      data-tool={tool.tool}
      // Required, or Android scrolls the page instead of delivering
      // pointermove, and a stroke silently stops mid-gesture.
      style={{ touchAction: 'none' }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={(event) => endGesture(event, false)}
      onPointerCancel={(event) => endGesture(event, true)}
      onLostPointerCapture={(event) => endGesture(event, true)}
    >
      <canvas
        ref={tileCanvasRef}
        className="ink-canvas-layer"
        role="img"
        aria-label={page?.name ? `Drawing page ${page.name}` : 'Drawing page'}
      />
      <canvas ref={liveCanvasRef} className="ink-canvas-layer ink-canvas-live" aria-hidden />
    </div>
  );
}
