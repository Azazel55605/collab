import { getDocument, GlobalWorkerOptions } from 'pdfjs-dist';

const workerUrl = new URL('pdfjs-dist/build/pdf.worker.mjs', import.meta.url).toString();
GlobalWorkerOptions.workerSrc = workerUrl;

const previewCache = new Map<string, Promise<string>>();

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
