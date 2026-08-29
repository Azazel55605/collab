import { describe, expect, it } from 'vitest';

import { INK_LIMITS } from '../../types/ink';
import type { InkScene } from '../../types/ink';

import {
  copySelection,
  duplicateSelection,
  INK_PASTE_OFFSET,
  isInkClipboard,
  pasteClipboard,
} from './clipboard';
import { buildInkScene } from './fixture';
import { addLayer, boundsOf, groupObjects } from './operations';
import { objectBounds } from './svg';

function scene(strokes = 3): InkScene {
  return buildInkScene({ strokes, samplesPerStroke: 8 });
}

const makeId = (original: string, index: number) => `copy-${index}-${original}`;

describe('copySelection', () => {
  it('captures the selected objects and their origin', () => {
    const source = scene();
    const clipboard = copySelection(source, ['stroke-1', 'stroke-2'])!;
    expect(clipboard.objects).toHaveLength(2);
    expect(clipboard.originX).toBe(boundsOf(source, ['stroke-1', 'stroke-2'])!.minX);
  });

  it('flattens groups to their members', () => {
    const grouped = groupObjects(scene(4), ['stroke-1', 'stroke-2'], 'g1').result;
    const clipboard = copySelection(grouped, ['g1'])!;
    expect(clipboard.objects.map((object) => object.id)).toEqual(['stroke-1', 'stroke-2']);
    expect(clipboard.objects.some((object) => object.type === 'group')).toBe(false);
  });

  it('is null for an empty selection', () => {
    expect(copySelection(scene(), [])).toBeNull();
    expect(copySelection(scene(), ['ghost'])).toBeNull();
  });
});

describe('isInkClipboard', () => {
  it('accepts a payload and rejects anything else', () => {
    expect(isInkClipboard(copySelection(scene(), ['stroke-1']))).toBe(true);
    expect(isInkClipboard({ kind: 'something-else', objects: [] })).toBe(false);
    expect(isInkClipboard(null)).toBe(false);
    expect(isInkClipboard('text')).toBe(false);
  });
});

describe('pasteClipboard', () => {
  it('pastes with new ids so nothing collides', () => {
    // Two copies sharing an id are indistinguishable to the index and the CRDT.
    const source = scene();
    const clipboard = copySelection(source, ['stroke-1'])!;
    const edit = pasteClipboard(source, clipboard, { layerId: 'layer-1', makeId });

    expect(edit.pastedIds).toEqual(['copy-0-stroke-1']);
    expect(edit.result.objects['stroke-1']).toBeTruthy();
    expect(edit.result.objects['copy-0-stroke-1']).toBeTruthy();
  });

  it('offsets the copy so it is not hidden under the original', () => {
    const source = scene();
    const clipboard = copySelection(source, ['stroke-1'])!;
    const result = pasteClipboard(source, clipboard, { layerId: 'layer-1', makeId }).result;

    const before = objectBounds(source.objects['stroke-1'])!;
    const after = objectBounds(result.objects['copy-0-stroke-1'])!;
    expect(after.minX - before.minX).toBeCloseTo(INK_PASTE_OFFSET, 0);
  });

  it('pastes at an explicit position when given one', () => {
    const source = scene();
    const clipboard = copySelection(source, ['stroke-1'])!;
    const result = pasteClipboard(source, clipboard, {
      layerId: 'layer-1',
      makeId,
      x: 50_000,
      y: 60_000,
    }).result;
    expect(objectBounds(result.objects['copy-0-stroke-1'])!.minX).toBeCloseTo(50_000, 0);
  });

  it('lands on the current layer, not the one it was copied from', () => {
    // Recreating the source's layers would multiply them on every paste, and
    // pasting into a drawing whose layers changed must not fail.
    const source = addLayer(scene(), {
      id: 'layer-2',
      name: 'Two',
      visible: true,
      locked: false,
      opacity: 1,
    }).result;
    const clipboard = copySelection(source, ['stroke-1'])!;
    const result = pasteClipboard(source, clipboard, { layerId: 'layer-2', makeId }).result;
    expect(result.objects['copy-0-stroke-1'].layerId).toBe('layer-2');
  });

  it('is reversible', () => {
    const source = scene();
    const clipboard = copySelection(source, ['stroke-1', 'stroke-2'])!;
    const edit = pasteClipboard(source, clipboard, { layerId: 'layer-1', makeId });
    expect(edit.inverse(edit.result).result).toEqual(source);
  });

  it('refuses a layer that does not exist', () => {
    const source = scene();
    const clipboard = copySelection(source, ['stroke-1'])!;
    expect(() => pasteClipboard(source, clipboard, { layerId: 'ghost', makeId })).toThrow(
      /no layer/,
    );
  });

  it('refuses rather than truncating when the page cannot hold the paste', () => {
    // A paste that silently dropped half a selection is worse than one that
    // says no.
    const source = scene(1);
    const clipboard = copySelection(source, ['stroke-1'])!;
    const many = {
      ...clipboard,
      objects: Array.from({ length: INK_LIMITS.objectsPerPage + 1 }, (_, index) => ({
        ...clipboard.objects[0],
        id: `bulk-${index}`,
      })),
    };
    expect(() => pasteClipboard(source, many, { layerId: 'layer-1', makeId })).toThrow(/limit/);
  });
});

describe('duplicateSelection', () => {
  it('copies and pastes in one step', () => {
    const source = scene();
    const edit = duplicateSelection(source, ['stroke-1'], 'layer-1', makeId)!;
    expect(edit.pastedIds).toHaveLength(1);
    expect(edit.result.objectOrder).toHaveLength(source.objectOrder.length + 1);
    expect(edit.inverse(edit.result).result).toEqual(source);
  });

  it('is null when nothing is selected', () => {
    expect(duplicateSelection(scene(), [], 'layer-1', makeId)).toBeNull();
  });
});
