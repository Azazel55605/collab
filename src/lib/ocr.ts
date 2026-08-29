import { type OcrPreprocessingMode, useUiStore } from '../store/uiStore';

import { type OcrCacheScope, readOcrCache, writeOcrCache } from './ocrCache';
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
}

const OCR_CACHE_PATH = 'collab-ocr/official-fast';
const OCR_WORKER_IDLE_MS = 3 * 60 * 1000;

let activeWorker: {
  language: string;
  worker: Tesseract.Worker;
  idleTimer: number | null;
} | null = null;
let activeProgress: OcrProgress | undefined;

function isNativeOcrSupportedBase64ImageDataUrl(value: string): boolean {
  return /^data:image\/(?:png|jpe?g|webp);base64,/i.test(value);
}

async function imageToNativeOcrDataUrl(image: string | HTMLCanvasElement): Promise<string> {
  if (image instanceof HTMLCanvasElement) return image.toDataURL('image/png');
  if (isNativeOcrSupportedBase64ImageDataUrl(image)) return image;
  return (await toCanvas(image)).toDataURL('image/png');
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
): Promise<string | HTMLCanvasElement> {
  if (mode === 'none') return image;
  const source = await toCanvas(image);
  const canvas = document.createElement('canvas');
  canvas.width = source.width;
  canvas.height = source.height;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) throw new Error('Failed to prepare OCR preprocessing');
  context.drawImage(source, 0, 0);
  const imageData = context.getImageData(0, 0, canvas.width, canvas.height);
  const { data } = imageData;
  for (let index = 0; index < data.length; index += 4) {
    const red = data[index] ?? 0;
    const green = data[index + 1] ?? 0;
    const blue = data[index + 2] ?? 0;
    const gray = Math.round(red * 0.299 + green * 0.587 + blue * 0.114);

    if (mode === 'invert') {
      data[index] = 255 - red;
      data[index + 1] = 255 - green;
      data[index + 2] = 255 - blue;
    } else if (mode === 'contrast') {
      const boosted = Math.max(0, Math.min(255, (gray - 128) * 1.45 + 128));
      data[index] = boosted;
      data[index + 1] = boosted;
      data[index + 2] = boosted;
    } else if (mode === 'threshold') {
      const threshold = gray >= 168 ? 255 : 0;
      data[index] = threshold;
      data[index + 1] = threshold;
      data[index + 2] = threshold;
    } else {
      data[index] = gray;
      data[index + 1] = gray;
      data[index + 2] = gray;
    }
  }
  context.putImageData(imageData, 0, 0);
  return canvas;
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
  activeWorker = null;
  if (idleTimer != null) window.clearTimeout(idleTimer);
  await worker.terminate().catch(() => undefined);
}

function scheduleWorkerIdleShutdown() {
  if (!activeWorker) return;
  if (activeWorker.idleTimer != null) window.clearTimeout(activeWorker.idleTimer);
  activeWorker.idleTimer = window.setTimeout(() => {
    void terminateActiveWorker();
  }, OCR_WORKER_IDLE_MS);
}

async function getWorker(language: string): Promise<Tesseract.Worker> {
  if (activeWorker?.language === language) {
    if (activeWorker.idleTimer != null) {
      window.clearTimeout(activeWorker.idleTimer);
      activeWorker.idleTimer = null;
    }
    return activeWorker.worker;
  }

  await terminateActiveWorker();
  await seedInstalledLanguagePacks(language);

  const { createWorker } = await import('tesseract.js');
  const worker = await createWorker(language, 1, {
    workerPath: assetUrl('worker.min.js'),
    corePath: assetUrl('tesseract-core-lstm.wasm.js'),
    langPath: assetUrl(''),
    cachePath: OCR_CACHE_PATH,
    gzip: true,
    workerBlobURL: false,
    logger: (message) => {
      if (typeof message.progress === 'number') {
        activeProgress?.(message.progress, message.status ?? 'Recognizing text');
      }
    },
  });
  activeWorker = { language, worker, idleTimer: null };
  return worker;
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
): Promise<OcrResult> {
  activeProgress = onProgress;
  const worker = await getWorker(language);
  try {
    const result = await worker.recognize(image, {}, { text: true, blocks: true, tsv: true });
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
    activeProgress = undefined;
    scheduleWorkerIdleShutdown();
  }
}

async function recognizeWithNativeFallback(
  image: string | HTMLCanvasElement,
  language: string,
  onProgress?: OcrProgress,
): Promise<OcrResult> {
  onProgress?.(0.1, 'Preparing native OCR');
  const dataUrl = await imageToNativeOcrDataUrl(image);
  const result = await tauriCommands.recognizeImageDataUrlWords(dataUrl, language);
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

export async function recognizeImageText(
  image: string | HTMLCanvasElement,
  onProgress?: OcrProgress,
  options: RecognizeImageTextOptions = {},
): Promise<OcrResult> {
  const { ocrLanguage, ocrModelSource, ocrPreprocessingMode } = useUiStore.getState();
  const language = ocrLanguage || 'eng';
  const cacheScope = options.cacheScope
    ? {
        ...options.cacheScope,
        language,
        modelSource: ocrModelSource,
        preprocessing: ocrPreprocessingMode,
        engine: 'tesseract.js-v7',
        resultMode: 'ocr',
      }
    : null;
  if (cacheScope && !options.force) {
    const cached = await readOcrCache(cacheScope);
    if (cached) {
      onProgress?.(1, 'Loaded cached OCR');
      return {
        text: cached.text,
        confidence: cached.confidence,
        words: cached.words,
        sourceWidth: cached.sourceWidth,
        sourceHeight: cached.sourceHeight,
        cached: true,
      };
    }
  }

  try {
    onProgress?.(
      0,
      ocrPreprocessingMode === 'none'
        ? 'Preparing OCR'
        : `Applying ${ocrPreprocessingMode} preprocessing`,
    );
    const preparedImage = await preprocessImage(image, ocrPreprocessingMode);
    const result = await recognizeWithWasm(preparedImage, language, onProgress);
    if (cacheScope) await writeOcrCache(cacheScope, result, 'ocr').catch(() => undefined);
    return result;
  } catch (error) {
    console.warn('[ocr] bundled WASM OCR failed, falling back to native tesseract', error);
    const preparedImage = await preprocessImage(image, ocrPreprocessingMode);
    const result = await recognizeWithNativeFallback(preparedImage, language, onProgress);
    if (cacheScope) await writeOcrCache(cacheScope, result, 'ocr').catch(() => undefined);
    return result;
  }
}

export async function copyTextToClipboard(text: string): Promise<void> {
  await navigator.clipboard.writeText(text);
}
