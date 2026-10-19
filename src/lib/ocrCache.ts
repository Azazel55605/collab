import type { OcrResult } from './ocr';

const OCR_RESULT_CACHE_DB = 'collab-ocr-results';
// Scope format includes word boxes, dimensions and the current memory session.
const OCR_RESULT_CACHE_VERSION = 2;

export type OcrCacheScope = Record<string, string | number | boolean | null | undefined>;

export interface CachedOcrResult extends OcrResult {
  cachedAt: string;
  resultMode: 'ocr' | 'pdf-text';
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object)
    .filter((key) => typeof object[key] !== 'undefined')
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(object[key])}`)
    .join(',')}}`;
}

function bytesToHex(bytes: ArrayBuffer): string {
  return Array.from(new Uint8Array(bytes))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

export async function hashOcrCacheString(input: string): Promise<string> {
  const bytes = new TextEncoder().encode(input);
  return bytesToHex(await crypto.subtle.digest('SHA-256', bytes));
}

export async function buildOcrCacheKey(scope: OcrCacheScope): Promise<string> {
  return `ocr-result:${await hashOcrCacheString(stableStringify({ version: OCR_RESULT_CACHE_VERSION, ...scope }))}`;
}

// Recognized document text is disposable and must not outlive its authorized
// vault/account context. Never persist it in the webview profile.
const MAX_ENTRIES = 64;
const MAX_BYTES = 8 * 1024 * 1024;
const MAX_AGE_MS = 30 * 60 * 1000;
let epoch = 0;
let context: string | null = null;
let cacheBytes = 0;
let expiryTimer: ReturnType<typeof setTimeout> | undefined;
const results = new Map<string, { value: CachedOcrResult; bytes: number }>();
let legacyDeletion: Promise<void> | undefined;

export function scopeOcrCache(scope: OcrCacheScope): OcrCacheScope {
  return { ...scope, cacheSession: scope.cacheSession ?? epoch };
}

function resetResults() {
  epoch++;
  clearTimeout(expiryTimer);
  expiryTimer = undefined;
  results.clear();
  cacheBytes = 0;
}

export function setOcrCacheContext(nextContext: string | null) {
  if (nextContext !== context) {
    context = nextContext;
    resetResults();
  }
  void removeLegacyOcrCache().catch(() => undefined);
}

// Delete the old plaintext database, including when upgrading without doing OCR.
// Blocked/failed deletion is retried on the next lifecycle/cache operation.
function removeLegacyOcrCache(): Promise<void> {
  if (typeof indexedDB === 'undefined') return Promise.resolve();
  if (legacyDeletion) return legacyDeletion;
  legacyDeletion = new Promise<void>((resolve, reject) => {
    const request = indexedDB.deleteDatabase(OCR_RESULT_CACHE_DB);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error ?? new Error('Could not remove legacy OCR cache'));
    request.onblocked = () =>
      reject(new Error('Close other Collab windows to remove the old OCR cache'));
  }).catch((error) => {
    legacyDeletion = undefined;
    throw error;
  });
  return legacyDeletion;
}

function removeEntry(key: string) {
  const entry = results.get(key);
  if (entry) cacheBytes -= entry.bytes;
  results.delete(key);
}

function scheduleExpiry() {
  clearTimeout(expiryTimer);
  expiryTimer = undefined;
  if (!results.size) return;
  const expiresAt = Math.min(
    ...Array.from(results.values(), ({ value }) => Date.parse(value.cachedAt) + MAX_AGE_MS),
  );
  expiryTimer = setTimeout(
    () => {
      for (const [key, { value }] of results) {
        if (Date.now() - Date.parse(value.cachedAt) >= MAX_AGE_MS) removeEntry(key);
      }
      scheduleExpiry();
    },
    Math.max(1, expiresAt - Date.now()),
  );
}

export async function readOcrCache(scope: OcrCacheScope): Promise<CachedOcrResult | null> {
  void removeLegacyOcrCache().catch(() => undefined);
  const started = epoch;
  if (context === null || scope.cacheSession !== started) return null;
  const key = await buildOcrCacheKey(scope);
  if (started !== epoch) return null;
  const entry = results.get(key);
  if (!entry) return null;
  if (Date.now() - Date.parse(entry.value.cachedAt) >= MAX_AGE_MS) {
    removeEntry(key);
    return null;
  }
  results.delete(key);
  results.set(key, entry);
  return structuredClone(entry.value);
}

export async function writeOcrCache(
  scope: OcrCacheScope,
  result: OcrResult,
  resultMode: CachedOcrResult['resultMode'],
): Promise<void> {
  const started = epoch;
  if (context === null || scope.cacheSession !== started) return;
  const key = await buildOcrCacheKey(scope);
  if (started !== epoch) return;
  const value = structuredClone({ ...result, resultMode, cachedAt: new Date().toISOString() });
  const bytes = new TextEncoder().encode(JSON.stringify(value)).byteLength;
  removeEntry(key);
  if (bytes > MAX_BYTES) return;
  results.set(key, { value, bytes });
  cacheBytes += bytes;
  while (results.size > MAX_ENTRIES || cacheBytes > MAX_BYTES) {
    removeEntry(results.keys().next().value!);
  }
  scheduleExpiry();
}

export async function clearOcrResultCache(): Promise<void> {
  resetResults();
  await removeLegacyOcrCache();
}
