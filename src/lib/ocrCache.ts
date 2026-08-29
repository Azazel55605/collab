import type { OcrResult } from './ocr';

const OCR_RESULT_CACHE_DB = 'collab-ocr-results';
const OCR_RESULT_CACHE_STORE = 'results';
// v2: cached OCR results now also persist word bounding boxes and source dimensions
// for the selectable OCR overlay. Bumping the version invalidates older word-less
// entries so the overlay can render on the next recognition.
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

function openOcrCache(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(OCR_RESULT_CACHE_DB, 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore(OCR_RESULT_CACHE_STORE);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('Could not open OCR result cache'));
  });
}

export async function readOcrCache(scope: OcrCacheScope): Promise<CachedOcrResult | null> {
  const key = await buildOcrCacheKey(scope);
  const db = await openOcrCache();
  try {
    return await new Promise<CachedOcrResult | null>((resolve, reject) => {
      const transaction = db.transaction(OCR_RESULT_CACHE_STORE, 'readonly');
      const request = transaction.objectStore(OCR_RESULT_CACHE_STORE).get(key);
      request.onsuccess = () => resolve((request.result as CachedOcrResult | undefined) ?? null);
      request.onerror = () => reject(request.error ?? new Error('Could not read OCR result cache'));
    });
  } finally {
    db.close();
  }
}

export async function writeOcrCache(
  scope: OcrCacheScope,
  result: OcrResult,
  resultMode: CachedOcrResult['resultMode'],
): Promise<void> {
  const key = await buildOcrCacheKey(scope);
  const db = await openOcrCache();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction(OCR_RESULT_CACHE_STORE, 'readwrite');
      transaction.objectStore(OCR_RESULT_CACHE_STORE).put(
        {
          ...result,
          resultMode,
          cachedAt: new Date().toISOString(),
        } satisfies CachedOcrResult,
        key,
      );
      transaction.oncomplete = () => resolve();
      transaction.onerror = () =>
        reject(transaction.error ?? new Error('Could not write OCR result cache'));
      transaction.onabort = () =>
        reject(transaction.error ?? new Error('Could not write OCR result cache'));
    });
  } finally {
    db.close();
  }
}

export async function clearOcrResultCache(): Promise<void> {
  const db = await openOcrCache();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction(OCR_RESULT_CACHE_STORE, 'readwrite');
      transaction.objectStore(OCR_RESULT_CACHE_STORE).clear();
      transaction.oncomplete = () => resolve();
      transaction.onerror = () =>
        reject(transaction.error ?? new Error('Could not clear OCR result cache'));
      transaction.onabort = () =>
        reject(transaction.error ?? new Error('Could not clear OCR result cache'));
    });
  } finally {
    db.close();
  }
}
