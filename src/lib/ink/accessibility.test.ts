import { describe, expect, it } from 'vitest';

import { accessibleInkObjects, inkObjectAccessibleName } from './accessibility';
import { createInkPage } from './document';
import { FIXTURE_BRUSH } from './fixture';

describe('ink accessibility', () => {
  it('names typed and authored objects without exposing raw ids', () => {
    expect(
      inkObjectAccessibleName({
        id: 'text-opaque-id',
        type: 'text',
        layerId: 'layer-1',
        x: 0,
        y: 0,
        width: 100,
        height: 100,
        text: 'Quarterly plan',
        color: '#000',
        fontSize: 64,
      }),
    ).toBe('Text, Quarterly plan');
    expect(
      inkObjectAccessibleName({
        id: 'shape-1',
        type: 'shape',
        layerId: 'layer-1',
        shape: 'rectangle',
        points: [0, 0, 100, 100],
        stroke: FIXTURE_BRUSH,
      }),
    ).toBe('Rectangle shape');
  });

  it('keeps semantic reading order while omitting freehand and editor guides', () => {
    const page = createInkPage('page-1');
    const layerId = page.scene.layerOrder[0];
    page.scene.objects = {
      stroke: {
        id: 'stroke',
        type: 'stroke',
        layerId,
        brush: FIXTURE_BRUSH,
        samples: { x: [0], y: [0] },
      },
      text: {
        id: 'text',
        type: 'text',
        layerId,
        x: 0,
        y: 0,
        width: 100,
        height: 100,
        text: 'First',
        color: '#000',
        fontSize: 64,
      },
      guide: {
        id: 'guide',
        type: 'shape',
        layerId,
        shape: 'line',
        points: [0, 0, 100, 0],
        stroke: FIXTURE_BRUSH,
        guide: true,
      },
      stamp: {
        id: 'stamp',
        type: 'stamp',
        layerId,
        x: 0,
        y: 0,
        width: 100,
        height: 100,
        symbolId: 'check-circle',
      },
    };
    page.scene.objectOrder = ['stroke', 'text', 'guide', 'stamp'];

    expect(accessibleInkObjects(page.scene)).toEqual([
      { id: 'text', name: 'Text, First', layerName: 'Layer 1', readingOrder: 1 },
      { id: 'stamp', name: 'Stamp, check circle', layerName: 'Layer 1', readingOrder: 2 },
    ]);
  });
});
