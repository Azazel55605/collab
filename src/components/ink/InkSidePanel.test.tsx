import type { ComponentProps } from 'react';

import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { createInkPage } from '../../lib/ink/document';
import { addObject } from '../../lib/ink/operations';
import { defaultToolState } from '../../lib/ink/tools';

import InkSidePanel from './InkSidePanel';

function props(): ComponentProps<typeof InkSidePanel> {
  let page = createInkPage('page-1');
  page = {
    ...page,
    name: 'Page 1',
    scene: addObject(page.scene, {
      id: 'text-1',
      type: 'text',
      layerId: page.scene.layerOrder[0],
      x: 0,
      y: 0,
      width: 100,
      height: 100,
      text: 'Quarterly plan',
      color: '#000000',
      fontSize: 64,
    }).result,
  };
  return {
    scene: page.scene,
    page,
    brushes: [],
    swatches: [],
    tool: defaultToolState(),
    readOnly: false,
    selectedIds: [],
    activeLayerId: page.scene.layerOrder[0],
    onBrushChange: vi.fn(),
    onEraserChange: vi.fn(),
    onActiveLayerChange: vi.fn(),
    onSelectObject: vi.fn(),
    onAddLayer: vi.fn(),
    onToggleLayerVisible: vi.fn(),
    onToggleLayerLocked: vi.fn(),
    onRenameLayer: vi.fn(),
    onReorderLayer: vi.fn(),
    onMergeLayerDown: vi.fn(),
    onDeleteLayer: vi.fn(),
    onAlign: vi.fn(),
    onDistribute: vi.fn(),
    onAdvancedToolChange: vi.fn(),
    onRecognizeSelection: vi.fn(),
    onSmoothSelection: vi.fn(),
    onRecolorSelection: vi.fn(),
    onUpdateSelectedText: vi.fn(),
    onPageBackgroundChange: vi.fn(),
    onSelectBrushPreset: vi.fn(),
    onSaveBrushFavorite: vi.fn(),
    onAddSwatch: vi.fn(),
    onSetSelectedLink: vi.fn(),
    templates: [],
    onSavePageTemplate: vi.fn(),
    onAddPageFromTemplate: vi.fn(),
    onDeleteTemplate: vi.fn(),
    onImportTemplate: vi.fn(),
    onExportTemplate: vi.fn(),
  };
}

describe('InkSidePanel object navigator', () => {
  it('exposes semantic names in reading order and selects with the keyboard button', () => {
    const values = props();
    render(<InkSidePanel {...values} />);

    const object = screen.getByRole('button', {
      name: '1. Text, Quarterly plan, layer Layer 1',
    });
    fireEvent.click(object, { shiftKey: true });
    expect(values.onSelectObject).toHaveBeenCalledWith('text-1', true);
  });

  it('paginates authored objects instead of creating an unbounded list', () => {
    const values = props();
    let scene = values.scene!;
    const layerId = scene.layerOrder[0];
    for (let index = 2; index <= 51; index += 1) {
      scene = addObject(scene, {
        id: `stamp-${index}`,
        type: 'stamp',
        layerId,
        x: index * 100,
        y: 0,
        width: 64,
        height: 64,
        symbolId: `number-${index}`,
      }).result;
    }
    render(<InkSidePanel {...values} scene={scene} page={{ ...values.page!, scene }} />);

    expect(
      screen.getByRole('list', { name: 'Page reading order, part 1 of 2' }).children,
    ).toHaveLength(50);
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    expect(
      screen.getByRole('list', { name: 'Page reading order, part 2 of 2' }).children,
    ).toHaveLength(1);
  });
});
