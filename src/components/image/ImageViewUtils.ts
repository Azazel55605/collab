import type {
  ImageCropRect,
  ImageLineStyle,
  ImageOverlayDocument,
  ImageOverlayItem,
  ImageTextOverlay,
  PermanentImageEdits,
} from '../../types/image';

export type Point = { x: number; y: number };
export type Dimensions = { width: number; height: number };

export const EMPTY_SIZE: Dimensions = { width: 1, height: 1 };

export function createEmptyEdits(): PermanentImageEdits {
  return {
    rotation: 0,
    crop: null,
    resizeWidth: null,
    resizeHeight: null,
    lockAspectRatio: true,
  };
}

export function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

export function fitWithin(container: Dimensions, intrinsic: Dimensions): Dimensions {
  if (container.width <= 0 || container.height <= 0 || intrinsic.width <= 0 || intrinsic.height <= 0) {
    return EMPTY_SIZE;
  }

  const scale = Math.min(container.width / intrinsic.width, container.height / intrinsic.height);
  return {
    width: Math.max(1, Math.round(intrinsic.width * scale)),
    height: Math.max(1, Math.round(intrinsic.height * scale)),
  };
}

export function scaleDimensions(dimensions: Dimensions, scale: number): Dimensions {
  return {
    width: Math.max(1, Math.round(dimensions.width * scale)),
    height: Math.max(1, Math.round(dimensions.height * scale)),
  };
}

export function getWorkspaceDimensions(viewport: Dimensions, stage: Dimensions, padding = 48): Dimensions {
  return {
    width: Math.max(stage.width + padding, viewport.width),
    height: Math.max(stage.height + padding, viewport.height),
  };
}

export function getExtension(path: string | null): string {
  if (!path) return '';
  const segment = path.split('/').pop() ?? path;
  const dotIndex = segment.lastIndexOf('.');
  return dotIndex === -1 ? '' : segment.slice(dotIndex + 1).toLowerCase();
}

export function getBaseName(path: string | null): string {
  if (!path) return 'Image';
  return path.split('/').pop() ?? path;
}

export function canOverwriteImageFormat(path: string | null): boolean {
  return ['png', 'jpg', 'jpeg', 'webp'].includes(getExtension(path));
}

export function getOutputMime(path: string | null): 'image/png' | 'image/jpeg' | 'image/webp' {
  const ext = getExtension(path);
  if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg';
  if (ext === 'webp') return 'image/webp';
  return 'image/png';
}

export function getOutputFileName(path: string | null, mime: string) {
  const fileName = getBaseName(path);
  const dotIndex = fileName.lastIndexOf('.');
  const stem = dotIndex === -1 ? fileName : fileName.slice(0, dotIndex);
  const ext = mime === 'image/jpeg' ? 'jpg' : mime === 'image/webp' ? 'webp' : 'png';
  return `${stem}-edited.${ext}`;
}

export function createEmptyOverlayDocument(dimensions: Dimensions): ImageOverlayDocument {
  return {
    version: 1,
    baseWidth: dimensions.width,
    baseHeight: dimensions.height,
    items: [],
    updatedAt: Date.now(),
  };
}

export function getTextWidth(item: ImageTextOverlay) {
  return item.width || 0.22;
}

export function getTextHeight(item: ImageTextOverlay) {
  return item.height || 0.12;
}

export function getTextMinWidth(display: Dimensions) {
  return clamp(120 / Math.max(display.width, 1), 0.12, 0.4);
}

export function getTextMinHeight(display: Dimensions) {
  return clamp(56 / Math.max(display.height, 1), 0.08, 0.3);
}

export function getRotatedDimensions(dimensions: Dimensions, rotation: PermanentImageEdits['rotation']): Dimensions {
  return rotation === 90 || rotation === 270
    ? { width: dimensions.height, height: dimensions.width }
    : dimensions;
}

export function normalizeCropRect(rect: ImageCropRect, bounds: Dimensions): ImageCropRect {
  const x = clamp(rect.x, 0, bounds.width - 1);
  const y = clamp(rect.y, 0, bounds.height - 1);
  const width = clamp(rect.width, 1, bounds.width - x);
  const height = clamp(rect.height, 1, bounds.height - y);
  return { x, y, width, height };
}

export function getCropBounds(dimensions: Dimensions, edits: PermanentImageEdits): ImageCropRect {
  const rotated = getRotatedDimensions(dimensions, edits.rotation);
  if (!edits.crop) {
    return { x: 0, y: 0, width: rotated.width, height: rotated.height };
  }
  return normalizeCropRect(edits.crop, rotated);
}

export function getPermanentPreviewDimensions(
  dimensions: Dimensions,
  edits: PermanentImageEdits,
  cropMode: boolean,
): Dimensions {
  const rotated = getRotatedDimensions(dimensions, edits.rotation);
  if (cropMode) {
    return rotated;
  }

  const crop = getCropBounds(dimensions, edits);
  return {
    width: edits.resizeWidth ?? crop.width,
    height: edits.resizeHeight ?? crop.height,
  };
}

export function getArrowHeadPoints(from: Point, to: Point, size: number) {
  const angle = Math.atan2(to.y - from.y, to.x - from.x);
  return [
    `${to.x},${to.y}`,
    `${to.x - size * Math.cos(angle - Math.PI / 6)},${to.y - size * Math.sin(angle - Math.PI / 6)}`,
    `${to.x - size * Math.cos(angle + Math.PI / 6)},${to.y - size * Math.sin(angle + Math.PI / 6)}`,
  ].join(' ');
}

export function getArrowLineEnd(from: Point, to: Point, headSize: number): Point {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const length = Math.hypot(dx, dy);
  if (length === 0) return to;
  const inset = Math.min(headSize * 0.82, length * 0.45);
  return {
    x: to.x - (dx / length) * inset,
    y: to.y - (dy / length) * inset,
  };
}

export function getLineDash(style: ImageLineStyle, strokeWidth: number): number[] | undefined {
  if (style === 'dashed') return [strokeWidth * 3, strokeWidth * 2];
  if (style === 'dotted') return [strokeWidth, strokeWidth * 1.75];
  return undefined;
}

export function getOverlaySignature(overlay: ImageOverlayDocument | null) {
  return overlay ? JSON.stringify(overlay) : '';
}

export function isPermanentDirty(edits: PermanentImageEdits) {
  return (
    edits.rotation !== 0 ||
    edits.crop !== null ||
    edits.resizeWidth !== null ||
    edits.resizeHeight !== null
  );
}

export function getRelativePoint(event: PointerEvent | React.PointerEvent, rect: DOMRect): Point {
  return {
    x: clamp((event.clientX - rect.left) / rect.width, 0, 1),
    y: clamp((event.clientY - rect.top) / rect.height, 0, 1),
  };
}

export function describeOverlayCount(count: number) {
  if (count === 0) return 'No additive annotations';
  if (count === 1) return '1 additive annotation';
  return `${count} additive annotations`;
}

export function getOverlayItemLabel(item: ImageOverlayItem, index: number) {
  if (item.type === 'text') {
    const preview = item.text.trim().split('\n')[0];
    return preview ? `Text: ${preview}` : `Text ${index + 1}`;
  }
  if (item.type === 'arrow') return `Arrow ${index + 1}`;
  return `Freehand ${index + 1}`;
}

export function getOverlayItemMeta(item: ImageOverlayItem) {
  if (item.type === 'text') return `${Math.round(item.fontSize)}px text`;
  if (item.type === 'arrow') return `${Math.round(item.strokeWidth)}px ${item.lineStyle} arrow`;
  return `${Math.round(item.strokeWidth)}px stroke, ${item.points.length} points`;
}
