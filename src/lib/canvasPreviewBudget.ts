import type { PreviewState } from '../components/canvas/CanvasPreviewUtils';

export const CANVAS_PREVIEW_BYTES = 32 * 1024 * 1024;
export const CANVAS_PREVIEW_ENTRIES = 24;
const costs = new WeakMap<PreviewState, number>();
export function previewRetainedBytes(preview: PreviewState): number {
  // Charge string storage and a conservative decoded raster surface separately.
  const cached = costs.get(preview);
  if (cached !== undefined) return cached;
  const strings = (value: unknown): number =>
    typeof value === 'string'
      ? value.length * 2
      : value && typeof value === 'object'
        ? Object.values(value).reduce<number>((sum, child) => sum + strings(child), 0)
        : 8;
  const cost = strings(preview) + (preview.imageSrc ? 640 * 480 * 4 : 0);
  costs.set(preview, cost);
  return cost;
}
export function boundedCanvasPreviews(
  values: Record<string, PreviewState>,
  allowed: ReadonlySet<string>,
) {
  let bytes = 0;
  let changed = false;
  const next: Record<string, PreviewState> = {};
  for (const [key, value] of Object.entries(values)) {
    if (!allowed.has(key)) {
      changed = true;
      continue;
    }
    const cost = previewRetainedBytes(value);
    if (bytes + cost > CANVAS_PREVIEW_BYTES) {
      next[key] = {
        loaded: true,
        loading: false,
        previewError: 'Preview memory budget reached. Move other cards out of view to retry.',
      };
      changed = true;
    } else {
      next[key] = value;
      bytes += cost;
    }
  }
  return changed ? next : values;
}
