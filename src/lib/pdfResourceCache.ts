import { getDocument, type PDFDocumentProxy } from 'pdfjs-dist';

interface Resource {
  promise: Promise<PDFDocumentProxy>;
  destroy(): Promise<void>;
}
interface Entry {
  resource: Resource;
  refs: number;
  bytes: number;
  ready: boolean;
}
/** Two idle workers, bounded by source bytes; mounted consumers are never evicted. */
export class PdfResourceCache {
  private entries = new Map<string, Entry>();
  constructor(
    private readonly maxEntries = 2,
    private readonly maxBytes = 64 * 1024 * 1024,
  ) {}
  acquire(key: string, bytes: number, create: () => Resource) {
    let entry = this.entries.get(key);
    if (!entry) {
      entry = { resource: create(), refs: 0, bytes, ready: false };
      this.entries.set(key, entry);
      const created = entry;
      void created.resource.promise.then(
        () => {
          created.ready = true;
        },
        () => {
          if (this.entries.get(key) === created) this.remove(key);
        },
      );
    }
    this.entries.delete(key);
    this.entries.set(key, entry);
    entry.refs++;
    this.trim();
    let released = false;
    return {
      promise: entry.resource.promise,
      release: () => {
        if (released) return;
        released = true;
        entry.refs--;
        if (!entry.ready && entry.refs === 0 && this.entries.get(key) === entry) this.remove(key);
        this.trim();
      },
    };
  }
  private remove(key: string) {
    const entry = this.entries.get(key);
    this.entries.delete(key);
    if (entry) void entry.resource.destroy().catch(() => {});
  }
  private trim() {
    let bytes = [...this.entries.values()].reduce((sum, entry) => sum + entry.bytes, 0);
    for (const [key, entry] of this.entries) {
      if (this.entries.size <= this.maxEntries && bytes <= this.maxBytes) break;
      if (entry.refs) continue;
      bytes -= entry.bytes;
      this.remove(key);
    }
  }
}
const cache = new PdfResourceCache();
export async function acquirePdfDocument(scope: string, data: Uint8Array) {
  // Hash before pdf.js transfers/detaches the input buffer to its worker.
  const digest = await crypto.subtle.digest('SHA-256', data as Uint8Array<ArrayBuffer>);
  const hash = Array.from(new Uint8Array(digest), (value) =>
    value.toString(16).padStart(2, '0'),
  ).join('');
  return cache.acquire(`${scope}:${hash}`, data.byteLength, () => getDocument({ data }));
}
