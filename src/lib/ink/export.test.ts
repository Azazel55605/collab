import { describe, expect, it } from 'vitest';

import { createInkDocument } from './document';
import {
  encodeInkExportMetadata,
  extractInkExportSource,
  makeInkExportSource,
  planInkExportPages,
  stableInkEmbedPath,
} from './export';
import { buildInkPdf } from './exportPdf';
import { renderInkExport } from './exportRuntime';

function documentWithTwoPages() {
  const document = createInkDocument({ name: 'Export', timestamp: '2026-01-01T00:00:00.000Z' });
  const first = document.pages[document.pageOrder[0]];
  const second = { ...first, id: 'page-2', name: 'Page 2' };
  return {
    ...document,
    pages: { ...document.pages, [second.id]: second },
    pageOrder: [...document.pageOrder, second.id],
  };
}

describe('ink export planning', () => {
  it('plans a requested region and all PDF pages without changing document data', () => {
    const document = documentWithTwoPages();
    const pageId = document.pageOrder[0];
    const region = { minX: 100, minY: 200, maxX: 900, maxY: 1_200 };
    const regionPlans = planInkExportPages(document, {
      format: 'png',
      scope: 'region',
      pageId,
      region,
      crop: 'page',
      scale: 2,
      padding: 10,
      transparent: true,
      includePageBackground: false,
      palette: 'light',
    });
    expect(regionPlans).toHaveLength(1);
    expect(regionPlans[0].bounds).toEqual({ minX: 90, minY: 190, maxX: 910, maxY: 1_210 });

    const documentPlans = planInkExportPages(document, {
      format: 'pdf',
      scope: 'document',
      pageId,
      crop: 'page',
      scale: 1,
      padding: 0,
      transparent: false,
      includePageBackground: true,
      palette: 'page',
    });
    expect(documentPlans.map((plan) => plan.page.id)).toEqual(document.pageOrder);
  });

  it('uses stable collision-resistant paths for note assets', () => {
    const document = documentWithTwoPages();
    const page = document.pages[document.pageOrder[0]];
    const first = stableInkEmbedPath('Projects/A/Sketch.ink', page);
    expect(stableInkEmbedPath('Projects/A/Sketch.ink', page)).toBe(first);
    expect(stableInkEmbedPath('Projects/B/Sketch.ink', page)).not.toBe(first);
    expect(first).toMatch(/^Pictures\/Sketch-[a-f0-9]+-/);
  });
});

describe('ink export output', () => {
  it('round-trips source metadata from a standalone SVG data URL', () => {
    const source = makeInkExportSource('Sketches/Ideas.ink', 'page-1', {
      minX: 10,
      minY: 20,
      maxX: 300,
      maxY: 400,
    });
    const svg = `<svg xmlns="http://www.w3.org/2000/svg"><metadata id="collab-ink-export">${encodeInkExportMetadata(source)}</metadata></svg>`;
    const dataUrl = `data:image/svg+xml;base64,${btoa(svg)}`;
    expect(extractInkExportSource(dataUrl)).toEqual(source);
  });

  it('rejects source metadata that escapes the vault or is not an ink document', () => {
    const source = makeInkExportSource('../Secrets.txt', 'page-1', {
      minX: 0,
      minY: 0,
      maxX: 100,
      maxY: 100,
    });
    const svg = `<svg xmlns="http://www.w3.org/2000/svg"><metadata id="collab-ink-export">${encodeInkExportMetadata(source)}</metadata></svg>`;
    expect(extractInkExportSource(`data:image/svg+xml;base64,${btoa(svg)}`)).toBeNull();
  });

  it('renders deterministic light and dark standalone SVG exports', async () => {
    const document = documentWithTwoPages();
    const pageId = document.pageOrder[0];
    const base = {
      document,
      relativePath: 'Sketches/Ideas.ink',
      assets: {},
      report: {
        missingAssets: ['Pictures/missing.png'],
        missingFonts: ['Missing Sans'],
        warnings: [],
      },
    };
    const options = {
      format: 'svg' as const,
      scope: 'page' as const,
      pageId,
      crop: 'page' as const,
      scale: 1,
      padding: 0,
      transparent: false,
      includePageBackground: false,
      palette: 'light' as const,
    };
    const light = await renderInkExport({ ...base, options });
    const repeated = await renderInkExport({ ...base, options });
    const dark = await renderInkExport({ ...base, options: { ...options, palette: 'dark' } });

    expect(light.contentBase64).toBe(repeated.contentBase64);
    expect(atob(light.contentBase64)).toContain('fill="#ffffff"');
    expect(atob(dark.contentBase64)).toContain('fill="#111827"');
    expect(light.report.missingAssets).toEqual(['Pictures/missing.png']);
    expect(light.report.missingFonts).toEqual(['Missing Sans']);
  });

  it('builds a deterministic multi-page PDF container', () => {
    const page = {
      jpeg: new Uint8Array([0xff, 0xd8, 0xff, 0xd9]),
      pixelWidth: 1,
      pixelHeight: 1,
      pointWidth: 612,
      pointHeight: 792,
    };
    const first = buildInkPdf([page, page]);
    expect(new TextDecoder().decode(first.subarray(0, 8))).toContain('%PDF-1.4');
    expect(buildInkPdf([page, page])).toEqual(first);
    expect(new TextDecoder().decode(first)).toContain('/Count 2');
  });
});
