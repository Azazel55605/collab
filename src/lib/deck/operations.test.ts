import { describe, expect, it } from 'vitest';

import type { DeckDocument, DeckElement } from '../../types/deck';
import { InkHistory } from '../ink/history';

import { buildFixtureDeck } from './fixture';
import {
  addElements,
  composeEdits,
  deleteSlides,
  duplicateSlides,
  expandGroups,
  groupElements,
  insertSlide,
  moveSlides,
  removeElements,
  reorderElements,
  setElementsLocked,
  setSlidesHidden,
  topLevelOf,
  ungroupElements,
  updateElements,
} from './operations';
import type { DeckEdit } from './operations';
import { serializeDeck, validateDeck } from './validate';

function ids(prefix = 'new') {
  let counter = 0;
  return (kind: string) => `${prefix}-${kind}-${(counter += 1)}`;
}

/** Every edit must validate and undo exactly. */
function roundTrip(document: DeckDocument, edit: DeckEdit): DeckDocument {
  const check = validateDeck(edit.result);
  expect(check.ok ? [] : check.issues).toEqual([]);
  const undone = edit.inverse(edit.result);
  expect(serializeDeck(undone.result)).toBe(serializeDeck(document));
  const redone = undone.inverse(undone.result);
  expect(serializeDeck(redone.result)).toBe(serializeDeck(edit.result));
  return edit.result;
}

const rect = (id: string, x = 0): DeckElement => ({
  id,
  type: 'shape',
  geometry: 'rect',
  frame: { x, y: 0, width: 1_000, height: 1_000 },
});

describe('slide operations', () => {
  it('inserts, moves, hides, and deletes slides reversibly', () => {
    const deck = buildFixtureDeck();
    const inserted = roundTrip(
      deck,
      insertSlide(deck, { id: 'slide-x', elements: {}, elementOrder: [] }, 1),
    );
    expect(inserted.slideOrder).toEqual([
      'slide-1',
      'slide-x',
      'slide-2',
      'slide-3',
      'slide-4',
      'slide-5',
    ]);

    const moved = roundTrip(deck, moveSlides(deck, ['slide-4', 'slide-5'], 0));
    expect(moved.slideOrder).toEqual(['slide-4', 'slide-5', 'slide-1', 'slide-2', 'slide-3']);

    const hidden = roundTrip(deck, setSlidesHidden(deck, ['slide-2'], true));
    expect(hidden.slides['slide-2'].hidden).toBe(true);

    const deleted = roundTrip(deck, deleteSlides(deck, ['slide-2']));
    expect(deleted.slideOrder).not.toContain('slide-2');
  });

  it('moves a section to the next surviving slide when its first slide is deleted', () => {
    const deck = buildFixtureDeck();
    const deleted = roundTrip(deck, deleteSlides(deck, ['slide-3']));
    expect(deleted.sections).toEqual([
      { id: 'section-intro', name: 'Introduction', firstSlideId: 'slide-1' },
      { id: 'section-objects', name: 'Objects', firstSlideId: 'slide-4' },
    ]);
  });

  it('never deletes the last slide', () => {
    const deck = buildFixtureDeck();
    expect(() => deleteSlides(deck, deck.slideOrder)).toThrow(/at least one slide/);
  });

  it('duplicates slides with fresh element ids and intact groups', () => {
    const deck = buildFixtureDeck();
    deck.slides['slide-3'].readingOrder = ['s3-image', 's3-title'];
    const edit = duplicateSlides(deck, ['slide-3'], ids());
    const result = roundTrip(deck, edit);
    const copy = result.slides[edit.slideIds[0]];
    expect(result.slideOrder.indexOf(copy.id)).toBe(result.slideOrder.indexOf('slide-3') + 1);
    expect(Object.keys(copy.elements).some((id) => id in deck.slides['slide-3'].elements)).toBe(
      false,
    );
    const group = Object.values(copy.elements).find((element) => element.type === 'group');
    expect(group?.type === 'group' && group.childIds.every((child) => child in copy.elements)).toBe(
      true,
    );
    expect(copy.readingOrder).toHaveLength(2);
    expect(copy.readingOrder?.every((id) => id in copy.elements)).toBe(true);
  });
});

describe('element operations', () => {
  it('adds, updates, and removes elements reversibly', () => {
    const deck = buildFixtureDeck();
    const added = roundTrip(deck, addElements(deck, 'slide-5', [rect('box')]));
    expect(
      added.slides['slide-5'].elementOrder[added.slides['slide-5'].elementOrder.length - 1],
    ).toBe('box');

    const updated = roundTrip(
      added,
      updateElements(added, 'slide-5', { box: (element) => ({ ...element, name: 'Box' }) }),
    );
    expect(updated.slides['slide-5'].elements.box.name).toBe('Box');

    const removed = roundTrip(added, removeElements(added, 'slide-5', ['box']));
    expect(removed.slides['slide-5'].elements.box).toBeUndefined();
  });

  it('removes a group with its children', () => {
    const deck = buildFixtureDeck();
    deck.slides['slide-3'].readingOrder = ['s3-image', 's3-badge-back', 's3-card'];
    const result = roundTrip(deck, removeElements(deck, 'slide-3', ['s3-group']));
    for (const id of ['s3-group', 's3-badge-back', 's3-badge-dot']) {
      expect(result.slides['slide-3'].elements[id]).toBeUndefined();
    }
    expect(result.slides['slide-3'].readingOrder).toEqual(['s3-image', 's3-card']);
  });

  it('dissolves a group left with one child', () => {
    const deck = buildFixtureDeck();
    const result = roundTrip(deck, removeElements(deck, 'slide-3', ['s3-badge-dot']));
    const slide = result.slides['slide-3'];
    expect(slide.elements['s3-group']).toBeUndefined();
    expect(slide.elementOrder).toContain('s3-badge-back');
  });

  it('reorders top-level elements', () => {
    const deck = buildFixtureDeck();
    const order = deck.slides['slide-3'].elementOrder;
    const front = roundTrip(deck, reorderElements(deck, 'slide-3', ['s3-card'], 'front'));
    expect(
      front.slides['slide-3'].elementOrder[front.slides['slide-3'].elementOrder.length - 1],
    ).toBe('s3-card');
    const back = roundTrip(deck, reorderElements(deck, 'slide-3', ['s3-group'], 'back'));
    expect(back.slides['slide-3'].elementOrder[0]).toBe('s3-group');
    const forward = roundTrip(deck, reorderElements(deck, 'slide-3', [order[0]], 'forward'));
    expect(forward.slides['slide-3'].elementOrder[1]).toBe(order[0]);
    expect(reorderElements(deck, 'slide-3', [order[order.length - 1]], 'front').result).toBe(deck);
  });

  it('groups at the topmost member position and ungroups back', () => {
    const deck = buildFixtureDeck();
    const grouped = roundTrip(
      deck,
      groupElements(deck, 'slide-3', ['s3-card', 's3-arrow'], 'g1', {
        x: 0,
        y: 0,
        width: 10,
        height: 10,
      }),
    );
    const slide = grouped.slides['slide-3'];
    expect(slide.elementOrder.indexOf('g1')).toBe(
      deck.slides['slide-3'].elementOrder.indexOf('s3-arrow') - 1,
    );
    expect(topLevelOf(slide, 's3-card')).toBe('g1');
    expect(expandGroups(slide, ['g1'])).toEqual(new Set(['g1', 's3-card', 's3-arrow']));

    const ungrouped = roundTrip(grouped, ungroupElements(grouped, 'slide-3', ['g1']));
    expect(ungrouped.slides['slide-3'].elements.g1).toBeUndefined();
    expect(ungrouped.slides['slide-3'].elementOrder).toEqual(
      expect.arrayContaining(['s3-card', 's3-arrow']),
    );
  });

  it('locks and unlocks', () => {
    const deck = buildFixtureDeck();
    const locked = roundTrip(deck, setElementsLocked(deck, 'slide-3', ['s3-card'], true));
    expect(locked.slides['slide-3'].elements['s3-card'].locked).toBe(true);
    expect(setElementsLocked(locked, 'slide-3', ['s3-card'], true).result).toBe(locked);
  });

  it('composes several edits into one undo step', () => {
    const deck = buildFixtureDeck();
    const edit = composeEdits(deck, [
      (current) => addElements(current, 'slide-5', [rect('a')]),
      (current) => addElements(current, 'slide-5', [rect('b', 2_000)]),
      (current) => setSlidesHidden(current, ['slide-5'], true),
    ]);
    roundTrip(deck, edit);
  });

  it('drives the shared undo history', () => {
    const history = new InkHistory<DeckDocument>();
    let deck = buildFixtureDeck();
    const original = serializeDeck(deck);
    const edit = addElements(deck, 'slide-5', [rect('a')]);
    deck = edit.result;
    history.push(edit, 'Add box');
    expect(history.snapshot().undoLabel).toBe('Add box');
    deck = history.undo(deck)!;
    expect(serializeDeck(deck)).toBe(original);
    deck = history.redo(deck)!;
    expect(deck.slides['slide-5'].elements.a).toBeDefined();
  });
});
