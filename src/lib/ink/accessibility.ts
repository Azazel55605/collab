import type { InkObject, InkScene } from '../../types/ink';

export interface AccessibleInkObject {
  id: string;
  name: string;
  layerName: string;
  readingOrder: number;
}

/**
 * Semantic objects in back-to-front document order.
 *
 * Freehand strokes stay on the bitmap-backed canvas: creating thousands of DOM
 * nodes for handwriting would make the accessibility layer itself a denial of
 * service. Every authored non-freehand object gets a stable, useful name and
 * participates in the reading order.
 */
export function accessibleInkObjects(scene: InkScene | null): AccessibleInkObject[] {
  if (!scene) return [];
  const result: AccessibleInkObject[] = [];
  for (const id of scene.objectOrder) {
    const object = scene.objects[id];
    if (!object || object.type === 'stroke' || (object.type === 'shape' && object.guide)) continue;
    result.push({
      id,
      name: inkObjectAccessibleName(object),
      layerName: scene.layers[object.layerId]?.name ?? 'Unknown layer',
      readingOrder: result.length + 1,
    });
  }
  return result;
}

export function inkObjectAccessibleName(object: InkObject): string {
  switch (object.type) {
    case 'stroke':
      return object.classification ? `Handwriting, ${object.classification}` : 'Freehand stroke';
    case 'shape':
      return `${capitalize(object.shape)} shape`;
    case 'connector':
      return object.label?.trim() ? `Connector, ${boundedText(object.label)}` : 'Connector';
    case 'text': {
      const kind = object.equation ? 'Equation' : object.sticky ? 'Sticky note' : 'Text';
      return object.text.trim() ? `${kind}, ${boundedText(object.text)}` : `${kind}, empty`;
    }
    case 'image': {
      const fileName = object.relativePath.split('/').pop() || object.relativePath;
      return `Image, ${fileName}`;
    }
    case 'stamp':
      return `Stamp, ${object.symbolId.split('-').join(' ')}`;
    case 'group':
      return `Group, ${object.childIds.length} objects`;
  }
}

function boundedText(value: string): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  return normalized.length > 120 ? `${normalized.slice(0, 117)}…` : normalized;
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}
