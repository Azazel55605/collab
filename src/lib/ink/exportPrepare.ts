import type { InkDocument } from '../../types/ink';
import type { VaultClient } from '../vaultClient';

import type { InkExportAsset, InkExportOptions, InkExportReport } from './export';
import { collectInkExportDependencies, planInkExportPages } from './export';
import type { InkExportRuntimeRequest } from './exportRuntime';

async function imageDimensions(dataUrl: string): Promise<{ width: number; height: number }> {
  const image = new Image();
  await new Promise<void>((resolve, reject) => {
    image.onload = () => resolve();
    image.onerror = () => reject(new Error('The image could not be decoded.'));
    image.src = dataUrl;
  });
  return {
    width: Math.max(1, image.naturalWidth || image.width),
    height: Math.max(1, image.naturalHeight || image.height),
  };
}

function fontAvailable(fontFamily: string): boolean {
  if (typeof document === 'undefined' || !document.fonts?.check) return true;
  const escaped = fontFamily.replace(/["\\]/g, '\\$&');
  return document.fonts.check(`16px "${escaped}"`);
}

export async function prepareInkExportRequest(
  client: VaultClient,
  document: InkDocument,
  relativePath: string,
  options: InkExportOptions,
): Promise<InkExportRuntimeRequest> {
  const pageIds = planInkExportPages(document, options).map((plan) => plan.page.id);
  const dependencies = collectInkExportDependencies(document, pageIds);
  const assets: Record<string, InkExportAsset> = {};
  const report: InkExportReport = {
    missingAssets: [],
    missingFonts: dependencies.fontFamilies.filter((font) => !fontAvailable(font)),
    warnings: [],
  };

  let cursor = 0;
  let bytes = 0;
  const load = async () => {
    while (cursor < dependencies.assetPaths.length) {
      const assetPath = dependencies.assetPaths[cursor++];
      let dataUrl: string;
      try {
        dataUrl = await client.readAssetDataUrl(assetPath);
      } catch {
        report.missingAssets.push(assetPath);
        continue;
      }
      bytes += dataUrl.length * 2;
      if (bytes > 128 * 1024 * 1024)
        throw new Error('Drawing export assets exceed the 128 MiB preparation budget');
      try {
        if (!/^data:image\//i.test(dataUrl)) throw new Error('Asset is not an image');
        const size = await imageDimensions(dataUrl);
        if (size.width * size.height > 48_000_000)
          throw new Error('Image exceeds export decode limit');
        assets[assetPath] = { dataUrl, ...size };
      } catch {
        report.missingAssets.push(assetPath);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(2, dependencies.assetPaths.length) }, load));

  report.missingAssets.sort();
  if (options.format === 'pdf' && options.transparent) {
    report.warnings.push('PDF pages are opaque; the selected export background was used.');
  }
  const snapshot = {
    ...document,
    pageOrder: pageIds,
    pages: Object.fromEntries(pageIds.map((id) => [id, document.pages[id]])),
  };
  return { document: snapshot, relativePath, options, assets, report };
}
