import { describe, expect, it } from 'vitest';

import type { InkScene } from '../../types/ink';

import { buildInkScene, buildStroke } from './fixture';
import { InkHistory } from './history';
import { addObject, removeObject } from './operations';

function scene(strokes = 3): InkScene {
  return buildInkScene({ strokes, samplesPerStroke: 6 });
}

describe('InkHistory', () => {
  it('undoes and redoes an edit', () => {
    const history = new InkHistory<InkScene>();
    const initial = scene();
    const stroke = buildStroke('new', 'layer-1', { samples: 4, x: 0, y: 0 });

    const edit = addObject(initial, stroke);
    history.push(edit, 'Draw');
    expect(edit.result.objects.new).toBeTruthy();

    const undone = history.undo(edit.result)!;
    expect(undone.objects.new).toBeUndefined();
    expect(undone).toEqual(initial);

    const redone = history.redo(undone)!;
    expect(redone.objects.new).toBeTruthy();
  });

  it('reports what the next undo and redo would do', () => {
    const history = new InkHistory<InkScene>();
    const initial = scene();
    expect(history.snapshot()).toMatchObject({ canUndo: false, canRedo: false, depth: 0 });

    const edit = removeObject(initial, 'stroke-1');
    history.push(edit, 'Erase');
    expect(history.snapshot()).toMatchObject({ canUndo: true, undoLabel: 'Erase', depth: 1 });

    history.undo(edit.result);
    expect(history.snapshot()).toMatchObject({ canUndo: false, canRedo: true, redoLabel: 'Erase' });
  });

  it('replays a long chain in both directions', () => {
    const history = new InkHistory<InkScene>();
    let current = scene(1);
    const checkpoints = [current];

    for (let index = 0; index < 10; index += 1) {
      const edit = addObject(
        current,
        buildStroke(`s${index}`, 'layer-1', {
          samples: 4,
          x: index * 100,
          y: 0,
        }),
      );
      history.push(edit, `Draw ${index}`);
      current = edit.result;
      checkpoints.push(current);
    }

    for (let index = 10; index > 0; index -= 1) {
      current = history.undo(current)!;
      expect(current).toEqual(checkpoints[index - 1]);
    }
    expect(history.undo(current)).toBeNull();

    for (let index = 1; index <= 10; index += 1) {
      current = history.redo(current)!;
      expect(current.objectOrder).toEqual(checkpoints[index].objectOrder);
    }
    expect(history.redo(current)).toBeNull();
  });

  it('discards the redo branch once you edit after undoing', () => {
    // Keeping it would let a redo splice unrelated work back into the drawing.
    const history = new InkHistory<InkScene>();
    const initial = scene();

    const first = addObject(initial, buildStroke('a', 'layer-1', { samples: 4, x: 0, y: 0 }));
    history.push(first, 'A');
    const undone = history.undo(first.result)!;
    expect(history.snapshot().canRedo).toBe(true);

    const second = addObject(undone, buildStroke('b', 'layer-1', { samples: 4, x: 0, y: 0 }));
    history.push(second, 'B');
    expect(history.snapshot().canRedo).toBe(false);
  });

  it('returns null rather than throwing on an empty stack', () => {
    const history = new InkHistory<InkScene>();
    expect(history.undo(scene())).toBeNull();
    expect(history.redo(scene())).toBeNull();
  });

  it('drops the oldest entry past the limit', () => {
    const history = new InkHistory<InkScene>(3);
    let current = scene(1);
    for (let index = 0; index < 5; index += 1) {
      const edit = addObject(
        current,
        buildStroke(`s${index}`, 'layer-1', {
          samples: 4,
          x: index,
          y: 0,
        }),
      );
      history.push(edit, `Draw ${index}`);
      current = edit.result;
    }
    expect(history.snapshot().depth).toBe(3);
  });

  it('clears everything when the document is replaced', () => {
    // Every inverse describes a document that no longer exists; applying one
    // would corrupt the new document rather than undo anything.
    const history = new InkHistory<InkScene>();
    const edit = addObject(scene(), buildStroke('a', 'layer-1', { samples: 4, x: 0, y: 0 }));
    history.push(edit, 'A');
    history.undo(edit.result);

    history.clear();
    expect(history.snapshot()).toMatchObject({ canUndo: false, canRedo: false, depth: 0 });
  });
});
