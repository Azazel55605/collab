import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Image as ImageIcon,
  Minus,
  Plus,
} from 'lucide-react';
import { useEditorStore } from '../store/editorStore';
import { useVaultStore } from '../store/vaultStore';
import type {
  ImageArrowOverlay,
  ImageCropRect,
  ImageOverlayDocument,
  ImageOverlayItem,
  ImageLineStyle,
  ImageOverlayTool,
  ImagePenOverlay,
  PermanentImageEdits,
} from '../types/image';
import { cn } from '../lib/utils';
import { Button } from '../components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../components/ui/dialog';
import {
  DocumentTopBar,
  documentTopBarGroupClass,
  getDocumentBaseName,
  getDocumentFolderPath,
} from '../components/layout/DocumentTopBar';
import { ImageAnnotationsPopover } from '../components/image/ImageAnnotationsPopover';
import { ImageAdditiveToolbar } from '../components/image/ImageAdditiveToolbar';
import { ImageAdditiveStage } from '../components/image/ImageAdditiveStage';
import { ImageCropFooter, ImagePermanentStage } from '../components/image/ImagePermanentStage';
import { ImagePermanentToolbar } from '../components/image/ImagePermanentToolbar';
import { useImageDocumentSession } from '../components/image/useImageDocumentSession';
import { useImageInteractions } from '../components/image/useImageInteractions';
import {
  canOverwriteImageFormat,
  clamp,
  createEmptyEdits,
  createEmptyOverlayDocument,
  EMPTY_SIZE,
  fitWithin,
  getArrowLineEnd,
  getBaseName,
  getCropBounds,
  getLineDash,
  getOutputFileName,
  getOutputMime,
  getPermanentPreviewDimensions,
  getRotatedDimensions,
  getTextWidth,
  getWorkspaceDimensions,
  scaleDimensions,
  type Dimensions,
  type Point,
} from '../components/image/ImageViewUtils';

interface Props {
  relativePath: string | null;
}

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

function generateId() {
  return Math.random().toString(36).slice(2, 10);
}

function loadImage(dataUrl: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('Failed to decode image'));
    image.src = dataUrl;
  });
}

function createCanvas(width: number, height: number) {
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(width));
  canvas.height = Math.max(1, Math.round(height));
  return canvas;
}

function buildRotatedCanvas(image: HTMLImageElement, rotation: PermanentImageEdits['rotation']) {
  const source = { width: image.naturalWidth, height: image.naturalHeight };
  const rotatedSize = getRotatedDimensions(source, rotation);
  const canvas = createCanvas(rotatedSize.width, rotatedSize.height);
  const ctx = canvas.getContext('2d');
  if (!ctx) return canvas;

  if (rotation === 0) {
    ctx.drawImage(image, 0, 0);
    return canvas;
  }

  ctx.save();
  if (rotation === 90) {
    ctx.translate(rotatedSize.width, 0);
    ctx.rotate(Math.PI / 2);
  } else if (rotation === 180) {
    ctx.translate(rotatedSize.width, rotatedSize.height);
    ctx.rotate(Math.PI);
  } else {
    ctx.translate(0, rotatedSize.height);
    ctx.rotate(-Math.PI / 2);
  }
  ctx.drawImage(image, 0, 0);
  ctx.restore();
  return canvas;
}

function buildPermanentCanvas(
  image: HTMLImageElement,
  edits: PermanentImageEdits,
  options?: { ignoreCrop?: boolean; ignoreResize?: boolean },
) {
  const rotated = buildRotatedCanvas(image, edits.rotation);
  const rotatedSize = { width: rotated.width, height: rotated.height };
  const crop = options?.ignoreCrop
    ? { x: 0, y: 0, width: rotated.width, height: rotated.height }
    : getCropBounds({ width: image.naturalWidth, height: image.naturalHeight }, edits);

  const cropped = createCanvas(crop.width, crop.height);
  const croppedCtx = cropped.getContext('2d');
  croppedCtx?.drawImage(rotated, crop.x, crop.y, crop.width, crop.height, 0, 0, crop.width, crop.height);

  if (options?.ignoreResize || (!edits.resizeWidth && !edits.resizeHeight)) {
    return { canvas: cropped, sourceSize: rotatedSize };
  }

  const resized = createCanvas(edits.resizeWidth ?? crop.width, edits.resizeHeight ?? crop.height);
  const resizedCtx = resized.getContext('2d');
  resizedCtx?.drawImage(cropped, 0, 0, resized.width, resized.height);
  return { canvas: resized, sourceSize: rotatedSize };
}

function drawArrowHead(ctx: CanvasRenderingContext2D, from: Point, to: Point, size: number) {
  const angle = Math.atan2(to.y - from.y, to.x - from.x);
  ctx.beginPath();
  ctx.moveTo(to.x, to.y);
  ctx.lineTo(
    to.x - size * Math.cos(angle - Math.PI / 6),
    to.y - size * Math.sin(angle - Math.PI / 6),
  );
  ctx.lineTo(
    to.x - size * Math.cos(angle + Math.PI / 6),
    to.y - size * Math.sin(angle + Math.PI / 6),
  );
  ctx.closePath();
  ctx.fill();
}


function drawOverlayToCanvas(
  ctx: CanvasRenderingContext2D,
  overlay: ImageOverlayDocument | null,
  dimensions: Dimensions,
) {
  if (!overlay) return;

  for (const item of overlay.items) {
    if (item.type === 'text') {
      ctx.fillStyle = item.color;
      ctx.font = `${item.fontSize}px sans-serif`;
      ctx.textBaseline = 'top';
      const x = item.x * dimensions.width;
      const y = item.y * dimensions.height;
      const maxWidth = Math.max(40, getTextWidth(item) * dimensions.width - 12);
      const words = item.text.split(/\s+/).filter(Boolean);
      const lines: string[] = [];
      if (words.length === 0) {
        lines.push('');
      } else {
        let currentLine = '';
        words.forEach((word) => {
          const candidate = currentLine ? `${currentLine} ${word}` : word;
          if (ctx.measureText(candidate).width <= maxWidth || !currentLine) {
            currentLine = candidate;
          } else {
            lines.push(currentLine);
            currentLine = word;
          }
        });
        lines.push(currentLine);
      }
      lines.forEach((line, index) => {
        ctx.fillText(line || ' ', x + 6, y + 6 + index * item.fontSize * 1.25, maxWidth);
      });
      continue;
    }

    if (item.type === 'arrow') {
      const start = {
        x: item.start.x * dimensions.width,
        y: item.start.y * dimensions.height,
      };
      const end = {
        x: item.end.x * dimensions.width,
        y: item.end.y * dimensions.height,
      };
      const headSize = Math.max(8, item.strokeWidth * 3);
      const lineEnd = getArrowLineEnd(start, end, headSize);
      ctx.strokeStyle = item.color;
      ctx.fillStyle = item.color;
      ctx.lineWidth = item.strokeWidth;
      ctx.lineCap = 'round';
      ctx.setLineDash(getLineDash(item.lineStyle, item.strokeWidth) ?? []);
      ctx.beginPath();
      ctx.moveTo(start.x, start.y);
      ctx.lineTo(lineEnd.x, lineEnd.y);
      ctx.stroke();
      ctx.setLineDash([]);
      drawArrowHead(ctx, start, end, headSize);
      continue;
    }

    ctx.strokeStyle = item.color;
    ctx.lineWidth = item.strokeWidth;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.beginPath();
    item.points.forEach((point, index) => {
      const x = point.x * dimensions.width;
      const y = point.y * dimensions.height;
      if (index === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.stroke();
  }
}

function useElementSize<T extends HTMLElement>(ref: { current: T | null }) {
  const [size, setSize] = useState<Dimensions>(EMPTY_SIZE);

  useEffect(() => {
    const element = ref.current;
    if (!element) return;

    const observer = new ResizeObserver(([entry]) => {
      const box = entry.contentRect;
      setSize({ width: box.width, height: box.height });
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref]);

  return size;
}

function renderCanvasToElement(canvas: HTMLCanvasElement, target: HTMLCanvasElement, display: Dimensions) {
  const dpr = window.devicePixelRatio || 1;
  target.width = Math.max(1, Math.round(display.width * dpr));
  target.height = Math.max(1, Math.round(display.height * dpr));
  target.style.width = `${display.width}px`;
  target.style.height = `${display.height}px`;

  const ctx = target.getContext('2d');
  if (!ctx) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, display.width, display.height);
  const fitted = fitWithin(display, { width: canvas.width, height: canvas.height });
  const offsetX = (display.width - fitted.width) / 2;
  const offsetY = (display.height - fitted.height) / 2;
  ctx.drawImage(canvas, offsetX, offsetY, fitted.width, fitted.height);
}

const OVERLAY_COLORS = ['#38bdf8', '#f97316', '#f43f5e', '#22c55e', '#eab308', '#a78bfa', '#64748b', '#f8fafc', '#fb7185', '#34d399'];

export default function ImageView({ relativePath }: Props) {
  const { vault, refreshFileTree } = useVaultStore();
  const { openTab, markDirty, markSaved } = useEditorStore();
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const previewCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const textInputRefs = useRef<Record<string, HTMLTextAreaElement | null>>({});
  const overlayViewportSize = useElementSize(viewportRef);

  const [mode, setMode] = useState<ViewerMode>('view');
  const [src, setSrc] = useState<string | null>(null);
  const [image, setImage] = useState<HTMLImageElement | null>(null);
  const [dimensions, setDimensions] = useState<Dimensions | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [overlayDoc, setOverlayDoc] = useState<ImageOverlayDocument | null>(null);
  const [overlayLoaded, setOverlayLoaded] = useState(false);
  const [persistedOverlaySignature, setPersistedOverlaySignature] = useState('');
  const [tool, setTool] = useState<ImageOverlayTool>('select');
  const [selectedItemId, setSelectedItemId] = useState<string | null>(null);
  const [overlayColor, setOverlayColor] = useState('#38bdf8');
  const [strokeWidth, setStrokeWidth] = useState(4);
  const [lineStyle, setLineStyle] = useState<ImageLineStyle>('solid');
  const [fontSize, setFontSize] = useState(20);
  const [colorOpen, setColorOpen] = useState(false);
  const [hexDraft, setHexDraft] = useState('#38bdf8');
  const [draftArrow, setDraftArrow] = useState<ImageArrowOverlay | null>(null);
  const [draftStroke, setDraftStroke] = useState<ImagePenOverlay | null>(null);
  const [permanentEdits, setPermanentEdits] = useState<PermanentImageEdits>(createEmptyEdits);
  const [cropMode, setCropMode] = useState(false);
  const [cropDraft, setCropDraft] = useState<ImageCropRect | null>(null);
  const [cropDragStart, setCropDragStart] = useState<Point | null>(null);
  const [cropInteraction, setCropInteraction] = useState<CropInteraction | null>(null);
  const [saveIntent, setSaveIntent] = useState<SaveIntent>(null);
  const [saving, setSaving] = useState(false);
  const [zoomPercent, setZoomPercent] = useState(100);
  const [annotationsOpen, setAnnotationsOpen] = useState(false);
  const [editingTextId, setEditingTextId] = useState<string | null>(null);
  const [textInteraction, setTextInteraction] = useState<TextInteraction | null>(null);
  const [arrowInteraction, setArrowInteraction] = useState<ArrowInteraction | null>(null);

  const hasAdditiveItems = (overlayDoc?.items.length ?? 0) > 0;
  const overwriteSupported = canOverwriteImageFormat(relativePath);
  const currentDimensions = dimensions ?? EMPTY_SIZE;
  const rotatedDimensions = getRotatedDimensions(currentDimensions, permanentEdits.rotation);
  const additiveBaseFittedDimensions = fitWithin(overlayViewportSize, currentDimensions);
  const additiveDisplayDimensions = scaleDimensions(additiveBaseFittedDimensions, zoomPercent / 100);
  const permanentPreviewDimensions = getPermanentPreviewDimensions(currentDimensions, permanentEdits, cropMode);
  const permanentBaseFittedDimensions = fitWithin(overlayViewportSize, permanentPreviewDimensions);
  const permanentDisplayDimensions = scaleDimensions(permanentBaseFittedDimensions, zoomPercent / 100);
  const activeDisplayDimensions = mode === 'permanent' ? permanentDisplayDimensions : additiveDisplayDimensions;
  const workspaceDimensions = getWorkspaceDimensions(overlayViewportSize, activeDisplayDimensions);

  const selectedItem = overlayDoc?.items.find((item) => item.id === selectedItemId) ?? null;

  const { permanentDirty, saveImageOutput } = useImageDocumentSession({
    vault,
    relativePath,
    refreshFileTree,
    openTab,
    markDirty,
    markSaved,
    mode,
    image,
    dimensions,
    overlayDoc,
    overlayLoaded,
    persistedOverlaySignature,
    permanentEdits,
    cropMode,
    permanentDisplayDimensions,
    saveIntent,
    previewCanvasRef,
    loadImage,
    createEmptyOverlayDocument,
    buildPermanentCanvas,
    renderCanvasToElement,
    drawOverlayToCanvas,
    getOutputMime,
    getOutputFileName,
    getBaseName,
    setSrc,
    setImage,
    setDimensions,
    setLoading,
    setError,
    setOverlayDoc,
    setOverlayLoaded,
    setPersistedOverlaySignature,
    setSelectedItemId,
    setDraftArrow,
    setDraftStroke,
    setPermanentEdits,
    setCropMode,
    setCropDraft,
    setCropDragStart,
    setCropInteraction,
    setZoomPercent,
    setEditingTextId,
    setTextInteraction,
    setArrowInteraction,
    setSaveIntent,
    setSaving,
  });

  const setOverlayItems = (updater: (items: ImageOverlayItem[]) => ImageOverlayItem[]) => {
    setOverlayDoc((current) => {
      if (!current) return current;
      return {
        ...current,
        items: updater(current.items),
        updatedAt: Date.now(),
      };
    });
  };

  const updateSelectedItem = (updater: (item: ImageOverlayItem) => ImageOverlayItem) => {
    if (!selectedItemId) return;
    setOverlayItems((items) => items.map((item) => item.id === selectedItemId ? updater(item) : item));
  };

  const {
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
  } = useImageInteractions({
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
    createId: generateId,
  });

  const overlaySvgItems = useMemo(() => {
    const items = overlayDoc?.items ?? [];
    return [
      ...items,
      ...(draftArrow ? [draftArrow] : []),
      ...(draftStroke ? [draftStroke] : []),
    ];
  }, [overlayDoc?.items, draftArrow, draftStroke]);

  const additiveCanvasStyle = {
    width: additiveDisplayDimensions.width,
    height: additiveDisplayDimensions.height,
  };

  const cropRectStyle = cropDraft ? {
    left: `${(cropDraft.x / rotatedDimensions.width) * 100}%`,
    top: `${(cropDraft.y / rotatedDimensions.height) * 100}%`,
    width: `${(cropDraft.width / rotatedDimensions.width) * 100}%`,
    height: `${(cropDraft.height / rotatedDimensions.height) * 100}%`,
  } : undefined;

  const selectedStroke = selectedItem?.type === 'arrow' || selectedItem?.type === 'pen' ? selectedItem : null;
  const annotationItems = overlayDoc?.items ?? [];
  const activeColor = selectedItem?.color ?? overlayColor;

  return (
    <div className="flex h-full w-full flex-col overflow-hidden bg-background app-fade-slide-in">
      <DocumentTopBar
        title={getDocumentBaseName(relativePath, 'Image')}
        subtitle={getDocumentFolderPath(relativePath)}
        icon={<ImageIcon size={15} className="text-sky-400/80" />}
        meta={
          <>
            {dimensions && (
              <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
                {dimensions.width} x {dimensions.height}
              </span>
            )}
            <ImageAnnotationsPopover
              open={annotationsOpen}
              onOpenChange={setAnnotationsOpen}
              items={annotationItems}
              selectedItemId={selectedItemId}
              onSelectItem={(id) => {
                setMode('additive');
                setTool('select');
                setSelectedItemId(id);
              }}
              onDeleteItem={(id) => {
                if (selectedItemId !== id) {
                  setSelectedItemId(id);
                }
                setOverlayItems((items) => items.filter((entry) => entry.id !== id));
                if (selectedItemId === id) {
                  setSelectedItemId(null);
                }
              }}
            />
          </>
        }
        secondary={
          <>
          <div className={documentTopBarGroupClass}>
            {(['view', 'additive', 'permanent'] as const).map((nextMode) => (
              <Button
                key={nextMode}
                size="sm"
                variant="ghost"
                className={cn('h-8 px-2.5 text-xs app-motion-fast', mode === nextMode && 'bg-accent text-accent-foreground')}
                onClick={() => setMode(nextMode)}
              >
                {nextMode === 'view' ? 'View' : nextMode === 'additive' ? 'Additive' : 'Permanent'}
              </Button>
            ))}
          </div>

          {mode === 'additive' && (
            <>
              <ImageAdditiveToolbar
                tool={tool}
                onToolChange={setTool}
                activeColor={activeColor}
                overlayColors={OVERLAY_COLORS}
                colorOpen={colorOpen}
                onColorOpenChange={(open) => {
                  setColorOpen(open);
                  if (open) setHexDraft(activeColor);
                }}
                hexDraft={hexDraft}
                onHexDraftChange={setHexDraft}
                onApplyHexColor={() => {
                  const value = hexDraft.trim();
                  if (/^#[0-9a-f]{6}$/i.test(value)) {
                    setOverlayColor(value);
                    if (selectedItem) {
                      updateSelectedItem((item) => ({ ...item, color: value } as ImageOverlayItem));
                    }
                  }
                }}
                onColorSelect={(swatch) => {
                  setOverlayColor(swatch);
                  if (selectedItem) {
                    updateSelectedItem((item) => ({ ...item, color: swatch } as ImageOverlayItem));
                  }
                }}
                strokeWidth={selectedStroke?.strokeWidth ?? strokeWidth}
                onStrokeWidthChange={(value) => {
                  const next = clamp(Number.parseInt(value, 10) || 1, 1, 18);
                  setStrokeWidth(next);
                  if (selectedItem?.type === 'arrow' || selectedItem?.type === 'pen') {
                    updateSelectedItem((item) => ({ ...item, strokeWidth: next } as ImageOverlayItem));
                  }
                }}
                lineStyle={selectedItem?.type === 'arrow' ? selectedItem.lineStyle : null}
                onLineStyleChange={(next) => {
                  setLineStyle(next);
                  updateSelectedItem((item) => item.type === 'arrow'
                    ? { ...item, lineStyle: next }
                    : item
                  );
                }}
                fontSize={selectedItem?.type === 'text' ? selectedItem.fontSize : fontSize}
                onFontSizeChange={(value) => {
                  const next = clamp(Number.parseInt(value, 10) || 12, 10, 64);
                  setFontSize(next);
                  if (selectedItem?.type === 'text') {
                    updateSelectedItem((item) => ({ ...item, fontSize: next } as ImageOverlayItem));
                  }
                }}
                hasSelectedItem={!!selectedItem}
                onDeleteSelected={deleteSelectedItem}
                hasAdditiveItems={hasAdditiveItems}
                onBakeIntoImage={() => setSaveIntent('flatten')}
              />
            </>
          )}

          {mode === 'permanent' && (
            <>
              <ImagePermanentToolbar
                cropMode={cropMode}
                resizeWidth={permanentEdits.resizeWidth}
                resizeHeight={permanentEdits.resizeHeight}
                widthPlaceholder={String(getCropBounds(currentDimensions, permanentEdits).width)}
                heightPlaceholder={String(getCropBounds(currentDimensions, permanentEdits).height)}
                lockAspectRatio={permanentEdits.lockAspectRatio}
                permanentDirty={permanentDirty}
                onRotate={() => setPermanentEdits((current) => ({
                  ...current,
                  rotation: (((current.rotation + 90) % 360) as PermanentImageEdits['rotation']),
                }))}
                onBeginCrop={beginCrop}
                onResizeWidthChange={(value) => handleResizeChange('width', value)}
                onResizeHeightChange={(value) => handleResizeChange('height', value)}
                onToggleLockRatio={() => setPermanentEdits((current) => ({ ...current, lockAspectRatio: !current.lockAspectRatio }))}
                onReset={resetPermanentEdits}
                onSaveChanges={() => setSaveIntent('permanent')}
              />
            </>
          )}

          <div className={documentTopBarGroupClass}>
            <Button
              size="icon"
              variant="ghost"
              className="size-8"
              onClick={() => setZoomPercent((current) => Math.max(25, current - 25))}
              disabled={zoomPercent <= 25}
              title="Zoom out"
            >
              <Minus size={14} />
            </Button>
            <button
              type="button"
              onClick={() => setZoomPercent(100)}
              className="min-w-[86px] rounded-md px-2 text-center text-xs font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
              title="Reset zoom to 100%"
            >
              {zoomPercent}%
            </button>
            <Button
              size="icon"
              variant="ghost"
              className="size-8"
              onClick={() => setZoomPercent((current) => Math.min(400, current + 25))}
              disabled={zoomPercent >= 400}
              title="Zoom in"
            >
              <Plus size={14} />
            </Button>
          </div>
          </>
        }
      />

      {mode === 'permanent' && hasAdditiveItems && (
        <div className="shrink-0 border-b border-border/30 bg-background/72 px-4 py-2 text-[11px] text-muted-foreground">
          This image has additive annotations. Use <span className="font-medium text-foreground">Bake Into Image</span> in additive mode if you want them permanently merged into the raster output.
        </div>
      )}

      <div
        ref={viewportRef}
        className="relative flex-1 overflow-auto bg-[radial-gradient(circle_at_1px_1px,rgba(255,255,255,0.08)_1px,transparent_0)] [background-size:18px_18px]"
      >
        {mode === 'additive' && selectedItem?.type === 'text' && (
          <div className="pointer-events-none absolute inset-x-0 top-4 z-20 flex justify-center px-4">
            <div className="pointer-events-auto w-full max-w-xl rounded-xl border border-border/60 bg-background/88 p-3 shadow-2xl shadow-black/25 backdrop-blur-sm">
              <textarea
                value={selectedItem.text}
                onChange={(event) => {
                  const value = event.target.value;
                  setEditingTextId(selectedItem.id);
                  updateSelectedItem((item) => item.type === 'text'
                    ? { ...item, text: value }
                    : item
                  );
                }}
                className="min-h-20 w-full rounded-lg border border-input bg-background/55 px-3 py-2 text-sm outline-none transition-colors focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
                placeholder="Annotation text"
              />
            </div>
          </div>
        )}

        {loading && (
          <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
            Loading image…
          </div>
        )}

        {!loading && error && (
          <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center text-sm text-muted-foreground">
            <ImageIcon size={28} className="opacity-35" />
            <p>Failed to load image.</p>
            <p className="text-xs opacity-70">{error}</p>
          </div>
        )}

        {!loading && src && image && mode !== 'permanent' && (
          <div
            className="flex items-center justify-center p-6"
            style={{
              width: workspaceDimensions.width,
              height: workspaceDimensions.height,
              minWidth: workspaceDimensions.width,
              minHeight: workspaceDimensions.height,
            }}
          >
            <ImageAdditiveStage
              src={src}
              relativePath={relativePath}
              toolCursor={tool === 'text' ? 'cursor-text' : tool === 'select' ? 'cursor-default' : 'cursor-crosshair'}
              additiveCanvasStyle={additiveCanvasStyle}
              additiveDisplayDimensions={additiveDisplayDimensions}
              overlaySvgItems={overlaySvgItems}
              selectedItemId={selectedItemId}
              textInputRefs={textInputRefs}
              onStagePointerDown={handleOverlayPointerDown}
              onStagePointerMove={handleOverlayPointerMove}
              onStagePointerUp={finishOverlayDraft}
              onStagePointerLeave={finishOverlayDraft}
              onSelectItem={setSelectedItemId}
              onSetEditingTextId={setEditingTextId}
              onStartArrowInteraction={setArrowInteraction}
              onStartTextInteraction={(interaction) => {
                if (interaction.mode === 'move') {
                  setTextInteraction({
                    id: interaction.id,
                    mode: 'move',
                    startPointer: interaction.startPointer,
                    startX: interaction.startX,
                    startY: interaction.startY,
                  });
                  return;
                }
                if (!interaction.edges || typeof interaction.startWidth !== 'number' || typeof interaction.startHeight !== 'number') return;
                setTextInteraction({
                  id: interaction.id,
                  mode: 'resize',
                  edges: interaction.edges,
                  startPointer: interaction.startPointer,
                  startX: interaction.startX,
                  startY: interaction.startY,
                  startWidth: interaction.startWidth,
                  startHeight: interaction.startHeight,
                });
              }}
              onTextChange={(id, value) => {
                setOverlayItems((items) => items.map((entry) => entry.id === id && entry.type === 'text'
                  ? { ...entry, text: value }
                  : entry
                ));
              }}
            />
          </div>
        )}

        {!loading && src && image && mode === 'permanent' && (
          <div
            className="flex items-center justify-center p-6"
            style={{
              width: workspaceDimensions.width,
              height: workspaceDimensions.height,
              minWidth: workspaceDimensions.width,
              minHeight: workspaceDimensions.height,
            }}
          >
            <ImagePermanentStage
              previewCanvasRef={previewCanvasRef}
              displayWidth={permanentDisplayDimensions.width}
              displayHeight={permanentDisplayDimensions.height}
              cropMode={cropMode}
              cropDraft={cropDraft}
              cropRectStyle={cropRectStyle}
              onCropPointerDown={handleCropPointerDown}
              onCropPointerMove={handleCropPointerMove}
              onCropPointerEnd={() => setCropDragStart(null)}
              onCropResizeStart={({ edges, startPointer, startRect }) => {
                setCropInteraction({
                  mode: 'resize',
                  edges,
                  startPointer,
                  startRect,
                });
              }}
            />
          </div>
        )}
      </div>

      <ImageCropFooter
        cropMode={cropMode}
        cropDraft={cropDraft}
        onCancelCrop={cancelCrop}
        onApplyCrop={applyCrop}
      />

      <Dialog open={saveIntent !== null} onOpenChange={(open) => !open && !saving && setSaveIntent(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>
              {saveIntent === 'flatten' ? 'Turn additive changes into permanent edits?' : 'Save permanent image changes?'}
            </DialogTitle>
            <DialogDescription>
              {saveIntent === 'flatten'
                ? 'You can overwrite the current image or create a separate edited file with the annotations baked in.'
                : 'Permanent changes modify the raster output. Overwriting updates the current image; saving as new creates a second file.'}
            </DialogDescription>
          </DialogHeader>

          {!overwriteSupported && (
            <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-100/90">
              Overwrite is only available for PNG, JPEG, and WebP files. Other formats can still be saved as a new edited PNG.
            </div>
          )}

          <DialogFooter className="border-none bg-transparent -mx-0 -mb-0 px-0 pb-0">
            <Button variant="outline" disabled={saving} onClick={() => setSaveIntent(null)}>
              Cancel
            </Button>
            <Button variant="secondary" disabled={saving} onClick={() => void saveImageOutput(false)}>
              Save As New File
            </Button>
            <Button disabled={saving || !overwriteSupported} onClick={() => void saveImageOutput(true)}>
              Overwrite Original
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
