import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  enforceBundleBudgets,
  initialBundleFiles,
  OCR_ASSETS,
  reportDesktopBundle,
  verifyOcrAssets,
} from './report-desktop-bundle.mjs';

describe('desktop bundle report', () => {
  it('fails measurable regressions, missing lazy entries and absent offline resources', () => {
    const manifest = {
      'node_modules/highlight.js/es/index.js': { isDynamicEntry: true },
      'src/views/PdfView.tsx': { isDynamicEntry: true },
    };
    const policy = {
      maximums: { initialJsBytes: 100 },
      deferredEntries: ['src/views/PdfView.tsx'],
    };
    const report = { initialJsBytes: 100, ocrIntegrityValid: true };
    expect(() => enforceBundleBudgets(report, manifest, new Set(), policy)).not.toThrow();
    expect(() =>
      enforceBundleBudgets({ ...report, initialJsBytes: 101 }, manifest, new Set(), policy),
    ).toThrow('Bundle budget exceeded');
    expect(() =>
      enforceBundleBudgets(report, manifest, new Set(['src/views/PdfView.tsx']), policy),
    ).toThrow('missing or eager');
    expect(() => enforceBundleBudgets(report, {}, new Set(), policy)).toThrow('missing or eager');
    expect(() =>
      enforceBundleBudgets({ ...report, ocrIntegrityValid: false }, manifest, new Set(), policy),
    ).toThrow('offline English OCR');
  });

  it('requires the complete offline OCR asset set with matching byte counts and hashes', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'collab-ocr-integrity-'));
    try {
      await mkdir(path.join(root, 'ocr-assets'));
      const assets = [];
      for (const file of OCR_ASSETS) {
        const content = Buffer.from(file);
        await writeFile(path.join(root, 'ocr-assets', file), content);
        assets.push({
          file,
          bytes: content.length,
          sha256: createHash('sha256').update(content).digest('hex'),
        });
      }
      await writeFile(
        path.join(root, 'ocr-assets/manifest.json'),
        JSON.stringify({ version: 1, assets }),
      );
      expect(await verifyOcrAssets(root)).toBe(true);
      await writeFile(path.join(root, 'ocr-assets/eng.traineddata.gz'), 'corrupt');
      expect(await verifyOcrAssets(root)).toBe(false);
      await rm(path.join(root, 'ocr-assets/eng.traineddata.gz'));
      expect(await verifyOcrAssets(root)).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it('follows static imports once through cycles and excludes dynamic imports', () => {
    const result = initialBundleFiles({
      app: { file: 'app.js', isEntry: true, imports: ['shared'], dynamicImports: ['view'] },
      shared: { file: 'shared.js', imports: ['app'] },
      view: { file: 'view.js', isDynamicEntry: true },
    });
    expect(result.files).toEqual(['app.js', 'shared.js']);
    expect(() => initialBundleFiles({})).toThrow('No application entry');
  });

  it('reports actual asset bytes and rejects eager regressions or duplicate workers', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'collab-bundle-report-'));
    try {
      await mkdir(path.join(directory, '.vite'));
      await mkdir(path.join(directory, 'assets'));
      await writeFile(path.join(directory, 'assets/app.js'), 'app');
      await writeFile(path.join(directory, 'assets/pdf.worker-legacy.mjs'), 'worker');
      const manifest = {
        app: { file: 'assets/app.js', isEntry: true, imports: [] as string[] },
        'src/views/PdfView.tsx': { file: 'assets/view.js', isDynamicEntry: true },
        'src/lib/pdfRuntime.ts': { file: 'assets/pdf.js', isDynamicEntry: true },
      };
      const save = () =>
        writeFile(path.join(directory, '.vite/manifest.json'), JSON.stringify(manifest));
      await save();
      expect(await reportDesktopBundle(directory, true)).toMatchObject({
        initialJsBytes: 3,
        pdfWorkerBytes: 6,
        pdfWorkerFiles: 1,
      });
      await writeFile(path.join(directory, 'assets/pdf.worker-normal.mjs'), 'duplicate');
      await expect(reportDesktopBundle(directory, true)).rejects.toThrow('Expected one PDF worker');
      manifest.app.imports = ['src/views/PdfView.tsx'];
      await save();
      // The assertion runs before reading deferred assets; make the eager view available.
      await writeFile(path.join(directory, 'assets/view.js'), 'eager');
      await expect(reportDesktopBundle(directory, true)).rejects.toThrow('Startup eagerly loads');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
