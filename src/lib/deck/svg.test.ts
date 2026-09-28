import { describe, expect, it } from 'vitest';

import type { DeckAssetRef } from '../../types/deck';

import { buildFixtureDeck, FIXTURE_IMAGE_PATH } from './fixture';
import { resolveDeck, resolveSlide } from './resolve';
import { escapeXml, fitSlide, renderSlideSvg } from './svg';
import { createApproximateMeasurer } from './textLayout';

const measurer = createApproximateMeasurer();
const PIXEL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
const resolveAsset = (asset: DeckAssetRef) => (asset.path === FIXTURE_IMAGE_PATH ? PIXEL : null);

/** Everything except the root element's pixel size. */
function withoutRootSize(svg: string): string {
  return svg.replace(/^<svg([^>]*?) width="[^"]*" height="[^"]*"/, '<svg$1');
}

describe('renderSlideSvg', () => {
  it('produces the same scene for the editor, a thumbnail, and presentation mode', () => {
    // The Phase 0 proof for "identical scene output": every view renders the
    // one resolved scene in deck units, and differs only in its output size.
    const deck = buildFixtureDeck();
    for (const slideId of deck.slideOrder) {
      const slide = resolveSlide(deck, slideId);
      const editor = renderSlideSvg(slide, { measurer, resolveAsset, pixelWidth: 1_280 });
      const thumbnail = renderSlideSvg(slide, { measurer, resolveAsset, pixelWidth: 192 });
      const presentation = renderSlideSvg(slide, { measurer, resolveAsset, pixelWidth: 3_840 });
      expect(withoutRootSize(thumbnail)).toBe(withoutRootSize(editor));
      expect(withoutRootSize(presentation)).toBe(withoutRootSize(editor));
      expect(thumbnail).toContain('width="192" height="108"');
      expect(presentation).toContain('width="3840" height="2160"');
    }
  });

  it('is byte-stable across renders', () => {
    const deck = buildFixtureDeck();
    const first = resolveDeck(deck).map((slide) =>
      renderSlideSvg(slide, { measurer, resolveAsset }),
    );
    const second = resolveDeck(buildFixtureDeck()).map((slide) =>
      renderSlideSvg(slide, { measurer, resolveAsset }),
    );
    expect(second).toEqual(first);
  });

  it('draws in deck units with a slide-sized viewBox', () => {
    const svg = renderSlideSvg(resolveSlide(buildFixtureDeck(), 'slide-1'), { measurer });
    expect(svg).toContain('viewBox="0 0 96000 54000"');
    expect(svg).toContain('width="1280" height="720"');
  });

  it('renders text, shapes, lines, tables, and charts from the fixture', () => {
    const deck = buildFixtureDeck();
    const svgs = deck.slideOrder.map((id) =>
      renderSlideSvg(resolveSlide(deck, id), { measurer, resolveAsset }),
    );
    expect(svgs[0]).toContain('Collab Presentations');
    expect(svgs[1]).toContain('>•</text>');
    expect(svgs[1]).toContain('>2</text>'); // slide-number field
    expect(svgs[2]).toContain('rotate(15 ');
    expect(svgs[2]).toContain('<line ');
    expect(svgs[2]).toContain('viewBox="0 50 1600 900"'); // 5% crop top and bottom
    expect(svgs[3]).toContain('>PowerPoint</text>');
    expect(svgs[4]).toContain('Export coverage');
  });

  it('never emits an external URL, even if an asset resolver returns one', () => {
    const svg = renderSlideSvg(resolveSlide(buildFixtureDeck(), 'slide-3'), {
      measurer,
      resolveAsset: () => 'https://attacker.example/track.png',
    });
    expect(svg).not.toContain('attacker.example');
    expect(svg).toContain('Missing image: assets/deck-fixture.png');
  });

  it('escapes document text and ids', () => {
    const deck = buildFixtureDeck();
    const note = deck.slides['slide-5'].elements['s5-note'];
    if (note.type !== 'text') throw new Error('fixture changed');
    note.text.content.paragraphs[0].runs = [
      { kind: 'text', text: '<script>alert("x")</script> & more' },
    ];
    const svg = renderSlideSvg(resolveSlide(deck, 'slide-5'), { measurer });
    expect(svg).not.toContain('<script>');
    expect(svg).toContain('&lt;script&gt;');
    expect(escapeXml('a\u0000b')).toBe('ab');
  });
});

describe('fitSlide', () => {
  it('fits and centres a widescreen slide in any container', () => {
    const slide = { width: 96_000, height: 54_000 };
    expect(fitSlide(slide, { width: 1_280, height: 720 })).toEqual({
      scale: 1,
      width: 1_280,
      height: 720,
      x: 0,
      y: 0,
    });
    const tall = fitSlide(slide, { width: 640, height: 900 });
    expect(tall.width).toBe(640);
    expect(tall.height).toBe(360);
    expect(tall.y).toBe(270);
  });
});
