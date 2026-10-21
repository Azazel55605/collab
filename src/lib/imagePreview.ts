import { bytesDataUrl } from './assetBytes';
import { mediaGeneration, registerMediaCleanup } from './mediaLifecycle';
import { previewIdentity } from './previewIdentity';
import { type PreviewPriority, previewScheduler } from './previewScheduler';
import type { VaultClient } from './vaultClient';

const cache = new Map<string, { url: string; bytes: number }>();
let cachedBytes = 0;
registerMediaCleanup(() => {
  cache.clear();
  cachedBytes = 0;
});
export function getImagePreviewDataUrl(
  client: VaultClient,
  path: string,
  options: { signal?: AbortSignal; priority?: PreviewPriority } = {},
) {
  const key = previewIdentity(client, path, 'image:640x480:v1');
  const hit = cache.get(key);
  if (hit) {
    cache.delete(key);
    cache.set(key, hit);
    return Promise.resolve(hit.url);
  }
  const generation = mediaGeneration();
  return previewScheduler.run(
    key,
    async (signal) => {
      if (!client.readAssetBytes) return client.readAssetDataUrl(path);
      const bytes = await client.readAssetBytes(path, signal, true);
      const svg = /\.svg$/i.test(path);
      const url = await bytesDataUrl(bytes, svg ? 'image/svg+xml' : 'image/png');
      if (!signal.aborted && generation === mediaGeneration()) {
        const cost = url.length * 2 + 640 * 480 * 4;
        while (cache.size && (cache.size >= 32 || cachedBytes + cost > 16 * 1024 * 1024)) {
          const first = cache.keys().next().value!;
          cachedBytes -= cache.get(first)!.bytes;
          cache.delete(first);
        }
        if (cost <= 16 * 1024 * 1024) {
          cache.set(key, { url, bytes: cost });
          cachedBytes += cost;
        }
      }
      return url;
    },
    options,
  );
}
