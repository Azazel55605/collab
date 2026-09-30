/**
 * Slide geometry for editing: frames, hit testing, transforms, snapping, and
 * alignment.
 *
 * Framework-free and in deck units throughout. Frames come from the shared
 * resolver, so a placeholder that inherits its geometry from a layout is hit
 * and transformed exactly where it is drawn; the first transform writes that
 * geometry into the element as an explicit override. Every value written back
 * is rounded to an integer, as the schema requires.
 */
import { DECK_ROTATION_FULL_TURN, DECK_UNITS_PER_POINT } from '../../types/deck';
import type { DeckDocument, DeckElement, DeckElementContainer, DeckFrame } from '../../types/deck';

import { expandGroups } from './operations';
import { resolveTarget } from './resolve';
import type { DeckTarget } from './resolve';
import { normalizeRotation } from './units';

export type Frame = Required<DeckFrame>;
export interface Point {
  x: number;
  y: number;
}
export interface Bounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export type ResizeHandle = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw';

/** The smallest a resize may make an element: one point. */
export const MIN_ELEMENT_SIZE = DECK_UNITS_PER_POINT;

export interface SlideGeometry {
  /** The slide, layout, or master being edited. */
  slide: DeckElementContainer;
  /** Effective frame of every visible element, groups included. */
  frames: Map<string, Frame>;
  /** Top-level ids in paint order, back to front. */
  order: string[];
  /** Child → parent group. */
  parents: Map<string, string>;
  width: number;
  height: number;
}

const toRadians = (rotation: number) => (rotation / DECK_ROTATION_FULL_TURN) * Math.PI * 2;

export function frameCenter(frame: Frame): Point {
  return { x: frame.x + frame.width / 2, y: frame.y + frame.height / 2 };
}

/** The four corners of a frame after rotation about its centre. */
export function frameCorners(frame: Frame): Point[] {
  const centre = frameCenter(frame);
  const angle = toRadians(frame.rotation);
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  return [
    [frame.x, frame.y],
    [frame.x + frame.width, frame.y],
    [frame.x + frame.width, frame.y + frame.height],
    [frame.x, frame.y + frame.height],
  ].map(([x, y]) => ({
    x: centre.x + (x - centre.x) * cos - (y - centre.y) * sin,
    y: centre.y + (x - centre.x) * sin + (y - centre.y) * cos,
  }));
}

export function boundsOfFrames(frames: Iterable<Frame>): Bounds | null {
  let bounds: Bounds | null = null;
  for (const frame of frames) {
    for (const corner of frameCorners(frame)) {
      bounds = bounds
        ? {
            minX: Math.min(bounds.minX, corner.x),
            minY: Math.min(bounds.minY, corner.y),
            maxX: Math.max(bounds.maxX, corner.x),
            maxY: Math.max(bounds.maxY, corner.y),
          }
        : { minX: corner.x, minY: corner.y, maxX: corner.x, maxY: corner.y };
    }
  }
  return bounds;
}

function boundsFrame(bounds: Bounds): Frame {
  return {
    x: bounds.minX,
    y: bounds.minY,
    width: bounds.maxX - bounds.minX,
    height: bounds.maxY - bounds.minY,
    rotation: 0,
    flipH: false,
    flipV: false,
  };
}

/** Frames for every visible element of a slide, from the shared resolver. */
export function slideGeometry(deck: DeckDocument, slideId: string): SlideGeometry {
  return targetGeometry(deck, { kind: 'slide', id: slideId });
}

/** The container a target names. */
export function targetContainer(deck: DeckDocument, target: DeckTarget): DeckElementContainer {
  const container =
    target.kind === 'slide'
      ? deck.slides[target.id]
      : target.kind === 'layout'
        ? deck.layouts[target.id]
        : deck.masters[target.id];
  if (!container) throw new Error(`The ${target.kind} ${target.id} does not exist.`);
  return container;
}

/**
 * Frames for every visible element of a slide, layout, or master. Only the
 * target's own elements are editable; inherited master artwork is not.
 */
export function targetGeometry(deck: DeckDocument, target: DeckTarget): SlideGeometry {
  const slide = targetContainer(deck, target);
  const resolved = resolveTarget(deck, target);
  const frames = new Map<string, Frame>();
  for (const item of resolved.items) {
    if (item.origin === target.kind) frames.set(item.id, item.frame);
  }
  const parents = new Map<string, string>();
  for (const element of Object.values(slide.elements)) {
    if (element.type === 'group')
      for (const child of element.childIds) parents.set(child, element.id);
  }
  // Groups are not painted, so their frame is the union of their children,
  // computed bottom-up so nested groups resolve.
  const groupFrame = (id: string, depth = 0): Frame | null => {
    const element = slide.elements[id];
    if (!element || element.type !== 'group' || depth > 16) return frames.get(id) ?? null;
    const children = element.childIds
      .map((child) => groupFrame(child, depth + 1))
      .filter((frame): frame is Frame => frame !== null);
    const bounds = boundsOfFrames(children);
    if (!bounds) return null;
    const frame = boundsFrame(bounds);
    frames.set(id, frame);
    return frame;
  };
  for (const element of Object.values(slide.elements))
    if (element.type === 'group') groupFrame(element.id);
  return {
    slide,
    frames,
    order: slide.elementOrder.filter((id) => frames.has(id)),
    parents,
    width: deck.size.width,
    height: deck.size.height,
  };
}

/* ------------------------------------------------------------------------- */
/* Hit testing                                                                */
/* ------------------------------------------------------------------------- */

export function pointInFrame(frame: Frame, point: Point, slop = 0): boolean {
  const centre = frameCenter(frame);
  const angle = -toRadians(frame.rotation);
  const dx = point.x - centre.x;
  const dy = point.y - centre.y;
  const localX = dx * Math.cos(angle) - dy * Math.sin(angle);
  const localY = dx * Math.sin(angle) + dy * Math.cos(angle);
  return Math.abs(localX) <= frame.width / 2 + slop && Math.abs(localY) <= frame.height / 2 + slop;
}

function distanceToSegment(point: Point, a: Point, b: Point): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lengthSquared = dx * dx + dy * dy;
  const t =
    lengthSquared === 0
      ? 0
      : Math.max(0, Math.min(1, ((point.x - a.x) * dx + (point.y - a.y) * dy) / lengthSquared));
  return Math.hypot(point.x - (a.x + t * dx), point.y - (a.y + t * dy));
}

function hitsElement(geometry: SlideGeometry, id: string, point: Point, slop: number): boolean {
  const element = geometry.slide.elements[id];
  if (!element || element.hidden) return false;
  if (element.type === 'group')
    return element.childIds.some((child) => hitsElement(geometry, child, point, slop));
  if (element.type === 'line') {
    return distanceToSegment(point, element.from, element.to) <= element.line.width / 2 + slop;
  }
  const frame = geometry.frames.get(id);
  return frame ? pointInFrame(frame, point, slop) : false;
}

/** The topmost top-level element under a point, or null. `slop` is in deck units. */
export function hitTest(geometry: SlideGeometry, point: Point, slop = 0): string | null {
  for (let index = geometry.order.length - 1; index >= 0; index -= 1) {
    const id = geometry.order[index];
    if (hitsElement(geometry, id, point, slop)) return id;
  }
  return null;
}

/** Top-level elements lying entirely inside a rectangle, in paint order. */
export function marqueeSelect(geometry: SlideGeometry, rect: Bounds): string[] {
  return geometry.order.filter((id) => {
    const bounds = boundsOfFrames([geometry.frames.get(id)!]);
    return (
      bounds !== null &&
      bounds.minX >= rect.minX &&
      bounds.maxX <= rect.maxX &&
      bounds.minY >= rect.minY &&
      bounds.maxY <= rect.maxY
    );
  });
}

/** Axis-aligned bounds of a selection. */
export function selectionBounds(geometry: SlideGeometry, ids: string[]): Bounds | null {
  return boundsOfFrames(
    ids.map((id) => geometry.frames.get(id)).filter((frame): frame is Frame => !!frame),
  );
}

/* ------------------------------------------------------------------------- */
/* Transforms                                                                 */
/* ------------------------------------------------------------------------- */

export type ElementUpdaters = Record<string, (element: DeckElement) => DeckElement>;

const round = Math.round;

function frameUpdate(frame: Frame): (element: DeckElement) => DeckElement {
  return (element) => ({
    ...element,
    frame: {
      x: round(frame.x),
      y: round(frame.y),
      width: Math.max(0, round(frame.width)),
      height: Math.max(0, round(frame.height)),
      ...(normalizeRotation(frame.rotation) ? { rotation: normalizeRotation(frame.rotation) } : {}),
      ...(frame.flipH ? { flipH: true } : {}),
      ...(frame.flipV ? { flipV: true } : {}),
    },
  });
}

/**
 * Applies a point mapping to every element in a selection (groups expanded).
 * Frames move by their centre, scale their size by `scale`, and turn by
 * `rotate`; lines map both endpoints. Group frames are then recomputed from
 * their transformed children, deepest first, so a group always encloses what
 * it holds. This one function carries moves, multi-element resizes, and
 * rotations.
 */
function mapSelection(
  geometry: SlideGeometry,
  ids: string[],
  mapPoint: (point: Point) => Point,
  scale: { x: number; y: number },
  rotate: number,
): ElementUpdaters {
  const updaters: ElementUpdaters = {};
  const mapped = new Map<string, Frame>();
  const groups: string[] = [];
  for (const id of expandGroups(geometry.slide, ids)) {
    const element = geometry.slide.elements[id];
    if (element.type === 'group') {
      groups.push(id);
      continue;
    }
    if (element.type === 'line') {
      const from = mapPoint(element.from);
      const to = mapPoint(element.to);
      updaters[id] = (current) => ({
        ...current,
        from: { x: round(from.x), y: round(from.y) },
        to: { x: round(to.x), y: round(to.y) },
      });
      mapped.set(id, {
        x: Math.min(from.x, to.x),
        y: Math.min(from.y, to.y),
        width: Math.abs(to.x - from.x),
        height: Math.abs(to.y - from.y),
        rotation: 0,
        flipH: false,
        flipV: false,
      });
      continue;
    }
    const frame = geometry.frames.get(id);
    if (!frame) continue;
    const centre = mapPoint(frameCenter(frame));
    const width = Math.max(MIN_ELEMENT_SIZE, frame.width * scale.x);
    const height = Math.max(MIN_ELEMENT_SIZE, frame.height * scale.y);
    const next = {
      ...frame,
      x: centre.x - width / 2,
      y: centre.y - height / 2,
      width,
      height,
      rotation: frame.rotation + rotate,
    };
    mapped.set(id, next);
    updaters[id] = frameUpdate(next);
  }

  const depth = (id: string) => {
    let count = 0;
    for (let current = id; geometry.parents.has(current) && count < 32; count += 1) {
      current = geometry.parents.get(current)!;
    }
    return count;
  };
  groups.sort((left, right) => depth(right) - depth(left));
  for (const id of groups) {
    const element = geometry.slide.elements[id];
    if (element.type !== 'group') continue;
    const bounds = boundsOfFrames(
      element.childIds.map((child) => mapped.get(child)).filter((frame): frame is Frame => !!frame),
    );
    if (!bounds) continue;
    const frame = boundsFrame(bounds);
    mapped.set(id, frame);
    updaters[id] = frameUpdate(frame);
  }
  return updaters;
}

export function moveSelection(
  geometry: SlideGeometry,
  ids: string[],
  dx: number,
  dy: number,
): ElementUpdaters {
  return mapSelection(
    geometry,
    ids,
    (point) => ({ x: point.x + dx, y: point.y + dy }),
    { x: 1, y: 1 },
    0,
  );
}

/**
 * Resizes one ungrouped element in its own rotated frame: the edge opposite
 * the handle stays fixed on screen. `delta` is the pointer movement in slide
 * coordinates. `keepAspect` preserves the proportions (Shift).
 */
export function resizeFrame(
  frame: Frame,
  handle: ResizeHandle,
  delta: Point,
  keepAspect: boolean,
): Frame {
  const angle = toRadians(frame.rotation);
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  // Pointer movement in the element's local axes.
  let localX = delta.x * cos + delta.y * sin;
  let localY = -delta.x * sin + delta.y * cos;
  const horizontal = handle.includes('e') ? 1 : handle.includes('w') ? -1 : 0;
  const vertical = handle.includes('s') ? 1 : handle.includes('n') ? -1 : 0;
  if (horizontal === 0) localX = 0;
  if (vertical === 0) localY = 0;

  let width = Math.max(MIN_ELEMENT_SIZE, frame.width + horizontal * localX);
  let height = Math.max(MIN_ELEMENT_SIZE, frame.height + vertical * localY);
  if (keepAspect && frame.width > 0 && frame.height > 0) {
    const ratio = frame.width / frame.height;
    if (horizontal !== 0 && vertical !== 0) {
      if (width / frame.width > height / frame.height) height = width / ratio;
      else width = height * ratio;
    } else if (horizontal !== 0) {
      height = width / ratio;
    } else {
      width = height * ratio;
    }
  }
  // Keep the opposite edge (or the centre, for the free axis) in place.
  const shiftX = horizontal === 0 ? 0 : (horizontal * (width - frame.width)) / 2;
  const shiftY = vertical === 0 ? 0 : (vertical * (height - frame.height)) / 2;
  const centre = frameCenter(frame);
  const nextCentre = {
    x: centre.x + shiftX * cos - shiftY * sin,
    y: centre.y + shiftX * sin + shiftY * cos,
  };
  return { ...frame, x: nextCentre.x - width / 2, y: nextCentre.y - height / 2, width, height };
}

/**
 * Resizes a selection. One ungrouped element resizes in its own rotated frame;
 * anything else scales about the selection's axis-aligned bounds, with the
 * edge opposite the handle as the anchor.
 */
export function resizeSelection(
  geometry: SlideGeometry,
  ids: string[],
  handle: ResizeHandle,
  delta: Point,
  keepAspect: boolean,
): ElementUpdaters {
  if (ids.length === 1) {
    const element = geometry.slide.elements[ids[0]];
    const frame = geometry.frames.get(ids[0]);
    if (element && frame && element.type !== 'group' && element.type !== 'line') {
      return { [ids[0]]: frameUpdate(resizeFrame(frame, handle, delta, keepAspect)) };
    }
  }
  const bounds = selectionBounds(geometry, ids);
  if (!bounds) return {};
  const box = boundsFrame(bounds);
  const next = resizeFrame(box, handle, delta, keepAspect);
  const scaleX = box.width > 0 ? next.width / box.width : 1;
  const scaleY = box.height > 0 ? next.height / box.height : 1;
  return mapSelection(
    geometry,
    ids,
    (point) => ({
      x: next.x + (point.x - box.x) * scaleX,
      y: next.y + (point.y - box.y) * scaleY,
    }),
    { x: scaleX, y: scaleY },
    0,
  );
}

/** Rotates a selection by `delta` hundredths of a degree about its centre. */
export function rotateSelection(
  geometry: SlideGeometry,
  ids: string[],
  delta: number,
): ElementUpdaters {
  const bounds = selectionBounds(geometry, ids);
  if (!bounds) return {};
  const centre = { x: (bounds.minX + bounds.maxX) / 2, y: (bounds.minY + bounds.maxY) / 2 };
  const angle = toRadians(delta);
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  return mapSelection(
    geometry,
    ids,
    (point) => ({
      x: centre.x + (point.x - centre.x) * cos - (point.y - centre.y) * sin,
      y: centre.y + (point.x - centre.x) * sin + (point.y - centre.y) * cos,
    }),
    { x: 1, y: 1 },
    delta,
  );
}

/* ------------------------------------------------------------------------- */
/* Snapping                                                                   */
/* ------------------------------------------------------------------------- */

export interface SnapGuide {
  axis: 'x' | 'y';
  /** Position of the guide line in deck units. */
  at: number;
}

export interface SnapResult {
  dx: number;
  dy: number;
  guides: SnapGuide[];
}

/**
 * Snaps a moving selection to the slide's edges and centre lines and to the
 * edges and centres of every other top-level element. `threshold` is in deck
 * units, so callers pass a screen distance divided by the zoom.
 */
export function snapMove(
  geometry: SlideGeometry,
  movingIds: string[],
  dx: number,
  dy: number,
  threshold: number,
  grid = 0,
): SnapResult {
  const bounds = selectionBounds(geometry, movingIds);
  if (!bounds) return { dx, dy, guides: [] };
  const moving = new Set(movingIds);
  const xs = [0, geometry.width / 2, geometry.width];
  const ys = [0, geometry.height / 2, geometry.height];
  for (const id of geometry.order) {
    if (moving.has(id)) continue;
    const other = boundsOfFrames([geometry.frames.get(id)!]);
    if (!other) continue;
    xs.push(other.minX, (other.minX + other.maxX) / 2, other.maxX);
    ys.push(other.minY, (other.minY + other.maxY) / 2, other.maxY);
  }

  const snapAxis = (min: number, max: number, delta: number, targets: number[]) => {
    const edges = [min + delta, (min + max) / 2 + delta, max + delta];
    let best: { offset: number; at: number } | null = null;
    for (const edge of edges) {
      for (const target of targets) {
        const offset = target - edge;
        if (Math.abs(offset) <= threshold && (!best || Math.abs(offset) < Math.abs(best.offset))) {
          best = { offset, at: target };
        }
      }
    }
    if (best) return { delta: delta + best.offset, at: best.at as number | null };
    if (grid > 0) return { delta: Math.round((min + delta) / grid) * grid - min, at: null };
    return { delta, at: null };
  };

  const x = snapAxis(bounds.minX, bounds.maxX, dx, xs);
  const y = snapAxis(bounds.minY, bounds.maxY, dy, ys);
  const guides: SnapGuide[] = [];
  if (x.at !== null) guides.push({ axis: 'x', at: x.at });
  if (y.at !== null) guides.push({ axis: 'y', at: y.at });
  return { dx: Math.round(x.delta), dy: Math.round(y.delta), guides };
}

/* ------------------------------------------------------------------------- */
/* Align and distribute                                                       */
/* ------------------------------------------------------------------------- */

export type DeckAlignment = 'left' | 'center' | 'right' | 'top' | 'middle' | 'bottom';

/**
 * Aligns top-level elements. With one element, or when `toSlide` is set, it
 * aligns to the slide; otherwise to the selection's bounds.
 */
export function alignSelection(
  geometry: SlideGeometry,
  ids: string[],
  alignment: DeckAlignment,
  toSlide = ids.length < 2,
): ElementUpdaters {
  const reference = toSlide
    ? { minX: 0, minY: 0, maxX: geometry.width, maxY: geometry.height }
    : selectionBounds(geometry, ids);
  if (!reference) return {};
  const updaters: ElementUpdaters = {};
  for (const id of ids) {
    const bounds = selectionBounds(geometry, [id]);
    if (!bounds) continue;
    let dx = 0;
    let dy = 0;
    if (alignment === 'left') dx = reference.minX - bounds.minX;
    if (alignment === 'right') dx = reference.maxX - bounds.maxX;
    if (alignment === 'center')
      dx = (reference.minX + reference.maxX) / 2 - (bounds.minX + bounds.maxX) / 2;
    if (alignment === 'top') dy = reference.minY - bounds.minY;
    if (alignment === 'bottom') dy = reference.maxY - bounds.maxY;
    if (alignment === 'middle')
      dy = (reference.minY + reference.maxY) / 2 - (bounds.minY + bounds.maxY) / 2;
    Object.assign(updaters, moveSelection(geometry, [id], dx, dy));
  }
  return updaters;
}

/** Spaces three or more top-level elements with equal gaps along one axis. */
export function distributeSelection(
  geometry: SlideGeometry,
  ids: string[],
  axis: 'horizontal' | 'vertical',
): ElementUpdaters {
  const items = ids
    .map((id) => ({ id, bounds: selectionBounds(geometry, [id]) }))
    .filter((item): item is { id: string; bounds: Bounds } => item.bounds !== null);
  if (items.length < 3) return {};
  const [min, max] =
    axis === 'horizontal' ? (['minX', 'maxX'] as const) : (['minY', 'maxY'] as const);
  items.sort((left, right) => left.bounds[min] - right.bounds[min]);
  const span = items[items.length - 1].bounds[max] - items[0].bounds[min];
  const occupied = items.reduce((total, item) => total + (item.bounds[max] - item.bounds[min]), 0);
  const gap = (span - occupied) / (items.length - 1);
  const updaters: ElementUpdaters = {};
  let cursor = items[0].bounds[min];
  for (const item of items) {
    const offset = cursor - item.bounds[min];
    if (Math.round(offset) !== 0) {
      Object.assign(
        updaters,
        moveSelection(
          geometry,
          [item.id],
          axis === 'horizontal' ? offset : 0,
          axis === 'vertical' ? offset : 0,
        ),
      );
    }
    cursor += item.bounds[max] - item.bounds[min] + gap;
  }
  return updaters;
}

/** A frame that encloses a set of elements, for a new group. */
export function groupFrameFor(geometry: SlideGeometry, ids: string[]): DeckFrame | undefined {
  const bounds = selectionBounds(geometry, ids);
  if (!bounds) return undefined;
  return {
    x: Math.round(bounds.minX),
    y: Math.round(bounds.minY),
    width: Math.round(bounds.maxX - bounds.minX),
    height: Math.round(bounds.maxY - bounds.minY),
  };
}

/* ------------------------------------------------------------------------- */
/* Crop                                                                       */
/* ------------------------------------------------------------------------- */

export type CropHandle = 'n' | 's' | 'e' | 'w';

/** The smallest share of an image a crop may leave visible on an axis: 1%. */
const MIN_VISIBLE = 10;

/**
 * Crops an image from one side. The image keeps its scale: dragging a side
 * handle moves that edge of the frame and hides or reveals the same span of
 * the image, never more than the image has.
 */
export function cropImage(
  geometry: SlideGeometry,
  id: string,
  handle: CropHandle,
  delta: Point,
): ElementUpdaters {
  const element = geometry.slide.elements[id];
  const frame = geometry.frames.get(id);
  if (!element || element.type !== 'image' || !frame) return {};
  const crop = element.crop ?? { left: 0, top: 0, right: 0, bottom: 0 };
  const horizontal = handle === 'e' || handle === 'w';
  const size = horizontal ? frame.width : frame.height;
  const [first, second] = horizontal ? [crop.left, crop.right] : [crop.top, crop.bottom];
  const visible = 1_000 - first - second;
  if (visible <= 0 || size <= 0) return {};
  // Deck units the whole image would span at its current scale.
  const full = (size * 1_000) / visible;
  const own =
    handle === 'w'
      ? crop.left
      : handle === 'e'
        ? crop.right
        : handle === 'n'
          ? crop.top
          : crop.bottom;

  // Pointer movement along the handle's outward normal, in local axes.
  const angle = toRadians(frame.rotation);
  const localX = delta.x * Math.cos(angle) + delta.y * Math.sin(angle);
  const localY = -delta.x * Math.sin(angle) + delta.y * Math.cos(angle);
  const outward =
    handle === 'e' ? localX : handle === 'w' ? -localX : handle === 's' ? localY : -localY;
  const grow = Math.max(
    -(size - (full * MIN_VISIBLE) / 1_000),
    Math.min((own / 1_000) * full, outward),
  );
  const nextOwn = Math.max(0, Math.round(own - (grow / full) * 1_000));
  const applied = ((own - nextOwn) / 1_000) * full;

  const localDelta = {
    x: handle === 'e' ? applied : handle === 'w' ? -applied : 0,
    y: handle === 's' ? applied : handle === 'n' ? -applied : 0,
  };
  const slideDelta = {
    x: localDelta.x * Math.cos(angle) - localDelta.y * Math.sin(angle),
    y: localDelta.x * Math.sin(angle) + localDelta.y * Math.cos(angle),
  };
  const nextFrame = resizeFrame(frame, handle, slideDelta, false);
  const nextCrop = {
    ...crop,
    ...(handle === 'w' ? { left: nextOwn } : {}),
    ...(handle === 'e' ? { right: nextOwn } : {}),
    ...(handle === 'n' ? { top: nextOwn } : {}),
    ...(handle === 's' ? { bottom: nextOwn } : {}),
  };
  const withFrame = frameUpdate(nextFrame);
  return {
    [id]: (current) => {
      const next = withFrame(current);
      if (next.type !== 'image') return next;
      const uncropped = !nextCrop.left && !nextCrop.top && !nextCrop.right && !nextCrop.bottom;
      if (uncropped) {
        const { crop: _removed, ...rest } = next;
        return rest;
      }
      return { ...next, crop: nextCrop };
    },
  };
}
