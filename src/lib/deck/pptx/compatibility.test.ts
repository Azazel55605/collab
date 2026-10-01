// @vitest-environment node
/**
 * Visual-semantic comparison with a real application.
 *
 * Exports the fixture, has LibreOffice Impress render it to PDF, and compares
 * each page with Collab's own rendering of the same slide (SVG through rsvg),
 * both rasterized by poppler at one size. The comparison is of what is drawn,
 * not of bytes, and allows for the one expected difference: font
 * substitution when a deck's font is not installed.
 *
 * Needs `soffice` (with Impress), `pdftoppm`, and `rsvg-convert`; skipped
 * unless COLLAB_PPTX_RENDER=1. Set COLLAB_DECK_FIXTURE_OUT to keep the files.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import type { DeckDocument, DeckParagraph } from '../../../types/deck';
import { createSlideForLayout } from '../design';
import { createDeckDocument } from '../document';
import { buildFixtureDeck, FIXTURE_IMAGE_PATH } from '../fixture';
import { resolveDeck } from '../resolve';
import { renderSlideSvg } from '../svg';
import { DECK_TEMPLATES } from '../templates';
import type { DeckTemplateId } from '../templates';
import { createApproximateMeasurer } from '../textLayout';

import { exportDeckToPptx } from './exportDeckToPptx';

const PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
const WIDTH = 320;
const HEIGHT = 180;

/** Reads a binary PPM (P6). */
function readPpm(file: string): { width: number; height: number; data: Uint8Array } {
  const bytes = readFileSync(file);
  let offset = 0;
  const token = () => {
    while (/\s/.test(String.fromCharCode(bytes[offset]))) offset += 1;
    let value = '';
    while (!/\s/.test(String.fromCharCode(bytes[offset])))
      value += String.fromCharCode(bytes[offset++]);
    return value;
  };
  if (token() !== 'P6') throw new Error(`${file} is not a binary PPM`);
  const width = Number(token());
  const height = Number(token());
  token(); // max value
  offset += 1;
  return { width, height, data: bytes.subarray(offset, offset + width * height * 3) };
}

function rasterize(pdf: string, prefix: string): string[] {
  execFileSync('pdftoppm', [
    '-scale-to-x',
    String(WIDTH),
    '-scale-to-y',
    String(HEIGHT),
    pdf,
    prefix,
  ]);
  const dir = join(prefix, '..');
  const stem = prefix.split('/').pop()!;
  return readdirSync(dir)
    .filter((name) => name.startsWith(`${stem}-`) && name.endsWith('.ppm'))
    .sort()
    .map((name) => join(dir, name));
}

/** Share of pixels whose colour differs by more than a quarter of the range. */
function difference(a: string, b: string): number {
  const left = readPpm(a);
  const right = readPpm(b);
  expect([left.width, left.height]).toEqual([right.width, right.height]);
  let different = 0;
  for (let index = 0; index < left.data.length; index += 3) {
    const delta =
      Math.abs(left.data[index] - right.data[index]) +
      Math.abs(left.data[index + 1] - right.data[index + 1]) +
      Math.abs(left.data[index + 2] - right.data[index + 2]);
    if (delta > 192) different += 1;
  }
  return different / (left.width * left.height);
}

/** A deck in one built-in design with a slide for every layout, every placeholder filled. */
function templateDeck(template: DeckTemplateId): DeckDocument {
  const deck = createDeckDocument({
    id: template,
    name: template,
    now: '2026-10-01T00:00:00Z',
    template,
  });
  const paragraph = (id: string, text: string, level = 0): DeckParagraph => ({
    id,
    ...(level ? { style: { level } } : {}),
    runs: [{ kind: 'text', text }],
  });
  deck.slides = {};
  deck.slideOrder = [];
  for (const layout of Object.values(deck.layouts)) {
    const slide = createSlideForLayout(`s-${layout.id}`, layout);
    for (const element of Object.values(slide.elements)) {
      if (element.type !== 'text' || !element.placeholder) continue;
      const type = element.placeholder.type;
      if (type === 'slideNumber') continue;
      const paragraphs =
        type === 'body' || type === 'content'
          ? [
              paragraph(`${element.id}-1`, `${layout.name}: the first point`),
              paragraph(`${element.id}-2`, 'A detail one level down', 1),
              paragraph(`${element.id}-3`, 'The second point'),
            ]
          : [paragraph(`${element.id}-1`, type === 'title' ? layout.name : `A ${type}`)];
      element.text = { ...element.text, content: { paragraphs } };
    }
    deck.slides[slide.id] = slide;
    deck.slideOrder.push(slide.id);
  }
  return deck;
}

/** Exports, renders in LibreOffice, and returns each slide's share of differing pixels. */
async function compare(dir: string, name: string, deck: DeckDocument): Promise<number[]> {
  const { bytes } = await exportDeckToPptx(deck, { assets: { [FIXTURE_IMAGE_PATH]: PNG } });
  writeFileSync(join(dir, `${name}.pptx`), bytes);
  execFileSync(
    'soffice',
    ['--headless', '--convert-to', 'pdf', '--outdir', dir, join(dir, `${name}.pptx`)],
    { stdio: 'ignore', timeout: 120_000 },
  );
  const office = rasterize(join(dir, `${name}.pdf`), join(dir, `${name}-office`));
  expect(office).toHaveLength(deck.slideOrder.length);
  const measurer = createApproximateMeasurer();
  return resolveDeck(deck).map((slide, index) => {
    const svg = join(dir, `${name}-collab-${index + 1}.svg`);
    writeFileSync(
      svg,
      renderSlideSvg(slide, { measurer, resolveAsset: () => PNG, pixelWidth: 960 }),
    );
    execFileSync('rsvg-convert', ['-f', 'pdf', '-o', `${svg}.pdf`, svg]);
    const [collab] = rasterize(`${svg}.pdf`, join(dir, `${name}-collab-${index + 1}`));
    return difference(collab, office[index]);
  });
}

describe.skipIf(!process.env.COLLAB_PPTX_RENDER)('PowerPoint export in LibreOffice Impress', () => {
  it('draws every slide as Collab does, apart from font substitution', async () => {
    const dir = process.env.COLLAB_DECK_FIXTURE_OUT ?? mkdtempSync(join(tmpdir(), 'deck-pptx-'));
    mkdirSync(dir, { recursive: true });
    const results: Record<string, number[]> = {
      fixture: await compare(dir, 'deck-fixture', buildFixtureDeck()),
    };
    for (const template of DECK_TEMPLATES) {
      results[template.id] = await compare(
        dir,
        `template-${template.id}`,
        templateDeck(template.id),
      );
    }
    writeFileSync(join(dir, 'differences.json'), JSON.stringify(results, null, 1));
    // Text drawn in a substituted font moves glyph edges, and a chart's axis
    // labels follow the viewer; shapes, colours, and positions must agree
    // everywhere else.
    for (const share of Object.values(results).flat()) expect(share).toBeLessThan(0.08);
  }, 600_000);
});
