import { describe, expect, it } from 'vitest';

import { INK_LIMITS } from '../../types/ink';
import type { InkLayer, InkObject, InkScene } from '../../types/ink';

import { createInkDocument, createInkPage } from './document';
import { buildInkScene, buildStroke } from './fixture';
import {
  addLayer,
  addObject,
  addPage,
  boundsOf,
  duplicatePage,
  expandSelection,
  groupObjects,
  mergeLayerDown,
  moveObjectsToLayer,
  onPage,
  removeLayer,
  removeObject,
  removeObjects,
  removePage,
  reorderLayer,
  reorderObjects,
  reorderPage,
  restyleObjects,
  ungroupObject,
  updateLayer,
  updateObject,
} from './operations';
import type { InkEdit } from './operations';

function scene(strokes = 3): InkScene {
  return buildInkScene({ strokes, samplesPerStroke: 8 });
}

function layer(id: string): InkLayer {
  return { id, name: id, visible: true, locked: false, opacity: 1 };
}

/** Applies an edit then its inverse, asserting the round trip is exact. */
function expectReversible<T>(input: T, edit: InkEdit<T>): T {
  expect(edit.inverse(edit.result).result).toEqual(input);
  return edit.result;
}

describe('object operations', () => {
  it('adds an object and undoes cleanly', () => {
    const initial = scene();
    const stroke = buildStroke('new', 'layer-1', { samples: 6, x: 0, y: 0 });
    const result = expectReversible(initial, addObject(initial, stroke));
    expect(result.objectOrder[result.objectOrder.length - 1]).toBe('new');
  });

  it('refuses a duplicate object id', () => {
    const initial = scene();
    const clash = buildStroke('stroke-1', 'layer-1', { samples: 4, x: 0, y: 0 });
    expect(() => addObject(initial, clash)).toThrow(/already exists/);
  });

  it('restores a removed object to its original paint index', () => {
    // An erase followed by an undo that reinserts on top would silently
    // reorder the drawing.
    const initial = scene(5);
    const middle = initial.objectOrder[2];
    const edit = removeObject(initial, middle);
    expect(edit.result.objectOrder).not.toContain(middle);

    const undone = edit.inverse(edit.result).result;
    expect(undone.objectOrder).toEqual(initial.objectOrder);
    expect(undone.objects[middle]).toEqual(initial.objects[middle]);
  });

  it('removes many objects and restores every index', () => {
    const initial = scene(6);
    const doomed = [initial.objectOrder[1], initial.objectOrder[3], initial.objectOrder[4]];
    const edit = removeObjects(initial, doomed);
    expect(edit.result.objectOrder).toHaveLength(3);
    expect(edit.inverse(edit.result).result.objectOrder).toEqual(initial.objectOrder);
  });

  it('ignores removal of an object that is not there', () => {
    const initial = scene();
    expect(removeObject(initial, 'ghost').result).toBe(initial);
  });

  it('updates an object reversibly', () => {
    const initial = scene();
    const edit = updateObject(initial, 'stroke-1', (object) => ({ ...object, locked: true }));
    expect(edit.result.objects['stroke-1'].locked).toBe(true);
    expect(edit.inverse(edit.result).result).toEqual(initial);
  });

  it('does not mutate the input scene', () => {
    // The renderer's tile cache and the collaboration layer both key off object
    // identity to decide what changed.
    const initial = scene();
    const snapshot = JSON.parse(JSON.stringify(initial));
    addObject(initial, buildStroke('x', 'layer-1', { samples: 4, x: 0, y: 0 }));
    removeObject(initial, 'stroke-1');
    restyleObjects(initial, ['stroke-1'], { color: '#fff' });
    expect(initial).toEqual(snapshot);
  });

  it('restyles many objects reversibly', () => {
    const initial = scene(4);
    const ids = initial.objectOrder.slice(0, 2);
    const edit = restyleObjects(initial, ids, { color: '#ff0000' });
    for (const id of ids) {
      const object = edit.result.objects[id];
      if (object.type === 'stroke') expect(object.brush.color).toBe('#ff0000');
    }
    expect(edit.inverse(edit.result).result).toEqual(initial);
  });

  it('moves objects between layers reversibly', () => {
    const initial = addLayer(scene(3), layer('layer-2')).result;
    const ids = initial.objectOrder.slice(0, 2);
    const edit = moveObjectsToLayer(initial, ids, 'layer-2');
    for (const id of ids) expect(edit.result.objects[id].layerId).toBe('layer-2');
    expect(edit.inverse(edit.result).result).toEqual(initial);
  });

  it('refuses to move objects onto a layer that does not exist', () => {
    expect(() => moveObjectsToLayer(scene(), ['stroke-1'], 'ghost')).toThrow(/no layer/);
  });
});

describe('reordering', () => {
  it('brings objects to the front and back', () => {
    const initial = scene(4);
    const front = reorderObjects(initial, ['stroke-1'], 'front');
    expect(front.result.objectOrder[3]).toBe('stroke-1');
    expect(front.inverse(front.result).result.objectOrder).toEqual(initial.objectOrder);

    const back = reorderObjects(initial, ['stroke-4'], 'back');
    expect(back.result.objectOrder[0]).toBe('stroke-4');
  });

  it('steps one position forward and backward', () => {
    const initial = scene(4);
    expect(reorderObjects(initial, ['stroke-2'], 'forward').result.objectOrder).toEqual([
      'stroke-1',
      'stroke-3',
      'stroke-2',
      'stroke-4',
    ]);
    expect(reorderObjects(initial, ['stroke-3'], 'backward').result.objectOrder).toEqual([
      'stroke-1',
      'stroke-3',
      'stroke-2',
      'stroke-4',
    ]);
  });

  it('keeps a multi-selection arranged rather than collapsing it', () => {
    const initial = scene(5);
    const moved = reorderObjects(initial, ['stroke-1', 'stroke-2'], 'forward').result;
    expect(moved.objectOrder.indexOf('stroke-1')).toBeLessThan(
      moved.objectOrder.indexOf('stroke-2'),
    );
  });

  it('does nothing at the edges', () => {
    const initial = scene(3);
    expect(reorderObjects(initial, ['stroke-3'], 'forward').result.objectOrder).toEqual(
      initial.objectOrder,
    );
    expect(reorderObjects(initial, ['stroke-1'], 'backward').result.objectOrder).toEqual(
      initial.objectOrder,
    );
  });
});

describe('grouping', () => {
  it('groups and ungroups reversibly', () => {
    const initial = scene(4);
    const edit = groupObjects(initial, ['stroke-1', 'stroke-2'], 'group-1');
    expect(edit.result.objects['group-1'].type).toBe('group');
    expect(edit.inverse(edit.result).result).toEqual(initial);
  });

  it('refuses to group fewer than two objects', () => {
    const initial = scene(3);
    expect(groupObjects(initial, ['stroke-1'], 'g').result).toBe(initial);
  });

  it('expands a selection through nested groups', () => {
    let current = scene(4);
    current = groupObjects(current, ['stroke-1', 'stroke-2'], 'inner').result;
    current = groupObjects(current, ['inner', 'stroke-3'], 'outer').result;

    const expanded = expandSelection(current, ['outer']);
    expect(expanded).toContain('stroke-1');
    expect(expanded).toContain('stroke-2');
    expect(expanded).toContain('stroke-3');
    expect(expanded).not.toContain('stroke-4');
  });

  it('refuses to nest past the depth bound', () => {
    let current = scene(2);
    let previous = ['stroke-1', 'stroke-2'];
    for (let depth = 0; depth < INK_LIMITS.groupDepth; depth += 1) {
      const id = `group-${depth}`;
      try {
        current = groupObjects(current, previous, id).result;
      } catch (error) {
        expect((error as Error).message).toMatch(/nesting/);
        return;
      }
      previous = [id, 'stroke-1'];
    }
    throw new Error('expected the depth bound to be enforced');
  });

  it('survives a group whose children reference each other in a cycle', () => {
    // Not reachable through the API, but a merge or a hand-edited file can
    // produce it, and a naive walk would never terminate.
    const cyclic: InkScene = {
      layers: { 'layer-1': layer('layer-1') },
      layerOrder: ['layer-1'],
      objects: {
        a: { id: 'a', type: 'group', layerId: 'layer-1', childIds: ['b'] } as InkObject,
        b: { id: 'b', type: 'group', layerId: 'layer-1', childIds: ['a'] } as InkObject,
      },
      objectOrder: ['a', 'b'],
    };
    expect(() => expandSelection(cyclic, ['a'])).not.toThrow();
  });

  it('ignores ungrouping something that is not a group', () => {
    const initial = scene(2);
    expect(ungroupObject(initial, 'stroke-1').result).toBe(initial);
  });
});

describe('layer operations', () => {
  it('adds and removes a layer reversibly, taking its objects with it', () => {
    const withLayer = addLayer(scene(4), layer('layer-2')).result;
    const populated = moveObjectsToLayer(withLayer, ['stroke-1', 'stroke-2'], 'layer-2').result;

    const edit = removeLayer(populated, 'layer-2');
    expect(edit.result.objectOrder).not.toContain('stroke-1');
    expect(edit.result.layerOrder).not.toContain('layer-2');
    // Undo has to bring back the layer *and* everything drawn on it, in order.
    expect(edit.inverse(edit.result).result).toEqual(populated);
  });

  it('refuses to remove the only layer', () => {
    // A scene with no layers has nowhere to put the next stroke, and the
    // normalizer would silently invent one on reload.
    expect(() => removeLayer(scene(), 'layer-1')).toThrow(/only layer/);
  });

  it('updates and reorders layers reversibly', () => {
    const initial = addLayer(scene(2), layer('layer-2')).result;
    const hidden = updateLayer(initial, 'layer-1', (entry) => ({ ...entry, visible: false }));
    expect(hidden.result.layers['layer-1'].visible).toBe(false);
    expect(hidden.inverse(hidden.result).result).toEqual(initial);

    const reordered = reorderLayer(initial, 'layer-1', 1);
    expect(reordered.result.layerOrder).toEqual(['layer-2', 'layer-1']);
    expect(reordered.inverse(reordered.result).result).toEqual(initial);
  });

  it('merges a layer down without disturbing paint order', () => {
    const initial = addLayer(scene(4), layer('layer-2'), 1).result;
    const populated = moveObjectsToLayer(initial, ['stroke-2'], 'layer-2').result;

    const edit = mergeLayerDown(populated, 'layer-2');
    expect(edit.result.layerOrder).toEqual(['layer-1']);
    expect(edit.result.objects['stroke-2'].layerId).toBe('layer-1');
    // Nothing visually jumps: the objects keep their positions in objectOrder.
    expect(edit.result.objectOrder).toEqual(populated.objectOrder);
    expect(edit.inverse(edit.result).result).toEqual(populated);
  });

  it('does nothing merging the bottom layer down', () => {
    const initial = scene(2);
    expect(mergeLayerDown(initial, 'layer-1').result).toBe(initial);
  });
});

describe('page operations', () => {
  const document = () =>
    createInkDocument({ name: 'Pages', timestamp: '2026-01-01T00:00:00.000Z' });

  it('adds, reorders, and removes pages reversibly', () => {
    const initial = document();
    const added = addPage(initial, createInkPage('page-2'));
    expect(added.result.pageOrder).toEqual(['page-1', 'page-2']);
    expect(added.inverse(added.result).result).toEqual(initial);

    const twoPages = added.result;
    const reordered = reorderPage(twoPages, 'page-2', 0);
    expect(reordered.result.pageOrder).toEqual(['page-2', 'page-1']);
    expect(reordered.inverse(reordered.result).result).toEqual(twoPages);

    const removed = removePage(twoPages, 'page-1');
    expect(removed.result.pageOrder).toEqual(['page-2']);
    expect(removed.inverse(removed.result).result).toEqual(twoPages);
  });

  it('refuses to remove the only page', () => {
    expect(() => removePage(document(), 'page-1')).toThrow(/only page/);
  });

  it('applies a scene operation to one page and inverts it', () => {
    const initial = document();
    const stroke = buildStroke('s', 'page-1-layer-1', { samples: 6, x: 0, y: 0 });
    const edit = onPage(initial, 'page-1', (target) => addObject(target, stroke));
    expect(edit.result.pages['page-1'].scene.objectOrder).toEqual(['s']);
    expect(edit.inverse(edit.result).result).toEqual(initial);
  });

  it('remaps every identity when duplicating a page', () => {
    // Two pages sharing an object id would be indistinguishable to the CRDT and
    // to the spatial index.
    const initial = addPage(document(), {
      ...createInkPage('page-2'),
      scene: buildInkScene({ strokes: 3, samplesPerStroke: 6 }),
    }).result;
    const grouped = onPage(initial, 'page-2', (target) =>
      groupObjects(target, ['stroke-1', 'stroke-2'], 'group-1'),
    ).result;

    const edit = duplicatePage(
      grouped,
      'page-2',
      'page-3',
      (kind, original) => `copy-${kind}-${original}`,
    );
    const source = edit.result.pages['page-2'].scene;
    const copy = edit.result.pages['page-3'].scene;

    expect(copy.objectOrder).toHaveLength(source.objectOrder.length);
    for (const id of copy.objectOrder) expect(source.objects[id]).toBeUndefined();
    for (const id of copy.layerOrder) expect(source.layers[id]).toBeUndefined();
    // Group membership must point at the copies, not at the originals.
    const group = copy.objects['copy-object-group-1'];
    if (group.type === 'group') {
      for (const childId of group.childIds) expect(copy.objects[childId]).toBeDefined();
    }
    expect(edit.inverse(edit.result).result).toEqual(grouped);
  });

  it('places a duplicate immediately after its source', () => {
    const initial = addPage(document(), createInkPage('page-2')).result;
    const edit = duplicatePage(
      initial,
      'page-1',
      'copy',
      (kind, original) => `c-${kind}-${original}`,
    );
    expect(edit.result.pageOrder).toEqual(['page-1', 'copy', 'page-2']);
  });
});

describe('boundsOf', () => {
  it('unions the bounds of a selection, expanding groups', () => {
    const initial = groupObjects(scene(4), ['stroke-1', 'stroke-2'], 'group-1').result;
    const grouped = boundsOf(initial, ['group-1']);
    const members = boundsOf(initial, ['stroke-1', 'stroke-2']);
    expect(grouped).toEqual(members);
  });

  it('is null when nothing has geometry', () => {
    expect(boundsOf(scene(2), ['ghost'])).toBeNull();
  });
});
