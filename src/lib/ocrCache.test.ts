import { webcrypto } from 'node:crypto';

import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import {
  clearOcrResultCache,
  readOcrCache,
  scopeOcrCache,
  setOcrCacheContext,
  writeOcrCache,
} from './ocrCache';

beforeEach(() => {
  vi.stubGlobal('crypto', webcrypto);
  setOcrCacheContext('vault-a');
});
afterEach(() => {
  setOcrCacheContext(null);
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it('isolates cached results and unfinished writes across vault/account changes', async () => {
  const scope = scopeOcrCache({ path: 'a.png' });
  const result = { text: 'private', confidence: 99, words: [] };
  await writeOcrCache(scope, result, 'ocr');
  expect((await readOcrCache(scope))?.text).toBe('private');
  setOcrCacheContext('vault-b');
  await writeOcrCache(scope, result, 'ocr');
  expect(await readOcrCache(scopeOcrCache({ path: 'a.png' }))).toBeNull();
  setOcrCacheContext('vault-a');
  expect(await readOcrCache(scopeOcrCache({ path: 'a.png' }))).toBeNull();
});

it('does not retain results while locked or allow an in-flight hash to repopulate after clearing', async () => {
  const scope = scopeOcrCache({ path: 'a' });
  const pending = writeOcrCache(scope, { text: 'secret', confidence: null }, 'ocr');
  await clearOcrResultCache();
  await pending;
  expect(await readOcrCache(scopeOcrCache({ path: 'a' }))).toBeNull();
  setOcrCacheContext(null);
  const locked = scopeOcrCache({ path: 'a' });
  await writeOcrCache(locked, { text: 'secret', confidence: null }, 'ocr');
  expect(await readOcrCache(locked)).toBeNull();
});

it('expires results and bounds retained entries without sharing mutable word boxes', async () => {
  vi.useFakeTimers();
  const first = scopeOcrCache({ page: 0 });
  await writeOcrCache(first, { text: 'zero', confidence: null }, 'pdf-text');
  const copy = await readOcrCache(first);
  copy!.text = 'mutated';
  expect((await readOcrCache(first))?.text).toBe('zero');
  for (let page = 1; page <= 64; page++) {
    await writeOcrCache(scopeOcrCache({ page }), { text: String(page), confidence: null }, 'ocr');
  }
  expect(await readOcrCache(first)).toBeNull();
  vi.advanceTimersByTime(30 * 60 * 1000);
  expect(await readOcrCache(scopeOcrCache({ page: 64 }))).toBeNull();
});

it('deletes the legacy plaintext database without opening or recreating it', async () => {
  const deleteDatabase = vi.fn(() => {
    const request = { onsuccess: null as (() => void) | null };
    queueMicrotask(() => request.onsuccess?.());
    return request;
  });
  const open = vi.fn();
  vi.stubGlobal('indexedDB', { deleteDatabase, open });
  await clearOcrResultCache();
  expect(deleteDatabase).toHaveBeenCalledWith('collab-ocr-results');
  expect(open).not.toHaveBeenCalled();
});
