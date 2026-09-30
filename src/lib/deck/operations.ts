/**
 * Reversible `.deck` edits.
 *
 * Every operation is expressed as a {@link DeckPatch} — replacement values for
 * only the slides, slide order, and sections it touches — and returns the
 * patch that restores what it replaced. Inverses are therefore exact (captured
 * at edit time, not reconstructed), and an undo entry costs one slide rather
 * than a copy of the deck. The shape matches `InkEdit`, so the ink undo stack
 * (`InkHistory`) serves decks unchanged.
 *
 * Operations are pure and framework-free. They keep the document's structural
 * invariants (paint order, group membership, animation targets) and leave full
 * validation to `useDeckSession`, which re-validates every edit before it can
 * be saved.
 */
import type {
  DeckDocument,
  DeckElement,
  DeckElementContainer,
  DeckGroupElement,
  DeckLayout,
  DeckMaster,
  DeckSection,
  DeckSlide,
  DeckTheme,
} from '../../types/deck';

import type { DeckTarget } from './resolve';

/** A reversible edit. Applying `inverse` to `result` restores the input. */
export interface DeckEdit {
  result: DeckDocument;
  inverse: DeckOperation;
}

export type DeckOperation = (document: DeckDocument) => DeckEdit;

export interface DeckPatch {
  /** Replacement slides; `null` deletes. */
  slides?: Record<string, DeckSlide | null>;
  slideOrder?: string[];
  /** Replacement sections; `null` removes the field. */
  sections?: DeckSection[] | null;
  /** Replacement layouts, masters, and themes; `null` deletes. */
  layouts?: Record<string, DeckLayout | null>;
  masters?: Record<string, DeckMaster | null>;
  themes?: Record<string, DeckTheme | null>;
  themeId?: string;
}

type MapKey = 'slides' | 'layouts' | 'masters' | 'themes';

function patchMap<K extends MapKey>(
  document: DeckDocument,
  key: K,
  entries: Record<string, DeckDocument[K][string] | null>,
): { map: DeckDocument[K]; undo: Record<string, DeckDocument[K][string] | null> } {
  const map = { ...document[key] } as Record<string, DeckDocument[K][string]>;
  const undo: Record<string, DeckDocument[K][string] | null> = {};
  for (const [id, value] of Object.entries(entries)) {
    undo[id] = (document[key] as Record<string, DeckDocument[K][string]>)[id] ?? null;
    if (value) map[id] = value;
    else delete map[id];
  }
  return { map: map as DeckDocument[K], undo };
}

/** Applies a patch and returns the patch that undoes it. */
export function applyPatch(document: DeckDocument, patch: DeckPatch): DeckEdit {
  const undo: DeckPatch = {};
  let result: DeckDocument = document;

  for (const key of ['slides', 'layouts', 'masters', 'themes'] as const) {
    const entries = patch[key];
    if (!entries) continue;
    const { map, undo: inverse } = patchMap(document, key, entries as never);
    (undo as Record<string, unknown>)[key] = inverse;
    result = { ...result, [key]: map };
  }
  if (patch.slideOrder) {
    undo.slideOrder = document.slideOrder;
    result = { ...result, slideOrder: patch.slideOrder };
  }
  if (patch.themeId !== undefined) {
    undo.themeId = document.themeId;
    result = { ...result, themeId: patch.themeId };
  }
  if (patch.sections !== undefined) {
    undo.sections = document.sections ?? null;
    if (patch.sections) {
      result = { ...result, sections: patch.sections };
    } else {
      const { sections: _removed, ...rest } = result;
      result = rest;
    }
  }
  return { result, inverse: (current) => applyPatch(current, undo) };
}

/** The identity edit, for operations that turn out to change nothing. */
function unchanged(document: DeckDocument): DeckEdit {
  return { result: document, inverse: unchanged };
}

/**
 * Where element operations apply: a slide id, or an explicit slide, layout, or
 * master. Layouts and masters hold elements exactly as slides do, so the
 * layout and master editors reuse every element operation.
 */
export type DeckTargetRef = string | DeckTarget;

type AnyContainer = DeckSlide | DeckLayout | DeckMaster;

function asTarget(ref: DeckTargetRef): DeckTarget {
  return typeof ref === 'string' ? { kind: 'slide', id: ref } : ref;
}

function slideOf(document: DeckDocument, ref: DeckTargetRef): AnyContainer {
  const target = asTarget(ref);
  const container =
    target.kind === 'slide'
      ? document.slides[target.id]
      : target.kind === 'layout'
        ? document.layouts[target.id]
        : document.masters[target.id];
  if (!container) {
    throw new Error(
      `${target.kind[0].toUpperCase()}${target.kind.slice(1)} ${target.id} does not exist.`,
    );
  }
  return container;
}

function replaceSlide(
  document: DeckDocument,
  ref: DeckTargetRef,
  container: AnyContainer,
): DeckEdit {
  const target = asTarget(ref);
  if (target.kind === 'slide') {
    return applyPatch(document, { slides: { [target.id]: container as DeckSlide } });
  }
  if (target.kind === 'layout') {
    return applyPatch(document, { layouts: { [target.id]: container as DeckLayout } });
  }
  return applyPatch(document, { masters: { [target.id]: container as DeckMaster } });
}

/** Drops animations whose element no longer exists; only slides carry them. */
function withLiveAnimations(container: AnyContainer): AnyContainer {
  if (!('animations' in container) || !container.animations) return container;
  const animations = container.animations.filter(
    (animation) => container.elements[animation.elementId],
  );
  const next: DeckSlide = { ...container };
  if (animations.length > 0) next.animations = animations;
  else delete next.animations;
  return next;
}

/* ------------------------------------------------------------------------- */
/* Slides                                                                     */
/* ------------------------------------------------------------------------- */

/** Inserts a slide at `index` (default: the end). */
export function insertSlide(document: DeckDocument, slide: DeckSlide, index?: number): DeckEdit {
  if (document.slides[slide.id]) throw new Error(`Slide ${slide.id} already exists.`);
  const order = [...document.slideOrder];
  order.splice(index ?? order.length, 0, slide.id);
  return applyPatch(document, { slides: { [slide.id]: slide }, slideOrder: order });
}

/**
 * Deletes slides. The last slide can never be deleted — a deck with no slides
 * is repaired on open, and silently doing that on every save is worse than
 * refusing here. Sections starting at a deleted slide move to the next
 * surviving slide, or are removed if none follows.
 */
export function deleteSlides(document: DeckDocument, slideIds: string[]): DeckEdit {
  const doomed = new Set(slideIds.filter((id) => document.slides[id]));
  if (doomed.size === 0) return unchanged(document);
  if (doomed.size >= document.slideOrder.length) {
    throw new Error('A presentation needs at least one slide.');
  }
  const order = document.slideOrder.filter((id) => !doomed.has(id));
  const slides: Record<string, null> = {};
  for (const id of doomed) slides[id] = null;

  const patch: DeckPatch = { slides, slideOrder: order };
  if (document.sections) {
    const sections: DeckSection[] = [];
    for (const section of document.sections) {
      if (!doomed.has(section.firstSlideId)) {
        sections.push(section);
        continue;
      }
      const from = document.slideOrder.indexOf(section.firstSlideId);
      const next = document.slideOrder.slice(from + 1).find((id) => !doomed.has(id));
      if (next && !sections.some((entry) => entry.firstSlideId === next)) {
        sections.push({ ...section, firstSlideId: next });
      }
    }
    patch.sections = sections;
  }
  return applyPatch(document, patch);
}

/** Moves slides, keeping their relative order, so they start at `toIndex` of the remaining order. */
export function moveSlides(document: DeckDocument, slideIds: string[], toIndex: number): DeckEdit {
  const moving = document.slideOrder.filter((id) => slideIds.includes(id));
  if (moving.length === 0) return unchanged(document);
  const rest = document.slideOrder.filter((id) => !slideIds.includes(id));
  const at = Math.max(0, Math.min(rest.length, toIndex));
  const order = [...rest.slice(0, at), ...moving, ...rest.slice(at)];
  if (order.every((id, index) => id === document.slideOrder[index])) return unchanged(document);
  return applyPatch(document, { slideOrder: order });
}

export function setSlidesHidden(
  document: DeckDocument,
  slideIds: string[],
  hidden: boolean,
): DeckEdit {
  const slides: Record<string, DeckSlide> = {};
  for (const id of slideIds) {
    const slide = document.slides[id];
    if (!slide || Boolean(slide.hidden) === hidden) continue;
    const next = { ...slide };
    if (hidden) next.hidden = true;
    else delete next.hidden;
    slides[id] = next;
  }
  return Object.keys(slides).length > 0 ? applyPatch(document, { slides }) : unchanged(document);
}

/**
 * Deep-copies an element map with fresh ids, rewriting group membership,
 * returning the id mapping. Used by slide duplication and paste.
 */
export function cloneElements(
  elements: DeckElement[],
  nextId: (prefix: string) => string,
): { elements: DeckElement[]; ids: Map<string, string> } {
  const ids = new Map<string, string>();
  for (const element of elements) ids.set(element.id, nextId('el'));
  const cloned = elements.map((element) => {
    const copy = structuredClone(element);
    copy.id = ids.get(element.id)!;
    if (copy.type === 'group')
      copy.childIds = copy.childIds.map((child) => ids.get(child) ?? child);
    return copy;
  });
  return { elements: cloned, ids };
}

/** Duplicates slides, each inserted right after its source. Returns the new ids in order. */
export function duplicateSlides(
  document: DeckDocument,
  slideIds: string[],
  nextId: (prefix: string) => string,
): DeckEdit & { slideIds: string[] } {
  const sources = document.slideOrder.filter((id) => slideIds.includes(id));
  const slides: Record<string, DeckSlide> = {};
  const order = [...document.slideOrder];
  const created: string[] = [];
  for (const sourceId of sources) {
    const source = document.slides[sourceId];
    const id = nextId('slide');
    const { elements, ids } = cloneElements(Object.values(source.elements), nextId);
    const copy: DeckSlide = {
      ...structuredClone(source),
      id,
      elements: Object.fromEntries(elements.map((element) => [element.id, element])),
      elementOrder: source.elementOrder.map((elementId) => ids.get(elementId)!),
    };
    if (copy.animations) {
      copy.animations = copy.animations.map((animation) => ({
        ...animation,
        id: nextId('anim'),
        elementId: ids.get(animation.elementId) ?? animation.elementId,
      }));
    }
    slides[id] = copy;
    order.splice(order.indexOf(sourceId) + 1, 0, id);
    created.push(id);
  }
  if (created.length === 0) return { ...unchanged(document), slideIds: [] };
  return { ...applyPatch(document, { slides, slideOrder: order }), slideIds: created };
}

/* ------------------------------------------------------------------------- */
/* Elements                                                                   */
/* ------------------------------------------------------------------------- */

/** Ids of every element in `ids` plus, recursively, every group child. */
export function expandGroups(slide: DeckElementContainer, ids: Iterable<string>): Set<string> {
  const out = new Set<string>();
  const visit = (id: string) => {
    if (out.has(id)) return;
    const element = slide.elements[id];
    if (!element) return;
    out.add(id);
    if (element.type === 'group') element.childIds.forEach(visit);
  };
  for (const id of ids) visit(id);
  return out;
}

/** The top-level element (paint-order entry) an element belongs to. */
export function topLevelOf(slide: DeckElementContainer, elementId: string): string {
  const parents = new Map<string, string>();
  for (const element of Object.values(slide.elements)) {
    if (element.type === 'group')
      for (const child of element.childIds) parents.set(child, element.id);
  }
  let current = elementId;
  for (let guard = 0; guard < 64 && parents.has(current); guard += 1)
    current = parents.get(current)!;
  return current;
}

/** Adds top-level elements, at the top of the paint order or at `index`. */
export function addElements(
  document: DeckDocument,
  slideId: DeckTargetRef,
  elements: DeckElement[],
  options: { index?: number; topLevelIds?: string[] } = {},
): DeckEdit {
  const slide = slideOf(document, slideId);
  const map = { ...slide.elements };
  for (const element of elements) {
    if (map[element.id]) throw new Error(`Element ${element.id} already exists.`);
    map[element.id] = element;
  }
  // Group children are added to the map but not to the paint order.
  const topLevel = options.topLevelIds ?? elements.map((element) => element.id);
  const order = [...slide.elementOrder];
  order.splice(options.index ?? order.length, 0, ...topLevel);
  return replaceSlide(document, slideId, { ...slide, elements: map, elementOrder: order });
}

/**
 * Removes elements, their group children, their membership in any parent
 * group, and animations that target them. A group left with fewer than two
 * children is dissolved, as PowerPoint does.
 */
export function removeElements(
  document: DeckDocument,
  slideId: DeckTargetRef,
  elementIds: string[],
): DeckEdit {
  const slide = slideOf(document, slideId);
  const doomed = expandGroups(slide, elementIds);
  if (doomed.size === 0) return unchanged(document);

  const elements: Record<string, DeckElement> = {};
  for (const [id, element] of Object.entries(slide.elements)) {
    if (!doomed.has(id)) elements[id] = element;
  }
  let order = slide.elementOrder.filter((id) => !doomed.has(id));

  for (const [id, element] of Object.entries(elements)) {
    if (element.type !== 'group') continue;
    const children = element.childIds.filter((child) => !doomed.has(child));
    if (children.length === element.childIds.length) continue;
    if (children.length >= 2) {
      elements[id] = { ...element, childIds: children };
    } else {
      // Dissolve: the surviving child takes the group's place.
      delete elements[id];
      order = order.flatMap((entry) => (entry === id ? children : [entry]));
      for (const parent of Object.values(elements)) {
        if (parent.type === 'group' && parent.childIds.includes(id)) {
          elements[parent.id] = {
            ...parent,
            childIds: parent.childIds.flatMap((child) => (child === id ? children : [child])),
          };
        }
      }
    }
  }

  return replaceSlide(
    document,
    slideId,
    withLiveAnimations({ ...slide, elements, elementOrder: order }),
  );
}

/** Replaces elements through per-element updaters; unknown ids are ignored. */
export function updateElements(
  document: DeckDocument,
  slideId: DeckTargetRef,
  updaters: Record<string, (element: DeckElement) => DeckElement>,
): DeckEdit {
  const slide = slideOf(document, slideId);
  let changed = false;
  const elements = { ...slide.elements };
  for (const [id, update] of Object.entries(updaters)) {
    const current = elements[id];
    if (!current) continue;
    const next = update(current);
    if (next !== current) {
      elements[id] = { ...next, id };
      changed = true;
    }
  }
  return changed ? replaceSlide(document, slideId, { ...slide, elements }) : unchanged(document);
}

export type DeckReorder = 'front' | 'back' | 'forward' | 'backward';

/** Changes the paint position of top-level elements, keeping their relative order. */
export function reorderElements(
  document: DeckDocument,
  slideId: DeckTargetRef,
  elementIds: string[],
  direction: DeckReorder,
): DeckEdit {
  const slide = slideOf(document, slideId);
  const selected = new Set(elementIds.filter((id) => slide.elementOrder.includes(id)));
  if (selected.size === 0) return unchanged(document);
  const order = [...slide.elementOrder];
  let next: string[];
  if (direction === 'front' || direction === 'back') {
    const moving = order.filter((id) => selected.has(id));
    const rest = order.filter((id) => !selected.has(id));
    next = direction === 'front' ? [...rest, ...moving] : [...moving, ...rest];
  } else {
    next = [...order];
    const step = direction === 'forward' ? 1 : -1;
    const indices = next
      .map((id, index) => (selected.has(id) ? index : -1))
      .filter((index) => index >= 0);
    if (step > 0) indices.reverse();
    for (const index of indices) {
      const target = index + step;
      if (target < 0 || target >= next.length || selected.has(next[target])) continue;
      [next[index], next[target]] = [next[target], next[index]];
    }
  }
  if (next.every((id, index) => id === order[index])) return unchanged(document);
  return replaceSlide(document, slideId, { ...slide, elementOrder: next });
}

/**
 * Groups top-level elements. The group takes the paint position of the
 * topmost member so nothing jumps above or below unrelated elements.
 */
export function groupElements(
  document: DeckDocument,
  slideId: DeckTargetRef,
  elementIds: string[],
  groupId: string,
  frame: DeckGroupElement['frame'],
): DeckEdit {
  const slide = slideOf(document, slideId);
  const members = slide.elementOrder.filter((id) => elementIds.includes(id));
  if (members.length < 2) return unchanged(document);
  if (slide.elements[groupId]) throw new Error(`Element ${groupId} already exists.`);
  const group: DeckGroupElement = {
    id: groupId,
    type: 'group',
    childIds: members,
    ...(frame ? { frame } : {}),
  };
  const topIndex = slide.elementOrder.indexOf(members[members.length - 1]);
  const order = slide.elementOrder.flatMap((id, index) =>
    index === topIndex ? [groupId] : members.includes(id) ? [] : [id],
  );
  return replaceSlide(document, slideId, {
    ...slide,
    elements: { ...slide.elements, [groupId]: group },
    elementOrder: order,
  });
}

/** Ungroups top-level groups; their children take the group's paint position. */
export function ungroupElements(
  document: DeckDocument,
  slideId: DeckTargetRef,
  groupIds: string[],
): DeckEdit {
  const slide = slideOf(document, slideId);
  const groups = groupIds.filter(
    (id) => slide.elements[id]?.type === 'group' && slide.elementOrder.includes(id),
  );
  if (groups.length === 0) return unchanged(document);
  const elements = { ...slide.elements };
  const order = slide.elementOrder.flatMap((id) => {
    if (!groups.includes(id)) return [id];
    const group = elements[id] as DeckGroupElement;
    delete elements[id];
    return group.childIds;
  });
  return replaceSlide(
    document,
    slideId,
    withLiveAnimations({ ...slide, elements, elementOrder: order }),
  );
}

export function setElementsLocked(
  document: DeckDocument,
  slideId: DeckTargetRef,
  elementIds: string[],
  locked: boolean,
): DeckEdit {
  const updaters: Record<string, (element: DeckElement) => DeckElement> = {};
  for (const id of elementIds) {
    updaters[id] = (element) => {
      if (Boolean(element.locked) === locked) return element;
      const next = { ...element };
      if (locked) next.locked = true;
      else delete next.locked;
      return next;
    };
  }
  return updateElements(document, slideId, updaters);
}

/** Runs several edits as one undoable step, inverting in reverse order. */
export function composeEdits(document: DeckDocument, operations: DeckOperation[]): DeckEdit {
  const inverses: DeckOperation[] = [];
  let current = document;
  for (const operation of operations) {
    const edit = operation(current);
    inverses.unshift(edit.inverse);
    current = edit.result;
  }
  if (current === document) return unchanged(document);
  return {
    result: current,
    inverse: (input) => composeEdits(input, inverses),
  };
}
