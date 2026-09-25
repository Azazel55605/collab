import { describe, expect, it } from 'vitest';

import {
  ANCHORED_ANNOTATION_CAPABILITIES,
  imageAnnotationSurface,
  migrateImageAnnotations,
} from './viewAnnotations';

describe('anchored view annotations', () => {
  it('migrates every image-overlay v1 object into the shared ink scene', () => {
    const result = migrateImageAnnotations(
      {
        version: 1,
        baseWidth: 100,
        baseHeight: 50,
        updatedAt: 1,
        items: [
          {
            id: 'pen',
            type: 'pen',
            points: [
              { x: 0.1, y: 0.2 },
              { x: 0.9, y: 0.8 },
            ],
            color: '#123456',
            strokeWidth: 3,
          },
          {
            id: 'arrow',
            type: 'arrow',
            start: { x: 0.2, y: 0.3 },
            end: { x: 0.7, y: 0.6 },
            color: '#abcdef',
            strokeWidth: 2,
            lineStyle: 'dashed',
          },
          {
            id: 'text',
            type: 'text',
            x: 0.1,
            y: 0.1,
            width: 0.4,
            height: 0.2,
            text: 'Review this',
            color: '#ffffff',
            fontSize: 18,
          },
        ],
      },
      'Pictures/demo.png',
      100,
      50,
    );

    const surface = imageAnnotationSurface(result.document)!;
    expect(result.migrated).toBe(true);
    expect(surface.scene.objectOrder).toEqual(['pen', 'arrow', 'text']);
    expect(surface.scene.objects.pen.type).toBe('stroke');
    expect(surface.scene.objects.arrow).toMatchObject({ type: 'shape', arrowEnd: 'arrow' });
    expect(surface.scene.objects.text).toMatchObject({ type: 'text', text: 'Review this' });
  });

  it('repairs invalid sidecars into an empty bounded image surface', () => {
    const result = migrateImageAnnotations({ broken: true }, 'image.png', 320, 180);
    const surface = imageAnnotationSurface(result.document)!;

    expect(result.warnings).toHaveLength(1);
    expect(surface.anchor).toEqual({ kind: 'image', width: 320, height: 180 });
    expect(surface.scene.objectOrder).toEqual([]);
  });

  it('requires explicit capability registration for deck review', () => {
    expect(ANCHORED_ANNOTATION_CAPABILITIES.deckReview).toMatchObject({
      anchorKind: 'deck-slide',
      capability: 'view.annotate',
    });
    expect(ANCHORED_ANNOTATION_CAPABILITIES.deckReview.surfaceId('slide-4')).toBe(
      'deck-slide-slide-4',
    );
  });
});
