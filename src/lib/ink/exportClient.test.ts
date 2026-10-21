import { afterEach, describe, expect, it, vi } from 'vitest';

import { createInkDocument } from './document';
import { startInkExport } from './exportClient';
import { InkExportCancelledError } from './exportRuntime';

const OriginalWorker = globalThis.Worker;

afterEach(() => {
  globalThis.Worker = OriginalWorker;
});

describe('startInkExport', () => {
  it('terminates a busy worker and rejects immediately when cancelled', async () => {
    const terminate = vi.fn();
    class BusyWorker {
      addEventListener() {}
      postMessage() {}
      terminate = terminate;
    }
    globalThis.Worker = BusyWorker as unknown as typeof Worker;
    const document = createInkDocument({ name: 'Cancel', timestamp: '2026-01-01T00:00:00.000Z' });
    const job = startInkExport(
      {
        document,
        relativePath: 'Sketches/Cancel.ink',
        assets: {},
        report: { missingAssets: [], missingFonts: [], warnings: [] },
        options: {
          format: 'pdf',
          scope: 'document',
          pageId: document.pageOrder[0],
          crop: 'page',
          scale: 4,
          padding: 0,
          transparent: false,
          includePageBackground: true,
          palette: 'page',
        },
      },
      vi.fn(),
    );

    job.cancel();

    await expect(job.promise).rejects.toBeInstanceOf(InkExportCancelledError);
    expect(terminate).toHaveBeenCalledOnce();
  });
});

it('shares global export admission with PowerPoint and releases slots on cancellation', async () => {
  const { startPptxExport } = await import('../deck/pptx/exportClient');
  class BusyWorker {
    addEventListener() {}
    postMessage() {}
    terminate() {}
  }
  globalThis.Worker = BusyWorker as unknown as typeof Worker;
  const deck = {} as import('../../types/deck').DeckDocument;
  const request = { deck, assets: {}, svgFallbacks: {}, missingFonts: {} };
  const first = startPptxExport(request, vi.fn());
  const second = startPptxExport(request, vi.fn());
  await expect(startPptxExport(request, vi.fn()).promise).rejects.toThrow('Two exports');
  const cancelled = expect(first.promise).rejects.toThrow('cancelled');
  first.cancel();
  await cancelled;
  const another = startPptxExport(request, vi.fn());
  const jobs = Promise.all([
    expect(second.promise).rejects.toThrow('cancelled'),
    expect(another.promise).rejects.toThrow('cancelled'),
  ]);
  second.cancel();
  another.cancel();
  await jobs;
});
