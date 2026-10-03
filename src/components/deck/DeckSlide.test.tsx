import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { buildFixtureDeck } from '../../lib/deck/fixture';
import { resolveSlide } from '../../lib/deck/resolve';
import { createApproximateMeasurer } from '../../lib/deck/textLayout';

import { DeckSlide } from './DeckSlide';

describe('DeckSlide accessibility companion', () => {
  it('keeps the visual slide and exposes authored objects in reading order', () => {
    const deck = buildFixtureDeck();
    deck.slides['slide-3'].readingOrder = ['s3-image', 's3-title'];
    render(
      <DeckSlide
        slide={resolveSlide(deck, 'slide-3')}
        width={640}
        measurer={createApproximateMeasurer()}
        resolveAsset={() => null}
      />,
    );

    const visual = screen.getByRole('img', { name: 'Slide 3' });
    const contents = screen.getByRole('list', { name: 'Slide contents' });
    expect(visual.getAttribute('aria-describedby')).toBe(contents.id);
    const items = within(contents).getAllByRole('listitem');
    expect(items.map((item) => item.textContent).slice(-2)).not.toEqual([]);
    expect(items.findIndex((item) => item.textContent === 'Architecture diagram')).toBeLessThan(
      items.findIndex((item) => item.textContent === 'Shapes, lines, and images'),
    );
  });
});
