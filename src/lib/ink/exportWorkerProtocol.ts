import type { InkExportResult } from './export';
import type { InkExportProgress, InkExportRuntimeRequest } from './exportRuntime';

export type InkExportWorkerInbound =
  | { type: 'run'; jobId: string; request: InkExportRuntimeRequest }
  | { type: 'cancel'; jobId: string };

export type InkExportWorkerOutbound =
  | { type: 'progress'; jobId: string; progress: InkExportProgress }
  | { type: 'complete'; jobId: string; result: InkExportResult }
  | { type: 'cancelled'; jobId: string }
  | { type: 'error'; jobId: string; message: string };
