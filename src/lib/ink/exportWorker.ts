/// <reference lib="webworker" />
import { unpackExport } from '../exportTransport';

import type { InkExportRuntimeRequest } from './exportRuntime';
import { InkExportCancelledError, renderInkExport } from './exportRuntime';
import type { InkExportWorkerInbound, InkExportWorkerOutbound } from './exportWorkerProtocol';

const cancelledJobs = new Set<string>();

function send(message: InkExportWorkerOutbound) {
  self.postMessage(message, {
    transfer:
      message.type === 'complete' && message.result.bytes
        ? [message.result.bytes.buffer as ArrayBuffer]
        : [],
  });
}

self.addEventListener('message', (event: MessageEvent<InkExportWorkerInbound>) => {
  const message = event.data;
  if (message.type === 'cancel') {
    cancelledJobs.add(message.jobId);
    return;
  }
  const jobId = message.jobId;
  const { metadata, assets } = unpackExport<
    Omit<InkExportRuntimeRequest, 'assets'> & {
      assetMetadata: Record<string, { width: number; height: number }>;
    }
  >(message.packet);
  const request: InkExportRuntimeRequest = {
    ...metadata,
    assets: Object.fromEntries(
      Object.entries(assets).map(([id, dataUrl]) => [
        id,
        { dataUrl, ...metadata.assetMetadata[id] },
      ]),
    ),
    binaryOutput: true,
  };
  cancelledJobs.delete(jobId);
  void renderInkExport(
    request,
    (progress) => send({ type: 'progress', jobId: jobId, progress }),
    () => cancelledJobs.has(jobId),
  )
    .then((result) => {
      if (cancelledJobs.has(jobId)) {
        send({ type: 'cancelled', jobId: jobId });
      } else {
        send({ type: 'complete', jobId: jobId, result });
      }
    })
    .catch((error: unknown) => {
      if (error instanceof InkExportCancelledError || cancelledJobs.has(jobId)) {
        send({ type: 'cancelled', jobId: jobId });
      } else {
        send({ type: 'error', jobId: jobId, message: String(error) });
      }
    })
    .finally(() => cancelledJobs.delete(jobId));
});

export {};
