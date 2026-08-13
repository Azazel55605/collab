/**
 * Copy, cut, paste, and duplicate for ink selections.
 *
 * The clipboard payload is a self-contained set of objects plus the bounds they
 * came from. It carries no layer records: pasted objects land on the *current*
 * layer, because pasting into a drawing whose layers you have since renamed or
 * deleted must not fail, and recreating the source's layers would quietly
 * multiply them on every paste.
 *
 * Object ids are regenerated on paste. Two copies sharing an id would be
 * indistinguishable to the spatial index and to the CRDT.
 */

import { INK_LIMITS } from '../../types/ink';
import type { InkObject, InkScene } from '../../types/ink';
import { addObject, expandSelection } from './operations';
import type { InkEdit } from './operations';
import { boundsOf } from './operations';
import { transformObject, translation } from './transform';

export const INK_CLIPBOARD_KIND = 'collab-ink-clipboard';

export interface InkClipboard {
  kind: typeof INK_CLIPBOARD_KIND;
  /** Ink-unit origin of the copied content, so a paste can be offset from it. */
  originX: number;
  originY: number;
  objects: InkObject[];
}

/** How far a paste is nudged from its source, so it does not hide underneath. */
export const INK_PASTE_OFFSET = 640;

/**
 * Builds a clipboard payload from a selection.
 *
 * Groups are expanded to their members. A pasted group would need its members
 * remapped anyway, and flattening keeps the payload honest about what it holds.
 */
export function copySelection(scene: InkScene, objectIds: string[]): InkClipboard | null {
  const ids = expandSelection(scene, objectIds).filter(
    (id) => scene.objects[id]?.type !== 'group',
  );
  if (ids.length === 0) return null;

  const bounds = boundsOf(scene, ids);
  return {
    kind: INK_CLIPBOARD_KIND,
    originX: bounds?.minX ?? 0,
    originY: bounds?.minY ?? 0,
    objects: ids.map((id) => scene.objects[id]),
  };
}

/** True when a value is a clipboard payload this build can paste. */
export function isInkClipboard(value: unknown): value is InkClipboard {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as InkClipboard).kind === INK_CLIPBOARD_KIND &&
    Array.isArray((value as InkClipboard).objects)
  );
}

export interface PasteOptions {
  /** Layer the pasted objects land on. */
  layerId: string;
  /** Ink-unit position for the payload's origin. Defaults to a small offset. */
  x?: number;
  y?: number;
  /** Produces an id for each pasted object. */
  makeId: (original: string, index: number) => string;
}

export interface PasteResult extends InkEdit<InkScene> {
  /** Ids of the objects that were pasted, for selecting them afterwards. */
  pastedIds: string[];
}

/**
 * Pastes a payload into a scene as one reversible edit.
 *
 * Refuses rather than truncating when the page cannot hold the payload: a paste
 * that silently dropped half a selection is worse than one that says no.
 */
export function pasteClipboard(
  scene: InkScene,
  clipboard: InkClipboard,
  options: PasteOptions,
): PasteResult {
  if (!scene.layers[options.layerId]) {
    throw new Error(`ink: no layer '${options.layerId}' to paste onto`);
  }
  if (scene.objectOrder.length + clipboard.objects.length > INK_LIMITS.objectsPerPage) {
    throw new Error(
      `ink: pasting ${clipboard.objects.length} objects would exceed the ${INK_LIMITS.objectsPerPage}-object page limit`,
    );
  }

  const dx = (options.x ?? clipboard.originX + INK_PASTE_OFFSET) - clipboard.originX;
  const dy = (options.y ?? clipboard.originY + INK_PASTE_OFFSET) - clipboard.originY;
  const offset = translation(dx, dy);

  const pastedIds: string[] = [];
  const edits: Array<InkEdit<InkScene>> = [];
  let result = scene;

  clipboard.objects.forEach((object, index) => {
    const id = options.makeId(object.id, index);
    const pasted: InkObject = {
      ...transformObject(object, offset),
      id,
      layerId: options.layerId,
    };
    const edit = addObject(result, pasted);
    edits.push(edit);
    result = edit.result;
    pastedIds.push(id);
  });

  return {
    result,
    pastedIds,
    inverse: (input) => {
      let reverted = input;
      for (let index = edits.length - 1; index >= 0; index -= 1) {
        reverted = edits[index].inverse(reverted).result;
      }
      return {
        result: reverted,
        inverse: (next) => pasteClipboard(next, clipboard, options),
      };
    },
  };
}

/** Duplicates a selection in place, offset so the copy is visible. */
export function duplicateSelection(
  scene: InkScene,
  objectIds: string[],
  layerId: string,
  makeId: (original: string, index: number) => string,
): PasteResult | null {
  const clipboard = copySelection(scene, objectIds);
  if (!clipboard) return null;
  return pasteClipboard(scene, clipboard, { layerId, makeId });
}
