import { useCallback, useEffect } from 'react';

import type { ImageCropRect, PermanentImageEdits } from '../../types/image';

import {
  clamp,
  createEmptyEdits,
  type Dimensions,
  getCropBounds,
  getRelativePoint,
  normalizeCropRect,
  type Point,
} from './ImageViewUtils';

type ViewerMode = 'view' | 'additive' | 'permanent';
export type ImageCropInteraction =
  | { mode: 'draw'; startPointer: Point }
  | {
      mode: 'resize';
      edges: { left: boolean; right: boolean; top: boolean; bottom: boolean };
      startPointer: Point;
      startRect: ImageCropRect;
    };

interface Options {
  viewportRef: React.RefObject<HTMLDivElement | null>;
  currentDimensions: Dimensions;
  rotatedDimensions: Dimensions;
  permanentEdits: PermanentImageEdits;
  cropMode: boolean;
  cropDraft: ImageCropRect | null;
  cropDragStart: Point | null;
  cropInteraction: ImageCropInteraction | null;
  dialogOpen: boolean;
  setMode: React.Dispatch<React.SetStateAction<ViewerMode>>;
  setPermanentEdits: React.Dispatch<React.SetStateAction<PermanentImageEdits>>;
  setCropMode: React.Dispatch<React.SetStateAction<boolean>>;
  setCropDraft: React.Dispatch<React.SetStateAction<ImageCropRect | null>>;
  setCropDragStart: React.Dispatch<React.SetStateAction<Point | null>>;
  setCropInteraction: React.Dispatch<React.SetStateAction<ImageCropInteraction | null>>;
  setZoomPercent: React.Dispatch<React.SetStateAction<number>>;
}

export function useImageInteractions({
  viewportRef,
  currentDimensions,
  rotatedDimensions,
  permanentEdits,
  cropMode,
  cropDraft,
  cropDragStart,
  cropInteraction,
  dialogOpen,
  setMode,
  setPermanentEdits,
  setCropMode,
  setCropDraft,
  setCropDragStart,
  setCropInteraction,
  setZoomPercent,
}: Options) {
  const beginCrop = useCallback(() => {
    setMode('permanent');
    setCropMode(true);
    setCropDraft(getCropBounds(currentDimensions, permanentEdits));
  }, [currentDimensions, permanentEdits, setCropDraft, setCropMode, setMode]);

  const resetPermanentEdits = useCallback(() => {
    setPermanentEdits(createEmptyEdits());
    setCropMode(false);
    setCropDraft(null);
    setCropDragStart(null);
  }, [setCropDraft, setCropDragStart, setCropMode, setPermanentEdits]);

  const applyCrop = useCallback(() => {
    if (!cropDraft) return;
    setPermanentEdits((current) => ({
      ...current,
      crop: normalizeCropRect(cropDraft, rotatedDimensions),
    }));
    setCropMode(false);
  }, [cropDraft, rotatedDimensions, setCropMode, setPermanentEdits]);

  const cancelCrop = useCallback(() => {
    setCropMode(false);
    setCropDraft(null);
    setCropDragStart(null);
  }, [setCropDraft, setCropDragStart, setCropMode]);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      const editable =
        event.target instanceof HTMLElement &&
        event.target.matches('input, textarea, [contenteditable="true"], [role="textbox"]');
      if (dialogOpen || editable || event.altKey) return;
      const ctrl = event.ctrlKey || event.metaKey;
      if (ctrl && (event.key === '+' || event.key === '=')) {
        event.preventDefault();
        setZoomPercent((current) => Math.min(400, current + 25));
      } else if (ctrl && event.key === '-') {
        event.preventDefault();
        setZoomPercent((current) => Math.max(25, current - 25));
      } else if (ctrl && event.key === '0') {
        event.preventDefault();
        setZoomPercent(100);
      } else if (event.key === '1') setMode('view');
      else if (event.key === '2') setMode('additive');
      else if (event.key === '3') setMode('permanent');
      else if (event.key.toLowerCase() === 'r') {
        setMode('permanent');
        setPermanentEdits((current) => ({
          ...current,
          rotation: ((current.rotation + 90) % 360) as PermanentImageEdits['rotation'],
        }));
      } else if (event.key.toLowerCase() === 'c') beginCrop();
      else if (event.key === 'Escape' && cropMode) cancelCrop();
    };
    document.addEventListener('keydown', handleKeyDown, { capture: true });
    return () => document.removeEventListener('keydown', handleKeyDown, { capture: true });
  }, [
    beginCrop,
    cancelCrop,
    cropMode,
    dialogOpen,
    setMode,
    setPermanentEdits,
    setZoomPercent,
    viewportRef,
  ]);

  const handleCropPointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (!cropMode) return;
      const point = getRelativePoint(event, event.currentTarget.getBoundingClientRect());
      setCropDragStart(point);
      setCropInteraction({ mode: 'draw', startPointer: point });
      setCropDraft({
        x: point.x * rotatedDimensions.width,
        y: point.y * rotatedDimensions.height,
        width: 1,
        height: 1,
      });
    },
    [cropMode, rotatedDimensions, setCropDraft, setCropDragStart, setCropInteraction],
  );

  const handleCropPointerMove = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (!cropMode || !cropDragStart) return;
      const point = getRelativePoint(event, event.currentTarget.getBoundingClientRect());
      const startX = cropDragStart.x * rotatedDimensions.width;
      const startY = cropDragStart.y * rotatedDimensions.height;
      const endX = point.x * rotatedDimensions.width;
      const endY = point.y * rotatedDimensions.height;
      setCropDraft(
        normalizeCropRect(
          {
            x: Math.min(startX, endX),
            y: Math.min(startY, endY),
            width: Math.abs(endX - startX),
            height: Math.abs(endY - startY),
          },
          rotatedDimensions,
        ),
      );
    },
    [cropDragStart, cropMode, rotatedDimensions, setCropDraft],
  );

  useEffect(() => {
    if (!cropMode || !cropInteraction) return;
    const handleMove = (event: PointerEvent) => {
      const stage = viewportRef.current?.querySelector('[data-image-stage="crop"]');
      if (!(stage instanceof HTMLDivElement)) return;
      const point = getRelativePoint(event, stage.getBoundingClientRect());
      if (cropInteraction.mode === 'draw') {
        const startX = cropInteraction.startPointer.x * rotatedDimensions.width;
        const startY = cropInteraction.startPointer.y * rotatedDimensions.height;
        const endX = point.x * rotatedDimensions.width;
        const endY = point.y * rotatedDimensions.height;
        setCropDraft(
          normalizeCropRect(
            {
              x: Math.min(startX, endX),
              y: Math.min(startY, endY),
              width: Math.abs(endX - startX),
              height: Math.abs(endY - startY),
            },
            rotatedDimensions,
          ),
        );
        return;
      }
      const dx = (point.x - cropInteraction.startPointer.x) * rotatedDimensions.width;
      const dy = (point.y - cropInteraction.startPointer.y) * rotatedDimensions.height;
      const start = cropInteraction.startRect;
      let x = start.x;
      let y = start.y;
      let width = start.width;
      let height = start.height;
      if (cropInteraction.edges.left) {
        x = clamp(start.x + dx, 0, start.x + start.width - 24);
        width = start.width + start.x - x;
      }
      if (cropInteraction.edges.right)
        width = clamp(start.width + dx, 24, rotatedDimensions.width - x);
      if (cropInteraction.edges.top) {
        y = clamp(start.y + dy, 0, start.y + start.height - 24);
        height = start.height + start.y - y;
      }
      if (cropInteraction.edges.bottom)
        height = clamp(start.height + dy, 24, rotatedDimensions.height - y);
      setCropDraft(normalizeCropRect({ x, y, width, height }, rotatedDimensions));
    };
    const handleUp = () => {
      setCropInteraction(null);
      setCropDragStart(null);
    };
    window.addEventListener('pointermove', handleMove);
    window.addEventListener('pointerup', handleUp, { once: true });
    return () => {
      window.removeEventListener('pointermove', handleMove);
      window.removeEventListener('pointerup', handleUp);
    };
  }, [
    cropInteraction,
    cropMode,
    rotatedDimensions,
    setCropDraft,
    setCropDragStart,
    setCropInteraction,
    viewportRef,
  ]);

  const handleResizeChange = useCallback(
    (dimension: 'width' | 'height', value: string) => {
      const parsed = Number.parseInt(value, 10);
      const next = Number.isFinite(parsed) && parsed > 0 ? parsed : null;
      const source = getCropBounds(currentDimensions, permanentEdits);
      const aspect = source.width / source.height;
      setPermanentEdits((current) =>
        dimension === 'width'
          ? {
              ...current,
              resizeWidth: next,
              resizeHeight:
                current.lockAspectRatio && next ? Math.round(next / aspect) : current.resizeHeight,
            }
          : {
              ...current,
              resizeHeight: next,
              resizeWidth:
                current.lockAspectRatio && next ? Math.round(next * aspect) : current.resizeWidth,
            },
      );
    },
    [currentDimensions, permanentEdits, setPermanentEdits],
  );

  return {
    beginCrop,
    resetPermanentEdits,
    applyCrop,
    cancelCrop,
    handleCropPointerDown,
    handleCropPointerMove,
    handleResizeChange,
  };
}
