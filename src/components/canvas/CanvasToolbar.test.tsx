import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../ui/button', () => ({
  Button: ({ children, onClick, title, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button type="button" onClick={onClick} title={title} {...props}>{children}</button>
  ),
}));

vi.mock('../layout/DocumentTopBar', () => ({
  documentTopBarGroupClass: 'toolbar-group',
}));

import { CanvasToolbar } from './CanvasToolbar';

describe('CanvasToolbar', () => {
  afterEach(() => {
    cleanup();
  });

  it('fires add actions from the toolbar', () => {
    const onAddNote = vi.fn();
    const onAddFile = vi.fn();
    const onAddText = vi.fn();
    const onAddWeb = vi.fn();

    render(
      <CanvasToolbar
        zoomLabel="100%"
        onAddNote={onAddNote}
        onAddFile={onAddFile}
        onAddText={onAddText}
        onAddWeb={onAddWeb}
        onZoomOut={vi.fn()}
        onResetZoom={vi.fn()}
        onZoomIn={vi.fn()}
        onFitView={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /add note/i }));
    fireEvent.click(screen.getByRole('button', { name: /add file/i }));
    fireEvent.click(screen.getByRole('button', { name: /add text/i }));
    fireEvent.click(screen.getByRole('button', { name: /add web/i }));

    expect(onAddNote).toHaveBeenCalled();
    expect(onAddFile).toHaveBeenCalled();
    expect(onAddText).toHaveBeenCalled();
    expect(onAddWeb).toHaveBeenCalled();
  });

  it('fires zoom and fit actions from the toolbar', () => {
    const onZoomOut = vi.fn();
    const onResetZoom = vi.fn();
    const onZoomIn = vi.fn();
    const onFitView = vi.fn();

    render(
      <CanvasToolbar
        zoomLabel="125%"
        onAddNote={vi.fn()}
        onAddFile={vi.fn()}
        onAddText={vi.fn()}
        onAddWeb={vi.fn()}
        onZoomOut={onZoomOut}
        onResetZoom={onResetZoom}
        onZoomIn={onZoomIn}
        onFitView={onFitView}
      />,
    );

    fireEvent.click(screen.getByTitle(/zoom out/i));
    fireEvent.click(screen.getByRole('button', { name: '125%' }));
    fireEvent.click(screen.getByTitle(/zoom in/i));
    fireEvent.click(screen.getByRole('button', { name: /fit view/i }));

    expect(onZoomOut).toHaveBeenCalled();
    expect(onResetZoom).toHaveBeenCalledTimes(1);
    expect(onZoomIn).toHaveBeenCalled();
    expect(onFitView).toHaveBeenCalled();
  });
});
