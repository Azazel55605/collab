import { describe, expect, it } from 'vitest';

import type { InkScene } from '../../types/ink';
import { buildInkScene, buildStroke } from './fixture';
import { outlineStrokeWithPerfectFreehand } from './strokeAdapters';
import { objectBounds, escapeXml, sceneBounds, sceneToSvg } from './svg';

function sceneWithLayers(): InkScene {
  const scene = buildInkScene({ strokes: 3, samplesPerStroke: 12, layers: 3 });
  return scene;
}

describe('sceneToSvg', () => {
  it('is byte-identical across repeated exports', () => {
    // Phase 7 re-exports source-linked assets into notes. A generator that
    // varied would rewrite those assets on every export and fill the revision
    // history with noise.
    const scene = buildInkScene({ strokes: 40, samplesPerStroke: 24 });
    expect(sceneToSvg(scene)).toBe(sceneToSvg(scene));
  });

  it('paints in objectOrder, not in key order', () => {
    // Paint order is document data. Depending on object-key enumeration would
    // make z-order an accident of how the JSON happened to be written.
    const scene = buildInkScene({ strokes: 3, samplesPerStroke: 8 });
    scene.objectOrder = ['stroke-3', 'stroke-1', 'stroke-2'];
    const svg = sceneToSvg(scene);

    const first = svg.indexOf('<path');
    const second = svg.indexOf('<path', first + 1);
    const third = svg.indexOf('<path', second + 1);
    expect([first, second, third].every((index) => index > 0)).toBe(true);

    const reordered = { ...scene, objectOrder: ['stroke-1', 'stroke-2', 'stroke-3'] };
    expect(sceneToSvg(reordered)).not.toBe(svg);
  });

  it('omits hidden layers', () => {
    const scene = sceneWithLayers();
    const visible = sceneToSvg(scene);
    scene.layers['layer-2'].visible = false;
    const hidden = sceneToSvg(scene);
    expect(hidden.length).toBeLessThan(visible.length);
  });

  it('omits layers excluded from export even while visible on screen', () => {
    const scene = sceneWithLayers();
    const before = sceneToSvg(scene);
    scene.layers['layer-2'].exported = false;
    expect(sceneToSvg(scene)).not.toBe(before);
  });

  it('carries layer opacity onto the emitted group', () => {
    const scene = sceneWithLayers();
    scene.layers['layer-1'].opacity = 0.4;
    expect(sceneToSvg(scene)).toContain('opacity="0.4"');
  });

  it('exports only the requested objects for a selection export', () => {
    const scene = buildInkScene({ strokes: 5, samplesPerStroke: 10 });
    const svg = sceneToSvg(scene, { objectIds: ['stroke-2'] });
    expect(svg.match(/<path/g)).toHaveLength(1);
  });

  it('escapes values that came from document content', () => {
    // Colours and text are document data and may have been authored elsewhere.
    const scene = buildInkScene({ strokes: 1, samplesPerStroke: 4 });
    scene.objects['text-1'] = {
      id: 'text-1',
      type: 'text',
      layerId: 'layer-1',
      x: 0,
      y: 0,
      width: 100,
      height: 20,
      text: '</text><script>alert(1)</script>',
      color: '#000000',
      fontSize: 12,
    };
    scene.objectOrder.push('text-1');

    const svg = sceneToSvg(scene);
    expect(svg).not.toContain('<script>');
    expect(svg).toContain('&lt;script&gt;');
  });

  it('emits a background only when one is asked for', () => {
    const scene = buildInkScene({ strokes: 1, samplesPerStroke: 4 });
    expect(sceneToSvg(scene)).not.toContain('<rect');
    expect(sceneToSvg(scene, { background: '#ffffff' })).toContain('<rect');
  });

  it('scales the pixel size without changing the coordinates', () => {
    const scene = buildInkScene({ strokes: 1, samplesPerStroke: 6 });
    const plain = sceneToSvg(scene);
    const scaled = sceneToSvg(scene, { scale: 2 });
    const viewBox = /viewBox="([^"]+)"/;
    expect(scaled.match(viewBox)![1]).toBe(plain.match(viewBox)![1]);
    expect(scaled.match(/width="([^"]+)"/)![1]).not.toBe(plain.match(/width="([^"]+)"/)![1]);
  });

  it('produces valid XML that a parser accepts', () => {
    const scene = buildInkScene({ strokes: 12, samplesPerStroke: 16 });
    const parsed = new DOMParser().parseFromString(sceneToSvg(scene), 'image/svg+xml');
    expect(parsed.querySelector('parsererror')).toBeNull();
    expect(parsed.documentElement.tagName).toBe('svg');
  });

  it('exports through whichever outliner is installed', () => {
    const scene = buildInkScene({ strokes: 4, samplesPerStroke: 20 });
    const firstParty = sceneToSvg(scene);
    const freehand = sceneToSvg(scene, { outliner: outlineStrokeWithPerfectFreehand });
    expect(freehand).not.toBe(firstParty);
    expect(freehand.startsWith('<svg')).toBe(true);
  });

  it('exports an empty scene without throwing', () => {
    const empty: InkScene = { layers: {}, layerOrder: [], objects: {}, objectOrder: [] };
    expect(sceneToSvg(empty)).toContain('<svg');
  });

  it('skips an id in objectOrder that has no object', () => {
    const scene = buildInkScene({ strokes: 2, samplesPerStroke: 6 });
    scene.objectOrder.push('missing');
    expect(() => sceneToSvg(scene)).not.toThrow();
  });
});

describe('sceneBounds', () => {
  it('covers every exported object', () => {
    const scene = buildInkScene({ strokes: 6, samplesPerStroke: 20 });
    const bounds = sceneBounds(scene);
    for (const id of scene.objectOrder) {
      const objectBound = objectBounds(scene.objects[id])!;
      expect(objectBound.minX).toBeGreaterThanOrEqual(bounds.minX);
      expect(objectBound.maxX).toBeLessThanOrEqual(bounds.maxX);
    }
  });

  it('ignores layers excluded from export', () => {
    const scene = buildInkScene({ strokes: 4, samplesPerStroke: 10, layers: 2 });
    const before = sceneBounds(scene);
    scene.layers['layer-2'].exported = false;
    expect(sceneBounds(scene)).not.toEqual(before);
  });

  it('is a degenerate box for an empty scene', () => {
    const empty: InkScene = { layers: {}, layerOrder: [], objects: {}, objectOrder: [] };
    expect(sceneBounds(empty)).toEqual({ minX: 0, minY: 0, maxX: 0, maxY: 0 });
  });
});

describe('objectBounds', () => {
  it('computes stroke bounds from the samples rather than trusting the stored value', () => {
    // A stale `bounds` after a migration or a partial write would silently
    // clip the export.
    const stroke = buildStroke('s', 'layer-1', { samples: 30, x: 0, y: 0 });
    const lied = { ...stroke, bounds: { minX: 0, minY: 0, maxX: 1, maxY: 1 } };
    expect(objectBounds(lied)).not.toEqual(lied.bounds);
  });
});

describe('escapeXml', () => {
  it('escapes every character that could close an element or attribute', () => {
    expect(escapeXml(`<&>"'`)).toBe('&lt;&amp;&gt;&quot;&apos;');
  });
});
