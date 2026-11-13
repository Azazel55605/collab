import { describe, expect, it } from 'vitest';

import { containedBox, controlsBox } from './useVideoBox';

describe('containedBox', () => {
  it('pillarboxes a 16:9 picture in a wider stage', () => {
    expect(containedBox({ width: 2000, height: 900 }, { width: 1920, height: 1080 })).toEqual({
      left: 200,
      top: 0,
      width: 1600,
      height: 900,
    });
  });

  it('letterboxes a 2.39:1 film in a 16:9 stage', () => {
    const box = containedBox({ width: 1600, height: 900 }, { width: 2390, height: 1000 });
    expect(box?.width).toBe(1600);
    expect(box?.left).toBe(0);
    expect(box?.top).toBeCloseTo((900 - 1600 / 2.39) / 2);
  });

  it('is unknown until both sizes are known', () => {
    expect(containedBox({ width: 0, height: 900 }, { width: 1920, height: 1080 })).toBeNull();
    expect(containedBox({ width: 1600, height: 900 }, { width: 0, height: 0 })).toBeNull();
  });
});

describe('controlsBox', () => {
  it('follows the picture width and bottom edge', () => {
    expect(controlsBox({ left: 200, top: 30, width: 1600, height: 840 })).toEqual({
      left: 200,
      width: 1600,
      bottom: 30,
    });
  });

  it('keeps a minimum width for narrow pictures, capped at the stage', () => {
    expect(controlsBox({ left: 400, top: 0, width: 200, height: 360 })).toEqual({
      left: 290,
      width: 420,
      bottom: 0,
    });
    expect(controlsBox({ left: 50, top: 0, width: 200, height: 360 })).toEqual({
      left: 0,
      width: 300,
      bottom: 0,
    });
  });
});
