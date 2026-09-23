import type { InkExportResult } from './export';
import { InkExportCancelledError } from './exportRuntime';
import type { InkExportProgress, InkExportRuntimeRequest } from './exportRuntime';
import type { InkExportWorkerInbound, InkExportWorkerOutbound } from './exportWorkerProtocol';

export interface InkExportJob {
  promise: Promise<InkExportResult>;
  cancel(): void;
}

export function startInkExport(
  request: InkExportRuntimeRequest,
  onProgress: (progress: InkExportProgress) => void,
): InkExportJob {
  const worker = new Worker(new URL('./exportWorker.ts', import.meta.url), { type: 'module' });
  const jobId = crypto.randomUUID();
  let settled = false;
  let rejectPromise: (reason: Error) => void = () => undefined;
  const promise = new Promise<InkExportResult>((resolve, reject) => {
    rejectPromise = reject;
    worker.addEventListener('message', (event: MessageEvent<InkExportWorkerOutbound>) => {
      if (settled) return;
      const message = event.data;
      if (message.jobId !== jobId) return;
      if (message.type === 'progress') {
        onProgress(message.progress);
        return;
      }
      settled = true;
      worker.terminate();
      if (message.type === 'complete') resolve(message.result);
      else if (message.type === 'cancelled') reject(new InkExportCancelledError());
      else reject(new Error(message.message));
    });
    worker.addEventListener('error', (event) => {
      if (settled) return;
      settled = true;
      worker.terminate();
      reject(new Error(event.message || 'The ink export worker failed.'));
    });
    const message: InkExportWorkerInbound = { type: 'run', jobId, request };
    worker.postMessage(message);
  });
  return {
    promise,
    cancel() {
      if (settled) return;
      settled = true;
      worker.terminate();
      rejectPromise(new InkExportCancelledError());
    },
  };
}
