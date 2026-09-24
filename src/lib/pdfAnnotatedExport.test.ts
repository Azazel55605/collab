import { describe, expect, it } from 'vitest';

import { annotatedPdfFileName, pdfExportScale } from './pdfAnnotatedExport';

describe('annotated PDF export planning', () => {
  it('uses a stable copy filename without changing the source name', () => {
    expect(annotatedPdfFileName('Research/Paper.PDF')).toBe('Paper-annotated.pdf');
  });

  it('keeps ordinary pages at 2x and bounds unusually large pages', () => {
    expect(pdfExportScale(612, 792)).toBe(2);
    const scale = pdfExportScale(20_000, 20_000);
    expect(scale).toBeLessThan(1);
    expect(20_000 * 20_000 * scale * scale).toBeCloseTo(24_000_000, -1);
  });
});
