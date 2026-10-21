import type { DeckDocument } from '../../../types/deck';
import { admitExport, packExport } from '../../exportTransport';
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
  let release: () => void;
  try {
    release = admitExport();
  } catch (error) {
    return { promise: Promise.reject(error), cancel() {} };
  }
  let worker: Worker;
  try {
    worker = new Worker(new URL('./exportWorker.ts', import.meta.url), { type: 'module' });
  } catch (error) {
    release();
    return { promise: Promise.reject(error), cancel() {} };
  }
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
      release();
      if (message.type === 'complete') resolve(message.result);
      else reject(new Error(message.message));
    });
    worker.addEventListener('error', (event) => {
      if (settled) return;
      settled = true;
      worker.terminate();
      release();
      reject(new Error(event.message || 'The PowerPoint export worker failed.'));
    });
    try {
      const { assets, svgFallbacks, ...metadata } = request;
      const combined = {
        ...Object.fromEntries(
          Object.entries(assets).map(([key, value]) => [`asset:${key}`, value]),
        ),
        ...Object.fromEntries(
          Object.entries(svgFallbacks).map(([key, value]) => [`fallback:${key}`, value]),
        ),
      };
      const packet = packExport(metadata, combined);
      const message: DeckPptxWorkerInbound = {
        type: 'run',
        packet: { json: packet.json, assets: packet.assets },
      };
      worker.postMessage(message, packet.transfers);
    } catch (error) {
      settled = true;
      worker.terminate();
      release();
      reject(error);
    }
  });
  return {
    promise,
    cancel() {
      if (settled) return;
      settled = true;
      worker.terminate();
      release();
      rejectPromise(new DeckExportCancelledError());
    },
  };
}
