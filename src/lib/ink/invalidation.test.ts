import { describe, expect, it } from 'vitest';

import { createInkPage } from './document';
import { FIXTURE_BRUSH } from './fixture';
import { planInkPageInvalidation } from './invalidation';
import { addObject, removeObject, reorderObjects, updateLayer, updateObject } from './operations';
import { transformObject, translation } from './transform';

function pageWithShapes() {
  const page = createInkPage('page-1');
  const layerId = page.scene.layerOrder[0];
  let scene = addObject(page.scene, {
    id: 'a',
    type: 'shape',
    layerId,
    shape: 'rectangle',
    points: [0, 0, 100, 0, 100, 100, 0, 100],
    stroke: FIXTURE_BRUSH,
  }).result;
  scene = addObject(scene, {
    id: 'b',
    type: 'shape',
    layerId,
    shape: 'rectangle',
    points: [1_000, 1_000, 1_100, 1_000, 1_100, 1_100, 1_000, 1_100],
    stroke: FIXTURE_BRUSH,
  }).result;
  return { ...page, scene };
}

describe('planInkPageInvalidation', () => {
  it('invalidates only the old and new bounds of a transformed object', () => {
    const before = pageWithShapes();
    const after = {
      ...before,
      scene: updateObject(before.scene, 'a', (object) =>
        transformObject(object, translation(500, 250)),
      ).result,
    };
    const plan = planInkPageInvalidation(before, after);
    expect(plan.kind).toBe('bounds');
    if (plan.kind === 'bounds') expect(plan.bounds).toHaveLength(2);
  });

  it('keeps object additions and removals bounded', () => {
    const before = pageWithShapes();
    const after = { ...before, scene: removeObject(before.scene, 'a').result };
    expect(planInkPageInvalidation(before, after).kind).toBe('bounds');
  });

  it('fully invalidates a paint-order or page-background change', () => {
    const before = pageWithShapes();
    const reordered = { ...before, scene: reorderObjects(before.scene, ['a'], 'front').result };
    expect(planInkPageInvalidation(before, reordered).kind).toBe('all');
    expect(
      planInkPageInvalidation(before, {
        ...before,
        background: { ...before.background, pattern: 'grid' },
      }).kind,
    ).toBe('all');
  });

  it('invalidates objects on a layer whose visibility changes', () => {
    const before = pageWithShapes();
    const layerId = before.scene.layerOrder[0];
    const after = {
      ...before,
      scene: updateLayer(before.scene, layerId, (layer) => ({ ...layer, visible: false })).result,
    };
    const plan = planInkPageInvalidation(before, after);
    expect(plan.kind).toBe('bounds');
    if (plan.kind === 'bounds') expect(plan.bounds.length).toBeGreaterThanOrEqual(2);
  });
});
