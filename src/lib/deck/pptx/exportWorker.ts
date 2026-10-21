/// <reference lib="webworker" />
import { type ExportPacket, unpackExport } from '../../exportTransport';
/**
 * Runs PowerPoint export off the main thread, so a large deck never freezes
 * the editor. Cancelling terminates the worker (see `exportClient.ts`).
 */
import { createCanvasMeasurer } from '../textLayout';

import type { DeckPptxExportRequest } from './exportClient';
import { exportDeckToPptx } from './exportDeckToPptx';
import type { DeckPptxExportResult } from './exportDeckToPptx';

export type DeckPptxWorkerInbound = { type: 'run'; packet: Omit<ExportPacket, 'transfers'> };

export type DeckPptxWorkerOutbound =
  | { type: 'progress'; completed: number; total: number }
  | { type: 'complete'; result: DeckPptxExportResult }
  | { type: 'error'; message: string };

self.addEventListener('message', (event: MessageEvent<DeckPptxWorkerInbound>) => {
  const message = event.data;
  if (message.type !== 'run') return;
  const send = (out: DeckPptxWorkerOutbound, transfer: Transferable[] = []) =>
    self.postMessage(out, { transfer });
  const { metadata, assets: packedAssets } = unpackExport<
    Omit<DeckPptxExportRequest, 'assets' | 'svgFallbacks'>
  >(message.packet);
  const assets: Record<string, string> = {},
    svgFallbacks: Record<string, string> = {};
  for (const [key, value] of Object.entries(packedAssets)) {
    if (key.startsWith('asset:')) assets[key.slice(6)] = value;
    else if (key.startsWith('fallback:')) svgFallbacks[key.slice(9)] = value;
  }
  void exportDeckToPptx(metadata.deck, {
    assets,
    svgFallbacks,
    ...(metadata.slideIds ? { slideIds: metadata.slideIds } : {}),
    missingFonts: metadata.missingFonts,
    measurer: createCanvasMeasurer(),
    onProgress: (completed, total) => send({ type: 'progress', completed, total }),
  })
    .then((result) => send({ type: 'complete', result }, [result.bytes.buffer]))
    .catch((error: unknown) =>
      send({ type: 'error', message: error instanceof Error ? error.message : String(error) }),
    );
});

export {};
