/// <reference lib="webworker" />
/**
 * Runs PowerPoint export off the main thread, so a large deck never freezes
 * the editor. Cancelling terminates the worker (see `exportClient.ts`).
 */
import type { DeckDocument } from '../../../types/deck';
import { createCanvasMeasurer } from '../textLayout';

import { exportDeckToPptx } from './exportDeckToPptx';
import type { DeckPptxExportResult } from './exportDeckToPptx';

export type DeckPptxWorkerInbound = {
  type: 'run';
  deck: DeckDocument;
  assets: Record<string, string>;
  svgFallbacks: Record<string, string>;
  slideIds?: string[];
  missingFonts: Record<string, string>;
};

export type DeckPptxWorkerOutbound =
  | { type: 'progress'; completed: number; total: number }
  | { type: 'complete'; result: DeckPptxExportResult }
  | { type: 'error'; message: string };

self.addEventListener('message', (event: MessageEvent<DeckPptxWorkerInbound>) => {
  const message = event.data;
  if (message.type !== 'run') return;
  const send = (out: DeckPptxWorkerOutbound, transfer: Transferable[] = []) =>
    self.postMessage(out, { transfer });
  void exportDeckToPptx(message.deck, {
    assets: message.assets,
    svgFallbacks: message.svgFallbacks,
    ...(message.slideIds ? { slideIds: message.slideIds } : {}),
    missingFonts: message.missingFonts,
    measurer: createCanvasMeasurer(),
    onProgress: (completed, total) => send({ type: 'progress', completed, total }),
  })
    .then((result) => send({ type: 'complete', result }, [result.bytes.buffer]))
    .catch((error: unknown) =>
      send({ type: 'error', message: error instanceof Error ? error.message : String(error) }),
    );
});

export {};
