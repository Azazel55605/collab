import { beforeEach, describe, expect, it, vi } from 'vitest';

import { recognizeImageText } from './ocr';
import { tauriCommands } from './tauri';

vi.mock('tesseract.js', () => ({
  createWorker: vi.fn(async () => {
    throw new Error('WASM unavailable');
  }),
}));

vi.mock('./tauri', () => ({
  tauriCommands: {
    recognizeImageDataUrlWords: vi.fn(async () => ({ text: 'hello', words: [] })),
  },
}));

describe('recognizeImageText', () => {
  beforeEach(() => {
    vi.mocked(tauriCommands.recognizeImageDataUrlWords).mockClear();

    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
      drawImage: vi.fn(),
      getImageData: vi.fn(),
      putImageData: vi.fn(),
    } as unknown as CanvasRenderingContext2D);
    vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue(
      'data:image/png;base64,converted',
    );

    class ImageMock {
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      naturalWidth = 320;
      naturalHeight = 160;

      set src(_value: string) {
        queueMicrotask(() => this.onload?.());
      }
    }

    vi.stubGlobal('Image', ImageMock);
  });

  it('normalizes non-base64 image data URLs before native fallback OCR', async () => {
    const result = await recognizeImageText('data:image/svg+xml,%3Csvg%3E%3C/svg%3E');

    expect(result.text).toBe('hello');
    expect(tauriCommands.recognizeImageDataUrlWords).toHaveBeenCalledWith(
      'data:image/png;base64,converted',
      'eng',
    );
  });
});
