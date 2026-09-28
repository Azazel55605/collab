/**
 * Preset shape outlines, in a shape's local box (0,0)-(width,height).
 *
 * Every preset maps to an OOXML `prstGeom` of the same name, and the outlines
 * here follow those presets' default adjustment values (for example a
 * `roundRect` corner is 16.667% of the shorter side, an arrow shaft is half the
 * height). They are close approximations of PowerPoint's formulas, not ports of
 * them: porting `presetShapeDefinitions.xml` exactly is Phase 4 work, and the
 * difference is part of the documented export tolerance until then.
 */
import type { DeckShapeGeometry } from '../../types/deck';

type Point = [number, number];

function polygon(points: Point[]): string {
  return `${points.map(([x, y], index) => `${index === 0 ? 'M' : 'L'}${fmt(x)} ${fmt(y)}`).join(' ')} Z`;
}

/** Fixed-precision number formatting: output must be byte-stable. */
export function fmt(value: number): string {
  const rounded = Math.round(value * 100) / 100;
  return Object.is(rounded, -0) ? '0' : String(rounded);
}

/** OOXML preset name for each geometry. They are deliberately identical. */
export const OOXML_PRESET: Record<DeckShapeGeometry, string> = {
  rect: 'rect',
  roundRect: 'roundRect',
  ellipse: 'ellipse',
  triangle: 'triangle',
  rightTriangle: 'rtTriangle',
  diamond: 'diamond',
  pentagon: 'pentagon',
  hexagon: 'hexagon',
  rightArrow: 'rightArrow',
  leftArrow: 'leftArrow',
  upArrow: 'upArrow',
  downArrow: 'downArrow',
  chevron: 'chevron',
  star5: 'star5',
};

function regular(sides: number, width: number, height: number, rotation = -Math.PI / 2): Point[] {
  return Array.from({ length: sides }, (_, index) => {
    const angle = rotation + (index * 2 * Math.PI) / sides;
    return [width / 2 + (Math.cos(angle) * width) / 2, height / 2 + (Math.sin(angle) * height) / 2];
  });
}

/** SVG path data for a preset in its local box. */
export function shapePath(geometry: DeckShapeGeometry, width: number, height: number): string {
  const w = width;
  const h = height;
  const ss = Math.min(w, h);
  switch (geometry) {
    case 'rect':
      return polygon([
        [0, 0],
        [w, 0],
        [w, h],
        [0, h],
      ]);
    case 'roundRect': {
      const r = ss * 0.16667;
      return [
        `M${fmt(r)} 0`,
        `L${fmt(w - r)} 0`,
        `A${fmt(r)} ${fmt(r)} 0 0 1 ${fmt(w)} ${fmt(r)}`,
        `L${fmt(w)} ${fmt(h - r)}`,
        `A${fmt(r)} ${fmt(r)} 0 0 1 ${fmt(w - r)} ${fmt(h)}`,
        `L${fmt(r)} ${fmt(h)}`,
        `A${fmt(r)} ${fmt(r)} 0 0 1 0 ${fmt(h - r)}`,
        `L0 ${fmt(r)}`,
        `A${fmt(r)} ${fmt(r)} 0 0 1 ${fmt(r)} 0`,
        'Z',
      ].join(' ');
    }
    case 'ellipse':
      return [
        `M0 ${fmt(h / 2)}`,
        `A${fmt(w / 2)} ${fmt(h / 2)} 0 1 1 ${fmt(w)} ${fmt(h / 2)}`,
        `A${fmt(w / 2)} ${fmt(h / 2)} 0 1 1 0 ${fmt(h / 2)}`,
        'Z',
      ].join(' ');
    case 'triangle':
      return polygon([
        [w / 2, 0],
        [w, h],
        [0, h],
      ]);
    case 'rightTriangle':
      return polygon([
        [0, 0],
        [w, h],
        [0, h],
      ]);
    case 'diamond':
      return polygon([
        [w / 2, 0],
        [w, h / 2],
        [w / 2, h],
        [0, h / 2],
      ]);
    case 'pentagon':
      return polygon(regular(5, w, h));
    case 'hexagon': {
      const inset = ss * 0.25;
      return polygon([
        [inset, 0],
        [w - inset, 0],
        [w, h / 2],
        [w - inset, h],
        [inset, h],
        [0, h / 2],
      ]);
    }
    case 'rightArrow':
    case 'leftArrow': {
      const head = ss * 0.5;
      const points: Point[] = [
        [0, h * 0.25],
        [w - head, h * 0.25],
        [w - head, 0],
        [w, h / 2],
        [w - head, h],
        [w - head, h * 0.75],
        [0, h * 0.75],
      ];
      return polygon(geometry === 'rightArrow' ? points : points.map(([x, y]) => [w - x, y]));
    }
    case 'upArrow':
    case 'downArrow': {
      const head = ss * 0.5;
      const points: Point[] = [
        [w * 0.25, h],
        [w * 0.25, head],
        [0, head],
        [w / 2, 0],
        [w, head],
        [w * 0.75, head],
        [w * 0.75, h],
      ];
      return polygon(geometry === 'upArrow' ? points : points.map(([x, y]) => [x, h - y]));
    }
    case 'chevron': {
      const depth = ss * 0.5;
      return polygon([
        [0, 0],
        [w - depth, 0],
        [w, h / 2],
        [w - depth, h],
        [0, h],
        [depth, h / 2],
      ]);
    }
    case 'star5': {
      const outer = regular(5, w, h);
      const inner = regular(5, w * 0.38, h * 0.38, -Math.PI / 2 + Math.PI / 5).map(
        ([x, y]): Point => [x + w * 0.31, y + h * 0.31],
      );
      return polygon(outer.flatMap((point, index) => [point, inner[index]]));
    }
  }
}
