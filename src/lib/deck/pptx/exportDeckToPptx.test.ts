import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import JSZip from 'jszip';
import { beforeAll, describe, expect, it } from 'vitest';

import { buildFixtureDeck, FIXTURE_IMAGE_PATH } from '../fixture';
import { unitsToEmu } from '../units';

import { exportDeckToPptx } from './exportDeckToPptx';
import type { DeckPptxExportResult } from './exportDeckToPptx';
import { countBySeverity } from './exportReport';

const PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
const SVG = `data:image/svg+xml;base64,${btoa('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10" fill="red"/></svg>')}`;

let result: DeckPptxExportResult;
let zip: JSZip;
const part = (name: string) => zip.file(name)!.async('string');
const names = (pattern: RegExp) => Object.keys(zip.files).filter((name) => pattern.test(name));

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
  it('writes a well-formed package: every XML part parses and every relationship resolves', async () => {
    const parser = new DOMParser();
    for (const name of names(/\.(xml|rels)$/)) {
      const xml = await part(name);
      const doc = parser.parseFromString(xml, 'application/xml');
      expect(doc.getElementsByTagName('parsererror'), name).toHaveLength(0);
    }
    for (const relsName of names(/\.rels$/)) {
      // `ppt/_rels/presentation.xml.rels` describes `ppt/presentation.xml`; targets are relative to `ppt/`.
      const base = relsName.replace(/_rels\/[^/]*\.rels$/, '');
      const xml = await part(relsName);
      for (const [, target, mode] of xml.matchAll(/Target="([^"]+)"(?: TargetMode="(\w+)")?/g)) {
        if (mode === 'External') continue;
        const parts = `${base}${target}`.split('/');
        const resolved: string[] = [];
        for (const segment of parts) {
          if (segment === '..') resolved.pop();
          else if (segment && segment !== '.') resolved.push(segment);
        }
        expect(zip.file(resolved.join('/')), `${relsName} → ${target}`).not.toBeNull();
      }
    }
    // No folder entries: packages hold parts only.
    expect(Object.values(zip.files).some((entry) => entry.dir)).toBe(false);
    // Every part is declared in [Content_Types].xml (by default extension or override).
    const types = await part('[Content_Types].xml');
    for (const name of Object.keys(zip.files)) {
      if (name === '[Content_Types].xml') continue;
      const extension = name.split('.').pop()!;
      expect(
        types.includes(`PartName="/${name}"`) || types.includes(`Extension="${extension}"`),
        name,
      ).toBe(true);
    }
  });

  it('writes one slide per deck slide, in order, at the slide size in exact EMU', async () => {
    expect(names(/^ppt\/slides\/slide\d+\.xml$/)).toHaveLength(5);
    expect(await part('ppt/slides/slide1.xml')).toContain('Collab Presentations');
    expect(await part('ppt/slides/slide5.xml')).toContain('A free text box');
    const presentation = await part('ppt/presentation.xml');
    expect(presentation).toContain(`cx="${unitsToEmu(96_000)}" cy="${unitsToEmu(54_000)}"`);
  });

  it('exports masters and layouts, and links slide placeholders to their layout', async () => {
    expect(names(/^ppt\/slideMasters\/slideMaster\d+\.xml$/)).toHaveLength(1);
    const layouts = await Promise.all(
      names(/^ppt\/slideLayouts\/slideLayout\d+\.xml$/).map((name) => part(name)),
    );
    expect(layouts.some((xml) => xml.includes('name="Title slide"'))).toBe(true);
    const titleLayout = layouts.find((xml) => xml.includes('name="Title slide"'))!;
    expect(titleLayout).toContain('<p:ph type="title" hasCustomPrompt="1"/>');
    expect(titleLayout).toMatch(/<p:ph type="subTitle" idx="\d+" hasCustomPrompt="1"\/>/);
    const slide = await part('ppt/slides/slide1.xml');
    expect(slide).toContain('<p:ph type="title"/>');
    // The slide keeps its own position and formatting.
    expect(slide).toMatch(/<a:off x="\d+" y="\d+"\/>/);
    expect(slide).toContain('sz="4000"');
    expect(slide).toMatch(/<a:srgbClr val="FFFFFF"\/>/);
  });

  it('writes the deck theme as the file theme', async () => {
    const theme = await part('ppt/theme/theme1.xml');
    expect(theme).toContain('<a:accent1><a:srgbClr val="6D5DFC"/></a:accent1>');
    expect(theme).toContain('<a:majorFont><a:latin typeface="Inter"/>');
  });

  it('places elements at exact EMU offsets with rotation, dashes, arrowheads, and crop', async () => {
    const xml = await part('ppt/slides/slide3.xml');
    // s3-card is at (48pt, 140pt) = (4,800, 14,000) deck units.
    expect(xml).toContain(`<a:off x="${unitsToEmu(4_800)}" y="${unitsToEmu(14_000)}"/>`);
    expect(xml).toContain('prst="roundRect"');
    expect(xml).toContain('rot="900000"'); // 15 degrees in 60,000ths
    expect(xml).toContain('prst="rightArrow"');
    expect(xml).toContain('<a:prstDash val="dash"/>');
    expect(xml).toMatch(/<a:tailEnd type="triangle"/);
    expect(xml).toContain('<a:srcRect l="0" t="5000" r="0" b="5000"/>');
  });

  it('keeps groups as groups', async () => {
    const xml = await part('ppt/slides/slide3.xml');
    expect(xml).toMatch(/<p:grpSp><p:nvGrpSpPr><p:cNvPr id="\d+" name="Badge"\/>/);
    const group = xml.slice(xml.indexOf('<p:grpSp>'), xml.indexOf('</p:grpSp>'));
    expect(group.match(/<p:sp>/g)?.length).toBeGreaterThanOrEqual(2);
  });

  it('carries resolved text styles, bullets, levels, insets, links, and slide-number fields', async () => {
    const body = await part('ppt/slides/slide2.xml');
    expect(body).toContain('<a:buChar char="•"/>');
    expect(body).toContain('<a:buChar char="–"/>');
    expect(body).toContain('lvl="1"');
    expect(body).toContain('b="1"');
    expect(body).toContain('lIns="91440"');
    expect(body).toContain('tIns="45720"');
    // One <a:p> per deck paragraph; exactly one <a:pPr>, first.
    for (const [, inner] of body.matchAll(/<a:p>([\s\S]*?)<\/a:p>/g)) {
      expect(inner.match(/<a:pPr\b/g)?.length ?? 0).toBeLessThanOrEqual(1);
      if (inner.includes('<a:pPr')) expect(inner.startsWith('<a:pPr')).toBe(true);
    }
    expect(body).toMatch(/<a:fld id="\{[0-9A-F-]+\}" type="slidenum">/);
  });

  it('writes formatted speaker notes and sections', async () => {
    const notes = await Promise.all(names(/^ppt\/notesSlides\/notesSlide\d+\.xml$/).map(part));
    expect(notes.some((text) => text.includes('Stress that export never changes'))).toBe(true);
    expect(notes[0]).toContain('<p:ph type="body" idx="1"/>');
    const presentation = await part('ppt/presentation.xml');
    expect(presentation).toContain('<p14:section name="Introduction"');
    expect(presentation).toContain('<p14:section name="Objects"');
  });

  it('exports native tables and editable charts with their data', async () => {
    const table = await part('ppt/slides/slide4.xml');
    expect(table).toContain('<a:tbl>');
    expect(table).toContain('PowerPoint');
    expect(names(/^ppt\/charts\/chart\d+\.xml$/)).toHaveLength(1);
    const chart = await part('ppt/charts/chart1.xml');
    expect(chart).toContain('<c:barDir val="col"/>');
    expect(chart).toContain('<c:v>92</c:v>');
    expect(chart).toContain('<c:externalData r:id="rId1">');
    const workbook = await JSZip.loadAsync(
      await zip.file(names(/^ppt\/embeddings\/.+\.xlsx$/)[0])!.async('uint8array'),
    );
    expect(await workbook.file('xl/worksheets/sheet1.xml')!.async('string')).toContain('<v>92</v>');
  });

  it('reports only what it really approximates or omits', () => {
    const codes = result.report.entries.map((entry) => entry.code);
    expect(codes).toEqual(expect.arrayContaining(['vault-link', 'chart-layout']));
    for (const gone of [
      'masters-flattened',
      'group-flattened',
      'slide-number-static',
      'notes-plain',
    ])
      expect(codes).not.toContain(gone);
    expect(result.report.slides).toBe(5);
    expect(result.report.exported).toBeGreaterThan(15);
    expect(result.report.fonts).toEqual(['Inter']);
    expect(result.report.missingAssets).toEqual([]);
    expect(countBySeverity(result.report).missing).toBe(0);
  });

  it('writes SVG images with a picture fallback for viewers without SVG', async () => {
    const svgResult = await exportDeckToPptx(buildFixtureDeck(), {
      slideIds: ['slide-3'],
      assets: { [FIXTURE_IMAGE_PATH]: SVG },
      svgFallbacks: { [FIXTURE_IMAGE_PATH]: PNG },
    });
    const svgZip = await JSZip.loadAsync(svgResult.bytes);
    const media = Object.keys(svgZip.files).filter((name) => name.startsWith('ppt/media/'));
    expect(media.map((name) => name.split('.').pop()).sort()).toEqual(['png', 'svg']);
    const xml = await svgZip.file('ppt/slides/slide1.xml')!.async('string');
    expect(xml).toContain('<asvg:svgBlip');
  });

  it('exports the compatible transition subset and reports animation omissions', async () => {
    const deck = buildFixtureDeck();
    deck.slides['slide-1'].transition = { kind: 'wipe', durationMs: 900 };
    deck.slides['slide-1'].animations = [
      {
        id: 'animation-1',
        elementId: 's1-title',
        effect: 'fade',
        phase: 'entrance',
        trigger: 'click',
        durationMs: 500,
      },
    ];
    const animated = await exportDeckToPptx(deck, { slideIds: ['slide-1'] });
    const animatedZip = await JSZip.loadAsync(animated.bytes);
    const xml = await animatedZip.file('ppt/slides/slide1.xml')!.async('string');
    expect(xml).toContain('<p:transition spd="med" advClick="1"><p:wipe dir="r"/></p:transition>');
    expect(animated.report.entries.map((entry) => entry.code)).toEqual(
      expect.arrayContaining(['transition-duration', 'animation']),
    );
  });

  it('reports a missing image and writes a placeholder instead of failing', async () => {
    const missing = await exportDeckToPptx(buildFixtureDeck(), { slideIds: ['slide-3'] });
    expect(missing.report.missingAssets).toEqual([FIXTURE_IMAGE_PATH]);
    expect(countBySeverity(missing.report).missing).toBe(1);
    const missingZip = await JSZip.loadAsync(missing.bytes);
    expect(Object.keys(missingZip.files).some((name) => /^ppt\/media\/.+/.test(name))).toBe(false);
  });

  it('reports progress per slide and stops when cancelled', async () => {
    const seen: number[] = [];
    await exportDeckToPptx(buildFixtureDeck(), { onProgress: (done) => seen.push(done) });
    expect(seen).toEqual([1, 2, 3, 4, 5]);
    let calls = 0;
    await expect(
      exportDeckToPptx(buildFixtureDeck(), { isCancelled: () => calls++ > 1 }),
    ).rejects.toThrow(/cancelled/);
  });
});
