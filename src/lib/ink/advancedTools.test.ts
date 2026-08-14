import { describe, expect, it } from 'vitest';

import type { InkBrushParameters, InkStroke } from '../../types/ink';
import { encodeSamples, decodeSamples } from './codec';
import {
  createInkConnector,
  createInkShape,
  createInkStamp,
  inkObjectColor,
  recognizeInkShape,
  recognizeStraightStroke,
  recolorInkObject,
  shapePoints,
  shouldHoldToStraighten,
  smoothInkStroke,
  snapInkPoint,
  snapPointToAngle,
} from './advancedTools';

const brush: InkBrushParameters = {
  kind: 'technical',
  color: '#102030',
  opacity: 1,
  width: 96,
  thinning: 0,
  smoothing: 0.5,
  streamline: 0,
  taperStart: 0,
  taperEnd: 0,
};

function stroke(points: Array<{ x: number; y: number }>): InkStroke {
  return {
    id: 'stroke-1',
    type: 'stroke',
    layerId: 'layer-1',
    brush,
    samples: encodeSamples(points),
  };
}

describe('advanced ink tools', () => {
  it('snaps endpoints to a bounded document grid', () => {
    expect(snapInkPoint({ x: 740, y: 1_170 }, { enabled: true, spacing: 768 }))
      .toEqual({ x: 768, y: 1_536 });
    expect(snapInkPoint({ x: 740, y: 1_170 }, { enabled: false, spacing: 768 }))
      .toEqual({ x: 740, y: 1_170 });
  });

  it('builds deterministic geometry and honours the uniform modifier', () => {
    expect(shapePoints('rectangle', { x: 0, y: 0 }, { x: 100, y: 40 }, true))
      .toEqual([0, 0, 100, 0, 100, 100, 0, 100]);
    expect(shapePoints('ellipse', { x: 0, y: 0 }, { x: 100, y: 50 })).toHaveLength(64);
  });

  it('creates styled shapes and arrow connectors without mutable preset references', () => {
    const shape = createInkShape({
      id: 'shape-1', layerId: 'layer-1', kind: 'diamond',
      from: { x: 0, y: 0 }, to: { x: 200, y: 100 },
      style: { stroke: brush, fill: '#fff', fillOpacity: 0.4 },
    });
    const connector = createInkConnector({
      id: 'connector-1', layerId: 'layer-1',
      from: { x: 0, y: 0 }, to: { x: 200, y: 100 }, stroke: brush,
    });
    expect(shape.points).toEqual([100, 0, 200, 50, 100, 100, 0, 50]);
    expect(shape.stroke).not.toBe(brush);
    expect(connector.arrowEnd).toBe('arrow');
  });

  it('creates stamps and snaps protractor lines to fixed angles', () => {
    expect(createInkStamp({
      id: 'stamp', layerId: 'layer-1', symbolId: 'check',
      from: { x: 0, y: 0 }, to: { x: 100, y: 200 }, color: '#123456',
    })).toMatchObject({ type: 'stamp', symbolId: 'check', color: '#123456' });
    const snapped = snapPointToAngle({ x: 0, y: 0 }, { x: 100, y: 20 }, 15);
    expect(Math.atan2(snapped.y, snapped.x)).toBeCloseTo(Math.PI / 12, 2);
    expect(inkObjectColor(stroke([{ x: 0, y: 0 }, { x: 100, y: 0 }]))).toBe('#102030');
  });

  it('recognizes only convincingly straight strokes and retains source identity', () => {
    const straight = stroke([{ x: 0, y: 0 }, { x: 50, y: 1 }, { x: 100, y: 0 }]);
    const bent = stroke([{ x: 0, y: 0 }, { x: 50, y: 40 }, { x: 100, y: 0 }]);
    expect(recognizeStraightStroke(straight)).toMatchObject({
      id: 'stroke-1', type: 'shape', shape: 'line', sourceStrokeId: 'stroke-1',
    });
    expect(recognizeStraightStroke(bent)).toBeNull();
  });

  it('recognizes closed rectangles and ellipses without mutating the source stroke', () => {
    const rectangle = stroke([
      { x: 0, y: 0 }, { x: 50, y: 0 }, { x: 100, y: 0 },
      { x: 100, y: 50 }, { x: 100, y: 100 }, { x: 50, y: 100 },
      { x: 0, y: 100 }, { x: 0, y: 50 }, { x: 0, y: 0 },
    ]);
    const ellipse = stroke(Array.from({ length: 25 }, (_, index) => {
      const angle = (index / 24) * Math.PI * 2;
      return { x: Math.round(100 + Math.cos(angle) * 100), y: Math.round(80 + Math.sin(angle) * 80) };
    }));
    expect(recognizeInkShape(rectangle)).toMatchObject({ shape: 'rectangle', sourceStrokeId: rectangle.id });
    expect(recognizeInkShape(ellipse)).toMatchObject({ shape: 'ellipse', sourceStrokeId: ellipse.id });
    expect(rectangle.type).toBe('stroke');
  });

  it('requires both a hold and straight geometry for hold-to-straighten', () => {
    const samples = [{ x: 0, y: 0 }, { x: 50, y: 0 }, { x: 100, y: 0 }];
    expect(shouldHoldToStraighten(samples, 499)).toBe(false);
    expect(shouldHoldToStraighten(samples, 500)).toBe(true);
  });

  it('smooths interior points without moving endpoints and recolors supported objects', () => {
    const source = stroke([{ x: 0, y: 0 }, { x: 50, y: 30 }, { x: 100, y: 0 }]);
    const smoothed = decodeSamples(smoothInkStroke(source, 1).samples);
    expect(smoothed[0]).toMatchObject({ x: 0, y: 0 });
    expect(smoothed[1].y).toBe(10);
    expect(smoothed[2]).toMatchObject({ x: 100, y: 0 });
    expect(recolorInkObject(source, '#abcdef')).toMatchObject({ brush: { color: '#abcdef' } });
  });
});
