import { useEffect, useMemo, useRef, useState } from 'react';
import { getDocument, GlobalWorkerOptions, PixelsPerInch, RenderingCancelledException, TextLayer } from 'pdfjs-dist';
import type { PDFDocumentProxy, RenderTask } from 'pdfjs-dist';
import {
  ChevronLeft,
  ChevronRight,
  Columns2,
  FileText,
  Loader2,
  Maximize2,
  Minus,
  Plus,
  Rows3,
  RotateCw,
} from 'lucide-react';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { cn } from '../lib/utils';
import { tauriCommands } from '../lib/tauri';
import { useVaultStore } from '../store/vaultStore';
import {
  DocumentTopBar,
  documentTopBarGroupClass,
  getDocumentBaseName,
  getDocumentFolderPath,
} from '../components/layout/DocumentTopBar';

const workerUrl = new URL('pdfjs-dist/build/pdf.worker.mjs', import.meta.url).toString();
GlobalWorkerOptions.workerSrc = workerUrl;

type ZoomMode = 'custom' | 'fit-width' | 'fit-height' | 'fit-page';
type LayoutMode = 'single' | 'scroll' | 'spread';

const ZOOM_MIN = 0.5;
const ZOOM_MAX = 3;
const ZOOM_STEP = 0.1;
const DEVICE_SCALE_LIMIT = 2;
const WORKSPACE_PADDING = 40;
const PAGE_GAP = 20;
const PDF_CSS_SCALE = PixelsPerInch.PDF_TO_CSS_UNITS;

interface WebKitGestureEvent extends Event {
  scale: number;
}

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

interface PdfPageCanvasProps {
  documentProxy: PDFDocumentProxy;
  pageNumber: number;
  scale: number;
  rotation: number;
  active: boolean;
  onMeasured: (pageNumber: number, width: number, height: number) => void;
}

function PdfPageCanvas({ documentProxy, pageNumber, scale, rotation, active, onMeasured }: PdfPageCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const textLayerRef = useRef<HTMLDivElement | null>(null);
  const renderTaskRef = useRef<RenderTask | null>(null);
  const textLayerTaskRef = useRef<TextLayer | null>(null);
  const hasRenderedRef = useRef(false);
  const [rendering, setRendering] = useState(true);
  const [hasRendered, setHasRendered] = useState(false);
  const [renderError, setRenderError] = useState<string | null>(null);

  useEffect(() => {
    if (!canvasRef.current || !textLayerRef.current) return;

    let cancelled = false;
    if (!hasRenderedRef.current) setRendering(true);
    setRenderError(null);
    if (renderTaskRef.current) {
      void renderTaskRef.current.promise.catch(() => {});
      renderTaskRef.current.cancel();
    }
    textLayerTaskRef.current?.cancel();

    const renderPage = async () => {
      try {
        const page = await documentProxy.getPage(pageNumber);
        if (cancelled || !canvasRef.current || !textLayerRef.current) return;

        const renderScale = scale * PDF_CSS_SCALE;
        const viewport = page.getViewport({ scale: renderScale, rotation });
        const baseViewport = page.getViewport({ scale: 1, rotation: 0 });
        onMeasured(pageNumber, baseViewport.width, baseViewport.height);

        const canvas = canvasRef.current;
        const textLayer = textLayerRef.current;
        const context = canvas.getContext('2d', { alpha: false });
        if (!context) throw new Error('Failed to get PDF canvas context');

        const deviceScale = Math.min(window.devicePixelRatio || 1, DEVICE_SCALE_LIMIT);
        canvas.width = Math.max(1, Math.floor(viewport.width * deviceScale));
        canvas.height = Math.max(1, Math.floor(viewport.height * deviceScale));
        canvas.style.width = `${viewport.width}px`;
        canvas.style.height = `${viewport.height}px`;
        context.setTransform(deviceScale, 0, 0, deviceScale, 0, 0);

        textLayer.replaceChildren();
        textLayer.style.width = `${viewport.width}px`;
        textLayer.style.height = `${viewport.height}px`;
        textLayer.style.setProperty('--scale-factor', String(renderScale));
        textLayer.style.setProperty('--total-scale-factor', String(renderScale));
        textLayer.style.setProperty('--user-unit', '1');

        const task = page.render({
          canvas,
          canvasContext: context,
          viewport,
        });
        renderTaskRef.current = task;

        const textContent = await page.getTextContent();
        if (cancelled || !textLayerRef.current) return;

        const textLayerTask = new TextLayer({
          container: textLayer,
          textContentSource: textContent,
          viewport,
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
        if (!cancelled) {
          hasRenderedRef.current = true;
          setHasRendered(true);
          setRendering(false);
        }
      } catch (error: unknown) {
        if (cancelled) return;
        if (error instanceof RenderingCancelledException) return;
        const message = error instanceof Error ? error.message : String(error);
        if (message.toLowerCase().includes('rendering cancelled')) return;
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
  }, [documentProxy, onMeasured, pageNumber, rotation, scale]);

  return (
    <div
      className={cn(
        'relative overflow-hidden rounded-2xl border bg-card shadow-2xl shadow-black/20 transition-[transform,border-color,box-shadow] app-motion-fast',
        active ? 'border-primary/35 shadow-primary/10' : 'border-border/60',
      )}
      data-pdf-page={pageNumber}
    >
      <canvas ref={canvasRef} className="block bg-white" />
      <div ref={textLayerRef} className="pdf-text-layer textLayer" />
      {rendering && !hasRendered && (
        <div className="absolute inset-0 flex items-center justify-center bg-background/28 backdrop-blur-2px-webkit">
          <div className="flex items-center gap-2 rounded-xl border border-border/60 bg-popover/90 px-3 py-2 text-sm text-muted-foreground shadow-lg">
            <Loader2 size={16} className="animate-spin" />
            Rendering page {pageNumber}…
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
  const { vault } = useVaultStore();
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const pageRefs = useRef<Record<number, HTMLDivElement | null>>({});
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

    void tauriCommands.readNoteAssetDataUrl(vault.path, relativePath)
      .then(async (dataUrl) => {
        const data = dataUrlToUint8Array(dataUrl);
        const task = getDocument({ data });
        const pdf = await task.promise;
        if (cancelled) {
          await pdf.destroy().catch(() => {});
          return null;
        }
        return pdf;
      })
      .then(async (pdf) => {
        if (!pdf || cancelled) return;
        const firstPage = await pdf.getPage(1);
        if (cancelled) return;
        const initialViewport = firstPage.getViewport({ scale: 1, rotation: 0 });
        setPageSizes({ 1: { width: initialViewport.width, height: initialViewport.height } });
        setDocumentProxy(pdf);
        setPageCount(pdf.numPages);
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
  }, [relativePath, vault]);

  const activePageSize = pageSizes[pageNumber] ?? pageSizes[1] ?? null;
  const rotatedPageSize = useMemo(
    () => (activePageSize
      ? rotation % 180 === 0
        ? activePageSize
        : { width: activePageSize.height, height: activePageSize.width }
      : null),
    [activePageSize, rotation],
  );

  const effectiveScale = useMemo(() => {
    if (!rotatedPageSize || containerSize.width <= 0 || containerSize.height <= 0) {
      return zoom;
    }

    const availableWidth = Math.max(120, containerSize.width - WORKSPACE_PADDING * 2);
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
  }, [containerSize.height, containerSize.width, layoutMode, rotatedPageSize, zoom, zoomMode]);

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
    const contentWidth = layoutMode === 'spread'
      ? scaledPageWidth * 2 + PAGE_GAP
      : scaledPageWidth;
    const contentHeight = layoutMode === 'scroll'
      ? scaledPageHeight * pageTotal + PAGE_GAP * Math.max(0, pageTotal - 1)
      : scaledPageHeight;

    return {
      width: Math.max(containerSize.width, contentWidth + WORKSPACE_PADDING * 2),
      height: Math.max(containerSize.height, contentHeight + WORKSPACE_PADDING * 2),
    };
  }, [containerSize.height, containerSize.width, effectiveScale, layoutMode, renderedPages.length, rotatedPageSize]);

  const zoomLabel = zoomMode === 'custom'
    ? `${Math.round(effectiveScale * 100)}%`
    : zoomMode === 'fit-width'
    ? 'Fit width'
    : zoomMode === 'fit-height'
    ? 'Fit height'
    : 'Fit page';

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

  const handleMeasured = (nextPage: number, width: number, height: number) => {
    setPageSizes((current) => {
      const existing = current[nextPage];
      if (existing?.width === width && existing?.height === height) return current;
      return { ...current, [nextPage]: { width, height } };
    });
  };

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

    const isEventInsidePdf = (target: EventTarget | null) => target instanceof Node && viewport.contains(target);
    const isEditableTarget = (target: EventTarget | null) => (
      target instanceof HTMLElement
      && target.matches('input, textarea, [contenteditable="true"], [contenteditable=""], [role="textbox"]')
    );

    // Keep PDF zoom shortcuts independent from scroll-container focus and from the
    // app-wide browser zoom blocker.
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
      const scale = 'scale' in event && typeof (event as WebKitGestureEvent).scale === 'number'
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
      document.removeEventListener('keydown', handleKeyDown, { capture: true } as EventListenerOptions);
      document.removeEventListener('wheel', handleWheel, { capture: true } as EventListenerOptions);
      document.removeEventListener('gesturestart', handleGestureStart, { capture: true } as EventListenerOptions);
      document.removeEventListener('gesturechange', handleGestureChange, { capture: true } as EventListenerOptions);
    };
  }, [effectiveScale, layoutMode, pageCount, pageNumber]);

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center text-muted-foreground">
        Loading PDF…
      </div>
    );
  }

  if (error || !documentProxy) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 text-muted-foreground">
        <FileText size={36} className="opacity-40" />
        <div className="text-base font-medium">Unable to open PDF</div>
        <div className="max-w-md text-center text-sm opacity-70">{error ?? 'Unknown PDF error'}</div>
      </div>
    );
  }

  return (
    <div className="pdf-view flex h-full min-h-0 flex-col bg-background">
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
            <Button
              size="sm"
              variant="ghost"
              className={cn('h-8 gap-1.5 px-2.5 text-xs', zoomMode === 'fit-width' && 'bg-accent text-accent-foreground')}
              onClick={() => setZoomMode('fit-width')}
            >
              <Rows3 size={14} />
              Fit width
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className={cn('h-8 gap-1.5 px-2.5 text-xs', zoomMode === 'fit-height' && 'bg-accent text-accent-foreground')}
              onClick={() => setZoomMode('fit-height')}
            >
              <Columns2 size={14} />
              Fit height
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className={cn('h-8 gap-1.5 px-2.5 text-xs', zoomMode === 'fit-page' && 'bg-accent text-accent-foreground')}
              onClick={() => setZoomMode('fit-page')}
            >
              <Maximize2 size={14} />
              Fit page
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="h-8 gap-1.5 px-2.5 text-xs"
              onClick={() => setRotation((current) => (current + 90) % 360)}
            >
              <RotateCw size={14} />
              Rotate
            </Button>
          </div>

          {pageCount > 1 && (
            <div className={documentTopBarGroupClass}>
              <Button
                size="sm"
                variant="ghost"
                className={cn('h-8 gap-1.5 px-2.5 text-xs', layoutMode === 'single' && 'bg-accent text-accent-foreground')}
                onClick={() => setLayoutMode('single')}
              >
                Single
              </Button>
              <Button
                size="sm"
                variant="ghost"
                className={cn('h-8 gap-1.5 px-2.5 text-xs', layoutMode === 'scroll' && 'bg-accent text-accent-foreground')}
                onClick={() => setLayoutMode('scroll')}
              >
                <Rows3 size={14} />
                Long scroll
              </Button>
              <Button
                size="sm"
                variant="ghost"
                className={cn('h-8 gap-1.5 px-2.5 text-xs', layoutMode === 'spread' && 'bg-accent text-accent-foreground')}
                onClick={() => setLayoutMode('spread')}
              >
                <Columns2 size={14} />
                Side by side
              </Button>
            </div>
          )}
          </>
        }
      />

      <div
        ref={viewportRef}
        tabIndex={0}
        className="relative min-h-0 flex-1 overflow-auto bg-[radial-gradient(circle_at_top,oklch(0.24_0.04_230_/_0.08),transparent_42%),linear-gradient(to_bottom,color-mix(in_oklch,var(--background)_92%,black_8%),var(--background))]"
        onPointerDown={() => viewportRef.current?.focus()}
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
            style={layoutMode === 'spread' ? { gridTemplateColumns: 'repeat(2, max-content)' } : undefined}
          >
            {renderedPages.map((renderedPage) => (
              <div
                key={renderedPage}
                ref={(element) => {
                  pageRefs.current[renderedPage] = element;
                }}
              >
                <PdfPageCanvas
                  documentProxy={documentProxy}
                  pageNumber={renderedPage}
                  scale={effectiveScale}
                  rotation={rotation}
                  active={renderedPage === pageNumber}
                  onMeasured={handleMeasured}
                />
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
