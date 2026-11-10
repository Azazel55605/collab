import { describe, expect, it } from 'vitest';

import { DEFAULT_NOTE_PAGE_SETTINGS, MM_TO_PX, notePageGeometry } from './notePageLayout';

describe('note page geometry', () => {
  it('uses physical paper dimensions and subtracts both margins', () => {
    const page = notePageGeometry(DEFAULT_NOTE_PAGE_SETTINGS);
    expect(page.width).toBeCloseTo(210 * MM_TO_PX);
    expect(page.height).toBeCloseTo(297 * MM_TO_PX);
    expect(page.contentHeight).toBeCloseTo(257 * MM_TO_PX);
  });
  it('supports Letter landscape and narrow margins', () => {
    const page = notePageGeometry({ paper: 'letter', orientation: 'landscape', margins: 'narrow' });
    expect(page.widthMm).toBe(279.4);
    expect(page.heightMm).toBe(215.9);
    expect(page.contentWidth).toBeCloseTo((279.4 - 24) * MM_TO_PX);
  });
});
