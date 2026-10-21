import { registerMediaCleanup } from './mediaLifecycle';
import { boundedCanvasDeviceScale } from './rendering';

const backing = new Map<HTMLCanvasElement, number>();
export const PDF_BACKING_PIXELS = 48_000_000;
export function releasePdfCanvas(canvas: HTMLCanvasElement) {
  backing.delete(canvas);
  canvas.width = 0;
  canvas.height = 0;
}
export function reservePdfCanvas(
  canvas: HTMLCanvasElement,
  width: number,
  height: number,
  requestedScale: number,
) {
  backing.delete(canvas);
  const occupied = [...backing.values()].reduce((sum, pixels) => sum + pixels, 0);
  const available = PDF_BACKING_PIXELS - occupied;
  if (available < 65536)
    throw new Error('PDF rendering memory is in use. Scroll away from other pages or retry.');
  const scale = boundedCanvasDeviceScale(
    width,
    height,
    requestedScale,
    2,
    Math.min(6_000_000, available),
  );
  backing.set(canvas, Math.ceil(width * scale) * Math.ceil(height * scale));
  return scale;
}
export function pdfCanvasStats() {
  return {
    canvases: backing.size,
    pixels: [...backing.values()].reduce((sum, pixels) => sum + pixels, 0),
  };
}
registerMediaCleanup(() => {
  for (const canvas of backing.keys()) releasePdfCanvas(canvas);
});
