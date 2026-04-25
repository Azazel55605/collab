import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { ImagePermanentToolbar } from './ImagePermanentToolbar';

describe('ImagePermanentToolbar', () => {
  it('renders controls and forwards interactions', () => {
    const onRotate = vi.fn();
    const onBeginCrop = vi.fn();
    const onResizeWidthChange = vi.fn();
    const onResizeHeightChange = vi.fn();
    const onToggleLockRatio = vi.fn();
    const onReset = vi.fn();
    const onSaveChanges = vi.fn();

    render(
      <ImagePermanentToolbar
        cropMode={false}
        resizeWidth={320}
        resizeHeight={180}
        widthPlaceholder="800"
        heightPlaceholder="600"
        lockAspectRatio
        permanentDirty
        onRotate={onRotate}
        onBeginCrop={onBeginCrop}
        onResizeWidthChange={onResizeWidthChange}
        onResizeHeightChange={onResizeHeightChange}
        onToggleLockRatio={onToggleLockRatio}
        onReset={onReset}
        onSaveChanges={onSaveChanges}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /rotate/i }));
    fireEvent.click(screen.getByRole('button', { name: /crop/i }));
    fireEvent.change(screen.getByDisplayValue('320'), { target: { value: '640' } });
    fireEvent.change(screen.getByDisplayValue('180'), { target: { value: '360' } });
    fireEvent.click(screen.getByRole('button', { name: /lock ratio/i }));
    fireEvent.click(screen.getByRole('button', { name: /reset/i }));
    fireEvent.click(screen.getByRole('button', { name: /save changes/i }));

    expect(onRotate).toHaveBeenCalled();
    expect(onBeginCrop).toHaveBeenCalled();
    expect(onResizeWidthChange).toHaveBeenCalledWith('640');
    expect(onResizeHeightChange).toHaveBeenCalledWith('360');
    expect(onToggleLockRatio).toHaveBeenCalled();
    expect(onReset).toHaveBeenCalled();
    expect(onSaveChanges).toHaveBeenCalled();
  });

  it('disables save when nothing changed', () => {
    render(
      <ImagePermanentToolbar
        cropMode
        resizeWidth={null}
        resizeHeight={null}
        widthPlaceholder="100"
        heightPlaceholder="100"
        lockAspectRatio={false}
        permanentDirty={false}
        onRotate={vi.fn()}
        onBeginCrop={vi.fn()}
        onResizeWidthChange={vi.fn()}
        onResizeHeightChange={vi.fn()}
        onToggleLockRatio={vi.fn()}
        onReset={vi.fn()}
        onSaveChanges={vi.fn()}
      />,
    );

    expect(screen.getByRole('button', { name: /save changes/i }).hasAttribute('disabled')).toBe(true);
  });
});
