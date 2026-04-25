import { describe, expect, it } from 'vitest';

import { createColorPreviewExtension, findColorPreviewMatches, tryParseColor } from './colorPreview';

describe('colorPreview helpers', () => {
  it('parses supported colors', () => {
    expect(tryParseColor('#ff0000')).toEqual(
      expect.objectContaining({ r: 255, g: 0, b: 0 }),
    );
    expect(tryParseColor('not-a-color')).toBeNull();
  });

  it('finds enabled color preview matches', () => {
    const matches = findColorPreviewMatches(
      'color: #ff0000; background: rgb(0, 255, 0); border: oklch(60% 0.1 200);',
      10,
      { hex: true, rgb: true, hsl: false, oklch: true, oklab: false },
    );

    expect(matches).toHaveLength(3);
    expect(matches[0]).toEqual(expect.objectContaining({ from: 17, to: 24 }));
  });

  it('returns an empty extension when previews are disabled', () => {
    expect(createColorPreviewExtension({
      enabled: false,
      showSwatch: true,
      tintText: true,
      formats: { hex: true, rgb: true, hsl: true, oklch: true, oklab: true },
    })).toEqual([]);
  });
});
