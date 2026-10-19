import { tauriCommands } from './tauri';

interface Point {
  x: number;
  y: number;
}
interface Size {
  width: number;
  height: number;
}

/** Native view coordinates to CSS viewport coordinates, including WebView zoom. */
export function nativeDropClientPoint(point: Point, native: Size, css: Size): Point {
  if (
    ![point.x, point.y, native.width, native.height, css.width, css.height].every(
      Number.isFinite,
    ) ||
    native.width <= 0 ||
    native.height <= 0 ||
    css.width <= 0 ||
    css.height <= 0
  ) {
    throw new Error('Invalid native drop coordinates or viewport.');
  }
  return { x: (point.x * css.width) / native.width, y: (point.y * css.height) / native.height };
}

let cached: { size: Size; css: Size; at: number } | null = null;
let pending: Promise<Size> | null = null;

export async function resolveNativeDropPoint(point: Point, fresh = false): Promise<Point> {
  const css = { width: window.innerWidth, height: window.innerHeight };
  if (
    !fresh &&
    cached &&
    Date.now() - cached.at < 250 &&
    css.width === cached.css.width &&
    css.height === cached.css.height
  ) {
    return nativeDropClientPoint(point, cached.size, css);
  }
  // Share concurrent hover requests, but query again for the final drop so a
  // resize/monitor/zoom transition cannot commit a cached coordinate transform.
  const request = fresh
    ? tauriCommands.nativeDropViewport()
    : (pending ??= tauriCommands.nativeDropViewport());
  try {
    const size = await request;
    const converted = nativeDropClientPoint(point, size, css);
    cached = { size, css, at: Date.now() };
    return converted;
  } finally {
    if (pending === request) pending = null;
  }
}
