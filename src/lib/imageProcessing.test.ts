import { expect, it, vi } from 'vitest';

import { preprocessCanvas } from './imageProcessing';

it('rejects oversized input before creating or transferring another full bitmap', async () => {
  const bitmap = vi.fn();
  vi.stubGlobal('createImageBitmap', bitmap);
  const canvas = document.createElement('canvas');
  canvas.width = 10000;
  canvas.height = 10000;
  await expect(preprocessCanvas(canvas, 'threshold')).rejects.toThrow('48 megapixel source');
  expect(bitmap).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
});
