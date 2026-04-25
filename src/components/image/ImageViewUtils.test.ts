import { describe, expect, it } from 'vitest';

import {
  canOverwriteImageFormat,
  createEmptyEdits,
  createEmptyOverlayDocument,
  describeOverlayCount,
  fitWithin,
  getArrowLineEnd,
  getCropBounds,
  getLineDash,
  getOutputFileName,
  getOutputMime,
  getOverlayItemLabel,
  getOverlayItemMeta,
  getPermanentPreviewDimensions,
  getRotatedDimensions,
  getTextMinHeight,
  getTextMinWidth,
  isPermanentDirty,
  normalizeCropRect,
  scaleDimensions,
  type Dimensions,
} from './ImageViewUtils';

describe('ImageViewUtils', () => {
  it('fits and scales dimensions safely', () => {
    expect(fitWithin({ width: 500, height: 300 }, { width: 1000, height: 1000 })).toEqual({ width: 300, height: 300 });
    expect(scaleDimensions({ width: 100, height: 50 }, 1.5)).toEqual({ width: 150, height: 75 });
  });

  it('handles output format helpers', () => {
    expect(canOverwriteImageFormat('Pictures/example.png')).toBe(true);
    expect(canOverwriteImageFormat('Pictures/example.gif')).toBe(false);
    expect(getOutputMime('Pictures/example.jpeg')).toBe('image/jpeg');
    expect(getOutputMime('Pictures/example.webp')).toBe('image/webp');
    expect(getOutputMime('Pictures/example.gif')).toBe('image/png');
    expect(getOutputFileName('Pictures/example.png', 'image/jpeg')).toBe('example-edited.jpg');
  });

  it('computes crop and preview dimensions from edits', () => {
    const source: Dimensions = { width: 1200, height: 800 };
    const edits = {
      ...createEmptyEdits(),
      rotation: 90 as const,
      crop: { x: 50, y: 60, width: 300, height: 200 },
      resizeWidth: 600,
    };

    expect(getRotatedDimensions(source, edits.rotation)).toEqual({ width: 800, height: 1200 });
    expect(getCropBounds(source, edits)).toEqual({ x: 50, y: 60, width: 300, height: 200 });
    expect(getPermanentPreviewDimensions(source, edits, false)).toEqual({ width: 600, height: 200 });
    expect(getPermanentPreviewDimensions(source, edits, true)).toEqual({ width: 800, height: 1200 });
  });

  it('normalizes crop rectangles into bounds', () => {
    expect(normalizeCropRect({ x: -10, y: 10, width: 999, height: 0 }, { width: 300, height: 200 })).toEqual({
      x: 0,
      y: 10,
      width: 300,
      height: 1,
    });
  });

  it('provides additive overlay labels and metadata', () => {
    expect(describeOverlayCount(0)).toBe('No additive annotations');
    expect(describeOverlayCount(2)).toBe('2 additive annotations');
    expect(getOverlayItemLabel({
      id: 't1',
      type: 'text',
      x: 0,
      y: 0,
      width: 0.22,
      height: 0.12,
      text: 'Hello world',
      color: '#fff',
      fontSize: 18,
    }, 0)).toBe('Text: Hello world');
    expect(getOverlayItemMeta({ id: 'a1', type: 'arrow', start: { x: 0, y: 0 }, end: { x: 1, y: 1 }, color: '#fff', strokeWidth: 4, lineStyle: 'dotted' })).toBe('4px dotted arrow');
  });

  it('derives stroke dash and arrow line end geometry', () => {
    expect(getLineDash('solid', 4)).toBeUndefined();
    expect(getLineDash('dashed', 4)).toEqual([12, 8]);
    expect(getLineDash('dotted', 4)).toEqual([4, 7]);
    expect(getArrowLineEnd({ x: 0, y: 0 }, { x: 10, y: 0 }, 4)).toEqual({ x: expect.closeTo(6.72, 10), y: 0 });
  });

  it('derives text minimums and dirty state', () => {
    expect(getTextMinWidth({ width: 1000, height: 500 })).toBe(0.12);
    expect(getTextMinHeight({ width: 1000, height: 100 })).toBe(0.3);
    expect(isPermanentDirty(createEmptyEdits())).toBe(false);
    expect(isPermanentDirty({ ...createEmptyEdits(), rotation: 90 })).toBe(true);
  });

  it('creates an empty overlay document from dimensions', () => {
    expect(createEmptyOverlayDocument({ width: 640, height: 480 })).toEqual(
      expect.objectContaining({
        version: 1,
        baseWidth: 640,
        baseHeight: 480,
        items: [],
      }),
    );
  });
});
