import { type OcrPreprocessingMode, useUiStore } from '../store/uiStore';

import { encodeImageCanvas, preprocessCanvas } from './imageProcessing';
import { registerMediaCleanup } from './mediaLifecycle';
import { type OcrCacheScope, readOcrCache, scopeOcrCache, writeOcrCache } from './ocrCache';
import { tauriCommands } from './tauri';

export interface OcrResult {
  text: string;
  confidence: number | null;
  cached?: boolean;
  words?: OcrWordBox[];
  sourceWidth?: number;
  sourceHeight?: number;
}

export type OcrProgress = (progress: number, status: string) => void;

export interface OcrWordBox {
  text: string;
  confidence: number;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export interface RecognizeImageTextOptions {
  cacheScope?: OcrCacheScope;
  force?: boolean;
  signal?: AbortSignal;
}

const OCR_CACHE_PATH = 'collab-ocr/official-fast';
const OCR_WORKER_IDLE_MS = 3 * 60 * 1000;
const MAX_OCR_JOBS = 8;
let jobTail: Promise<void> = Promise.resolve();
let pendingJobs = 0;

let activeWorker: {
  language: string;
  worker: Tesseract.Worker;
  idleTimer: number | null;
  progress: { current: OcrProgress | undefined };
} | null = null;

function clearWorkerIdleTimer() {
  if (activeWorker?.idleTimer != null) {
    window.clearTimeout(activeWorker.idleTimer);
    activeWorker.idleTimer = null;
  }
}

function runOcrJob<T>(work: () => Promise<T>): Promise<T> {
  if (pendingJobs >= MAX_OCR_JOBS) {
    return Promise.reject(
      new Error('OCR is busy. Wait for a current request to finish and try again.'),
    );
  }
  pendingJobs++;
  clearWorkerIdleTimer();
  const result = jobTail.then(work);
  // Failed requests cannot poison the queue or bypass cleanup for the next caller.
  jobTail = result
    .then(
      () => undefined,
      () => undefined,
    )
    .finally(() => {
      pendingJobs--;
      if (pendingJobs === 0) scheduleWorkerIdleShutdown();
    });
  return result;
}

function isNativeOcrSupportedBase64ImageDataUrl(value: string): boolean {
  return /^data:image\/(?:png|jpe?g|webp);base64,/i.test(value);
}

async function imageToNativeOcrDataUrl(image: string | HTMLCanvasElement): Promise<string> {
  if (image instanceof HTMLCanvasElement) return encodeImageCanvas(image, 'image/png');
  if (isNativeOcrSupportedBase64ImageDataUrl(image)) return image;
  return encodeImageCanvas(await toCanvas(image), 'image/png');
}

async function getImageSize(
  image: string | HTMLCanvasElement,
): Promise<{ width: number; height: number }> {
  if (image instanceof HTMLCanvasElement) return { width: image.width, height: image.height };
  const element = await loadImageElement(image);
  return { width: element.naturalWidth, height: element.naturalHeight };
}

function assetUrl(path: string): string {
  const base = import.meta.env.BASE_URL || '/';
  return new URL(`${base.replace(/\/$/, '')}/ocr-assets/${path}`, window.location.href).href;
}

async function loadImageElement(source: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('Failed to decode OCR image'));
    image.src = source;
  });
}

async function toCanvas(image: string | HTMLCanvasElement): Promise<HTMLCanvasElement> {
  if (image instanceof HTMLCanvasElement) return image;
  const element = await loadImageElement(image);
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, element.naturalWidth);
  canvas.height = Math.max(1, element.naturalHeight);
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Failed to prepare OCR image');
  context.drawImage(element, 0, 0);
  return canvas;
}

async function preprocessImage(
  image: string | HTMLCanvasElement,
  mode: OcrPreprocessingMode,
  signal?: AbortSignal,
): Promise<string | HTMLCanvasElement> {
  if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
  if (
    mode === 'none' &&
    image instanceof HTMLCanvasElement &&
    image.width * image.height <= 12_000_000
  )
    return image;
  const source = image instanceof HTMLCanvasElement ? image : await loadImageElement(image);
  if (
    mode === 'none' &&
    !(source instanceof HTMLCanvasElement) &&
    source.naturalWidth * source.naturalHeight <= 12_000_000
  )
    return image;
  return preprocessCanvas(source, mode, signal);
}

function installedLanguageCodes(language: string): string[] {
  return language.split('+').filter((code) => code && code !== 'eng');
}

function base64ToBytes(base64: string): Uint8Array {
  const raw = atob(base64);
  const bytes = new Uint8Array(raw.length);
  for (let index = 0; index < raw.length; index += 1) {
    bytes[index] = raw.charCodeAt(index);
  }
  return bytes;
}

function openTesseractCache(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('keyval-store');
    request.onupgradeneeded = () => {
      request.result.createObjectStore('keyval');
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('Could not open OCR cache'));
  });
}

async function writeTesseractCache(key: string, value: Uint8Array): Promise<void> {
  const db = await openTesseractCache();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction('keyval', 'readwrite');
      transaction.objectStore('keyval').put(value, key);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () =>
        reject(transaction.error ?? new Error('Could not write OCR cache'));
      transaction.onabort = () =>
        reject(transaction.error ?? new Error('Could not write OCR cache'));
    });
  } finally {
    db.close();
  }
}

async function seedInstalledLanguagePacks(language: string): Promise<void> {
  await Promise.all(
    installedLanguageCodes(language).map(async (code) => {
      const pack = await tauriCommands.readOcrLanguagePackData(code);
      await writeTesseractCache(
        `${OCR_CACHE_PATH}/${pack.code}.traineddata`,
        base64ToBytes(pack.dataBase64),
      );
    }),
  );
}

async function terminateActiveWorker(): Promise<void> {
  if (!activeWorker) return;
  const { worker, idleTimer } = activeWorker;
  activeWorker.progress.current = undefined;
  activeWorker = null;
  if (idleTimer != null) window.clearTimeout(idleTimer);
  await worker.terminate().catch(() => undefined);
}

function scheduleWorkerIdleShutdown() {
  if (!activeWorker) return;
  clearWorkerIdleTimer();
  const owner = activeWorker;
  owner.idleTimer = window.setTimeout(() => {
    if (activeWorker !== owner || pendingJobs !== 0) return;
    // A later request must wait for idle termination before creating/reusing a worker.
    jobTail = jobTail.then(terminateActiveWorker).catch(() => undefined);
  }, OCR_WORKER_IDLE_MS);
}

async function getWorker(
  language: string,
  onProgress?: OcrProgress,
  signal?: AbortSignal,
): Promise<Tesseract.Worker> {
  if (activeWorker?.language === language) {
    clearWorkerIdleTimer();
    activeWorker.progress.current = onProgress;
    return activeWorker.worker;
  }

  await terminateActiveWorker();
  await seedInstalledLanguagePacks(language);

  if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
  const progress = { current: onProgress };
  const stopProgress = () => {
    progress.current = undefined;
  };
  signal?.addEventListener('abort', stopProgress, { once: true });
  const { createWorker } = await import('tesseract.js');
  try {
    const worker = await createWorker(language, 1, {
      workerPath: assetUrl('worker.min.js'),
      corePath: assetUrl('tesseract-core-lstm.wasm.js'),
      langPath: assetUrl(''),
      cachePath: OCR_CACHE_PATH,
      gzip: true,
      workerBlobURL: false,
      logger: (message) => {
        if (typeof message.progress === 'number') {
          progress.current?.(message.progress, message.status ?? 'Recognizing text');
        }
      },
    });
    if (signal?.aborted) {
      progress.current = undefined;
      await worker.terminate().catch(() => undefined);
      throw new DOMException('Cancelled', 'AbortError');
    }
    activeWorker = { language, worker, idleTimer: null, progress };
    return worker;
  } catch (error) {
    progress.current = undefined;
    throw error;
  } finally {
    signal?.removeEventListener('abort', stopProgress);
  }
}

function wordsFromBlocks(blocks: Tesseract.Block[] | null | undefined): OcrWordBox[] {
  return (blocks ?? []).flatMap((block) =>
    (block.paragraphs ?? []).flatMap((paragraph) =>
      (paragraph.lines ?? []).flatMap((line) =>
        (line.words ?? [])
          .filter((word) => word.bbox && word.text.trim().length > 0)
          .map((word) => ({
            text: word.text,
            confidence: word.confidence,
            x0: word.bbox.x0,
            y0: word.bbox.y0,
            x1: word.bbox.x1,
            y1: word.bbox.y1,
          })),
      ),
    ),
  );
}

// Tesseract TSV columns: level, page, block, par, line, word, left, top, width, height, conf, text.
// level 5 is a word. This is more reliable across core builds than the hierarchical blocks JSON.
function wordsFromTsv(tsv: string | null | undefined): OcrWordBox[] {
  if (!tsv) return [];
  const words: OcrWordBox[] = [];
  for (const row of tsv.split('\n')) {
    const cols = row.split('\t');
    if (cols.length < 12 || cols[0] !== '5') continue;
    const text = cols.slice(11).join('\t').trim();
    if (text.length === 0) continue;
    const left = Number(cols[6]);
    const top = Number(cols[7]);
    const width = Number(cols[8]);
    const height = Number(cols[9]);
    const conf = Number(cols[10]);
    if (![left, top, width, height].every(Number.isFinite)) continue;
    words.push({
      text,
      confidence: Number.isFinite(conf) ? conf : 0,
      x0: left,
      y0: top,
      x1: left + width,
      y1: top + height,
    });
  }
  return words;
}

async function recognizeWithWasm(
  image: string | HTMLCanvasElement,
  language: string,
  onProgress?: OcrProgress,
  signal?: AbortSignal,
): Promise<OcrResult> {
  const worker = await getWorker(language, onProgress, signal);
  try {
    if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
    let abort!: () => void;
    const cancelled = new Promise<never>((_resolve, reject) => {
      abort = () => {
        void terminateActiveWorker();
        reject(new DOMException('Cancelled', 'AbortError'));
      };
      signal?.addEventListener('abort', abort, { once: true });
    });
    const result = await Promise.race([
      worker.recognize(image, {}, { text: true, blocks: true, tsv: true }),
      cancelled,
    ]).finally(() => signal?.removeEventListener('abort', abort));
    const blockWords = wordsFromBlocks(result.data.blocks);
    const words = blockWords.length > 0 ? blockWords : wordsFromTsv(result.data.tsv);
    const size = await getImageSize(image);
    return {
      text: result.data.text.trim(),
      confidence: typeof result.data.confidence === 'number' ? result.data.confidence : null,
      words,
      sourceWidth: size.width,
      sourceHeight: size.height,
    };
  } finally {
    if (activeWorker?.worker === worker) activeWorker.progress.current = undefined;
  }
}

async function recognizeWithNativeFallback(
  image: string | HTMLCanvasElement,
  language: string,
  onProgress?: OcrProgress,
  signal?: AbortSignal,
): Promise<OcrResult> {
  onProgress?.(0.1, 'Preparing native OCR');
  const dataUrl = await imageToNativeOcrDataUrl(image);
  const result = await (signal
    ? tauriCommands.recognizeImageDataUrlWords(dataUrl, language, signal)
    : tauriCommands.recognizeImageDataUrlWords(dataUrl, language));
  onProgress?.(1, 'OCR complete');
  const size = await getImageSize(image);
  return {
    text: result.text.trim(),
    confidence: null,
    words: result.words.filter((word) => word.text.trim().length > 0),
    sourceWidth: size.width,
    sourceHeight: size.height,
  };
}

async function recognizeOwnedImageText(
  image: string | HTMLCanvasElement,
  onProgress?: OcrProgress,
  options: RecognizeImageTextOptions = {},
): Promise<OcrResult> {
  if (options.signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
  const { ocrLanguage, ocrModelSource, ocrPreprocessingMode } = useUiStore.getState();
  const language = ocrLanguage || 'eng';
  const cacheScope = options.cacheScope
    ? scopeOcrCache({
        ...options.cacheScope,
        language,
        modelSource: ocrModelSource,
        preprocessing: ocrPreprocessingMode,
        engine: 'tesseract.js-v7',
        resultMode: 'ocr',
      })
    : null;
  const cachedResult = async (): Promise<OcrResult | null> => {
    if (!cacheScope || options.force) return null;
    const cached = await readOcrCache(cacheScope).catch(() => null);
    if (options.signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
    if (!cached) return null;
    onProgress?.(1, 'Loaded cached OCR');
    return { ...cached, cached: true };
  };
  // Completed cache hits do not wait behind expensive recognition jobs.
  const cached = await cachedResult();
  if (cached) return cached;
  return runOcrJob(async () => {
    if (options.signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
    const refreshed = await cachedResult();
    if (refreshed) return refreshed;
    onProgress?.(
      0,
      ocrPreprocessingMode === 'none'
        ? 'Preparing OCR'
        : `Applying ${ocrPreprocessingMode} preprocessing`,
    );
    const preparedImage = await preprocessImage(image, ocrPreprocessingMode, options.signal);
    let result: OcrResult;
    try {
      try {
        result = await recognizeWithWasm(preparedImage, language, onProgress, options.signal);
      } catch (error) {
        if (
          options.signal?.aborted ||
          (error instanceof DOMException && error.name === 'AbortError')
        )
          throw error;
        console.warn('[ocr] bundled WASM OCR failed, falling back to native tesseract', error);
        // A failed recognition may leave this worker unusable; never reuse it for the next job.
        await terminateActiveWorker();
        result = await recognizeWithNativeFallback(
          preparedImage,
          language,
          onProgress,
          options.signal,
        );
      }
      if (options.signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
      if (cacheScope) await writeOcrCache(cacheScope, result, 'ocr').catch(() => undefined);
      return result;
    } finally {
      if (preparedImage instanceof HTMLCanvasElement && preparedImage !== image) {
        preparedImage.width = 0;
        preparedImage.height = 0;
      }
    }
  });
}

const requests = new Set<AbortController>();
registerMediaCleanup(() => {
  for (const request of requests) request.abort();
  void terminateActiveWorker();
});
export async function recognizeImageText(
  image: string | HTMLCanvasElement,
  onProgress?: OcrProgress,
  options: RecognizeImageTextOptions = {},
): Promise<OcrResult> {
  const request = new AbortController();
  const cancel = () => request.abort();
  if (options.signal?.aborted) request.abort();
  options.signal?.addEventListener('abort', cancel, { once: true });
  requests.add(request);
  try {
    return await recognizeOwnedImageText(image, onProgress, { ...options, signal: request.signal });
  } finally {
    requests.delete(request);
    options.signal?.removeEventListener('abort', cancel);
  }
}

export async function copyTextToClipboard(text: string): Promise<void> {
  await navigator.clipboard.writeText(text);
}
