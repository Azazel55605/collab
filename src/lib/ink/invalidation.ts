import type { InkBounds, InkPage, InkScene } from '../../types/ink';

import { objectBounds } from './svg';

export type InkInvalidationPlan =
  { kind: 'none' } | { kind: 'all' } | { kind: 'bounds'; bounds: InkBounds[] };

/**
 * Plans the smallest safe tile-cache invalidation for a page update.
 *
 * Scene edits structurally share every object they did not touch. That makes
 * identity a reliable and cheap change signal: ordinary drawing, erasing,
 * transforms, and text edits invalidate only their old/new bounds. Page or
 * paint-order changes fall back to a full invalidation because they can change
 * compositing without changing object geometry.
 */
export function planInkPageInvalidation(
  previous: InkPage | null,
  next: InkPage | null,
): InkInvalidationPlan {
  if (!previous && !next) return { kind: 'none' };
  if (!previous || !next || previous.id !== next.id) return { kind: 'all' };
  if (!sameBackground(previous, next)) return { kind: 'all' };

  const layerPlan = changedLayerBounds(previous.scene, next.scene);
  if (layerPlan.kind === 'all') return layerPlan;

  const orderChanged = !sameOrder(previous.scene.objectOrder, next.scene.objectOrder);
  if (orderChanged && !sameCommonOrder(previous.scene, next.scene)) return { kind: 'all' };

  const bounds = layerPlan.kind === 'bounds' ? [...layerPlan.bounds] : [];
  const ids = new Set([...Object.keys(previous.scene.objects), ...Object.keys(next.scene.objects)]);
  for (const id of ids) {
    const before = previous.scene.objects[id];
    const after = next.scene.objects[id];
    if (before === after) continue;
    const beforeBounds = before ? objectBounds(before) : null;
    const afterBounds = after ? objectBounds(after) : null;
    if (beforeBounds) bounds.push(beforeBounds);
    if (afterBounds) bounds.push(afterBounds);
  }
  return bounds.length > 0 ? { kind: 'bounds', bounds } : { kind: 'none' };
}

function sameBackground(left: InkPage, right: InkPage): boolean {
  const a = left.background;
  const b = right.background;
  return (
    a === b ||
    (a.pattern === b.pattern &&
      a.spacing === b.spacing &&
      a.color === b.color &&
      a.lineColor === b.lineColor)
  );
}

function changedLayerBounds(previous: InkScene, next: InkScene): InkInvalidationPlan {
  if (!sameOrder(previous.layerOrder, next.layerOrder)) return { kind: 'all' };
  const changed = new Set<string>();
  const ids = new Set([...Object.keys(previous.layers), ...Object.keys(next.layers)]);
  for (const id of ids) {
    const before = previous.layers[id];
    const after = next.layers[id];
    if (!before || !after) return { kind: 'all' };
    if (before.visible !== after.visible || before.opacity !== after.opacity) changed.add(id);
  }
  if (changed.size === 0) return { kind: 'bounds', bounds: [] };

  const bounds: InkBounds[] = [];
  for (const scene of [previous, next]) {
    for (const object of Object.values(scene.objects)) {
      if (!changed.has(object.layerId)) continue;
      const value = objectBounds(object);
      if (value) bounds.push(value);
    }
  }
  return { kind: 'bounds', bounds };
}

function sameOrder(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((id, index) => id === right[index]);
}

/** Adding/removing objects preserves the relative order of everything else. */
function sameCommonOrder(previous: InkScene, next: InkScene): boolean {
  const common = new Set(
    Object.keys(previous.objects).filter((id) =>
      Object.prototype.hasOwnProperty.call(next.objects, id),
    ),
  );
  const before = previous.objectOrder.filter((id) => common.has(id));
  const after = next.objectOrder.filter((id) => common.has(id));
  return sameOrder(before, after);
}
