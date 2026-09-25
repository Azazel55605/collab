import { useEffect, useMemo, useRef, useState } from 'react';

import {
  Copy,
  Crop as CropIcon,
  Eye,
  EyeOff,
  FileText,
  Image as ImageIcon,
  Loader2,
  Minus,
  PanelRightClose,
  Plus,
  RefreshCw,
} from 'lucide-react';

import type { SelectableImageOcrWord } from '../components/image/ImageAdditiveStage';
import ImageInkOverlay from '../components/image/ImageInkOverlay';
import { ImageCropFooter, ImagePermanentStage } from '../components/image/ImagePermanentStage';
import { ImagePermanentToolbar } from '../components/image/ImagePermanentToolbar';
import {
  canOverwriteImageFormat,
  createEmptyEdits,
  type Dimensions,
  EMPTY_SIZE,
  fitWithin,
  getBaseName,
  getCropBounds,
  getOutputFileName,
  getOutputMime,
  getPermanentPreviewDimensions,
  getRotatedDimensions,
  getWorkspaceDimensions,
  type Point,
  scaleDimensions,
} from '../components/image/ImageViewUtils';
import { useImageDocumentSession } from '../components/image/useImageDocumentSession';
import {
  type ImageCropInteraction,
  useImageInteractions,
} from '../components/image/useImageInteractions';
import {
  DocumentTopBar,
  documentTopBarGroupClass,
  getDocumentBaseName,
  getDocumentFolderPath,
} from '../components/layout/DocumentTopBar';
import PdfInkToolbar from '../components/pdf/PdfInkToolbar';
import { Button } from '../components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../components/ui/dialog';
import { sceneToSvg } from '../lib/ink/svg';
import { defaultToolState } from '../lib/ink/tools';
import { interactiveCanvasDeviceScale } from '../lib/rendering';
import { cn } from '../lib/utils';
import { imageAnnotationObjectCount, imageAnnotationSurface } from '../lib/viewAnnotations';
import { useDocumentStatusRegistration } from '../store/documentStatusStore';
import { useEditorStore } from '../store/editorStore';
import { useUiStore } from '../store/uiStore';
import { useVaultStore } from '../store/vaultStore';
import type { ImageCropRect, PermanentImageEdits } from '../types/image';
import { INK_UNITS_PER_PX, type InkAnnotationDocument } from '../types/ink';

interface Props {
  relativePath: string | null;
}

type ViewerMode = 'view' | 'additive' | 'permanent';
type SaveIntent = 'permanent' | 'flatten' | null;

type ImageOcrOverlay =
  | { surface: 'additive'; words: SelectableImageOcrWord[] }
  | { surface: 'permanent'; words: SelectableImageOcrWord[] };

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
  croppedCtx?.drawImage(
    rotated,
    crop.x,
    crop.y,
    crop.width,
    crop.height,
    0,
    0,
    crop.width,
    crop.height,
  );

  if (options?.ignoreResize || (!edits.resizeWidth && !edits.resizeHeight)) {
    return { canvas: cropped, sourceSize: rotatedSize };
  }

  const resized = createCanvas(edits.resizeWidth ?? crop.width, edits.resizeHeight ?? crop.height);
  const resizedCtx = resized.getContext('2d');
  resizedCtx?.drawImage(cropped, 0, 0, resized.width, resized.height);
  return { canvas: resized, sourceSize: rotatedSize };
}

function normalizeImageOcrWords(
  result: {
    words?: Array<{ text: string; x0: number; y0: number; x1: number; y1: number }>;
    sourceWidth?: number;
    sourceHeight?: number;
  },
  offset: { left: number; top: number; width: number; height: number } = {
    left: 0,
    top: 0,
    width: 1,
    height: 1,
  },
): SelectableImageOcrWord[] {
  const sourceWidth = Math.max(result.sourceWidth ?? 0, 1);
  const sourceHeight = Math.max(result.sourceHeight ?? 0, 1);
  return (result.words ?? [])
    .map((word) => ({
      text: word.text,
      left: offset.left + (word.x0 / sourceWidth) * offset.width,
      top: offset.top + (word.y0 / sourceHeight) * offset.height,
      width: Math.max(0.001, ((word.x1 - word.x0) / sourceWidth) * offset.width),
      height: Math.max(0.001, ((word.y1 - word.y0) / sourceHeight) * offset.height),
    }))
    .filter((word) => word.text.trim().length > 0);
}

async function drawAnnotationsToCanvas(
  ctx: CanvasRenderingContext2D,
  document: InkAnnotationDocument,
  dimensions: Dimensions,
) {
  const surface = imageAnnotationSurface(document);
  if (!surface || surface.scene.objectOrder.length === 0) return;
  const svg = sceneToSvg(surface.scene, {
    bounds: {
      minX: 0,
      minY: 0,
      maxX: dimensions.width * INK_UNITS_PER_PX,
      maxY: dimensions.height * INK_UNITS_PER_PX,
    },
  });
  const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
  try {
    const overlay = await loadImage(url);
    ctx.drawImage(overlay, 0, 0, dimensions.width, dimensions.height);
  } finally {
    URL.revokeObjectURL(url);
  }
}

function useElementSize<T extends HTMLElement>(ref: { current: T | null }) {
  const [size, setSize] = useState<Dimensions>(EMPTY_SIZE);

  useEffect(() => {
    const element = ref.current;
    if (!element) return;

    const observer = new ResizeObserver(([entry]) => {
      const box = entry.contentRect;
      setSize((current) =>
        current.width === box.width && current.height === box.height
          ? current
          : { width: box.width, height: box.height },
      );
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref]);

  return size;
}

function renderCanvasToElement(
  canvas: HTMLCanvasElement,
  target: HTMLCanvasElement,
  display: Dimensions,
) {
  const dpr = interactiveCanvasDeviceScale(display.width, display.height);
  const pixelWidth = Math.max(1, Math.round(display.width * dpr));
  const pixelHeight = Math.max(1, Math.round(display.height * dpr));
  if (target.width !== pixelWidth) target.width = pixelWidth;
  if (target.height !== pixelHeight) target.height = pixelHeight;
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

export default function ImageView({ relativePath }: Props) {
  const { vault, refreshFileTree } = useVaultStore();
  const { openTab, markDirty, markSaved } = useEditorStore();
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const previewCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const overlayViewportSize = useElementSize(viewportRef);

  const [mode, setMode] = useState<ViewerMode>('view');
  const [src, setSrc] = useState<string | null>(null);
  const [image, setImage] = useState<HTMLImageElement | null>(null);
  const [dimensions, setDimensions] = useState<Dimensions | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [annotationDoc, setAnnotationDoc] = useState<InkAnnotationDocument | null>(null);
  const [annotationsLoaded, setAnnotationsLoaded] = useState(false);
  const [inkTool, setInkTool] = useState(defaultToolState);
  const [permanentEdits, setPermanentEdits] = useState<PermanentImageEdits>(createEmptyEdits);
  const [cropMode, setCropMode] = useState(false);
  const [cropDraft, setCropDraft] = useState<ImageCropRect | null>(null);
  const [cropDragStart, setCropDragStart] = useState<Point | null>(null);
  const [cropInteraction, setCropInteraction] = useState<ImageCropInteraction | null>(null);
  const [saveIntent, setSaveIntent] = useState<SaveIntent>(null);
  const [saving, setSaving] = useState(false);
  const [zoomPercent, setZoomPercent] = useState(100);
  const ocrOverlayVisible = useUiStore((state) => state.ocrOverlayVisible);
  const setOcrOverlayVisible = useUiStore((state) => state.setOcrOverlayVisible);
  const [ocrText, setOcrText] = useState('');
  const [ocrConfidence, setOcrConfidence] = useState<number | null>(null);
  const [ocrOpen, setOcrOpen] = useState(false);
  const [ocrLoading, setOcrLoading] = useState(false);
  const [ocrError, setOcrError] = useState<string | null>(null);
  const [ocrProgress, setOcrProgress] = useState<{ progress: number; status: string } | null>(null);
  const [ocrCached, setOcrCached] = useState(false);
  const [lastOcrRegion, setLastOcrRegion] = useState<ImageCropRect | null>(null);
  const [ocrOverlay, setOcrOverlay] = useState<ImageOcrOverlay | null>(null);
  const hasAdditiveItems = imageAnnotationObjectCount(annotationDoc) > 0;
  const hostedImage = vault?.kind === 'hosted';
  const overwriteSupported = !hostedImage && canOverwriteImageFormat(relativePath);
  const currentDimensions = dimensions ?? EMPTY_SIZE;
  const rotatedDimensions = getRotatedDimensions(currentDimensions, permanentEdits.rotation);
  const additiveBaseFittedDimensions = fitWithin(overlayViewportSize, currentDimensions);
  const additiveDisplayDimensions = scaleDimensions(
    additiveBaseFittedDimensions,
    zoomPercent / 100,
  );
  const permanentPreviewDimensions = getPermanentPreviewDimensions(
    currentDimensions,
    permanentEdits,
    cropMode,
  );
  const permanentBaseFittedDimensions = fitWithin(overlayViewportSize, permanentPreviewDimensions);
  const permanentDisplayDimensions = scaleDimensions(
    permanentBaseFittedDimensions,
    zoomPercent / 100,
  );
  const activeDisplayDimensions =
    mode === 'permanent' ? permanentDisplayDimensions : additiveDisplayDimensions;
  const workspaceDimensions = getWorkspaceDimensions(overlayViewportSize, activeDisplayDimensions);

  const {
    annotationStatus,
    canAnnotate,
    permanentDirty,
    saveImageOutput,
    loadRemoteAnnotations,
    keepLocalAnnotations,
  } = useImageDocumentSession({
    vault,
    relativePath,
    refreshFileTree,
    openTab,
    markDirty,
    markSaved,
    mode,
    image,
    dimensions,
    annotationDoc,
    annotationsLoaded,
    permanentEdits,
    cropMode,
    permanentDisplayDimensions,
    saveIntent,
    previewCanvasRef,
    loadImage,
    buildPermanentCanvas,
    renderCanvasToElement,
    drawAnnotationsToCanvas,
    getOutputMime,
    getOutputFileName,
    getBaseName,
    setSrc,
    setImage,
    setDimensions,
    setLoading,
    setError,
    setAnnotationDoc,
    setAnnotationsLoaded,
    setPermanentEdits,
    setCropMode,
    setCropDraft,
    setZoomPercent,
    setSaveIntent,
    setSaving,
  });

  const documentStatus = useMemo(
    () => ({
      status: annotationStatus,
      onLoadRemote: loadRemoteAnnotations,
      onKeepLocal: keepLocalAnnotations,
    }),
    [annotationStatus, keepLocalAnnotations, loadRemoteAnnotations],
  );
  useDocumentStatusRegistration(relativePath, documentStatus);

  const {
    beginCrop,
    resetPermanentEdits,
    applyCrop,
    cancelCrop,
    handleCropPointerDown,
    handleCropPointerMove,
    handleResizeChange,
  } = useImageInteractions({
    viewportRef,
    currentDimensions,
    rotatedDimensions,
    permanentEdits,
    cropMode,
    cropDraft,
    cropDragStart,
    cropInteraction,
    dialogOpen: saveIntent !== null,
    setMode,
    setPermanentEdits,
    setCropMode,
    setCropDraft,
    setCropDragStart,
    setCropInteraction,
    setZoomPercent,
  });

  const cropRectStyle = cropDraft
    ? {
        left: `${(cropDraft.x / rotatedDimensions.width) * 100}%`,
        top: `${(cropDraft.y / rotatedDimensions.height) * 100}%`,
        width: `${(cropDraft.width / rotatedDimensions.width) * 100}%`,
        height: `${(cropDraft.height / rotatedDimensions.height) * 100}%`,
      }
    : undefined;

  useEffect(() => {
    setOcrText('');
    setOcrConfidence(null);
    setOcrError(null);
    setOcrProgress(null);
    setOcrCached(false);
    setLastOcrRegion(null);
    setOcrOverlay(null);
    setOcrOpen(false);
  }, [relativePath, src]);

  const runImageOcr = async (force = false, region: ImageCropRect | null = null) => {
    if (!src) return;
    setOcrOpen(true);
    setOcrLoading(true);
    setOcrError(null);
    setLastOcrRegion(region);
    setOcrOverlay(null);
    setOcrProgress({ progress: 0, status: 'Preparing OCR' });
    try {
      const { recognizeImageText } = await import('../lib/ocr');
      const { hashOcrCacheString } = await import('../lib/ocrCache');
      const sourceHash = await hashOcrCacheString(src);
      let ocrInput: string | HTMLCanvasElement = src;
      if (region && image) {
        const rotated = buildRotatedCanvas(image, permanentEdits.rotation);
        const cropCanvas = createCanvas(region.width, region.height);
        const context = cropCanvas.getContext('2d');
        if (!context) throw new Error('Failed to prepare image region for OCR');
        context.drawImage(
          rotated,
          region.x,
          region.y,
          region.width,
          region.height,
          0,
          0,
          cropCanvas.width,
          cropCanvas.height,
        );
        ocrInput = cropCanvas;
      }
      const result = await recognizeImageText(
        ocrInput,
        (progress, status) => {
          setOcrProgress({ progress, status });
        },
        {
          force,
          cacheScope: {
            kind: region ? 'image-region' : 'image',
            relativePath,
            sourceHash,
            regionX: region?.x ?? null,
            regionY: region?.y ?? null,
            regionWidth: region?.width ?? null,
            regionHeight: region?.height ?? null,
            rotation: region ? permanentEdits.rotation : null,
          },
        },
      );
      setOcrText(result.text);
      setOcrConfidence(result.confidence);
      setOcrError(null);
      setOcrCached(result.cached === true);
      if (region) {
        setOcrOverlay({
          surface: 'permanent',
          words: normalizeImageOcrWords(result, {
            left: region.x / Math.max(rotatedDimensions.width, 1),
            top: region.y / Math.max(rotatedDimensions.height, 1),
            width: region.width / Math.max(rotatedDimensions.width, 1),
            height: region.height / Math.max(rotatedDimensions.height, 1),
          }),
        });
      } else if (mode !== 'permanent') {
        setOcrOverlay({ surface: 'additive', words: normalizeImageOcrWords(result) });
      }
      setOcrProgress(null);
    } catch (reason) {
      setOcrText('');
      setOcrConfidence(null);
      setOcrError(`OCR failed: ${reason}`);
      setOcrCached(false);
      setOcrOverlay(null);
      setOcrProgress(null);
    } finally {
      setOcrLoading(false);
    }
  };

  const copyOcrText = async () => {
    if (!ocrText) return;
    const { copyTextToClipboard } = await import('../lib/ocr');
    await copyTextToClipboard(ocrText);
  };

  return (
    <div className="flex h-full w-full flex-col overflow-hidden bg-background app-document-ready">
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
            {hasAdditiveItems && (
              <span className="text-xs text-muted-foreground">
                {imageAnnotationObjectCount(annotationDoc)} annotations
              </span>
            )}
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
                  className={cn(
                    'h-8 px-2.5 text-xs app-motion-fast',
                    mode === nextMode && 'bg-accent text-accent-foreground',
                  )}
                  onClick={() => setMode(nextMode)}
                >
                  {nextMode === 'view'
                    ? 'View'
                    : nextMode === 'additive'
                      ? 'Additive'
                      : 'Permanent'}
                </Button>
              ))}
            </div>

            {mode === 'additive' && (
              <div className={documentTopBarGroupClass}>
                <PdfInkToolbar tool={inkTool} readOnly={!canAnnotate} onChange={setInkTool} />
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-8 px-2.5 text-xs"
                  disabled={!hasAdditiveItems}
                  onClick={() => setSaveIntent('flatten')}
                >
                  Export baked copy
                </Button>
              </div>
            )}

            {mode === 'permanent' && (
              <>
                <ImagePermanentToolbar
                  cropMode={cropMode}
                  resizeWidth={permanentEdits.resizeWidth}
                  resizeHeight={permanentEdits.resizeHeight}
                  widthPlaceholder={String(getCropBounds(currentDimensions, permanentEdits).width)}
                  heightPlaceholder={String(
                    getCropBounds(currentDimensions, permanentEdits).height,
                  )}
                  lockAspectRatio={permanentEdits.lockAspectRatio}
                  permanentDirty={permanentDirty}
                  onRotate={() =>
                    setPermanentEdits((current) => ({
                      ...current,
                      rotation: ((current.rotation + 90) % 360) as PermanentImageEdits['rotation'],
                    }))
                  }
                  onBeginCrop={beginCrop}
                  onResizeWidthChange={(value) => handleResizeChange('width', value)}
                  onResizeHeightChange={(value) => handleResizeChange('height', value)}
                  onToggleLockRatio={() =>
                    setPermanentEdits((current) => ({
                      ...current,
                      lockAspectRatio: !current.lockAspectRatio,
                    }))
                  }
                  onReset={resetPermanentEdits}
                  onSaveChanges={() => setSaveIntent('permanent')}
                />
              </>
            )}

            <div className={documentTopBarGroupClass}>
              <Button
                size="sm"
                variant="ghost"
                className={cn(
                  'h-8 gap-1.5 px-2.5 text-xs',
                  ocrOpen && 'bg-accent text-accent-foreground',
                )}
                onClick={() => {
                  if (ocrText) {
                    setOcrOpen((current) => !current);
                    return;
                  }
                  void runImageOcr();
                }}
                disabled={!src || ocrLoading}
              >
                {ocrLoading ? (
                  <Loader2 size={14} className="animate-spin" />
                ) : (
                  <FileText size={14} />
                )}
                OCR
              </Button>
              {cropDraft && (
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-8 gap-1.5 px-2.5 text-xs"
                  onClick={() => void runImageOcr(false, cropDraft)}
                  disabled={!src || !image || ocrLoading}
                >
                  {ocrLoading ? (
                    <Loader2 size={14} className="animate-spin" />
                  ) : (
                    <CropIcon size={14} />
                  )}
                  OCR crop
                </Button>
              )}
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
          This image has additive annotations. Use{' '}
          <span className="font-medium text-foreground">Bake Into Image</span> in additive mode if
          you want them permanently merged into the raster output.
        </div>
      )}

      <div
        ref={viewportRef}
        className="relative flex-1 overflow-auto bg-[radial-gradient(circle_at_1px_1px,rgba(255,255,255,0.08)_1px,transparent_0)] [background-size:18px_18px]"
      >
        {ocrOpen && (
          <div className="absolute right-4 top-4 z-30 w-[min(360px,calc(100%-2rem))] rounded-xl border border-border/60 bg-popover/95 p-3 shadow-2xl shadow-black/25 backdrop-blur-sm-webkit app-panel-enter">
            <div className="mb-2 flex items-start justify-between gap-3">
              <div>
                <div className="text-sm font-medium">Recognized text</div>
                <div className="text-xs text-muted-foreground">
                  {ocrLoading && ocrProgress
                    ? `${ocrProgress.status} · ${Math.round(ocrProgress.progress * 100)}%`
                    : ocrError
                      ? 'OCR failed'
                      : ocrConfidence != null
                        ? `${ocrCached ? 'Cached · ' : ''}Confidence ${Math.round(ocrConfidence)}%`
                        : 'Image OCR'}
                </div>
              </div>
              <div className="flex items-center gap-1">
                {(ocrOverlay?.words.length ?? 0) > 0 && (
                  <Button
                    size="icon"
                    variant="ghost"
                    className={cn('size-8', ocrOverlayVisible && 'text-primary')}
                    onClick={() => setOcrOverlayVisible(!ocrOverlayVisible)}
                    title={
                      ocrOverlayVisible ? 'Hide text boxes on image' : 'Show text boxes on image'
                    }
                  >
                    {ocrOverlayVisible ? <Eye size={14} /> : <EyeOff size={14} />}
                  </Button>
                )}
                <Button
                  size="icon"
                  variant="ghost"
                  className="size-8"
                  disabled={!src || ocrLoading}
                  onClick={() => void runImageOcr(true, lastOcrRegion)}
                  title="Regenerate OCR"
                >
                  <RefreshCw size={14} />
                </Button>
                <Button
                  size="icon"
                  variant="ghost"
                  className="size-8"
                  disabled={!ocrText}
                  onClick={() => void copyOcrText()}
                  title="Copy recognized text"
                >
                  <Copy size={14} />
                </Button>
                <Button
                  size="icon"
                  variant="ghost"
                  className="size-8"
                  onClick={() => setOcrOpen(false)}
                  title="Close OCR panel"
                >
                  <PanelRightClose size={14} />
                </Button>
              </div>
            </div>
            <Button
              size="sm"
              variant="outline"
              className={cn(
                'mb-2 h-8 w-full gap-1.5 text-xs',
                (cropMode || !!cropDraft) && 'border-primary text-primary',
              )}
              disabled={!src || !image || ocrLoading}
              onClick={() => {
                if (cropDraft) {
                  void runImageOcr(false, cropDraft);
                } else {
                  beginCrop();
                }
              }}
              title="OCR a selected region of the image"
            >
              <CropIcon size={14} />
              {cropDraft
                ? 'OCR selected region'
                : cropMode
                  ? 'Drag to select a region…'
                  : 'Region OCR'}
            </Button>
            {ocrLoading && (
              <div className="h-1 overflow-hidden rounded-full bg-muted">
                <div
                  className="h-full bg-primary transition-all"
                  style={{ width: `${Math.round((ocrProgress?.progress ?? 0) * 100)}%` }}
                />
              </div>
            )}
            {!ocrLoading && (
              <textarea
                readOnly
                value={ocrError ?? (ocrText || 'No text recognized.')}
                className={cn(
                  'mt-2 h-48 w-full resize-none rounded-lg border border-input bg-background/70 px-3 py-2 text-xs leading-relaxed outline-none',
                  ocrError && 'border-destructive/40 text-destructive',
                )}
              />
            )}
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
            <div
              className="relative overflow-hidden rounded-sm bg-black/20 shadow-2xl"
              style={{
                width: additiveDisplayDimensions.width,
                height: additiveDisplayDimensions.height,
              }}
              data-image-stage="additive"
            >
              <img
                src={src}
                alt={relativePath ?? 'Image'}
                draggable={false}
                className="absolute inset-0 size-full select-none object-fill"
              />
              {annotationDoc && (
                <ImageInkOverlay
                  document={annotationDoc}
                  width={image.naturalWidth}
                  height={image.naturalHeight}
                  displayWidth={additiveDisplayDimensions.width}
                  displayHeight={additiveDisplayDimensions.height}
                  enabled={mode === 'additive'}
                  readOnly={!canAnnotate}
                  tool={inkTool}
                  onChange={setAnnotationDoc}
                />
              )}
              {ocrOverlayVisible && ocrOverlay?.surface === 'additive' && (
                <div className="pointer-events-none absolute inset-0 z-20">
                  {ocrOverlay.words.map((word, index) => (
                    <span
                      key={`${word.text}-${index}`}
                      className="absolute border border-sky-400/70 bg-sky-400/10 text-transparent"
                      style={{
                        left: `${word.left * 100}%`,
                        top: `${word.top * 100}%`,
                        width: `${word.width * 100}%`,
                        height: `${word.height * 100}%`,
                      }}
                    >
                      {word.text}
                    </span>
                  ))}
                </div>
              )}
            </div>
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
              ocrWords={
                ocrOverlayVisible && ocrOverlay?.surface === 'permanent' ? ocrOverlay.words : []
              }
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

      <Dialog
        open={saveIntent !== null}
        onOpenChange={(open) => !open && !saving && setSaveIntent(null)}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>
              {saveIntent === 'flatten'
                ? 'Turn additive changes into permanent edits?'
                : 'Save permanent image changes?'}
            </DialogTitle>
            <DialogDescription>
              {saveIntent === 'flatten'
                ? 'This creates a separate raster copy with annotations baked in. The original image and editable annotation sidecar remain intact.'
                : 'Permanent changes modify the raster output. Overwriting updates the current image; saving as new creates a second file.'}
            </DialogDescription>
          </DialogHeader>

          {saveIntent !== 'flatten' && !overwriteSupported && (
            <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-100/90">
              {hostedImage
                ? 'Hosted images can be saved as a new edited file. Overwriting the original hosted image is not available yet.'
                : 'Overwrite is only available for PNG, JPEG, and WebP files. Other formats can still be saved as a new edited PNG.'}
            </div>
          )}

          <DialogFooter className="border-none bg-transparent -mx-0 -mb-0 px-0 pb-0">
            <Button variant="outline" disabled={saving} onClick={() => setSaveIntent(null)}>
              Cancel
            </Button>
            <Button
              variant="secondary"
              disabled={saving}
              onClick={() => void saveImageOutput(false)}
            >
              Save As New File
            </Button>
            <Button
              disabled={saving || !overwriteSupported || saveIntent === 'flatten'}
              onClick={() => void saveImageOutput(true)}
            >
              Overwrite Original
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
