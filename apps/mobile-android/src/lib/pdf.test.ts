import { describe, expect, it } from 'vitest';

import { calculateMobilePdfPageSize } from './pdf';

describe('calculateMobilePdfPageSize', () => {
  it('reserves the fitted height for each page aspect ratio', () => {
    expect(
      calculateMobilePdfPageSize({
        naturalWidth: 600,
        naturalHeight: 800,
        stageWidth: 388,
        zoom: 1,
      }),
    ).toEqual({ width: 360, height: 480 });

    expect(
      calculateMobilePdfPageSize({
        naturalWidth: 600,
        naturalHeight: 1_200,
        stageWidth: 388,
        zoom: 1,
      }),
    ).toEqual({ width: 360, height: 720 });
  });

  it('includes the active zoom in the reserved dimensions', () => {
    expect(
      calculateMobilePdfPageSize({
        naturalWidth: 600,
        naturalHeight: 800,
        stageWidth: 388,
        zoom: 1.5,
      }),
    ).toEqual({ width: 540, height: 720 });
  });
});
