import { describe, expect, it } from 'vitest';

import type { InkConnector, InkShape } from '../../types/ink';
import { createInkScene } from './document';
import { selectionFrame } from './selectionFrame';

const stroke = {
  kind: 'ballpoint' as const,
  color: '#111111',
  opacity: 1,
  width: 20,
  thinning: 0,
  smoothing: 0,
  streamline: 0,
  taperStart: 0,
  taperEnd: 0,
};

describe('selectionFrame', () => {
  it('aligns legacy line objects that do not yet have rotation metadata', () => {
    const guide: InkShape = {
      id: 'legacy-guide', type: 'shape', shape: 'line', layerId: 'layer-1', guide: true,
      points: [0, 0, 1_000, 1_000], stroke,
    };
    const scene = createInkScene();
    scene.objects['legacy-guide'] = guide;
    scene.objectOrder.push('legacy-guide');
    const frame = selectionFrame(scene, ['legacy-guide'])!;
    expect(frame.rotation).toBeCloseTo(Math.PI / 4);
    expect(frame.width).toBeGreaterThan(1_400);
    expect(frame.height).toBeCloseTo(20);
  });

  it('keeps a rotated guide aligned with its local axes', () => {
    const guide: InkShape = {
      id: 'guide', type: 'shape', shape: 'line', layerId: 'layer-1', guide: true,
      points: [0, 0, 0, 1_000], stroke, rotation: Math.PI / 2,
    };
    const scene = createInkScene();
    scene.objects.guide = guide;
    scene.objectOrder.push('guide');
    const frame = selectionFrame(scene, ['guide'])!;
    expect(frame.rotation).toBeCloseTo(Math.PI / 2);
    expect(frame.width).toBeCloseTo(1_020);
    expect(frame.height).toBeCloseTo(20);
  });

  it('keeps a rotated connector aligned with its local axes', () => {
    const connector: InkConnector = {
      id: 'connector', type: 'connector', layerId: 'layer-1',
      from: { x: 0, y: 0 }, to: { x: 0, y: 1_000 },
      routing: 'straight', stroke, rotation: Math.PI / 2,
    };
    const scene = createInkScene();
    scene.objects.connector = connector;
    scene.objectOrder.push('connector');
    const frame = selectionFrame(scene, ['connector'])!;
    expect(frame.rotation).toBeCloseTo(Math.PI / 2);
    expect(frame.width).toBeCloseTo(1_020);
    expect(frame.height).toBeCloseTo(20);
  });
});
