import { describe, expect, it } from 'vitest';

import { collectDeckAssetPaths } from './assets';
import { buildFixtureDeck, FIXTURE_IMAGE_PATH } from './fixture';

describe('collectDeckAssetPaths', () => {
  it('finds image elements, background fills, and embed previews once each', () => {
    const deck = buildFixtureDeck();
    deck.slides['slide-4'].background = {
      kind: 'image',
      fit: 'cover',
      asset: { path: 'assets/bg.png', mediaType: 'image/png', pixelWidth: 1, pixelHeight: 1 },
    };
    deck.slides['slide-1'].elements['dup'] = {
      id: 'dup',
      type: 'image',
      frame: { x: 0, y: 0, width: 10, height: 10 },
      asset: { path: FIXTURE_IMAGE_PATH, mediaType: 'image/png', pixelWidth: 1, pixelHeight: 1 },
    };
    expect(collectDeckAssetPaths(deck)).toEqual(['assets/bg.png', FIXTURE_IMAGE_PATH]);
  });
});
