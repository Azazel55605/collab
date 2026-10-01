// @vitest-environment node
import { describe, expect, it } from 'vitest';

import { exportDeckPdf } from './exportPdf';
import { buildFixtureDeck } from './fixture';
import { buildDeckPdf } from './pdf';
import { plainText, resolveSlide } from './resolve';
import { createApproximateMeasurer } from './textLayout';

const JPEG = Uint8Array.from(
  atob(
    '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACP/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AVN//2Q==',
  ),
  (char) => char.charCodeAt(0),
);

async function readPdf(bytes: Uint8Array) {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const document = await pdfjs.getDocument({
    data: bytes.slice(),
    useSystemFonts: false,
    verbosity: 0,
  }).promise;
  const pages: Array<{
    text: string;
    items: Array<{ str: string; transform: number[] }>;
    links: unknown[];
  }> = [];
  for (let number = 1; number <= document.numPages; number += 1) {
    const page = await document.getPage(number);
    const content = await page.getTextContent();
    const items = content.items.filter(
      (item): item is (typeof content.items)[number] & { str: string; transform: number[] } =>
        'str' in item,
    );
    pages.push({
      text: items.map((item) => item.str).join(' '),
      items,
      links: await page.getAnnotations(),
    });
  }
  const metadata = await document.getMetadata();
  return { pages, info: metadata.info as Record<string, unknown> };
}

describe('deck PDF writer', () => {
  it('extracts the invisible text layer exactly, astral characters included', async () => {
    const pdf = buildDeckPdf(
      [
        {
          width: 200,
          height: 100,
          jpeg: JPEG,
          pixelWidth: 1,
          pixelHeight: 1,
          text: [
            { text: 'Grüße, 日本語 😀', matrix: [1, 0, 0, 1, 10, 30], size: 12, width: 120 },
            { text: 'second (line) \\', matrix: [1, 0, 0, 1, 10, 60], size: 12, width: 90 },
          ],
          links: [
            {
              x: 10,
              y: 20,
              width: 50,
              height: 12,
              target: { kind: 'uri', uri: 'https://example.com/a b' },
            },
            { x: 10, y: 50, width: 50, height: 12, target: { kind: 'page', pageIndex: 1 } },
          ],
        },
        { width: 200, height: 100, jpeg: JPEG, pixelWidth: 1, pixelHeight: 1 },
      ],
      { title: 'Quarterly Überblick' },
    );
    const { pages, info } = await readPdf(pdf);
    expect(info.Title).toBe('Quarterly Überblick');
    expect(pages).toHaveLength(2);
    expect(pages[0].text).toContain('Grüße, 日本語 😀');
    expect(pages[0].text).toContain('second (line) \\');
    // Baseline at y = 30 from the top of a 100 pt page is y = 70 in PDF space.
    const first = pages[0].items.find((item) => item.str.startsWith('Grüße'));
    expect(first?.transform[4]).toBeCloseTo(10, 3);
    expect(first?.transform[5]).toBeCloseTo(70, 3);
    expect(pages[0].links).toHaveLength(2);
    expect(pages[0].links[0]).toMatchObject({ url: 'https://example.com/a%20b' });
    expect(pages[1].text).toBe('');
  });

  it('makes a fixture deck searchable: every slide title is in its page text', async () => {
    const deck = buildFixtureDeck();
    const measurer = createApproximateMeasurer();
    const pdf = await exportDeckPdf(
      deck,
      { kind: 'slides' },
      { measurer, rasterize: async () => JPEG },
    );
    const { pages } = await readPdf(pdf);
    expect(pages).toHaveLength(deck.slideOrder.length);
    const slide = resolveSlide(deck, deck.slideOrder[0]);
    const title = slide.items.find((item) => item.kind === 'shape' && item.text);
    const words = plainText(title?.kind === 'shape' ? title.text : null)
      .split(/\s+/)
      .filter(Boolean);
    for (const word of words) expect(pages[0].text).toContain(word);
  });

  it('writes handouts with notes as paper pages', async () => {
    const deck = buildFixtureDeck();
    const measurer = createApproximateMeasurer();
    const pdf = await exportDeckPdf(
      deck,
      { kind: 'handouts', paper: 'a4', orientation: 'portrait', slidesPerPage: 3, notes: true },
      { measurer, rasterize: async () => JPEG, title: 'Fixture deck', includeHidden: true },
    );
    const text = new TextDecoder('latin1').decode(pdf);
    expect(text.match(/\/MediaBox \[0 0 595.28 841.89\]/g)).toHaveLength(2);
    const { pages } = await readPdf(pdf);
    expect(pages[0].text.replace(/\s+/g, ' ')).toContain(
      'export never changes the backing format.',
    );
  });
});
