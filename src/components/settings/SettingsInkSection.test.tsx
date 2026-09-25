import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import SettingsInkSection from './SettingsInkSection';

describe('SettingsInkSection', () => {
  it('updates drawing defaults', () => {
    const setBrushKind = vi.fn();
    const setColor = vi.fn();
    const setWidth = vi.fn();
    const setEraserMode = vi.fn();
    const setEraserRadius = vi.fn();
    const setSnapToGrid = vi.fn();
    const setHoldToStraighten = vi.fn();

    render(
      <SettingsInkSection
        brushKind="ballpoint"
        setBrushKind={setBrushKind}
        color="ink:foreground"
        setColor={setColor}
        width={96}
        setWidth={setWidth}
        eraserMode="segment"
        setEraserMode={setEraserMode}
        eraserRadius={640}
        setEraserRadius={setEraserRadius}
        snapToGrid
        setSnapToGrid={setSnapToGrid}
        holdToStraighten
        setHoldToStraighten={setHoldToStraighten}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'pencil' }));
    expect(setBrushKind).toHaveBeenCalledWith('pencil');
    fireEvent.click(screen.getByRole('button', { name: 'Blue' }));
    expect(setColor).toHaveBeenCalledWith('ink:blue');
    fireEvent.click(screen.getByRole('button', { name: '4 pt' }));
    expect(setWidth).toHaveBeenCalledWith(256);
    fireEvent.click(screen.getByRole('button', { name: 'Stroke' }));
    expect(setEraserMode).toHaveBeenCalledWith('stroke');
    fireEvent.click(screen.getByRole('switch', { name: 'Default snap to grid' }));
    expect(setSnapToGrid).toHaveBeenCalledWith(false);
  });
});
