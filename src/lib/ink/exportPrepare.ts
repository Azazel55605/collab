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

  await Promise.all(
    dependencies.assetPaths.map(async (assetPath) => {
      try {
        const dataUrl = await client.readAssetDataUrl(assetPath);
        if (!/^data:image\//i.test(dataUrl)) throw new Error('Asset is not an image.');
        assets[assetPath] = { dataUrl, ...(await imageDimensions(dataUrl)) };
      } catch {
        report.missingAssets.push(assetPath);
      }
    }),
  );

  report.missingAssets.sort();
  if (options.format === 'pdf' && options.transparent) {
    report.warnings.push('PDF pages are opaque; the selected export background was used.');
  }
  return { document, relativePath, options, assets, report };
}
