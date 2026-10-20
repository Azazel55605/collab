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

it('bounds query retention while handling empty, excessive and invalid limits', async () => {
  const { iconSearchStats, prepareIconSearchIndex } = await import('./nerdFontIcons');
  await prepareIconSearchIndex();
  expect(searchNerdFontIcons('a', 0)).toEqual([]);
  expect(searchNerdFontIcons('a', -5)).toEqual([]);
  expect(searchNerdFontIcons('a', NaN).length).toBeLessThanOrEqual(240);
  expect(searchNerdFontIcons('a', 100000).length).toBeLessThanOrEqual(1000);
  for (let index = 0; index < 300; index++) searchNerdFontIcons(`query ${index}`, 1000);
  expect(iconSearchStats().entries).toBeLessThanOrEqual(64);
  expect(iconSearchStats().references).toBeLessThanOrEqual(8192);
  expect(iconSearchStats().indexBytes).toBeLessThan(16 * 1024 * 1024);
});
it('preserves ranked results and tie order through indexed substring candidates', async () => {
  const { NERD_FONT_ICONS } = await import('./nerdFontIcons');
  for (const query of ['a', 'bu', 'bug', 'font awesome', 'arrow left', 'nf-md-', 'xyzxyz']) {
    const score = (entry: (typeof NERD_FONT_ICONS)[number]) => {
      if (entry.idLower === query || entry.nameLower === query) return 0;
      if (entry.nameLower.startsWith(query)) return 1;
      if (entry.idLower.startsWith(query)) return 2;
      if (entry.categoryLower.startsWith(query)) return 3;
      const word = entry.nameWords.findIndex((word) => word.startsWith(query));
      return word >= 0 ? 4 + word : entry.searchText.includes(query) ? 12 : Infinity;
    };
    const expected = NERD_FONT_ICONS.filter((entry) => Number.isFinite(score(entry)))
      .sort((a, b) => score(a) - score(b))
      .slice(0, 17);
    expect(searchNerdFontIcons(`icon ${query}`, 17)).toEqual(expected);
  }
});
