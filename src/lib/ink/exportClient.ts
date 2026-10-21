import { admitExport, packExport } from '../exportTransport';

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
      release();
      if (message.type === 'complete') resolve(message.result);
      else if (message.type === 'cancelled') reject(new InkExportCancelledError());
      else reject(new Error(message.message));
    });
    worker.addEventListener('error', (event) => {
      if (settled) return;
      settled = true;
      worker.terminate();
      release();
      reject(new Error(event.message || 'The ink export worker failed.'));
    });
    try {
      const { assets, ...metadata } = request;
      const packet = packExport(
        {
          ...metadata,
          assetMetadata: Object.fromEntries(
            Object.entries(assets).map(([id, asset]) => [
              id,
              { width: asset.width, height: asset.height },
            ]),
          ),
        },
        Object.fromEntries(Object.entries(assets).map(([id, asset]) => [id, asset.dataUrl])),
      );
      const message: InkExportWorkerInbound = {
        type: 'run',
        jobId,
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
      rejectPromise(new InkExportCancelledError());
    },
  };
}
