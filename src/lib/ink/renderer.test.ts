import { describe, expect, it } from 'vitest';

import type { InkPage, InkScene } from '../../types/ink';

import { INK_COLOR_TOKENS, INK_DARK_PALETTE } from './colors';
import { createInkPage, strokeOf } from './document';
import { buildInkScene } from './fixture';
import { InkTileRenderer, paintPageBackground, paintScene } from './renderer';
import type { InkRenderTarget, InkTileSurfaceFactory } from './renderer';
import { outlineStrokeWithPerfectFreehand } from './strokeAdapters';
import { INK_TILE_SIZE } from './tiles';

/**
 * Records what would be drawn.
 *
 * jsdom has no canvas, so a recording target is the only way to verify the
 * paint path at all — and it verifies the thing that actually matters, which is
 * which objects were drawn and with what style, not the pixels.
 */
class RecordingTarget implements InkRenderTarget {
  fills = 0;
  strokes = 0;
  texts: string[] = [];
  rects = 0;
  colors: string[] = [];
  alphas: number[] = [];
  dashes: number[][] = [];
  fillStyle = '';
  strokeStyle = '';
  lineWidth = 1;
  globalAlpha = 1;
  font = '';
  private depth = 0;
  maxDepth = 0;

  save(): void {
    this.depth += 1;
    this.maxDepth = Math.max(this.maxDepth, this.depth);
  }
  restore(): void {
    this.depth -= 1;
  }
  get balanced(): boolean {
    return this.depth === 0;
  }
  setTransform(): void {}
  translate(): void {}
  scale(): void {}
  rotate(): void {}
  clearRect(): void {}
  fillRect(): void {
    this.rects += 1;
  }
  beginPath(): void {}
  moveTo(): void {}
  lineTo(): void {}
  closePath(): void {}
  fill(): void {
    this.fills += 1;
    this.colors.push(this.fillStyle);
    this.alphas.push(this.globalAlpha);
  }
  stroke(): void {
    this.strokes += 1;
  }
  fillText(text: string): void {
    this.texts.push(text);
  }
  setLineDash(segments: number[]): void {
    this.dashes.push(segments);
  }
}

const wholePage = { minX: -1e9, minY: -1e9, maxX: 1e9, maxY: 1e9 };

describe('paintScene', () => {
  it('resolves semantic and legacy default ink through the render palette', () => {
    const scene = buildInkScene({ strokes: 2, samplesPerStroke: 6 });
    const first = strokeOf(scene, 'stroke-1');
    const second = strokeOf(scene, 'stroke-2');
    if (first)
      scene.objects[first.id] = {
        ...first,
        brush: { ...first.brush, color: INK_COLOR_TOKENS.foreground },
      };
    if (second)
      scene.objects[second.id] = { ...second, brush: { ...second.brush, color: '#1f2933' } };
    const target = new RecordingTarget();
    paintScene(target, scene, wholePage, { colors: INK_DARK_PALETTE });
    expect(target.colors).toEqual([INK_DARK_PALETTE.foreground, INK_DARK_PALETTE.foreground]);
  });

  it('paints every stroke in the region', () => {
    const scene = buildInkScene({ strokes: 5, samplesPerStroke: 10 });
    const target = new RecordingTarget();
    expect(paintScene(target, scene, wholePage)).toBe(5);
    expect(target.fills).toBe(5);
  });

  it('skips objects whose bounds miss the region', () => {
    // This check is what makes a tile repaint cost a tile's worth of work
    // rather than a page's.
    const scene = buildInkScene({ strokes: 40, samplesPerStroke: 10 });
    const target = new RecordingTarget();
    const painted = paintScene(target, scene, {
      minX: 0,
      minY: 0,
      maxX: INK_TILE_SIZE,
      maxY: INK_TILE_SIZE,
    });
    expect(painted).toBeGreaterThan(0);
    expect(painted).toBeLessThan(40);
  });

  it('paints in objectOrder, not key order', () => {
    const scene = buildInkScene({ strokes: 3, samplesPerStroke: 6 });
    const recolor = (id: string, color: string): void => {
      const stroke = strokeOf(scene, id);
      if (stroke) scene.objects[id] = { ...stroke, brush: { ...stroke.brush, color } };
    };
    recolor('stroke-1', '#aaaaaa');
    recolor('stroke-3', '#cccccc');
    scene.objectOrder = ['stroke-3', 'stroke-2', 'stroke-1'];

    const target = new RecordingTarget();
    paintScene(target, scene, wholePage);
    expect(target.colors[0]).toBe('#cccccc');
    expect(target.colors[2]).toBe('#aaaaaa');
  });

  it('skips hidden layers but can be told not to', () => {
    const scene = buildInkScene({ strokes: 4, samplesPerStroke: 6, layers: 2 });
    scene.layers['layer-1'].visible = false;

    const hidden = new RecordingTarget();
    const visible = new RecordingTarget();
    const hiddenCount = paintScene(hidden, scene, wholePage);
    const allCount = paintScene(visible, scene, wholePage, { respectVisibility: false });
    expect(hiddenCount).toBeLessThan(allCount);
  });

  it('excludes non-exported layers unless asked for them', () => {
    const scene = buildInkScene({ strokes: 4, samplesPerStroke: 6, layers: 2 });
    scene.layers['layer-2'].exported = false;

    const screen = new RecordingTarget();
    const exported = new RecordingTarget();
    paintScene(screen, scene, wholePage, { includeNonExported: true });
    paintScene(exported, scene, wholePage);
    expect(exported.fills).toBeLessThan(screen.fills);
  });

  it('applies layer opacity and restores the state afterwards', () => {
    const scene = buildInkScene({ strokes: 2, samplesPerStroke: 6 });
    scene.layers['layer-1'].opacity = 0.5;
    const target = new RecordingTarget();
    paintScene(target, scene, wholePage);
    expect(target.balanced).toBe(true);
  });

  it('restricts painting to the requested objects', () => {
    const scene = buildInkScene({ strokes: 5, samplesPerStroke: 6 });
    const target = new RecordingTarget();
    expect(paintScene(target, scene, wholePage, { objectIds: ['stroke-2'] })).toBe(1);
  });

  it('paints text objects', () => {
    const scene = buildInkScene({ strokes: 1, samplesPerStroke: 4 });
    scene.objects.t = {
      id: 't',
      type: 'text',
      layerId: 'layer-1',
      x: 0,
      y: 0,
      width: 100,
      height: 40,
      text: 'hello',
      color: '#000',
      fontSize: 96,
    };
    scene.objectOrder.push('t');
    const target = new RecordingTarget();
    paintScene(target, scene, wholePage);
    expect(target.texts).toEqual(['hello']);
  });

  it('paints styled shapes, connector arrowheads, and sticky backgrounds', () => {
    const scene = buildInkScene({ strokes: 0 });
    scene.objects.shape = {
      id: 'shape',
      type: 'shape',
      layerId: 'layer-1',
      shape: 'rectangle',
      points: [0, 0, 1_000, 0, 1_000, 500, 0, 500],
      stroke: {
        kind: 'technical',
        color: '#123',
        opacity: 1,
        width: 64,
        thinning: 0,
        smoothing: 0,
        streamline: 0,
        taperStart: 0,
        taperEnd: 0,
        dash: 'dashed',
      },
      fill: '#fff',
      fillOpacity: 0.5,
    };
    scene.objects.connector = {
      id: 'connector',
      type: 'connector',
      layerId: 'layer-1',
      from: { x: 0, y: 0 },
      to: { x: 1_000, y: 1_000 },
      routing: 'straight',
      stroke: {
        kind: 'technical',
        color: '#123',
        opacity: 1,
        width: 64,
        thinning: 0,
        smoothing: 0,
        streamline: 0,
        taperStart: 0,
        taperEnd: 0,
      },
      arrowEnd: 'arrow',
    };
    scene.objects.sticky = {
      id: 'sticky',
      type: 'text',
      layerId: 'layer-1',
      x: 0,
      y: 0,
      width: 1_000,
      height: 800,
      text: 'remember',
      color: '#000',
      fontSize: 96,
      sticky: true,
      backgroundColor: '#ff0',
    };
    scene.objectOrder.push('shape', 'connector', 'sticky');

    const target = new RecordingTarget();
    expect(paintScene(target, scene, wholePage)).toBe(3);
    expect(target.strokes).toBeGreaterThanOrEqual(2);
    expect(target.fills).toBeGreaterThanOrEqual(2);
    expect(target.rects).toBe(1);
    expect(target.texts).toContain('remember');
    expect(target.dashes).toContainEqual([256, 192]);
  });

  it('skips an id in objectOrder with no object', () => {
    const scene = buildInkScene({ strokes: 2, samplesPerStroke: 6 });
    scene.objectOrder.push('ghost');
    expect(() => paintScene(new RecordingTarget(), scene, wholePage)).not.toThrow();
  });

  it('paints through whichever outliner is installed', () => {
    const scene = buildInkScene({ strokes: 3, samplesPerStroke: 8 });
    const target = new RecordingTarget();
    paintScene(target, scene, wholePage, { outliner: outlineStrokeWithPerfectFreehand });
    expect(target.fills).toBe(3);
  });
});

describe('paintPageBackground', () => {
  const region = { minX: 0, minY: 0, maxX: 10_000, maxY: 10_000 };

  it('draws nothing for a blank page with no colour', () => {
    const page = createInkPage('p', { background: { pattern: 'blank' } });
    const target = new RecordingTarget();
    paintPageBackground(target, page, region);
    expect(target.strokes).toBe(0);
    expect(target.rects).toBe(0);
  });

  it('draws horizontal lines for ruled and both axes for grid', () => {
    const ruled = new RecordingTarget();
    const grid = new RecordingTarget();
    paintPageBackground(
      ruled,
      createInkPage('p', { background: { pattern: 'ruled', spacing: 1_000 } }),
      region,
    );
    paintPageBackground(
      grid,
      createInkPage('p', { background: { pattern: 'grid', spacing: 1_000 } }),
      region,
    );
    expect(ruled.strokes).toBeGreaterThan(0);
    expect(grid.strokes).toBeGreaterThan(ruled.strokes);
  });

  it('draws dots for a dotted page', () => {
    const target = new RecordingTarget();
    paintPageBackground(
      target,
      createInkPage('p', { background: { pattern: 'dotted', spacing: 1_000 } }),
      region,
    );
    expect(target.rects).toBeGreaterThan(50);
  });

  it('draws music staffs and storyboard frames', () => {
    const staff = new RecordingTarget();
    const storyboard = new RecordingTarget();
    paintPageBackground(
      staff,
      createInkPage('p', { background: { pattern: 'staff', spacing: 1_000 } }),
      region,
    );
    paintPageBackground(
      storyboard,
      createInkPage('p', { background: { pattern: 'storyboard', spacing: 1_000 } }),
      region,
    );
    expect(staff.strokes).toBeGreaterThan(5);
    expect(storyboard.strokes).toBeGreaterThan(1);
  });

  it('terminates on a zero spacing rather than looping forever', () => {
    const target = new RecordingTarget();
    expect(() =>
      paintPageBackground(
        target,
        createInkPage('p', { background: { pattern: 'grid', spacing: 0 } }),
        region,
      ),
    ).not.toThrow();
  });
});

/* ------------------------------------------------------------------------- */

interface FakeSurface {
  id: number;
  pixelSize: number;
  target: RecordingTarget;
}

function makeFactory(): InkTileSurfaceFactory<FakeSurface> & {
  created: number;
  disposed: number;
} {
  let nextId = 0;
  const factory = {
    created: 0,
    disposed: 0,
    create(pixelSize: number) {
      factory.created += 1;
      const target = new RecordingTarget();
      return { surface: { id: (nextId += 1), pixelSize, target }, target };
    },
    dispose() {
      factory.disposed += 1;
    },
  };
  return factory;
}

describe('InkTileRenderer', () => {
  const viewport = { x: 0, y: 0, width: INK_TILE_SIZE, height: INK_TILE_SIZE, zoom: 1 };

  function denseScene(): InkScene {
    return buildInkScene({ strokes: 200, samplesPerStroke: 10 });
  }

  it('paints a tile once and serves it from cache afterwards', () => {
    // The whole point of the cache: Phase 0 measured a viewport repaint at 31 ms
    // against 2.5 ms for one tile.
    const factory = makeFactory();
    const renderer = new InkTileRenderer(factory);
    const scene = denseScene();

    const first = renderer.renderViewport(scene, viewport);
    expect(first.every((tile) => tile.repainted)).toBe(true);
    const created = factory.created;

    const second = renderer.renderViewport(scene, viewport);
    expect(second.every((tile) => tile.repainted)).toBe(false);
    expect(factory.created).toBe(created);
  });

  it('repaints only the tiles an edit invalidated', () => {
    const factory = makeFactory();
    const renderer = new InkTileRenderer(factory);
    const scene = denseScene();
    renderer.renderViewport(scene, viewport);

    renderer.invalidateBounds({ minX: 0, minY: 0, maxX: 100, maxY: 100 });
    const repainted = renderer.renderViewport(scene, viewport).filter((tile) => tile.repainted);
    expect(repainted).toHaveLength(1);
    expect(repainted[0].key).toEqual({ col: 0, row: 0 });
  });

  it('invalidates both the region an object left and the one it entered', () => {
    // Forgetting the vacated region is what leaves a ghost of the object behind.
    const factory = makeFactory();
    const renderer = new InkTileRenderer(factory);
    const scene = denseScene();
    renderer.renderViewport(scene, viewport);

    renderer.invalidateMoved(
      { minX: 0, minY: 0, maxX: 100, maxY: 100 },
      { minX: INK_TILE_SIZE, minY: 0, maxX: INK_TILE_SIZE + 100, maxY: 100 },
    );
    const repainted = renderer.renderViewport(scene, viewport).filter((tile) => tile.repainted);
    expect(repainted.map((tile) => tile.key)).toEqual(
      expect.arrayContaining([
        { col: 0, row: 0 },
        { col: 1, row: 0 },
      ]),
    );
  });

  it('repaints when the zoom changes the tile resolution', () => {
    // A tile cached at another zoom is the wrong resolution; scaling it up
    // would show visibly soft ink after a pinch.
    const factory = makeFactory();
    const renderer = new InkTileRenderer(factory);
    const scene = denseScene();
    renderer.renderViewport(scene, viewport);

    const zoomed = renderer.renderViewport(scene, { ...viewport, zoom: 4 });
    expect(zoomed.every((tile) => tile.repainted)).toBe(true);
  });

  it('evicts under budget but never a visible tile', () => {
    const factory = makeFactory();
    // A budget too small for even one tile, so eviction has to run and has to
    // still leave the visible tiles alone.
    const renderer = new InkTileRenderer(factory, { budgetBytes: 1 });
    const scene = denseScene();

    const tiles = renderer.renderViewport(scene, viewport);
    expect(renderer.cachedTileCount).toBe(tiles.length);
    expect(factory.disposed).toBe(0);
  });

  it('evicts the least recently used tile once the viewport moves on', () => {
    const factory = makeFactory();
    const renderer = new InkTileRenderer(factory, { budgetBytes: 1 });
    const scene = denseScene();

    renderer.renderViewport(scene, viewport);
    const firstCount = renderer.cachedTileCount;
    // Move far enough that none of the original tiles are needed.
    renderer.renderViewport(scene, { ...viewport, x: INK_TILE_SIZE * 40, y: INK_TILE_SIZE * 40 });
    expect(factory.disposed).toBeGreaterThan(0);
    expect(renderer.cachedTileCount).toBeLessThanOrEqual(firstCount);
  });

  it('drops every tile on invalidateAll', () => {
    const factory = makeFactory();
    const renderer = new InkTileRenderer(factory);
    renderer.renderViewport(denseScene(), viewport);
    expect(renderer.cachedTileCount).toBeGreaterThan(0);

    renderer.invalidateAll();
    expect(renderer.cachedTileCount).toBe(0);
    expect(renderer.cachedByteEstimate).toBe(0);
  });

  it('paints the page background into each tile when given a page', () => {
    const factory = makeFactory();
    const renderer = new InkTileRenderer(factory);
    const page: InkPage = {
      ...createInkPage('p', { background: { pattern: 'grid', spacing: 1_000 } }),
      scene: buildInkScene({ strokes: 2, samplesPerStroke: 6 }),
    };
    const tiles = renderer.renderViewport(page.scene, viewport, page);
    expect(tiles.length).toBeGreaterThan(0);
    expect(tiles.some((tile) => (tile.surface as FakeSurface).target.strokes > 0)).toBe(true);
  });

  it('leaves the target state balanced after painting a tile', () => {
    const factory = makeFactory();
    const renderer = new InkTileRenderer(factory);
    const tiles = renderer.renderViewport(denseScene(), viewport);
    for (const tile of tiles) {
      expect((tile.surface as FakeSurface).target.balanced).toBe(true);
    }
  });

  it('reports a byte estimate that tracks the cache', () => {
    const factory = makeFactory();
    const renderer = new InkTileRenderer(factory);
    renderer.renderViewport(denseScene(), viewport);
    expect(renderer.cachedByteEstimate).toBeGreaterThan(0);

    renderer.invalidate({ col: 0, row: 0 });
    const after = renderer.cachedByteEstimate;
    renderer.invalidate({ col: 0, row: 0 });
    expect(renderer.cachedByteEstimate).toBe(after);
  });
});
