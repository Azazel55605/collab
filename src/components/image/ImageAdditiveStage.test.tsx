import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { ImageAdditiveStage } from './ImageAdditiveStage';

describe('ImageAdditiveStage', () => {
  it('renders overlays and forwards interactions', () => {
    const onStagePointerDown = vi.fn();
    const onStagePointerMove = vi.fn();
    const onStagePointerUp = vi.fn();
    const onStagePointerLeave = vi.fn();
    const onSelectItem = vi.fn();
    const onSetEditingTextId = vi.fn();
    const onStartArrowInteraction = vi.fn();
    const onStartTextInteraction = vi.fn();
    const onTextChange = vi.fn();
    const textInputRefs = { current: {} as Record<string, HTMLTextAreaElement | null> };

    render(
      <ImageAdditiveStage
        src="data:image/png;base64,abc"
        relativePath="Pictures/demo.png"
        toolCursor="cursor-default"
        additiveCanvasStyle={{ width: 300, height: 200 }}
        additiveDisplayDimensions={{ width: 300, height: 200 }}
        overlaySvgItems={[
          { id: 'arrow-1', type: 'arrow', start: { x: 0.1, y: 0.1 }, end: { x: 0.8, y: 0.8 }, color: '#fff', strokeWidth: 4, lineStyle: 'solid' },
          { id: 'pen-1', type: 'pen', points: [{ x: 0.1, y: 0.2 }, { x: 0.3, y: 0.4 }], color: '#0ff', strokeWidth: 3 },
          { id: 'text-1', type: 'text', x: 0.2, y: 0.2, width: 0.2, height: 0.12, text: 'Hello', color: '#f00', fontSize: 18 },
        ]}
        selectedItemId="arrow-1"
        textInputRefs={textInputRefs}
        onStagePointerDown={onStagePointerDown}
        onStagePointerMove={onStagePointerMove}
        onStagePointerUp={onStagePointerUp}
        onStagePointerLeave={onStagePointerLeave}
        onSelectItem={onSelectItem}
        onSetEditingTextId={onSetEditingTextId}
        onStartArrowInteraction={onStartArrowInteraction}
        onStartTextInteraction={onStartTextInteraction}
        onTextChange={onTextChange}
      />,
    );

    const stage = document.querySelector('[data-image-stage="additive"]') as HTMLDivElement;
    expect(stage).toBeTruthy();
    fireEvent.pointerDown(stage);
    expect(onStagePointerDown).toHaveBeenCalled();

    const textArea = screen.getByPlaceholderText('Write here');
    fireEvent.focus(textArea);
    fireEvent.change(textArea, { target: { value: 'Updated' } });
    expect(onSelectItem).toHaveBeenCalledWith('text-1');
    expect(onSetEditingTextId).toHaveBeenCalledWith('text-1');
    expect(onTextChange).toHaveBeenCalledWith('text-1', 'Updated');

    const arrowHandle = document.querySelector('circle') as SVGCircleElement;
    expect(arrowHandle).toBeTruthy();
    fireEvent.pointerDown(arrowHandle);
    expect(onStartArrowInteraction).toHaveBeenCalled();
  });
});
