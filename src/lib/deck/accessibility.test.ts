import { describe, expect, it } from 'vitest';

import {
  accessibleItemLabel,
  accessibleSlideItems,
  auditDeckAccessibility,
  contrastRatio,
  slideReadingOrder,
} from './accessibility';
import { buildFixtureDeck } from './fixture';
import { resolveSlide } from './resolve';

describe('deck accessibility', () => {
  it('keeps assistive reading order independent from paint order', () => {
    const deck = buildFixtureDeck();
    const slide = deck.slides['slide-3'];
    slide.readingOrder = ['s3-image', 's3-title'];

    expect(slideReadingOrder(slide).slice(0, 3)).toEqual(['s3-image', 's3-title', 's3-card']);
    const semantic = accessibleSlideItems(resolveSlide(deck, slide.id));
    const authored = semantic.filter((item) => item.origin === 'slide');
    expect(authored.slice(0, 2).map((item) => item.id)).toEqual(['s3-image', 's3-title']);
    expect(slide.elementOrder[0]).toBe('s3-title');
  });

  it('uses authored alt text and bounded useful fallbacks', () => {
    const deck = buildFixtureDeck();
    const items = resolveSlide(deck, 'slide-3').items;
    expect(accessibleItemLabel(items.find((item) => item.id === 's3-image')!)).toBe(
      'Architecture diagram',
    );
    expect(accessibleItemLabel(items.find((item) => item.id === 's3-line')!)).toBe('Line');
  });

  it('reports missing alternative text, low contrast, and missing fonts', () => {
    const deck = buildFixtureDeck();
    const image = deck.slides['slide-3'].elements['s3-image'];
    delete image.altText;
    const card = deck.slides['slide-3'].elements['s3-card'];
    if (card.type !== 'shape' || !card.text) throw new Error('fixture changed');
    card.text.content.paragraphs[0].runs[0].style = {
      ...card.text.content.paragraphs[0].runs[0].style,
      color: { kind: 'theme', token: 'accent1' },
    };
    const issues = auditDeckAccessibility(deck, {
      fontAvailable: (family) => family === 'sans-serif',
    });
    expect(issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'missing-alt-text', elementId: 's3-image' }),
        expect.objectContaining({ code: 'low-contrast', elementId: 's3-card' }),
        expect.objectContaining({ code: 'missing-font' }),
      ]),
    );
  });

  it('computes WCAG contrast ratios', () => {
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 5);
    expect(contrastRatio('#777777', '#ffffff')).toBeCloseTo(4.48, 2);
    expect(contrastRatio('bad', '#ffffff')).toBeNull();
  });
});
