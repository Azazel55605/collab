import { describe, expect, it } from 'vitest';

import {
  completeNerdFontIconQuery,
  isNerdFontIconQuery,
  searchNerdFontIcons,
} from './nerdFontIcons';

describe('nerdFontIcons helpers', () => {
  it('strips complete singular/plural aliases without leaving trailing prefix letters', () => {
    for (const alias of ['icon', 'icons', 'glyph', 'glyphs', 'symbol', 'symbols', 'nf']) {
      expect(searchNerdFontIcons(`${alias} nf-cod-bug`, 1)[0]?.id).toBe('nf-cod-bug');
    }
  });
  it('recognizes icon-mode queries and completion aliases', () => {
    expect(isNerdFontIconQuery('icon bug')).toBe(true);
    expect(isNerdFontIconQuery('nf rocket')).toBe(true);
    expect(isNerdFontIconQuery('table')).toBe(false);
    expect(completeNerdFontIconQuery('nf')).toBe('icon ');
    expect(completeNerdFontIconQuery('icon ')).toBeNull();
  });

  it('returns strong matches first for exact and prefix searches', () => {
    const exact = searchNerdFontIcons('icon nf-cod-bug', 5);
    expect(exact[0]?.id).toBe('nf-cod-bug');

    const prefix = searchNerdFontIcons('icon bug', 10);
    expect(prefix.some((entry) => entry.id === 'nf-cod-bug')).toBe(true);
  });

  it('respects result limits', () => {
    expect(searchNerdFontIcons('icon a', 7)).toHaveLength(7);
  });
});
