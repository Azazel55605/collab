import type { InkBounds, InkObject, InkScene } from '../../types/ink';

import { boundsOf, expandSelection } from './operations';
import { selectionRotationOf } from './transform';

export interface InkSelectionFrame {
  centerX: number;
  centerY: number;
  width: number;
  height: number;
  rotation: number;
}

interface Point {
  x: number;
  y: number;
}

function axisAlignedFrame(bounds: InkBounds): InkSelectionFrame {
  return {
    centerX: (bounds.minX + bounds.maxX) / 2,
    centerY: (bounds.minY + bounds.maxY) / 2,
    width: bounds.maxX - bounds.minX,
    height: bounds.maxY - bounds.minY,
    rotation: 0,
  };
}

function pointsOf(object: InkObject): { points: Point[]; padding: number } | null {
  if (object.type === 'shape') {
    const points: Point[] = [];
    for (let index = 0; index + 1 < object.points.length; index += 2) {
      points.push({ x: object.points[index], y: object.points[index + 1] });
    }
    return { points, padding: object.stroke.width / 2 };
  }
  if (object.type === 'connector') {
    return {
      points: [
        { x: object.from.x, y: object.from.y },
        { x: object.to.x, y: object.to.y },
      ],
      padding: object.stroke.width / 2,
    };
  }
  return null;
}

function vectorFrame(object: InkObject): InkSelectionFrame | null {
  const geometry = pointsOf(object);
  if (!geometry || geometry.points.length === 0) return null;
  const rotation = selectionRotationOf(object);
  const cos = Math.cos(rotation);
  const sin = Math.sin(rotation);
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const point of geometry.points) {
    const localX = point.x * cos + point.y * sin;
    const localY = -point.x * sin + point.y * cos;
    minX = Math.min(minX, localX);
    minY = Math.min(minY, localY);
    maxX = Math.max(maxX, localX);
    maxY = Math.max(maxY, localY);
  }
  minX -= geometry.padding;
  minY -= geometry.padding;
  maxX += geometry.padding;
  maxY += geometry.padding;
  const localCenterX = (minX + maxX) / 2;
  const localCenterY = (minY + maxY) / 2;
  return {
    centerX: localCenterX * cos - localCenterY * sin,
    centerY: localCenterX * sin + localCenterY * cos,
    width: maxX - minX,
    height: maxY - minY,
    rotation,
  };
}

/**
 * Returns the editor frame for a selection.
 *
 * A single oriented vector or box keeps its local axes. Mixed selections use
 * an axis-aligned union because they do not have one unambiguous orientation.
 */
export function selectionFrame(scene: InkScene, selectedIds: string[]): InkSelectionFrame | null {
  const expanded = expandSelection(scene, selectedIds).filter((id) => scene.objects[id]);
  if (expanded.length === 1) {
    const object = scene.objects[expanded[0]];
    if (object.type === 'text' || object.type === 'image' || object.type === 'stamp') {
      return {
        centerX: object.x + object.width / 2,
        centerY: object.y + object.height / 2,
        width: object.width,
        height: object.height,
        rotation: object.rotation ?? 0,
      };
    }
    const vector = vectorFrame(object);
    if (vector) return vector;
  }
  const bounds = boundsOf(scene, selectedIds);
  return bounds ? axisAlignedFrame(bounds) : null;
}

export function frameCorners(frame: InkSelectionFrame): [Point, Point, Point, Point] {
  const cos = Math.cos(frame.rotation);
  const sin = Math.sin(frame.rotation);
  const halfWidth = frame.width / 2;
  const halfHeight = frame.height / 2;
  const point = (x: number, y: number): Point => ({
    x: frame.centerX + x * cos - y * sin,
    y: frame.centerY + x * sin + y * cos,
  });
  return [
    point(-halfWidth, -halfHeight),
    point(halfWidth, -halfHeight),
    point(halfWidth, halfHeight),
    point(-halfWidth, halfHeight),
  ];
}
