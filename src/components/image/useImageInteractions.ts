import { useCallback, useEffect } from 'react';

import type {
  ImageArrowOverlay,
  ImageCropRect,
  ImageLineStyle,
  ImageOverlayItem,
  ImageOverlayTool,
  ImagePenOverlay,
  ImageTextOverlay,
  PermanentImageEdits,
} from '../../types/image';
import {
  clamp,
  createEmptyEdits,
  getCropBounds,
  getRelativePoint,
  getTextHeight,
  getTextMinHeight,
  getTextMinWidth,
  getTextWidth,
  normalizeCropRect,
  type Dimensions,
  type Point,
} from './ImageViewUtils';

type ViewerMode = 'view' | 'additive' | 'permanent';
type SaveIntent = 'permanent' | 'flatten' | null;
type TextInteraction =
  | { id: string; mode: 'move'; startPointer: Point; startX: number; startY: number }
  | {
      id: string;
      mode: 'resize';
      edges: { left: boolean; right: boolean; top: boolean; bottom: boolean };
      startPointer: Point;
      startX: number;
      startY: number;
      startWidth: number;
      startHeight: number;
    };
type ArrowInteraction =
  | { id: string; mode: 'move'; startPointer: Point; startStart: Point; startEnd: Point }
  | { id: string; mode: 'start'; startPointer: Point; startStart: Point; startEnd: Point }
  | { id: string; mode: 'end'; startPointer: Point; startStart: Point; startEnd: Point };
type CropInteraction =
  | { mode: 'draw'; startPointer: Point }
  | {
      mode: 'resize';
      edges: { left: boolean; right: boolean; top: boolean; bottom: boolean };
      startPointer: Point;
      startRect: ImageCropRect;
    };

interface UseImageInteractionsOptions {
  viewportRef: React.RefObject<HTMLDivElement | null>;
  textInputRefs: React.RefObject<Record<string, HTMLTextAreaElement | null>>;
  overlayDoc: { items: ImageOverlayItem[] } | null;
  dimensions: Dimensions | null;
  currentDimensions: Dimensions;
  additiveDisplayDimensions: Dimensions;
  rotatedDimensions: Dimensions;
  permanentEdits: PermanentImageEdits;
  cropMode: boolean;
  cropDraft: ImageCropRect | null;
  cropDragStart: Point | null;
  cropInteraction: CropInteraction | null;
  saveIntent: SaveIntent;
  mode: ViewerMode;
  tool: ImageOverlayTool;
  overlayColor: string;
  fontSize: number;
  strokeWidth: number;
  lineStyle: ImageLineStyle;
  selectedItemId: string | null;
  editingTextId: string | null;
  textInteraction: TextInteraction | null;
  arrowInteraction: ArrowInteraction | null;
  setMode: React.Dispatch<React.SetStateAction<ViewerMode>>;
  setTool: React.Dispatch<React.SetStateAction<ImageOverlayTool>>;
  setOverlayItems: (updater: (items: ImageOverlayItem[]) => ImageOverlayItem[]) => void;
  setSelectedItemId: React.Dispatch<React.SetStateAction<string | null>>;
  setEditingTextId: React.Dispatch<React.SetStateAction<string | null>>;
  setDraftArrow: React.Dispatch<React.SetStateAction<ImageArrowOverlay | null>>;
  setDraftStroke: React.Dispatch<React.SetStateAction<ImagePenOverlay | null>>;
  draftArrow: ImageArrowOverlay | null;
  draftStroke: ImagePenOverlay | null;
  setPermanentEdits: React.Dispatch<React.SetStateAction<PermanentImageEdits>>;
  setCropMode: React.Dispatch<React.SetStateAction<boolean>>;
  setCropDraft: React.Dispatch<React.SetStateAction<ImageCropRect | null>>;
  setCropDragStart: React.Dispatch<React.SetStateAction<Point | null>>;
  setCropInteraction: React.Dispatch<React.SetStateAction<CropInteraction | null>>;
  setZoomPercent: React.Dispatch<React.SetStateAction<number>>;
  setTextInteraction: React.Dispatch<React.SetStateAction<TextInteraction | null>>;
  setArrowInteraction: React.Dispatch<React.SetStateAction<ArrowInteraction | null>>;
  createId: () => string;
}

export function useImageInteractions({
  viewportRef,
  textInputRefs,
  overlayDoc,
  dimensions,
  currentDimensions,
  additiveDisplayDimensions,
  rotatedDimensions,
  permanentEdits,
  cropMode,
  cropDraft,
  cropDragStart,
  cropInteraction,
  saveIntent,
  mode,
  tool,
  overlayColor,
  fontSize,
  strokeWidth,
  lineStyle,
  selectedItemId,
  editingTextId,
  textInteraction,
  arrowInteraction,
  setMode,
  setTool,
  setOverlayItems,
  setSelectedItemId,
  setEditingTextId,
  setDraftArrow,
  setDraftStroke,
  draftArrow,
  draftStroke,
  setPermanentEdits,
  setCropMode,
  setCropDraft,
  setCropDragStart,
  setCropInteraction,
  setZoomPercent,
  setTextInteraction,
  setArrowInteraction,
  createId,
}: UseImageInteractionsOptions) {
  const deleteSelectedItem = useCallback(() => {
    if (!selectedItemId) return;
    setOverlayItems((items) => items.filter((item) => item.id !== selectedItemId));
    if (editingTextId === selectedItemId) setEditingTextId(null);
    setSelectedItemId(null);
  }, [editingTextId, selectedItemId, setEditingTextId, setOverlayItems, setSelectedItemId]);

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
    setPermanentEdits((current) => ({ ...current, crop: normalizeCropRect(cropDraft, rotatedDimensions) }));
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

    const isEventInsideImageView = (target: EventTarget | null) => target instanceof Node && viewport.contains(target);
    const isEditableTarget = (target: EventTarget | null) => (
      target instanceof HTMLElement
      && target.matches('input, textarea, [contenteditable="true"], [contenteditable=""], [role="textbox"], [role="combobox"]')
    );

    const handleKeyDown = (event: KeyboardEvent) => {
      const ctrl = event.ctrlKey || event.metaKey;
      if (ctrl) {
        if (event.key === 'ArrowUp' || event.key === '+' || event.key === '=') {
          event.preventDefault();
          setZoomPercent((current) => Math.min(400, current + 25));
          return;
        }

        if (event.key === 'ArrowDown' || event.key === '-') {
          event.preventDefault();
          setZoomPercent((current) => Math.max(25, current - 25));
          return;
        }

        if (event.key === '0') {
          event.preventDefault();
          setZoomPercent(100);
        }
        return;
      }

      if (saveIntent || isEditableTarget(event.target) || event.altKey) return;

      const scrollStep = Math.max(56, viewport.clientHeight * 0.12);
      const scrollViewportBy = (deltaY: number) => {
        viewport.scrollBy({ top: deltaY, behavior: 'smooth' });
      };

      switch (event.key) {
        case '1':
          event.preventDefault();
          setMode('view');
          break;
        case '2':
          event.preventDefault();
          setMode('additive');
          break;
        case '3':
          event.preventDefault();
          setMode('permanent');
          break;
        case 's':
        case 'S':
          if (mode === 'additive') {
            event.preventDefault();
            setTool('select');
          }
          break;
        case 't':
        case 'T':
          if (mode === 'additive') {
            event.preventDefault();
            setTool('text');
          }
          break;
        case 'a':
        case 'A':
          if (mode === 'additive') {
            event.preventDefault();
            setTool('arrow');
          }
          break;
        case 'f':
        case 'F':
          if (mode === 'additive') {
            event.preventDefault();
            setTool('pen');
          }
          break;
        case 'r':
        case 'R':
          event.preventDefault();
          setMode('permanent');
          setPermanentEdits((current) => ({
            ...current,
            rotation: (((current.rotation + 90) % 360) as PermanentImageEdits['rotation']),
          }));
          break;
        case 'c':
        case 'C':
          event.preventDefault();
          beginCrop();
          break;
        case 'l':
        case 'L':
          if (mode === 'permanent') {
            event.preventDefault();
            setPermanentEdits((current) => ({ ...current, lockAspectRatio: !current.lockAspectRatio }));
          }
          break;
        case 'Delete':
        case 'Backspace':
          if (mode === 'additive' && selectedItemId && !editingTextId) {
            event.preventDefault();
            deleteSelectedItem();
          }
          break;
        case 'Escape':
          if (cropMode) {
            event.preventDefault();
            cancelCrop();
          } else if (selectedItemId) {
            event.preventDefault();
            setSelectedItemId(null);
          }
          break;
        case 'ArrowDown':
          if (isEventInsideImageView(event.target) || event.target === document.body) {
            event.preventDefault();
            scrollViewportBy(scrollStep);
          }
          break;
        case 'ArrowUp':
          if (isEventInsideImageView(event.target) || event.target === document.body) {
            event.preventDefault();
            scrollViewportBy(-scrollStep);
          }
          break;
        case '0':
          event.preventDefault();
          setZoomPercent(100);
          break;
      }
    };

    document.addEventListener('keydown', handleKeyDown, { capture: true });
    return () => {
      document.removeEventListener('keydown', handleKeyDown, { capture: true } as EventListenerOptions);
    };
  }, [
    beginCrop,
    cancelCrop,
    cropMode,
    deleteSelectedItem,
    editingTextId,
    mode,
    saveIntent,
    selectedItemId,
    setMode,
    setPermanentEdits,
    setSelectedItemId,
    setTool,
    setZoomPercent,
    viewportRef,
  ]);

  const handleOverlayPointerDown = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (!overlayDoc || !dimensions) return;
    if (tool === 'select') {
      setSelectedItemId(null);
      return;
    }

    const rect = event.currentTarget.getBoundingClientRect();
    const point = getRelativePoint(event, rect);

    if (tool === 'text') {
      const initialWidth = Math.max(0.24, getTextMinWidth(additiveDisplayDimensions));
      const initialHeight = Math.max(0.14, getTextMinHeight(additiveDisplayDimensions));
      const item: ImageTextOverlay = {
        id: createId(),
        type: 'text',
        x: clamp(point.x, 0, 1 - initialWidth),
        y: clamp(point.y, 0, 1 - initialHeight),
        width: initialWidth,
        height: initialHeight,
        text: '',
        color: overlayColor,
        fontSize,
      };
      setOverlayItems((items) => [...items, item]);
      setSelectedItemId(item.id);
      setEditingTextId(item.id);
      return;
    }

    if (tool === 'arrow') {
      const item: ImageArrowOverlay = {
        id: createId(),
        type: 'arrow',
        start: point,
        end: point,
        color: overlayColor,
        strokeWidth,
        lineStyle,
      };
      setDraftArrow(item);
      return;
    }

    const stroke: ImagePenOverlay = {
      id: createId(),
      type: 'pen',
      points: [point],
      color: overlayColor,
      strokeWidth,
    };
    setDraftStroke(stroke);
  }, [
    additiveDisplayDimensions,
    createId,
    dimensions,
    fontSize,
    lineStyle,
    overlayColor,
    overlayDoc,
    setDraftArrow,
    setDraftStroke,
    setEditingTextId,
    setOverlayItems,
    setSelectedItemId,
    strokeWidth,
    tool,
  ]);

  const handleOverlayPointerMove = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    if (draftArrow) {
      setDraftArrow({
        ...draftArrow,
        end: getRelativePoint(event, rect),
      });
    }

    if (draftStroke) {
      setDraftStroke({
        ...draftStroke,
        points: [...draftStroke.points, getRelativePoint(event, rect)],
      });
    }
  }, [draftArrow, draftStroke, setDraftArrow, setDraftStroke]);

  const finishOverlayDraft = useCallback(() => {
    if (draftArrow) {
      setOverlayItems((items) => [...items, draftArrow]);
      setSelectedItemId(draftArrow.id);
      setDraftArrow(null);
    }
    if (draftStroke) {
      setOverlayItems((items) => [...items, draftStroke]);
      setSelectedItemId(draftStroke.id);
      setDraftStroke(null);
    }
  }, [draftArrow, draftStroke, setDraftArrow, setDraftStroke, setOverlayItems, setSelectedItemId]);

  const handleCropPointerDown = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (!cropMode) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const point = getRelativePoint(event, rect);
    setCropDragStart(point);
    setCropInteraction({ mode: 'draw', startPointer: point });
    setCropDraft({
      x: point.x * rotatedDimensions.width,
      y: point.y * rotatedDimensions.height,
      width: 1,
      height: 1,
    });
  }, [cropMode, rotatedDimensions, setCropDraft, setCropDragStart, setCropInteraction]);

  const handleCropPointerMove = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (!cropMode || !cropDragStart) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const point = getRelativePoint(event, rect);
    const startX = cropDragStart.x * rotatedDimensions.width;
    const startY = cropDragStart.y * rotatedDimensions.height;
    const endX = point.x * rotatedDimensions.width;
    const endY = point.y * rotatedDimensions.height;
    setCropDraft(normalizeCropRect({
      x: Math.min(startX, endX),
      y: Math.min(startY, endY),
      width: Math.abs(endX - startX),
      height: Math.abs(endY - startY),
    }, rotatedDimensions));
  }, [cropDragStart, cropMode, rotatedDimensions, setCropDraft]);

  useEffect(() => {
    if (!cropMode || !cropInteraction) return;

    const handleMove = (event: PointerEvent) => {
      const stage = viewportRef.current?.querySelector('[data-image-stage="crop"]') as HTMLDivElement | null;
      if (!stage) return;
      const rect = stage.getBoundingClientRect();
      const point = getRelativePoint(event, rect);

      if (cropInteraction.mode === 'draw') {
        const startX = cropInteraction.startPointer.x * rotatedDimensions.width;
        const startY = cropInteraction.startPointer.y * rotatedDimensions.height;
        const endX = point.x * rotatedDimensions.width;
        const endY = point.y * rotatedDimensions.height;
        setCropDraft(normalizeCropRect({
          x: Math.min(startX, endX),
          y: Math.min(startY, endY),
          width: Math.abs(endX - startX),
          height: Math.abs(endY - startY),
        }, rotatedDimensions));
        return;
      }

      const deltaX = (point.x - cropInteraction.startPointer.x) * rotatedDimensions.width;
      const deltaY = (point.y - cropInteraction.startPointer.y) * rotatedDimensions.height;
      const minSize = 24;
      const startRect = cropInteraction.startRect;
      let nextX = startRect.x;
      let nextY = startRect.y;
      let nextWidth = startRect.width;
      let nextHeight = startRect.height;

      if (cropInteraction.edges.left) {
        const proposedX = clamp(startRect.x + deltaX, 0, startRect.x + startRect.width - minSize);
        nextWidth = startRect.width + (startRect.x - proposedX);
        nextX = proposedX;
      }
      if (cropInteraction.edges.right) {
        nextWidth = clamp(startRect.width + deltaX, minSize, rotatedDimensions.width - nextX);
      }
      if (cropInteraction.edges.top) {
        const proposedY = clamp(startRect.y + deltaY, 0, startRect.y + startRect.height - minSize);
        nextHeight = startRect.height + (startRect.y - proposedY);
        nextY = proposedY;
      }
      if (cropInteraction.edges.bottom) {
        nextHeight = clamp(startRect.height + deltaY, minSize, rotatedDimensions.height - nextY);
      }

      setCropDraft(normalizeCropRect({
        x: nextX,
        y: nextY,
        width: nextWidth,
        height: nextHeight,
      }, rotatedDimensions));
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
  }, [cropInteraction, cropMode, rotatedDimensions, setCropDraft, setCropDragStart, setCropInteraction, viewportRef]);

  const handleResizeChange = useCallback((dimension: 'width' | 'height', value: string) => {
    const parsed = Number.parseInt(value, 10);
    const next = Number.isFinite(parsed) && parsed > 0 ? parsed : null;
    const source = getCropBounds(currentDimensions, permanentEdits);
    const aspect = source.width / source.height;

    setPermanentEdits((current) => {
      if (dimension === 'width') {
        return {
          ...current,
          resizeWidth: next,
          resizeHeight: current.lockAspectRatio && next ? Math.round(next / aspect) : current.resizeHeight,
        };
      }
      return {
        ...current,
        resizeHeight: next,
        resizeWidth: current.lockAspectRatio && next ? Math.round(next * aspect) : current.resizeWidth,
      };
    });
  }, [currentDimensions, permanentEdits, setPermanentEdits]);

  useEffect(() => {
    if (!editingTextId) return;
    const textarea = textInputRefs.current[editingTextId];
    if (!textarea) return;
    textarea.focus();
    const length = textarea.value.length;
    textarea.setSelectionRange(length, length);
  }, [editingTextId, overlayDoc?.items.length, textInputRefs]);

  useEffect(() => {
    if (!textInteraction) return;

    const handleMove = (event: PointerEvent) => {
      const stage = viewportRef.current?.querySelector('[data-image-stage="additive"]') as HTMLDivElement | null;
      if (!stage) return;
      const rect = stage.getBoundingClientRect();
      const pointer = getRelativePoint(event, rect);

      setOverlayItems((items) => items.map((item) => {
        if (item.id !== textInteraction.id || item.type !== 'text') return item;
        if (textInteraction.mode === 'move') {
          const deltaX = pointer.x - textInteraction.startPointer.x;
          const deltaY = pointer.y - textInteraction.startPointer.y;
          return {
            ...item,
            x: clamp(textInteraction.startX + deltaX, 0, 1 - getTextWidth(item)),
            y: clamp(textInteraction.startY + deltaY, 0, 1 - getTextHeight(item)),
          };
        }
        const deltaX = pointer.x - textInteraction.startPointer.x;
        const deltaY = pointer.y - textInteraction.startPointer.y;
        const minWidth = getTextMinWidth(additiveDisplayDimensions);
        const minHeight = getTextMinHeight(additiveDisplayDimensions);
        let nextX = textInteraction.startX;
        let nextY = textInteraction.startY;
        let nextWidth = textInteraction.startWidth;
        let nextHeight = textInteraction.startHeight;

        if (textInteraction.edges.right) {
          nextWidth = clamp(textInteraction.startWidth + deltaX, minWidth, 1 - nextX);
        }
        if (textInteraction.edges.bottom) {
          nextHeight = clamp(textInteraction.startHeight + deltaY, minHeight, 1 - nextY);
        }
        if (textInteraction.edges.left) {
          const proposedX = clamp(textInteraction.startX + deltaX, 0, textInteraction.startX + textInteraction.startWidth - minWidth);
          nextWidth = clamp(textInteraction.startWidth + (textInteraction.startX - proposedX), minWidth, 1);
          nextX = proposedX;
        }
        if (textInteraction.edges.top) {
          const proposedY = clamp(textInteraction.startY + deltaY, 0, textInteraction.startY + textInteraction.startHeight - minHeight);
          nextHeight = clamp(textInteraction.startHeight + (textInteraction.startY - proposedY), minHeight, 1);
          nextY = proposedY;
        }

        return {
          ...item,
          x: clamp(nextX, 0, 1 - nextWidth),
          y: clamp(nextY, 0, 1 - nextHeight),
          width: clamp(nextWidth, minWidth, 1 - clamp(nextX, 0, 1 - nextWidth)),
          height: clamp(nextHeight, minHeight, 1 - clamp(nextY, 0, 1 - nextHeight)),
        };
      }));
    };

    const handleUp = () => setTextInteraction(null);

    window.addEventListener('pointermove', handleMove);
    window.addEventListener('pointerup', handleUp, { once: true });
    return () => {
      window.removeEventListener('pointermove', handleMove);
      window.removeEventListener('pointerup', handleUp);
    };
  }, [additiveDisplayDimensions, setOverlayItems, setTextInteraction, textInteraction, viewportRef]);

  useEffect(() => {
    if (!arrowInteraction) return;

    const handleMove = (event: PointerEvent) => {
      const stage = viewportRef.current?.querySelector('[data-image-stage="additive"]') as HTMLDivElement | null;
      if (!stage) return;
      const rect = stage.getBoundingClientRect();
      const pointer = getRelativePoint(event, rect);
      const deltaX = pointer.x - arrowInteraction.startPointer.x;
      const deltaY = pointer.y - arrowInteraction.startPointer.y;

      setOverlayItems((items) => items.map((item) => {
        if (item.id !== arrowInteraction.id || item.type !== 'arrow') return item;
        if (arrowInteraction.mode === 'move') {
          const nextStart = {
            x: clamp(arrowInteraction.startStart.x + deltaX, 0, 1),
            y: clamp(arrowInteraction.startStart.y + deltaY, 0, 1),
          };
          const nextEnd = {
            x: clamp(arrowInteraction.startEnd.x + deltaX, 0, 1),
            y: clamp(arrowInteraction.startEnd.y + deltaY, 0, 1),
          };
          const correctionX =
            (arrowInteraction.startStart.x + deltaX < 0 ? -(arrowInteraction.startStart.x + deltaX) : 0) ||
            (arrowInteraction.startEnd.x + deltaX > 1 ? 1 - (arrowInteraction.startEnd.x + deltaX) : 0) ||
            (arrowInteraction.startEnd.x + deltaX < 0 ? -(arrowInteraction.startEnd.x + deltaX) : 0) ||
            (arrowInteraction.startStart.x + deltaX > 1 ? 1 - (arrowInteraction.startStart.x + deltaX) : 0);
          const correctionY =
            (arrowInteraction.startStart.y + deltaY < 0 ? -(arrowInteraction.startStart.y + deltaY) : 0) ||
            (arrowInteraction.startEnd.y + deltaY > 1 ? 1 - (arrowInteraction.startEnd.y + deltaY) : 0) ||
            (arrowInteraction.startEnd.y + deltaY < 0 ? -(arrowInteraction.startEnd.y + deltaY) : 0) ||
            (arrowInteraction.startStart.y + deltaY > 1 ? 1 - (arrowInteraction.startStart.y + deltaY) : 0);
          return {
            ...item,
            start: { x: clamp(nextStart.x + correctionX, 0, 1), y: clamp(nextStart.y + correctionY, 0, 1) },
            end: { x: clamp(nextEnd.x + correctionX, 0, 1), y: clamp(nextEnd.y + correctionY, 0, 1) },
          };
        }

        return arrowInteraction.mode === 'start'
          ? { ...item, start: pointer }
          : { ...item, end: pointer };
      }));
    };

    const handleUp = () => setArrowInteraction(null);

    window.addEventListener('pointermove', handleMove);
    window.addEventListener('pointerup', handleUp, { once: true });
    return () => {
      window.removeEventListener('pointermove', handleMove);
      window.removeEventListener('pointerup', handleUp);
    };
  }, [arrowInteraction, setArrowInteraction, setOverlayItems, viewportRef]);

  return {
    beginCrop,
    resetPermanentEdits,
    applyCrop,
    cancelCrop,
    handleOverlayPointerDown,
    handleOverlayPointerMove,
    finishOverlayDraft,
    handleCropPointerDown,
    handleCropPointerMove,
    handleResizeChange,
    deleteSelectedItem,
  };
}
