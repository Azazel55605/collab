import { describe, expect, it } from 'vitest';

import { boundedCanvasDeviceScale } from './rendering';

describe('boundedCanvasDeviceScale', () => {
  it('keeps normal HiDPI canvases sharp', () => {
    expect(boundedCanvasDeviceScale(1_200, 800, 2)).toBe(2);
  });

  it('caps large backing stores by pixel area', () => {
    const scale = boundedCanvasDeviceScale(3_840, 2_160, 2);
    expect(scale).toBeCloseTo(Math.sqrt(12_000_000 / (3_840 * 2_160)));
  });

  it('honors a platform-specific device-scale ceiling', () => {
    expect(boundedCanvasDeviceScale(1_200, 800, 2, 1.5)).toBe(1.5);
  });
});
