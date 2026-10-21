import type { PDFDocumentProxy } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { expect, it, vi } from 'vitest';

import { PdfResourceCache } from './pdfResourceCache';

function resource() {
  return { promise: Promise.resolve({} as PDFDocumentProxy), destroy: vi.fn(async () => {}) };
}
it('reuses an unchanged worker on switching back and evicts older idle documents', async () => {
  const cache = new PdfResourceCache(2, 100);
  const a = resource(),
    b = resource(),
    c = resource();
  const first = cache.acquire('a:hash1', 10, () => a);
  await first.promise;
  first.release();
  const second = cache.acquire('b:hash', 10, () => b);
  await second.promise;
  second.release();
  const create = vi.fn(() => resource());
  const back = cache.acquire('a:hash1', 10, create);
  expect(create).not.toHaveBeenCalled();
  back.release();
  const third = cache.acquire('c:hash', 10, () => c);
  expect(b.destroy).toHaveBeenCalledOnce();
  expect(a.destroy).not.toHaveBeenCalled();
  await third.promise;
  third.release();
});
it('releases oversized documents and cancels abandoned pending workers', async () => {
  const cache = new PdfResourceCache(2, 10);
  const big = resource();
  const lease = cache.acquire('big', 20, () => big);
  await lease.promise;
  lease.release();
  lease.release();
  expect(big.destroy).toHaveBeenCalledOnce();
  const pending = {
    promise: new Promise<PDFDocumentProxy>(() => {}),
    destroy: vi.fn(async () => {}),
  };
  cache.acquire('pending', 1, () => pending).release();
  expect(pending.destroy).toHaveBeenCalledOnce();
});
it('does not evict a worker still used by another mounted consumer', async () => {
  const cache = new PdfResourceCache(1, 10);
  const a = resource(),
    b = resource();
  const one = cache.acquire('same', 5, () => a);
  const two = cache.acquire('same', 5, () => a);
  await one.promise;
  one.release();
  const other = cache.acquire('other', 5, () => b);
  await other.promise;
  other.release();
  expect(a.destroy).not.toHaveBeenCalled();
  two.release();
});

it('retires idle workers and destroys active resources immediately on privacy cleanup', async () => {
  vi.useFakeTimers();
  try {
    const cache = new PdfResourceCache();
    const idle = resource();
    const active = resource();
    const first = cache.acquire('idle', 1, () => idle);
    await first.promise;
    first.release();
    await vi.advanceTimersByTimeAsync(30000);
    expect(idle.destroy).toHaveBeenCalledOnce();
    const second = cache.acquire('active', 1, () => active);
    await second.promise;
    cache.clear();
    expect(active.destroy).toHaveBeenCalledOnce();
    second.release();
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    vi.useRealTimers();
  }
});
