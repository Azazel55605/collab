/**
 * The Pointer Events adapter.
 *
 * This is the only place in the ink stack that knows about the DOM. It turns
 * `PointerEvent`s into the plain readings `samples.ts` consumes, and it owns
 * the device-behaviour decisions that cannot be tested without a real pointer:
 * which contacts draw, which pan, and which are a palm.
 *
 * Pointer Events is the right boundary because it is one event family for pen,
 * mouse, and touch, and it is where pressure, tilt, twist, coalesced events,
 * and pointer capture live. Touch Events would lose pressure and tilt; mouse
 * events would lose everything.
 */

import { INK_UNITS_PER_PX } from '../../types/ink';
import type { InkPointerReading } from './samples';

export type InkPointerKind = 'pen' | 'touch' | 'mouse';

/** What a contact is allowed to do, decided when it goes down. */
export type InkContactRole = 'draw' | 'navigate' | 'erase' | 'reject';

export interface InkViewportTransform {
  /** Ink-unit coordinate at the top-left of the surface. */
  originX: number;
  originY: number;
  /** CSS pixels per ink unit, i.e. the rendered zoom. */
  zoom: number;
}

export interface InkSurfacePoint {
  /** CSS pixels relative to the drawing surface. */
  offsetX: number;
  offsetY: number;
}

/** Surface pixels to document ink units. */
export function toInkUnits(
  point: InkSurfacePoint,
  transform: InkViewportTransform,
): { x: number; y: number } {
  const scale = INK_UNITS_PER_PX / Math.max(transform.zoom, Number.EPSILON);
  return {
    x: transform.originX + point.offsetX * scale,
    y: transform.originY + point.offsetY * scale,
  };
}

/**
 * The fields of a `PointerEvent` this module reads.
 *
 * Declared structurally rather than taking `PointerEvent` so the pipeline can
 * be driven by recorded traces in a test, which is the only way to get an
 * Android S Pen trace onto a CI machine.
 */
export interface InkPointerEventLike {
  pointerId: number;
  pointerType: string;
  isPrimary: boolean;
  buttons: number;
  button?: number;
  pressure: number;
  tiltX?: number;
  tiltY?: number;
  twist?: number;
  width?: number;
  height?: number;
  offsetX: number;
  offsetY: number;
  timeStamp: number;
}

export function pointerKind(event: InkPointerEventLike): InkPointerKind {
  if (event.pointerType === 'pen') return 'pen';
  if (event.pointerType === 'touch') return 'touch';
  return 'mouse';
}

/**
 * `buttons` bit 5 (value 32) is the eraser end of a pen, per the spec.
 * `button` 5 reports the transition. Both are checked because platforms differ
 * in which they populate on the initial `pointerdown`.
 */
export function isEraserEnd(event: InkPointerEventLike): boolean {
  return (event.buttons & 32) !== 0 || event.button === 5;
}

/** Barrel button, `buttons` bit 1 (value 2). */
export function isBarrelButton(event: InkPointerEventLike): boolean {
  return (event.buttons & 2) !== 0;
}

export interface InkInputSettings {
  /** Draw with a finger instead of panning with it. */
  fingerDrawing: boolean;
  /** Ignore touch entirely while a pen is in use. */
  palmRejection: boolean;
  /** What the barrel button does while held. */
  barrelButton: 'erase' | 'lasso' | 'none';
}

export const INK_DEFAULT_INPUT_SETTINGS: InkInputSettings = {
  fingerDrawing: false,
  palmRejection: true,
  barrelButton: 'erase',
};

/**
 * Milliseconds after the last pen sample during which touches are treated as
 * palm contacts.
 *
 * A palm usually lands *before* the pen tip does, so this window is also
 * applied backwards by `ContactArbiter` retiring touches that were already
 * down when a pen arrives. The window is generous because the cost of a
 * missed rejection (a stray mark) is worse than the cost of an over-rejection
 * (a pan that did not happen).
 */
export const INK_PALM_WINDOW_MS = 1_000;

/**
 * Contact area, in CSS pixels, above which a touch is a palm regardless of
 * timing. A fingertip reports well under this on every platform that reports
 * contact geometry at all; a platform that reports nothing gives 0 or 1 and
 * falls through to the timing rule.
 */
export const INK_PALM_CONTACT_PX = 40;

/**
 * Decides what each contact may do.
 *
 * Palm rejection here is explicitly best-effort and application-level. When the
 * operating system or the digitizer rejects a palm, the event never reaches us
 * and that is the authoritative answer; this only covers the platforms that
 * deliver the contact anyway.
 */
export class InkContactArbiter {
  private readonly roles = new Map<number, InkContactRole>();
  private lastPenActivityMs = Number.NEGATIVE_INFINITY;
  private penIsDown = false;

  constructor(private settings: InkInputSettings = INK_DEFAULT_INPUT_SETTINGS) {}

  updateSettings(settings: InkInputSettings): void {
    this.settings = settings;
  }

  /** True while a touch should be treated as a palm. */
  private withinPalmWindow(timeStamp: number): boolean {
    if (!this.settings.palmRejection) return false;
    if (this.penIsDown) return true;
    return timeStamp - this.lastPenActivityMs < INK_PALM_WINDOW_MS;
  }

  /**
   * Classifies a new contact.
   *
   * A pen arriving retires every touch already classified as navigating, which
   * is what handles the palm that landed first.
   */
  down(event: InkPointerEventLike): InkContactRole {
    const kind = pointerKind(event);
    let role: InkContactRole;

    if (kind === 'pen') {
      this.penIsDown = true;
      this.lastPenActivityMs = event.timeStamp;
      if (this.settings.palmRejection) {
        for (const [id, existing] of this.roles) {
          if (existing !== 'draw') this.roles.set(id, 'reject');
        }
      }
      role =
        isEraserEnd(event) || (isBarrelButton(event) && this.settings.barrelButton === 'erase')
          ? 'erase'
          : 'draw';
    } else if (kind === 'touch') {
      const large =
        (event.width ?? 0) > INK_PALM_CONTACT_PX || (event.height ?? 0) > INK_PALM_CONTACT_PX;
      if (large || this.withinPalmWindow(event.timeStamp)) {
        role = 'reject';
      } else {
        role = this.settings.fingerDrawing ? 'draw' : 'navigate';
      }
    } else {
      role = 'draw';
    }

    this.roles.set(event.pointerId, role);
    return role;
  }

  move(event: InkPointerEventLike): InkContactRole {
    if (pointerKind(event) === 'pen') this.lastPenActivityMs = event.timeStamp;
    return this.roles.get(event.pointerId) ?? 'reject';
  }

  /** Ends a contact. Must be called for `pointerup`, `pointercancel`, and lost capture. */
  up(event: InkPointerEventLike): InkContactRole {
    const role = this.roles.get(event.pointerId) ?? 'reject';
    this.roles.delete(event.pointerId);
    if (pointerKind(event) === 'pen') {
      this.penIsDown = false;
      this.lastPenActivityMs = event.timeStamp;
    }
    return role;
  }

  /** Drops all state. For visibility loss, rotation, and window blur. */
  reset(): void {
    this.roles.clear();
    this.penIsDown = false;
  }

  get activeContacts(): number {
    return this.roles.size;
  }

  roleOf(pointerId: number): InkContactRole | undefined {
    return this.roles.get(pointerId);
  }
}

/**
 * Turns one pointer event into a reading in document coordinates.
 *
 * `strokeStartMs` makes `elapsed` relative to the stroke rather than to the
 * page load, which is what keeps the delta-encoded time channel small.
 */
export function readingFromEvent(
  event: InkPointerEventLike,
  transform: InkViewportTransform,
  strokeStartMs: number,
): InkPointerReading {
  const { x, y } = toInkUnits(event, transform);
  const reading: InkPointerReading = { x, y, elapsed: event.timeStamp - strokeStartMs };

  // A mouse reports 0.5 while a button is down and 0 otherwise; that is not a
  // measurement. Only pen pressure is recorded as pressure.
  if (event.pointerType === 'pen' && event.pressure > 0) reading.pressure = event.pressure;
  if (event.tiltX !== undefined && event.tiltX !== 0) reading.tiltX = event.tiltX;
  if (event.tiltY !== undefined && event.tiltY !== 0) reading.tiltY = event.tiltY;
  if (event.twist !== undefined && event.twist !== 0) reading.twist = event.twist;

  return reading;
}

/**
 * Expands an event into its coalesced readings.
 *
 * Browsers deliver pointer samples faster than they fire events, batching the
 * intermediate ones. Without this the captured line is visibly polygonal at
 * speed on exactly the high-rate digitizers people buy for drawing.
 *
 * Predicted events are deliberately not read anywhere: they are a rendering
 * hint about where the pointer is going, and persisting a guess would put
 * points in the document the user never drew.
 */
export function readingsFromEvent(
  event: InkPointerEventLike,
  transform: InkViewportTransform,
  strokeStartMs: number,
  coalesced?: InkPointerEventLike[],
): InkPointerReading[] {
  if (!coalesced || coalesced.length === 0) {
    return [readingFromEvent(event, transform, strokeStartMs)];
  }
  return coalesced.map((entry) => readingFromEvent(entry, transform, strokeStartMs));
}
