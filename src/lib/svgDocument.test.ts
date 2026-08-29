import { describe, expect, it } from 'vitest';

import {
  addNode,
  createNode,
  findNode,
  nodeBounds,
  parseSvg,
  removeNode,
  reorderNode,
  resizeNodeToBounds,
  serializeScene,
  setNodeStyle,
  SvgParseError,
  translateNode,
  updateNode,
} from './svgDocument';

const SAMPLE = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 80">
  <defs><linearGradient id="g"><stop offset="0" stop-color="red"/></linearGradient></defs>
  <rect x="10" y="20" width="30" height="40" fill="url(#g)" rx="4"/>
  <circle cx="50" cy="50" r="12" fill="#123456"/>
  <g transform="translate(5,5)"><path d="M0 0 L10 10"/></g>
  <text x="5" y="70" font-size="14" fill="#fff">Hi</text>
</svg>`;

describe('parseSvg', () => {
  it('parses viewBox and separates editable nodes from passthrough', () => {
    const scene = parseSvg(SAMPLE);
    expect(scene.viewBox).toEqual({ x: 0, y: 0, width: 100, height: 80 });
    const nodes = scene.slots.filter((s) => s.kind === 'node');
    const raw = scene.slots.filter((s) => s.kind === 'raw');
    // rect, circle, text are editable; defs and the <g> are passthrough
    expect(nodes).toHaveLength(3);
    expect(raw).toHaveLength(2);
    expect(raw.some((s) => s.kind === 'raw' && s.markup.includes('linearGradient'))).toBe(true);
    expect(raw.some((s) => s.kind === 'raw' && s.markup.includes('<g'))).toBe(true);
  });

  it('reads primitive geometry and style in user units', () => {
    const scene = parseSvg(SAMPLE);
    const rect = scene.slots.find((s) => s.kind === 'node' && s.node.type === 'rect');
    expect(rect?.kind === 'node' && rect.node).toMatchObject({
      x: 10,
      y: 20,
      width: 30,
      height: 40,
      style: { fill: 'url(#g)' },
    });
    // rx is not a rect geometry field we own — it must be preserved as an extra attr
    expect(rect?.kind === 'node' && rect.node.extraAttrs.rx).toBe('4');
  });

  it('preserves fill declared via inline style', () => {
    const scene = parseSvg(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect style="fill:#abc;opacity:0.5;foo:bar" width="5" height="5"/></svg>',
    );
    const node = findNode(scene, scene.slots[0].kind === 'node' ? scene.slots[0].node.id : '');
    expect(node?.style.fill).toBe('#abc');
    expect(node?.style.opacity).toBe(0.5);
    // unrelated declaration stays in the leftover style
    expect(node?.extraAttrs.style).toContain('foo: bar');
  });

  it('throws on non-svg input', () => {
    expect(() => parseSvg('not svg')).toThrow(SvgParseError);
    expect(() => parseSvg('<html><body/></html>')).toThrow(SvgParseError);
  });
});

describe('serializeScene round-trip', () => {
  it('re-parses to an equivalent scene and keeps passthrough intact', () => {
    const scene = parseSvg(SAMPLE);
    const out = serializeScene(scene);
    expect(out).toContain('linearGradient');
    expect(out).toMatch(/<g[^>]*transform="translate\(5,5\)"/);
    const reparsed = parseSvg(out);
    expect(reparsed.viewBox).toEqual(scene.viewBox);
    expect(reparsed.slots.filter((s) => s.kind === 'node')).toHaveLength(3);
    const rect = reparsed.slots.find((s) => s.kind === 'node' && s.node.type === 'rect');
    expect(rect?.kind === 'node' && rect.node.width).toBe(30);
    expect(rect?.kind === 'node' && rect.node.extraAttrs.rx).toBe('4');
  });

  it('escapes text content on serialize so the result re-parses', () => {
    let scene = parseSvg(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><text x="0" y="5">t</text></svg>',
    );
    const id = scene.slots[0].kind === 'node' ? scene.slots[0].node.id : '';
    scene = updateNode(scene, id, (n) => ({ ...n, text: 'a & b < c' }));
    const out = serializeScene(scene);
    expect(out).toContain('a &amp; b &lt; c');
    const reparsed = parseSvg(out);
    const textNode = reparsed.slots.find((s) => s.kind === 'node' && s.node.type === 'text');
    expect(textNode?.kind === 'node' && textNode.node.text).toBe('a & b < c');
  });
});

describe('geometry operations', () => {
  it('computes bounds per primitive type', () => {
    expect(nodeBounds(createNode('rect', { x: 2, y: 3, width: 10, height: 20 }))).toEqual({
      x: 2,
      y: 3,
      width: 10,
      height: 20,
    });
    const circle = createNode('circle', { x: 0, y: 0, width: 10, height: 10 });
    expect(nodeBounds(circle)).toEqual({ x: 0, y: 0, width: 10, height: 10 });
    expect(nodeBounds(createNode('text', { x: 0, y: 0, width: 5, height: 5 }))).toBeNull();
  });

  it('translates native primitives by attribute and paths by transform', () => {
    const rect = createNode('rect', { x: 0, y: 0, width: 10, height: 10 });
    expect(translateNode(rect, 5, 7)).toMatchObject({ x: 5, y: 7 });

    const line = createNode('line', { x: 0, y: 0, width: 10, height: 10 });
    expect(translateNode(line, 1, 2)).toMatchObject({ x1: 1, y1: 2, x2: 11, y2: 12 });

    const scene = parseSvg(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><path d="M0 0"/></svg>',
    );
    const pathId = scene.slots[0].kind === 'node' ? scene.slots[0].node.id : '';
    const moved = updateNode(scene, pathId, (n) => translateNode(n, 3, 4));
    expect(findNode(moved, pathId)?.transform).toContain('translate(3, 4)');
  });

  it('resizes box primitives to new bounds', () => {
    const ellipse = createNode('ellipse', { x: 0, y: 0, width: 10, height: 10 });
    const resized = resizeNodeToBounds(ellipse, { x: 4, y: 4, width: 20, height: 40 });
    expect(resized).toMatchObject({ cx: 14, cy: 24, rx: 10, ry: 20 });
  });

  it('enforces a minimum size on resize', () => {
    const rect = createNode('rect', { x: 0, y: 0, width: 10, height: 10 });
    expect(resizeNodeToBounds(rect, { x: 0, y: 0, width: 0, height: 0 }).width).toBe(1);
  });
});

describe('scene mutations', () => {
  it('adds, updates, removes and reorders nodes', () => {
    let scene = parseSvg('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"/>');
    const node = createNode('rect', { x: 0, y: 0, width: 5, height: 5 });
    scene = addNode(scene, node);
    expect(findNode(scene, node.id)).toBeTruthy();

    scene = updateNode(scene, node.id, (n) => setNodeStyle(n, { fill: '#000' }));
    expect(findNode(scene, node.id)?.style.fill).toBe('#000');

    const second = createNode('circle', { x: 0, y: 0, width: 4, height: 4 });
    scene = addNode(scene, second);
    const before = scene.slots.findIndex((s) => s.kind === 'node' && s.node.id === node.id);
    scene = reorderNode(scene, node.id, 'forward');
    const after = scene.slots.findIndex((s) => s.kind === 'node' && s.node.id === node.id);
    expect(after).toBe(before + 1);

    scene = removeNode(scene, node.id);
    expect(findNode(scene, node.id)).toBeNull();
  });
});
