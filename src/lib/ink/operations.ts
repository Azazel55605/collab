/**
 * Page, layer, and object operations, each paired with its inverse.
 *
 * Every mutation here is pure: it takes a scene or document and returns a new
 * one, structurally shared where nothing changed. Components must never mutate
 * an ink document in place — the renderer's tile cache and the collaboration
 * layer both key off object identity to decide what actually changed.
 *
 * The inverse is returned alongside the result rather than derived later.
 * Deriving an undo after the fact means reconstructing state that has already
 * been replaced, which is where undo implementations usually go wrong: erasing
 * a stroke loses its samples, so the inverse has to capture them at the moment
 * of the erase. Local undo/redo (Phase 3) is a stack of these inverses.
 */
import { INK_LIMITS } from '../../types/ink';
import type {
  InkBounds,
  InkBrushParameters,
  InkDocument,
  InkLayer,
  InkObject,
  InkPage,
  InkScene,
} from '../../types/ink';

import { objectBounds } from './svg';

/** A reversible edit. Applying `inverse` to the result restores the input. */
export interface InkEdit<T> {
  result: T;
  inverse: InkOperation<T>;
}

export type InkOperation<T> = (input: T) => InkEdit<T>;

/* -------------------------------------------------------------------------
 * Objects
 * ---------------------------------------------------------------------- */

/** Inserts an object at the top of the paint order, or at `index`. */
export function addObject(scene: InkScene, object: InkObject, index?: number): InkEdit<InkScene> {
  if (scene.objects[object.id]) {
    throw new Error(`ink: object '${object.id}' already exists`);
  }
  if (scene.objectOrder.length >= INK_LIMITS.objectsPerPage) {
    throw new Error(`ink: page already holds ${INK_LIMITS.objectsPerPage} objects`);
  }

  const at = index ?? scene.objectOrder.length;
  const objectOrder = [...scene.objectOrder];
  objectOrder.splice(Math.max(0, Math.min(at, objectOrder.length)), 0, object.id);

  return {
    result: {
      ...scene,
      objects: { ...scene.objects, [object.id]: object },
      objectOrder,
    },
    inverse: (input) => removeObject(input, object.id),
  };
}

/**
 * Removes an object, capturing enough to put it back exactly where it was.
 *
 * The inverse restores the paint index, not just the object: an erase followed
 * by an undo that reinserts on top would silently reorder the drawing.
 */
export function removeObject(scene: InkScene, objectId: string): InkEdit<InkScene> {
  const object = scene.objects[objectId];
  if (!object) return { result: scene, inverse: (input) => ({ result: input, inverse: noop }) };

  const index = scene.objectOrder.indexOf(objectId);
  const objects = { ...scene.objects };
  delete objects[objectId];

  return {
    result: {
      ...scene,
      objects,
      objectOrder: scene.objectOrder.filter((id) => id !== objectId),
    },
    inverse: (input) => addObject(input, object, index),
  };
}

export function removeObjects(scene: InkScene, objectIds: string[]): InkEdit<InkScene> {
  // Captured in reverse so the inverses reinsert ascending and each index is
  // still valid when its turn comes.
  const ordered = [...objectIds].sort(
    (left, right) => scene.objectOrder.indexOf(right) - scene.objectOrder.indexOf(left),
  );
  const restores: Array<{ object: InkObject; index: number }> = [];
  let result = scene;
  for (const id of ordered) {
    const object = result.objects[id];
    if (!object) continue;
    restores.push({ object, index: result.objectOrder.indexOf(id) });
    result = removeObject(result, id).result;
  }

  return {
    result,
    inverse: (input) => {
      let restored = input;
      for (let index = restores.length - 1; index >= 0; index -= 1) {
        const entry = restores[index];
        restored = addObject(restored, entry.object, entry.index).result;
      }
      return { result: restored, inverse: (next) => removeObjects(next, objectIds) };
    },
  };
}

/** Replaces an object wholesale, e.g. after a transform or a restyle. */
export function updateObject(
  scene: InkScene,
  objectId: string,
  update: (object: InkObject) => InkObject,
): InkEdit<InkScene> {
  const object = scene.objects[objectId];
  if (!object) return { result: scene, inverse: (input) => ({ result: input, inverse: noop }) };

  const updated = update(object);
  return {
    result: { ...scene, objects: { ...scene.objects, [objectId]: updated } },
    inverse: (input) => updateObject(input, objectId, () => object),
  };
}

/** Applies a brush change to many objects at once. */
export function restyleObjects(
  scene: InkScene,
  objectIds: string[],
  change: Partial<InkBrushParameters>,
): InkEdit<InkScene> {
  const previous = new Map<string, InkBrushParameters>();
  const objects = { ...scene.objects };

  for (const id of objectIds) {
    const object = objects[id];
    if (!object) continue;
    if (object.type === 'stroke') {
      previous.set(id, object.brush);
      objects[id] = { ...object, brush: { ...object.brush, ...change } };
    } else if (object.type === 'shape' || object.type === 'connector') {
      previous.set(id, object.stroke);
      objects[id] = { ...object, stroke: { ...object.stroke, ...change } };
    }
  }

  return {
    result: { ...scene, objects },
    inverse: (input) => {
      const restored = { ...input.objects };
      for (const [id, brush] of previous) {
        const object = restored[id];
        if (!object) continue;
        if (object.type === 'stroke') restored[id] = { ...object, brush };
        else if (object.type === 'shape' || object.type === 'connector') {
          restored[id] = { ...object, stroke: brush };
        }
      }
      return {
        result: { ...input, objects: restored },
        inverse: (next) => restyleObjects(next, objectIds, change),
      };
    },
  };
}

/** Moves objects to another layer, keeping their relative paint order. */
export function moveObjectsToLayer(
  scene: InkScene,
  objectIds: string[],
  layerId: string,
): InkEdit<InkScene> {
  if (!scene.layers[layerId]) throw new Error(`ink: no layer '${layerId}'`);

  const previous = new Map<string, string>();
  const objects = { ...scene.objects };
  for (const id of objectIds) {
    const object = objects[id];
    if (!object) continue;
    previous.set(id, object.layerId);
    objects[id] = { ...object, layerId };
  }

  return {
    result: { ...scene, objects },
    inverse: (input) => {
      const restored = { ...input.objects };
      for (const [id, originalLayer] of previous) {
        const object = restored[id];
        if (object) restored[id] = { ...object, layerId: originalLayer };
      }
      return {
        result: { ...input, objects: restored },
        inverse: (next) => moveObjectsToLayer(next, objectIds, layerId),
      };
    },
  };
}

export type InkReorder = 'front' | 'back' | 'forward' | 'backward';

/** Changes paint order within the scene. */
export function reorderObjects(
  scene: InkScene,
  objectIds: string[],
  reorder: InkReorder,
): InkEdit<InkScene> {
  const previousOrder = scene.objectOrder;
  const moving = new Set(objectIds.filter((id) => scene.objects[id]));
  if (moving.size === 0) {
    return { result: scene, inverse: (input) => ({ result: input, inverse: noop }) };
  }

  const rest = previousOrder.filter((id) => !moving.has(id));
  const selected = previousOrder.filter((id) => moving.has(id));

  let objectOrder: string[];
  if (reorder === 'front') {
    objectOrder = [...rest, ...selected];
  } else if (reorder === 'back') {
    objectOrder = [...selected, ...rest];
  } else {
    // One step, computed against the original order so a multi-selection keeps
    // its internal arrangement rather than collapsing together.
    objectOrder = [...previousOrder];
    const indexes = selected.map((id) => objectOrder.indexOf(id));
    const step = reorder === 'forward' ? 1 : -1;
    const ordered = reorder === 'forward' ? indexes.reverse() : indexes;
    for (const index of ordered) {
      const target = index + step;
      if (target < 0 || target >= objectOrder.length) continue;
      if (moving.has(objectOrder[target])) continue;
      [objectOrder[index], objectOrder[target]] = [objectOrder[target], objectOrder[index]];
    }
  }

  return {
    result: { ...scene, objectOrder },
    inverse: (input) => ({
      result: { ...input, objectOrder: previousOrder },
      inverse: (next) => reorderObjects(next, objectIds, reorder),
    }),
  };
}

/* -------------------------------------------------------------------------
 * Grouping
 * ---------------------------------------------------------------------- */

/** Wraps objects in a group placed at the topmost member's position. */
export function groupObjects(
  scene: InkScene,
  objectIds: string[],
  groupId: string,
): InkEdit<InkScene> {
  const members = scene.objectOrder.filter((id) => objectIds.includes(id));
  if (members.length < 2) {
    return { result: scene, inverse: (input) => ({ result: input, inverse: noop }) };
  }
  if (groupDepthOf(scene, members) >= INK_LIMITS.groupDepth) {
    throw new Error(`ink: group nesting exceeds ${INK_LIMITS.groupDepth}`);
  }

  const topIndex = scene.objectOrder.indexOf(members[members.length - 1]);
  const group: InkObject = {
    id: groupId,
    type: 'group',
    layerId: scene.objects[members[0]].layerId,
    childIds: members,
  };
  const objectOrder = [...scene.objectOrder];
  objectOrder.splice(topIndex + 1, 0, groupId);

  return {
    result: {
      ...scene,
      objects: { ...scene.objects, [groupId]: group },
      objectOrder,
    },
    inverse: (input) => ungroupObject(input, groupId),
  };
}

export function ungroupObject(scene: InkScene, groupId: string): InkEdit<InkScene> {
  const group = scene.objects[groupId];
  if (!group || group.type !== 'group') {
    return { result: scene, inverse: (input) => ({ result: input, inverse: noop }) };
  }
  const index = scene.objectOrder.indexOf(groupId);
  const objects = { ...scene.objects };
  delete objects[groupId];

  return {
    result: {
      ...scene,
      objects,
      objectOrder: scene.objectOrder.filter((id) => id !== groupId),
    },
    inverse: (input) => {
      const objectOrder = [...input.objectOrder];
      objectOrder.splice(Math.min(index, objectOrder.length), 0, groupId);
      return {
        result: {
          ...input,
          objects: { ...input.objects, [groupId]: group },
          objectOrder,
        },
        inverse: (next) => ungroupObject(next, groupId),
      };
    },
  };
}

/** Deepest group nesting among the given objects, for the depth bound. */
export function groupDepthOf(scene: InkScene, objectIds: string[]): number {
  let deepest = 0;
  const walk = (id: string, depth: number): void => {
    if (depth > INK_LIMITS.groupDepth) return;
    deepest = Math.max(deepest, depth);
    const object = scene.objects[id];
    if (object?.type === 'group') {
      for (const childId of object.childIds) walk(childId, depth + 1);
    }
  };
  for (const id of objectIds) walk(id, 1);
  return deepest;
}

/** Every object a selection covers, expanding groups to their members. */
export function expandSelection(scene: InkScene, objectIds: string[]): string[] {
  const seen = new Set<string>();
  const walk = (id: string, depth: number): void => {
    if (seen.has(id) || depth > INK_LIMITS.groupDepth) return;
    const object = scene.objects[id];
    if (!object) return;
    if (object.type === 'group') {
      seen.add(id);
      for (const childId of object.childIds) walk(childId, depth + 1);
      return;
    }
    seen.add(id);
  };
  for (const id of objectIds) walk(id, 1);
  return scene.objectOrder.filter((id) => seen.has(id));
}

/* -------------------------------------------------------------------------
 * Layers
 * ---------------------------------------------------------------------- */

export function addLayer(scene: InkScene, layer: InkLayer, index?: number): InkEdit<InkScene> {
  if (scene.layers[layer.id]) throw new Error(`ink: layer '${layer.id}' already exists`);
  if (scene.layerOrder.length >= INK_LIMITS.layersPerPage) {
    throw new Error(`ink: page already holds ${INK_LIMITS.layersPerPage} layers`);
  }
  const at = index ?? scene.layerOrder.length;
  const layerOrder = [...scene.layerOrder];
  layerOrder.splice(Math.max(0, Math.min(at, layerOrder.length)), 0, layer.id);

  return {
    result: { ...scene, layers: { ...scene.layers, [layer.id]: layer }, layerOrder },
    inverse: (input) => removeLayer(input, layer.id),
  };
}

/**
 * Removes a layer and everything drawn on it.
 *
 * Refuses to remove the last layer: a scene with no layers has nowhere to put
 * the next stroke, and the normalizer would silently invent one on reload.
 */
export function removeLayer(scene: InkScene, layerId: string): InkEdit<InkScene> {
  const layer = scene.layers[layerId];
  if (!layer) return { result: scene, inverse: (input) => ({ result: input, inverse: noop }) };
  if (scene.layerOrder.length <= 1) throw new Error('ink: cannot remove the only layer');

  const index = scene.layerOrder.indexOf(layerId);
  const doomed = scene.objectOrder.filter((id) => scene.objects[id].layerId === layerId);
  const removal = removeObjects(scene, doomed);

  const layers = { ...removal.result.layers };
  delete layers[layerId];

  return {
    result: {
      ...removal.result,
      layers,
      layerOrder: removal.result.layerOrder.filter((id) => id !== layerId),
    },
    inverse: (input) => {
      const restoredLayer = addLayer(input, layer, index);
      const restored = removal.inverse(restoredLayer.result);
      return {
        result: restored.result,
        inverse: (next) => removeLayer(next, layerId),
      };
    },
  };
}

export function updateLayer(
  scene: InkScene,
  layerId: string,
  update: (layer: InkLayer) => InkLayer,
): InkEdit<InkScene> {
  const layer = scene.layers[layerId];
  if (!layer) return { result: scene, inverse: (input) => ({ result: input, inverse: noop }) };
  return {
    result: { ...scene, layers: { ...scene.layers, [layerId]: update(layer) } },
    inverse: (input) => updateLayer(input, layerId, () => layer),
  };
}

export function reorderLayer(scene: InkScene, layerId: string, toIndex: number): InkEdit<InkScene> {
  const from = scene.layerOrder.indexOf(layerId);
  if (from < 0) return { result: scene, inverse: (input) => ({ result: input, inverse: noop }) };

  const layerOrder = [...scene.layerOrder];
  layerOrder.splice(from, 1);
  layerOrder.splice(Math.max(0, Math.min(toIndex, layerOrder.length)), 0, layerId);

  return {
    result: { ...scene, layerOrder },
    inverse: (input) => reorderLayer(input, layerId, from),
  };
}

/**
 * Merges a layer down into the one below it.
 *
 * Objects keep their paint order: the merged objects take the target layer's
 * id but stay where they were in `objectOrder`, so nothing visually jumps.
 */
export function mergeLayerDown(scene: InkScene, layerId: string): InkEdit<InkScene> {
  const index = scene.layerOrder.indexOf(layerId);
  if (index <= 0) {
    return { result: scene, inverse: (input) => ({ result: input, inverse: noop }) };
  }
  const targetId = scene.layerOrder[index - 1];
  const layer = scene.layers[layerId];
  const moved = scene.objectOrder.filter((id) => scene.objects[id].layerId === layerId);

  const objects = { ...scene.objects };
  for (const id of moved) objects[id] = { ...objects[id], layerId: targetId };
  const layers = { ...scene.layers };
  delete layers[layerId];

  return {
    result: {
      ...scene,
      objects,
      layers,
      layerOrder: scene.layerOrder.filter((id) => id !== layerId),
    },
    inverse: (input) => {
      const restoredObjects = { ...input.objects };
      for (const id of moved) {
        if (restoredObjects[id]) restoredObjects[id] = { ...restoredObjects[id], layerId };
      }
      const restoredOrder = [...input.layerOrder];
      restoredOrder.splice(index, 0, layerId);
      return {
        result: {
          ...input,
          objects: restoredObjects,
          layers: { ...input.layers, [layerId]: layer },
          layerOrder: restoredOrder,
        },
        inverse: (next) => mergeLayerDown(next, layerId),
      };
    },
  };
}

/* -------------------------------------------------------------------------
 * Pages
 * ---------------------------------------------------------------------- */

export function addPage(
  document: InkDocument,
  page: InkPage,
  index?: number,
): InkEdit<InkDocument> {
  if (document.pages[page.id]) throw new Error(`ink: page '${page.id}' already exists`);
  if (document.pageOrder.length >= INK_LIMITS.pagesPerDocument) {
    throw new Error(`ink: document already holds ${INK_LIMITS.pagesPerDocument} pages`);
  }
  const at = index ?? document.pageOrder.length;
  const pageOrder = [...document.pageOrder];
  pageOrder.splice(Math.max(0, Math.min(at, pageOrder.length)), 0, page.id);

  return {
    result: { ...document, pages: { ...document.pages, [page.id]: page }, pageOrder },
    inverse: (input) => removePage(input, page.id),
  };
}

export function removePage(document: InkDocument, pageId: string): InkEdit<InkDocument> {
  const page = document.pages[pageId];
  if (!page) return { result: document, inverse: (input) => ({ result: input, inverse: noop }) };
  if (document.pageOrder.length <= 1) throw new Error('ink: cannot remove the only page');

  const index = document.pageOrder.indexOf(pageId);
  const pages = { ...document.pages };
  delete pages[pageId];

  return {
    result: {
      ...document,
      pages,
      pageOrder: document.pageOrder.filter((id) => id !== pageId),
    },
    inverse: (input) => addPage(input, page, index),
  };
}

export function reorderPage(
  document: InkDocument,
  pageId: string,
  toIndex: number,
): InkEdit<InkDocument> {
  const from = document.pageOrder.indexOf(pageId);
  if (from < 0) {
    return { result: document, inverse: (input) => ({ result: input, inverse: noop }) };
  }
  const pageOrder = [...document.pageOrder];
  pageOrder.splice(from, 1);
  pageOrder.splice(Math.max(0, Math.min(toIndex, pageOrder.length)), 0, pageId);

  return {
    result: { ...document, pageOrder },
    inverse: (input) => reorderPage(input, pageId, from),
  };
}

export function updatePage(
  document: InkDocument,
  pageId: string,
  update: (page: InkPage) => InkPage,
): InkEdit<InkDocument> {
  const page = document.pages[pageId];
  if (!page) return { result: document, inverse: (input) => ({ result: input, inverse: noop }) };
  return {
    result: { ...document, pages: { ...document.pages, [pageId]: update(page) } },
    inverse: (input) => updatePage(input, pageId, () => page),
  };
}

/** Applies a scene operation to one page of a document, preserving the inverse. */
export function onPage(
  document: InkDocument,
  pageId: string,
  operation: InkOperation<InkScene>,
): InkEdit<InkDocument> {
  const page = document.pages[pageId];
  if (!page) return { result: document, inverse: (input) => ({ result: input, inverse: noop }) };

  const edit = operation(page.scene);
  return {
    result: {
      ...document,
      pages: { ...document.pages, [pageId]: { ...page, scene: edit.result } },
    },
    inverse: (input) => onPage(input, pageId, edit.inverse),
  };
}

/**
 * Duplicates a page under a new id, remapping every layer and object identity.
 *
 * Identities must be remapped rather than shared: two pages holding the same
 * object id would be indistinguishable to the CRDT and to the spatial index.
 */
export function duplicatePage(
  document: InkDocument,
  pageId: string,
  newPageId: string,
  makeId: (kind: 'layer' | 'object', original: string, index: number) => string,
): InkEdit<InkDocument> {
  const page = document.pages[pageId];
  if (!page) return { result: document, inverse: (input) => ({ result: input, inverse: noop }) };

  const layerMap = new Map<string, string>();
  page.scene.layerOrder.forEach((id, index) => layerMap.set(id, makeId('layer', id, index)));
  const objectMap = new Map<string, string>();
  page.scene.objectOrder.forEach((id, index) => objectMap.set(id, makeId('object', id, index)));

  const layers: Record<string, InkLayer> = {};
  for (const [original, copy] of layerMap) {
    layers[copy] = { ...page.scene.layers[original], id: copy };
  }
  const objects: Record<string, InkObject> = {};
  for (const [original, copy] of objectMap) {
    const object = page.scene.objects[original];
    const duplicated: InkObject = {
      ...object,
      id: copy,
      layerId: layerMap.get(object.layerId) ?? object.layerId,
    };
    if (duplicated.type === 'group') {
      duplicated.childIds = duplicated.childIds.map((child) => objectMap.get(child) ?? child);
    }
    objects[copy] = duplicated;
  }

  const copy: InkPage = {
    ...page,
    id: newPageId,
    name: page.name ? `${page.name} copy` : undefined,
    scene: {
      layers,
      layerOrder: page.scene.layerOrder.map((id) => layerMap.get(id)!),
      objects,
      objectOrder: page.scene.objectOrder.map((id) => objectMap.get(id)!),
    },
  };

  return addPage(document, copy, document.pageOrder.indexOf(pageId) + 1);
}

/* -------------------------------------------------------------------------
 * Geometry
 * ---------------------------------------------------------------------- */

/** Union bounds of the given objects, or null when none have geometry. */
export function boundsOf(scene: InkScene, objectIds: string[]): InkBounds | null {
  let bounds: InkBounds | null = null;
  for (const id of expandSelection(scene, objectIds)) {
    const object = scene.objects[id];
    if (!object) continue;
    const objectBound = objectBounds(object);
    if (!objectBound) continue;
    bounds = bounds
      ? {
          minX: Math.min(bounds.minX, objectBound.minX),
          minY: Math.min(bounds.minY, objectBound.minY),
          maxX: Math.max(bounds.maxX, objectBound.maxX),
          maxY: Math.max(bounds.maxY, objectBound.maxY),
        }
      : objectBound;
  }
  return bounds;
}

function noop<T>(input: T): InkEdit<T> {
  return { result: input, inverse: noop };
}
