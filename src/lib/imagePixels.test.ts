// @vitest-environment node
import { expect, it } from 'vitest';

import { filterPixels } from './imagePixels';

it('preserves OCR coefficients and alpha for every worker preprocessing mode', () => {
  for (const mode of ['grayscale', 'contrast', 'threshold', 'invert']) {
    const value = new Uint8ClampedArray([100, 150, 200, 73]);
    filterPixels(value, mode);
    const gray = Math.round(100 * 0.299 + 150 * 0.587 + 200 * 0.114);
    expect(value[3]).toBe(73);
    if (mode === 'invert') expect([...value]).toEqual([155, 105, 55, 73]);
    else
      expect(value[0]).toBe(
        mode === 'threshold'
          ? gray >= 168
            ? 255
            : 0
          : mode === 'contrast'
            ? Math.round(Math.max(0, Math.min(255, (gray - 128) * 1.45 + 128)))
            : gray,
      );
  }
});
