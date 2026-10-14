import { describe, expect, it } from 'vitest';

import { boundedCanvasDeviceScale } from './rendering';

describe('boundedCanvasDeviceScale', () => {
  it('keeps normal HiDPI canvases sharp', () => {
    expect(boundedCanvasDeviceScale(1_200, 800, 2)).toBe(2);
  });

  it('caps large backing stores by pixel area', () => {
    const scale = boundedCanvasDeviceScale(3_840, 2_160, 2);
    expect(scale).toBeCloseTo(Math.sqrt(12_000_000 / (3_840 * 2_160)), 3);
    expect(Math.ceil(3_840 * scale) * Math.ceil(2_160 * scale)).toBeLessThanOrEqual(12_000_000);
  });

  it('honors a platform-specific device-scale ceiling', () => {
    expect(boundedCanvasDeviceScale(1_200, 800, 2, 1.5)).toBe(1.5);
  });

  it('allows sub-half scaling for oversized surfaces', () => {
    const scale = boundedCanvasDeviceScale(8_000, 8_000, 2);
    expect(scale).toBeLessThan(0.5);
    expect(8_000 * 8_000 * scale * scale).toBeLessThanOrEqual(12_000_000);
  });
});
