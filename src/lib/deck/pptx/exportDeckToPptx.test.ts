import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import JSZip from 'jszip';
import { beforeAll, describe, expect, it } from 'vitest';

import { buildFixtureDeck, FIXTURE_IMAGE_PATH } from '../fixture';
import { unitsToEmu } from '../units';

import { exportDeckToPptx, repairParagraphXml } from './exportDeckToPptx';
import type { DeckPptxExportResult } from './exportDeckToPptx';
import { countBySeverity } from './exportReport';

const PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

let result: DeckPptxExportResult;
let zip: JSZip;
const part = (name: string) => zip.file(name)!.async('string');

beforeAll(async () => {
  result = await exportDeckToPptx(buildFixtureDeck(), { assets: { [FIXTURE_IMAGE_PATH]: PNG } });
  zip = await JSZip.loadAsync(result.bytes);
  // Set COLLAB_DECK_FIXTURE_OUT to keep the file for inspection in real applications.
  const out = process.env.COLLAB_DECK_FIXTURE_OUT;
  if (out) {
    mkdirSync(out, { recursive: true });
    writeFileSync(join(out, 'deck-fixture.pptx'), result.bytes);
  }
}, 30_000);

describe('exportDeckToPptx', () => {
  it('writes a presentation package with one slide per deck slide, in order', async () => {
    const slides = Object.keys(zip.files).filter((name) =>
      /^ppt\/slides\/slide\d+\.xml$/.test(name),
    );
    expect(slides).toHaveLength(5);
    expect(await part('ppt/slides/slide1.xml')).toContain('Collab Presentations');
    expect(await part('ppt/slides/slide5.xml')).toContain('A free text box');
  });

  it('sets the slide size in exact EMU', async () => {
    const presentation = await part('ppt/presentation.xml');
    expect(presentation).toContain(`cx="${unitsToEmu(96_000)}" cy="${unitsToEmu(54_000)}"`);
  });

  it('places elements at exact EMU offsets', async () => {
    const xml = await part('ppt/slides/slide3.xml');
    // s3-card is at (48pt, 140pt) = (4,800, 14,000) deck units.
    expect(xml).toContain(`<a:off x="${unitsToEmu(4_800)}" y="${unitsToEmu(14_000)}"/>`);
    expect(xml).toContain('prst="roundRect"');
  });

  it('maps rotation, dashes, arrowheads, and crop', async () => {
    const xml = await part('ppt/slides/slide3.xml');
    expect(xml).toContain('rot="900000"'); // 15 degrees in 60,000ths
    expect(xml).toContain('prst="rightArrow"');
    expect(xml).toContain('<a:prstDash val="dash"/>');
    expect(xml).toMatch(/<a:tailEnd type="triangle"/);
    expect(xml).toContain('<a:srcRect l="0" r="0" t="5000" b="5000"/>');
  });

  it('carries inherited text styles, bullets, levels, and insets', async () => {
    const title = await part('ppt/slides/slide1.xml');
    expect(title).toContain('sz="4000"');
    expect(title).toMatch(/<a:solidFill><a:srgbClr val="FFFFFF"/);
    const body = await part('ppt/slides/slide2.xml');
    expect(body).toContain('<a:buChar char="&#x2022;"/>');
    expect(body).toContain('<a:buChar char="&#x2013;"/>');
    // One <a:p> per deck paragraph: runs with different styles stay together.
    const bodyShape = body.slice(body.indexOf('The '), body.indexOf('before changing the schema'));
    expect(bodyShape.match(/<a:p>/g)).toHaveLength(3);
    expect(body).toContain('lvl="1"');
    expect(body).toContain('b="1"');
    // PowerPoint's default insets, from the deck default: 0.1 in and 0.05 in.
    expect(body).toContain('lIns="91440"');
    expect(body).toContain('tIns="45720"');
    expect(body).toMatch(/rIns="91440" bIns="45720"/);
  });

  it('writes at most one paragraph-properties element per paragraph, first', async () => {
    // PptxGenJS emits one per run; LibreOffice then drops bullets and indents.
    for (const name of Object.keys(zip.files).filter((entry) =>
      /^ppt\/slides\/slide\d+\.xml$/.test(entry),
    )) {
      const xml = await part(name);
      for (const [, inner] of xml.matchAll(/<a:p>([\s\S]*?)<\/a:p>/g)) {
        const count = inner.match(/<a:pPr\b/g)?.length ?? 0;
        expect(count).toBeLessThanOrEqual(1);
        if (count === 1) expect(inner.startsWith('<a:pPr')).toBe(true);
      }
    }
  });

  it('repairs paragraph XML without touching valid paragraphs', () => {
    const valid = '<a:p><a:pPr algn="l"/><a:r><a:t>ok</a:t></a:r></a:p>';
    expect(repairParagraphXml(valid)).toBe(valid);
    expect(
      repairParagraphXml(
        '<a:p><a:pPr lvl="1"><a:buChar char="x"/></a:pPr><a:r/><a:pPr algn="l"><a:buNone/></a:pPr><a:r/></a:p>',
      ),
    ).toBe('<a:p><a:pPr lvl="1"><a:buChar char="x"/></a:pPr><a:r/><a:r/></a:p>');
  });

  it('writes speaker notes and sections', async () => {
    const notes = Object.keys(zip.files).filter((name) =>
      /^ppt\/notesSlides\/notesSlide\d+\.xml$/.test(name),
    );
    const texts = await Promise.all(notes.map((name) => part(name)));
    expect(
      texts.some((text) => text.includes('Stress that export never changes the backing format.')),
    ).toBe(true);
    const presentation = await part('ppt/presentation.xml');
    expect(presentation).toContain('name="Introduction"');
    expect(presentation).toContain('name="Objects"');
  });

  it('exports tables and chart data', async () => {
    const table = await part('ppt/slides/slide4.xml');
    expect(table).toContain('<a:tbl>');
    expect(table).toContain('PowerPoint');
    const charts = Object.keys(zip.files).filter((name) =>
      /^ppt\/charts\/chart\d+\.xml$/.test(name),
    );
    expect(charts).toHaveLength(1);
    const chart = await part(charts[0]);
    expect(chart).toContain('<c:barDir val="col"/>');
    expect(chart).toContain('<c:v>92</c:v>');
  });

  it('reports what it flattened, approximated, and omitted', () => {
    const codes = result.report.entries.map((entry) => entry.code);
    expect(codes).toEqual(
      expect.arrayContaining([
        'masters-flattened',
        'group-flattened',
        'slide-number-static',
        'vault-link',
        'chart-styling',
      ]),
    );
    expect(result.report.slides).toBe(5);
    expect(result.report.exported).toBeGreaterThan(15);
    expect(result.report.fonts).toEqual(['Inter']);
    expect(result.report.missingAssets).toEqual([]);
    expect(countBySeverity(result.report).missing).toBe(0);
  });

  it('reports a missing image and writes a placeholder instead of failing', async () => {
    const missing = await exportDeckToPptx(buildFixtureDeck(), { slideIds: ['slide-3'] });
    expect(missing.report.missingAssets).toEqual([FIXTURE_IMAGE_PATH]);
    expect(countBySeverity(missing.report).missing).toBe(1);
    const missingZip = await JSZip.loadAsync(missing.bytes);
    expect(Object.keys(missingZip.files).some((name) => /^ppt\/media\/.+/.test(name))).toBe(false);
  });
});
