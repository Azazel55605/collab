import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { listen } from '@tauri-apps/api/event';
import {
  Bookmark,
  BookmarkPlus,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Columns2,
  Copy,
  Crop,
  Eye,
  EyeOff,
  FileText,
  Highlighter,
  ImagePlus,
  Loader2,
  Maximize2,
  MessageSquare,
  MessageSquareQuote,
  Minus,
  PanelRightClose,
  PanelRightOpen,
  Plus,
  RefreshCw,
  RotateCw,
  Rows3,
  Trash2,
} from 'lucide-react';
import {
  getDocument,
  GlobalWorkerOptions,
  PixelsPerInch,
  RenderingCancelledException,
  TextLayer,
} from 'pdfjs-dist/legacy/build/pdf.mjs';
import type { PDFDocumentProxy, RenderTask } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { toast } from 'sonner';

import {
  DocumentTopBar,
  documentTopBarGroupClass,
  getDocumentBaseName,
  getDocumentFolderPath,
} from '../components/layout/DocumentTopBar';
import { type PdfSendTarget, PdfSendTargetDialog } from '../components/pdf/PdfSendTargetDialog';
import { Button } from '../components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '../components/ui/dropdown-menu';
import { Input } from '../components/ui/input';
import { Textarea } from '../components/ui/textarea';
import {
  compareDocumentVersions,
  type RemoteCandidate,
  useDocumentSessionController,
} from '../lib/documentSessionController';
import { readOcrCache, writeOcrCache } from '../lib/ocrCache';
import {
  appendMarkdownBlock,
  appendPdfQuoteTextNode,
  appendPdfSnapshotFileNode,
  buildPdfQuoteMarkdown,
  buildPdfSnapshotMarkdown,
} from '../lib/pdfWorkspace';
import { tauriCommands } from '../lib/tauri';
import { cn } from '../lib/utils';
import { createVaultClient } from '../lib/vaultClient';
import type { VaultPdfAnnotations } from '../lib/vaultClient';
import { onReplicaMutated, replicaMutationAffectsPath } from '../lib/vaultReplica';
import { useDocumentStatusRegistration } from '../store/documentStatusStore';
import { useEditorStore } from '../store/editorStore';
import { useUiStore } from '../store/uiStore';
import { useVaultStore } from '../store/vaultStore';
import type { CanvasData } from '../types/canvas';
import type {
  PdfBookmark,
  PdfHighlight,
  PdfHighlightRect,
  PdfPageComment,
  PdfSidecarState,
  PdfTextAnnotation,
} from '../types/pdf';
import { vaultCan } from '../types/vault';

import { enqueuePdfRender } from './pdfRenderQueue';
import {
  buildPdfPageRenderCacheKey,
  buildPdfViewerState,
  type PdfPageRenderCacheEntry,
  resolvePdfBookmarksOpen,
} from './pdfViewSession';
import type { LayoutMode, ZoomMode } from './pdfViewTypes';
import { expandPdfHighlightRects, flattenPdfFiles } from './pdfViewUtils';

const workerUrl = new URL('pdfjs-dist/legacy/build/pdf.worker.mjs', import.meta.url).toString();
GlobalWorkerOptions.workerSrc = workerUrl;

const ZOOM_MIN = 0.5;
const ZOOM_MAX = 3;
const ZOOM_STEP = 0.1;
const DEVICE_SCALE_LIMIT = 2;
const WORKSPACE_PADDING = 40;
const PAGE_GAP = 20;
const OCR_MAX_CANVAS_PIXELS = 24_000_000;

type PdfTextContentItem = {
  str?: string;
  hasEOL?: boolean;
};

function textContentToPlainText(textContent: { items?: unknown[] }): string {
  const chunks: string[] = [];
  for (const item of textContent.items ?? []) {
    if (!item || typeof item !== 'object') continue;
    const textItem = item as PdfTextContentItem;
    if (typeof textItem.str !== 'string' || textItem.str.length === 0) continue;
    chunks.push(textItem.str);
    chunks.push(textItem.hasEOL ? '\n' : ' ');
  }
  return chunks
    .join('')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

async function renderPdfPageForOcr(
  documentProxy: PDFDocumentProxy,
  pageNumber: number,
  scale: number,
  rotation: number,
): Promise<HTMLCanvasElement> {
  const page = await documentProxy.getPage(pageNumber);
  const requestedViewport = page.getViewport({ scale, rotation });
  const requestedPixels = requestedViewport.width * requestedViewport.height;
  const safeScale =
    requestedPixels > OCR_MAX_CANVAS_PIXELS
      ? scale * Math.sqrt(OCR_MAX_CANVAS_PIXELS / requestedPixels)
      : scale;
  const viewport = page.getViewport({ scale: safeScale, rotation });
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.ceil(viewport.width));
  canvas.height = Math.max(1, Math.ceil(viewport.height));
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Failed to prepare PDF page for OCR');
  await page.render({ canvas, canvasContext: context, viewport }).promise;
  return canvas;
}

function cropRenderedPdfRegion(
  canvas: HTMLCanvasElement,
  region: { left: number; top: number; width: number; height: number },
  surfaceSize: { width: number; height: number },
): HTMLCanvasElement {
  const scaleX = canvas.width / Math.max(surfaceSize.width, 1);
  const scaleY = canvas.height / Math.max(surfaceSize.height, 1);
  const cropLeft = Math.max(0, Math.round(region.left * scaleX));
  const cropTop = Math.max(0, Math.round(region.top * scaleY));
  const cropWidth = Math.max(
    1,
    Math.min(Math.round(region.width * scaleX), canvas.width - cropLeft),
  );
  const cropHeight = Math.max(
    1,
    Math.min(Math.round(region.height * scaleY), canvas.height - cropTop),
  );
  const cropCanvas = document.createElement('canvas');
  cropCanvas.width = cropWidth;
  cropCanvas.height = cropHeight;
  const context = cropCanvas.getContext('2d');
  if (!context) throw new Error('Failed to prepare PDF region for OCR');
  context.drawImage(canvas, cropLeft, cropTop, cropWidth, cropHeight, 0, 0, cropWidth, cropHeight);
  return cropCanvas;
}

interface SelectableOcrWord {
  text: string;
  left: number;
  top: number;
  width: number;
  height: number;
}

function normalizeOcrWords(
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
): SelectableOcrWord[] {
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

const PDF_CSS_SCALE = PixelsPerInch.PDF_TO_CSS_UNITS;
const DEFAULT_HIGHLIGHT_COLOR = '#facc15';
const PDF_TEXT_ANNOTATION_STYLES = [
  {
    id: 'sun',
    label: 'Sun',
    backgroundColor: '#fef3c7',
    textColor: '#713f12',
    borderColor: '#f59e0b',
  },
  {
    id: 'sky',
    label: 'Sky',
    backgroundColor: '#dbeafe',
    textColor: '#1e3a8a',
    borderColor: '#3b82f6',
  },
  {
    id: 'rose',
    label: 'Rose',
    backgroundColor: '#ffe4e6',
    textColor: '#881337',
    borderColor: '#f43f5e',
  },
  {
    id: 'mint',
    label: 'Mint',
    backgroundColor: '#dcfce7',
    textColor: '#14532d',
    borderColor: '#22c55e',
  },
  {
    id: 'slate',
    label: 'Slate',
    backgroundColor: '#1e293b',
    textColor: '#f8fafc',
    borderColor: '#475569',
  },
] as const;

function getPdfTextAnnotationPalette(annotation: PdfTextAnnotation) {
  const backgroundColor = annotation.backgroundColor ?? annotation.color ?? '#fef3c7';
  const preset = PDF_TEXT_ANNOTATION_STYLES.find(
    (entry) => entry.backgroundColor === backgroundColor,
  );
  return {
    backgroundColor,
    textColor: annotation.textColor ?? preset?.textColor ?? '#111827',
    borderColor: preset?.borderColor ?? annotation.color ?? '#f59e0b',
  };
}

const EMPTY_PDF_STATE: PdfSidecarState = {
  bookmarks: [],
  highlights: [],
  textAnnotations: [],
  pageComments: [],
  viewerState: null,
};

const pdfPageRenderCache = new Map<string, PdfPageRenderCacheEntry>();

interface WebKitGestureEvent extends Event {
  scale: number;
}

interface SelectionActionState {
  page: number;
  text: string;
  rects: PdfHighlightRect[];
  left: number;
  top: number;
}

interface RegionSelectionState {
  page: number;
  mode: 'snapshot' | 'annotation' | 'ocr';
  startX: number;
  startY: number;
  currentX: number;
  currentY: number;
}

interface AnnotationManipulationState {
  annotationId: string;
  page: number;
  mode: 'move' | 'resize';
  startClientX: number;
  startClientY: number;
  originLeft: number;
  originTop: number;
  originWidth: number;
  originHeight: number;
}

interface PdfOcrOverlay {
  page: number;
  words: SelectableOcrWord[];
}

type PdfOcrRegenerateAction =
  | { kind: 'page'; page: number }
  | {
      kind: 'region';
      page: number;
      region: { left: number; top: number; width: number; height: number };
    };

type PendingSendAction =
  | { mode: 'quote'; page: number; text: string }
  | { mode: 'snapshot'; page: number; dataUrl: string };

function clampZoom(value: number) {
  return Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, value));
}

function dataUrlToUint8Array(dataUrl: string) {
  const [, encoded = ''] = dataUrl.split(',', 2);
  const binary = atob(encoded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function useElementSize<T extends HTMLElement>(ref: { current: T | null }) {
  const [size, setSize] = useState({ width: 0, height: 0 });

  useEffect(() => {
    let observer: ResizeObserver | null = null;
    let frame = 0;

    const attach = () => {
      const element = ref.current;
      if (!element) {
        frame = window.requestAnimationFrame(attach);
        return;
      }

      const rect = element.getBoundingClientRect();
      setSize({ width: rect.width, height: rect.height });

      observer = new ResizeObserver(([entry]) => {
        const { width, height } = entry.contentRect;
        setSize({ width, height });
      });

      observer.observe(element);
    };

    attach();

    return () => {
      if (frame) window.cancelAnimationFrame(frame);
      observer?.disconnect();
    };
  }, [ref]);

  return size;
}

function getTimestamp() {
  return Date.now();
}

function selectionToRegionRect(selection: RegionSelectionState | null) {
  if (!selection) return null;
  return {
    left: Math.min(selection.startX, selection.currentX),
    top: Math.min(selection.startY, selection.currentY),
    width: Math.abs(selection.currentX - selection.startX),
    height: Math.abs(selection.currentY - selection.startY),
  };
}

interface PdfPageCanvasProps {
  documentCacheKey: string;
  documentProxy: PDFDocumentProxy;
  pageNumber: number;
  scale: number;
  rotation: number;
  active: boolean;
  eager: boolean;
  observerRoot: HTMLDivElement | null;
  estimatedSize: { width: number; height: number } | null;
  onMeasured: (pageNumber: number, width: number, height: number) => void;
  registerSurface: (
    pageNumber: number,
    container: HTMLDivElement | null,
    canvas: HTMLCanvasElement | null,
  ) => void;
  highlights: PdfHighlight[];
  textAnnotations: PdfTextAnnotation[];
  selectedHighlightId: string | null;
  selectedTextAnnotationId: string | null;
  onHighlightClick: (highlight: PdfHighlight) => void;
  onTextAnnotationClick: (annotation: PdfTextAnnotation) => void;
  onTextAnnotationPointerDown: (
    annotation: PdfTextAnnotation,
    event: React.PointerEvent<HTMLElement>,
    mode: 'move' | 'resize',
  ) => void;
  regionSelection: RegionSelectionState | null;
  interactionMode: 'none' | 'snapshot' | 'annotation' | 'ocr';
  ocrWords: SelectableOcrWord[];
}

function PdfPageCanvas({
  documentCacheKey,
  documentProxy,
  pageNumber,
  scale,
  rotation,
  active,
  eager,
  observerRoot,
  estimatedSize,
  onMeasured,
  registerSurface,
  highlights,
  textAnnotations,
  selectedHighlightId,
  selectedTextAnnotationId,
  onHighlightClick,
  onTextAnnotationClick,
  onTextAnnotationPointerDown,
  regionSelection,
  interactionMode,
  ocrWords,
}: PdfPageCanvasProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const textLayerRef = useRef<HTMLDivElement | null>(null);
  const renderTaskRef = useRef<RenderTask | null>(null);
  const textLayerTaskRef = useRef<TextLayer | null>(null);
  const hasRenderedRef = useRef(false);
  const [rendering, setRendering] = useState(true);
  const [hasRendered, setHasRendered] = useState(false);
  const [renderError, setRenderError] = useState<string | null>(null);
  const [isNearViewport, setIsNearViewport] = useState(eager);
  const placeholderWidth = estimatedSize
    ? Math.max(120, scale * estimatedSize.width * PDF_CSS_SCALE)
    : 360;
  const placeholderHeight = estimatedSize
    ? Math.max(160, scale * estimatedSize.height * PDF_CSS_SCALE)
    : 480;
  const [displaySize, setDisplaySize] = useState<{ width: number; height: number } | null>(null);
  const [renderSize, setRenderSize] = useState<{ width: number; height: number } | null>(null);
  const cacheKey = useMemo(
    () => buildPdfPageRenderCacheKey(documentCacheKey, pageNumber, scale, rotation),
    [documentCacheKey, pageNumber, rotation, scale],
  );

  useEffect(() => {
    registerSurface(pageNumber, containerRef.current, canvasRef.current);
    return () => registerSurface(pageNumber, null, null);
  }, [pageNumber, registerSurface]);

  useEffect(() => {
    if (eager) {
      setIsNearViewport(true);
      return;
    }

    const element = containerRef.current;
    if (!element || !observerRoot || hasRenderedRef.current) return;

    const observer = new IntersectionObserver(
      (entries) => {
        const entry = entries[0];
        if (entry?.isIntersecting) {
          setIsNearViewport(true);
          observer.disconnect();
        }
      },
      {
        root: observerRoot,
        rootMargin: '800px 0px',
        threshold: 0,
      },
    );

    observer.observe(element);
    return () => observer.disconnect();
  }, [eager, observerRoot]);

  const shouldRender = eager || isNearViewport || hasRendered;

  useEffect(() => {
    let cancelled = false;
    if (renderTaskRef.current) {
      void renderTaskRef.current.promise.catch(() => {});
      renderTaskRef.current.cancel();
    }
    textLayerTaskRef.current?.cancel();
    renderTaskRef.current = null;
    textLayerTaskRef.current = null;

    if (!canvasRef.current || !textLayerRef.current) return;
    if (!shouldRender && !hasRenderedRef.current) {
      setRendering(false);
      return;
    }

    const cachedRender = pdfPageRenderCache.get(cacheKey);
    if (cachedRender) {
      const canvas = canvasRef.current;
      const textLayer = textLayerRef.current;
      const image = new Image();

      image.onload = () => {
        if (cancelled || !canvasRef.current || !textLayerRef.current) return;
        const context = canvas.getContext('2d');
        if (!context) return;

        setDisplaySize({ width: cachedRender.displayWidth, height: cachedRender.displayHeight });
        setRenderSize({ width: cachedRender.renderWidth, height: cachedRender.renderHeight });
        canvas.width = Math.max(1, image.naturalWidth);
        canvas.height = Math.max(1, image.naturalHeight);
        canvas.style.width = `${cachedRender.renderWidth}px`;
        canvas.style.height = `${cachedRender.renderHeight}px`;
        context.setTransform(1, 0, 0, 1, 0, 0);
        context.clearRect(0, 0, canvas.width, canvas.height);
        context.drawImage(image, 0, 0, canvas.width, canvas.height);

        textLayer.replaceChildren();
        textLayer.innerHTML = cachedRender.textLayerHtml;
        textLayer.style.width = `${cachedRender.renderWidth}px`;
        textLayer.style.height = `${cachedRender.renderHeight}px`;
        textLayer.style.setProperty('--user-unit', '1');

        onMeasured(pageNumber, cachedRender.baseWidth, cachedRender.baseHeight);
        hasRenderedRef.current = true;
        setHasRendered(true);
        setRendering(false);
        setRenderError(null);
        registerSurface(pageNumber, containerRef.current, canvasRef.current);
      };

      image.src = cachedRender.dataUrl;
      return () => {
        cancelled = true;
      };
    }

    if (!hasRenderedRef.current) setRendering(true);
    setRenderError(null);

    const renderPage = async () => {
      try {
        await enqueuePdfRender(async () => {
          if (cancelled || !canvasRef.current || !textLayerRef.current) return;

          const page = await documentProxy.getPage(pageNumber);
          if (cancelled || !canvasRef.current || !textLayerRef.current) return;

          const displayScale = scale * PDF_CSS_SCALE;
          const renderScale = Math.max(displayScale, PDF_CSS_SCALE);
          const displayViewport = page.getViewport({ scale: displayScale, rotation });
          const baseViewport = page.getViewport({ scale: 1, rotation: 0 });
          onMeasured(pageNumber, baseViewport.width, baseViewport.height);

          const canvas = canvasRef.current;
          const textLayer = textLayerRef.current;
          const context = canvas.getContext('2d');
          if (!context) throw new Error('Failed to get PDF canvas context');

          const deviceScale = Math.min(window.devicePixelRatio || 1, DEVICE_SCALE_LIMIT);
          const renderViewport = page.getViewport({ scale: renderScale, rotation });
          setDisplaySize({ width: displayViewport.width, height: displayViewport.height });
          setRenderSize({ width: renderViewport.width, height: renderViewport.height });
          canvas.width = Math.max(1, Math.ceil(renderViewport.width * deviceScale));
          canvas.height = Math.max(1, Math.ceil(renderViewport.height * deviceScale));
          canvas.style.width = `${renderViewport.width}px`;
          canvas.style.height = `${renderViewport.height}px`;
          context.setTransform(1, 0, 0, 1, 0, 0);
          context.clearRect(0, 0, canvas.width, canvas.height);
          context.setTransform(deviceScale, 0, 0, deviceScale, 0, 0);
          context.imageSmoothingEnabled = true;

          textLayer.replaceChildren();
          textLayer.style.width = `${renderViewport.width}px`;
          textLayer.style.height = `${renderViewport.height}px`;
          textLayer.style.setProperty('--scale-factor', String(renderScale));
          textLayer.style.setProperty('--total-scale-factor', String(renderScale));
          textLayer.style.setProperty('--user-unit', '1');

          const task = page.render({
            canvas,
            canvasContext: context,
            viewport: renderViewport,
          });
          renderTaskRef.current = task;

          const textContent = await page.getTextContent();
          if (cancelled || !textLayerRef.current) return;

          const textLayerTask = new TextLayer({
            container: textLayer,
            textContentSource: textContent,
            viewport: displayViewport,
          });
          textLayerTaskRef.current = textLayerTask;

          await Promise.all([
            task.promise.catch((error: unknown) => {
              if (error instanceof RenderingCancelledException) return;
              throw error;
            }),
            textLayerTask.render().catch((error: unknown) => {
              if (error instanceof RenderingCancelledException) return;
              throw error;
            }),
          ]);

          pdfPageRenderCache.set(cacheKey, {
            dataUrl: canvas.toDataURL('image/png'),
            textLayerHtml: textLayer.innerHTML,
            displayWidth: displayViewport.width,
            displayHeight: displayViewport.height,
            renderWidth: renderViewport.width,
            renderHeight: renderViewport.height,
            baseWidth: baseViewport.width,
            baseHeight: baseViewport.height,
          });
        });
        if (!cancelled) {
          hasRenderedRef.current = true;
          setHasRendered(true);
          setRendering(false);
          registerSurface(pageNumber, containerRef.current, canvasRef.current);
        }
      } catch (error: unknown) {
        if (cancelled) return;
        if (error instanceof RenderingCancelledException) return;
        const message = error instanceof Error ? error.message : String(error);
        if (message.toLowerCase().includes('rendering cancelled')) return;
        setRendering(false);
        setRenderError(message);
      }
    };

    void renderPage();

    return () => {
      cancelled = true;
      if (renderTaskRef.current) {
        void renderTaskRef.current.promise.catch(() => {});
        renderTaskRef.current.cancel();
      }
      renderTaskRef.current = null;
      textLayerTaskRef.current?.cancel();
      textLayerTaskRef.current = null;
    };
  }, [
    cacheKey,
    documentProxy,
    onMeasured,
    pageNumber,
    registerSurface,
    rotation,
    scale,
    shouldRender,
  ]);

  const visibleWidth = displaySize?.width ?? placeholderWidth;
  const visibleHeight = displaySize?.height ?? placeholderHeight;
  const renderWidth = renderSize?.width ?? visibleWidth;
  const renderHeight = renderSize?.height ?? visibleHeight;
  const shrinkFactor = renderWidth > 0 ? visibleWidth / renderWidth : 1;
  const activeRegionRect =
    regionSelection?.page === pageNumber ? selectionToRegionRect(regionSelection) : null;

  return (
    <div
      ref={containerRef}
      className={cn(
        'relative overflow-hidden rounded-2xl border bg-card shadow-2xl shadow-black/20 transition-[transform,border-color,box-shadow] app-motion-fast',
        active ? 'border-primary/35 shadow-primary/10' : 'border-border/60',
        interactionMode !== 'none' && 'cursor-crosshair',
      )}
      data-pdf-page={pageNumber}
      style={{
        width: `${visibleWidth}px`,
        minWidth: `${visibleWidth}px`,
        minHeight: `${visibleHeight}px`,
        height: `${visibleHeight}px`,
      }}
    >
      <div
        className="absolute left-0 top-0 origin-top-left"
        style={{
          width: `${renderWidth}px`,
          height: `${renderHeight}px`,
          transform: `scale(${shrinkFactor})`,
        }}
      >
        <canvas ref={canvasRef} className="block bg-white" />
        <div ref={textLayerRef} className="pdf-text-layer textLayer" />
      </div>

      {ocrWords.length > 0 && (
        <div
          className="pointer-events-none absolute inset-0 z-[2] select-text"
          aria-label="OCR text layer"
        >
          {ocrWords.map((word, index) => (
            <span
              key={`${word.text}-${index}`}
              className="pointer-events-auto absolute flex cursor-text items-center overflow-hidden whitespace-pre rounded-[2px] border border-primary/45 bg-background/80 px-[1px] text-foreground shadow-sm selection:bg-primary/35"
              style={{
                left: `${word.left * 100}%`,
                top: `${word.top * 100}%`,
                width: `${word.width * 100}%`,
                height: `${word.height * 100}%`,
                fontSize: `${Math.max(6, word.height * visibleHeight * 0.82)}px`,
                lineHeight: 1,
              }}
            >
              {word.text}
            </span>
          ))}
        </div>
      )}

      <div className="pointer-events-none absolute inset-0 z-[3]">
        {expandPdfHighlightRects(highlights).map(({ highlight, rect, index }) => (
          <button
            key={`${highlight.id}-${index}`}
            type="button"
            className={cn(
              'pointer-events-auto absolute rounded-sm border border-amber-400/40 bg-amber-300/30 transition-colors hover:bg-amber-300/45',
              selectedHighlightId === highlight.id && 'bg-amber-300/60 ring-2 ring-amber-300/40',
            )}
            style={{
              left: `${rect.left * 100}%`,
              top: `${rect.top * 100}%`,
              width: `${rect.width * 100}%`,
              height: `${rect.height * 100}%`,
            }}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => onHighlightClick(highlight)}
          />
        ))}
        {textAnnotations.map((annotation) =>
          (() => {
            const palette = getPdfTextAnnotationPalette(annotation);
            return (
              <button
                key={annotation.id}
                type="button"
                className={cn(
                  'pointer-events-auto absolute overflow-hidden rounded-md border px-2 py-1 text-left shadow-sm transition-colors',
                  selectedTextAnnotationId === annotation.id ? 'ring-2 ring-white/35' : '',
                )}
                style={{
                  left: `${annotation.left * 100}%`,
                  top: `${annotation.top * 100}%`,
                  width: `${annotation.width * 100}%`,
                  height: `${annotation.height * 100}%`,
                  backgroundColor: palette.backgroundColor,
                  color: palette.textColor,
                  borderColor: palette.borderColor,
                }}
                onPointerDown={(event) => onTextAnnotationPointerDown(annotation, event, 'move')}
                onClick={() => onTextAnnotationClick(annotation)}
              >
                <div className="line-clamp-6 text-[11px] leading-snug">
                  {annotation.text || 'Text box'}
                </div>
                <span
                  className="absolute bottom-0.5 right-0.5 h-3.5 w-3.5 cursor-se-resize rounded-sm border border-black/10 bg-black/10"
                  onPointerDown={(event) =>
                    onTextAnnotationPointerDown(annotation, event, 'resize')
                  }
                />
              </button>
            );
          })(),
        )}
        {activeRegionRect && (
          <div
            className="absolute border-2 border-primary bg-primary/15"
            style={{
              left: `${activeRegionRect.left}px`,
              top: `${activeRegionRect.top}px`,
              width: `${activeRegionRect.width}px`,
              height: `${activeRegionRect.height}px`,
            }}
          />
        )}
      </div>

      {rendering && !hasRendered && shouldRender && (
        <div className="absolute inset-0 flex items-center justify-center bg-background/28 backdrop-blur-2px-webkit">
          <div className="flex items-center gap-2 rounded-xl border border-border/60 bg-popover/90 px-3 py-2 text-sm text-muted-foreground shadow-lg">
            <Loader2 size={16} className="animate-spin" />
            Rendering page {pageNumber}…
          </div>
        </div>
      )}
      {!hasRendered && !rendering && !renderError && !shouldRender && (
        <div className="absolute inset-0 flex items-center justify-center bg-background/12">
          <div className="rounded-xl border border-border/50 bg-popover/80 px-3 py-1.5 text-xs text-muted-foreground shadow-sm">
            Page {pageNumber} loads when you scroll closer
          </div>
        </div>
      )}
      {renderError && (
        <div className="absolute inset-0 flex items-center justify-center bg-background/70 p-4 text-center text-sm text-destructive">
          {renderError}
        </div>
      )}
      <div className="absolute right-3 bottom-3 rounded-full border border-border/60 bg-popover/90 px-2 py-1 text-[11px] text-muted-foreground shadow-md">
        Page {pageNumber}
      </div>
    </div>
  );
}

interface Props {
  relativePath: string;
}

export default function PdfView({ relativePath }: Props) {
  const { vault, fileTree } = useVaultStore();
  // PDF workspace sidecars live on the local filesystem under .collab/pdf/; hosted
  // vaults have no sidecar endpoint, so viewer state is in-memory only there.
  const supportsSidecars = useMemo(
    () => (vault ? createVaultClient(vault).capabilities.nativeFilesystem : false),
    [vault?.path],
  );
  // Annotation-editing permissions. Local vaults are always fully capable; hosted
  // vaults consult the caller's effective capabilities so commenters/viewers do
  // not attempt writes the server would reject. Page comments need `pdf.comment`;
  // bookmarks/highlights/text annotations need `pdf.annotate`.
  const canComment = useMemo(() => vaultCan(vault, 'pdf.comment'), [vault]);
  const canAnnotate = useMemo(() => vaultCan(vault, 'pdf.annotate'), [vault]);
  const {
    openTabs,
    activeTabPath,
    openTab: openEditorTab,
    setActiveTab,
    setForceReloadPath,
    setRevealEditorPath,
  } = useEditorStore();
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const pageRefs = useRef<Record<number, HTMLDivElement | null>>({});
  const pageCanvasRefs = useRef<Record<number, HTMLCanvasElement | null>>({});
  const pinchScaleRef = useRef(1);
  const containerSize = useElementSize(viewportRef);

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [documentProxy, setDocumentProxy] = useState<PDFDocumentProxy | null>(null);
  const [pageNumber, setPageNumber] = useState(1);
  const [pageInput, setPageInput] = useState('1');
  const [pageCount, setPageCount] = useState(0);
  const [zoomMode, setZoomMode] = useState<ZoomMode>('fit-width');
  const [zoom, setZoom] = useState(1);
  const [rotation, setRotation] = useState(0);
  const [layoutMode, setLayoutMode] = useState<LayoutMode>('single');
  const [pageSizes, setPageSizes] = useState<Record<number, { width: number; height: number }>>({});
  const [pdfState, setPdfState] = useState<PdfSidecarState>(EMPTY_PDF_STATE);
  const [sidecarLoaded, setSidecarLoaded] = useState(false);
  const [selectionAction, setSelectionAction] = useState<SelectionActionState | null>(null);
  const [selectedHighlightId, setSelectedHighlightId] = useState<string | null>(null);
  const [selectedTextAnnotationId, setSelectedTextAnnotationId] = useState<string | null>(null);
  const [selectedPageCommentId, setSelectedPageCommentId] = useState<string | null>(null);
  const [annotationManipulation, setAnnotationManipulation] =
    useState<AnnotationManipulationState | null>(null);
  const [bookmarksOpen, setBookmarksOpen] = useState(true);
  const [regionSelection, setRegionSelection] = useState<RegionSelectionState | null>(null);
  const [interactionMode, setInteractionMode] = useState<
    'none' | 'snapshot' | 'annotation' | 'ocr'
  >('none');
  const [pendingSendAction, setPendingSendAction] = useState<PendingSendAction | null>(null);
  const [ocrOpen, setOcrOpen] = useState(false);
  const [ocrLoading, setOcrLoading] = useState(false);
  const [ocrText, setOcrText] = useState('');
  const [ocrPage, setOcrPage] = useState<number | null>(null);
  const [ocrConfidence, setOcrConfidence] = useState<number | null>(null);
  const [ocrResultMode, setOcrResultMode] = useState<'pdf-text' | 'ocr'>('ocr');
  const [ocrProgress, setOcrProgress] = useState<{ progress: number; status: string } | null>(null);
  const [ocrCached, setOcrCached] = useState(false);
  const [ocrOverlay, setOcrOverlay] = useState<PdfOcrOverlay | null>(null);
  const [ocrRegenerateAction, setOcrRegenerateAction] = useState<PdfOcrRegenerateAction | null>(
    null,
  );
  const ocrRenderScale = useUiStore((state) => state.ocrRenderScale);
  const ocrOverlayVisible = useUiStore((state) => state.ocrOverlayVisible);
  const setOcrOverlayVisible = useUiStore((state) => state.setOcrOverlayVisible);
  const documentCacheKey = useMemo(() => {
    const maybeFingerprints = (
      documentProxy as (PDFDocumentProxy & { fingerprints?: string[] }) | null
    )?.fingerprints;
    return maybeFingerprints?.[0] ?? relativePath;
  }, [documentProxy, relativePath]);
  const latestViewerStateRef = useRef(
    buildPdfViewerState({
      pageNumber: 1,
      zoomMode: 'fit-width',
      zoom: 1,
      layoutMode: 'single',
      rotation: 0,
      bookmarksOpen: true,
    }),
  );

  const normalizePdfState = useCallback(
    (state: PdfSidecarState): PdfSidecarState => ({
      ...EMPTY_PDF_STATE,
      ...state,
      textAnnotations: state.textAnnotations ?? [],
      pageComments: state.pageComments ?? [],
    }),
    [],
  );

  const serializePdfSession = useCallback(
    (state: PdfSidecarState) => {
      const normalized = normalizePdfState(state);
      if (vault?.kind === 'hosted') {
        return JSON.stringify({
          bookmarks: normalized.bookmarks,
          highlights: normalized.highlights,
          textAnnotations: normalized.textAnnotations,
          pageComments: normalized.pageComments,
        });
      }
      return JSON.stringify({
        ...normalized,
        viewerState: normalized.viewerState ?? latestViewerStateRef.current,
      });
    },
    [normalizePdfState, vault?.kind],
  );

  const deserializePdfSession = useCallback(
    (content: string): PdfSidecarState => {
      return normalizePdfState(JSON.parse(content) as PdfSidecarState);
    },
    [normalizePdfState],
  );

  const applyPdfSession = useCallback(
    (candidate: RemoteCandidate<PdfSidecarState>) => {
      const sidecar = normalizePdfState(candidate.document);
      setPdfState(sidecar);
      setBookmarksOpen(resolvePdfBookmarksOpen(sidecar.viewerState));
      if (sidecar.viewerState?.lastPage && pageCount > 0) {
        const nextPage = Math.min(Math.max(sidecar.viewerState.lastPage, 1), pageCount);
        setPageNumber(nextPage);
        setPageInput(String(nextPage));
      }
      if (
        sidecar.viewerState?.lastZoomMode === 'custom' ||
        sidecar.viewerState?.lastZoomMode === 'fit-width' ||
        sidecar.viewerState?.lastZoomMode === 'fit-height' ||
        sidecar.viewerState?.lastZoomMode === 'fit-page'
      ) {
        setZoomMode(sidecar.viewerState.lastZoomMode);
      }
      if (typeof sidecar.viewerState?.lastZoom === 'number') {
        setZoom(clampZoom(sidecar.viewerState.lastZoom));
      }
      if (
        sidecar.viewerState?.lastLayoutMode === 'single' ||
        sidecar.viewerState?.lastLayoutMode === 'scroll' ||
        sidecar.viewerState?.lastLayoutMode === 'spread'
      ) {
        setLayoutMode(sidecar.viewerState.lastLayoutMode);
      }
      if (typeof sidecar.viewerState?.lastRotation === 'number') {
        setRotation(sidecar.viewerState.lastRotation);
      }
    },
    [normalizePdfState, pageCount],
  );

  const readPdfSession = useCallback(async (): Promise<{
    content: string;
    version: string | null;
  }> => {
    if (!vault || !relativePath)
      return { content: serializePdfSession(EMPTY_PDF_STATE), version: null };
    const annotations = await createVaultClient(vault).readPdfAnnotations(relativePath);
    const state = normalizePdfState(annotations.state);
    const content = serializePdfSession(state);
    return {
      content,
      version: annotations.version === null ? content : String(annotations.version),
    };
  }, [normalizePdfState, relativePath, serializePdfSession, vault]);

  const { controller: pdfSessionController, snapshot: pdfSessionSnapshot } =
    useDocumentSessionController<PdfSidecarState>({
      serialize: serializePdfSession,
      deserialize: deserializePdfSession,
      applyDocument: applyPdfSession,
      read: readPdfSession,
      write: async ({ content, expectedVersion }) => {
        if (!vault || !relativePath) return { version: expectedVersion ?? content };
        const state = deserializePdfSession(content);
        if (vault.kind === 'hosted') {
          const parsedVersion = expectedVersion == null ? null : Number(expectedVersion);
          const result = await createVaultClient(vault).writePdfAnnotations(
            relativePath,
            state,
            Number.isFinite(parsedVersion) ? parsedVersion : null,
          );
          const nextContent = serializePdfSession(result.state);
          return {
            version: result.version === null ? nextContent : String(result.version),
            mergedContent: nextContent,
          };
        }
        await tauriCommands.writePdfSidecarState(vault.path, relativePath, {
          ...state,
          viewerState: latestViewerStateRef.current,
        });
        const nextContent = serializePdfSession({
          ...state,
          viewerState: latestViewerStateRef.current,
        });
        return { version: nextContent, mergedContent: nextContent };
      },
      autosaveDebounceMs: vault?.kind === 'hosted' ? 400 : 250,
      compareVersions: compareDocumentVersions,
    });

  const loadRemotePdfSession = useCallback(() => {
    if (pdfSessionSnapshot.conflicted) pdfSessionController.resolveConflict('load-remote');
    else pdfSessionController.applyRemoteNow();
  }, [pdfSessionController, pdfSessionSnapshot.conflicted]);

  const keepLocalPdfSession = useCallback(() => {
    if (pdfSessionSnapshot.conflicted) pdfSessionController.resolveConflict('keep-local');
    else pdfSessionController.discardRemoteCandidate();
  }, [pdfSessionController, pdfSessionSnapshot.conflicted]);

  const documentStatus = useMemo(
    () => ({
      status: pdfSessionSnapshot.status,
      onLoadRemote: loadRemotePdfSession,
      onKeepLocal: keepLocalPdfSession,
    }),
    [keepLocalPdfSession, loadRemotePdfSession, pdfSessionSnapshot.status],
  );
  useDocumentStatusRegistration(relativePath, documentStatus);

  const allFiles = useMemo(
    () => flattenPdfFiles(fileTree).filter((node) => !node.isFolder),
    [fileTree],
  );
  const availableNotes = useMemo(
    () => allFiles.filter((file) => file.extension.toLowerCase() === 'md'),
    [allFiles],
  );
  const currentNotePath = useMemo(() => {
    const active = openTabs.find(
      (tab) => tab.relativePath === activeTabPath && tab.type === 'note',
    );
    return (
      active?.relativePath ?? openTabs.find((tab) => tab.type === 'note')?.relativePath ?? null
    );
  }, [activeTabPath, openTabs]);
  const currentCanvasPath = useMemo(() => {
    const active = openTabs.find(
      (tab) => tab.relativePath === activeTabPath && tab.type === 'canvas',
    );
    return (
      active?.relativePath ?? openTabs.find((tab) => tab.type === 'canvas')?.relativePath ?? null
    );
  }, [activeTabPath, openTabs]);

  useEffect(() => {
    if (!vault || !relativePath) {
      setDocumentProxy(null);
      setPageCount(0);
      setLoading(false);
      setError('No PDF selected');
      return;
    }

    let cancelled = false;
    setLoading(true);
    setError(null);
    setDocumentProxy(null);
    setPageNumber(1);
    setPageInput('1');
    setPageCount(0);
    setZoomMode('fit-width');
    setZoom(1);
    setRotation(0);
    setLayoutMode('single');
    setPageSizes({});
    setPdfState(EMPTY_PDF_STATE);
    setSidecarLoaded(false);
    setSelectionAction(null);
    setSelectedHighlightId(null);
    setSelectedTextAnnotationId(null);
    setSelectedPageCommentId(null);
    setAnnotationManipulation(null);
    setBookmarksOpen(true);
    setRegionSelection(null);
    setInteractionMode('none');
    setOcrOpen(false);
    setOcrLoading(false);
    setOcrText('');
    setOcrPage(null);
    setOcrConfidence(null);
    setOcrProgress(null);

    const loadClient = createVaultClient(vault);
    void Promise.all([
      loadClient.readAssetDataUrl(relativePath),
      // Annotations load through the VaultClient for both local (filesystem
      // sidecar) and hosted (server-stored, permission-enforced) vaults.
      loadClient
        .readPdfAnnotations(relativePath)
        .catch(() => ({ state: EMPTY_PDF_STATE, version: null }) as VaultPdfAnnotations),
    ])
      .then(async ([dataUrl, annotations]) => {
        const sidecar = normalizePdfState(annotations.state);
        const data = dataUrlToUint8Array(dataUrl);
        const task = getDocument({ data });
        const pdf = await task.promise;
        if (cancelled) {
          // pdf.js 6 removed `PDFDocumentProxy.destroy`; the loading task owns
          // the worker teardown now.
          await task.destroy().catch(() => {});
          return;
        }

        const firstPage = await pdf.getPage(1);
        if (cancelled) return;
        const initialViewport = firstPage.getViewport({ scale: 1, rotation: 0 });
        const initialPage = Math.min(Math.max(sidecar.viewerState?.lastPage ?? 1, 1), pdf.numPages);

        setPageSizes({ 1: { width: initialViewport.width, height: initialViewport.height } });
        setPdfState(sidecar);
        setBookmarksOpen(resolvePdfBookmarksOpen(sidecar.viewerState));
        setSidecarLoaded(true);
        pdfSessionController.load(
          serializePdfSession(sidecar),
          annotations.version === null ? serializePdfSession(sidecar) : String(annotations.version),
          'rest',
        );
        setDocumentProxy(pdf);
        setPageCount(pdf.numPages);
        setPageNumber(initialPage);
        setPageInput(String(initialPage));
        if (
          sidecar.viewerState?.lastZoomMode === 'custom' ||
          sidecar.viewerState?.lastZoomMode === 'fit-width' ||
          sidecar.viewerState?.lastZoomMode === 'fit-height' ||
          sidecar.viewerState?.lastZoomMode === 'fit-page'
        ) {
          setZoomMode(sidecar.viewerState.lastZoomMode);
        }
        if (typeof sidecar.viewerState?.lastZoom === 'number') {
          setZoom(clampZoom(sidecar.viewerState.lastZoom));
        }
        if (
          sidecar.viewerState?.lastLayoutMode === 'single' ||
          sidecar.viewerState?.lastLayoutMode === 'scroll' ||
          sidecar.viewerState?.lastLayoutMode === 'spread'
        ) {
          setLayoutMode(sidecar.viewerState.lastLayoutMode);
        }
        if (typeof sidecar.viewerState?.lastRotation === 'number') {
          setRotation(sidecar.viewerState.lastRotation);
        }
      })
      .catch((loadError) => {
        if (cancelled) return;
        setDocumentProxy(null);
        setError(String(loadError));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [
    normalizePdfState,
    pdfSessionController,
    relativePath,
    serializePdfSession,
    supportsSidecars,
    vault?.path,
  ]);

  useEffect(() => {
    if (!vault || !relativePath || !sidecarLoaded) return;
    latestViewerStateRef.current = buildPdfViewerState({
      pageNumber,
      zoomMode,
      zoom,
      layoutMode,
      rotation,
      bookmarksOpen,
    });
    pdfSessionController.markLocalChange({
      ...pdfState,
      viewerState: latestViewerStateRef.current,
    });
  }, [
    bookmarksOpen,
    layoutMode,
    pageNumber,
    pdfSessionController,
    pdfState,
    relativePath,
    rotation,
    sidecarLoaded,
    vault,
    zoom,
    zoomMode,
  ]);

  useEffect(() => {
    if (!vault || !supportsSidecars || !relativePath) return;
    let unlisten: (() => void) | undefined;
    listen<{ path: string }>('vault:file-modified', async (event) => {
      if (event.payload?.path !== relativePath) return;
      if (Date.now() - pdfSessionController.getSnapshot().lastLocalWriteStartedAt < 2000) return;
      await pdfSessionController.handleExternalMutation('rest');
    }).then((cleanup) => {
      unlisten = cleanup;
    });
    return () => {
      unlisten?.();
    };
  }, [pdfSessionController, relativePath, supportsSidecars, vault]);

  useEffect(() => {
    if (!vault || vault.kind !== 'hosted' || !relativePath) return;
    return onReplicaMutated(
      async (event) => {
        if (!replicaMutationAffectsPath(event, relativePath)) return;
        await pdfSessionController.handleExternalMutation('cache');
      },
      { kinds: ['manifest'] },
    );
  }, [pdfSessionController, relativePath, vault]);

  useEffect(() => {
    if (!pdfSessionSnapshot.conflicted) return;
    toast.error(
      'PDF annotations changed elsewhere. Review the pending changes before editing further.',
    );
  }, [pdfSessionSnapshot.conflicted]);

  const activePageSize = pageSizes[pageNumber] ?? pageSizes[1] ?? null;
  const rotatedPageSize = useMemo(
    () =>
      activePageSize
        ? rotation % 180 === 0
          ? activePageSize
          : { width: activePageSize.height, height: activePageSize.width }
        : null,
    [activePageSize, rotation],
  );

  const effectiveScale = useMemo(() => {
    if (!rotatedPageSize || containerSize.width <= 0 || containerSize.height <= 0) {
      return zoom;
    }

    const availableWidth = Math.max(
      120,
      containerSize.width - WORKSPACE_PADDING * 2 - (bookmarksOpen ? 300 : 0),
    );
    const availableHeight = Math.max(120, containerSize.height - WORKSPACE_PADDING * 2);

    const columnCount = layoutMode === 'spread' ? 2 : 1;
    const widthForPages = availableWidth - PAGE_GAP * Math.max(0, columnCount - 1);
    const fitWidthScale = widthForPages / (rotatedPageSize.width * columnCount * PDF_CSS_SCALE);
    const fitHeightScale = availableHeight / (rotatedPageSize.height * PDF_CSS_SCALE);
    const fitPageScale = Math.min(fitWidthScale, fitHeightScale);

    if (zoomMode === 'fit-width') return fitWidthScale;
    if (zoomMode === 'fit-height') return fitHeightScale;
    if (zoomMode === 'fit-page') return fitPageScale;
    return zoom;
  }, [
    bookmarksOpen,
    containerSize.height,
    containerSize.width,
    layoutMode,
    rotatedPageSize,
    zoom,
    zoomMode,
  ]);

  const renderedPages = useMemo(() => {
    if (!documentProxy) return [] as number[];
    if (layoutMode === 'single') return [pageNumber];
    return Array.from({ length: pageCount }, (_, index) => index + 1);
  }, [documentProxy, layoutMode, pageCount, pageNumber]);

  const workspaceMetrics = useMemo(() => {
    if (!rotatedPageSize) {
      return {
        width: containerSize.width,
        height: containerSize.height,
      };
    }

    const scaledPageWidth = rotatedPageSize.width * effectiveScale * PDF_CSS_SCALE;
    const scaledPageHeight = rotatedPageSize.height * effectiveScale * PDF_CSS_SCALE;
    const pageTotal = Math.max(1, renderedPages.length);
    const contentWidth = layoutMode === 'spread' ? scaledPageWidth * 2 + PAGE_GAP : scaledPageWidth;
    const contentHeight =
      layoutMode === 'scroll'
        ? scaledPageHeight * pageTotal + PAGE_GAP * Math.max(0, pageTotal - 1)
        : scaledPageHeight;

    return {
      width: Math.max(containerSize.width, contentWidth + WORKSPACE_PADDING * 2),
      height: Math.max(containerSize.height, contentHeight + WORKSPACE_PADDING * 2),
    };
  }, [
    containerSize.height,
    containerSize.width,
    effectiveScale,
    layoutMode,
    renderedPages.length,
    rotatedPageSize,
  ]);

  const zoomLabel =
    zoomMode === 'custom'
      ? `${Math.round(effectiveScale * 100)}%`
      : zoomMode === 'fit-width'
        ? 'Fit width'
        : zoomMode === 'fit-height'
          ? 'Fit height'
          : 'Fit page';

  const selectedHighlight = useMemo(
    () => pdfState.highlights.find((highlight) => highlight.id === selectedHighlightId) ?? null,
    [pdfState.highlights, selectedHighlightId],
  );
  const selectedTextAnnotation = useMemo(
    () =>
      pdfState.textAnnotations.find((annotation) => annotation.id === selectedTextAnnotationId) ??
      null,
    [pdfState.textAnnotations, selectedTextAnnotationId],
  );
  const setCustomZoom = (nextZoom: number) => {
    setZoomMode('custom');
    setZoom(clampZoom(Math.round(nextZoom * 100) / 100));
  };

  const adjustCustomZoom = (delta: number) => {
    setCustomZoom(effectiveScale + delta);
  };

  const scaleCustomZoom = (factor: number) => {
    setCustomZoom(effectiveScale * factor);
  };

  const handleMeasured = useCallback((nextPage: number, width: number, height: number) => {
    setPageSizes((current) => {
      const existing = current[nextPage];
      if (existing?.width === width && existing?.height === height) return current;
      return { ...current, [nextPage]: { width, height } };
    });
  }, []);

  const registerSurface = useCallback(
    (nextPage: number, container: HTMLDivElement | null, canvas: HTMLCanvasElement | null) => {
      pageRefs.current[nextPage] = container;
      pageCanvasRefs.current[nextPage] = canvas;
    },
    [],
  );

  const scrollToPage = (nextPage: number) => {
    const element = pageRefs.current[nextPage];
    if (!element) return;
    element.scrollIntoView({ behavior: 'smooth', block: 'start', inline: 'nearest' });
  };

  const scrollViewportBy = (deltaY: number) => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    viewport.scrollBy({ top: deltaY, behavior: 'smooth' });
  };

  const goToPage = (nextPage: number) => {
    const clamped = Math.min(pageCount, Math.max(1, nextPage));
    setPageNumber(clamped);
    setPageInput(String(clamped));
    if (layoutMode !== 'single') scrollToPage(clamped);
  };

  const updatePdfState = useCallback((updater: (current: PdfSidecarState) => PdfSidecarState) => {
    setPdfState((current) => updater(current));
  }, []);

  const addBookmarkForCurrentPage = useCallback(() => {
    if (!canAnnotate) return;
    const timestamp = getTimestamp();
    const bookmark: PdfBookmark = {
      id: crypto.randomUUID(),
      page: pageNumber,
      label: `Page ${pageNumber}`,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    updatePdfState((current) => ({
      ...current,
      bookmarks: [...current.bookmarks, bookmark].sort((left, right) => left.page - right.page),
    }));
    setBookmarksOpen(true);
  }, [canAnnotate, pageNumber, updatePdfState]);

  const updateBookmarkLabel = useCallback(
    (bookmarkId: string, label: string) => {
      if (!canAnnotate) return;
      updatePdfState((current) => ({
        ...current,
        bookmarks: current.bookmarks.map((bookmark) =>
          bookmark.id === bookmarkId ? { ...bookmark, label, updatedAt: getTimestamp() } : bookmark,
        ),
      }));
    },
    [canAnnotate, updatePdfState],
  );

  const removeBookmark = useCallback(
    (bookmarkId: string) => {
      if (!canAnnotate) return;
      updatePdfState((current) => ({
        ...current,
        bookmarks: current.bookmarks.filter((bookmark) => bookmark.id !== bookmarkId),
      }));
    },
    [canAnnotate, updatePdfState],
  );

  const createHighlight = useCallback(
    (withNote: boolean) => {
      if (!canAnnotate) return;
      if (!selectionAction) return;
      const timestamp = getTimestamp();
      const highlight: PdfHighlight = {
        id: crypto.randomUUID(),
        page: selectionAction.page,
        text: selectionAction.text,
        rects: selectionAction.rects,
        color: DEFAULT_HIGHLIGHT_COLOR,
        note: withNote ? '' : null,
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      updatePdfState((current) => ({
        ...current,
        highlights: [...current.highlights, highlight],
      }));
      setSelectedHighlightId(highlight.id);
      setSelectionAction(null);
      window.getSelection()?.removeAllRanges();
    },
    [canAnnotate, selectionAction, updatePdfState],
  );

  const updateHighlightNote = useCallback(
    (highlightId: string, note: string) => {
      if (!canAnnotate) return;
      updatePdfState((current) => ({
        ...current,
        highlights: current.highlights.map((highlight) =>
          highlight.id === highlightId
            ? { ...highlight, note, updatedAt: getTimestamp() }
            : highlight,
        ),
      }));
    },
    [canAnnotate, updatePdfState],
  );

  const removeHighlight = useCallback(
    (highlightId: string) => {
      if (!canAnnotate) return;
      updatePdfState((current) => ({
        ...current,
        highlights: current.highlights.filter((highlight) => highlight.id !== highlightId),
      }));
      if (selectedHighlightId === highlightId) {
        setSelectedHighlightId(null);
      }
    },
    [canAnnotate, selectedHighlightId, updatePdfState],
  );

  const createTextAnnotation = useCallback(
    (selection: RegionSelectionState) => {
      if (!canAnnotate) return;
      const rect = selectionToRegionRect(selection);
      const surface = pageRefs.current[selection.page];
      if (!rect || !surface) return;
      const bounds = surface.getBoundingClientRect();
      if (!bounds.width || !bounds.height || rect.width < 16 || rect.height < 16) return;
      const timestamp = getTimestamp();
      const annotation: PdfTextAnnotation = {
        id: crypto.randomUUID(),
        page: selection.page,
        text: '',
        left: rect.left / bounds.width,
        top: rect.top / bounds.height,
        width: rect.width / bounds.width,
        height: rect.height / bounds.height,
        color: PDF_TEXT_ANNOTATION_STYLES[0].borderColor,
        backgroundColor: PDF_TEXT_ANNOTATION_STYLES[0].backgroundColor,
        textColor: PDF_TEXT_ANNOTATION_STYLES[0].textColor,
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      updatePdfState((current) => ({
        ...current,
        textAnnotations: [...current.textAnnotations, annotation],
      }));
      setSelectedTextAnnotationId(annotation.id);
    },
    [canAnnotate, updatePdfState],
  );

  const updateTextAnnotation = useCallback(
    (annotationId: string, text: string) => {
      if (!canAnnotate) return;
      updatePdfState((current) => ({
        ...current,
        textAnnotations: current.textAnnotations.map((annotation) =>
          annotation.id === annotationId
            ? { ...annotation, text, updatedAt: getTimestamp() }
            : annotation,
        ),
      }));
    },
    [canAnnotate, updatePdfState],
  );

  const updateTextAnnotationPalette = useCallback(
    (
      annotationId: string,
      palette: { backgroundColor: string; textColor: string; borderColor: string },
    ) => {
      if (!canAnnotate) return;
      updatePdfState((current) => ({
        ...current,
        textAnnotations: current.textAnnotations.map((annotation) =>
          annotation.id === annotationId
            ? {
                ...annotation,
                color: palette.borderColor,
                backgroundColor: palette.backgroundColor,
                textColor: palette.textColor,
                updatedAt: getTimestamp(),
              }
            : annotation,
        ),
      }));
    },
    [canAnnotate, updatePdfState],
  );

  const removeTextAnnotation = useCallback(
    (annotationId: string) => {
      if (!canAnnotate) return;
      updatePdfState((current) => ({
        ...current,
        textAnnotations: current.textAnnotations.filter(
          (annotation) => annotation.id !== annotationId,
        ),
      }));
      if (selectedTextAnnotationId === annotationId) {
        setSelectedTextAnnotationId(null);
      }
    },
    [canAnnotate, selectedTextAnnotationId, updatePdfState],
  );

  const updateTextAnnotationFrame = useCallback(
    (annotationId: string, frame: Pick<PdfTextAnnotation, 'left' | 'top' | 'width' | 'height'>) => {
      if (!canAnnotate) return;
      updatePdfState((current) => ({
        ...current,
        textAnnotations: current.textAnnotations.map((annotation) =>
          annotation.id === annotationId
            ? {
                ...annotation,
                ...frame,
                updatedAt: getTimestamp(),
              }
            : annotation,
        ),
      }));
    },
    [canAnnotate, updatePdfState],
  );

  const handleTextAnnotationPointerDown = useCallback(
    (
      annotation: PdfTextAnnotation,
      event: React.PointerEvent<HTMLElement>,
      mode: 'move' | 'resize',
    ) => {
      if (!canAnnotate) return;
      if (interactionMode !== 'none') return;
      event.preventDefault();
      event.stopPropagation();
      setSelectedTextAnnotationId(annotation.id);
      setAnnotationManipulation({
        annotationId: annotation.id,
        page: annotation.page,
        mode,
        startClientX: event.clientX,
        startClientY: event.clientY,
        originLeft: annotation.left,
        originTop: annotation.top,
        originWidth: annotation.width,
        originHeight: annotation.height,
      });
    },
    [canAnnotate, interactionMode],
  );

  const addPageCommentForCurrentPage = useCallback(() => {
    if (!canComment) return;
    const timestamp = getTimestamp();
    const comment: PdfPageComment = {
      id: crypto.randomUUID(),
      page: pageNumber,
      content: '',
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    updatePdfState((current) => ({
      ...current,
      pageComments: [...current.pageComments, comment].sort(
        (left, right) => left.page - right.page,
      ),
    }));
    setBookmarksOpen(true);
    setSelectedPageCommentId(comment.id);
  }, [canComment, pageNumber, updatePdfState]);

  const updatePageComment = useCallback(
    (commentId: string, content: string) => {
      if (!canComment) return;
      updatePdfState((current) => ({
        ...current,
        pageComments: current.pageComments.map((comment) =>
          comment.id === commentId ? { ...comment, content, updatedAt: getTimestamp() } : comment,
        ),
      }));
    },
    [canComment, updatePdfState],
  );

  const removePageComment = useCallback(
    (commentId: string) => {
      if (!canComment) return;
      updatePdfState((current) => ({
        ...current,
        pageComments: current.pageComments.filter((comment) => comment.id !== commentId),
      }));
      if (selectedPageCommentId === commentId) {
        setSelectedPageCommentId(null);
      }
    },
    [canComment, selectedPageCommentId, updatePdfState],
  );

  const appendToNote = useCallback(
    async (targetPath: string, block: string) => {
      if (!vault) return;
      const targetOpenTab = openTabs.find(
        (tab) => tab.relativePath === targetPath && tab.type === 'note',
      );
      if (targetOpenTab?.isDirty) {
        toast.error('Save the target note before inserting PDF content.');
        return;
      }

      const client = createVaultClient(vault);
      const note = await client.readDocument(targetPath);
      const nextContent = appendMarkdownBlock(note.content, block);
      await client.writeDocument(targetPath, nextContent, note.version);
      if (targetOpenTab) {
        setActiveTab(targetPath);
      } else {
        const title = targetPath.split('/').pop()?.replace(/\.md$/i, '') ?? targetPath;
        openEditorTab(targetPath, title, 'note');
      }
      setForceReloadPath(targetPath);
      setRevealEditorPath(targetPath);
      toast.success(`Inserted into ${targetPath}`);
    },
    [openEditorTab, openTabs, setActiveTab, setForceReloadPath, setRevealEditorPath, vault],
  );

  const appendToCanvas = useCallback(
    async (targetPath: string, mutate: (canvas: CanvasData) => CanvasData) => {
      if (!vault) return;
      const openTab = openTabs.find(
        (tab) => tab.relativePath === targetPath && tab.type === 'canvas',
      );
      if (openTab?.isDirty) {
        toast.error('Save the target canvas before inserting PDF content.');
        return;
      }

      const client = createVaultClient(vault);
      const canvasDoc = await client.readDocument(targetPath);
      const currentCanvas = canvasDoc.content.trim()
        ? (JSON.parse(canvasDoc.content) as CanvasData)
        : { nodes: [], edges: [], viewport: { x: 0, y: 0, zoom: 1 } };
      const nextCanvas = mutate(currentCanvas);
      await client.writeDocument(
        targetPath,
        JSON.stringify(nextCanvas, null, 2),
        canvasDoc.version,
      );
      toast.success(`Inserted into ${targetPath}`);
    },
    [openTabs, vault],
  );

  const handleSendTargetConfirm = useCallback(
    async (target: PdfSendTarget) => {
      if (!pendingSendAction || !vault) return;

      try {
        if (pendingSendAction.mode === 'quote') {
          const markdown = buildPdfQuoteMarkdown(
            relativePath,
            pendingSendAction.page,
            pendingSendAction.text,
          );
          if (target.kind === 'canvas-current') {
            await appendToCanvas(target.relativePath, (canvas) =>
              appendPdfQuoteTextNode(
                canvas,
                `${pendingSendAction.text}\n\nSource: ${relativePath} (page ${pendingSendAction.page})`,
              ),
            );
          } else {
            await appendToNote(target.relativePath, markdown);
          }
        } else {
          const suggestedName = `${getDocumentBaseName(relativePath, 'pdf')}-page-${pendingSendAction.page}-snapshot.png`;
          const savedRelativePath = await tauriCommands.saveGeneratedImage(
            vault.path,
            relativePath,
            pendingSendAction.dataUrl,
            false,
            suggestedName,
          );
          if (target.kind === 'canvas-current') {
            await appendToCanvas(target.relativePath, (canvas) =>
              appendPdfSnapshotFileNode(canvas, savedRelativePath),
            );
          } else {
            await appendToNote(
              target.relativePath,
              buildPdfSnapshotMarkdown(relativePath, pendingSendAction.page, savedRelativePath),
            );
          }
        }
      } catch (actionError) {
        toast.error(`Failed to send PDF ${pendingSendAction.mode}: ${String(actionError)}`);
      } finally {
        setPendingSendAction(null);
      }
    },
    [appendToCanvas, appendToNote, pendingSendAction, relativePath, vault],
  );

  const captureFullPageSnapshot = useCallback((targetPage: number) => {
    const canvas = pageCanvasRefs.current[targetPage];
    if (!canvas) {
      toast.error('That PDF page has not rendered yet. Scroll it into view first.');
      return;
    }
    setPendingSendAction({
      mode: 'snapshot',
      page: targetPage,
      dataUrl: canvas.toDataURL('image/png'),
    });
  }, []);

  const runPageOcr = useCallback(
    async (targetPage: number, force = false) => {
      setOcrOpen(true);
      setOcrLoading(true);
      setOcrPage(targetPage);
      setOcrText('');
      setOcrConfidence(null);
      setOcrResultMode('ocr');
      setOcrCached(false);
      setOcrOverlay(null);
      setOcrRegenerateAction({ kind: 'page', page: targetPage });
      setOcrProgress({ progress: 0, status: 'Checking PDF text' });
      try {
        const pdfTextCacheScope = {
          kind: 'pdf-page-text',
          relativePath,
          documentCacheKey,
          page: targetPage,
        };
        if (!force) {
          const cachedPdfText = await readOcrCache(pdfTextCacheScope);
          if (cachedPdfText) {
            setOcrText(cachedPdfText.text);
            setOcrConfidence(cachedPdfText.confidence);
            setOcrResultMode('pdf-text');
            setOcrCached(true);
            setOcrProgress(null);
            return;
          }
        }

        if (documentProxy) {
          const page = await documentProxy.getPage(targetPage);
          const textContent = await page.getTextContent();
          const embeddedText = textContentToPlainText(textContent);
          if (embeddedText.length > 0) {
            const result = { text: embeddedText, confidence: null };
            await writeOcrCache(pdfTextCacheScope, result, 'pdf-text').catch(() => undefined);
            setOcrText(result.text);
            setOcrConfidence(null);
            setOcrResultMode('pdf-text');
            setOcrCached(false);
            setOcrProgress(null);
            return;
          }
        }

        if (!documentProxy) {
          toast.error('PDF document is not ready for OCR yet.');
          return;
        }
        setOcrProgress({ progress: 0, status: `Rendering page at ${ocrRenderScale}x` });
        const canvas = await enqueuePdfRender(() =>
          renderPdfPageForOcr(documentProxy, targetPage, ocrRenderScale, rotation),
        );
        setOcrProgress({ progress: 0, status: 'Preparing OCR' });
        const { recognizeImageText } = await import('../lib/ocr');
        const result = await recognizeImageText(
          canvas,
          (progress, status) => {
            setOcrProgress({ progress, status });
          },
          {
            force,
            cacheScope: {
              kind: 'pdf-page-ocr',
              relativePath,
              documentCacheKey,
              page: targetPage,
              rotation,
              renderScale: ocrRenderScale,
            },
          },
        );
        setOcrText(result.text);
        setOcrConfidence(result.confidence);
        setOcrResultMode('ocr');
        setOcrCached(result.cached === true);
        setOcrOverlay({ page: targetPage, words: normalizeOcrWords(result) });
        setOcrProgress(null);
      } catch (reason) {
        setOcrText('');
        setOcrConfidence(null);
        setOcrResultMode('ocr');
        setOcrCached(false);
        setOcrOverlay(null);
        setOcrProgress(null);
        toast.error(`OCR failed: ${String(reason)}`);
      } finally {
        setOcrLoading(false);
      }
    },
    [documentCacheKey, documentProxy, ocrRenderScale, relativePath, rotation],
  );

  const runRegionOcr = useCallback(
    async (
      targetPage: number,
      region: { left: number; top: number; width: number; height: number },
      force = false,
    ) => {
      const surface = pageRefs.current[targetPage];
      if (!surface || !documentProxy) {
        toast.error('That PDF page is not ready for region OCR yet.');
        return;
      }
      const surfaceRect = surface.getBoundingClientRect();
      const normalizedRegion = {
        left: Number((region.left / Math.max(surfaceRect.width, 1)).toFixed(5)),
        top: Number((region.top / Math.max(surfaceRect.height, 1)).toFixed(5)),
        width: Number((region.width / Math.max(surfaceRect.width, 1)).toFixed(5)),
        height: Number((region.height / Math.max(surfaceRect.height, 1)).toFixed(5)),
      };

      setOcrOpen(true);
      setOcrLoading(true);
      setOcrPage(targetPage);
      setOcrText('');
      setOcrConfidence(null);
      setOcrResultMode('ocr');
      setOcrCached(false);
      setOcrOverlay(null);
      setOcrRegenerateAction({ kind: 'region', page: targetPage, region });
      setOcrProgress({ progress: 0, status: `Rendering region at ${ocrRenderScale}x` });
      try {
        const renderedPage = await enqueuePdfRender(() =>
          renderPdfPageForOcr(documentProxy, targetPage, ocrRenderScale, rotation),
        );
        const canvas = cropRenderedPdfRegion(renderedPage, region, {
          width: surfaceRect.width,
          height: surfaceRect.height,
        });
        setOcrProgress({ progress: 0, status: 'Preparing OCR' });
        const { recognizeImageText } = await import('../lib/ocr');
        const result = await recognizeImageText(
          canvas,
          (progress, status) => {
            setOcrProgress({ progress, status });
          },
          {
            force,
            cacheScope: {
              kind: 'pdf-region-ocr',
              relativePath,
              documentCacheKey,
              page: targetPage,
              rotation,
              renderScale: ocrRenderScale,
              regionLeft: normalizedRegion.left,
              regionTop: normalizedRegion.top,
              regionWidth: normalizedRegion.width,
              regionHeight: normalizedRegion.height,
            },
          },
        );
        setOcrText(result.text);
        setOcrConfidence(result.confidence);
        setOcrCached(result.cached === true);
        setOcrOverlay({ page: targetPage, words: normalizeOcrWords(result, normalizedRegion) });
        setOcrProgress(null);
      } catch (reason) {
        setOcrText('');
        setOcrConfidence(null);
        setOcrCached(false);
        setOcrOverlay(null);
        setOcrProgress(null);
        toast.error(`Region OCR failed: ${String(reason)}`);
      } finally {
        setOcrLoading(false);
      }
    },
    [documentCacheKey, documentProxy, ocrRenderScale, relativePath, rotation],
  );

  const copyOcrText = useCallback(async () => {
    if (!ocrText) return;
    const { copyTextToClipboard } = await import('../lib/ocr');
    await copyTextToClipboard(ocrText);
  }, [ocrText]);

  const regenerateOcr = useCallback(() => {
    if (!ocrRegenerateAction) {
      void runPageOcr(ocrPage ?? pageNumber, true);
      return;
    }
    if (ocrRegenerateAction.kind === 'page') {
      void runPageOcr(ocrRegenerateAction.page, true);
      return;
    }
    void runRegionOcr(ocrRegenerateAction.page, ocrRegenerateAction.region, true);
  }, [ocrPage, ocrRegenerateAction, pageNumber, runPageOcr, runRegionOcr]);

  const captureRegionSnapshot = useCallback(
    (targetPage: number, region: { left: number; top: number; width: number; height: number }) => {
      const canvas = pageCanvasRefs.current[targetPage];
      const surface = pageRefs.current[targetPage];
      if (!canvas || !surface) {
        toast.error('That PDF page is not ready for region snapshots yet.');
        return;
      }

      const surfaceRect = surface.getBoundingClientRect();
      const scaleX = canvas.width / Math.max(surfaceRect.width, 1);
      const scaleY = canvas.height / Math.max(surfaceRect.height, 1);
      const cropWidth = Math.max(1, Math.round(region.width * scaleX));
      const cropHeight = Math.max(1, Math.round(region.height * scaleY));
      const cropLeft = Math.max(0, Math.round(region.left * scaleX));
      const cropTop = Math.max(0, Math.round(region.top * scaleY));
      const cropCanvas = document.createElement('canvas');
      cropCanvas.width = cropWidth;
      cropCanvas.height = cropHeight;
      const context = cropCanvas.getContext('2d');
      if (!context) {
        toast.error('Failed to prepare region snapshot.');
        return;
      }

      context.drawImage(
        canvas,
        cropLeft,
        cropTop,
        Math.min(cropWidth, canvas.width - cropLeft),
        Math.min(cropHeight, canvas.height - cropTop),
        0,
        0,
        cropWidth,
        cropHeight,
      );

      setPendingSendAction({
        mode: 'snapshot',
        page: targetPage,
        dataUrl: cropCanvas.toDataURL('image/png'),
      });
    },
    [],
  );

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport || layoutMode === 'single' || renderedPages.length === 0) return;

    let frame = 0;

    const updateVisiblePage = () => {
      frame = 0;
      const viewportRect = viewport.getBoundingClientRect();
      const viewportCenterY = viewportRect.top + viewportRect.height / 2;

      let closestPage = pageNumber;
      let closestDistance = Number.POSITIVE_INFINITY;

      for (const renderedPage of renderedPages) {
        const element = pageRefs.current[renderedPage];
        if (!element) continue;

        const rect = element.getBoundingClientRect();
        const pageCenterY = rect.top + rect.height / 2;
        const distance = Math.abs(pageCenterY - viewportCenterY);
        if (distance < closestDistance) {
          closestDistance = distance;
          closestPage = renderedPage;
        }
      }

      if (closestPage !== pageNumber) {
        setPageNumber(closestPage);
        setPageInput(String(closestPage));
      }
    };

    const scheduleUpdate = () => {
      if (frame) return;
      frame = window.requestAnimationFrame(updateVisiblePage);
    };

    scheduleUpdate();
    viewport.addEventListener('scroll', scheduleUpdate, { passive: true });
    window.addEventListener('resize', scheduleUpdate);

    return () => {
      if (frame) window.cancelAnimationFrame(frame);
      viewport.removeEventListener('scroll', scheduleUpdate);
      window.removeEventListener('resize', scheduleUpdate);
    };
  }, [effectiveScale, layoutMode, pageNumber, renderedPages]);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;

    const isEventInsidePdf = (target: EventTarget | null) =>
      target instanceof Node && viewport.contains(target);
    const isEditableTarget = (target: EventTarget | null) =>
      target instanceof HTMLElement &&
      target.matches(
        'input, textarea, [contenteditable="true"], [contenteditable=""], [role="textbox"]',
      );

    const handleKeyDown = (event: KeyboardEvent) => {
      const ctrl = event.ctrlKey || event.metaKey;
      if (ctrl) {
        if (event.key === 'ArrowUp' || event.key === '+' || event.key === '=') {
          event.preventDefault();
          adjustCustomZoom(ZOOM_STEP);
          return;
        }

        if (event.key === 'ArrowDown' || event.key === '-') {
          event.preventDefault();
          adjustCustomZoom(-ZOOM_STEP);
          return;
        }

        if (event.key === '0') {
          event.preventDefault();
          setCustomZoom(1);
        }
        return;
      }

      if (isEditableTarget(event.target) || event.altKey) return;

      const scrollStep = Math.max(56, viewport.clientHeight * 0.12);

      switch (event.key) {
        case '1':
          event.preventDefault();
          setLayoutMode('single');
          break;
        case '2':
          event.preventDefault();
          setLayoutMode('scroll');
          break;
        case '3':
          event.preventDefault();
          setLayoutMode('spread');
          break;
        case 'r':
        case 'R':
          event.preventDefault();
          setRotation((current) => (current + 90) % 360);
          break;
        case 'ArrowDown':
          event.preventDefault();
          scrollViewportBy(scrollStep);
          break;
        case 'ArrowUp':
          event.preventDefault();
          scrollViewportBy(-scrollStep);
          break;
        case 'ArrowRight':
          event.preventDefault();
          goToPage(pageNumber + 1);
          break;
        case 'ArrowLeft':
          event.preventDefault();
          goToPage(pageNumber - 1);
          break;
        case 'PageDown':
          event.preventDefault();
          goToPage(pageNumber + 1);
          break;
        case 'PageUp':
          event.preventDefault();
          goToPage(pageNumber - 1);
          break;
        case ' ':
          event.preventDefault();
          goToPage(pageNumber + (event.shiftKey ? -1 : 1));
          break;
        case 'Home':
          event.preventDefault();
          goToPage(1);
          break;
        case 'End':
          event.preventDefault();
          goToPage(pageCount);
          break;
        case '0':
          event.preventDefault();
          setCustomZoom(1);
          break;
      }
    };

    const handleWheel = (event: WheelEvent) => {
      if (!event.ctrlKey && !event.metaKey) return;
      if (!isEventInsidePdf(event.target)) return;
      event.preventDefault();
      scaleCustomZoom(Math.exp(-event.deltaY * 0.0025));
    };

    const handleGestureStart = (event: Event) => {
      if (!isEventInsidePdf(event.target)) return;
      pinchScaleRef.current = 1;
      event.preventDefault();
    };

    const handleGestureChange = (event: Event) => {
      if (!isEventInsidePdf(event.target)) return;
      const scale =
        'scale' in event && typeof (event as WebKitGestureEvent).scale === 'number'
          ? (event as WebKitGestureEvent).scale
          : null;
      if (!scale || scale <= 0) return;

      event.preventDefault();
      const deltaScale = scale / pinchScaleRef.current;
      pinchScaleRef.current = scale;
      scaleCustomZoom(deltaScale);
    };

    document.addEventListener('keydown', handleKeyDown, { capture: true });
    document.addEventListener('wheel', handleWheel, { passive: false, capture: true });
    document.addEventListener('gesturestart', handleGestureStart, { capture: true });
    document.addEventListener('gesturechange', handleGestureChange, { capture: true });

    return () => {
      document.removeEventListener('keydown', handleKeyDown, {
        capture: true,
      } as EventListenerOptions);
      document.removeEventListener('wheel', handleWheel, { capture: true } as EventListenerOptions);
      document.removeEventListener('gesturestart', handleGestureStart, {
        capture: true,
      } as EventListenerOptions);
      document.removeEventListener('gesturechange', handleGestureChange, {
        capture: true,
      } as EventListenerOptions);
    };
  }, [effectiveScale, layoutMode, pageCount, pageNumber]);

  useEffect(() => {
    const handleMouseUp = () => {
      if (interactionMode !== 'none' || regionSelection) return;
      window.setTimeout(() => {
        const selection = window.getSelection();
        if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
          setSelectionAction(null);
          return;
        }
        const range = selection.getRangeAt(0);
        const startElement =
          range.startContainer instanceof Element
            ? range.startContainer
            : range.startContainer.parentElement;
        const endElement =
          range.endContainer instanceof Element
            ? range.endContainer
            : range.endContainer.parentElement;
        if (!startElement || !endElement) {
          setSelectionAction(null);
          return;
        }
        const startPage = startElement.closest<HTMLElement>('[data-pdf-page]');
        const endPage = endElement.closest<HTMLElement>('[data-pdf-page]');
        if (!startPage || !endPage || startPage !== endPage) {
          setSelectionAction(null);
          return;
        }
        if (!viewportRef.current?.contains(startPage)) {
          setSelectionAction(null);
          return;
        }

        const pageRect = startPage.getBoundingClientRect();
        const boundingRect = range.getBoundingClientRect();
        const text = selection.toString().trim();
        if (!text || !pageRect.width || !pageRect.height) {
          setSelectionAction(null);
          return;
        }

        const rects = Array.from(range.getClientRects())
          .map((rect) => ({
            left: (Math.max(rect.left, pageRect.left) - pageRect.left) / pageRect.width,
            top: (Math.max(rect.top, pageRect.top) - pageRect.top) / pageRect.height,
            width:
              (Math.min(rect.right, pageRect.right) - Math.max(rect.left, pageRect.left)) /
              pageRect.width,
            height:
              (Math.min(rect.bottom, pageRect.bottom) - Math.max(rect.top, pageRect.top)) /
              pageRect.height,
          }))
          .filter((rect) => rect.width > 0.001 && rect.height > 0.001);

        if (rects.length === 0) {
          setSelectionAction(null);
          return;
        }

        setSelectionAction({
          page: Number.parseInt(startPage.dataset.pdfPage ?? '1', 10) || 1,
          text,
          rects,
          left: boundingRect.left + boundingRect.width / 2,
          top: boundingRect.top - 12,
        });
      }, 0);
    };

    document.addEventListener('mouseup', handleMouseUp, true);
    return () => document.removeEventListener('mouseup', handleMouseUp, true);
  }, [interactionMode, regionSelection]);

  useEffect(() => {
    if (!regionSelection) return;

    const handlePointerMove = (event: PointerEvent) => {
      const surface = pageRefs.current[regionSelection.page];
      if (!surface) return;
      const rect = surface.getBoundingClientRect();
      setRegionSelection((current) =>
        current
          ? {
              ...current,
              currentX: Math.min(Math.max(event.clientX - rect.left, 0), rect.width),
              currentY: Math.min(Math.max(event.clientY - rect.top, 0), rect.height),
            }
          : current,
      );
    };

    const handlePointerUp = () => {
      const regionRect = selectionToRegionRect(regionSelection);
      if (regionRect && regionRect.width >= 12 && regionRect.height >= 12) {
        if (regionSelection.mode === 'snapshot') {
          captureRegionSnapshot(regionSelection.page, regionRect);
        } else if (regionSelection.mode === 'ocr') {
          void runRegionOcr(regionSelection.page, regionRect);
        } else {
          createTextAnnotation(regionSelection);
        }
      }
      setRegionSelection(null);
      setInteractionMode('none');
    };

    window.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('pointerup', handlePointerUp, { once: true });

    return () => {
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', handlePointerUp);
    };
  }, [captureRegionSnapshot, createTextAnnotation, regionSelection, runRegionOcr]);

  useEffect(() => {
    if (!annotationManipulation) return;

    const handlePointerMove = (event: PointerEvent) => {
      const surface = pageRefs.current[annotationManipulation.page];
      if (!surface) return;
      const bounds = surface.getBoundingClientRect();
      if (!bounds.width || !bounds.height) return;

      const deltaX = (event.clientX - annotationManipulation.startClientX) / bounds.width;
      const deltaY = (event.clientY - annotationManipulation.startClientY) / bounds.height;
      const minWidth = Math.min(0.5, 48 / bounds.width);
      const minHeight = Math.min(0.5, 32 / bounds.height);

      if (annotationManipulation.mode === 'move') {
        const nextLeft = Math.min(
          Math.max(0, annotationManipulation.originLeft + deltaX),
          Math.max(0, 1 - annotationManipulation.originWidth),
        );
        const nextTop = Math.min(
          Math.max(0, annotationManipulation.originTop + deltaY),
          Math.max(0, 1 - annotationManipulation.originHeight),
        );
        updateTextAnnotationFrame(annotationManipulation.annotationId, {
          left: nextLeft,
          top: nextTop,
          width: annotationManipulation.originWidth,
          height: annotationManipulation.originHeight,
        });
        return;
      }

      const nextWidth = Math.min(
        Math.max(minWidth, annotationManipulation.originWidth + deltaX),
        Math.max(minWidth, 1 - annotationManipulation.originLeft),
      );
      const nextHeight = Math.min(
        Math.max(minHeight, annotationManipulation.originHeight + deltaY),
        Math.max(minHeight, 1 - annotationManipulation.originTop),
      );
      updateTextAnnotationFrame(annotationManipulation.annotationId, {
        left: annotationManipulation.originLeft,
        top: annotationManipulation.originTop,
        width: nextWidth,
        height: nextHeight,
      });
    };

    const handlePointerUp = () => {
      setAnnotationManipulation(null);
    };

    window.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('pointerup', handlePointerUp, { once: true });

    return () => {
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', handlePointerUp);
    };
  }, [annotationManipulation, updateTextAnnotationFrame]);

  const handleWorkspacePointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (interactionMode === 'none') return;
      const target =
        event.target instanceof Element
          ? event.target.closest<HTMLElement>('[data-pdf-page]')
          : null;
      if (!target) return;
      const page = Number.parseInt(target.dataset.pdfPage ?? '1', 10) || 1;
      const rect = target.getBoundingClientRect();
      setRegionSelection({
        page,
        mode: interactionMode,
        startX: Math.min(Math.max(event.clientX - rect.left, 0), rect.width),
        startY: Math.min(Math.max(event.clientY - rect.top, 0), rect.height),
        currentX: Math.min(Math.max(event.clientX - rect.left, 0), rect.width),
        currentY: Math.min(Math.max(event.clientY - rect.top, 0), rect.height),
      });
      event.preventDefault();
    },
    [interactionMode],
  );

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center text-muted-foreground app-fade-scale-in">
        Loading PDF…
      </div>
    );
  }

  if (error || !documentProxy) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 text-muted-foreground app-fade-scale-in">
        <FileText size={36} className="opacity-40" />
        <div className="text-base font-medium">Unable to open PDF</div>
        <div className="max-w-md text-center text-sm opacity-70">
          {error ?? 'Unknown PDF error'}
        </div>
      </div>
    );
  }

  return (
    <div className="pdf-view flex h-full min-h-0 flex-col bg-background app-document-ready">
      <style>{`
        .pdf-view .pdf-text-layer {
          position: absolute;
          inset: 0;
          overflow: clip;
          opacity: 1;
          text-align: initial;
          line-height: 1;
          text-size-adjust: none;
          -webkit-text-size-adjust: none;
          -moz-text-size-adjust: none;
          user-select: text;
          -webkit-user-select: text;
          forced-color-adjust: none;
          transform-origin: 0 0;
          caret-color: CanvasText;
          z-index: 1;
          --scale-factor: 1;
          --user-unit: 1;
          --total-scale-factor: calc(var(--scale-factor) * var(--user-unit));
          --min-font-size: 1;
          --text-scale-factor: calc(var(--total-scale-factor) * var(--min-font-size));
          --min-font-size-inv: calc(1 / var(--min-font-size));
        }

        .pdf-view .pdf-text-layer :is(span, br) {
          position: absolute;
          white-space: pre;
          transform-origin: 0 0;
          color: transparent;
          cursor: text;
        }

        .pdf-view .pdf-text-layer > :not(.markedContent),
        .pdf-view .pdf-text-layer .markedContent span:not(.markedContent) {
          z-index: 1;
          --font-height: 0;
          font-size: calc(var(--text-scale-factor) * var(--font-height));
          --scale-x: 1;
          --rotate: 0deg;
          transform: rotate(var(--rotate)) scaleX(var(--scale-x)) scale(var(--min-font-size-inv));
        }

        .pdf-view .pdf-text-layer .markedContent {
          display: contents;
        }

        .pdf-view .pdf-text-layer .endOfContent {
          display: block;
          position: absolute;
          inset: 100% 0 0;
          z-index: 0;
          cursor: default;
          user-select: none;
          -webkit-user-select: none;
        }

        .pdf-view .pdf-text-layer ::selection {
          background: color-mix(in oklch, var(--primary) 35%, white 20%);
        }

        .pdf-view .pdf-text-layer ::-moz-selection {
          background: color-mix(in oklch, var(--primary) 35%, white 20%);
        }
      `}</style>
      <DocumentTopBar
        title={getDocumentBaseName(relativePath, 'PDF')}
        subtitle={getDocumentFolderPath(relativePath)}
        icon={<FileText size={15} />}
        secondary={
          <>
            <div className={documentTopBarGroupClass}>
              <Button
                size="icon"
                variant="ghost"
                className="size-8"
                onClick={() => goToPage(pageNumber - 1)}
                disabled={pageNumber <= 1}
                title="Previous page"
              >
                <ChevronLeft size={15} />
              </Button>
              <Input
                value={pageInput}
                onChange={(event) => setPageInput(event.target.value.replace(/[^\d]/g, ''))}
                onBlur={() => goToPage(Number.parseInt(pageInput || '1', 10) || 1)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    goToPage(Number.parseInt(pageInput || '1', 10) || 1);
                  }
                }}
                className="h-8 w-14 border-0 bg-transparent px-2 text-center text-sm shadow-none focus-visible:ring-0"
              />
              <span className="px-1 text-xs text-muted-foreground">/ {pageCount}</span>
              <Button
                size="icon"
                variant="ghost"
                className="size-8"
                onClick={() => goToPage(pageNumber + 1)}
                disabled={pageNumber >= pageCount}
                title="Next page"
              >
                <ChevronRight size={15} />
              </Button>
            </div>

            <div className={documentTopBarGroupClass}>
              <Button
                size="icon"
                variant="ghost"
                className="size-8"
                onClick={() => adjustCustomZoom(-ZOOM_STEP)}
                disabled={zoomMode === 'custom' && zoom <= ZOOM_MIN}
                title="Zoom out"
              >
                <Minus size={15} />
              </Button>
              <button
                type="button"
                onClick={() => setCustomZoom(1)}
                className="min-w-[86px] rounded-md px-2 text-center text-xs font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
                title="Reset zoom to 100%"
              >
                {zoomLabel}
              </button>
              <Button
                size="icon"
                variant="ghost"
                className="size-8"
                onClick={() => adjustCustomZoom(ZOOM_STEP)}
                disabled={zoomMode === 'custom' && zoom >= ZOOM_MAX}
                title="Zoom in"
              >
                <Plus size={15} />
              </Button>
            </div>

            <div className={documentTopBarGroupClass}>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button size="sm" variant="ghost" className="h-8 gap-1.5 px-2.5 text-xs">
                    <Maximize2 size={14} />
                    View
                    <ChevronDown size={13} className="opacity-60" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" className="w-44">
                  <DropdownMenuSub>
                    <DropdownMenuSubTrigger>
                      <Maximize2 size={14} className="mr-2" />
                      Fit
                    </DropdownMenuSubTrigger>
                    <DropdownMenuSubContent>
                      <DropdownMenuRadioGroup
                        value={zoomMode}
                        onValueChange={(value) => setZoomMode(value as ZoomMode)}
                      >
                        <DropdownMenuRadioItem value="fit-width">
                          <Rows3 size={14} className="mr-2" />
                          Fit width
                        </DropdownMenuRadioItem>
                        <DropdownMenuRadioItem value="fit-height">
                          <Columns2 size={14} className="mr-2" />
                          Fit height
                        </DropdownMenuRadioItem>
                        <DropdownMenuRadioItem value="fit-page">
                          <Maximize2 size={14} className="mr-2" />
                          Fit page
                        </DropdownMenuRadioItem>
                      </DropdownMenuRadioGroup>
                    </DropdownMenuSubContent>
                  </DropdownMenuSub>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onClick={() => setRotation((current) => (current + 90) % 360)}>
                    <RotateCw size={14} className="mr-2" />
                    Rotate 90°
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>

            <div className={documentTopBarGroupClass}>
              <Button
                size="sm"
                variant="ghost"
                className="h-8 gap-1.5 px-2.5 text-xs"
                onClick={addBookmarkForCurrentPage}
              >
                <BookmarkPlus size={14} />
                Bookmark
              </Button>
              <Button
                size="sm"
                variant="ghost"
                className={cn(
                  'h-8 gap-1.5 px-2.5 text-xs',
                  interactionMode === 'snapshot' && 'bg-accent text-accent-foreground',
                )}
                onClick={() => {
                  setInteractionMode((current) => (current === 'snapshot' ? 'none' : 'snapshot'));
                  setRegionSelection(null);
                }}
              >
                <Crop size={14} />
                Region snapshot
              </Button>
              <Button
                size="sm"
                variant="ghost"
                className={cn(
                  'h-8 gap-1.5 px-2.5 text-xs',
                  interactionMode === 'annotation' && 'bg-accent text-accent-foreground',
                )}
                onClick={() => {
                  setInteractionMode((current) =>
                    current === 'annotation' ? 'none' : 'annotation',
                  );
                  setRegionSelection(null);
                }}
              >
                <MessageSquare size={14} />
                Text box
              </Button>
              <Button
                size="sm"
                variant="ghost"
                className="h-8 gap-1.5 px-2.5 text-xs"
                onClick={() => captureFullPageSnapshot(pageNumber)}
              >
                <ImagePlus size={14} />
                Snapshot page
              </Button>
              <Button
                size="sm"
                variant="ghost"
                className={cn(
                  'h-8 gap-1.5 px-2.5 text-xs',
                  ocrOpen && 'bg-accent text-accent-foreground',
                )}
                disabled={ocrLoading}
                onClick={() => {
                  if (ocrText && ocrPage === pageNumber) {
                    setOcrOpen((current) => !current);
                    return;
                  }
                  void runPageOcr(pageNumber);
                }}
              >
                {ocrLoading ? (
                  <Loader2 size={14} className="animate-spin" />
                ) : (
                  <FileText size={14} />
                )}
                OCR page
              </Button>
              <Button
                size="sm"
                variant="ghost"
                className="h-8 gap-1.5 px-2.5 text-xs"
                onClick={addPageCommentForCurrentPage}
              >
                <MessageSquare size={14} />
                Page comment
              </Button>
              <Button
                size="sm"
                variant="ghost"
                className="h-8 gap-1.5 px-2.5 text-xs"
                onClick={() => setBookmarksOpen((current) => !current)}
              >
                {bookmarksOpen ? <PanelRightClose size={14} /> : <PanelRightOpen size={14} />}
                Bookmarks
              </Button>
            </div>

            {pageCount > 1 && (
              <div className={documentTopBarGroupClass}>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button size="sm" variant="ghost" className="h-8 gap-1.5 px-2.5 text-xs">
                      {layoutMode === 'scroll' ? (
                        <Rows3 size={14} />
                      ) : layoutMode === 'spread' ? (
                        <Columns2 size={14} />
                      ) : (
                        <FileText size={14} />
                      )}
                      {layoutMode === 'scroll'
                        ? 'Long scroll'
                        : layoutMode === 'spread'
                          ? 'Side by side'
                          : 'Single page'}
                      <ChevronDown size={13} className="opacity-60" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="start" className="w-44">
                    <DropdownMenuRadioGroup
                      value={layoutMode}
                      onValueChange={(value) => setLayoutMode(value as LayoutMode)}
                    >
                      <DropdownMenuRadioItem value="single">
                        <FileText size={14} className="mr-2" />
                        Single page
                      </DropdownMenuRadioItem>
                      <DropdownMenuRadioItem value="scroll">
                        <Rows3 size={14} className="mr-2" />
                        Long scroll
                      </DropdownMenuRadioItem>
                      <DropdownMenuRadioItem value="spread">
                        <Columns2 size={14} className="mr-2" />
                        Side by side
                      </DropdownMenuRadioItem>
                    </DropdownMenuRadioGroup>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            )}
          </>
        }
      />

      <div className="relative min-h-0 flex-1">
        <div className="pointer-events-none absolute right-5 top-5 z-20 flex flex-col gap-3">
          {ocrOpen && (
            <div className="pointer-events-auto w-[min(380px,calc(100vw-2.5rem))] rounded-2xl border border-border/60 bg-popover/95 p-3 shadow-2xl shadow-black/25 app-panel-enter">
              <div className="mb-2 flex items-start justify-between gap-3">
                <div>
                  <div className="text-sm font-medium">Recognized text</div>
                  <div className="text-xs text-muted-foreground">
                    {ocrLoading && ocrProgress
                      ? `${ocrProgress.status} · ${Math.round(ocrProgress.progress * 100)}%`
                      : ocrPage
                        ? ocrResultMode === 'pdf-text'
                          ? `Page ${ocrPage} · ${ocrCached ? 'cached ' : ''}extracted PDF text`
                          : `Page ${ocrPage}${ocrCached ? ' · cached' : ''}${ocrConfidence != null ? ` · confidence ${Math.round(ocrConfidence)}%` : ''}`
                        : 'PDF OCR'}
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
                        ocrOverlayVisible ? 'Hide text boxes on page' : 'Show text boxes on page'
                      }
                    >
                      {ocrOverlayVisible ? <Eye size={14} /> : <EyeOff size={14} />}
                    </Button>
                  )}
                  <Button
                    size="icon"
                    variant="ghost"
                    className="size-8"
                    disabled={ocrLoading}
                    onClick={regenerateOcr}
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
                  interactionMode === 'ocr' && 'border-primary text-primary',
                )}
                onClick={() => {
                  setInteractionMode((current) => (current === 'ocr' ? 'none' : 'ocr'));
                  setRegionSelection(null);
                }}
                title="OCR a selected region of the page"
              >
                <Crop size={14} />
                {interactionMode === 'ocr' ? 'Click & drag a region…' : 'Region OCR'}
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
                  value={ocrText || 'No text recognized.'}
                  className="mt-2 h-52 w-full resize-none rounded-lg border border-input bg-background/70 px-3 py-2 text-xs leading-relaxed outline-none"
                />
              )}
            </div>
          )}

          {selectionAction && (
            <div
              className="pointer-events-auto fixed z-50 flex items-center gap-1 rounded-xl border border-border/60 bg-popover/95 px-2 py-1 shadow-2xl shadow-black/30 app-panel-enter"
              style={{
                left: `${selectionAction.left}px`,
                top: `${selectionAction.top}px`,
                transform: 'translate(-50%, -100%)',
              }}
            >
              <Button
                size="sm"
                variant="ghost"
                className="h-8 gap-1.5 px-2 text-xs"
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => createHighlight(false)}
              >
                <Highlighter size={14} />
                Highlight
              </Button>
              <Button
                size="sm"
                variant="ghost"
                className="h-8 gap-1.5 px-2 text-xs"
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => createHighlight(true)}
              >
                <Bookmark size={14} />
                Add note
              </Button>
              <Button
                size="sm"
                variant="ghost"
                className="h-8 gap-1.5 px-2 text-xs"
                onMouseDown={(event) => event.preventDefault()}
                onClick={() =>
                  setPendingSendAction({
                    mode: 'quote',
                    page: selectionAction.page,
                    text: selectionAction.text,
                  })
                }
              >
                <MessageSquareQuote size={14} />
                Quote
              </Button>
            </div>
          )}

          {selectedHighlight && (
            <div className="pointer-events-auto w-80 rounded-2xl border border-border/60 bg-popover/95 p-3 shadow-2xl shadow-black/25 app-panel-enter">
              <div className="mb-2 flex items-start justify-between gap-3">
                <div>
                  <div className="text-sm font-medium">Highlight note</div>
                  <div className="text-xs text-muted-foreground">Page {selectedHighlight.page}</div>
                </div>
                <Button
                  size="icon"
                  variant="ghost"
                  className="size-8"
                  onClick={() => setSelectedHighlightId(null)}
                >
                  <PanelRightClose size={14} />
                </Button>
              </div>
              <div className="mb-2 rounded-lg border border-border/50 bg-muted/30 px-2.5 py-2 text-xs text-muted-foreground">
                {selectedHighlight.text}
              </div>
              <Textarea
                value={selectedHighlight.note ?? ''}
                onChange={(event) => updateHighlightNote(selectedHighlight.id, event.target.value)}
                placeholder="Add a note to this highlight…"
                className="min-h-[110px]"
              />
              <div className="mt-3 flex justify-end">
                <Button
                  size="sm"
                  variant="ghost"
                  className="gap-1.5 text-destructive hover:text-destructive"
                  onClick={() => removeHighlight(selectedHighlight.id)}
                >
                  <Trash2 size={14} />
                  Remove highlight
                </Button>
              </div>
            </div>
          )}

          {selectedTextAnnotation && (
            <div className="pointer-events-auto w-80 rounded-2xl border border-border/60 bg-popover/95 p-3 shadow-2xl shadow-black/25 app-panel-enter">
              <div className="mb-2 flex items-start justify-between gap-3">
                <div>
                  <div className="text-sm font-medium">Text annotation</div>
                  <div className="text-xs text-muted-foreground">
                    Page {selectedTextAnnotation.page}
                  </div>
                </div>
                <Button
                  size="icon"
                  variant="ghost"
                  className="size-8"
                  onClick={() => setSelectedTextAnnotationId(null)}
                >
                  <PanelRightClose size={14} />
                </Button>
              </div>
              <Textarea
                value={selectedTextAnnotation.text}
                onChange={(event) =>
                  updateTextAnnotation(selectedTextAnnotation.id, event.target.value)
                }
                placeholder="Write inside this PDF text box…"
                className="min-h-[140px]"
              />
              <div className="mt-3">
                <div className="mb-2 text-xs font-medium text-muted-foreground">Style</div>
                <div className="flex flex-wrap gap-2">
                  {PDF_TEXT_ANNOTATION_STYLES.map((style) => {
                    const palette = getPdfTextAnnotationPalette(selectedTextAnnotation);
                    const isActive =
                      palette.backgroundColor === style.backgroundColor &&
                      palette.textColor === style.textColor;
                    return (
                      <button
                        key={style.id}
                        type="button"
                        onClick={() =>
                          updateTextAnnotationPalette(selectedTextAnnotation.id, style)
                        }
                        className={cn(
                          'rounded-md border px-2.5 py-1.5 text-xs transition-colors',
                          isActive && 'ring-2 ring-primary/35',
                        )}
                        style={{
                          backgroundColor: style.backgroundColor,
                          color: style.textColor,
                          borderColor: style.borderColor,
                        }}
                      >
                        {style.label}
                      </button>
                    );
                  })}
                </div>
              </div>
              <div className="mt-3 flex justify-end">
                <Button
                  size="sm"
                  variant="ghost"
                  className="gap-1.5 text-destructive hover:text-destructive"
                  onClick={() => removeTextAnnotation(selectedTextAnnotation.id)}
                >
                  <Trash2 size={14} />
                  Remove text box
                </Button>
              </div>
            </div>
          )}
        </div>

        {bookmarksOpen && (
          <aside className="absolute right-5 top-5 z-10 w-72 rounded-2xl border border-border/60 bg-popover/92 p-3 shadow-2xl shadow-black/25 backdrop-blur-sm-webkit app-panel-enter">
            <div className="mb-3 flex items-center justify-between gap-3">
              <div>
                <div className="text-sm font-medium">Bookmarks</div>
                <div className="text-xs text-muted-foreground">
                  {pdfState.bookmarks.length} saved
                </div>
              </div>
              <Button
                size="icon"
                variant="ghost"
                className="size-8"
                onClick={() => setBookmarksOpen(false)}
              >
                <PanelRightClose size={14} />
              </Button>
            </div>
            <div className="max-h-[50vh] space-y-2 overflow-auto pr-1">
              {pdfState.bookmarks.length === 0 ? (
                <div className="rounded-xl border border-dashed border-border/60 px-3 py-5 text-center text-xs text-muted-foreground">
                  No bookmarks yet. Save the current page from the top bar.
                </div>
              ) : (
                pdfState.bookmarks.map((bookmark) => (
                  <div
                    key={bookmark.id}
                    className="rounded-xl border border-border/50 bg-muted/20 p-2.5"
                  >
                    <button
                      type="button"
                      className="flex w-full items-center justify-between gap-3 text-left"
                      onClick={() => goToPage(bookmark.page)}
                    >
                      <div className="flex items-center gap-2 text-sm font-medium">
                        <Bookmark size={14} className="text-primary" />
                        Page {bookmark.page}
                      </div>
                    </button>
                    <Input
                      value={bookmark.label ?? ''}
                      onChange={(event) => updateBookmarkLabel(bookmark.id, event.target.value)}
                      className="mt-2 h-8 text-xs"
                      placeholder={`Page ${bookmark.page}`}
                    />
                    <div className="mt-2 flex justify-end">
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-7 gap-1 text-xs text-destructive hover:text-destructive"
                        onClick={() => removeBookmark(bookmark.id)}
                      >
                        <Trash2 size={12} />
                        Remove
                      </Button>
                    </div>
                  </div>
                ))
              )}
            </div>

            <div className="mt-4 border-t border-border/40 pt-4">
              <div className="mb-3 flex items-center justify-between gap-3">
                <div>
                  <div className="text-sm font-medium">Page comments</div>
                  <div className="text-xs text-muted-foreground">
                    {pdfState.pageComments.length} saved
                  </div>
                </div>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7 gap-1 text-xs"
                  onClick={addPageCommentForCurrentPage}
                >
                  <MessageSquare size={12} />
                  Add
                </Button>
              </div>
              <div className="max-h-[36vh] space-y-2 overflow-auto pr-1">
                {pdfState.pageComments.length === 0 ? (
                  <div className="rounded-xl border border-dashed border-border/60 px-3 py-5 text-center text-xs text-muted-foreground">
                    No page comments yet.
                  </div>
                ) : (
                  pdfState.pageComments.map((comment) => (
                    <div
                      key={comment.id}
                      className="rounded-xl border border-border/50 bg-muted/20 p-2.5"
                    >
                      <button
                        type="button"
                        className="mb-2 flex w-full items-center justify-between gap-3 text-left"
                        onClick={() => {
                          goToPage(comment.page);
                          setSelectedPageCommentId(comment.id);
                        }}
                      >
                        <div className="flex items-center gap-2 text-sm font-medium">
                          <MessageSquare size={14} className="text-primary" />
                          Page {comment.page}
                        </div>
                      </button>
                      <Textarea
                        value={comment.content}
                        onChange={(event) => updatePageComment(comment.id, event.target.value)}
                        placeholder={`Comment for page ${comment.page}`}
                        className={cn(
                          'min-h-[96px] text-xs',
                          selectedPageCommentId === comment.id && 'ring-1 ring-primary/30',
                        )}
                      />
                      <div className="mt-2 flex justify-end">
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-7 gap-1 text-xs text-destructive hover:text-destructive"
                          onClick={() => removePageComment(comment.id)}
                        >
                          <Trash2 size={12} />
                          Remove
                        </Button>
                      </div>
                    </div>
                  ))
                )}
              </div>
            </div>
          </aside>
        )}

        {interactionMode !== 'none' && !regionSelection && (
          <div className="absolute left-1/2 top-5 z-10 -translate-x-1/2 rounded-full border border-border/60 bg-popover/92 px-4 py-2 text-xs text-muted-foreground shadow-lg">
            {interactionMode === 'snapshot'
              ? 'Drag across a page to capture a region snapshot.'
              : interactionMode === 'ocr'
                ? 'Drag across a page to recognize text in that region.'
                : 'Drag across a page to place a text annotation box.'}
          </div>
        )}

        <div
          ref={viewportRef}
          tabIndex={0}
          className="relative min-h-0 h-full overflow-auto bg-[radial-gradient(circle_at_top,oklch(0.24_0.04_230_/_0.08),transparent_42%),linear-gradient(to_bottom,color-mix(in_oklch,var(--background)_92%,black_8%),var(--background))]"
          onPointerDown={() => viewportRef.current?.focus()}
          onPointerDownCapture={handleWorkspacePointerDown}
        >
          <div
            className="flex min-h-full min-w-full items-start justify-center"
            style={{
              width: `${workspaceMetrics.width}px`,
              minWidth: '100%',
              height: `${workspaceMetrics.height}px`,
              minHeight: '100%',
              padding: `${WORKSPACE_PADDING}px`,
            }}
          >
            <div
              className={cn(
                'shrink-0',
                layoutMode === 'single' && 'flex items-start justify-center',
                layoutMode === 'scroll' && 'flex flex-col items-center gap-5',
                layoutMode === 'spread' && 'grid items-start justify-center gap-5',
              )}
              style={
                layoutMode === 'spread'
                  ? { gridTemplateColumns: 'repeat(2, max-content)' }
                  : undefined
              }
            >
              {renderedPages.map((renderedPage) => (
                <PdfPageCanvas
                  key={renderedPage}
                  documentCacheKey={documentCacheKey}
                  documentProxy={documentProxy}
                  pageNumber={renderedPage}
                  scale={effectiveScale}
                  rotation={rotation}
                  active={renderedPage === pageNumber}
                  eager={layoutMode === 'single'}
                  observerRoot={viewportRef.current}
                  estimatedSize={pageSizes[renderedPage] ?? activePageSize}
                  onMeasured={handleMeasured}
                  registerSurface={registerSurface}
                  highlights={pdfState.highlights.filter(
                    (highlight) => highlight.page === renderedPage,
                  )}
                  textAnnotations={pdfState.textAnnotations.filter(
                    (annotation) => annotation.page === renderedPage,
                  )}
                  selectedHighlightId={selectedHighlightId}
                  selectedTextAnnotationId={selectedTextAnnotationId}
                  onHighlightClick={(highlight) => setSelectedHighlightId(highlight.id)}
                  onTextAnnotationClick={(annotation) => setSelectedTextAnnotationId(annotation.id)}
                  onTextAnnotationPointerDown={handleTextAnnotationPointerDown}
                  regionSelection={regionSelection}
                  interactionMode={interactionMode}
                  ocrWords={
                    ocrOverlayVisible && ocrOverlay?.page === renderedPage ? ocrOverlay.words : []
                  }
                />
              ))}
            </div>
          </div>
        </div>
      </div>

      <PdfSendTargetDialog
        open={!!pendingSendAction}
        mode={pendingSendAction?.mode ?? 'quote'}
        currentNotePath={currentNotePath}
        currentCanvasPath={currentCanvasPath}
        availableNotes={availableNotes}
        onConfirm={handleSendTargetConfirm}
        onClose={() => setPendingSendAction(null)}
      />
    </div>
  );
}
