import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Check,
  Crop,
  Eraser,
  Image as ImageIcon,
  Minus,
  MoveUpRight,
  Paintbrush,
  PencilLine,
  Plus,
  RotateCw,
  Type,
  X,
} from 'lucide-react';
import { toast } from 'sonner';
import { tauriCommands } from '../lib/tauri';
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
  ImageTextOverlay,
  PermanentImageEdits,
} from '../types/image';
import { cn } from '../lib/utils';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../components/ui/dialog';
import {
  Popover,
  PopoverContent,
  PopoverDescription,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger,
} from '../components/ui/popover';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../components/ui/select';
import {
  DocumentTopBar,
  documentTopBarGroupClass,
  getDocumentBaseName,
  getDocumentFolderPath,
} from '../components/layout/DocumentTopBar';

interface Props {
  relativePath: string | null;
}

type ViewerMode = 'view' | 'additive' | 'permanent';
type SaveIntent = 'permanent' | 'flatten' | null;
type Point = { x: number; y: number };
type Dimensions = { width: number; height: number };
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

const EMPTY_SIZE: Dimensions = { width: 1, height: 1 };

function createEmptyEdits(): PermanentImageEdits {
  return {
    rotation: 0,
    crop: null,
    resizeWidth: null,
    resizeHeight: null,
    lockAspectRatio: true,
  };
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function fitWithin(container: Dimensions, intrinsic: Dimensions): Dimensions {
  if (container.width <= 0 || container.height <= 0 || intrinsic.width <= 0 || intrinsic.height <= 0) {
    return EMPTY_SIZE;
  }

  const scale = Math.min(container.width / intrinsic.width, container.height / intrinsic.height);
  return {
    width: Math.max(1, Math.round(intrinsic.width * scale)),
    height: Math.max(1, Math.round(intrinsic.height * scale)),
  };
}

function scaleDimensions(dimensions: Dimensions, scale: number): Dimensions {
  return {
    width: Math.max(1, Math.round(dimensions.width * scale)),
    height: Math.max(1, Math.round(dimensions.height * scale)),
  };
}

function getWorkspaceDimensions(viewport: Dimensions, stage: Dimensions, padding = 48): Dimensions {
  return {
    width: Math.max(stage.width + padding, viewport.width),
    height: Math.max(stage.height + padding, viewport.height),
  };
}

function getExtension(path: string | null): string {
  if (!path) return '';
  const segment = path.split('/').pop() ?? path;
  const dotIndex = segment.lastIndexOf('.');
  return dotIndex === -1 ? '' : segment.slice(dotIndex + 1).toLowerCase();
}

function getBaseName(path: string | null): string {
  if (!path) return 'Image';
  return path.split('/').pop() ?? path;
}

function canOverwriteImageFormat(path: string | null): boolean {
  return ['png', 'jpg', 'jpeg', 'webp'].includes(getExtension(path));
}

function getOutputMime(path: string | null): 'image/png' | 'image/jpeg' | 'image/webp' {
  const ext = getExtension(path);
  if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg';
  if (ext === 'webp') return 'image/webp';
  return 'image/png';
}

function getOutputFileName(path: string | null, mime: string) {
  const fileName = getBaseName(path);
  const dotIndex = fileName.lastIndexOf('.');
  const stem = dotIndex === -1 ? fileName : fileName.slice(0, dotIndex);
  const ext = mime === 'image/jpeg' ? 'jpg' : mime === 'image/webp' ? 'webp' : 'png';
  return `${stem}-edited.${ext}`;
}

function generateId() {
  return Math.random().toString(36).slice(2, 10);
}

function createEmptyOverlayDocument(dimensions: Dimensions): ImageOverlayDocument {
  return {
    version: 1,
    baseWidth: dimensions.width,
    baseHeight: dimensions.height,
    items: [],
    updatedAt: Date.now(),
  };
}

function getTextWidth(item: ImageTextOverlay) {
  return item.width || 0.22;
}

function getTextHeight(item: ImageTextOverlay) {
  return item.height || 0.12;
}

function getTextMinWidth(display: Dimensions) {
  return clamp(120 / Math.max(display.width, 1), 0.12, 0.4);
}

function getTextMinHeight(display: Dimensions) {
  return clamp(56 / Math.max(display.height, 1), 0.08, 0.3);
}

function getRotatedDimensions(dimensions: Dimensions, rotation: PermanentImageEdits['rotation']): Dimensions {
  return rotation === 90 || rotation === 270
    ? { width: dimensions.height, height: dimensions.width }
    : dimensions;
}

function normalizeCropRect(rect: ImageCropRect, bounds: Dimensions): ImageCropRect {
  const x = clamp(rect.x, 0, bounds.width - 1);
  const y = clamp(rect.y, 0, bounds.height - 1);
  const width = clamp(rect.width, 1, bounds.width - x);
  const height = clamp(rect.height, 1, bounds.height - y);
  return { x, y, width, height };
}

function getCropBounds(dimensions: Dimensions, edits: PermanentImageEdits): ImageCropRect {
  const rotated = getRotatedDimensions(dimensions, edits.rotation);
  if (!edits.crop) {
    return { x: 0, y: 0, width: rotated.width, height: rotated.height };
  }
  return normalizeCropRect(edits.crop, rotated);
}

function getPermanentPreviewDimensions(
  dimensions: Dimensions,
  edits: PermanentImageEdits,
  cropMode: boolean,
): Dimensions {
  const rotated = getRotatedDimensions(dimensions, edits.rotation);
  if (cropMode) {
    return rotated;
  }

  const crop = getCropBounds(dimensions, edits);
  return {
    width: edits.resizeWidth ?? crop.width,
    height: edits.resizeHeight ?? crop.height,
  };
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

function getArrowHeadPoints(from: Point, to: Point, size: number) {
  const angle = Math.atan2(to.y - from.y, to.x - from.x);
  return [
    `${to.x},${to.y}`,
    `${to.x - size * Math.cos(angle - Math.PI / 6)},${to.y - size * Math.sin(angle - Math.PI / 6)}`,
    `${to.x - size * Math.cos(angle + Math.PI / 6)},${to.y - size * Math.sin(angle + Math.PI / 6)}`,
  ].join(' ');
}

function getArrowLineEnd(from: Point, to: Point, headSize: number): Point {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const length = Math.hypot(dx, dy);
  if (length === 0) return to;
  const inset = Math.min(headSize * 0.82, length * 0.45);
  return {
    x: to.x - (dx / length) * inset,
    y: to.y - (dy / length) * inset,
  };
}

function getLineDash(style: ImageLineStyle, strokeWidth: number): number[] | undefined {
  if (style === 'dashed') return [strokeWidth * 3, strokeWidth * 2];
  if (style === 'dotted') return [strokeWidth, strokeWidth * 1.75];
  return undefined;
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

function getOverlaySignature(overlay: ImageOverlayDocument | null) {
  return overlay ? JSON.stringify(overlay) : '';
}

function isPermanentDirty(edits: PermanentImageEdits) {
  return (
    edits.rotation !== 0 ||
    edits.crop !== null ||
    edits.resizeWidth !== null ||
    edits.resizeHeight !== null
  );
}

function getRelativePoint(event: PointerEvent | React.PointerEvent, rect: DOMRect): Point {
  return {
    x: clamp((event.clientX - rect.left) / rect.width, 0, 1),
    y: clamp((event.clientY - rect.top) / rect.height, 0, 1),
  };
}

function describeOverlayCount(count: number) {
  if (count === 0) return 'No additive annotations';
  if (count === 1) return '1 additive annotation';
  return `${count} additive annotations`;
}

function getOverlayItemLabel(item: ImageOverlayItem, index: number) {
  if (item.type === 'text') {
    const preview = item.text.trim().split('\n')[0];
    return preview ? `Text: ${preview}` : `Text ${index + 1}`;
  }
  if (item.type === 'arrow') return `Arrow ${index + 1}`;
  return `Freehand ${index + 1}`;
}

function getOverlayItemMeta(item: ImageOverlayItem) {
  if (item.type === 'text') return `${Math.round(item.fontSize)}px text`;
  if (item.type === 'arrow') return `${Math.round(item.strokeWidth)}px ${item.lineStyle} arrow`;
  return `${Math.round(item.strokeWidth)}px stroke, ${item.points.length} points`;
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

  const overlaySignature = useMemo(() => getOverlaySignature(overlayDoc), [overlayDoc]);
  const overlayDirty = overlayLoaded && overlaySignature !== persistedOverlaySignature;
  const permanentDirty = useMemo(() => isPermanentDirty(permanentEdits), [permanentEdits]);
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

  useEffect(() => {
    if (!vault || !relativePath) {
      setSrc(null);
      setImage(null);
      setOverlayDoc(null);
      setDimensions(null);
      setError('No image selected');
      return;
    }

    let cancelled = false;
    setLoading(true);
    setError(null);
    setOverlayLoaded(false);
    setSelectedItemId(null);
    setDraftArrow(null);
    setDraftStroke(null);
    setPermanentEdits(createEmptyEdits());
    setCropMode(false);
    setCropDraft(null);
    setCropDragStart(null);
    setCropInteraction(null);
    setZoomPercent(100);
    setEditingTextId(null);
    setTextInteraction(null);
    setArrowInteraction(null);

    tauriCommands.readNoteAssetDataUrl(vault.path, relativePath)
      .then(async (dataUrl) => {
        const decoded = await loadImage(dataUrl);
        if (cancelled) return;
        const decodedDimensions = { width: decoded.naturalWidth, height: decoded.naturalHeight };
        setSrc(dataUrl);
        setImage(decoded);
        setDimensions(decodedDimensions);
        return { dataUrl, decoded, decodedDimensions };
      })
      .then(async (loaded) => {
        if (!vault || !relativePath || cancelled) return;
        try {
          const overlayContent = await tauriCommands.readImageOverlay(vault.path, relativePath);
          if (cancelled) return;
          const fallback = createEmptyOverlayDocument(loaded?.decodedDimensions ?? EMPTY_SIZE);

          if (!overlayContent) {
            setOverlayDoc(fallback);
            setPersistedOverlaySignature('');
            setOverlayLoaded(true);
            return;
          }

          const parsed = JSON.parse(overlayContent) as ImageOverlayDocument;
          setOverlayDoc(parsed);
          setPersistedOverlaySignature(JSON.stringify(parsed));
          setOverlayLoaded(true);
        } catch (overlayError) {
          if (!cancelled) {
            setOverlayDoc(createEmptyOverlayDocument(loaded?.decodedDimensions ?? EMPTY_SIZE));
            setPersistedOverlaySignature('');
            setOverlayLoaded(true);
            toast.error(`Failed to load additive annotations: ${overlayError}`);
          }
        }
      })
      .catch((loadError) => {
        if (cancelled) return;
        setSrc(null);
        setImage(null);
        setDimensions(null);
        setOverlayDoc(null);
        setOverlayLoaded(false);
        setError(String(loadError));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [vault, relativePath]);

  useEffect(() => {
    if (!dimensions) return;
    if (!overlayDoc) {
      setOverlayDoc(createEmptyOverlayDocument(dimensions));
      return;
    }

    if (overlayDoc.baseWidth === dimensions.width && overlayDoc.baseHeight === dimensions.height) {
      return;
    }

    setOverlayDoc((current) => current ? {
      ...current,
      baseWidth: dimensions.width,
      baseHeight: dimensions.height,
      updatedAt: Date.now(),
    } : createEmptyOverlayDocument(dimensions));
  }, [dimensions?.width, dimensions?.height]);

  useEffect(() => {
    if (!relativePath) return;
    if (overlayDirty || permanentDirty) markDirty(relativePath);
    else markSaved(relativePath, `image:${Date.now()}`);
  }, [relativePath, overlayDirty, permanentDirty, markDirty, markSaved]);

  useEffect(() => {
    if (!vault || !relativePath || !overlayLoaded || !overlayDoc) return;

    const timeout = window.setTimeout(async () => {
      try {
        if (overlayDoc.items.length === 0) {
          await tauriCommands.deleteImageOverlay(vault.path, relativePath);
          setPersistedOverlaySignature('');
        } else {
          const serialized = JSON.stringify({ ...overlayDoc, updatedAt: Date.now() });
          await tauriCommands.writeImageOverlay(vault.path, relativePath, serialized);
          setPersistedOverlaySignature(serialized);
        }
      } catch (saveError) {
        toast.error(`Failed to save additive annotations: ${saveError}`);
      }
    }, 450);

    return () => window.clearTimeout(timeout);
  }, [vault, relativePath, overlayLoaded, overlayDoc]);

  useEffect(() => {
    if (mode !== 'permanent' || !image || !previewCanvasRef.current) return;
    const target = previewCanvasRef.current;
    const rendered = buildPermanentCanvas(image, permanentEdits, {
      ignoreCrop: cropMode,
      ignoreResize: cropMode,
    }).canvas;
    renderCanvasToElement(rendered, target, permanentDisplayDimensions);
  }, [
    mode,
    image,
    permanentEdits,
    cropMode,
    permanentDisplayDimensions.width,
    permanentDisplayDimensions.height,
  ]);

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

  const deleteSelectedItem = () => {
    if (!selectedItemId) return;
    setOverlayItems((items) => items.filter((item) => item.id !== selectedItemId));
    if (editingTextId === selectedItemId) setEditingTextId(null);
    setSelectedItemId(null);
  };

  const beginCrop = () => {
    setMode('permanent');
    setCropMode(true);
    setCropDraft(getCropBounds(currentDimensions, permanentEdits));
  };

  const resetPermanentEdits = () => {
    setPermanentEdits(createEmptyEdits());
    setCropMode(false);
    setCropDraft(null);
    setCropDragStart(null);
  };

  const applyCrop = () => {
    if (!cropDraft) return;
    setPermanentEdits((current) => ({ ...current, crop: normalizeCropRect(cropDraft, rotatedDimensions) }));
    setCropMode(false);
  };

  const cancelCrop = () => {
    setCropMode(false);
    setCropDraft(null);
    setCropDragStart(null);
  };

  const saveImageOutput = async (overwrite: boolean) => {
    if (!vault || !relativePath || !image || !saveIntent) return;

    const renderCanvas = saveIntent === 'flatten'
      ? (() => {
          const canvas = createCanvas(image.naturalWidth, image.naturalHeight);
          const ctx = canvas.getContext('2d');
          ctx?.drawImage(image, 0, 0);
          if (ctx && overlayDoc) {
            drawOverlayToCanvas(ctx, overlayDoc, {
              width: image.naturalWidth,
              height: image.naturalHeight,
            });
          }
          return canvas;
        })()
      : buildPermanentCanvas(image, permanentEdits).canvas;

    const targetMime = overwrite
      ? getOutputMime(relativePath)
      : (saveIntent === 'permanent' ? getOutputMime(relativePath) : 'image/png');
    const dataUrl = renderCanvas.toDataURL(targetMime, targetMime === 'image/jpeg' ? 0.92 : undefined);

    try {
      setSaving(true);
      const savedRelativePath = await tauriCommands.saveGeneratedImage(
        vault.path,
        relativePath,
        dataUrl,
        overwrite,
        overwrite ? undefined : getOutputFileName(relativePath, targetMime),
      );

      if (saveIntent === 'flatten' && overwrite) {
        await tauriCommands.deleteImageOverlay(vault.path, relativePath);
        const emptyDoc = createEmptyOverlayDocument({
          width: image.naturalWidth,
          height: image.naturalHeight,
        });
        setOverlayDoc(emptyDoc);
        setPersistedOverlaySignature('');
        setSelectedItemId(null);
      }

      if (saveIntent === 'permanent') {
        setPermanentEdits(createEmptyEdits());
        setCropMode(false);
        setCropDraft(null);
      }

      await refreshFileTree();

      if (overwrite) {
        const refreshedDataUrl = await tauriCommands.readNoteAssetDataUrl(vault.path, savedRelativePath);
        const refreshedImage = await loadImage(refreshedDataUrl);
        setSrc(refreshedDataUrl);
        setImage(refreshedImage);
        setDimensions({ width: refreshedImage.naturalWidth, height: refreshedImage.naturalHeight });
      } else {
        openTab(savedRelativePath, getBaseName(savedRelativePath), 'image');
      }

      toast.success(overwrite ? 'Image updated' : 'Edited image saved as a new file');
      setSaveIntent(null);
    } catch (saveError) {
      toast.error(`Failed to save image: ${saveError}`);
    } finally {
      setSaving(false);
    }
  };

  const handleOverlayPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
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
        id: generateId(),
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
        id: generateId(),
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
      id: generateId(),
      type: 'pen',
      points: [point],
      color: overlayColor,
      strokeWidth,
    };
    setDraftStroke(stroke);
  };

  const handleOverlayPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
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
  };

  const finishOverlayDraft = () => {
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
  };

  const handleCropPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
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
  };

  const handleCropPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
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
  };

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
  }, [cropMode, cropInteraction, rotatedDimensions.height, rotatedDimensions.width]);

  const handleResizeChange = (dimension: 'width' | 'height', value: string) => {
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
  };

  useEffect(() => {
    if (!editingTextId) return;
    const textarea = textInputRefs.current[editingTextId];
    if (!textarea) return;
    textarea.focus();
    const length = textarea.value.length;
    textarea.setSelectionRange(length, length);
  }, [editingTextId, overlayDoc?.items.length]);

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
  }, [textInteraction, additiveDisplayDimensions]);

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
  }, [arrowInteraction]);

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
            <Popover open={annotationsOpen} onOpenChange={setAnnotationsOpen}>
              <PopoverTrigger asChild>
                <button
                  type="button"
                  className="rounded-full border border-border/50 px-2 py-1 text-[10px] uppercase tracking-wide text-muted-foreground/90 transition-colors app-motion-fast hover:border-primary/40 hover:bg-primary/8 hover:text-foreground"
                >
                  {describeOverlayCount(annotationItems.length)}
                </button>
              </PopoverTrigger>
              <PopoverContent align="end" className="w-96 max-w-[calc(100vw-40px)] p-3">
                <PopoverHeader className="mb-1">
                  <PopoverTitle>Annotations</PopoverTitle>
                  <PopoverDescription>
                    Select an additive annotation or remove it from the image.
                  </PopoverDescription>
                </PopoverHeader>

                {annotationItems.length === 0 ? (
                  <div className="rounded-lg border border-dashed border-border/60 px-3 py-6 text-center text-xs text-muted-foreground">
                    No additive annotations yet.
                  </div>
                ) : (
                  <div className="max-h-80 space-y-2 overflow-y-auto pr-1">
                    {annotationItems.map((item, index) => {
                      const isSelected = item.id === selectedItemId;
                      return (
                        <div
                          key={item.id}
                          className={cn(
                            'flex items-start gap-2 rounded-xl border px-3 py-2 transition-colors app-motion-fast',
                            isSelected
                              ? 'border-primary/45 bg-primary/10'
                              : 'border-border/50 bg-background/45 hover:border-border hover:bg-background/70',
                          )}
                        >
                          <button
                            type="button"
                            className="min-w-0 flex-1 text-left"
                            onClick={() => {
                              setMode('additive');
                              setTool('select');
                              setSelectedItemId(item.id);
                              setAnnotationsOpen(false);
                            }}
                          >
                            <div className="truncate text-sm font-medium text-foreground">
                              {getOverlayItemLabel(item, index)}
                            </div>
                            <div className="mt-0.5 text-[11px] text-muted-foreground">
                              {getOverlayItemMeta(item)}
                            </div>
                          </button>
                          <Button
                            size="sm"
                            variant="ghost"
                            className="h-8 shrink-0 px-2 text-muted-foreground hover:text-destructive"
                            onClick={() => {
                              if (selectedItemId !== item.id) {
                                setSelectedItemId(item.id);
                              }
                              setOverlayItems((items) => items.filter((entry) => entry.id !== item.id));
                              if (selectedItemId === item.id) {
                                setSelectedItemId(null);
                              }
                            }}
                          >
                            <Eraser size={14} />
                          </Button>
                        </div>
                      );
                    })}
                  </div>
                )}
              </PopoverContent>
            </Popover>
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
              <div className={documentTopBarGroupClass}>
                {([
                  ['select', PencilLine, 'Select'],
                  ['text', Type, 'Text'],
                  ['arrow', MoveUpRight, 'Arrow'],
                  ['pen', Paintbrush, 'Freehand'],
                ] as const).map(([nextTool, Icon, label]) => (
                  <Button
                    key={nextTool}
                    size="sm"
                    variant="ghost"
                    className={cn('h-8 gap-1.5 px-2.5 text-xs app-motion-fast', tool === nextTool && 'bg-accent text-accent-foreground')}
                    onClick={() => setTool(nextTool)}
                  >
                    <Icon size={14} />
                    {label}
                  </Button>
                ))}
              </div>

              <label className="ml-2 flex items-center gap-2 rounded-lg border border-border/50 bg-background/40 px-2 py-1 text-[11px]">
                <span>Color</span>
                <Popover
                  open={colorOpen}
                  onOpenChange={(open) => {
                    setColorOpen(open);
                    if (open) setHexDraft(activeColor);
                  }}
                >
                  <PopoverTrigger asChild>
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-7 w-9 border-border/50 bg-background/70 px-1.5"
                    >
                      <span
                        className="h-3.5 w-full rounded-sm border border-black/20"
                        style={{ backgroundColor: activeColor }}
                      />
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent align="start" className="w-auto p-2.5 flex flex-col gap-2">
                    <div className="grid grid-cols-5 gap-2">
                      {OVERLAY_COLORS.map((swatch) => (
                        <button
                          key={swatch}
                          type="button"
                          onClick={() => {
                            setOverlayColor(swatch);
                            if (selectedItem) {
                              updateSelectedItem((item) => ({ ...item, color: swatch } as ImageOverlayItem));
                            }
                          }}
                          className={cn(
                            'h-7 w-7 rounded-full border border-white/10 transition-transform hover:scale-110',
                            activeColor === swatch && 'ring-2 ring-white/60 ring-offset-1 ring-offset-popover',
                          )}
                          style={{ backgroundColor: swatch }}
                        />
                      ))}
                    </div>
                    <div className="border-t border-border/40 pt-2 flex items-center gap-2">
                      <div
                        className="w-6 h-6 shrink-0 rounded-md border border-white/15"
                        style={{ backgroundColor: /^#[0-9a-f]{6}$/i.test(hexDraft) ? hexDraft : activeColor }}
                      />
                      <Input
                        value={hexDraft}
                        onChange={(event) => setHexDraft(event.target.value)}
                        onKeyDown={(event) => {
                          if (event.key === 'Enter') {
                            const value = hexDraft.trim();
                            if (/^#[0-9a-f]{6}$/i.test(value)) {
                              setOverlayColor(value);
                              if (selectedItem) {
                                updateSelectedItem((item) => ({ ...item, color: value } as ImageOverlayItem));
                              }
                            }
                          }
                        }}
                        onBlur={() => {
                          const value = hexDraft.trim();
                          if (/^#[0-9a-f]{6}$/i.test(value)) {
                            setOverlayColor(value);
                            if (selectedItem) {
                              updateSelectedItem((item) => ({ ...item, color: value } as ImageOverlayItem));
                            }
                          }
                        }}
                        placeholder="#rrggbb"
                        className="h-7 w-28 px-2 font-mono text-xs"
                        maxLength={7}
                        spellCheck={false}
                      />
                    </div>
                  </PopoverContent>
                </Popover>
              </label>

              <label className="flex items-center gap-2 rounded-lg border border-border/50 bg-background/40 px-2 py-1 text-[11px]">
                <span>Stroke</span>
                <Input
                  type="number"
                  min={1}
                  max={18}
                  value={selectedStroke?.strokeWidth ?? strokeWidth}
                  className="h-7 w-16"
                  onChange={(event) => {
                    const next = clamp(Number.parseInt(event.target.value, 10) || 1, 1, 18);
                    setStrokeWidth(next);
                    if (selectedItem?.type === 'arrow' || selectedItem?.type === 'pen') {
                      updateSelectedItem((item) => ({ ...item, strokeWidth: next } as ImageOverlayItem));
                    }
                  }}
                />
              </label>

              {selectedItem?.type === 'arrow' && (
                <label className="flex items-center gap-2 rounded-lg border border-border/50 bg-background/40 px-2 py-1 text-[11px]">
                  <span>Line</span>
                  <Select
                    value={selectedItem.lineStyle}
                    onValueChange={(value) => {
                      const next = value as ImageLineStyle;
                      setLineStyle(next);
                      updateSelectedItem((item) => item.type === 'arrow'
                        ? { ...item, lineStyle: next }
                        : item
                      );
                    }}
                  >
                    <SelectTrigger size="sm" className="h-7 bg-background/70 text-xs">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent align="end">
                      <SelectItem value="solid">Solid</SelectItem>
                      <SelectItem value="dashed">Dashed</SelectItem>
                      <SelectItem value="dotted">Dotted</SelectItem>
                    </SelectContent>
                  </Select>
                </label>
              )}

              <label className="flex items-center gap-2 rounded-lg border border-border/50 bg-background/40 px-2 py-1 text-[11px]">
                <span>Text</span>
                <Input
                  type="number"
                  min={10}
                  max={64}
                  value={selectedItem?.type === 'text' ? selectedItem.fontSize : fontSize}
                  className="h-7 w-16"
                  onChange={(event) => {
                    const next = clamp(Number.parseInt(event.target.value, 10) || 12, 10, 64);
                    setFontSize(next);
                    if (selectedItem?.type === 'text') {
                      updateSelectedItem((item) => ({ ...item, fontSize: next } as ImageOverlayItem));
                    }
                  }}
                />
              </label>

              {selectedItem && (
                <Button size="sm" variant="ghost" className="h-8 text-destructive" onClick={deleteSelectedItem}>
                  <Eraser size={14} className="mr-1.5" />
                  Delete selected
                </Button>
              )}

              {hasAdditiveItems && (
                <Button size="sm" variant="secondary" className="h-8" onClick={() => setSaveIntent('flatten')}>
                  Bake Into Image
                </Button>
              )}
            </>
          )}

          {mode === 'permanent' && (
            <>
              <div className="mx-1 h-6 w-px bg-border/50" />
              <Button size="sm" variant="outline" className="h-8" onClick={() => setPermanentEdits((current) => ({
                ...current,
                rotation: (((current.rotation + 90) % 360) as PermanentImageEdits['rotation']),
              }))}>
                <RotateCw size={14} className="mr-1.5" />
                Rotate
              </Button>
              <Button size="sm" variant={cropMode ? 'default' : 'outline'} className="h-8" onClick={beginCrop}>
                <Crop size={14} className="mr-1.5" />
                Crop
              </Button>
              <label className="flex items-center gap-2 rounded-lg border border-border/50 bg-background/40 px-2 py-1 text-[11px]">
                <span>W</span>
                <Input
                  type="number"
                  min={1}
                  value={permanentEdits.resizeWidth ?? ''}
                  className="h-7 w-20"
                  placeholder={String(getCropBounds(currentDimensions, permanentEdits).width)}
                  onChange={(event) => handleResizeChange('width', event.target.value)}
                />
              </label>
              <label className="flex items-center gap-2 rounded-lg border border-border/50 bg-background/40 px-2 py-1 text-[11px]">
                <span>H</span>
                <Input
                  type="number"
                  min={1}
                  value={permanentEdits.resizeHeight ?? ''}
                  className="h-7 w-20"
                  placeholder={String(getCropBounds(currentDimensions, permanentEdits).height)}
                  onChange={(event) => handleResizeChange('height', event.target.value)}
                />
              </label>
              <Button
                size="sm"
                variant={permanentEdits.lockAspectRatio ? 'secondary' : 'outline'}
                className="h-8"
                onClick={() => setPermanentEdits((current) => ({ ...current, lockAspectRatio: !current.lockAspectRatio }))}
              >
                Lock Ratio
              </Button>
              <Button size="sm" variant="ghost" className="h-8" onClick={resetPermanentEdits}>
                Reset
              </Button>
              <Button size="sm" variant="secondary" className="h-8" disabled={!permanentDirty} onClick={() => setSaveIntent('permanent')}>
                Save Changes
              </Button>
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
            <div
              className="relative shrink-0 rounded-xl border border-border/40 bg-background/70 shadow-xl app-fade-scale-in"
              style={additiveCanvasStyle}
            >
              <img
                src={src}
                alt={relativePath ?? 'Image'}
                className="block h-full w-full rounded-xl select-none"
                draggable={false}
              />

              {mode === 'additive' && overlayDoc && (
                <div
                  data-image-stage="additive"
                  className={cn(
                    'absolute inset-0 overflow-hidden rounded-xl',
                    tool === 'text' ? 'cursor-text' : tool === 'select' ? 'cursor-default' : 'cursor-crosshair',
                  )}
                  onPointerDown={handleOverlayPointerDown}
                  onPointerMove={handleOverlayPointerMove}
                  onPointerUp={finishOverlayDraft}
                  onPointerLeave={finishOverlayDraft}
                >
                  <svg className="absolute inset-0 h-full w-full">
                    {overlaySvgItems.map((item) => {
                      if (item.type === 'arrow') {
                        const arrowStart = {
                          x: item.start.x * additiveDisplayDimensions.width,
                          y: item.start.y * additiveDisplayDimensions.height,
                        };
                        const arrowEnd = {
                          x: item.end.x * additiveDisplayDimensions.width,
                          y: item.end.y * additiveDisplayDimensions.height,
                        };
                        const headSize = Math.max(8, item.strokeWidth * 3);
                        const lineEnd = getArrowLineEnd(arrowStart, arrowEnd, headSize);
                        return (
                          <g
                            key={item.id}
                            className="cursor-pointer"
                            onPointerDown={(event) => {
                              event.stopPropagation();
                              setSelectedItemId(item.id);
                              const stage = event.currentTarget.closest('[data-image-stage="additive"]') as HTMLDivElement | null;
                              if (!stage) return;
                              const rect = stage.getBoundingClientRect();
                              setArrowInteraction({
                                id: item.id,
                                mode: 'move',
                                startPointer: getRelativePoint(event, rect),
                                startStart: item.start,
                                startEnd: item.end,
                              });
                            }}
                          >
                            <line
                              x1={arrowStart.x}
                              y1={arrowStart.y}
                              x2={lineEnd.x}
                              y2={lineEnd.y}
                              stroke={item.color}
                              strokeWidth={item.strokeWidth}
                              strokeLinecap="round"
                              strokeDasharray={(getLineDash(item.lineStyle, item.strokeWidth) ?? []).join(' ')}
                            />
                            <polygon
                              points={getArrowHeadPoints(
                                arrowStart,
                                arrowEnd,
                                headSize,
                              )}
                              fill={item.color}
                            />
                            {selectedItemId === item.id && (
                              <>
                                <circle
                                  cx={arrowStart.x}
                                  cy={arrowStart.y}
                                  r="7"
                                  fill="rgb(var(--background))"
                                  stroke="white"
                                  strokeWidth="1.5"
                                  opacity="0.95"
                                  className="cursor-grab"
                                  onPointerDown={(event) => {
                                    event.stopPropagation();
                                    const stage = event.currentTarget.closest('[data-image-stage="additive"]') as HTMLDivElement | null;
                                    if (!stage) return;
                                    const rect = stage.getBoundingClientRect();
                                    setArrowInteraction({
                                      id: item.id,
                                      mode: 'start',
                                      startPointer: getRelativePoint(event, rect),
                                      startStart: item.start,
                                      startEnd: item.end,
                                    });
                                  }}
                                />
                                <circle
                                  cx={arrowEnd.x}
                                  cy={arrowEnd.y}
                                  r="7"
                                  fill="rgb(var(--background))"
                                  stroke="white"
                                  strokeWidth="1.5"
                                  opacity="0.95"
                                  className="cursor-grab"
                                  onPointerDown={(event) => {
                                    event.stopPropagation();
                                    const stage = event.currentTarget.closest('[data-image-stage="additive"]') as HTMLDivElement | null;
                                    if (!stage) return;
                                    const rect = stage.getBoundingClientRect();
                                    setArrowInteraction({
                                      id: item.id,
                                      mode: 'end',
                                      startPointer: getRelativePoint(event, rect),
                                      startStart: item.start,
                                      startEnd: item.end,
                                    });
                                  }}
                                />
                              </>
                            )}
                          </g>
                        );
                      }

                      if (item.type === 'pen') {
                        return (
                          <polyline
                            key={item.id}
                            points={item.points.map((point) => `${point.x * additiveDisplayDimensions.width},${point.y * additiveDisplayDimensions.height}`).join(' ')}
                            fill="none"
                            stroke={item.color}
                            strokeWidth={item.strokeWidth}
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            className="cursor-pointer"
                            onPointerDown={(event) => {
                              event.stopPropagation();
                              setSelectedItemId(item.id);
                            }}
                            opacity={selectedItemId === item.id ? 1 : 0.95}
                          />
                        );
                      }

                      return null;
                    })}
                  </svg>

                  {overlaySvgItems.filter((item): item is ImageTextOverlay => item.type === 'text').map((item) => (
                    <div
                      key={item.id}
                      className={cn(
                        'absolute rounded-md border shadow-lg shadow-black/15',
                        selectedItemId === item.id ? 'ring-1 ring-primary/80 bg-background/70' : 'bg-background/35',
                      )}
                      style={{
                        left: `${item.x * 100}%`,
                        top: `${item.y * 100}%`,
                        width: `${getTextWidth(item) * 100}%`,
                        height: `${getTextHeight(item) * 100}%`,
                        borderColor: selectedItemId === item.id ? 'rgb(var(--primary) / 0.65)' : 'rgb(var(--border) / 0.65)',
                      }}
                      onPointerDown={(event) => {
                        event.stopPropagation();
                        setSelectedItemId(item.id);
                        setEditingTextId(item.id);
                        const target = event.target as HTMLElement;
                        if (target.tagName === 'TEXTAREA' || target.closest('[data-text-resize-handle="true"]')) {
                          return;
                        }
                        const stage = event.currentTarget.closest('[data-image-stage="additive"]') as HTMLDivElement | null;
                        if (!stage) return;
                        const rect = stage.getBoundingClientRect();
                        setTextInteraction({
                          id: item.id,
                          mode: 'move',
                          startPointer: getRelativePoint(event, rect),
                          startX: item.x,
                          startY: item.y,
                        });
                      }}
                    >
                      <textarea
                        ref={(node) => {
                          textInputRefs.current[item.id] = node;
                        }}
                        value={item.text}
                        placeholder="Write here"
                        className="h-full w-full resize-none rounded-md border-0 bg-transparent px-2 py-2 outline-none"
                        style={{
                          color: item.color,
                          fontSize: `${item.fontSize}px`,
                          lineHeight: 1.25,
                        }}
                        onPointerDown={(event) => {
                          event.stopPropagation();
                          setSelectedItemId(item.id);
                          setEditingTextId(item.id);
                        }}
                        onChange={(event) => {
                          const value = event.target.value;
                          setSelectedItemId(item.id);
                          setEditingTextId(item.id);
                          setOverlayItems((items) => items.map((entry) => entry.id === item.id && entry.type === 'text'
                            ? { ...entry, text: value }
                            : entry
                          ));
                        }}
                        onFocus={() => {
                          setSelectedItemId(item.id);
                          setEditingTextId(item.id);
                        }}
                      />
                      {([
                        { key: 'top', className: 'absolute inset-x-2 top-[-3px] h-2 cursor-ns-resize', edges: { left: false, right: false, top: true, bottom: false } },
                        { key: 'bottom', className: 'absolute inset-x-2 bottom-[-3px] h-2 cursor-ns-resize', edges: { left: false, right: false, top: false, bottom: true } },
                        { key: 'left', className: 'absolute inset-y-2 left-[-3px] w-2 cursor-ew-resize', edges: { left: true, right: false, top: false, bottom: false } },
                        { key: 'right', className: 'absolute inset-y-2 right-[-3px] w-2 cursor-ew-resize', edges: { left: false, right: true, top: false, bottom: false } },
                        { key: 'top-left', className: 'absolute left-[-4px] top-[-4px] h-3 w-3 cursor-nwse-resize', edges: { left: true, right: false, top: true, bottom: false } },
                        { key: 'top-right', className: 'absolute right-[-4px] top-[-4px] h-3 w-3 cursor-nesw-resize', edges: { left: false, right: true, top: true, bottom: false } },
                        { key: 'bottom-left', className: 'absolute bottom-[-4px] left-[-4px] h-3 w-3 cursor-nesw-resize', edges: { left: true, right: false, top: false, bottom: true } },
                        { key: 'bottom-right', className: 'absolute bottom-[-4px] right-[-4px] h-3 w-3 cursor-nwse-resize', edges: { left: false, right: true, top: false, bottom: true } },
                      ] as const).map((handle) => (
                        <button
                          key={handle.key}
                          type="button"
                          data-text-resize-handle="true"
                          className={handle.className}
                          onPointerDown={(event) => {
                            event.stopPropagation();
                            const stage = event.currentTarget.closest('[data-image-stage="additive"]') as HTMLDivElement | null;
                            if (!stage) return;
                            const rect = stage.getBoundingClientRect();
                            setSelectedItemId(item.id);
                            setEditingTextId(item.id);
                            setTextInteraction({
                              id: item.id,
                              mode: 'resize',
                              edges: handle.edges,
                              startPointer: getRelativePoint(event, rect),
                              startX: item.x,
                              startY: item.y,
                              startWidth: getTextWidth(item),
                              startHeight: getTextHeight(item),
                            });
                          }}
                        />
                      ))}
                    </div>
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
            <div
              className="relative shrink-0 rounded-xl border border-border/40 bg-background/70 shadow-xl app-fade-scale-in"
              style={{ width: permanentDisplayDimensions.width, height: permanentDisplayDimensions.height }}
            >
              <canvas ref={previewCanvasRef} className="rounded-xl" />

              {cropMode && (
                <div
                  data-image-stage="crop"
                  className="absolute inset-0 cursor-crosshair"
                  onPointerDown={handleCropPointerDown}
                  onPointerMove={handleCropPointerMove}
                  onPointerUp={() => setCropDragStart(null)}
                  onPointerLeave={() => setCropDragStart(null)}
                >
                  <div className="absolute inset-0 bg-black/20 rounded-xl" />
                  {cropDraft && (
                    <div
                      className="absolute rounded-lg border-2 border-primary bg-primary/10 shadow-lg shadow-primary/20"
                      style={cropRectStyle}
                    >
                      {([
                        { key: 'top', className: 'absolute inset-x-2 top-[-4px] h-2 cursor-ns-resize', edges: { left: false, right: false, top: true, bottom: false } },
                        { key: 'bottom', className: 'absolute inset-x-2 bottom-[-4px] h-2 cursor-ns-resize', edges: { left: false, right: false, top: false, bottom: true } },
                        { key: 'left', className: 'absolute inset-y-2 left-[-4px] w-2 cursor-ew-resize', edges: { left: true, right: false, top: false, bottom: false } },
                        { key: 'right', className: 'absolute inset-y-2 right-[-4px] w-2 cursor-ew-resize', edges: { left: false, right: true, top: false, bottom: false } },
                        { key: 'top-left', className: 'absolute left-[-5px] top-[-5px] h-3 w-3 cursor-nwse-resize rounded-full border border-primary/70 bg-background' , edges: { left: true, right: false, top: true, bottom: false } },
                        { key: 'top-right', className: 'absolute right-[-5px] top-[-5px] h-3 w-3 cursor-nesw-resize rounded-full border border-primary/70 bg-background', edges: { left: false, right: true, top: true, bottom: false } },
                        { key: 'bottom-left', className: 'absolute bottom-[-5px] left-[-5px] h-3 w-3 cursor-nesw-resize rounded-full border border-primary/70 bg-background', edges: { left: true, right: false, top: false, bottom: true } },
                        { key: 'bottom-right', className: 'absolute bottom-[-5px] right-[-5px] h-3 w-3 cursor-nwse-resize rounded-full border border-primary/70 bg-background', edges: { left: false, right: true, top: false, bottom: true } },
                      ] as const).map((handle) => (
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
                            setCropInteraction({
                              mode: 'resize',
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
          </div>
        )}
      </div>

      {cropMode && (
        <div className="flex items-center justify-between gap-3 border-t border-border/30 bg-sidebar/30 px-4 py-2 text-xs text-muted-foreground">
          <span>
            Drag to define the crop area on the rotated image.
          </span>
          <div className="flex items-center gap-2">
            <Button size="sm" variant="outline" className="h-8" onClick={cancelCrop}>
              <X size={14} className="mr-1.5" />
              Cancel
            </Button>
            <Button size="sm" className="h-8" onClick={applyCrop} disabled={!cropDraft}>
              <Check size={14} className="mr-1.5" />
              Apply Crop
            </Button>
          </div>
        </div>
      )}

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
