import type { DeckDocument } from '../../../types/deck';
import { DeckExportCancelledError } from '../exportPdf';

import type { DeckPptxExportResult } from './exportDeckToPptx';
import type { DeckPptxWorkerInbound, DeckPptxWorkerOutbound } from './exportWorker';

export interface DeckPptxExportRequest {
  deck: DeckDocument;
  assets: Record<string, string>;
  svgFallbacks: Record<string, string>;
  slideIds?: string[];
  missingFonts: Record<string, string>;
}

export interface DeckPptxExportJob {
  promise: Promise<DeckPptxExportResult>;
  cancel(): void;
}

/**
 * Starts a PowerPoint export in a worker. Cancelling ends the worker at once;
 * the promise then rejects with `DeckExportCancelledError`.
 */
export function startPptxExport(
  request: DeckPptxExportRequest,
  onProgress: (completed: number, total: number) => void,
): DeckPptxExportJob {
  const worker = new Worker(new URL('./exportWorker.ts', import.meta.url), { type: 'module' });
  let settled = false;
  let rejectPromise: (reason: Error) => void = () => undefined;
  const promise = new Promise<DeckPptxExportResult>((resolve, reject) => {
    rejectPromise = reject;
    worker.addEventListener('message', (event: MessageEvent<DeckPptxWorkerOutbound>) => {
      if (settled) return;
      const message = event.data;
      if (message.type === 'progress') {
        onProgress(message.completed, message.total);
        return;
      }
      settled = true;
      worker.terminate();
      if (message.type === 'complete') resolve(message.result);
      else reject(new Error(message.message));
    });
    worker.addEventListener('error', (event) => {
      if (settled) return;
      settled = true;
      worker.terminate();
      reject(new Error(event.message || 'The PowerPoint export worker failed.'));
    });
    const message: DeckPptxWorkerInbound = { type: 'run', ...request };
    worker.postMessage(message);
  });
  return {
    promise,
    cancel() {
      if (settled) return;
      settled = true;
      worker.terminate();
      rejectPromise(new DeckExportCancelledError());
    },
  };
}
