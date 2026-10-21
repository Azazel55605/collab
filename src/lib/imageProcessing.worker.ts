/// <reference lib="webworker" />
import { filterPixels } from './imagePixels';

export type ImageWork = {
  kind: 'filter' | 'edit' | 'encode';
  bitmap: ImageBitmap;
  width: number;
  height: number;
  rotation?: number;
  crop?: { x: number; y: number; width: number; height: number };
  mode?: string;
  mime?: string;
  quality?: number;
};
self.onmessage = async (event: MessageEvent<ImageWork>) => {
  const request = event.data;
  let canvas: OffscreenCanvas | undefined;
  try {
    const { bitmap, width, height } = request;
    if (
      !Number.isFinite(width) ||
      !Number.isFinite(height) ||
      width < 1 ||
      height < 1 ||
      width * height > 48_000_000
    )
      throw new Error('Image operation exceeds its 48 megapixel limit');
    canvas = new OffscreenCanvas(Math.round(width), Math.round(height));
    const context = canvas.getContext('2d', { willReadFrequently: request.kind === 'filter' });
    if (!context) throw new Error('Image worker needs OffscreenCanvas 2D support');
    if (request.kind === 'edit') {
      const crop = request.crop!;
      context.scale(width / crop.width, height / crop.height);
      context.translate(-crop.x, -crop.y);
      if (request.rotation === 90) {
        context.translate(bitmap.height, 0);
        context.rotate(Math.PI / 2);
      } else if (request.rotation === 180) {
        context.translate(bitmap.width, bitmap.height);
        context.rotate(Math.PI);
      } else if (request.rotation === 270) {
        context.translate(0, bitmap.width);
        context.rotate(-Math.PI / 2);
      }
      context.drawImage(bitmap, 0, 0);
    } else context.drawImage(bitmap, 0, 0, width, height);
    if (request.kind === 'filter' && request.mode !== 'none') {
      const pixels = context.getImageData(0, 0, width, height);
      filterPixels(pixels.data, request.mode ?? 'grayscale');
      context.putImageData(pixels, 0, 0);
    }
    if (request.kind === 'encode')
      self.postMessage({
        result: await canvas.convertToBlob({
          type: request.mime ?? 'image/png',
          quality: request.quality,
        }),
      });
    else {
      const result = canvas.transferToImageBitmap();
      self.postMessage({ result }, [result]);
    }
  } catch (error) {
    self.postMessage({ error: error instanceof Error ? error.message : String(error) });
  } finally {
    request.bitmap.close();
    if (canvas) {
      canvas.width = 0;
      canvas.height = 0;
    }
  }
};
