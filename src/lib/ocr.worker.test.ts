import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  settings: { ocrLanguage: 'eng', ocrModelSource: 'official', ocrPreprocessingMode: 'none' },
  createWorker: vi.fn(),
  recognize: vi.fn(),
  terminate: vi.fn(),
  readCache: vi.fn(),
  writeCache: vi.fn(),
  native: vi.fn(),
}));
vi.mock('../store/uiStore', () => ({ useUiStore: { getState: () => mocks.settings } }));
vi.mock('tesseract.js', () => ({ createWorker: mocks.createWorker }));
vi.mock('./ocrCache', () => ({
  readOcrCache: mocks.readCache,
  scopeOcrCache: (scope: unknown) => scope,
  writeOcrCache: mocks.writeCache,
}));
vi.mock('./tauri', () => ({
  tauriCommands: {
    recognizeImageDataUrlWords: mocks.native,
    readOcrLanguagePackData: vi.fn(async (code: string) => ({ code, dataBase64: 'cGFjaw==' })),
  },
}));

const recognized = { data: { text: 'hello', confidence: 95, blocks: [], tsv: '' } };
type ProgressLogger = (message: { progress: number; status: string }) => void;
let loggers: ProgressLogger[];
let recognizeImageText: typeof import('./ocr').recognizeImageText;
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}
function image() {
  const canvas = document.createElement('canvas');
  canvas.width = 100;
  canvas.height = 50;
  return canvas;
}

beforeEach(async () => {
  vi.useFakeTimers();
  vi.resetModules();
  mocks.settings.ocrLanguage = 'eng';
  mocks.settings.ocrPreprocessingMode = 'none';
  loggers = [];
  mocks.recognize.mockReset().mockResolvedValue(recognized);
  mocks.terminate.mockReset().mockResolvedValue(undefined);
  mocks.createWorker.mockReset().mockImplementation(async (_language, _engine, options) => {
    loggers.push(options.logger);
    return { recognize: mocks.recognize, terminate: mocks.terminate };
  });
  mocks.readCache.mockReset().mockResolvedValue(null);
  mocks.writeCache.mockReset().mockResolvedValue(undefined);
  mocks.native.mockReset().mockResolvedValue({ text: 'native', words: [] });
  vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue('data:image/png;base64,cG5n');
  // Only installed language-pack seeding uses this DB; result caching is mocked independently.
  vi.stubGlobal('indexedDB', {
    open: () => {
      const request = {
        result: {
          close() {},
          transaction: () => {
            const transaction = {
              objectStore: () => ({ put() {} }),
              oncomplete: null as (() => void) | null,
            };
            queueMicrotask(() => transaction.oncomplete?.());
            return transaction;
          },
        },
        onsuccess: null as (() => void) | null,
      };
      queueMicrotask(() => request.onsuccess?.());
      return request;
    },
  });
  ({ recognizeImageText } = await import('./ocr'));
});
afterEach(async () => {
  await vi.advanceTimersByTimeAsync(3 * 60 * 1000);
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it('single-flights delayed initialization and keeps progress attached to the running pane', async () => {
  const initialization = deferred<{
    recognize: typeof mocks.recognize;
    terminate: typeof mocks.terminate;
  }>();
  mocks.createWorker.mockImplementationOnce((_language, _engine, options) => {
    loggers.push(options.logger);
    return initialization.promise;
  });
  const firstRecognition = deferred<typeof recognized>();
  mocks.recognize.mockImplementationOnce(() => firstRecognition.promise);
  const firstProgress = vi.fn();
  const secondProgress = vi.fn();
  const first = recognizeImageText(image(), firstProgress);
  const second = recognizeImageText(image(), secondProgress);
  await vi.waitFor(() => expect(mocks.createWorker).toHaveBeenCalledTimes(1));
  loggers[0]({ progress: 0.2, status: 'loading' });
  expect(firstProgress).toHaveBeenLastCalledWith(0.2, 'loading');
  expect(secondProgress).not.toHaveBeenCalled();
  initialization.resolve({ recognize: mocks.recognize, terminate: mocks.terminate });
  await vi.waitFor(() => expect(mocks.recognize).toHaveBeenCalledTimes(1));
  loggers[0]({ progress: 0.4, status: 'first' });
  firstRecognition.resolve(recognized);
  await first;
  await second;
  expect(mocks.createWorker).toHaveBeenCalledTimes(1);
  expect(mocks.recognize).toHaveBeenCalledTimes(2);
  expect(secondProgress).not.toHaveBeenCalledWith(0.4, 'first');
  // Late logs after both jobs finish cannot update either pane.
  firstProgress.mockClear();
  secondProgress.mockClear();
  loggers[0]({ progress: 1, status: 'late' });
  expect(firstProgress).not.toHaveBeenCalled();
  expect(secondProgress).not.toHaveBeenCalled();
});

it('waits for the first job before changing language and disconnects its logger', async () => {
  const held = deferred<typeof recognized>();
  mocks.recognize.mockImplementationOnce(() => held.promise);
  const firstProgress = vi.fn();
  const nextProgress = vi.fn();
  const first = recognizeImageText(image(), firstProgress);
  await vi.waitFor(() => expect(mocks.recognize).toHaveBeenCalledTimes(1));
  mocks.settings.ocrLanguage = 'deu';
  const second = recognizeImageText(image(), nextProgress);
  expect(mocks.terminate).not.toHaveBeenCalled();
  held.resolve(recognized);
  await first;
  await second;
  expect(mocks.createWorker.mock.calls.map(([language]) => language)).toEqual(['eng', 'deu']);
  expect(mocks.terminate).toHaveBeenCalledTimes(1);
  nextProgress.mockClear();
  loggers[0]({ progress: 0.9, status: 'old worker' });
  expect(nextProgress).not.toHaveBeenCalled();
});

it('does not idle-terminate an active job, and shuts down after the final idle interval', async () => {
  const held = deferred<typeof recognized>();
  mocks.recognize.mockImplementationOnce(() => held.promise);
  const first = recognizeImageText(image());
  await vi.waitFor(() => expect(mocks.recognize).toHaveBeenCalledTimes(1));
  await vi.advanceTimersByTimeAsync(4 * 60 * 1000);
  expect(mocks.terminate).not.toHaveBeenCalled();
  held.resolve(recognized);
  await first;
  await vi.advanceTimersByTimeAsync(0);
  await vi.advanceTimersByTimeAsync(2 * 60 * 1000);
  const secondHeld = deferred<typeof recognized>();
  mocks.recognize.mockImplementationOnce(() => secondHeld.promise);
  const second = recognizeImageText(image());
  await vi.waitFor(() => expect(mocks.recognize).toHaveBeenCalledTimes(2));
  await vi.advanceTimersByTimeAsync(2 * 60 * 1000);
  expect(mocks.terminate).not.toHaveBeenCalled();
  secondHeld.resolve(recognized);
  await second;
  await vi.advanceTimersByTimeAsync(3 * 60 * 1000);
  expect(mocks.terminate).toHaveBeenCalledTimes(1);
});

it('bounds retained recognition jobs and rejects overload without invoking native fallback', async () => {
  const held = deferred<typeof recognized>();
  mocks.recognize.mockImplementationOnce(() => held.promise);
  const jobs = Array.from({ length: 8 }, () => recognizeImageText(image()));
  await vi.waitFor(() => expect(mocks.recognize).toHaveBeenCalledTimes(1));
  await expect(recognizeImageText(image())).rejects.toThrow('OCR is busy');
  expect(mocks.native).not.toHaveBeenCalled();
  held.resolve(recognized);
  await Promise.all(jobs);
  expect(mocks.recognize).toHaveBeenCalledTimes(8);
});

it('releases a failed worker before native fallback and recovers after a failed job', async () => {
  mocks.recognize.mockRejectedValueOnce(new Error('broken WASM'));
  mocks.native.mockRejectedValueOnce(new Error('native failed'));
  await expect(recognizeImageText(image())).rejects.toThrow('native failed');
  expect(mocks.terminate).toHaveBeenCalledTimes(1);
  expect((await recognizeImageText(image())).text).toBe('hello');
  expect(mocks.createWorker).toHaveBeenCalledTimes(2);
});

it('recovers after worker initialization fails and clears initialization progress ownership', async () => {
  mocks.createWorker.mockRejectedValueOnce(new Error('cannot initialize'));
  expect((await recognizeImageText(image())).text).toBe('native');
  expect((await recognizeImageText(image())).text).toBe('hello');
  expect(mocks.createWorker).toHaveBeenCalledTimes(2);
});

it('serves completed cache hits without waiting for a running recognition', async () => {
  const held = deferred<typeof recognized>();
  mocks.recognize.mockImplementationOnce(() => held.promise);
  const running = recognizeImageText(image());
  await vi.waitFor(() => expect(mocks.recognize).toHaveBeenCalledTimes(1));
  mocks.readCache.mockResolvedValueOnce({ text: 'cached', confidence: 98, words: [] });
  expect(
    await recognizeImageText(image(), undefined, { cacheScope: { file: 'cached' } }),
  ).toMatchObject({ text: 'cached', cached: true });
  expect(mocks.recognize).toHaveBeenCalledTimes(1);
  held.resolve(recognized);
  await running;
});

it('treats a failed result cache as disposable without falling back from working WASM', async () => {
  mocks.readCache.mockRejectedValue(new Error('quota or broken DB'));
  mocks.writeCache.mockRejectedValue(new Error('quota'));
  expect(
    (await recognizeImageText(image(), undefined, { cacheScope: { file: 'uncached' } })).text,
  ).toBe('hello');
  expect(mocks.native).not.toHaveBeenCalled();
});

it('rechecks a queued duplicate after the first request writes its result cache', async () => {
  const held = deferred<typeof recognized>();
  mocks.recognize.mockImplementationOnce(() => held.promise);
  mocks.writeCache.mockImplementation(async (_scope, result) => {
    mocks.readCache.mockResolvedValue(result);
  });
  const options = { cacheScope: { file: 'shared' } };
  const first = recognizeImageText(image(), undefined, options);
  const second = recognizeImageText(image(), undefined, options);
  await vi.waitFor(() => expect(mocks.recognize).toHaveBeenCalledTimes(1));
  held.resolve(recognized);
  expect((await first).cached).not.toBe(true);
  expect((await second).cached).toBe(true);
  expect(mocks.recognize).toHaveBeenCalledTimes(1);
});

it('waits for an idle worker to finish terminating before creating its replacement', async () => {
  await recognizeImageText(image());
  await vi.advanceTimersByTimeAsync(0);
  const termination = deferred<void>();
  mocks.terminate.mockImplementationOnce(() => termination.promise);
  await vi.advanceTimersByTimeAsync(3 * 60 * 1000);
  expect(mocks.terminate).toHaveBeenCalledTimes(1);
  const next = recognizeImageText(image());
  await vi.advanceTimersByTimeAsync(0);
  expect(mocks.createWorker).toHaveBeenCalledTimes(1);
  termination.resolve();
  await next;
  expect(mocks.createWorker).toHaveBeenCalledTimes(2);
});
