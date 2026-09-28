import { describe, expect, it } from 'vitest';

import { DECK_LIMITS, DECK_SIZE_PRESETS } from '../../types/deck';

import {
  degreesToRotation,
  emuToInches,
  emuToUnits,
  normalizeRotation,
  pxToUnits,
  rotationToDegrees,
  rotationToOoxml,
  unitsToEmu,
  unitsToInches,
  unitsToPx,
} from './units';

describe('deck units', () => {
  it('map the standard sizes onto PowerPoint EMU exactly', () => {
    // PowerPoint's widescreen slide is 12,192,000 x 6,858,000 EMU. A factor
    // that only approximated it would shift every exported element.
    expect(unitsToEmu(DECK_SIZE_PRESETS.widescreen.width)).toBe(12_192_000);
    expect(unitsToEmu(DECK_SIZE_PRESETS.widescreen.height)).toBe(6_858_000);
    expect(unitsToEmu(DECK_SIZE_PRESETS.standard.width)).toBe(9_144_000);
  });

  it('round-trips every integer unit through EMU without drift', () => {
    for (let units = -DECK_LIMITS.maxSlideSide; units <= DECK_LIMITS.maxSlideSide; units += 997) {
      expect(emuToUnits(unitsToEmu(units))).toBe(units);
    }
  });

  it('agrees with inches, which the PPTX library takes', () => {
    for (const units of [1, 7, 720, 96_000, 403_199]) {
      expect(Math.round(unitsToInches(units) * 914_400)).toBe(unitsToEmu(units));
      expect(emuToInches(unitsToEmu(units))).toBeCloseTo(unitsToInches(units), 12);
    }
  });

  it('converts to CSS pixels at 96 dpi and back to integers', () => {
    expect(unitsToPx(DECK_SIZE_PRESETS.widescreen.width)).toBe(1_280);
    expect(unitsToPx(DECK_SIZE_PRESETS.widescreen.height)).toBe(720);
    expect(unitsToPx(7_500, 2)).toBe(200);
    expect(pxToUnits(1_280)).toBe(96_000);
    expect(Number.isInteger(pxToUnits(13.37, 1.7))).toBe(true);
  });

  it('normalizes rotation into one turn and maps it to OOXML exactly', () => {
    expect(normalizeRotation(-100)).toBe(35_900);
    expect(normalizeRotation(72_050)).toBe(50);
    expect(rotationToDegrees(4_500)).toBe(45);
    expect(degreesToRotation(-90)).toBe(27_000);
    expect(rotationToOoxml(4_500)).toBe(2_700_000);
  });
});
