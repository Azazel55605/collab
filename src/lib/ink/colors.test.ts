import { describe, expect, it } from 'vitest';

import {
  canonicalInkColor,
  INK_COLOR_TOKENS,
  INK_DARK_PALETTE,
  INK_LIGHT_PALETTE,
  inkExportPalette,
  inkPaletteForTheme,
  resolveInkColor,
} from './colors';

describe('theme-aware ink colours', () => {
  it('adapts semantic foreground ink to light and dark app themes', () => {
    expect(resolveInkColor(INK_COLOR_TOKENS.foreground, inkPaletteForTheme('light'))).toBe(
      INK_LIGHT_PALETTE.foreground,
    );
    expect(resolveInkColor(INK_COLOR_TOKENS.foreground, inkPaletteForTheme('dark'))).toBe(
      INK_DARK_PALETTE.foreground,
    );
  });

  it('keeps literal custom colours unchanged', () => {
    expect(resolveInkColor('#123456', INK_DARK_PALETTE)).toBe('#123456');
  });

  it('adapts the original built-in dark ink for existing documents', () => {
    expect(resolveInkColor('#1f2933', INK_DARK_PALETTE)).toBe(INK_DARK_PALETTE.foreground);
    expect(canonicalInkColor('#1f2933')).toBe(INK_COLOR_TOKENS.foreground);
  });

  it('uses the explicit page or export surface instead of the app theme', () => {
    expect(inkPaletteForTheme('dark', '#ffffff').foreground).toBe(INK_LIGHT_PALETTE.foreground);
    expect(inkPaletteForTheme('light', '#101114').foreground).toBe(INK_DARK_PALETTE.foreground);
    expect(inkPaletteForTheme('light', 'oklch(0.12 0.01 264)').foreground).toBe(
      INK_DARK_PALETTE.foreground,
    );
    expect(inkExportPalette('#101114').foreground).toBe(INK_DARK_PALETTE.foreground);
  });
});
