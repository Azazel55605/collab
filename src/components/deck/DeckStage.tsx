import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react';

import { updateElements } from '../../lib/deck/operations';
import type { DeckTarget, ResolvedSlide } from '../../lib/deck/resolve';
import { resolveTarget } from '../../lib/deck/resolve';
import { cellAtPoint } from '../../lib/deck/tables';
import type { DeckTextMeasurer } from '../../lib/deck/textLayout';
import {
  cropImage,
  frameCenter,
  frameCorners,
  hitTest,
  marqueeSelect,
  moveLineEndpoint,
  moveSelection,
  pointInFrame,
  resizeSelection,
  rotateSelection,
  selectionBounds,
  snapMove,
} from '../../lib/deck/transform';
import type {
  Bounds,
  CropHandle,
  ElementUpdaters,
  Point,
  ResizeHandle,
  SlideGeometry,
  SnapGuide,
} from '../../lib/deck/transform';
import { targetGeometry } from '../../lib/deck/transform';
import { DECK_UNITS_PER_INCH, DECK_UNITS_PER_PX } from '../../types/deck';
import type { DeckAssetRef, DeckDocument, DeckTransition } from '../../types/deck';

import { DeckSlide } from './DeckSlide';

/** Screen-pixel sizes: object controls keep their size at every zoom. */
const HANDLE_PX = 8;
const ROTATE_OFFSET_PX = 24;
const HIT_SLOP_PX = 4;
const SNAP_PX = 6;
const DRAG_THRESHOLD_PX = 3;
const RULER_PX = 20;
const MARGIN_PX = 48;
const ROTATE_STEP = 1_500; // 15° in hundredths of a degree

export interface DeckStageOptions {
  snapToObjects: boolean;
  /** Grid spacing in deck units; 0 when the grid is off. */
  grid: number;
  showRulers: boolean;
}

interface DeckStageProps {
  deck: DeckDocument;
  /** The slide, layout, or master being edited. */
  target: DeckTarget;
  resolved: ResolvedSlide;
  geometry: SlideGeometry;
  /** CSS pixels per CSS pixel of the slide at 100%. */
  zoom: number;
  measurer: DeckTextMeasurer;
  resolveAsset: (asset: DeckAssetRef) => string | null;
  selectedIds: string[];
  readOnly: boolean;
  options: DeckStageOptions;
  /** Crop mode: the side handles of a single selected image crop it instead. */
  cropping: boolean;
  /** Enters crop mode for an image (on double-click). */
  onCroppingChange: (imageId: string | null) => void;
  onSelectionChange: (ids: string[]) => void;
  /** Commits one finished gesture as one undoable edit. */
  onCommit: (updaters: ElementUpdaters, label: string) => void;
  onZoom: (next: number, anchor?: { clientX: number; clientY: number }) => void;
  onContextMenu?: (event: React.MouseEvent) => void;
  /** Opens in-place editing (single click for text boxes, double-click for shape text). */
  onEditText?: (elementId: string, point: { clientX: number; clientY: number }) => void;
  /**
   * The in-place text editor, laid over its element's frame — or over `rect`
   * (slide units, before the element's rotation) for a table cell.
   */
  editing?: {
    id: string;
    content: React.ReactNode;
    rect?: { x: number; y: number; width: number; height: number };
  } | null;
  /** Edits the text of a table cell (double-click on a table). */
  onEditCell?: (
    tableId: string,
    cell: { rowId: string; columnId: string },
    point: { clientX: number; clientY: number },
  ) => void;
  /** The table cell a click landed on, for row and column commands. */
  onActiveCell?: (tableId: string, cell: { rowId: string; columnId: string } | null) => void;
  /** Opens a linked document's source (double-click on it). */
  onOpenEmbed?: (elementId: string) => void;
  /** Files dropped on the stage, with the slide point they landed on. */
  onDropFiles?: (files: File[], point: Point) => void;
  /** Ends in-place text editing, when the pointer goes down anywhere else. */
  onExitText?: () => void;
  /** Collaborators' selections on this slide, outlined in their colour. */
  peers?: DeckStagePeer[];
  transitionPreview?: { key: number; transition: DeckTransition } | null;
}

export interface DeckStagePeer {
  key: string;
  name: string;
  color: string;
  ids: string[];
  /** The element the peer is typing in, if any. */
  typingId: string | null;
}

type Gesture =
  | { kind: 'none' }
  | {
      kind: 'pending';
      start: Point;
      hit: string;
      additive: boolean;
      editTextAt?: { clientX: number; clientY: number };
    }
  | { kind: 'move'; start: Point; ids: string[] }
  | { kind: 'resize'; start: Point; ids: string[]; handle: ResizeHandle }
  | { kind: 'crop'; start: Point; id: string; handle: CropHandle }
  | { kind: 'endpoint'; id: string; end: 'from' | 'to' }
  | { kind: 'rotate'; ids: string[]; centre: Point; startAngle: number }
  | { kind: 'marquee'; start: Point; current: Point; additive: boolean; base: string[] }
  | { kind: 'pan'; clientX: number; clientY: number; scrollLeft: number; scrollTop: number };

const CROP_BAR_PX = 18;
const CROP_HANDLES: Array<{ handle: CropHandle; at: [number, number]; cursor: string }> = [
  { handle: 'n', at: [0.5, 0], cursor: 'ns-resize' },
  { handle: 'e', at: [1, 0.5], cursor: 'ew-resize' },
  { handle: 's', at: [0.5, 1], cursor: 'ns-resize' },
  { handle: 'w', at: [0, 0.5], cursor: 'ew-resize' },
];

const HANDLES: Array<{ handle: ResizeHandle; at: [number, number]; cursor: string }> = [
  { handle: 'nw', at: [0, 0], cursor: 'nwse-resize' },
  { handle: 'n', at: [0.5, 0], cursor: 'ns-resize' },
  { handle: 'ne', at: [1, 0], cursor: 'nesw-resize' },
  { handle: 'e', at: [1, 0.5], cursor: 'ew-resize' },
  { handle: 'se', at: [1, 1], cursor: 'nwse-resize' },
  { handle: 's', at: [0.5, 1], cursor: 'ns-resize' },
  { handle: 'sw', at: [0, 1], cursor: 'nesw-resize' },
  { handle: 'w', at: [0, 0.5], cursor: 'ew-resize' },
];

/** Deck units → slide-local CSS pixels at a zoom. */
const toScreen = (units: number, zoom: number) => (units / DECK_UNITS_PER_PX) * zoom;

/** The outline and handle positions of a selection, in slide-local CSS pixels. */
function selectionShape(geometry: SlideGeometry, ids: string[], zoom: number) {
  if (ids.length === 1) {
    const frame = geometry.frames.get(ids[0]);
    const element = geometry.slide.elements[ids[0]];
    if (frame && element && element.type !== 'line' && element.type !== 'group') {
      const corners = frameCorners(frame).map((corner) => ({
        x: toScreen(corner.x, zoom),
        y: toScreen(corner.y, zoom),
      }));
      return { corners, rotated: frame.rotation !== 0 };
    }
  }
  const bounds = selectionBounds(geometry, ids);
  if (!bounds) return null;
  const x0 = toScreen(bounds.minX, zoom);
  const y0 = toScreen(bounds.minY, zoom);
  const x1 = toScreen(bounds.maxX, zoom);
  const y1 = toScreen(bounds.maxY, zoom);
  return {
    corners: [
      { x: x0, y: y0 },
      { x: x1, y: y0 },
      { x: x1, y: y1 },
      { x: x0, y: y1 },
    ],
    rotated: false,
  };
}

/** A point at fractional position (u, v) of a quadrilateral given by its corners. */
function along(corners: Point[], u: number, v: number): Point {
  const top = {
    x: corners[0].x + (corners[1].x - corners[0].x) * u,
    y: corners[0].y + (corners[1].y - corners[0].y) * u,
  };
  const bottom = {
    x: corners[3].x + (corners[2].x - corners[3].x) * u,
    y: corners[3].y + (corners[2].y - corners[3].y) * u,
  };
  return { x: top.x + (bottom.x - top.x) * v, y: top.y + (bottom.y - top.y) * v };
}

function Ruler({ axis, length, zoom }: { axis: 'x' | 'y'; length: number; zoom: number }) {
  // Major ticks every inch, minor every eighth, as slide tools conventionally show.
  const eighth = DECK_UNITS_PER_INCH / 8;
  const ticks: Array<{ at: number; major: boolean; label?: string }> = [];
  for (let units = 0, index = 0; units <= length; units += eighth, index += 1) {
    ticks.push({
      at: toScreen(units, zoom),
      major: index % 8 === 0,
      label: index % 8 === 0 ? String(index / 8) : undefined,
    });
  }
  const size = toScreen(length, zoom);
  return axis === 'x' ? (
    <svg
      width={size}
      height={RULER_PX}
      className="block overflow-visible text-muted-foreground"
      aria-hidden
    >
      {ticks.map((tick) => (
        <g key={tick.at}>
          <line
            x1={tick.at}
            x2={tick.at}
            y1={tick.major ? 4 : 13}
            y2={RULER_PX}
            stroke="currentColor"
            strokeWidth={1}
            opacity={0.6}
          />
          {tick.label && (
            <text x={tick.at + 3} y={11} fontSize={9} fill="currentColor">
              {tick.label}
            </text>
          )}
        </g>
      ))}
    </svg>
  ) : (
    <svg
      width={RULER_PX}
      height={size}
      className="block overflow-visible text-muted-foreground"
      aria-hidden
    >
      {ticks.map((tick) => (
        <g key={tick.at}>
          <line
            y1={tick.at}
            y2={tick.at}
            x1={tick.major ? 4 : 13}
            x2={RULER_PX}
            stroke="currentColor"
            strokeWidth={1}
            opacity={0.6}
          />
          {tick.label && (
            <text x={3} y={tick.at + 10} fontSize={9} fill="currentColor">
              {tick.label}
            </text>
          )}
        </g>
      ))}
    </svg>
  );
}

/**
 * The editing stage: one slide at a zoom, with selection, move, resize,
 * rotate, marquee, snapping, rulers, and pan.
 *
 * A gesture previews by applying its edit to a scratch copy of the deck and
 * commits once on release, so a drag is one undo step and one save.
 */
export function DeckStage({
  deck,
  target,
  resolved,
  geometry,
  zoom,
  measurer,
  resolveAsset,
  selectedIds,
  readOnly,
  options,
  cropping,
  onCroppingChange,
  onSelectionChange,
  onCommit,
  onZoom,
  onContextMenu,
  onEditText,
  editing,
  onExitText,
  peers,
  onEditCell,
  onActiveCell,
  onOpenEmbed,
  onDropFiles,
  transitionPreview,
}: DeckStageProps) {
  const slideId = target.id;
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const slideRef = useRef<HTMLDivElement | null>(null);
  const gestureRef = useRef<Gesture>({ kind: 'none' });
  const [preview, setPreviewState] = useState<{
    updaters: ElementUpdaters;
    guides: SnapGuide[];
  } | null>(null);
  // Mirrors `preview` synchronously: pointerup and lostpointercapture can both
  // fire before a re-render, and must not commit the same gesture twice.
  const previewRef = useRef<typeof preview>(null);
  const setPreview = (next: typeof preview) => {
    previewRef.current = next;
    setPreviewState(next);
  };
  const [scroll, setScroll] = useState({ left: 0, top: 0 });
  const [marquee, setMarquee] = useState<Bounds | null>(null);
  const [spaceHeld, setSpaceHeld] = useState(false);

  const slideWidthPx = toScreen(deck.size.width, zoom);
  const slideHeightPx = toScreen(deck.size.height, zoom);
  const rulers = options.showRulers ? RULER_PX : 0;
  // Slide origin inside the scrolled viewport, for the rulers.
  const originX = MARGIN_PX - scroll.left;
  const originY = MARGIN_PX - scroll.top;

  // The previewed scene: the committed deck with the in-flight gesture applied.
  const previewDeck = useMemo(
    () => (preview ? updateElements(deck, target, preview.updaters).result : deck),
    [deck, preview, target],
  );
  const shownSlide = useMemo(
    () => (preview ? resolveTarget(previewDeck, target, { prompts: true }) : resolved),
    [preview, previewDeck, resolved, target],
  );
  const shownGeometry = useMemo(
    () => (preview ? targetGeometry(previewDeck, target) : geometry),
    [geometry, preview, previewDeck, target],
  );

  const toSlide = useCallback(
    (clientX: number, clientY: number): Point => {
      const rect = slideRef.current?.getBoundingClientRect();
      if (!rect) return { x: 0, y: 0 };
      return {
        x: ((clientX - rect.left) / zoom) * DECK_UNITS_PER_PX,
        y: ((clientY - rect.top) / zoom) * DECK_UNITS_PER_PX,
      };
    },
    [zoom],
  );
  const unitsPerScreenPx = DECK_UNITS_PER_PX / zoom;
  const locked = selectedIds.some((id) => geometry.slide.elements[id]?.locked);
  const cropTarget =
    cropping &&
    selectedIds.length === 1 &&
    geometry.slide.elements[selectedIds[0]]?.type === 'image'
      ? selectedIds[0]
      : null;

  // Double-clicking an image crops it; shape text keeps the deliberate double-click path.
  const onDoubleClick = (event: React.MouseEvent<HTMLDivElement>) => {
    if (readOnly) return;
    const point = toSlide(event.clientX, event.clientY);
    let hit = hitTest(geometry, point, HIT_SLOP_PX * unitsPerScreenPx);
    // Inside a selected group, double-click reaches the child under the pointer.
    if (hit && geometry.slide.elements[hit]?.type === 'group') {
      const inner = [...geometry.frames.entries()]
        .filter(([id]) => geometry.parents.has(id) && geometry.slide.elements[id]?.type !== 'group')
        .reverse()
        .find(([, frame]) => pointInFrame(frame, point));
      if (inner) hit = inner[0];
    }
    const element = hit ? geometry.slide.elements[hit] : null;
    if (!hit || !element || element.locked) return;
    if (element.type === 'image') {
      onSelectionChange([hit]);
      onCroppingChange(hit);
      return;
    }
    if (element.type === 'table' && onEditCell) {
      const item = resolved.items.find((entry) => entry.id === hit);
      const cell = item?.kind === 'table' ? cellAtPoint(item, point) : null;
      if (cell) {
        if (geometry.order.includes(hit)) onSelectionChange([hit]);
        onEditCell(hit, cell, { clientX: event.clientX, clientY: event.clientY });
      }
      return;
    }
    if (element.type === 'embed') {
      onOpenEmbed?.(hit);
      return;
    }
    if ((element.type === 'text' || element.type === 'shape') && onEditText) {
      if (geometry.order.includes(hit)) onSelectionChange([hit]);
      onEditText(hit, { clientX: event.clientX, clientY: event.clientY });
    }
  };

  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (editing) onExitText?.();
    if (event.button === 2) {
      // Right-click selects what it lands on, so the context menu acts on it.
      const hit = hitTest(
        geometry,
        toSlide(event.clientX, event.clientY),
        HIT_SLOP_PX * unitsPerScreenPx,
      );
      if (hit && !selectedIds.includes(hit)) onSelectionChange([hit]);
      return;
    }
    const target = event.target as HTMLElement;
    event.currentTarget.setPointerCapture?.(event.pointerId);
    if (event.button === 1 || spaceHeld) {
      const scroller = scrollRef.current!;
      gestureRef.current = {
        kind: 'pan',
        clientX: event.clientX,
        clientY: event.clientY,
        scrollLeft: scroller.scrollLeft,
        scrollTop: scroller.scrollTop,
      };
      return;
    }
    const point = toSlide(event.clientX, event.clientY);
    const cropHandle = target.dataset.cropHandle as CropHandle | undefined;
    if (cropHandle && cropTarget && !readOnly && !locked) {
      gestureRef.current = { kind: 'crop', start: point, id: cropTarget, handle: cropHandle };
      return;
    }
    const endpoint = target.dataset.endpoint as 'from' | 'to' | undefined;
    if (endpoint && selectedIds.length === 1 && !readOnly && !locked) {
      gestureRef.current = { kind: 'endpoint', id: selectedIds[0], end: endpoint };
      return;
    }
    const handle = target.dataset.handle as ResizeHandle | 'rotate' | undefined;
    if (handle && !readOnly && !locked) {
      if (handle === 'rotate') {
        const bounds = selectionBounds(geometry, selectedIds)!;
        const centre =
          selectedIds.length === 1 && geometry.frames.get(selectedIds[0])
            ? frameCenter(geometry.frames.get(selectedIds[0])!)
            : { x: (bounds.minX + bounds.maxX) / 2, y: (bounds.minY + bounds.maxY) / 2 };
        gestureRef.current = {
          kind: 'rotate',
          ids: selectedIds,
          centre,
          startAngle: Math.atan2(point.y - centre.y, point.x - centre.x),
        };
      } else {
        gestureRef.current = { kind: 'resize', start: point, ids: selectedIds, handle };
      }
      return;
    }
    const hit = hitTest(geometry, point, HIT_SLOP_PX * unitsPerScreenPx);
    const additive = event.shiftKey || event.ctrlKey || event.metaKey;
    if (hit && onActiveCell && geometry.slide.elements[hit]?.type === 'table') {
      const item = resolved.items.find((entry) => entry.id === hit);
      onActiveCell(hit, item?.kind === 'table' ? cellAtPoint(item, point) : null);
    }
    if (hit) {
      const element = geometry.slide.elements[hit];
      // Text boxes are content-first. Defer opening until pointer-up so the
      // contenteditable, rather than this interaction layer, owns final focus.
      // Crossing the drag threshold still turns this into an ordinary move.
      if (!additive && !readOnly && element?.type === 'text' && !element.locked && onEditText) {
        if (geometry.order.includes(hit)) onSelectionChange([hit]);
        gestureRef.current = {
          kind: 'pending',
          start: point,
          hit,
          additive: false,
          editTextAt: { clientX: event.clientX, clientY: event.clientY },
        };
        return;
      }
      if (additive) {
        onSelectionChange(
          selectedIds.includes(hit)
            ? selectedIds.filter((id) => id !== hit)
            : [...selectedIds, hit],
        );
        gestureRef.current = { kind: 'none' };
        return;
      }
      if (!selectedIds.includes(hit)) onSelectionChange([hit]);
      gestureRef.current = { kind: 'pending', start: point, hit, additive: false };
      return;
    }
    if (!additive) onSelectionChange([]);
    gestureRef.current = {
      kind: 'marquee',
      start: point,
      current: point,
      additive,
      base: additive ? selectedIds : [],
    };
  };

  const onPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const gesture = gestureRef.current;
    if (gesture.kind === 'none') return;
    if (gesture.kind === 'pan') {
      const scroller = scrollRef.current!;
      scroller.scrollLeft = gesture.scrollLeft - (event.clientX - gesture.clientX);
      scroller.scrollTop = gesture.scrollTop - (event.clientY - gesture.clientY);
      return;
    }
    const point = toSlide(event.clientX, event.clientY);
    if (gesture.kind === 'pending') {
      const moved =
        Math.hypot(point.x - gesture.start.x, point.y - gesture.start.y) / unitsPerScreenPx;
      if (moved < DRAG_THRESHOLD_PX) return;
      if (readOnly || geometry.slide.elements[gesture.hit]?.locked) {
        gestureRef.current = { kind: 'none' };
        return;
      }
      const ids = selectedIds.includes(gesture.hit) ? selectedIds : [gesture.hit];
      gestureRef.current = { kind: 'move', start: gesture.start, ids };
      return onPointerMove(event);
    }
    if (gesture.kind === 'move') {
      let dx = point.x - gesture.start.x;
      let dy = point.y - gesture.start.y;
      let guides: SnapGuide[] = [];
      if (!event.altKey && (options.snapToObjects || options.grid > 0)) {
        const snapped = snapMove(
          geometry,
          gesture.ids,
          dx,
          dy,
          options.snapToObjects ? SNAP_PX * unitsPerScreenPx : 0,
          options.grid,
        );
        dx = snapped.dx;
        dy = snapped.dy;
        guides = snapped.guides;
      }
      setPreview({
        updaters: moveSelection(geometry, gesture.ids, Math.round(dx), Math.round(dy)),
        guides,
      });
      return;
    }
    if (gesture.kind === 'resize') {
      const delta = { x: point.x - gesture.start.x, y: point.y - gesture.start.y };
      setPreview({
        updaters: resizeSelection(geometry, gesture.ids, gesture.handle, delta, event.shiftKey),
        guides: [],
      });
      return;
    }
    if (gesture.kind === 'endpoint') {
      setPreview({
        updaters: moveLineEndpoint(geometry, gesture.id, gesture.end, point, {
          constrain: event.shiftKey,
          grid: event.altKey ? 0 : options.grid,
        }),
        guides: [],
      });
      return;
    }
    if (gesture.kind === 'crop') {
      const delta = { x: point.x - gesture.start.x, y: point.y - gesture.start.y };
      setPreview({
        updaters: cropImage(geometry, gesture.id, gesture.handle, delta),
        guides: [],
      });
      return;
    }
    if (gesture.kind === 'rotate') {
      const angle = Math.atan2(point.y - gesture.centre.y, point.x - gesture.centre.x);
      let delta = Math.round(((angle - gesture.startAngle) * 18_000) / Math.PI);
      if (event.shiftKey) delta = Math.round(delta / ROTATE_STEP) * ROTATE_STEP;
      setPreview({ updaters: rotateSelection(geometry, gesture.ids, delta), guides: [] });
      return;
    }
    if (gesture.kind === 'marquee') {
      gesture.current = point;
      setMarquee({
        minX: Math.min(gesture.start.x, point.x),
        minY: Math.min(gesture.start.y, point.y),
        maxX: Math.max(gesture.start.x, point.x),
        maxY: Math.max(gesture.start.y, point.y),
      });
    }
  };

  const finish = (commit: boolean) => {
    const gesture = gestureRef.current;
    gestureRef.current = { kind: 'none' };
    if (gesture.kind === 'pending' && commit && gesture.editTextAt && onEditText) {
      onEditText(gesture.hit, gesture.editTextAt);
      return;
    }
    if (gesture.kind === 'marquee') {
      const rect = marquee;
      setMarquee(null);
      if (commit && rect) {
        const hits = marqueeSelect(geometry, rect);
        onSelectionChange([...new Set([...gesture.base, ...hits])]);
      }
      return;
    }
    const pending = previewRef.current;
    setPreview(null);
    if (!commit || !pending || Object.keys(pending.updaters).length === 0) return;
    const label =
      gesture.kind === 'move'
        ? 'Move'
        : gesture.kind === 'resize'
          ? 'Resize'
          : gesture.kind === 'rotate'
            ? 'Rotate'
            : gesture.kind === 'crop'
              ? 'Crop'
              : gesture.kind === 'endpoint'
                ? 'Move line end'
                : 'Edit';
    onCommit(pending.updaters, label);
  };

  const onWheel = (event: React.WheelEvent<HTMLDivElement>) => {
    if (!event.ctrlKey && !event.metaKey) return;
    event.preventDefault();
    onZoom(zoom * (event.deltaY < 0 ? 1.1 : 1 / 1.1), {
      clientX: event.clientX,
      clientY: event.clientY,
    });
  };

  // Keep the anchor point under the pointer when zooming with the wheel.
  const zoomAnchor = useRef<{
    x: number;
    y: number;
    clientX: number;
    clientY: number;
    zoom: number;
  } | null>(null);
  useLayoutEffect(() => {
    const anchor = zoomAnchor.current;
    const scroller = scrollRef.current;
    const slide = slideRef.current;
    if (!anchor || !scroller || !slide || anchor.zoom === zoom) return;
    const rect = slide.getBoundingClientRect();
    scroller.scrollLeft += rect.left + toScreen(anchor.x, zoom) - anchor.clientX;
    scroller.scrollTop += rect.top + toScreen(anchor.y, zoom) - anchor.clientY;
    zoomAnchor.current = null;
  }, [zoom]);
  const wheelZoom = (event: React.WheelEvent<HTMLDivElement>) => {
    if (event.ctrlKey || event.metaKey) {
      const point = toSlide(event.clientX, event.clientY);
      zoomAnchor.current = { ...point, clientX: event.clientX, clientY: event.clientY, zoom };
    }
    onWheel(event);
  };

  const shape = selectedIds.length > 0 ? selectionShape(shownGeometry, selectedIds, zoom) : null;
  const selectedLine =
    selectedIds.length === 1 ? shownGeometry.slide.elements[selectedIds[0]] : undefined;
  const lineEnds = selectedLine?.type === 'line' ? selectedLine : null;
  // A line is edited by its two ends, not by a box.
  const handlesVisible = shape && !readOnly && !locked && !editing && !lineEnds;
  const cropHandlesVisible = Boolean(handlesVisible && cropTarget);
  const rotateHandle = shape
    ? (() => {
        const top = along(shape.corners, 0.5, 0);
        const bottom = along(shape.corners, 0.5, 1);
        const length = Math.hypot(top.x - bottom.x, top.y - bottom.y) || 1;
        return {
          x: top.x + ((top.x - bottom.x) / length) * ROTATE_OFFSET_PX,
          y: top.y + ((top.y - bottom.y) / length) * ROTATE_OFFSET_PX,
          from: top,
        };
      })()
    : null;

  return (
    <div className="relative h-full w-full overflow-hidden bg-muted/30" data-testid="deck-stage">
      {options.showRulers && (
        <>
          <div className="absolute left-0 top-0 z-20 h-5 w-5 border-b border-r border-border/50 bg-card" />
          <div className="absolute left-5 right-0 top-0 z-20 h-5 overflow-hidden border-b border-border/50 bg-card">
            <div style={{ transform: `translateX(${originX}px)` }}>
              <Ruler axis="x" length={deck.size.width} zoom={zoom} />
            </div>
          </div>
          <div className="absolute bottom-0 left-0 top-5 z-20 w-5 overflow-hidden border-r border-border/50 bg-card">
            <div style={{ transform: `translateY(${originY}px)` }}>
              <Ruler axis="y" length={deck.size.height} zoom={zoom} />
            </div>
          </div>
        </>
      )}
      <div
        ref={scrollRef}
        className="absolute overflow-auto"
        style={{ left: rulers, top: rulers, right: 0, bottom: 0 }}
        onScroll={(event) =>
          setScroll({ left: event.currentTarget.scrollLeft, top: event.currentTarget.scrollTop })
        }
        onWheel={wheelZoom}
        onKeyDown={(event) => event.key === ' ' && setSpaceHeld(true)}
        onKeyUp={(event) => event.key === ' ' && setSpaceHeld(false)}
      >
        <div
          className="relative"
          style={{
            width: slideWidthPx + MARGIN_PX * 2,
            height: slideHeightPx + MARGIN_PX * 2,
            minWidth: '100%',
            minHeight: '100%',
          }}
        >
          <div
            ref={slideRef}
            className="absolute"
            style={{ left: MARGIN_PX, top: MARGIN_PX, width: slideWidthPx, height: slideHeightPx }}
          >
            <div
              key={transitionPreview?.key}
              className={
                transitionPreview
                  ? `size-full deck-playback-${transitionPreview.transition.kind}`
                  : 'size-full'
              }
              style={
                transitionPreview
                  ? ({
                      '--deck-transition-duration': `${transitionPreview.transition.durationMs}ms`,
                    } as React.CSSProperties)
                  : undefined
              }
            >
              <DeckSlide
                slide={shownSlide}
                width={slideWidthPx}
                measurer={measurer}
                resolveAsset={resolveAsset}
                className="overflow-hidden shadow-lg shadow-black/20"
                label={`Slide ${resolved.number}`}
              />
            </div>
            {options.grid > 0 && (
              <svg
                className="pointer-events-none absolute inset-0"
                width={slideWidthPx}
                height={slideHeightPx}
                aria-hidden
              >
                <defs>
                  <pattern
                    id={`deck-grid-${slideId}`}
                    width={toScreen(options.grid, zoom)}
                    height={toScreen(options.grid, zoom)}
                    patternUnits="userSpaceOnUse"
                  >
                    <path
                      d={`M ${toScreen(options.grid, zoom)} 0 L 0 0 0 ${toScreen(options.grid, zoom)}`}
                      fill="none"
                      stroke="currentColor"
                      strokeWidth={0.5}
                      className="text-primary/25"
                    />
                  </pattern>
                </defs>
                <rect width="100%" height="100%" fill={`url(#deck-grid-${slideId})`} />
              </svg>
            )}
          </div>

          {editing &&
            (() => {
              const frame = shownGeometry.frames.get(editing.id);
              if (!frame) return null;
              const box = editing.rect ?? frame;
              // A cell turns with its table, about the table's centre.
              const originX = toScreen(frame.x + frame.width / 2 - box.x, zoom);
              const originY = toScreen(frame.y + frame.height / 2 - box.y, zoom);
              return (
                <div
                  className="absolute z-20"
                  style={{
                    left: MARGIN_PX + toScreen(box.x, zoom),
                    top: MARGIN_PX + toScreen(box.y, zoom),
                    width: toScreen(box.width, zoom),
                    height: toScreen(box.height, zoom),
                    transform: frame.rotation ? `rotate(${frame.rotation / 100}deg)` : undefined,
                    transformOrigin: `${originX}px ${originY}px`,
                  }}
                  data-testid="deck-text-editing"
                >
                  {editing.content}
                </div>
              );
            })()}

          {/* Interaction layer: covers the margins too, so marquee can start off-slide. */}
          <div
            className="absolute inset-0 z-10"
            style={{ cursor: spaceHeld ? 'grab' : 'default', touchAction: 'none' }}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={() => finish(true)}
            onPointerCancel={() => finish(false)}
            onLostPointerCapture={() => finish(true)}
            onContextMenu={onContextMenu}
            onDragOver={(event) => {
              if (onDropFiles && !readOnly && event.dataTransfer.types.includes('Files')) {
                event.preventDefault();
                event.dataTransfer.dropEffect = 'copy';
              }
            }}
            onDrop={(event) => {
              const files = Array.from(event.dataTransfer.files ?? []);
              if (!onDropFiles || readOnly || files.length === 0) return;
              event.preventDefault();
              onDropFiles(files, toSlide(event.clientX, event.clientY));
            }}
            onDoubleClick={onDoubleClick}
            data-testid="deck-stage-surface"
          >
            <svg
              className="pointer-events-none absolute overflow-visible"
              style={{ left: MARGIN_PX, top: MARGIN_PX }}
              width={slideWidthPx}
              height={slideHeightPx}
            >
              {shownSlide.items.map((item) =>
                item.kind === 'shape' && item.prompt && item.id !== editing?.id ? (
                  <polygon
                    key={`prompt-${item.id}`}
                    points={frameCorners(item.frame)
                      .map((c) => `${toScreen(c.x, zoom)},${toScreen(c.y, zoom)}`)
                      .join(' ')}
                    fill="none"
                    className="stroke-muted-foreground/60"
                    strokeWidth={1}
                    strokeDasharray="3 3"
                    data-testid="deck-placeholder-outline"
                  />
                ) : null,
              )}
              {preview?.guides.map((guide) =>
                guide.axis === 'x' ? (
                  <line
                    key={`x${guide.at}`}
                    x1={toScreen(guide.at, zoom)}
                    x2={toScreen(guide.at, zoom)}
                    y1={-MARGIN_PX}
                    y2={slideHeightPx + MARGIN_PX}
                    className="stroke-pink-500"
                    strokeWidth={1}
                    strokeDasharray="4 3"
                  />
                ) : (
                  <line
                    key={`y${guide.at}`}
                    y1={toScreen(guide.at, zoom)}
                    y2={toScreen(guide.at, zoom)}
                    x1={-MARGIN_PX}
                    x2={slideWidthPx + MARGIN_PX}
                    className="stroke-pink-500"
                    strokeWidth={1}
                    strokeDasharray="4 3"
                  />
                ),
              )}
              {selectedIds.length > 1 &&
                selectedIds.map((id) => {
                  const frame = shownGeometry.frames.get(id);
                  if (!frame) return null;
                  const corners = frameCorners(frame).map(
                    (c) => `${toScreen(c.x, zoom)},${toScreen(c.y, zoom)}`,
                  );
                  return (
                    <polygon
                      key={id}
                      points={corners.join(' ')}
                      fill="none"
                      className="stroke-primary/50"
                      strokeWidth={1}
                    />
                  );
                })}
              {peers?.map((peer) =>
                peer.ids.map((id, index) => {
                  const frame = shownGeometry.frames.get(id);
                  if (!frame) return null;
                  const corners = frameCorners(frame).map((c) => ({
                    x: toScreen(c.x, zoom),
                    y: toScreen(c.y, zoom),
                  }));
                  const top = corners.reduce((best, c) => (c.y < best.y ? c : best), corners[0]);
                  const label =
                    peer.typingId === id ? `${peer.name} is typing` : index === 0 ? peer.name : '';
                  return (
                    <g key={`${peer.key}:${id}`} data-testid="deck-peer-selection">
                      <polygon
                        points={corners.map((c) => `${c.x},${c.y}`).join(' ')}
                        fill="none"
                        stroke={peer.color}
                        strokeWidth={2}
                        strokeDasharray={peer.typingId === id ? '6 3' : undefined}
                      />
                      {label && (
                        <g transform={`translate(${top.x} ${top.y - 16})`}>
                          <rect
                            width={label.length * 6.2 + 10}
                            height={15}
                            rx={3}
                            fill={peer.color}
                          />
                          <text x={5} y={11} fontSize={10} fill="#fff">
                            {label}
                          </text>
                        </g>
                      )}
                    </g>
                  );
                }),
              )}
              {shape && (
                <polygon
                  points={shape.corners.map((corner) => `${corner.x},${corner.y}`).join(' ')}
                  fill="none"
                  className={locked ? 'stroke-muted-foreground' : 'stroke-primary'}
                  strokeWidth={1.5}
                  strokeDasharray={locked ? '4 3' : undefined}
                  data-testid="deck-selection"
                />
              )}
              {marquee && (
                <rect
                  x={toScreen(marquee.minX, zoom)}
                  y={toScreen(marquee.minY, zoom)}
                  width={toScreen(marquee.maxX - marquee.minX, zoom)}
                  height={toScreen(marquee.maxY - marquee.minY, zoom)}
                  className="fill-primary/10 stroke-primary"
                  strokeWidth={1}
                  strokeDasharray="4 3"
                  data-testid="deck-marquee"
                />
              )}
            </svg>
            {lineEnds && !readOnly && !locked && !editing && (
              <div
                className="pointer-events-none absolute"
                style={{
                  left: MARGIN_PX,
                  top: MARGIN_PX,
                  width: slideWidthPx,
                  height: slideHeightPx,
                }}
              >
                {(['from', 'to'] as const).map((end) => (
                  <div
                    key={end}
                    data-endpoint={end}
                    aria-label={end === 'from' ? 'Line start' : 'Line end'}
                    className="pointer-events-auto absolute rounded-full border border-primary bg-background"
                    style={{
                      left: toScreen(lineEnds[end].x, zoom) - HANDLE_PX / 2 - 1,
                      top: toScreen(lineEnds[end].y, zoom) - HANDLE_PX / 2 - 1,
                      width: HANDLE_PX + 2,
                      height: HANDLE_PX + 2,
                      cursor: 'crosshair',
                    }}
                  />
                ))}
              </div>
            )}
            {handlesVisible && shape && rotateHandle && (
              <div
                className="pointer-events-none absolute"
                style={{
                  left: MARGIN_PX,
                  top: MARGIN_PX,
                  width: slideWidthPx,
                  height: slideHeightPx,
                }}
              >
                <svg
                  className="pointer-events-none absolute overflow-visible"
                  width={slideWidthPx}
                  height={slideHeightPx}
                >
                  <line
                    visibility={cropHandlesVisible ? 'hidden' : undefined}
                    x1={rotateHandle.from.x}
                    y1={rotateHandle.from.y}
                    x2={rotateHandle.x}
                    y2={rotateHandle.y}
                    className="stroke-primary"
                    strokeWidth={1}
                  />
                </svg>
                {cropHandlesVisible &&
                  CROP_HANDLES.map(({ handle, at, cursor }) => {
                    const point = along(shape.corners, at[0], at[1]);
                    // Bars lie along their edge, which turns with the image.
                    const [a, b] = at[0] === 0.5 ? [0, 1] : [1, 2];
                    const edge = Math.atan2(
                      shape.corners[b].y - shape.corners[a].y,
                      shape.corners[b].x - shape.corners[a].x,
                    );
                    const angle = (edge * 180) / Math.PI;
                    return (
                      <div
                        key={handle}
                        data-crop-handle={handle}
                        aria-label={`Crop ${handle}`}
                        className="pointer-events-auto absolute rounded-[1px] bg-foreground ring-1 ring-background"
                        style={{
                          left: point.x - CROP_BAR_PX / 2,
                          top: point.y - HANDLE_PX / 4,
                          width: CROP_BAR_PX,
                          height: HANDLE_PX / 2,
                          transform: `rotate(${angle}deg)`,
                          cursor,
                        }}
                      />
                    );
                  })}
                {!cropHandlesVisible &&
                  HANDLES.map(({ handle, at, cursor }) => {
                    const point = along(shape.corners, at[0], at[1]);
                    return (
                      <div
                        key={handle}
                        data-handle={handle}
                        aria-label={`Resize ${handle}`}
                        className="pointer-events-auto absolute rounded-[2px] border border-primary bg-background"
                        style={{
                          left: point.x - HANDLE_PX / 2,
                          top: point.y - HANDLE_PX / 2,
                          width: HANDLE_PX,
                          height: HANDLE_PX,
                          cursor,
                        }}
                      />
                    );
                  })}
                {!cropHandlesVisible && (
                  <div
                    data-handle="rotate"
                    aria-label="Rotate"
                    className="pointer-events-auto absolute rounded-full border border-primary bg-background"
                    style={{
                      left: rotateHandle.x - HANDLE_PX / 2,
                      top: rotateHandle.y - HANDLE_PX / 2,
                      width: HANDLE_PX,
                      height: HANDLE_PX,
                      cursor: 'grab',
                    }}
                  />
                )}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
