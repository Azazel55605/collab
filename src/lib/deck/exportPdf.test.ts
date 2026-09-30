import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  DECK_MAX_RASTER_EDGE,
  DeckExportCancelledError,
  exportDeckPdf,
  rasterizeOutputPages,
  rasterSize,
} from './exportPdf';
import { buildFixtureDeck } from './fixture';
import { buildOutputPages } from './output';
import { createApproximateMeasurer } from './textLayout';

/** A valid 1x1 JPEG, so the PDF can be opened by real readers in inspection runs. */
const JPEG = Uint8Array.from(
  atob(
    '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACP/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AVN//2Q==',
  ),
  (char) => char.charCodeAt(0),
);

const measurer = createApproximateMeasurer();

describe('deck PDF and image output', () => {
  it('rasterizes every visible slide from its SVG at the requested density', async () => {
    const seen: Array<{ svg: string; width: number; height: number }> = [];
    const pages = await rasterizeOutputPages(
      buildOutputPages(buildFixtureDeck(), { kind: 'slides' }, { measurer }),
      {
        pixelsPerPoint: 2,
        rasterize: async (svg, width, height) => {
          seen.push({ svg, width, height });
          return JPEG;
        },
      },
    );
    expect(pages).toHaveLength(5);
    expect(seen[0]).toMatchObject({ width: 1_920, height: 1_080 });
    expect(seen[0].svg).toContain('width="1920" height="1080"');
    expect(seen[0].svg).toContain('viewBox="0 0 960 540"');
    expect(pages[0]).toMatchObject({ width: 960, height: 540 });
    expect(pages[0].text?.length).toBeGreaterThan(0);
  });

  it('skips hidden slides unless named, and bounds the raster size', () => {
    const deck = buildFixtureDeck();
    deck.slides['slide-4'].hidden = true;
    expect(buildOutputPages(deck, { kind: 'slides' }, { measurer })).toHaveLength(4);
    expect(
      buildOutputPages(deck, { kind: 'slides' }, { measurer, includeHidden: true }),
    ).toHaveLength(5);
    expect(
      buildOutputPages(deck, { kind: 'slides' }, { measurer, slideIds: ['slide-4'] }),
    ).toHaveLength(1);
    const huge = rasterSize(960, 540, 20);
    expect(Math.max(huge.pixelWidth, huge.pixelHeight)).toBe(DECK_MAX_RASTER_EDGE);
  });

  it('writes a PDF whose pages have the slide’s physical size', async () => {
    const pdf = await exportDeckPdf(
      buildFixtureDeck(),
      { kind: 'slides' },
      { measurer, rasterize: async () => JPEG, title: 'Fixture' },
    );
    const text = new TextDecoder('latin1').decode(pdf);
    expect(text.startsWith('%PDF-1.4')).toBe(true);
    expect(text).toContain('/Count 5');
    expect(text.match(/\/MediaBox \[0 0 960 540\]/g)).toHaveLength(5);
    expect(text).toContain('3 Tr');
    const out = process.env.COLLAB_DECK_FIXTURE_OUT;
    if (out) {
      mkdirSync(out, { recursive: true });
      writeFileSync(join(out, 'deck-fixture-raster.pdf'), pdf);
    }
  });

  it('stops between pages when cancelled', async () => {
    let calls = 0;
    await expect(
      exportDeckPdf(
        buildFixtureDeck(),
        { kind: 'slides' },
        { measurer, rasterize: async () => JPEG, isCancelled: () => calls++ > 1 },
      ),
    ).rejects.toBeInstanceOf(DeckExportCancelledError);
  });
});
