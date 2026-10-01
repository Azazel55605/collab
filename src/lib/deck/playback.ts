/**
 * Presentation playback: which slide shows, and what each input does.
 *
 * Pure state so the player, the presenter view, and the audience window agree
 * on one model, and so every key and gesture is testable without a DOM.
 *
 * - Hidden slides are skipped by next/previous but can still be reached by
 *   number or from the slide grid, as in PowerPoint.
 * - Blanking (black or white screen) hides the slide without moving; any
 *   navigation, or the same key again, brings it back.
 * - Nothing here writes to the deck. Ink, pointer, and timer are playback
 *   state only; saving ink is a separate, explicit command.
 */

export type PlaybackBlank = 'black' | 'white' | null;
export type PlaybackTool = 'none' | 'laser' | 'pen' | 'highlighter' | 'eraser';

export interface PlaybackSlide {
  id: string;
  hidden: boolean;
}

export interface PlaybackState {
  /** Index into the deck's slide order. */
  index: number;
  blank: PlaybackBlank;
  /** Digits typed for "go to slide N". */
  pendingNumber: string;
  /** The slide-grid overview is open. */
  overview: boolean;
  ended: boolean;
}

export type PlaybackAction =
  | { type: 'next' }
  | { type: 'previous' }
  | { type: 'first' }
  | { type: 'last' }
  | { type: 'goto'; index: number }
  | { type: 'digit'; digit: string }
  | { type: 'commitNumber' }
  | { type: 'blank'; blank: 'black' | 'white' }
  | { type: 'overview' }
  | { type: 'unblank' };

export function initialPlayback(slides: readonly PlaybackSlide[], startIndex = 0): PlaybackState {
  const index = Math.max(0, Math.min(slides.length - 1, startIndex));
  return { index, blank: null, pendingNumber: '', overview: false, ended: false };
}

function visibleFrom(slides: readonly PlaybackSlide[], from: number, step: 1 | -1): number | null {
  for (let index = from; index >= 0 && index < slides.length; index += step) {
    if (!slides[index].hidden) return index;
  }
  return null;
}

/** The next slide playback shows after `index`, or null at the end. */
export function nextIndex(slides: readonly PlaybackSlide[], index: number): number | null {
  return visibleFrom(slides, index + 1, 1);
}

export function previousIndex(slides: readonly PlaybackSlide[], index: number): number | null {
  return visibleFrom(slides, index - 1, -1);
}

/** Position among the slides playback shows, for "3 / 12". Hidden slides count as their own spot. */
export function playbackProgress(
  slides: readonly PlaybackSlide[],
  index: number,
): { position: number; total: number } {
  const shown = slides.filter((slide, at) => !slide.hidden || at === index);
  const position = shown.indexOf(slides[index]) + 1;
  return { position: Math.max(1, position), total: shown.length };
}

export function playbackReducer(
  slides: readonly PlaybackSlide[],
  state: PlaybackState,
  action: PlaybackAction,
): PlaybackState {
  const moved = (index: number | null): PlaybackState =>
    index === null
      ? { ...state, pendingNumber: '', blank: null, ended: action.type === 'next' || state.ended }
      : { ...state, index, blank: null, pendingNumber: '', ended: false, overview: false };
  switch (action.type) {
    case 'next':
      if (state.blank) return { ...state, blank: null, pendingNumber: '' };
      if (state.ended) return state;
      return moved(nextIndex(slides, state.index));
    case 'previous':
      if (state.blank) return { ...state, blank: null, pendingNumber: '' };
      if (state.ended) return { ...state, ended: false, pendingNumber: '' };
      return moved(previousIndex(slides, state.index));
    case 'first':
      return moved(visibleFrom(slides, 0, 1) ?? 0);
    case 'last':
      return moved(visibleFrom(slides, slides.length - 1, -1) ?? slides.length - 1);
    case 'goto':
      return action.index >= 0 && action.index < slides.length ? moved(action.index) : state;
    case 'digit':
      return { ...state, pendingNumber: (state.pendingNumber + action.digit).slice(-4) };
    case 'commitNumber': {
      const number = Number(state.pendingNumber);
      if (!state.pendingNumber || number < 1 || number > slides.length) {
        return { ...state, pendingNumber: '' };
      }
      return moved(number - 1);
    }
    case 'blank':
      return { ...state, blank: state.blank === action.blank ? null : action.blank };
    case 'unblank':
      return { ...state, blank: null };
    case 'overview':
      return { ...state, overview: !state.overview, pendingNumber: '' };
  }
}

/** What a key does during playback. `null` means the key is not ours. */
export type PlaybackKeyCommand =
  | PlaybackAction
  | { type: 'exit' }
  | { type: 'tool'; tool: PlaybackTool }
  | { type: 'clearInk' }
  | { type: 'toggleTimer' }
  | { type: 'resetTimer' };

export function playbackKeyCommand(
  key: string,
  modifiers: { ctrl?: boolean; meta?: boolean; alt?: boolean; shift?: boolean } = {},
  state?: Pick<PlaybackState, 'pendingNumber'>,
): PlaybackKeyCommand | null {
  if (modifiers.ctrl || modifiers.meta || modifiers.alt) {
    // Ctrl+P / Ctrl+L / Ctrl+E / Ctrl+A choose tools as in PowerPoint.
    if (!modifiers.ctrl && !modifiers.meta) return null;
    switch (key.toLowerCase()) {
      case 'p':
        return { type: 'tool', tool: 'pen' };
      case 'l':
        return { type: 'tool', tool: 'laser' };
      case 'i':
        return { type: 'tool', tool: 'highlighter' };
      case 'e':
        return { type: 'tool', tool: 'eraser' };
      case 'a':
        return { type: 'tool', tool: 'none' };
      default:
        return null;
    }
  }
  if (/^[0-9]$/.test(key)) return { type: 'digit', digit: key };
  switch (key) {
    case 'Enter':
      return state?.pendingNumber ? { type: 'commitNumber' } : { type: 'next' };
    case 'ArrowRight':
    case 'ArrowDown':
    case 'PageDown':
    case ' ':
    case 'n':
    case 'N':
      return { type: 'next' };
    case 'ArrowLeft':
    case 'ArrowUp':
    case 'PageUp':
    case 'Backspace':
    case 'p':
    case 'P':
      return { type: 'previous' };
    case 'Home':
      return { type: 'first' };
    case 'End':
      return { type: 'last' };
    case 'b':
    case 'B':
    case '.':
      return { type: 'blank', blank: 'black' };
    case 'w':
    case 'W':
    case ',':
      return { type: 'blank', blank: 'white' };
    case 'g':
    case 'G':
    case '-':
      return { type: 'overview' };
    case 'l':
    case 'L':
      return { type: 'tool', tool: 'laser' };
    case 'e':
    case 'E':
      return { type: 'clearInk' };
    case 't':
    case 'T':
      return { type: 'toggleTimer' };
    case 'r':
    case 'R':
      return { type: 'resetTimer' };
    case 'Escape':
      return { type: 'exit' };
    default:
      return null;
  }
}

/** A horizontal swipe of at least `threshold` pixels moves; vertical ones do not. */
export function swipeCommand(
  dx: number,
  dy: number,
  threshold = 48,
): { type: 'next' } | { type: 'previous' } | null {
  if (Math.abs(dx) < threshold || Math.abs(dx) < Math.abs(dy) * 1.5) return null;
  return dx < 0 ? { type: 'next' } : { type: 'previous' };
}

/** `h:mm:ss` past an hour, `m:ss` below. */
export function formatElapsed(milliseconds: number): string {
  const total = Math.max(0, Math.floor(milliseconds / 1_000));
  const hours = Math.floor(total / 3_600);
  const minutes = Math.floor((total % 3_600) / 60);
  const seconds = String(total % 60).padStart(2, '0');
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, '0')}:${seconds}`
    : `${minutes}:${seconds}`;
}

/** A stopwatch that can pause, as plain data. */
export interface PlaybackTimer {
  /** Accumulated milliseconds before the current run. */
  elapsed: number;
  /** When the current run started (`performance.now()` style), or null when paused. */
  runningSince: number | null;
}

export function timerElapsed(timer: PlaybackTimer, now: number): number {
  return timer.elapsed + (timer.runningSince === null ? 0 : now - timer.runningSince);
}

export function toggleTimer(timer: PlaybackTimer, now: number): PlaybackTimer {
  return timer.runningSince === null
    ? { ...timer, runningSince: now }
    : { elapsed: timerElapsed(timer, now), runningSince: null };
}

/* ------------------------------------------------------------------------- */
/* Temporary ink                                                              */
/* ------------------------------------------------------------------------- */

export interface PlaybackStroke {
  tool: 'pen' | 'highlighter';
  color: string;
  /** Stroke width in deck units. */
  width: number;
  /** Points in slide (deck unit) coordinates. */
  points: Array<[number, number]>;
}

/** Ink per slide id. Lives only as long as the presentation. */
export type PlaybackInk = Record<string, PlaybackStroke[]>;

export const PLAYBACK_INK_COLORS = [
  '#ef4444',
  '#facc15',
  '#22c55e',
  '#3b82f6',
  '#ffffff',
  '#111827',
];

/** Pen and highlighter widths relative to the slide, so ink looks alike at every size. */
export function inkWidth(tool: PlaybackStroke['tool'], slideWidth: number): number {
  return Math.round(slideWidth * (tool === 'highlighter' ? 0.016 : 0.0035));
}

/** Adds a point unless it is closer than `minDistance` to the last one. */
export function extendStroke(
  stroke: PlaybackStroke,
  point: [number, number],
  minDistance: number,
): PlaybackStroke {
  const last = stroke.points[stroke.points.length - 1];
  if (last && Math.hypot(point[0] - last[0], point[1] - last[1]) < minDistance) return stroke;
  return { ...stroke, points: [...stroke.points, point] };
}

function distanceToSegment(
  point: [number, number],
  a: [number, number],
  b: [number, number],
): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const lengthSquared = dx * dx + dy * dy;
  const t =
    lengthSquared === 0
      ? 0
      : Math.max(0, Math.min(1, ((point[0] - a[0]) * dx + (point[1] - a[1]) * dy) / lengthSquared));
  return Math.hypot(point[0] - (a[0] + t * dx), point[1] - (a[1] + t * dy));
}

/** Removes the strokes within `radius` of a point (whole strokes, as PowerPoint's eraser). */
export function eraseStrokes(
  strokes: readonly PlaybackStroke[],
  point: [number, number],
  radius: number,
): PlaybackStroke[] {
  return strokes.filter((stroke) => {
    const reach = radius + stroke.width / 2;
    if (stroke.points.length === 1) {
      return Math.hypot(point[0] - stroke.points[0][0], point[1] - stroke.points[0][1]) > reach;
    }
    for (let index = 1; index < stroke.points.length; index += 1) {
      if (distanceToSegment(point, stroke.points[index - 1], stroke.points[index]) <= reach) {
        return false;
      }
    }
    return true;
  });
}

function round(value: number): string {
  return String(Math.round(value));
}

/** SVG path data for a stroke. */
export function strokePath(stroke: PlaybackStroke): string {
  const [first, ...rest] = stroke.points;
  if (!first) return '';
  if (rest.length === 0) return `M${round(first[0])} ${round(first[1])}h0.1`;
  return `M${round(first[0])} ${round(first[1])}${rest.map(([x, y]) => `L${round(x)} ${round(y)}`).join('')}`;
}

function safeColor(color: string): string {
  return /^#[0-9a-f]{6}$/i.test(color) ? color : '#ef4444';
}

/** The strokes as SVG elements in slide coordinates (no root element). */
export function strokesSvg(strokes: readonly PlaybackStroke[]): string {
  return strokes
    .map(
      (stroke) =>
        `<path d="${strokePath(stroke)}" fill="none" stroke="${safeColor(stroke.color)}" stroke-width="${round(stroke.width)}"` +
        ` stroke-linecap="round" stroke-linejoin="round"${stroke.tool === 'highlighter' ? ' stroke-opacity="0.4"' : ''}/>`,
    )
    .join('');
}

/** A slide's ink as a standalone, transparent SVG the size of the slide. */
export function inkAnnotationSvg(
  strokes: readonly PlaybackStroke[],
  slideWidth: number,
  slideHeight: number,
  pixelWidth: number,
  pixelHeight: number,
): string {
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${round(pixelWidth)}" height="${round(pixelHeight)}"` +
    ` viewBox="0 0 ${round(slideWidth)} ${round(slideHeight)}">${strokesSvg(strokes)}</svg>`
  );
}
