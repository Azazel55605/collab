import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { ImageCropFooter, ImagePermanentStage } from './ImagePermanentStage';

describe('ImagePermanentStage', () => {
  it('renders crop overlay and forwards interactions', () => {
    const onCropPointerDown = vi.fn();
    const onCropPointerMove = vi.fn();
    const onCropPointerEnd = vi.fn();
    const onCropResizeStart = vi.fn();
    const previewCanvasRef = { current: null as HTMLCanvasElement | null };

    render(
      <ImagePermanentStage
        previewCanvasRef={previewCanvasRef}
        displayWidth={400}
        displayHeight={300}
        cropMode
        cropDraft={{ x: 20, y: 30, width: 120, height: 90 }}
        cropRectStyle={{ left: '10%', top: '10%', width: '40%', height: '40%' }}
        onCropPointerDown={onCropPointerDown}
        onCropPointerMove={onCropPointerMove}
        onCropPointerEnd={onCropPointerEnd}
        onCropResizeStart={onCropResizeStart}
      />,
    );

    const stage = document.querySelector('[data-image-stage="crop"]') as HTMLDivElement;
    expect(stage).toBeTruthy();
    fireEvent.pointerDown(stage);
    fireEvent.pointerMove(stage);
    fireEvent.pointerLeave(stage);

    expect(onCropPointerDown).toHaveBeenCalled();
    expect(onCropPointerMove).toHaveBeenCalled();
    expect(onCropPointerEnd).toHaveBeenCalled();

    const resizeHandle = stage.querySelector('button') as HTMLButtonElement;
    fireEvent.pointerDown(resizeHandle);
    expect(onCropResizeStart).toHaveBeenCalled();
  });
});

describe('ImageCropFooter', () => {
  it('renders crop actions and forwards buttons', () => {
    const onCancelCrop = vi.fn();
    const onApplyCrop = vi.fn();

    render(
      <ImageCropFooter
        cropMode
        cropDraft={{ x: 0, y: 0, width: 10, height: 10 }}
        onCancelCrop={onCancelCrop}
        onApplyCrop={onApplyCrop}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /cancel/i }));
    fireEvent.click(screen.getByRole('button', { name: /apply crop/i }));

    expect(onCancelCrop).toHaveBeenCalled();
    expect(onApplyCrop).toHaveBeenCalled();
  });
});
