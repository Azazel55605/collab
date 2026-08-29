/**
 * Aligning and distributing a selection.
 *
 * Every operation here reduces to a translation per object, applied through
 * `transformObject`, so alignment inherits the same geometry baking as every
 * other transform and needs no special case in bounds, hit testing, or export.
 */
import type { InkBounds, InkScene } from '../../types/ink';

import { boundsOf, expandSelection, updateObject } from './operations';
import type { InkEdit } from './operations';
import { objectBounds } from './svg';
import { transformObject, translation } from './transform';

export type InkAlignment =
  'left' | 'center-horizontal' | 'right' | 'top' | 'center-vertical' | 'bottom';

export type InkDistribution = 'horizontal' | 'vertical';

function offsetFor(
  bounds: InkBounds,
  target: InkBounds,
  alignment: InkAlignment,
): { dx: number; dy: number } {
  switch (alignment) {
    case 'left':
      return { dx: target.minX - bounds.minX, dy: 0 };
    case 'right':
      return { dx: target.maxX - bounds.maxX, dy: 0 };
    case 'center-horizontal':
      return {
        dx: (target.minX + target.maxX) / 2 - (bounds.minX + bounds.maxX) / 2,
        dy: 0,
      };
    case 'top':
      return { dx: 0, dy: target.minY - bounds.minY };
    case 'bottom':
      return { dx: 0, dy: target.maxY - bounds.maxY };
    case 'center-vertical':
      return {
        dx: 0,
        dy: (target.minY + target.maxY) / 2 - (bounds.minY + bounds.maxY) / 2,
      };
  }
}

/** Moves each object so it aligns to the selection's own bounding box. */
export function alignObjects(
  scene: InkScene,
  objectIds: string[],
  alignment: InkAlignment,
): InkEdit<InkScene> {
  const ids = expandSelection(scene, objectIds);
  const target = boundsOf(scene, ids);
  if (!target || ids.length < 2) return { result: scene, inverse: noop };

  const edits: Array<InkEdit<InkScene>> = [];
  let result = scene;

  for (const id of ids) {
    const bounds = objectBounds(result.objects[id]);
    if (!bounds) continue;
    const { dx, dy } = offsetFor(bounds, target, alignment);
    if (dx === 0 && dy === 0) continue;
    const edit = updateObject(result, id, (object) => transformObject(object, translation(dx, dy)));
    edits.push(edit);
    result = edit.result;
  }

  return { result, inverse: reverseAll(edits, (next) => alignObjects(next, objectIds, alignment)) };
}

/**
 * Spaces objects evenly between the outermost two.
 *
 * The extremes stay put — a distribute that moved them would change the
 * selection's overall footprint, which is not what the user asked for. Gaps are
 * equalized between *edges*, not centres, so differently sized objects end up
 * looking evenly spaced rather than measuring evenly.
 */
export function distributeObjects(
  scene: InkScene,
  objectIds: string[],
  axis: InkDistribution,
): InkEdit<InkScene> {
  const ids = expandSelection(scene, objectIds);
  if (ids.length < 3) return { result: scene, inverse: noop };

  const entries = ids
    .map((id) => ({ id, bounds: objectBounds(scene.objects[id]) }))
    .filter((entry): entry is { id: string; bounds: InkBounds } => entry.bounds !== null)
    .sort((left, right) =>
      axis === 'horizontal'
        ? left.bounds.minX - right.bounds.minX
        : left.bounds.minY - right.bounds.minY,
    );
  if (entries.length < 3) return { result: scene, inverse: noop };

  const first = entries[0].bounds;
  const last = entries[entries.length - 1].bounds;
  const span = axis === 'horizontal' ? last.maxX - first.minX : last.maxY - first.minY;
  const totalSize = entries.reduce(
    (sum, entry) =>
      sum +
      (axis === 'horizontal'
        ? entry.bounds.maxX - entry.bounds.minX
        : entry.bounds.maxY - entry.bounds.minY),
    0,
  );
  const gap = (span - totalSize) / (entries.length - 1);

  const edits: Array<InkEdit<InkScene>> = [];
  let result = scene;
  let cursor = axis === 'horizontal' ? first.minX : first.minY;

  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    const size =
      axis === 'horizontal'
        ? entry.bounds.maxX - entry.bounds.minX
        : entry.bounds.maxY - entry.bounds.minY;

    if (index > 0 && index < entries.length - 1) {
      const current = axis === 'horizontal' ? entry.bounds.minX : entry.bounds.minY;
      const delta = cursor - current;
      if (delta !== 0) {
        const edit = updateObject(result, entry.id, (object) =>
          transformObject(
            object,
            axis === 'horizontal' ? translation(delta, 0) : translation(0, delta),
          ),
        );
        edits.push(edit);
        result = edit.result;
      }
    }
    cursor += size + gap;
  }

  return {
    result,
    inverse: reverseAll(edits, (next) => distributeObjects(next, objectIds, axis)),
  };
}

/** Undoes a batch of edits in reverse, then re-applies the whole operation. */
function reverseAll(edits: Array<InkEdit<InkScene>>, redo: (scene: InkScene) => InkEdit<InkScene>) {
  return (input: InkScene): InkEdit<InkScene> => {
    let reverted = input;
    for (let index = edits.length - 1; index >= 0; index -= 1) {
      reverted = edits[index].inverse(reverted).result;
    }
    return { result: reverted, inverse: redo };
  };
}

function noop(input: InkScene): InkEdit<InkScene> {
  return { result: input, inverse: noop };
}
