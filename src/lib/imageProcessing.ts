import { getCropBounds, getRotatedDimensions } from '../components/image/ImageViewUtils';
import type { PermanentImageEdits } from '../types/image';

import { BoundedWorkerPool } from './boundedWorkerPool';
import type { ImageWork } from './imageProcessing.worker';
import { registerMediaCleanup } from './mediaLifecycle';
import { PreviewScheduler } from './previewScheduler';

const pool = new BoundedWorkerPool(
  () => new Worker(new URL('./imageProcessing.worker.ts', import.meta.url), { type: 'module' }),
  1,
  8,
  'Image',
);
const imageJobs = new PreviewScheduler(1, 8);
let imageSequence = 0;
registerMediaCleanup(() => imageJobs.clear());
async function work<T>(
  image: HTMLImageElement | HTMLCanvasElement,
  request: Omit<ImageWork, 'bitmap'>,
  signal?: AbortSignal,
) {
  return imageJobs.run(
    `image:${imageSequence++}`,
    async (ownedSignal) => {
      if (ownedSignal.aborted) throw new DOMException('Cancelled', 'AbortError');
      const sourceWidth = image instanceof HTMLCanvasElement ? image.width : image.naturalWidth;
      const sourceHeight = image instanceof HTMLCanvasElement ? image.height : image.naturalHeight;
      if (sourceWidth * sourceHeight > 48_000_000)
        throw new Error('Image operation exceeds its 48 megapixel source limit');
      if (typeof createImageBitmap !== 'function')
        throw new Error('Image workers are unavailable in this webview.');
      const bitmap = await createImageBitmap(image);
      if (ownedSignal.aborted) {
        bitmap.close();
        throw new DOMException('Cancelled', 'AbortError');
      }
      try {
        return await pool.run<T>({ ...request, bitmap }, ownedSignal, 30000, [bitmap]);
      } catch (error) {
        bitmap.close();
        throw error;
      }
    },
    { signal },
  );
}
function takeCanvas(bitmap: ImageBitmap) {
  const canvas = document.createElement('canvas');
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const context = canvas.getContext('2d');
  if (!context) {
    bitmap.close();
    throw new Error('Could not display processed image');
  }
  context.drawImage(bitmap, 0, 0);
  bitmap.close();
  return canvas;
}
export async function preprocessCanvas(
  image: HTMLImageElement | HTMLCanvasElement,
  mode: string,
  signal?: AbortSignal,
) {
  const width = image instanceof HTMLCanvasElement ? image.width : image.naturalWidth;
  const height = image instanceof HTMLCanvasElement ? image.height : image.naturalHeight;
  const scale = Math.min(1, Math.sqrt(12_000_000 / Math.max(1, width * height)));
  const bitmap = await work<ImageBitmap>(
    image,
    {
      kind: 'filter',
      width: Math.max(1, Math.floor(width * scale)),
      height: Math.max(1, Math.floor(height * scale)),
      mode,
    },
    signal,
  );
  return takeCanvas(bitmap);
}
export async function renderEditedImage(
  image: HTMLImageElement,
  edits: PermanentImageEdits,
  options: {
    ignoreCrop?: boolean;
    ignoreResize?: boolean;
    preview?: boolean;
    maxPixels?: number;
    signal?: AbortSignal;
  } = {},
) {
  const sourceSize = getRotatedDimensions(
    { width: image.naturalWidth, height: image.naturalHeight },
    edits.rotation,
  );
  const crop = options.ignoreCrop
    ? { x: 0, y: 0, ...sourceSize }
    : getCropBounds({ width: image.naturalWidth, height: image.naturalHeight }, edits);
  let width = options.ignoreResize ? crop.width : (edits.resizeWidth ?? crop.width);
  let height = options.ignoreResize ? crop.height : (edits.resizeHeight ?? crop.height);
  if (options.preview || options.maxPixels) {
    const scale = Math.min(
      1,
      Math.sqrt((options.maxPixels ?? 2_000_000) / Math.max(1, width * height)),
    );
    width = Math.max(1, Math.floor(width * scale));
    height = Math.max(1, Math.floor(height * scale));
  }
  const bitmap = await work<ImageBitmap>(
    image,
    { kind: 'edit', width, height, crop, rotation: edits.rotation },
    options.signal,
  );
  return { canvas: takeCanvas(bitmap), sourceSize };
}
export async function encodeImageCanvas(
  canvas: HTMLCanvasElement,
  mime: string,
  quality?: number,
  signal?: AbortSignal,
) {
  const blob = await work<Blob>(
    canvas,
    { kind: 'encode', width: canvas.width, height: canvas.height, mime, quality },
    signal,
  );
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}
