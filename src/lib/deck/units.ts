/**
 * The one place deck units are converted.
 *
 * Stored geometry is integer deck units (1/100 pt). Editing converts to CSS
 * pixels, PowerPoint export converts to EMU, and nothing else invents its own
 * factor — a second conversion is how a slide ends up a pixel off in export.
 */
import {
  DECK_EMU_PER_UNIT,
  DECK_ROTATION_FULL_TURN,
  DECK_ROTATION_UNITS_PER_DEGREE,
  DECK_UNITS_PER_INCH,
  DECK_UNITS_PER_POINT,
  DECK_UNITS_PER_PX,
} from '../../types/deck';

/** OOXML stores angles in 60,000ths of a degree. */
const OOXML_ANGLE_PER_DEGREE = 60_000;
const EMU_PER_INCH = 914_400;

export function unitsToPx(units: number, zoom = 1): number {
  return (units / DECK_UNITS_PER_PX) * zoom;
}

/** Nearest deck unit for an on-screen distance. Edits always store integers. */
export function pxToUnits(px: number, zoom = 1): number {
  return Math.round((px / zoom) * DECK_UNITS_PER_PX);
}

export function unitsToPoints(units: number): number {
  return units / DECK_UNITS_PER_POINT;
}

export function pointsToUnits(points: number): number {
  return Math.round(points * DECK_UNITS_PER_POINT);
}

export function unitsToInches(units: number): number {
  return units / DECK_UNITS_PER_INCH;
}

/** Exact: every deck unit is a whole number of EMU. */
export function unitsToEmu(units: number): number {
  return units * DECK_EMU_PER_UNIT;
}

/** Nearest deck unit for an EMU value, for the future importer. */
export function emuToUnits(emu: number): number {
  return Math.round(emu / DECK_EMU_PER_UNIT);
}

export function emuToInches(emu: number): number {
  return emu / EMU_PER_INCH;
}

/** Folds any integer rotation into [0, 36000). */
export function normalizeRotation(rotation: number): number {
  const folded = Math.round(rotation) % DECK_ROTATION_FULL_TURN;
  return folded < 0 ? folded + DECK_ROTATION_FULL_TURN : folded;
}

export function rotationToDegrees(rotation: number): number {
  return normalizeRotation(rotation) / DECK_ROTATION_UNITS_PER_DEGREE;
}

export function degreesToRotation(degrees: number): number {
  return normalizeRotation(Math.round(degrees * DECK_ROTATION_UNITS_PER_DEGREE));
}

/** OOXML `rot` attribute value. Exact: 600 per stored unit. */
export function rotationToOoxml(rotation: number): number {
  return normalizeRotation(rotation) * (OOXML_ANGLE_PER_DEGREE / DECK_ROTATION_UNITS_PER_DEGREE);
}
