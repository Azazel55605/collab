import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';

import type { InkBounds, InkPage, InkSample } from '../../types/ink';
import { INK_LIMITS, INK_UNITS_PER_PX } from '../../types/ink';
import { captureStroke } from '../../lib/ink/samples';
import type { InkPointerReading } from '../../lib/ink/samples';
import {
  InkContactArbiter,
  INK_DEFAULT_INPUT_SETTINGS,
  isBarrelButton,
  isEraserEnd,
  readingsFromEvent,
  toInkUnits,
} from '../../lib/ink/pointer';
import type { InkInputSettings, InkPointerEventLike } from '../../lib/ink/pointer';
import { InkTileRenderer } from '../../lib/ink/renderer';
import type { InkRenderTarget, InkTileSurfaceFactory } from '../../lib/ink/renderer';
import { outlineStroke } from '../../lib/ink/stroke';
import { INK_TILE_SIZE } from '../../lib/ink/tiles';
import type { InkViewport } from '../../lib/ink/tiles';
import { InkSpatialIndex } from '../../lib/ink/spatialIndex';
import { penButtonTool } from '../../lib/ink/tools';
import type { InkPenButtonMapping, InkToolState } from '../../lib/ink/tools';
import type { InkEraserPoint } from '../../lib/ink/erase';
import type { InkResizeHandle } from '../../lib/ink/transform';
import { shouldHoldToStraighten } from '../../lib/ink/advancedTools';
import InkRichObjectLayer from './InkRichObjectLayer';

/**
 * The interactive ink surface.
 *
 * Three layers, and the split is what keeps drawing responsive:
 *
 * 1. **Cached tiles** hold committed ink. Repainted only where an edit dirtied
 *    them — Phase 0 measured 2.5 ms against 31 ms for a viewport redraw.
 * 2. **A live overlay canvas** carries the stroke currently under the pen. It
 *    is cleared and redrawn every frame, but it holds one stroke, so that is
 *    cheap. Committing the stroke into the document is what moves it down to
 *    the tile layer.
 * 3. **A DOM overlay** draws selection handles and the lasso, where hit targets
 *    and accessibility belong.
 *
 * Drawn strokes become document edits on pointer-up. Erasing is applied while
 * the pointer moves so the surface responds like a physical eraser.
 */

interface CanvasTile {
  canvas: HTMLCanvasElement;
}

/** Absorbs paint calls where no 2D context exists (jsdom, headless tests). */
const NULL_TARGET: InkRenderTarget = {
  save() {}, restore() {}, setTransform() {}, translate() {}, scale() {},
  rotate() {},
  clearRect() {}, fillRect() {}, beginPath() {}, moveTo() {}, lineTo() {},
  closePath() {}, fill() {}, stroke() {}, fillText() {},
  setLineDash() {},
  fillStyle: '', strokeStyle: '', lineWidth: 1, globalAlpha: 1, font: '',
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

export interface InkCanvasProps {
  page: InkPage | null;
  originX: number;
  originY: number;
  zoom: number;
  tool: InkToolState;
  penButtons: InkPenButtonMapping;
  inputSettings?: InkInputSettings;
  selectedIds: string[];
  readOnly: boolean;
  onViewportChange: (next: { originX: number; originY: number; zoom: number }) => void;
  onCommitStroke: (samples: InkSample[], options?: { straighten?: boolean }) => void;
  onCreateAdvancedObject: (
    tool: 'shape' | 'connector' | 'text' | 'sticky' | 'image' | 'stamp' | 'equation' | 'ruler' | 'protractor' | 'compass' | 'guide',
    from: { x: number; y: number },
    to: { x: number; y: number },
    uniform: boolean,
  ) => void;
  onEyedropObject: (objectId: string) => void;
  onActivateObjectLink: (objectId: string) => void;
  readAssetDataUrl: (relativePath: string) => Promise<string>;
  onErase: (path: InkEraserPoint[], radius: number) => void;
  onSelectionChange: (ids: string[], additive: boolean) => void;
  onMoveSelection: (dx: number, dy: number) => void;
  onResizeSelection: (handle: InkResizeHandle, dx: number, dy: number, uniform: boolean) => void;
  onRotateSelection: (radians: number) => void;
  className?: string;
}

const ZOOM_STEP = 1.15;
/** Handle size in CSS pixels — a comfortable mouse and touch target. */
const HANDLE_PX = 9;
const ROTATION_HANDLE_OFFSET_PX = 28;

type Gesture =
  | { kind: 'none' }
  | { kind: 'draw'; pointerId: number; readings: InkPointerReading[]; startedAt: number }
  | { kind: 'erase'; pointerId: number; path: InkEraserPoint[] }
  | { kind: 'pan'; pointerId: number; clientX: number; clientY: number }
  | { kind: 'marquee'; pointerId: number; from: { x: number; y: number }; to: { x: number; y: number }; additive: boolean }
  | { kind: 'lasso'; pointerId: number; points: number[]; additive: boolean }
  | { kind: 'move'; pointerId: number; clientX: number; clientY: number }
  | { kind: 'resize'; pointerId: number; handle: InkResizeHandle; clientX: number; clientY: number }
  | { kind: 'rotate'; pointerId: number; center: { x: number; y: number }; startAngle: number; appliedAngle: number }
  | { kind: 'create'; pointerId: number; tool: 'shape' | 'connector' | 'text' | 'sticky' | 'image' | 'stamp' | 'equation' | 'ruler' | 'protractor' | 'compass' | 'guide'; from: { x: number; y: number }; to: { x: number; y: number }; uniform: boolean }
  | { kind: 'loupe'; pointerId: number };

export default function InkCanvas({
  page,
  originX,
  originY,
  zoom,
  tool,
  penButtons,
  inputSettings = INK_DEFAULT_INPUT_SETTINGS,
  selectedIds,
  readOnly,
  onViewportChange,
  onCommitStroke,
  onCreateAdvancedObject,
  onEyedropObject,
  onActivateObjectLink,
  readAssetDataUrl,
  onErase,
  onSelectionChange,
  onMoveSelection,
  onResizeSelection,
  onRotateSelection,
  className,
}: InkCanvasProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const tileCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const liveCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const loupeCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const rendererRef = useRef<InkTileRenderer<CanvasTile> | null>(null);
  const arbiterRef = useRef(new InkContactArbiter(inputSettings));
  const gestureRef = useRef<Gesture>({ kind: 'none' });
  const [gestureKind, setGestureKind] = useState<Gesture['kind']>('none');
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [overlayVersion, setOverlayVersion] = useState(0);
  const [loupePoint, setLoupePoint] = useState<{ x: number; y: number } | null>(null);
  const [hoveredHandle, setHoveredHandle] = useState<InkResizeHandle | 'rotate' | null>(null);

  rendererRef.current ??= new InkTileRenderer(createTileFactory(), {
    render: { includeNonExported: true, paintEquationFallback: false },
  });

  useEffect(() => {
    arbiterRef.current.updateSettings(inputSettings);
  }, [inputSettings]);

  const index = useMemo(
    () => (page ? new InkSpatialIndex(page.scene) : null),
    [page],
  );

  // The scene changes identity on every edit. Phase 3 drops the whole cache
  // rather than deriving which tiles moved; the targeted path exists
  // (`invalidateMoved`) and is what a later pass should wire to edit bounds.
  useEffect(() => {
    rendererRef.current?.invalidateAll();
  }, [page?.scene, page?.id, page?.background]);

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

  /* --------------------------------------------------------------------- */
  /* Committed ink                                                          */
  /* --------------------------------------------------------------------- */

  const drawTiles = useCallback(() => {
    const canvas = tileCanvasRef.current;
    const renderer = rendererRef.current;
    if (!canvas || !renderer || !page || size.width === 0 || size.height === 0) return;

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

  useEffect(() => {
    const source = tileCanvasRef.current;
    const loupe = loupeCanvasRef.current;
    if (!source || !loupe || !loupePoint) return;
    const ratio = window.devicePixelRatio || 1;
    const sizePx = 144;
    loupe.width = sizePx * ratio;
    loupe.height = sizePx * ratio;
    const context = loupe.getContext('2d');
    if (!context) return;
    const sample = sizePx / 2;
    context.clearRect(0, 0, loupe.width, loupe.height);
    context.drawImage(
      source,
      (loupePoint.x - sample / 2) * ratio,
      (loupePoint.y - sample / 2) * ratio,
      sample * ratio,
      sample * ratio,
      0,
      0,
      sizePx * ratio,
      sizePx * ratio,
    );
  }, [loupePoint, overlayVersion]);

  /* --------------------------------------------------------------------- */
  /* The stroke under the pen                                               */
  /* --------------------------------------------------------------------- */

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

    const gesture = gestureRef.current;
    context.setTransform(ratio, 0, 0, ratio, 0, 0);

    if (gesture.kind === 'draw' && gesture.readings.length > 0) {
      // Use the exact commit pipeline for the live line. A handwritten stroke
      // must not change shape or pressure the moment the pen lifts.
      const samples = captureStroke(gesture.readings, {
        streamline: tool.brush.streamline,
        simplifyTolerance: 0,
      });
      const outline = outlineStroke(samples, tool.brush);
      if (outline.length > 2) {
        context.beginPath();
        const first = toScreen(outline[0].x, outline[0].y);
        context.moveTo(first.x, first.y);
        for (let i = 1; i < outline.length; i += 1) {
          const point = toScreen(outline[i].x, outline[i].y);
          context.lineTo(point.x, point.y);
        }
        context.closePath();
        context.fillStyle = tool.brush.color;
        context.globalAlpha = tool.brush.opacity;
        context.fill();
        context.globalAlpha = 1;
      }
    }

    if (gesture.kind === 'erase' && gesture.path.length > 0) {
      context.lineCap = 'round';
      context.lineJoin = 'round';
      context.beginPath();
      const first = toScreen(gesture.path[0].x, gesture.path[0].y);
      context.moveTo(first.x, first.y);
      for (let index = 1; index < gesture.path.length; index += 1) {
        const point = toScreen(gesture.path[index].x, gesture.path[index].y);
        context.lineTo(point.x, point.y);
      }
      context.strokeStyle = 'rgba(148,163,184,0.28)';
      context.lineWidth = Math.max(2, (tool.eraserRadius * 2) / unitsPerPixel);
      context.stroke();

      const last = gesture.path[gesture.path.length - 1];
      const centre = toScreen(last.x, last.y);
      context.beginPath();
      context.arc(centre.x, centre.y, tool.eraserRadius / unitsPerPixel, 0, Math.PI * 2);
      context.strokeStyle = 'rgba(148,163,184,0.9)';
      context.lineWidth = 1;
      context.stroke();
    }
  }, [size.height, size.width, toScreen, tool.brush, tool.eraserRadius, unitsPerPixel]);

  useEffect(() => {
    const frame = requestAnimationFrame(drawLive);
    return () => cancelAnimationFrame(frame);
  }, [drawLive, overlayVersion]);

  /* --------------------------------------------------------------------- */
  /* Pointer handling                                                       */
  /* --------------------------------------------------------------------- */

  const asPointerEvent = (event: React.PointerEvent<HTMLDivElement>): InkPointerEventLike => {
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

  const bump = () => setOverlayVersion((version) => version + 1);

  /** Which resize handle, if any, is under a client point. */
  const handleAt = useCallback(
    (clientX: number, clientY: number): InkResizeHandle | null => {
      if (selectedIds.length === 0 || !page) return null;
      const bounds = selectionBounds(selectedIds, index);
      if (!bounds) return null;
      const point = { x: clientX, y: clientY };
      const rect = hostRef.current?.getBoundingClientRect();
      const local = { x: point.x - (rect?.left ?? 0), y: point.y - (rect?.top ?? 0) };

      for (const [handle, position] of handlePositions(bounds, toScreen)) {
        if (
          Math.abs(local.x - position.x) <= HANDLE_PX &&
          Math.abs(local.y - position.y) <= HANDLE_PX
        ) {
          return handle;
        }
      }
      return null;
    },
    [index, page, selectedIds, toScreen],
  );

  const rotationHandleAt = useCallback(
    (clientX: number, clientY: number): boolean => {
      if (selectedIds.length === 0 || !page) return false;
      const bounds = selectionBounds(selectedIds, index);
      if (!bounds) return false;
      const rect = hostRef.current?.getBoundingClientRect();
      const center = toScreen((bounds.minX + bounds.maxX) / 2, bounds.minY);
      const localX = clientX - (rect?.left ?? 0);
      const localY = clientY - (rect?.top ?? 0);
      return Math.hypot(localX - center.x, localY - (center.y - ROTATION_HANDLE_OFFSET_PX)) <= HANDLE_PX;
    },
    [index, page, selectedIds, toScreen],
  );

  const onPointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      const native = asPointerEvent(event);
      const role = arbiterRef.current.down(native);
      if (role === 'reject') return;

      event.currentTarget.setPointerCapture(event.pointerId);
      const point = toDocument(event.clientX, event.clientY);

      // A pen button temporarily overrides the tool, without changing it.
      let effective = tool.tool;
      if (native.pointerType === 'pen') {
        if (isEraserEnd(native)) effective = penButtonTool(penButtons.eraserEnd) ?? effective;
        else if (isBarrelButton(native)) effective = penButtonTool(penButtons.barrel) ?? effective;
      }
      if (role === 'erase') effective = 'eraser';
      if (role === 'navigate') effective = 'pan';
      if (readOnly && effective !== 'pan' && effective !== 'select' && effective !== 'loupe' && effective !== 'eyedropper') effective = 'pan';

      if (effective === 'pan') {
        gestureRef.current = {
          kind: 'pan', pointerId: event.pointerId, clientX: event.clientX, clientY: event.clientY,
        };
      } else if (effective === 'eraser') {
        gestureRef.current = { kind: 'erase', pointerId: event.pointerId, path: [point] };
        onErase([point], tool.eraserRadius);
      } else if (effective === 'pen') {
        gestureRef.current = {
          kind: 'draw',
          pointerId: event.pointerId,
          startedAt: event.timeStamp,
          readings: readingsFromEvent(native, { originX, originY, zoom }, event.timeStamp),
        };
      } else if (effective === 'lasso') {
        gestureRef.current = {
          kind: 'lasso', pointerId: event.pointerId, points: [point.x, point.y],
          additive: event.shiftKey,
        };
      } else if (effective === 'eyedropper') {
        const hit = index?.hitTest(point.x, point.y, { slop: HANDLE_PX * unitsPerPixel }) ?? null;
        if (hit) onEyedropObject(hit);
        gestureRef.current = { kind: 'none' };
      } else if (effective === 'loupe') {
        const rect = hostRef.current?.getBoundingClientRect();
        setLoupePoint({ x: event.clientX - (rect?.left ?? 0), y: event.clientY - (rect?.top ?? 0) });
        gestureRef.current = { kind: 'loupe', pointerId: event.pointerId };
      } else if (['shape', 'connector', 'text', 'sticky', 'image', 'stamp', 'equation', 'ruler', 'protractor', 'compass', 'guide'].includes(effective)) {
        gestureRef.current = {
          kind: 'create', pointerId: event.pointerId, tool: effective as Extract<Gesture, { kind: 'create' }>['tool'],
          from: point, to: point, uniform: event.shiftKey,
        };
      } else {
        const bounds = selectionBounds(selectedIds, index);
        if (rotationHandleAt(event.clientX, event.clientY) && bounds && !readOnly) {
          const center = {
            x: (bounds.minX + bounds.maxX) / 2,
            y: (bounds.minY + bounds.maxY) / 2,
          };
          gestureRef.current = {
            kind: 'rotate',
            pointerId: event.pointerId,
            center,
            startAngle: Math.atan2(point.y - center.y, point.x - center.x),
            appliedAngle: 0,
          };
        } else {
          const handle = handleAt(event.clientX, event.clientY);
          if (handle && !readOnly) {
            gestureRef.current = {
              kind: 'resize', pointerId: event.pointerId, handle,
              clientX: event.clientX, clientY: event.clientY,
            };
          } else {
            const hit = index?.hitTest(point.x, point.y, { slop: HANDLE_PX * unitsPerPixel }) ?? null;
            if (hit && selectedIds.includes(hit) && !readOnly) {
              gestureRef.current = {
                kind: 'move', pointerId: event.pointerId,
                clientX: event.clientX, clientY: event.clientY,
              };
            } else if (hit) {
              onSelectionChange([hit], event.shiftKey);
              gestureRef.current = readOnly
                ? { kind: 'none' }
                : { kind: 'move', pointerId: event.pointerId, clientX: event.clientX, clientY: event.clientY };
            } else {
              gestureRef.current = {
                kind: 'marquee', pointerId: event.pointerId,
                from: point, to: point, additive: event.shiftKey,
              };
            }
          }
        }
      }
      setGestureKind(gestureRef.current.kind);
      bump();
    },
    [handleAt, index, onErase, onEyedropObject, onSelectionChange, originX, originY, penButtons, readOnly, rotationHandleAt, selectedIds, tool.eraserRadius, tool.tool, toDocument, unitsPerPixel, zoom],
  );

  const onPointerMove = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      const gesture = gestureRef.current;
      if (gesture.kind === 'none') {
        if (tool.tool === 'select' && !readOnly) {
          setHoveredHandle(
            rotationHandleAt(event.clientX, event.clientY)
              ? 'rotate'
              : handleAt(event.clientX, event.clientY),
          );
        }
        return;
      }
      const native = asPointerEvent(event);
      if (arbiterRef.current.move(native) === 'reject') return;
      if (gesture.pointerId !== event.pointerId) return;

      switch (gesture.kind) {
        case 'pan': {
          onViewportChange({
            originX: originX - (event.clientX - gesture.clientX) * unitsPerPixel,
            originY: originY - (event.clientY - gesture.clientY) * unitsPerPixel,
            zoom,
          });
          gesture.clientX = event.clientX;
          gesture.clientY = event.clientY;
          return;
        }
        case 'draw': {
          const coalesced = (event.nativeEvent as PointerEvent).getCoalescedEvents?.() ?? [];
          const rect = hostRef.current?.getBoundingClientRect();
          const entries: InkPointerEventLike[] = (coalesced.length > 0 ? coalesced : [event.nativeEvent as PointerEvent]).map(
            (entry) => ({
              pointerId: entry.pointerId,
              pointerType: entry.pointerType,
              isPrimary: entry.isPrimary,
              buttons: entry.buttons,
              pressure: entry.pressure,
              tiltX: entry.tiltX,
              tiltY: entry.tiltY,
              twist: (entry as unknown as { twist?: number }).twist,
              offsetX: entry.clientX - (rect?.left ?? 0),
              offsetY: entry.clientY - (rect?.top ?? 0),
              timeStamp: entry.timeStamp,
            }),
          );
          for (const entry of entries) {
            gesture.readings.push(
              ...readingsFromEvent(entry, { originX, originY, zoom }, gesture.startedAt),
            );
          }
          bump();
          return;
        }
        case 'erase': {
          const next = toDocument(event.clientX, event.clientY);
          const previous = gesture.path[gesture.path.length - 1];
          gesture.path.push(next);
          onErase([previous, next], tool.eraserRadius);
          bump();
          return;
        }
        case 'marquee': {
          gesture.to = toDocument(event.clientX, event.clientY);
          bump();
          return;
        }
        case 'lasso': {
          const point = toDocument(event.clientX, event.clientY);
          gesture.points.push(point.x, point.y);
          bump();
          return;
        }
        case 'move': {
          onMoveSelection(
            (event.clientX - gesture.clientX) * unitsPerPixel,
            (event.clientY - gesture.clientY) * unitsPerPixel,
          );
          gesture.clientX = event.clientX;
          gesture.clientY = event.clientY;
          return;
        }
        case 'resize': {
          onResizeSelection(
            gesture.handle,
            (event.clientX - gesture.clientX) * unitsPerPixel,
            (event.clientY - gesture.clientY) * unitsPerPixel,
            event.shiftKey,
          );
          gesture.clientX = event.clientX;
          gesture.clientY = event.clientY;
          return;
        }
        case 'rotate': {
          const point = toDocument(event.clientX, event.clientY);
          const angle = Math.atan2(point.y - gesture.center.y, point.x - gesture.center.x);
          const raw = angle - gesture.startAngle;
          const desired = event.shiftKey
            ? Math.round(raw / (Math.PI / 12)) * (Math.PI / 12)
            : raw;
          const delta = desired - gesture.appliedAngle;
          if (delta !== 0) onRotateSelection(delta);
          gesture.appliedAngle = desired;
          return;
        }
        case 'create': {
          gesture.to = toDocument(event.clientX, event.clientY);
          gesture.uniform = event.shiftKey;
          bump();
          return;
        }
        case 'loupe': {
          const rect = hostRef.current?.getBoundingClientRect();
          setLoupePoint({ x: event.clientX - (rect?.left ?? 0), y: event.clientY - (rect?.top ?? 0) });
          return;
        }
      }
    },
    [handleAt, onErase, onMoveSelection, onResizeSelection, onRotateSelection, onViewportChange, originX, originY, readOnly, rotationHandleAt, toDocument, tool.eraserRadius, tool.tool, unitsPerPixel, zoom],
  );

  const endGesture = useCallback(
    (event: React.PointerEvent<HTMLDivElement>, cancelled: boolean) => {
      const gesture = gestureRef.current;
      arbiterRef.current.up(asPointerEvent(event));
      if (gesture.kind === 'none' || gesture.pointerId !== event.pointerId) return;

      gestureRef.current = { kind: 'none' };
      setGestureKind('none');

      if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }

      // A cancelled drawing gesture commits nothing. Erasing is deliberately
      // immediate, so portions already erased stay erased if capture is lost.
      if (cancelled) {
        if (gesture.kind === 'loupe') setLoupePoint(null);
        bump();
        return;
      }

      switch (gesture.kind) {
        case 'draw': {
          const samples = captureStroke(gesture.readings, {
            streamline: tool.brush.streamline,
            simplifyTolerance: 0,
          });
          if (samples.length > 0) {
            onCommitStroke(samples, {
              straighten: tool.holdToStraighten && shouldHoldToStraighten(samples, event.timeStamp - gesture.startedAt),
            });
          }
          break;
        }
        case 'erase':
          break;
        case 'marquee': {
          const bounds: InkBounds = {
            minX: Math.min(gesture.from.x, gesture.to.x),
            minY: Math.min(gesture.from.y, gesture.to.y),
            maxX: Math.max(gesture.from.x, gesture.to.x),
            maxY: Math.max(gesture.from.y, gesture.to.y),
          };
          const hits = index?.hitTestRegion(bounds, 'contain') ?? [];
          onSelectionChange(hits, gesture.additive);
          break;
        }
        case 'lasso': {
          const hits = index?.hitTestLasso(gesture.points, 'intersect') ?? [];
          onSelectionChange(hits, gesture.additive);
          break;
        }
        case 'create':
          onCreateAdvancedObject(gesture.tool, gesture.from, gesture.to, gesture.uniform);
          break;
        case 'loupe':
          setLoupePoint(null);
          break;
        default:
          break;
      }
      bump();
    },
    [index, onCommitStroke, onCreateAdvancedObject, onSelectionChange, tool.brush.streamline, tool.holdToStraighten],
  );

  const onWheel = useCallback(
    (event: React.WheelEvent<HTMLDivElement>) => {
      event.preventDefault();
      const rect = hostRef.current?.getBoundingClientRect();
      const pointerX = event.clientX - (rect?.left ?? 0);
      const pointerY = event.clientY - (rect?.top ?? 0);

      const next = Math.min(
        INK_LIMITS.maxZoom,
        Math.max(INK_LIMITS.minZoom, zoom * (event.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP)),
      );
      if (next === zoom) return;
      const after = INK_UNITS_PER_PX / next;
      onViewportChange({
        originX: originX + pointerX * (unitsPerPixel - after),
        originY: originY + pointerY * (unitsPerPixel - after),
        zoom: next,
      });
    },
    [onViewportChange, originX, originY, unitsPerPixel, zoom],
  );

  // Losing the window mid-stroke must not leave a stuck contact.
  useEffect(() => {
    const reset = () => {
      arbiterRef.current.reset();
      gestureRef.current = { kind: 'none' };
      setGestureKind('none');
      bump();
    };
    window.addEventListener('blur', reset);
    document.addEventListener('visibilitychange', reset);
    return () => {
      window.removeEventListener('blur', reset);
      document.removeEventListener('visibilitychange', reset);
    };
  }, []);

  const bounds = page ? selectionBounds(selectedIds, index) : null;
  const gesture = gestureRef.current;

  return (
    <div
      ref={hostRef}
      className={className}
      data-testid="ink-canvas-host"
      data-gesture={gestureKind}
      // Required, or the browser scrolls instead of delivering pointermove and
      // a stroke silently stops mid-gesture.
      style={{ touchAction: 'none', cursor: cursorFor(tool.tool, gestureKind, hoveredHandle, gestureRef.current) }}
      onWheel={onWheel}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={(event) => endGesture(event, false)}
      onPointerCancel={(event) => endGesture(event, true)}
      onLostPointerCapture={(event) => endGesture(event, true)}
      onPointerLeave={() => setHoveredHandle(null)}
      onDoubleClick={(event) => {
        const point = toDocument(event.clientX, event.clientY);
        const hit = index?.hitTest(point.x, point.y, { slop: HANDLE_PX * unitsPerPixel });
        if (hit) onActivateObjectLink(hit);
      }}
    >
      <canvas
        ref={tileCanvasRef}
        style={{ position: 'absolute', inset: 0, width: '100%', height: '100%' }}
        aria-label={page?.name ? `Drawing page ${page.name}` : 'Drawing page'}
        role="img"
      />
      {page ? (
        <InkRichObjectLayer
          scene={page.scene}
          originX={originX}
          originY={originY}
          zoom={zoom}
          readAssetDataUrl={readAssetDataUrl}
        />
      ) : null}
      <canvas
        ref={loupeCanvasRef}
        aria-hidden
        className="pointer-events-none absolute rounded-full border-2 border-primary bg-background shadow-xl"
        style={{
          display: loupePoint ? 'block' : 'none',
          left: (loupePoint?.x ?? 0) + 18,
          top: (loupePoint?.y ?? 0) + 18,
          width: 144,
          height: 144,
        }}
      />
      <canvas
        ref={liveCanvasRef}
        aria-hidden
        style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', pointerEvents: 'none' }}
      />

      <svg
        aria-hidden
        style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', pointerEvents: 'none' }}
      >
        {gesture.kind === 'marquee' && (
          <MarqueeOutline from={gesture.from} to={gesture.to} toScreen={toScreen} />
        )}
        {gesture.kind === 'lasso' && gesture.points.length >= 4 && (
          <polyline
            points={pairs(gesture.points).map((point) => {
              const screen = toScreen(point[0], point[1]);
              return `${screen.x},${screen.y}`;
            }).join(' ')}
            fill="rgba(139,125,255,0.08)"
            stroke="rgba(139,125,255,0.9)"
            strokeWidth={1}
            strokeDasharray="4 3"
          />
        )}
        {gesture.kind === 'create' && (
          <CreationPreview gesture={gesture} toScreen={toScreen} />
        )}
        {bounds && gesture.kind !== 'marquee' && gesture.kind !== 'lasso' && (
          <SelectionOverlay bounds={bounds} toScreen={toScreen} readOnly={readOnly} />
        )}
      </svg>
    </div>
  );
}

/* ------------------------------------------------------------------------- */

function pairs(flat: number[]): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (let index = 0; index + 1 < flat.length; index += 2) out.push([flat[index], flat[index + 1]]);
  return out;
}

function cursorFor(
  tool: string,
  gesture: string,
  hoveredHandle: InkResizeHandle | 'rotate' | null,
  activeGesture: Gesture,
): string {
  if (gesture === 'pan') return 'grabbing';
  if (gesture === 'rotate') return 'grabbing';
  if (activeGesture.kind === 'resize') return resizeCursor(activeGesture.handle);
  if (hoveredHandle === 'rotate') return 'grab';
  if (hoveredHandle) return resizeCursor(hoveredHandle);
  if (tool === 'pan') return 'grab';
  if (tool === 'pen' || tool === 'eraser' || tool === 'shape' || tool === 'connector' || tool === 'text' || tool === 'sticky' || tool === 'image' || tool === 'stamp' || tool === 'equation' || tool === 'ruler' || tool === 'protractor' || tool === 'compass' || tool === 'guide' || tool === 'eyedropper' || tool === 'loupe') return 'crosshair';
  return 'default';
}

function resizeCursor(handle: InkResizeHandle): string {
  if (handle === 'n' || handle === 's') return 'ns-resize';
  if (handle === 'e' || handle === 'w') return 'ew-resize';
  if (handle === 'nw' || handle === 'se') return 'nwse-resize';
  return 'nesw-resize';
}

function CreationPreview({
  gesture,
  toScreen,
}: {
  gesture: Extract<Gesture, { kind: 'create' }>;
  toScreen: ToScreen;
}) {
  const from = toScreen(gesture.from.x, gesture.from.y);
  const to = toScreen(gesture.to.x, gesture.to.y);
  if (gesture.tool === 'connector' || gesture.tool === 'ruler' || gesture.tool === 'protractor' || gesture.tool === 'guide') {
    return <line x1={from.x} y1={from.y} x2={to.x} y2={to.y} stroke="rgba(139,125,255,0.9)" strokeWidth={1.5} />;
  }
  return (
    <rect
      x={Math.min(from.x, to.x)}
      y={Math.min(from.y, to.y)}
      width={Math.max(1, Math.abs(to.x - from.x))}
      height={Math.max(1, Math.abs(to.y - from.y))}
      rx={gesture.tool === 'sticky' ? 6 : 0}
      fill={gesture.tool === 'sticky' ? 'rgba(254,243,167,0.35)' : 'rgba(139,125,255,0.08)'}
      stroke="rgba(139,125,255,0.9)"
      strokeWidth={1}
      strokeDasharray="4 3"
    />
  );
}

/** Union bounds of a selection, from the index's cached values. */
function selectionBounds(
  selectedIds: string[],
  index: InkSpatialIndex | null,
): InkBounds | null {
  let bounds: InkBounds | null = null;
  for (const id of selectedIds) {
    const objectBound = index?.boundsOf(id);
    if (!objectBound) continue;
    bounds = bounds
      ? {
          minX: Math.min(bounds.minX, objectBound.minX),
          minY: Math.min(bounds.minY, objectBound.minY),
          maxX: Math.max(bounds.maxX, objectBound.maxX),
          maxY: Math.max(bounds.maxY, objectBound.maxY),
        }
      : objectBound;
  }
  return bounds;
}

type ToScreen = (x: number, y: number) => { x: number; y: number };

function handlePositions(
  bounds: InkBounds,
  toScreen: ToScreen,
): Array<[InkResizeHandle, { x: number; y: number }]> {
  const midX = (bounds.minX + bounds.maxX) / 2;
  const midY = (bounds.minY + bounds.maxY) / 2;
  return [
    ['nw', toScreen(bounds.minX, bounds.minY)],
    ['n', toScreen(midX, bounds.minY)],
    ['ne', toScreen(bounds.maxX, bounds.minY)],
    ['w', toScreen(bounds.minX, midY)],
    ['e', toScreen(bounds.maxX, midY)],
    ['sw', toScreen(bounds.minX, bounds.maxY)],
    ['s', toScreen(midX, bounds.maxY)],
    ['se', toScreen(bounds.maxX, bounds.maxY)],
  ];
}

function SelectionOverlay({
  bounds,
  toScreen,
  readOnly,
}: {
  bounds: InkBounds;
  toScreen: ToScreen;
  readOnly: boolean;
}) {
  const topLeft = toScreen(bounds.minX, bounds.minY);
  const bottomRight = toScreen(bounds.maxX, bounds.maxY);
  return (
    <g data-testid="ink-selection">
      <rect
        x={topLeft.x}
        y={topLeft.y}
        width={Math.max(1, bottomRight.x - topLeft.x)}
        height={Math.max(1, bottomRight.y - topLeft.y)}
        fill="none"
        stroke="rgba(139,125,255,0.9)"
        strokeWidth={1}
        strokeDasharray="4 3"
      />
      {!readOnly &&
        <>
          <line
            x1={(topLeft.x + bottomRight.x) / 2}
            y1={topLeft.y}
            x2={(topLeft.x + bottomRight.x) / 2}
            y2={topLeft.y - ROTATION_HANDLE_OFFSET_PX}
            stroke="rgba(139,125,255,0.9)"
            strokeWidth={1}
          />
          <circle
            data-ink-handle="rotate"
            cx={(topLeft.x + bottomRight.x) / 2}
            cy={topLeft.y - ROTATION_HANDLE_OFFSET_PX}
            r={HANDLE_PX / 2}
            fill="var(--background, #fff)"
            stroke="rgba(139,125,255,0.9)"
            strokeWidth={1}
            style={{ cursor: 'grab' }}
          />
          {handlePositions(bounds, toScreen).map(([handle, point]) => (
          <rect
            key={handle}
            data-ink-handle={handle}
            x={point.x - HANDLE_PX / 2}
            y={point.y - HANDLE_PX / 2}
            width={HANDLE_PX}
            height={HANDLE_PX}
            fill="var(--background, #fff)"
            stroke="rgba(139,125,255,0.9)"
            strokeWidth={1}
            style={{ cursor: resizeCursor(handle) }}
          />
          ))}
        </>}
    </g>
  );
}

function MarqueeOutline({
  from,
  to,
  toScreen,
}: {
  from: { x: number; y: number };
  to: { x: number; y: number };
  toScreen: ToScreen;
}) {
  const a = toScreen(Math.min(from.x, to.x), Math.min(from.y, to.y));
  const b = toScreen(Math.max(from.x, to.x), Math.max(from.y, to.y));
  return (
    <rect
      data-testid="ink-marquee"
      x={a.x}
      y={a.y}
      width={Math.max(0, b.x - a.x)}
      height={Math.max(0, b.y - a.y)}
      fill="rgba(139,125,255,0.08)"
      stroke="rgba(139,125,255,0.9)"
      strokeWidth={1}
      strokeDasharray="4 3"
    />
  );
}
