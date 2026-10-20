import { describe, expect, it, vi } from 'vitest';

const pdf = vi.hoisted(() => ({ workerOptions: { workerSrc: '' }, getDocument: vi.fn() }));
vi.mock('pdfjs-dist/legacy/build/pdf.mjs', () => ({
  GlobalWorkerOptions: pdf.workerOptions,
  getDocument: pdf.getDocument,
  PixelsPerInch: {},
  RenderingCancelledException: class extends Error {},
  TextLayer: class {},
}));

describe('shared PDF runtime', () => {
  it('pairs the compatibility API with its matching worker before exposing document loading', async () => {
    const runtime = await import('./pdfRuntime');
    expect(runtime.getDocument).toBe(pdf.getDocument);
    expect(pdf.workerOptions.workerSrc).toContain('pdfjs-dist/legacy/build/pdf.worker.mjs');
    expect((await import('./pdfRuntime')).getDocument).toBe(runtime.getDocument);
  });
});
