import { expect, it } from 'vitest';

import {
  boundedCanvasPreviews,
  CANVAS_PREVIEW_BYTES,
  previewRetainedBytes,
} from './canvasPreviewBudget';

it('retires removed/offscreen content and rejects oversized retained payloads', () => {
  const allowed = new Set(['visible', 'huge']);
  const visible = { loaded: true, imageSrc: 'data:image/png;base64,AA==' };
  const next = boundedCanvasPreviews(
    {
      visible,
      offscreen: { markdownContent: 'private' },
      huge: { imageSrc: 'x'.repeat(CANVAS_PREVIEW_BYTES) },
    },
    allowed,
  );
  expect(next.offscreen).toBeUndefined();
  expect(next.visible).toBe(visible);
  expect(next.huge.imageSrc).toBeUndefined();
  expect(next.huge.previewError).toContain('budget');
  expect(previewRetainedBytes(next.visible)).toBeLessThan(CANVAS_PREVIEW_BYTES);
});
