import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  DECK_MAX_RASTER_EDGE,
  DeckExportCancelledError,
  exportDeckToPdf,
  renderDeckPages,
} from './exportPdf';
import { buildFixtureDeck } from './fixture';
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
  it('rasterizes every visible slide from its SVG at the requested scale', async () => {
    const seen: Array<{ svg: string; width: number; height: number }> = [];
    const pages = await renderDeckPages(buildFixtureDeck(), {
      measurer,
      scale: 2,
      rasterize: async (svg, width, height) => {
        seen.push({ svg, width, height });
        return JPEG;
      },
    });
    expect(pages).toHaveLength(5);
    expect(seen[0]).toMatchObject({ width: 2_560, height: 1_440 });
    expect(seen[0].svg).toContain('width="2560" height="1440"');
    expect(pages[0]).toMatchObject({ pointWidth: 960, pointHeight: 540 });
  });

  it('skips hidden slides unless asked, and bounds the raster size', async () => {
    const deck = buildFixtureDeck();
    deck.slides['slide-4'].hidden = true;
    const visible = await renderDeckPages(deck, { measurer, rasterize: async () => JPEG });
    expect(visible).toHaveLength(4);
    const huge = await renderDeckPages(deck, {
      measurer,
      rasterize: async () => JPEG,
      scale: 20,
      slideIds: ['slide-1'],
    });
    expect(Math.max(huge[0].pixelWidth, huge[0].pixelHeight)).toBeLessThanOrEqual(
      DECK_MAX_RASTER_EDGE,
    );
  });

  it('writes a PDF whose pages have the slide’s physical size', async () => {
    const pdf = await exportDeckToPdf(buildFixtureDeck(), {
      measurer,
      rasterize: async () => JPEG,
    });
    const text = new TextDecoder('latin1').decode(pdf);
    expect(text.startsWith('%PDF-1.4')).toBe(true);
    expect(text).toContain('/Count 5');
    expect(text.match(/\/MediaBox \[0 0 960 540\]/g)).toHaveLength(5);
    const out = process.env.COLLAB_DECK_FIXTURE_OUT;
    if (out) {
      mkdirSync(out, { recursive: true });
      writeFileSync(join(out, 'deck-fixture-raster.pdf'), pdf);
    }
  });

  it('stops between slides when cancelled', async () => {
    let calls = 0;
    await expect(
      renderDeckPages(buildFixtureDeck(), {
        measurer,
        rasterize: async () => JPEG,
        isCancelled: () => calls++ > 1,
      }),
    ).rejects.toBeInstanceOf(DeckExportCancelledError);
  });
});
