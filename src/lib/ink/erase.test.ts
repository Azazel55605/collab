import { describe, expect, it } from 'vitest';

import type { InkSample, InkScene } from '../../types/ink';
import { decodeSamples, encodeSamples } from './codec';
import { strokeOf } from './document';
import { applyErase, planErase, splitStrokeAroundEraser } from './erase';
import { FIXTURE_BRUSH } from './fixture';

/** A straight horizontal stroke from (0,0) to (10000,0), 21 samples. */
function line(): InkSample[] {
  return Array.from({ length: 21 }, (_, index) => ({ x: index * 500, y: 0 }));
}

function sceneWithLine(id = 's1'): InkScene {
  return {
    layers: { 'layer-1': { id: 'layer-1', name: 'L', visible: true, locked: false, opacity: 1 } },
    layerOrder: ['layer-1'],
    objects: {
      [id]: {
        id,
        type: 'stroke',
        layerId: 'layer-1',
        brush: { ...FIXTURE_BRUSH, thinning: 0 },
        samples: encodeSamples(line()),
      },
    },
    objectOrder: [id],
  };
}

describe('splitStrokeAroundEraser', () => {
  it('cuts a stroke in two when the eraser crosses its middle', () => {
    const runs = splitStrokeAroundEraser(line(), [{ x: 5_000, y: 0 }], 600);
    expect(runs).toHaveLength(2);
    expect(runs[0][0].x).toBe(0);
    expect(runs[1][runs[1].length - 1].x).toBe(10_000);
  });

  it('leaves the stroke whole when the eraser misses', () => {
    const runs = splitStrokeAroundEraser(line(), [{ x: 5_000, y: 50_000 }], 600);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toHaveLength(21);
  });

  it('removes everything when the eraser covers the whole stroke', () => {
    const runs = splitStrokeAroundEraser(line(), [{ x: 0, y: 0 }, { x: 10_000, y: 0 }], 600);
    expect(runs).toEqual([]);
  });

  it('drops a one-sample leftover rather than leaving eraser debris', () => {
    // A single surviving point renders as a dot the user never drew.
    const runs = splitStrokeAroundEraser(line(), [{ x: 750, y: 0 }, { x: 10_000, y: 0 }], 600);
    for (const run of runs) expect(run.length).toBeGreaterThan(1);
  });

  it('cuts along a dragged eraser path, not just a point', () => {
    const path = [
      { x: 3_000, y: -1_000 },
      { x: 3_000, y: 1_000 },
    ];
    expect(splitStrokeAroundEraser(line(), path, 300)).toHaveLength(2);
  });

  it('clips only the covered part of a long stored segment', () => {
    const sparse = [{ x: 0, y: 0 }, { x: 10_000, y: 0 }];
    const runs = splitStrokeAroundEraser(sparse, [{ x: 5_000, y: 0 }], 300);
    expect(runs).toHaveLength(2);
    expect(runs[0][runs[0].length - 1].x).toBeGreaterThan(4_000);
    expect(runs[1][0].x).toBeLessThan(6_000);
  });
});

describe('planErase', () => {
  it('removes the whole stroke in stroke mode', () => {
    const scene = sceneWithLine();
    const plan = planErase(scene, [{ x: 5_000, y: 0 }], 600, 'stroke');
    expect(plan.removedIds).toEqual(['s1']);
    expect(plan.replacements).toEqual([]);
  });

  it('splits into replacements in segment mode', () => {
    const scene = sceneWithLine();
    const plan = planErase(scene, [{ x: 5_000, y: 0 }], 400, 'segment');
    expect(plan.removedIds).toEqual(['s1']);
    expect(plan.replacements.length).toBeGreaterThan(1);
    // Deterministic ids, so two peers computing the same erase agree.
    expect(plan.replacements.map((stroke) => stroke.id)).toEqual(['s1~e0', 's1~e1']);
  });

  it('reaches the edge of a thick line, not only its centre', () => {
    // Otherwise a broad marker needs the eraser dragged through its middle.
    const scene = sceneWithLine();
    const offset = FIXTURE_BRUSH.width / 2 - 4;
    const plan = planErase(scene, [{ x: 5_000, y: offset }], 8, 'segment');
    expect(plan.removedIds).toEqual(['s1']);
  });

  it('does nothing when the eraser misses', () => {
    const scene = sceneWithLine();
    expect(planErase(scene, [{ x: 5_000, y: 90_000 }], 100, 'segment')).toEqual({
      removedIds: [],
      replacements: [],
    });
  });

  it('leaves a stroke alone when the eraser only grazes without cutting', () => {
    const scene = sceneWithLine();
    // Inside the hit-test radius but not close enough to remove any sample.
    const plan = planErase(scene, [{ x: 5_000, y: 200 }], 1, 'segment');
    expect(plan.removedIds).toEqual([]);
  });

  it('does not delete a text box in stroke or segment mode', () => {
    // Rubbing over a note must not delete the note.
    const scene = sceneWithLine();
    scene.objects.note = {
      id: 'note', type: 'text', layerId: 'layer-1',
      x: 4_800, y: -200, width: 500, height: 400,
      text: 'keep me', color: '#000', fontSize: 96,
    };
    scene.objectOrder.push('note');

    for (const mode of ['stroke', 'segment'] as const) {
      expect(planErase(scene, [{ x: 5_000, y: 0 }], 600, mode).removedIds).not.toContain('note');
    }
    expect(planErase(scene, [{ x: 5_000, y: 0 }], 600, 'object').removedIds).toContain('note');
  });

  it('does nothing for an empty path', () => {
    expect(planErase(sceneWithLine(), [], 600, 'stroke')).toEqual({
      removedIds: [],
      replacements: [],
    });
  });
});

describe('applyErase', () => {
  it('is reversible', () => {
    const scene = sceneWithLine();
    const plan = planErase(scene, [{ x: 5_000, y: 0 }], 400, 'segment');
    const edit = applyErase(scene, plan);

    expect(edit.result.objects.s1).toBeUndefined();
    expect(edit.result.objectOrder).toEqual(['s1~e0', 's1~e1']);
    expect(edit.inverse(edit.result).result).toEqual(scene);
  });

  it('keeps the surviving pieces at the original stroke position in z-order', () => {
    const scene = sceneWithLine();
    scene.objects.over = {
      id: 'over', type: 'stroke', layerId: 'layer-1',
      brush: FIXTURE_BRUSH, samples: encodeSamples([{ x: 0, y: 9_000 }, { x: 100, y: 9_000 }]),
    };
    scene.objectOrder = ['s1', 'over'];

    const plan = planErase(scene, [{ x: 5_000, y: 0 }], 400, 'segment');
    const result = applyErase(scene, plan).result;
    // The pieces stay under `over`, exactly where the original sat.
    expect(result.objectOrder[result.objectOrder.length - 1]).toBe('over');
  });

  it('preserves the surviving geometry exactly', () => {
    const scene = sceneWithLine();
    const plan = planErase(scene, [{ x: 5_000, y: 0 }], 400, 'segment');
    const result = applyErase(scene, plan).result;

    const left = decodeSamples(strokeOf(result, 's1~e0')!.samples);
    expect(left[0]).toEqual({ x: 0, y: 0 });
    for (const sample of left) expect(sample.x).toBeLessThan(5_000);
  });

  it('is a no-op for an empty plan', () => {
    const scene = sceneWithLine();
    const edit = applyErase(scene, { removedIds: [], replacements: [] });
    expect(edit.result).toBe(scene);
    expect(edit.inverse(edit.result).result).toBe(scene);
  });

  it('removes a stroke entirely when nothing survives', () => {
    const scene = sceneWithLine();
    const plan = planErase(scene, [{ x: 0, y: 0 }, { x: 10_000, y: 0 }], 600, 'segment');
    const edit = applyErase(scene, plan);
    expect(edit.result.objectOrder).toEqual([]);
    expect(edit.inverse(edit.result).result).toEqual(scene);
  });
});
