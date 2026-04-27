import { describe, expect, it } from 'vitest';

import {
  createColorPreviewExtension,
  findColorPreviewMatches,
  formatColorForClipboard,
  tryParseColor,
} from './colorPreview';

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
    expect(matches[0]).toEqual(expect.objectContaining({ from: 17, to: 24, source: '#ff0000' }));
  });

  it('returns an empty extension when previews are disabled', () => {
    expect(createColorPreviewExtension({
      enabled: false,
      showSwatch: true,
      tintText: true,
      formats: { hex: true, rgb: true, hsl: true, oklch: true, oklab: true },
    })).toEqual([]);
  });

  it('formats copied colors in multiple output styles', () => {
    const parsed = tryParseColor('#fe452f');
    expect(parsed).not.toBeNull();
    expect(formatColorForClipboard(parsed!, 'original', '#fe452f')).toBe('#fe452f');
    expect(formatColorForClipboard(parsed!, 'hex', '#fe452f')).toBe('#fe452f');
    expect(formatColorForClipboard(parsed!, 'rgb', '#fe452f')).toBe('rgb(254, 69, 47)');
    expect(formatColorForClipboard(parsed!, 'hsl', '#fe452f')).toBe('hsl(6deg 99% 59%)');
  });

  it('preserves alpha when formatting non-opaque colors', () => {
    const parsed = tryParseColor('rgba(255, 0, 0, 0.5)');
    expect(parsed).not.toBeNull();
    expect(formatColorForClipboard(parsed!, 'hex', 'rgba(255, 0, 0, 0.5)')).toBe('#ff000080');
    expect(formatColorForClipboard(parsed!, 'rgb', 'rgba(255, 0, 0, 0.5)')).toBe('rgba(255, 0, 0, 0.5)');
    expect(formatColorForClipboard(parsed!, 'hsl', 'rgba(255, 0, 0, 0.5)')).toBe('hsl(0deg 100% 50% / 0.5)');
  });
});
