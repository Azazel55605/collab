import { describe, expect, it } from 'vitest';

import { pdfInkClientToLocal, pdfInkOverlayTransform } from './PdfInkOverlay';

describe('PDF ink overlay transform', () => {
  it('maps source page space through every supported rotation', () => {
    expect(pdfInkOverlayTransform(0, 800, 1000).transform).toBe('none');
    expect(pdfInkOverlayTransform(90, 800, 1000).transform).toBe(
      'translateX(1000px) rotate(90deg)',
    );
    expect(pdfInkOverlayTransform(180, 800, 1000).transform).toBe(
      'translate(800px, 1000px) rotate(180deg)',
    );
    expect(pdfInkOverlayTransform(270, 800, 1000).transform).toBe(
      'translateY(800px) rotate(270deg)',
    );
  });

  it('normalizes negative and wrapped rotations', () => {
    expect(pdfInkOverlayTransform(-90, 800, 1000).transform).toBe(
      'translateY(800px) rotate(270deg)',
    );
    expect(pdfInkOverlayTransform(450, 800, 1000).transform).toBe(
      'translateX(1000px) rotate(90deg)',
    );
  });

  it('maps pointer coordinates back into source-page space after rotation', () => {
    const bounds = { left: 100, top: 200 } as DOMRect;
    expect(pdfInkClientToLocal(0, { x: 120, y: 230 }, bounds, 800, 1000)).toEqual({
      x: 20,
      y: 30,
    });
    expect(pdfInkClientToLocal(90, { x: 120, y: 230 }, bounds, 800, 1000)).toEqual({
      x: 30,
      y: 980,
    });
    expect(pdfInkClientToLocal(180, { x: 120, y: 230 }, bounds, 800, 1000)).toEqual({
      x: 780,
      y: 970,
    });
    expect(pdfInkClientToLocal(270, { x: 120, y: 230 }, bounds, 800, 1000)).toEqual({
      x: 770,
      y: 20,
    });
  });
});
