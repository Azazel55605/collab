import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { ImageAdditiveToolbar } from './ImageAdditiveToolbar';

describe('ImageAdditiveToolbar', () => {
  it('renders tool controls and action callbacks', () => {
    const onToolChange = vi.fn();
    const onColorOpenChange = vi.fn();
    const onHexDraftChange = vi.fn();
    const onApplyHexColor = vi.fn();
    const onColorSelect = vi.fn();
    const onStrokeWidthChange = vi.fn();
    const onLineStyleChange = vi.fn();
    const onFontSizeChange = vi.fn();
    const onDeleteSelected = vi.fn();
    const onBakeIntoImage = vi.fn();

    render(
      <ImageAdditiveToolbar
        tool="select"
        onToolChange={onToolChange}
        activeColor="#38bdf8"
        overlayColors={['#38bdf8', '#f97316']}
        colorOpen
        onColorOpenChange={onColorOpenChange}
        hexDraft="#38bdf8"
        onHexDraftChange={onHexDraftChange}
        onApplyHexColor={onApplyHexColor}
        onColorSelect={onColorSelect}
        strokeWidth={4}
        onStrokeWidthChange={onStrokeWidthChange}
        lineStyle="solid"
        onLineStyleChange={onLineStyleChange}
        fontSize={20}
        onFontSizeChange={onFontSizeChange}
        hasSelectedItem
        onDeleteSelected={onDeleteSelected}
        hasAdditiveItems
        onBakeIntoImage={onBakeIntoImage}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /arrow/i }));
    expect(onToolChange).toHaveBeenCalledWith('arrow');

    fireEvent.click(screen.getByRole('button', { name: /select color #f97316/i }));
    expect(onColorSelect).toHaveBeenCalledWith('#f97316');

    fireEvent.change(screen.getByDisplayValue('4'), { target: { value: '8' } });
    expect(onStrokeWidthChange).toHaveBeenCalledWith('8');

    fireEvent.change(screen.getByDisplayValue('20'), { target: { value: '24' } });
    expect(onFontSizeChange).toHaveBeenCalledWith('24');

    fireEvent.click(screen.getByRole('button', { name: /delete selected/i }));
    expect(onDeleteSelected).toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: /bake into image/i }));
    expect(onBakeIntoImage).toHaveBeenCalled();

    fireEvent.blur(screen.getByPlaceholderText('#rrggbb'));
    expect(onApplyHexColor).toHaveBeenCalled();
  });
});
