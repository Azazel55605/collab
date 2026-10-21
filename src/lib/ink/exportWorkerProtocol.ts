import type { ExportPacket } from '../exportTransport';

import type { InkExportResult } from './export';
import type { InkExportProgress } from './exportRuntime';

export type InkExportWorkerInbound =
  | { type: 'run'; jobId: string; packet: Omit<ExportPacket, 'transfers'> }
  | { type: 'cancel'; jobId: string };

export type InkExportWorkerOutbound =
  | { type: 'progress'; jobId: string; progress: InkExportProgress }
  | { type: 'complete'; jobId: string; result: InkExportResult }
  | { type: 'cancelled'; jobId: string }
  | { type: 'error'; jobId: string; message: string };
