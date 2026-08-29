import { describe, expect, it } from 'vitest';

import type { InkObject, InkScene } from '../../types/ink';

import { alignObjects, distributeObjects } from './align';
import { objectBounds } from './svg';

/** Boxes are the clearest fixture here: their bounds are exact, not outlined. */
function boxScene(
  boxes: Array<{ id: string; x: number; y: number; w: number; h: number }>,
): InkScene {
  const objects: Record<string, InkObject> = {};
  const objectOrder: string[] = [];
  for (const box of boxes) {
    objects[box.id] = {
      id: box.id,
      type: 'text',
      layerId: 'layer-1',
      x: box.x,
      y: box.y,
      width: box.w,
      height: box.h,
      text: box.id,
      color: '#000',
      fontSize: 12,
    };
    objectOrder.push(box.id);
  }
  return {
    layers: { 'layer-1': { id: 'layer-1', name: 'L', visible: true, locked: false, opacity: 1 } },
    layerOrder: ['layer-1'],
    objects,
    objectOrder,
  };
}

const THREE = () =>
  boxScene([
    { id: 'a', x: 0, y: 0, w: 100, h: 100 },
    { id: 'b', x: 200, y: 50, w: 60, h: 60 },
    { id: 'c', x: 400, y: 200, w: 40, h: 40 },
  ]);

function boundsOfId(scene: InkScene, id: string) {
  return objectBounds(scene.objects[id])!;
}

describe('alignObjects', () => {
  it('aligns left, right, and horizontal centre to the selection box', () => {
    const scene = THREE();
    const left = alignObjects(scene, ['a', 'b', 'c'], 'left').result;
    for (const id of ['a', 'b', 'c']) expect(boundsOfId(left, id).minX).toBe(0);

    const right = alignObjects(scene, ['a', 'b', 'c'], 'right').result;
    for (const id of ['a', 'b', 'c']) expect(boundsOfId(right, id).maxX).toBe(440);

    const centre = alignObjects(scene, ['a', 'b', 'c'], 'center-horizontal').result;
    const centres = ['a', 'b', 'c'].map((id) => {
      const bounds = boundsOfId(centre, id);
      return (bounds.minX + bounds.maxX) / 2;
    });
    expect(centres[1]).toBeCloseTo(centres[0], 6);
    expect(centres[2]).toBeCloseTo(centres[0], 6);
  });

  it('aligns top, bottom, and vertical centre', () => {
    const scene = THREE();
    const top = alignObjects(scene, ['a', 'b', 'c'], 'top').result;
    for (const id of ['a', 'b', 'c']) expect(boundsOfId(top, id).minY).toBe(0);

    const bottom = alignObjects(scene, ['a', 'b', 'c'], 'bottom').result;
    for (const id of ['a', 'b', 'c']) expect(boundsOfId(bottom, id).maxY).toBe(240);
  });

  it('is reversible', () => {
    const scene = THREE();
    const edit = alignObjects(scene, ['a', 'b', 'c'], 'left');
    expect(edit.inverse(edit.result).result).toEqual(scene);
  });

  it('does nothing for fewer than two objects', () => {
    const scene = THREE();
    expect(alignObjects(scene, ['a'], 'left').result).toBe(scene);
    expect(alignObjects(scene, [], 'left').result).toBe(scene);
  });

  it('leaves an already-aligned selection untouched', () => {
    const scene = boxScene([
      { id: 'a', x: 0, y: 0, w: 100, h: 100 },
      { id: 'b', x: 0, y: 200, w: 60, h: 60 },
    ]);
    expect(alignObjects(scene, ['a', 'b'], 'left').result).toEqual(scene);
  });
});

describe('distributeObjects', () => {
  it('leaves the outermost objects where they are', () => {
    // Moving them would change the selection's overall footprint, which is not
    // what the user asked for.
    const scene = THREE();
    const result = distributeObjects(scene, ['a', 'b', 'c'], 'horizontal').result;
    expect(boundsOfId(result, 'a')).toEqual(boundsOfId(scene, 'a'));
    expect(boundsOfId(result, 'c')).toEqual(boundsOfId(scene, 'c'));
  });

  it('equalizes the gaps between edges, not between centres', () => {
    // Differently sized objects have to *look* evenly spaced, which means the
    // space between them is what has to be equal.
    const scene = THREE();
    const result = distributeObjects(scene, ['a', 'b', 'c'], 'horizontal').result;

    const a = boundsOfId(result, 'a');
    const b = boundsOfId(result, 'b');
    const c = boundsOfId(result, 'c');
    expect(b.minX - a.maxX).toBeCloseTo(c.minX - b.maxX, 6);
  });

  it('distributes vertically too', () => {
    const scene = boxScene([
      { id: 'a', x: 0, y: 0, w: 40, h: 100 },
      { id: 'b', x: 0, y: 120, w: 40, h: 20 },
      { id: 'c', x: 0, y: 400, w: 40, h: 60 },
    ]);
    const result = distributeObjects(scene, ['a', 'b', 'c'], 'vertical').result;
    const a = boundsOfId(result, 'a');
    const b = boundsOfId(result, 'b');
    const c = boundsOfId(result, 'c');
    expect(b.minY - a.maxY).toBeCloseTo(c.minY - b.maxY, 6);
  });

  it('is reversible', () => {
    const scene = THREE();
    const edit = distributeObjects(scene, ['a', 'b', 'c'], 'horizontal');
    expect(edit.inverse(edit.result).result).toEqual(scene);
  });

  it('does nothing for fewer than three objects, which have no middle', () => {
    const scene = THREE();
    expect(distributeObjects(scene, ['a', 'b'], 'horizontal').result).toBe(scene);
  });

  it('handles objects supplied out of order', () => {
    const scene = THREE();
    const forwards = distributeObjects(scene, ['a', 'b', 'c'], 'horizontal').result;
    const backwards = distributeObjects(scene, ['c', 'b', 'a'], 'horizontal').result;
    expect(boundsOfId(backwards, 'b')).toEqual(boundsOfId(forwards, 'b'));
  });
});
