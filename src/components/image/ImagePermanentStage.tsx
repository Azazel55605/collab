import type { RefObject } from 'react';
import { Check, X } from 'lucide-react';

import type { ImageCropRect } from '../../types/image';
import { Button } from '../ui/button';
import { getRelativePoint, type Point } from './ImageViewUtils';

const CROP_RESIZE_HANDLES = [
  { key: 'top', className: 'absolute inset-x-2 top-[-4px] h-2 cursor-ns-resize', edges: { left: false, right: false, top: true, bottom: false } },
  { key: 'bottom', className: 'absolute inset-x-2 bottom-[-4px] h-2 cursor-ns-resize', edges: { left: false, right: false, top: false, bottom: true } },
  { key: 'left', className: 'absolute inset-y-2 left-[-4px] w-2 cursor-ew-resize', edges: { left: true, right: false, top: false, bottom: false } },
  { key: 'right', className: 'absolute inset-y-2 right-[-4px] w-2 cursor-ew-resize', edges: { left: false, right: true, top: false, bottom: false } },
  { key: 'top-left', className: 'absolute left-[-5px] top-[-5px] h-3 w-3 cursor-nwse-resize rounded-full border border-primary/70 bg-background', edges: { left: true, right: false, top: true, bottom: false } },
  { key: 'top-right', className: 'absolute right-[-5px] top-[-5px] h-3 w-3 cursor-nesw-resize rounded-full border border-primary/70 bg-background', edges: { left: false, right: true, top: true, bottom: false } },
  { key: 'bottom-left', className: 'absolute bottom-[-5px] left-[-5px] h-3 w-3 cursor-nesw-resize rounded-full border border-primary/70 bg-background', edges: { left: true, right: false, top: false, bottom: true } },
  { key: 'bottom-right', className: 'absolute bottom-[-5px] right-[-5px] h-3 w-3 cursor-nwse-resize rounded-full border border-primary/70 bg-background', edges: { left: false, right: true, top: false, bottom: true } },
] as const;

interface ImagePermanentStageProps {
  previewCanvasRef: RefObject<HTMLCanvasElement | null>;
  displayWidth: number;
  displayHeight: number;
  cropMode: boolean;
  cropDraft: ImageCropRect | null;
  cropRectStyle: React.CSSProperties | undefined;
  onCropPointerDown: (event: React.PointerEvent<HTMLDivElement>) => void;
  onCropPointerMove: (event: React.PointerEvent<HTMLDivElement>) => void;
  onCropPointerEnd: () => void;
  onCropResizeStart: (payload: {
    edges: { left: boolean; right: boolean; top: boolean; bottom: boolean };
    startPointer: Point;
    startRect: ImageCropRect;
  }) => void;
}

export function ImagePermanentStage({
  previewCanvasRef,
  displayWidth,
  displayHeight,
  cropMode,
  cropDraft,
  cropRectStyle,
  onCropPointerDown,
  onCropPointerMove,
  onCropPointerEnd,
  onCropResizeStart,
}: ImagePermanentStageProps) {
  return (
    <div
      className="relative shrink-0 rounded-xl border border-border/40 bg-background/70 shadow-xl app-fade-scale-in"
      style={{ width: displayWidth, height: displayHeight }}
    >
      <canvas ref={previewCanvasRef} className="rounded-xl" />

      {cropMode && (
        <div
          data-image-stage="crop"
          className="absolute inset-0 cursor-crosshair"
          onPointerDown={onCropPointerDown}
          onPointerMove={onCropPointerMove}
          onPointerUp={onCropPointerEnd}
          onPointerLeave={onCropPointerEnd}
        >
          <div className="absolute inset-0 rounded-xl bg-black/20" />
          {cropDraft && (
            <div
              className="absolute rounded-lg border-2 border-primary bg-primary/10 shadow-lg shadow-primary/20"
              style={cropRectStyle}
            >
              {CROP_RESIZE_HANDLES.map((handle) => (
                <button
                  key={handle.key}
                  type="button"
                  className={handle.className}
                  onPointerDown={(event) => {
                    event.stopPropagation();
                    if (!cropDraft) return;
                    const stage = event.currentTarget.closest('[data-image-stage="crop"]') as HTMLDivElement | null;
                    if (!stage) return;
                    const rect = stage.getBoundingClientRect();
                    onCropResizeStart({
                      edges: handle.edges,
                      startPointer: getRelativePoint(event, rect),
                      startRect: cropDraft,
                    });
                  }}
                />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

interface ImageCropFooterProps {
  cropMode: boolean;
  cropDraft: ImageCropRect | null;
  onCancelCrop: () => void;
  onApplyCrop: () => void;
}

export function ImageCropFooter({
  cropMode,
  cropDraft,
  onCancelCrop,
  onApplyCrop,
}: ImageCropFooterProps) {
  if (!cropMode) return null;

  return (
    <div className="flex items-center justify-between gap-3 border-t border-border/30 bg-sidebar/30 px-4 py-2 text-xs text-muted-foreground">
      <span>
        Drag to define the crop area on the rotated image.
      </span>
      <div className="flex items-center gap-2">
        <Button size="sm" variant="outline" className="h-8" onClick={onCancelCrop}>
          <X size={14} className="mr-1.5" />
          Cancel
        </Button>
        <Button size="sm" className="h-8" onClick={onApplyCrop} disabled={!cropDraft}>
          <Check size={14} className="mr-1.5" />
          Apply Crop
        </Button>
      </div>
    </div>
  );
}
