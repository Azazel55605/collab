import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createInkPage } from '../../lib/ink/document';
import { FIXTURE_BRUSH } from '../../lib/ink/fixture';
import { addObject } from '../../lib/ink/operations';
import { defaultToolState, INK_DEFAULT_PEN_BUTTONS } from '../../lib/ink/tools';
import type { InkShape } from '../../types/ink';

import InkCanvas from './InkCanvas';

function selectedPage() {
  const page = createInkPage('page-1');
  const layerId = page.scene.layerOrder[0];
  const shape: InkShape = {
    id: 'shape-1',
    type: 'shape',
    layerId,
    shape: 'rectangle',
    points: [1_000, 3_000, 3_000, 3_000, 3_000, 5_000, 1_000, 5_000],
    stroke: { ...FIXTURE_BRUSH, kind: 'technical', color: '#000', width: 48 },
  };
  return { ...page, scene: addObject(page.scene, shape).result };
}

function renderCanvas(onRotateSelection = vi.fn(), page = selectedPage()) {
  const tool = { ...defaultToolState(), tool: 'select' as const };
  render(
    <InkCanvas
      page={page}
      originX={0}
      originY={0}
      zoom={1}
      tool={tool}
      penButtons={INK_DEFAULT_PEN_BUTTONS}
      selectedIds={['shape-1']}
      readOnly={false}
      onViewportChange={vi.fn()}
      onCommitStroke={vi.fn()}
      onCreateAdvancedObject={vi.fn()}
      onEyedropObject={vi.fn()}
      onActivateObjectLink={vi.fn()}
      readAssetDataUrl={vi.fn(async () => '')}
      onErase={vi.fn()}
      onSelectionChange={vi.fn()}
      onMoveSelection={vi.fn()}
      onResizeSelection={vi.fn()}
      onRotateSelection={onRotateSelection}
    />,
  );
  return { host: screen.getByTestId('ink-canvas-host'), onRotateSelection };
}

beforeEach(() => {
  Element.prototype.getBoundingClientRect = vi.fn(() => ({
    x: 0,
    y: 0,
    top: 0,
    left: 0,
    right: 1_000,
    bottom: 800,
    width: 1_000,
    height: 800,
    toJSON: () => ({}),
  })) as unknown as typeof Element.prototype.getBoundingClientRect;
  Element.prototype.hasPointerCapture = vi.fn(() => false);
  Element.prototype.setPointerCapture = vi.fn();
  Element.prototype.releasePointerCapture = vi.fn();
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as never;
});

describe('InkCanvas selection affordances', () => {
  it('uses a directional cursor over a resize handle', () => {
    const { host } = renderCanvas();
    const handle = document.querySelector('[data-ink-handle="e"]') as SVGRectElement;
    fireEvent.pointerMove(host, {
      clientX: Number(handle.getAttribute('x')) + Number(handle.getAttribute('width')) / 2,
      clientY: Number(handle.getAttribute('y')) + Number(handle.getAttribute('height')) / 2,
    });
    expect(host.style.cursor).toBe('ew-resize');
  });

  it('rotates from the dedicated handle', () => {
    const { host, onRotateSelection } = renderCanvas();
    const handle = document.querySelector('[data-ink-handle="rotate"]') as SVGCircleElement;
    const startX = Number(handle.getAttribute('cx'));
    const startY = Number(handle.getAttribute('cy'));
    fireEvent.pointerDown(host, {
      pointerId: 9,
      pointerType: 'mouse',
      buttons: 1,
      clientX: startX,
      clientY: startY,
    });
    fireEvent.pointerMove(host, {
      pointerId: 9,
      pointerType: 'mouse',
      buttons: 1,
      clientX: startX + 40,
      clientY: startY + 28,
    });
    expect(onRotateSelection).toHaveBeenCalled();
    expect(host.style.cursor).toBe('grabbing');
  });

  it('renders the selection box on the rotated object axes', () => {
    const page = selectedPage();
    const shape = page.scene.objects['shape-1'] as InkShape;
    page.scene.objects['shape-1'] = {
      ...shape,
      points: [2_000, 2_586, 3_414, 4_000, 2_000, 5_414, 586, 4_000],
      rotation: Math.PI / 4,
    };
    renderCanvas(vi.fn(), page);
    const outline = document.querySelector('[data-testid="ink-selection"] polygon');
    expect(outline).not.toBeNull();
    const points = outline!
      .getAttribute('points')!
      .split(' ')
      .map((pair) => pair.split(',').map(Number));
    expect(points[0][1]).not.toBeCloseTo(points[1][1]);
    expect(points[1][0]).not.toBeCloseTo(points[2][0]);
  });
});
