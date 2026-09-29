import { describe, expect, it } from 'vitest';

import { DECK_UNITS_PER_POINT } from '../../types/deck';
import type { DeckDocument } from '../../types/deck';

import { buildFixtureDeck } from './fixture';
import { updateElements } from './operations';
import {
  alignSelection,
  cropImage,
  distributeSelection,
  frameCorners,
  hitTest,
  marqueeSelect,
  moveSelection,
  resizeFrame,
  resizeSelection,
  rotateSelection,
  selectionBounds,
  slideGeometry,
  snapMove,
} from './transform';
import type { ElementUpdaters, Frame } from './transform';
import { validateDeck } from './validate';

const pt = (points: number) => points * DECK_UNITS_PER_POINT;

function apply(deck: DeckDocument, slideId: string, updaters: ElementUpdaters): DeckDocument {
  const result = updateElements(deck, slideId, updaters).result;
  const check = validateDeck(result);
  expect(check.ok ? [] : check.issues).toEqual([]);
  return result;
}

const box = (x: number, y: number, width: number, height: number, rotation = 0): Frame => ({
  x,
  y,
  width,
  height,
  rotation,
  flipH: false,
  flipV: false,
});

describe('slideGeometry', () => {
  it('uses inherited placeholder frames and derives group frames from children', () => {
    const geometry = slideGeometry(buildFixtureDeck(), 'slide-3');
    // s3-title has no frame of its own; it inherits the master title frame.
    expect(geometry.frames.get('s3-title')).toMatchObject({ x: pt(48), y: pt(36) });
    expect(geometry.frames.get('s3-group')).toMatchObject({
      x: pt(500),
      y: pt(390),
      width: pt(160),
      height: pt(80),
    });
    expect(geometry.order).not.toContain('s3-badge-dot');
  });
});

describe('hit testing', () => {
  it('finds the topmost top-level element, selecting groups as a whole', () => {
    const geometry = slideGeometry(buildFixtureDeck(), 'slide-3');
    expect(hitTest(geometry, { x: pt(540), y: pt(430) })).toBe('s3-group');
    expect(hitTest(geometry, { x: pt(100), y: pt(200) })).toBe('s3-card');
    expect(hitTest(geometry, { x: pt(940), y: pt(520) })).toBeNull();
  });

  it('respects rotation and hits thin lines within slop', () => {
    const geometry = slideGeometry(buildFixtureDeck(), 'slide-3');
    const arrow = geometry.frames.get('s3-arrow')!;
    const [corner] = frameCorners(arrow);
    expect(hitTest(geometry, { x: corner.x + 5, y: corner.y + 60 })).toBe('s3-arrow');
    // A point on the dashed line, 3 pt off it.
    expect(hitTest(geometry, { x: pt(249), y: pt(370) + pt(3) }, pt(4))).toBe('s3-line');
  });

  it('marquee-selects only elements entirely inside the rectangle', () => {
    const geometry = slideGeometry(buildFixtureDeck(), 'slide-3');
    const selected = marqueeSelect(geometry, {
      minX: pt(480),
      minY: pt(120),
      maxX: pt(920),
      maxY: pt(480),
    });
    expect(selected).toEqual(['s3-image', 's3-group']);
  });
});

describe('transforms', () => {
  it('moves a selection, materializing inherited frames and moving lines and groups', () => {
    const deck = buildFixtureDeck();
    const geometry = slideGeometry(deck, 'slide-3');
    const moved = apply(
      deck,
      'slide-3',
      moveSelection(geometry, ['s3-title', 's3-line', 's3-group'], 100, 200),
    );
    const slide = moved.slides['slide-3'];
    expect(slide.elements['s3-title'].frame).toMatchObject({ x: pt(48) + 100, y: pt(36) + 200 });
    const line = slide.elements['s3-line'];
    expect(line.type === 'line' && line.from).toEqual({ x: pt(48) + 100, y: pt(320) + 200 });
    expect(slide.elements['s3-badge-dot'].frame).toMatchObject({
      x: pt(520) + 100,
      y: pt(410) + 200,
    });
    expect(slide.elements['s3-group'].frame).toMatchObject({ x: pt(500) + 100, y: pt(390) + 200 });
  });

  it('resizes an unrotated frame from each handle, keeping the opposite edge', () => {
    const frame = box(1_000, 1_000, 2_000, 1_000);
    expect(resizeFrame(frame, 'e', { x: 500, y: 999 }, false)).toMatchObject({
      x: 1_000,
      width: 2_500,
      height: 1_000,
    });
    expect(resizeFrame(frame, 'nw', { x: 200, y: 100 }, false)).toMatchObject({
      x: 1_200,
      y: 1_100,
      width: 1_800,
      height: 900,
    });
    expect(resizeFrame(frame, 'se', { x: 2_000, y: 0 }, true)).toMatchObject({
      width: 4_000,
      height: 2_000,
    });
    expect(resizeFrame(frame, 'w', { x: 5_000, y: 0 }, false).width).toBe(DECK_UNITS_PER_POINT);
  });

  it('resizes a rotated frame along its own axes', () => {
    const frame = box(0, 0, 2_000, 1_000, 9_000); // 90°: local x points down
    const next = resizeFrame(frame, 'e', { x: 0, y: 400 }, false);
    expect(next.width).toBeCloseTo(2_400, 6);
    expect(next.height).toBe(1_000);
    // The west edge's centre stays put on screen.
    const west = (candidate: Frame) => {
      const corners = frameCorners(candidate);
      return { x: (corners[0].x + corners[3].x) / 2, y: (corners[0].y + corners[3].y) / 2 };
    };
    expect(west(next).x).toBeCloseTo(west(frame).x, 6);
    expect(west(next).y).toBeCloseTo(west(frame).y, 6);
  });

  it('scales a multi-element selection about its bounds', () => {
    const deck = buildFixtureDeck();
    const geometry = slideGeometry(deck, 'slide-3');
    const before = selectionBounds(geometry, ['s3-card', 's3-group'])!;
    const resized = apply(
      deck,
      'slide-3',
      resizeSelection(geometry, ['s3-card', 's3-group'], 'se', { x: pt(100), y: 0 }, false),
    );
    const after = selectionBounds(slideGeometry(resized, 'slide-3'), ['s3-card', 's3-group'])!;
    expect(after.minX).toBeCloseTo(before.minX, -1);
    expect(after.maxX - after.minX).toBeCloseTo(before.maxX - before.minX + pt(100), -1);
  });

  it('rotates about the selection centre and keeps the rotation normalized', () => {
    const deck = buildFixtureDeck();
    const geometry = slideGeometry(deck, 'slide-3');
    const rotated = apply(deck, 'slide-3', rotateSelection(geometry, ['s3-arrow'], 34_500));
    // 15° + 345° = 360° → 0, stored as no rotation at all.
    expect(rotated.slides['slide-3'].elements['s3-arrow'].frame?.rotation).toBeUndefined();
  });
});

describe('snapping', () => {
  it('snaps a moving element to the slide centre and reports the guide', () => {
    const deck = buildFixtureDeck();
    const geometry = slideGeometry(deck, 'slide-5');
    const note = selectionBounds(geometry, ['s5-note'])!;
    const centreOffset = deck.size.width / 2 - (note.minX + note.maxX) / 2;
    const result = snapMove(geometry, ['s5-note'], centreOffset + 40, 0, 100);
    expect(result.dx).toBe(Math.round(centreOffset));
    expect(result.guides).toContainEqual({ axis: 'x', at: deck.size.width / 2 });
  });

  it('leaves the move alone beyond the threshold, or snaps to the grid', () => {
    const geometry = slideGeometry(buildFixtureDeck(), 'slide-5');
    expect(snapMove(geometry, ['s5-note'], 7, 3, 0)).toEqual({ dx: 7, dy: 3, guides: [] });
    const gridded = snapMove(geometry, ['s5-note'], 7, 3, 0, 1_000);
    const bounds = selectionBounds(geometry, ['s5-note'])!;
    expect((bounds.minX + gridded.dx) % 1_000).toBe(0);
  });
});

describe('align and distribute', () => {
  it('aligns a selection to its bounds and a single element to the slide', () => {
    const deck = buildFixtureDeck();
    const geometry = slideGeometry(deck, 'slide-3');
    const aligned = apply(
      deck,
      'slide-3',
      alignSelection(geometry, ['s3-card', 's3-image'], 'top'),
    );
    const next = slideGeometry(aligned, 'slide-3');
    expect(selectionBounds(next, ['s3-card'])!.minY).toBeCloseTo(
      selectionBounds(next, ['s3-image'])!.minY,
      0,
    );

    const centred = apply(deck, 'slide-3', alignSelection(geometry, ['s3-card'], 'center'));
    const bounds = selectionBounds(slideGeometry(centred, 'slide-3'), ['s3-card'])!;
    expect((bounds.minX + bounds.maxX) / 2).toBeCloseTo(deck.size.width / 2, 0);
  });

  it('distributes three or more elements with equal gaps', () => {
    const deck = buildFixtureDeck();
    const geometry = slideGeometry(deck, 'slide-3');
    const ids = ['s3-card', 's3-arrow', 's3-image'];
    const spread = apply(deck, 'slide-3', distributeSelection(geometry, ids, 'horizontal'));
    const next = slideGeometry(spread, 'slide-3');
    const sorted = ids.map((id) => selectionBounds(next, [id])!).sort((a, b) => a.minX - b.minX);
    const gap1 = sorted[1].minX - sorted[0].maxX;
    const gap2 = sorted[2].minX - sorted[1].maxX;
    expect(Math.abs(gap1 - gap2)).toBeLessThanOrEqual(2);
    expect(distributeSelection(geometry, ids.slice(0, 2), 'horizontal')).toEqual({});
  });
});

describe('cropImage', () => {
  it('hides part of the image and moves that edge, keeping the image scale', () => {
    const deck = buildFixtureDeck();
    const geometry = slideGeometry(deck, 'slide-3');
    // s3-image: 400 pt wide, uncropped horizontally. Drag the east edge 100 pt in.
    const cropped = apply(
      deck,
      'slide-3',
      cropImage(geometry, 's3-image', 'e', { x: -pt(100), y: 0 }),
    );
    const image = cropped.slides['slide-3'].elements['s3-image'];
    if (image.type !== 'image') throw new Error('fixture changed');
    expect(image.frame).toMatchObject({ x: pt(500), width: pt(300) });
    expect(image.crop).toMatchObject({ right: 250, left: 0 });
  });

  it('reveals no more than the image has', () => {
    const deck = buildFixtureDeck();
    const geometry = slideGeometry(deck, 'slide-3');
    // 5% is cropped from the top; dragging far outward reveals exactly that.
    const revealed = apply(
      deck,
      'slide-3',
      cropImage(geometry, 's3-image', 'n', { x: 0, y: -pt(500) }),
    );
    const image = revealed.slides['slide-3'].elements['s3-image'];
    if (image.type !== 'image') throw new Error('fixture changed');
    expect(image.crop?.top).toBe(0);
    // 225 pt shows 90% of a 250 pt image; revealing the 5% top adds 12.5 pt.
    expect(image.frame!.height).toBe(pt(237.5));
    expect(image.frame!.y).toBe(pt(127.5));
  });

  it('removes the crop entirely once nothing is hidden', () => {
    const deck = buildFixtureDeck();
    const image = deck.slides['slide-3'].elements['s3-image'];
    if (image.type !== 'image') throw new Error('fixture changed');
    image.crop = { left: 0, top: 50, right: 0, bottom: 0 };
    const geometry = slideGeometry(deck, 'slide-3');
    const result = apply(
      deck,
      'slide-3',
      cropImage(geometry, 's3-image', 'n', { x: 0, y: -pt(500) }),
    );
    expect(
      result.slides['slide-3'].elements['s3-image'].type === 'image' &&
        (result.slides['slide-3'].elements['s3-image'] as { crop?: unknown }).crop,
    ).toBeUndefined();
  });
});
