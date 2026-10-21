import { expect, it } from 'vitest';

import { clearMediaResources } from './mediaLifecycle';
import {
  PDF_BACKING_PIXELS,
  pdfCanvasStats,
  releasePdfCanvas,
  reservePdfCanvas,
} from './pdfCanvasBudget';

it('caps actual backing pixels across pages and releases on visibility/privacy boundaries', () => {
  clearMediaResources();
  const canvases = Array.from({ length: 8 }, () => document.createElement('canvas'));
  for (const canvas of canvases) reservePdfCanvas(canvas, 6000, 4000, 2);
  expect(pdfCanvasStats().pixels).toBeLessThanOrEqual(PDF_BACKING_PIXELS);
  expect(() => reservePdfCanvas(document.createElement('canvas'), 6000, 4000, 2)).toThrow(
    'memory is in use',
  );
  releasePdfCanvas(canvases[0]);
  expect(() => reservePdfCanvas(canvases[0], 800, 600, 1)).not.toThrow();
  clearMediaResources();
  expect(pdfCanvasStats()).toEqual({ canvases: 0, pixels: 0 });
  expect(canvases[1].width).toBe(0);
});
