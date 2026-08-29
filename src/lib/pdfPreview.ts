import { getDocument, GlobalWorkerOptions } from 'pdfjs-dist';

import { tauriCommands } from './tauri';
import { LocalVaultClient, type VaultClient } from './vaultClient';

const workerUrl = new URL('pdfjs-dist/build/pdf.worker.mjs', import.meta.url).toString();
GlobalWorkerOptions.workerSrc = workerUrl;

const previewCache = new Map<string, Promise<string>>();
const inFlightVaultPreviewLoads = new Map<string, Promise<string>>();

export async function renderPdfPreviewFromDataUrl(dataUrl: string) {
  const key = dataUrl;
  const cached = previewCache.get(key);
  if (cached) return cached;

  const promise = (async () => {
    const [, encoded = ''] = dataUrl.split(',', 2);
    const binary = atob(encoded);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }

    const pdfDocument = await getDocument({ data: bytes }).promise;
    const page = await pdfDocument.getPage(1);
    const baseViewport = page.getViewport({ scale: 1 });
    const scale = Math.min(1.4, 260 / Math.max(1, baseViewport.width));
    const viewport = page.getViewport({ scale });
    const canvas = window.document.createElement('canvas');
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Failed to get PDF preview canvas context');

    canvas.width = Math.max(1, Math.ceil(viewport.width));
    canvas.height = Math.max(1, Math.ceil(viewport.height));
    await page.render({
      canvas,
      canvasContext: context,
      viewport,
    }).promise;

    return canvas.toDataURL('image/png');
  })();

  previewCache.set(key, promise);
  return promise;
}

type PdfPreviewLoaderDeps = {
  readCachedDocumentPreviewDataUrl: typeof tauriCommands.readCachedDocumentPreviewDataUrl;
  writeCachedDocumentPreviewDataUrl: typeof tauriCommands.writeCachedDocumentPreviewDataUrl;
  renderPdfPreviewFromDataUrl: typeof renderPdfPreviewFromDataUrl;
};

export async function loadPdfPreviewDataUrl(
  client: VaultClient,
  relativePath: string,
  deps: PdfPreviewLoaderDeps = {
    readCachedDocumentPreviewDataUrl: tauriCommands.readCachedDocumentPreviewDataUrl,
    writeCachedDocumentPreviewDataUrl: tauriCommands.writeCachedDocumentPreviewDataUrl,
    renderPdfPreviewFromDataUrl,
  },
) {
  // The persistent document-preview cache is a native-filesystem feature;
  // hosted vaults render previews on demand from the authenticated asset.
  const cacheVaultPath = client instanceof LocalVaultClient ? client.vault.path : null;
  if (cacheVaultPath) {
    const cached = await deps.readCachedDocumentPreviewDataUrl(cacheVaultPath, relativePath);
    if (cached) return cached;
  }

  const sourceDataUrl = await client.readAssetDataUrl(relativePath);
  const renderedPreview = await deps.renderPdfPreviewFromDataUrl(sourceDataUrl);
  if (cacheVaultPath) {
    void deps
      .writeCachedDocumentPreviewDataUrl(cacheVaultPath, relativePath, renderedPreview)
      .catch(() => {});
  }
  return renderedPreview;
}

export async function getPdfPreviewDataUrl(client: VaultClient, relativePath: string) {
  const key = `${client.id}::${relativePath}`;
  const existing = inFlightVaultPreviewLoads.get(key);
  if (existing) return existing;

  const promise = loadPdfPreviewDataUrl(client, relativePath).finally(() => {
    inFlightVaultPreviewLoads.delete(key);
  });

  inFlightVaultPreviewLoads.set(key, promise);
  return promise;
}
