/** Maximum backing-store area for one interactive canvas. */
export const MAX_INTERACTIVE_CANVAS_PIXELS = 12_000_000;

/**
 * Bounds HiDPI canvas allocation without changing its CSS size.
 *
 * A fullscreen canvas at DPR 2 is four times the visible pixel area. That is
 * useful on small displays, but it creates 30+ megapixel buffers on 4K panels
 * and makes WebKitGTK upload far more data than the user can distinguish.
 */
export function boundedCanvasDeviceScale(
  cssWidth: number,
  cssHeight: number,
  devicePixelRatio: number,
  maxDeviceScale = 2,
  maxPixels = MAX_INTERACTIVE_CANVAS_PIXELS,
) {
  const width = Math.max(1, Number.isFinite(cssWidth) ? cssWidth : 1);
  const height = Math.max(1, Number.isFinite(cssHeight) ? cssHeight : 1);
  const requested = Math.max(0.5, Number.isFinite(devicePixelRatio) ? devicePixelRatio : 1);
  const pixelBudgetScale = Math.sqrt(maxPixels / (width * height));
  return Math.max(0.5, Math.min(requested, maxDeviceScale, pixelBudgetScale));
}

export function interactiveCanvasDeviceScale(cssWidth: number, cssHeight: number) {
  const linuxWebKit = document.documentElement.dataset.linuxWebkit !== undefined;
  return boundedCanvasDeviceScale(
    cssWidth,
    cssHeight,
    window.devicePixelRatio || 1,
    linuxWebKit ? 1.5 : 2,
  );
}
