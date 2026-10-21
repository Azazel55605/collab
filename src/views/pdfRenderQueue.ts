import { registerMediaCleanup } from '../lib/mediaLifecycle';
import { type PreviewPriority, PreviewScheduler } from '../lib/previewScheduler';

const queue = new PreviewScheduler(1, 64);
let sequence = 0;
/** One PDF raster at a time; abandoned zoom/page jobs leave the queue immediately. */
export function enqueuePdfRender<T>(
  job: () => Promise<T>,
  options: { signal?: AbortSignal; priority?: PreviewPriority } = {},
): Promise<T> {
  return queue.run(`pdf-render:${sequence++}`, job, options);
}

registerMediaCleanup(() => queue.clear());
