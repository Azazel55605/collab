import { registerMediaCleanup } from './mediaLifecycle';

interface Preview {
  hash: string;
  renderer: number;
  dataUrl: string;
}
const entries = new Map<string, Preview>();
let bytes = 0;
const MAX_BYTES = 16 * 1024 * 1024;
export function cachedRevisionPreview(key: string, hash: string): string | null {
  const entry = entries.get(key);
  if (!entry || entry.hash !== hash || entry.renderer !== 2) return null;
  entries.delete(key);
  entries.set(key, entry);
  return entry.dataUrl;
}
export function rememberRevisionPreview(key: string, preview: Preview): void {
  const previous = entries.get(key);
  if (previous) bytes -= previous.dataUrl.length * 2;
  entries.delete(key);
  if (preview.dataUrl.length * 2 > MAX_BYTES) return;
  entries.set(key, preview);
  bytes += preview.dataUrl.length * 2;
  while (entries.size > 64 || bytes > MAX_BYTES) {
    const oldest = entries.keys().next().value!;
    bytes -= entries.get(oldest)!.dataUrl.length * 2;
    entries.delete(oldest);
  }
}

registerMediaCleanup(() => {
  entries.clear();
  bytes = 0;
});
