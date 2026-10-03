import { describe, expect, it } from 'vitest';

import { automaticFontFallbacks, effectiveFamily } from './fonts';

describe('deck font fallback', () => {
  it('uses the bundled Inter face before installed platform substitutes', () => {
    expect(automaticFontFallbacks('Inter', ['Arial', 'sans-serif'])).toEqual([
      'Inter Variable',
      'Arial',
      'system-ui',
      'sans-serif',
    ]);
  });

  it('selects the first available family from the completed stack', () => {
    const available = (family: string) => family === 'Inter Variable' || family === 'system-ui';
    expect(
      effectiveFamily({ family: 'Inter', fallbacks: ['Arial', 'sans-serif'] }, available),
    ).toBe('Inter Variable');
  });

  it('adds platform fallbacks for fonts authored without a stack', () => {
    expect(automaticFontFallbacks('Unknown Sans')).toEqual(['system-ui', 'sans-serif']);
    expect(automaticFontFallbacks('Unknown Mono')).toEqual(['ui-monospace', 'monospace']);
  });
});
