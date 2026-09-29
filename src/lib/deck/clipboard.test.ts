import { describe, expect, it } from 'vitest';

import { copyElements, parseClipboard, preparePaste, textToParagraphs } from './clipboard';
import { buildFixtureDeck } from './fixture';
import { createInsertedElement } from './insert';
import { addElements } from './operations';
import { slideGeometry } from './transform';
import { validateDeck } from './validate';

function ids() {
  let counter = 0;
  return (kind: string) => `paste-${kind}-${(counter += 1)}`;
}

describe('deck clipboard', () => {
  it('round-trips a selection with groups into another slide as valid content', () => {
    const deck = buildFixtureDeck();
    const text = copyElements(slideGeometry(deck, 'slide-3'), ['s3-group', 's3-card']);
    const payload = parseClipboard(text)!;
    expect(payload.topLevel).toEqual(['s3-card', 's3-group']);
    expect(payload.elements).toHaveLength(4);

    const pasted = preparePaste(payload, ids(), 1_200);
    const result = addElements(deck, 'slide-5', pasted.elements, {
      topLevelIds: pasted.topLevel,
    }).result;
    const check = validateDeck(result);
    expect(check.ok ? [] : check.issues).toEqual([]);
    const card = pasted.elements.find(
      (element) =>
        element.name === undefined && element.type === 'shape' && element.geometry === 'roundRect',
    )!;
    expect(card.frame?.x).toBe(deck.slides['slide-3'].elements['s3-card'].frame!.x + 1_200);
  });

  it('makes placeholders self-contained so they paste onto any layout', () => {
    const deck = buildFixtureDeck();
    const payload = parseClipboard(copyElements(slideGeometry(deck, 'slide-2'), ['s2-title']))!;
    const [title] = payload.elements;
    expect(title.placeholder).toBeUndefined();
    expect(title.frame).toMatchObject({ x: 4_800, y: 3_600 });
    const pasted = preparePaste(payload, ids(), 0);
    const result = addElements(deck, 'slide-1', pasted.elements).result;
    expect(validateDeck(result).ok).toBe(true);
  });

  it('ignores foreign and oversized clipboard text', () => {
    expect(parseClipboard('just some text')).toBeNull();
    expect(parseClipboard('collab-deck-elements/v1\n{not json')).toBeNull();
    expect(parseClipboard(`collab-deck-elements/v1\n${' '.repeat(9 * 1024 * 1024)}`)).toBeNull();
  });

  it('turns plain text into paragraphs', () => {
    expect(textToParagraphs('one\r\n\ntwo', 't').map((p) => p.runs.length)).toEqual([1, 0, 1]);
  });
});

describe('inserted elements', () => {
  it('are valid on every kind and centred on the slide', () => {
    const deck = buildFixtureDeck();
    for (const kind of ['text', 'rect', 'ellipse', 'roundRect', 'line'] as const) {
      const element = createInsertedElement(deck, `new-${kind}`, kind);
      const result = addElements(deck, 'slide-5', [element]).result;
      const check = validateDeck(result);
      expect(check.ok ? [] : check.issues, kind).toEqual([]);
    }
    const rect = createInsertedElement(deck, 'r', 'rect');
    expect(rect.frame!.x + rect.frame!.width / 2).toBeCloseTo(deck.size.width / 2, -1);
  });
});
