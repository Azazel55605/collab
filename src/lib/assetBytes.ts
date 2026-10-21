import type { VaultClient } from './vaultClient';

export function dataUrlBytes(dataUrl: string) {
  const raw = atob(dataUrl.slice(dataUrl.indexOf(',') + 1));
  return Uint8Array.from(raw, (char) => char.charCodeAt(0));
}
/** The concrete local/hosted adapters always use binary IPC; legacy injected adapters can migrate independently. */
export async function readAssetBytes(client: VaultClient, path: string, signal?: AbortSignal) {
  if (client.readAssetBytes) return client.readAssetBytes(path, signal);
  const bytes = dataUrlBytes(await client.readAssetDataUrl(path));
  if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
  return bytes;
}
export function bytesDataUrl(bytes: Uint8Array, mime: string) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(new Blob([bytes as Uint8Array<ArrayBuffer>], { type: mime }));
  });
}
export function assetMime(path: string) {
  const extension = path.split('.').pop()?.toLowerCase();
  return (
    (
      {
        png: 'image/png',
        jpg: 'image/jpeg',
        jpeg: 'image/jpeg',
        webp: 'image/webp',
        gif: 'image/gif',
        svg: 'image/svg+xml',
        avif: 'image/avif',
        bmp: 'image/bmp',
        ico: 'image/x-icon',
      } as Record<string, string>
    )[extension ?? ''] ?? 'application/octet-stream'
  );
}
