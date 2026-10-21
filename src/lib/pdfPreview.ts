import { dataUrlBytes, readAssetBytes } from './assetBytes';
import { mediaGeneration, registerMediaCleanup } from './mediaLifecycle';
import { previewIdentity } from './previewIdentity';
import { type PreviewPriority, previewScheduler } from './previewScheduler';
import { tauriCommands } from './tauri';
import { LocalVaultClient, type VaultClient } from './vaultClient';

const outputs = new Map<string, { url: string; bytes: number }>();
let outputBytes = 0;
const OUTPUT_BUDGET = 16 * 1024 * 1024;
function clearOutputs() {
  outputs.clear();
  outputBytes = 0;
}
registerMediaCleanup(clearOutputs);
async function digest(bytes: Uint8Array) {
  const hash = await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>);
  return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, '0')).join('');
}
export async function renderPdfPreviewFromBytes(
  bytes: Uint8Array,
  signal?: AbortSignal,
  scope = '',
  hash?: string,
): Promise<string> {
  if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
  const epoch = mediaGeneration();
  const key = `${scope}:${hash ?? (await digest(bytes))}`;
  const cached = outputs.get(key);
  if (cached) {
    outputs.delete(key);
    outputs.set(key, cached);
    return cached.url;
  }
  const { getDocument } = await import('./pdfRuntime');
  if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
  const task = getDocument({ data: bytes });
  let render: { cancel?(): void } | undefined;
  let canvas: HTMLCanvasElement | undefined;
  let destroyed = false;
  const destroy = async () => {
    if (!destroyed) {
      destroyed = true;
      await task.destroy();
    }
  };
  const cancel = () => {
    render?.cancel?.();
    void destroy().catch(() => {});
  };
  signal?.addEventListener('abort', cancel, { once: true });
  try {
    const pdf = await task.promise;
    const page = await pdf.getPage(1);
    if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
    const base = page.getViewport({ scale: 1 });
    const viewport = page.getViewport({
      scale: Math.min(1.4, 260 / Math.max(1, base.width), 320 / Math.max(1, base.height)),
    });
    canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.ceil(viewport.width));
    canvas.height = Math.max(1, Math.ceil(viewport.height));
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Failed to get PDF preview canvas context');
    const rendering = page.render({ canvas, canvasContext: context, viewport });
    render = rendering;
    await rendering.promise;
    if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
    const url = canvas.toDataURL('image/png');
    const size = url.length * 2 + canvas.width * canvas.height * 4;
    if (epoch === mediaGeneration() && size <= OUTPUT_BUDGET) {
      while (outputs.size >= 32 || outputBytes + size > OUTPUT_BUDGET) {
        const first = outputs.keys().next().value!;
        outputBytes -= outputs.get(first)!.bytes;
        outputs.delete(first);
      }
      outputs.set(key, { url, bytes: size });
      outputBytes += size;
    }
    return url;
  } finally {
    signal?.removeEventListener('abort', cancel);
    if (canvas) {
      canvas.width = 0;
      canvas.height = 0;
    }
    await destroy();
  }
}
/** Compatibility entry point; normal vault consumers use binary transport. */
export function renderPdfPreviewFromDataUrl(dataUrl: string) {
  return renderPdfPreviewFromBytes(dataUrlBytes(dataUrl));
}
type PdfPreviewLoaderDeps = {
  readCachedDocumentPreviewDataUrl: typeof tauriCommands.readCachedDocumentPreviewDataUrl;
  writeCachedDocumentPreviewDataUrl: typeof tauriCommands.writeCachedDocumentPreviewDataUrl;
  renderPdfPreviewFromDataUrl: typeof renderPdfPreviewFromDataUrl;
  renderPdfPreviewFromBytes?: typeof renderPdfPreviewFromBytes;
};
export async function loadPdfPreviewDataUrl(
  client: VaultClient,
  path: string,
  deps: PdfPreviewLoaderDeps = {
    readCachedDocumentPreviewDataUrl: tauriCommands.readCachedDocumentPreviewDataUrl,
    writeCachedDocumentPreviewDataUrl: tauriCommands.writeCachedDocumentPreviewDataUrl,
    renderPdfPreviewFromDataUrl,
    renderPdfPreviewFromBytes,
  },
  signal?: AbortSignal,
) {
  const local = client instanceof LocalVaultClient ? client.vault.path : null;
  if (local) {
    const cached = await deps.readCachedDocumentPreviewDataUrl(local, path);
    if (cached) return cached;
  }
  if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
  let preview: string;
  let hash: string | undefined;
  if (deps.renderPdfPreviewFromBytes) {
    const bytes = await readAssetBytes(client, path, signal);
    hash = await digest(bytes);
    preview = await deps.renderPdfPreviewFromBytes(
      bytes,
      signal,
      previewIdentity(client, path, 'pdf'),
      hash,
    );
  } else {
    const source = await client.readAssetDataUrl(path);
    hash = local ? await digest(dataUrlBytes(source)) : undefined;
    preview = await deps.renderPdfPreviewFromDataUrl(source);
  }
  if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
  if (local)
    await deps.writeCachedDocumentPreviewDataUrl(local, path, preview, hash).catch(() => {});
  return preview;
}
export function getPdfPreviewDataUrl(
  client: VaultClient,
  path: string,
  options: { signal?: AbortSignal; priority?: PreviewPriority } = {},
) {
  return previewScheduler.run(
    previewIdentity(client, path, 'pdf:260x320:v3'),
    (signal) => loadPdfPreviewDataUrl(client, path, undefined, signal),
    options,
  );
}
