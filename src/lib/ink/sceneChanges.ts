import type { InkScene } from '../../types/ink';

declare const WeakRef: { new <T extends object>(target: T): { deref(): T | undefined } };

const changes = new WeakMap<
  InkScene,
  { previous: { deref(): InkScene | undefined }; ids: readonly string[] }
>();
/** Derived hints must never retain the undo chain or enter saved documents. */
export function recordInkSceneChanges(before: InkScene, after: InkScene, ids: readonly string[]) {
  if (before !== after) changes.set(after, { previous: new WeakRef(before), ids });
  return after;
}
export function inkSceneChangedIds(before: InkScene, after: InkScene): Set<string> | null {
  const ids = new Set<string>();
  let current = after;
  for (let steps = 0; steps < 64; steps++) {
    if (current === before) return ids;
    const change = changes.get(current);
    const previous = change?.previous.deref();
    if (!change || !previous) return null;
    for (const id of change.ids) ids.add(id);
    current = previous;
  }
  return null;
}
