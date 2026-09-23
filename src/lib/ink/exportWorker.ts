/// <reference lib="webworker" />
import { InkExportCancelledError, renderInkExport } from './exportRuntime';
import type { InkExportWorkerInbound, InkExportWorkerOutbound } from './exportWorkerProtocol';

const cancelledJobs = new Set<string>();

function send(message: InkExportWorkerOutbound) {
  self.postMessage(message);
}

self.addEventListener('message', (event: MessageEvent<InkExportWorkerInbound>) => {
  const message = event.data;
  if (message.type === 'cancel') {
    cancelledJobs.add(message.jobId);
    return;
  }
  cancelledJobs.delete(message.jobId);
  void renderInkExport(
    message.request,
    (progress) => send({ type: 'progress', jobId: message.jobId, progress }),
    () => cancelledJobs.has(message.jobId),
  )
    .then((result) => {
      if (cancelledJobs.has(message.jobId)) {
        send({ type: 'cancelled', jobId: message.jobId });
      } else {
        send({ type: 'complete', jobId: message.jobId, result });
      }
    })
    .catch((error: unknown) => {
      if (error instanceof InkExportCancelledError || cancelledJobs.has(message.jobId)) {
        send({ type: 'cancelled', jobId: message.jobId });
      } else {
        send({ type: 'error', jobId: message.jobId, message: String(error) });
      }
    })
    .finally(() => cancelledJobs.delete(message.jobId));
});

export {};
