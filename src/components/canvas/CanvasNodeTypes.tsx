import { useEffect, useRef, useState, type ReactNode } from 'react';
import { FileImage, FileText, Globe, Layout, LayoutDashboard, PencilLine } from 'lucide-react';
import { Handle, NodeResizer, Position, useStore } from '@xyflow/react';

import { MarkdownPreview } from '../editor/MarkdownPreview';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select';
import { cn } from '../../lib/utils';
import type { CanvasWebDisplayMode } from '../../types/canvas';
import { normalizeWebPreviewUrl } from '../../lib/webPreviewCache';

const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico', 'avif']);

export interface CanvasNodeData extends Record<string, unknown> {
  title: string;
  subtitle?: string;
  excerpt?: string;
  imageSrc?: string | null;
  faviconSrc?: string | null;
  markdownContent?: string;
  relativePath?: string;
  extension?: string;
  content?: string;
  url?: string;
  hasRichPreview?: boolean;
  previewError?: string | null;
  previewLoading?: boolean;
  previewLoaded?: boolean;
  previewAutoLoadEnabled?: boolean;
  webPreviewsEnabled?: boolean;
  displayMode?: CanvasWebDisplayMode;
  displayModeOverride?: CanvasWebDisplayMode | null;
  onWebUrlChange?: (nodeId: string, url: string) => void;
  onWebDisplayModeOverrideChange?: (nodeId: string, mode: CanvasWebDisplayMode | null) => void;
  onRequestWebPreview?: (nodeId: string) => void;
  onOpenUrl?: (url: string) => void;
  onOpen?: (path: string) => void;
  onTextChange?: (nodeId: string, content: string) => void;
  onWikilinkClick?: (path: string) => void;
  onSnapToGrid?: (nodeId: string) => void;
}

function getFileIcon(extension: string) {
  const normalizedExtension = extension.toLowerCase();
  if (IMAGE_EXTENSIONS.has(normalizedExtension)) return <FileImage size={14} className="shrink-0 text-sky-400/80" />;
  if (normalizedExtension === 'canvas') return <Layout size={14} className="shrink-0 text-blue-400/70" />;
  if (normalizedExtension === 'kanban') return <LayoutDashboard size={14} className="shrink-0 text-emerald-400/70" />;
  return <FileText size={14} className="shrink-0 text-muted-foreground/70" />;
}

function normalizeWebUrl(value: string) {
  return normalizeWebPreviewUrl(value);
}

function CanvasCardFrame({
  selected,
  children,
}: {
  selected?: boolean;
  children: ReactNode;
}) {
  return (
    <div
      className={cn(
        'flex h-full w-full flex-col overflow-hidden rounded-2xl border bg-card/96 text-card-foreground shadow-lg backdrop-blur-xs-webkit transition-[transform,width,height,box-shadow,border-color] app-motion-fast',
        selected
          ? 'border-primary/60 shadow-primary/15'
          : 'border-border/70 shadow-black/12 hover:shadow-black/18',
      )}
    >
      {children}
    </div>
  );
}

function CardHandles() {
  const connectionInProgress = useStore((state) => state.connection.inProgress);
  const handleClassName = cn(
    '!h-4 !w-4 !border-2 !border-background !bg-primary/90 shadow-[0_0_0_6px_color-mix(in_oklch,var(--primary)_16%,transparent)] transition-[transform,box-shadow,opacity] duration-150',
    connectionInProgress
      ? '!opacity-100 scale-110 shadow-[0_0_0_8px_color-mix(in_oklch,var(--primary)_20%,transparent)]'
      : '!opacity-0 group-hover:!opacity-100 group-hover:scale-110 group-hover:shadow-[0_0_0_8px_color-mix(in_oklch,var(--primary)_20%,transparent)]',
  );

  return (
    <>
      <Handle
        type="target"
        position={Position.Left}
        className={handleClassName}
      />
      <Handle
        type="source"
        position={Position.Right}
        className={handleClassName}
      />
    </>
  );
}

function NoteCardNode({ id, data, selected }: { id: string; data: CanvasNodeData; selected?: boolean }) {
  return (
    <div className="group relative h-full w-full">
      <NodeResizer
        isVisible={!!selected}
        minWidth={220}
        minHeight={140}
        lineClassName="!border-primary/30"
        handleClassName="!border-primary/50 !bg-background !w-3 !h-3"
        onResizeEnd={() => data.onSnapToGrid?.(id)}
      />
      <CanvasCardFrame selected={selected}>
        <button
          onDoubleClick={() => data.relativePath && data.onOpen?.(data.relativePath)}
          className="flex h-full flex-col text-left"
          type="button"
        >
          <div className="flex items-center gap-2 border-b border-border/60 px-3 py-2">
            <div className="flex size-7 items-center justify-center rounded-xl bg-primary/12 text-primary">
              <FileText size={14} />
            </div>
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-semibold">{data.title}</div>
              <div className="truncate text-[11px] text-muted-foreground">{data.subtitle}</div>
            </div>
          </div>
          <div className="min-h-0 flex-1 overflow-hidden px-3 py-3 text-sm text-muted-foreground">
            {data.markdownContent ? (
              <MarkdownPreview
                content={data.markdownContent}
                className="h-full overflow-hidden text-[13px] leading-relaxed [&_.contains-task-list]:pl-4 [&_blockquote]:border-l-2 [&_blockquote]:border-primary/30 [&_blockquote]:pl-3 [&_h1]:mb-2 [&_h1]:text-xl [&_h2]:mb-2 [&_h2]:text-lg [&_h3]:mb-1 [&_img]:hidden [&_ol]:pl-5 [&_p]:mb-2 [&_pre]:hidden [&_table]:hidden [&_ul]:pl-5"
                onWikilinkClick={data.onWikilinkClick}
              />
            ) : (
              <div className="line-clamp-6 whitespace-pre-wrap leading-relaxed">
                {data.excerpt || 'Double-click to open the note.'}
              </div>
            )}
          </div>
        </button>
      </CanvasCardFrame>
      <CardHandles />
    </div>
  );
}

function FileCardNode({ id, data, selected }: { id: string; data: CanvasNodeData; selected?: boolean }) {
  const isImage = !!data.imageSrc;

  return (
    <div className="group relative h-full w-full">
      <NodeResizer
        isVisible={!!selected}
        minWidth={220}
        minHeight={140}
        lineClassName="!border-primary/30"
        handleClassName="!border-primary/50 !bg-background !w-3 !h-3"
        onResizeEnd={() => data.onSnapToGrid?.(id)}
      />
      <CanvasCardFrame selected={selected}>
        <button
          onDoubleClick={() => data.relativePath && data.onOpen?.(data.relativePath)}
          className="flex h-full flex-col text-left"
          type="button"
        >
          <div className="flex items-center gap-2 border-b border-border/60 px-3 py-2">
            <div className="flex size-7 items-center justify-center rounded-xl bg-primary/12 text-primary">
              {data.extension ? getFileIcon(data.extension) : <FileText size={14} />}
            </div>
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-semibold">{data.title}</div>
              <div className="truncate text-[11px] text-muted-foreground">{data.subtitle}</div>
            </div>
          </div>

          {isImage ? (
            <div className="flex min-h-0 flex-1 items-center justify-center bg-background/50 p-3">
              <img src={data.imageSrc ?? ''} alt={data.title} className="max-h-full max-w-full rounded-xl object-contain" draggable={false} />
            </div>
          ) : (
            <div className="flex min-h-0 flex-1 flex-col justify-between px-3 py-3">
              <div className="line-clamp-6 whitespace-pre-wrap text-sm leading-relaxed text-muted-foreground">
                {data.excerpt || 'Double-click to open this file.'}
              </div>
              <div className="mt-3 flex items-center gap-2 text-[11px] text-muted-foreground/80">
                <span className="rounded-md border border-border/60 bg-background/60 px-1.5 py-0.5 uppercase tracking-wide">
                  {data.extension || 'file'}
                </span>
                <span className="truncate">{data.relativePath}</span>
              </div>
            </div>
          )}
        </button>
      </CanvasCardFrame>
      <CardHandles />
    </div>
  );
}

function TextCardNode({ id, data, selected }: { id: string; data: CanvasNodeData; selected?: boolean }) {
  return (
    <div className="group relative h-full w-full">
      <NodeResizer
        isVisible={!!selected}
        minWidth={200}
        minHeight={120}
        lineClassName="!border-primary/30"
        handleClassName="!border-primary/50 !bg-background !w-3 !h-3"
        onResizeEnd={() => data.onSnapToGrid?.(id)}
      />
      <CanvasCardFrame selected={selected}>
        <div className="flex items-center gap-2 border-b border-border/60 px-3 py-2">
          <div className="flex size-7 items-center justify-center rounded-xl bg-primary/12 text-primary">
            <PencilLine size={14} />
          </div>
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-semibold">Text</div>
            <div className="truncate text-[11px] text-muted-foreground">Canvas note</div>
          </div>
        </div>
        <textarea
          value={data.content ?? ''}
          placeholder="Write directly on the canvas…"
          onChange={(event) => data.onTextChange?.(id, event.target.value)}
          className="min-h-0 flex-1 resize-none bg-transparent px-3 py-3 text-sm leading-relaxed text-foreground outline-none placeholder:text-muted-foreground/60"
          onPointerDown={(event) => event.stopPropagation()}
        />
      </CanvasCardFrame>
      <CardHandles />
    </div>
  );
}

function WebCardNode({ id, data, selected }: { id: string; data: CanvasNodeData; selected?: boolean }) {
  const effectiveMode = data.displayMode ?? 'preview';
  const normalizedUrl = normalizeWebUrl(data.url ?? '');
  const canEmbed = normalizedUrl.startsWith('http://') || normalizedUrl.startsWith('https://');
  const canActuallyEmbed = canEmbed && data.embedAvailable !== false;
  const showingEmbedFallback = effectiveMode === 'embed' && !canActuallyEmbed && !!normalizedUrl;
  const previewLoading = data.previewLoading ?? false;
  const previewLoaded = data.previewLoaded ?? false;
  const previewAutoLoadEnabled = data.previewAutoLoadEnabled ?? true;
  const webPreviewsEnabled = data.webPreviewsEnabled ?? true;
  const showManualPreviewLoad = webPreviewsEnabled && !previewAutoLoadEnabled && !!normalizedUrl && !previewLoading && !previewLoaded;
  const [embedActivated, setEmbedActivated] = useState(false);
  const [iframeState, setIframeState] = useState<'idle' | 'loading' | 'loaded' | 'timed_out'>('idle');
  const previousModeRef = useRef<CanvasWebDisplayMode>(effectiveMode);

  useEffect(() => {
    if (effectiveMode === 'embed' && previousModeRef.current !== 'embed' && normalizedUrl) {
      setEmbedActivated(true);
    }
    if (effectiveMode !== 'embed') {
      setEmbedActivated(false);
    }
    previousModeRef.current = effectiveMode;
  }, [effectiveMode, normalizedUrl]);

  useEffect(() => {
    if (effectiveMode === 'embed' && canActuallyEmbed && embedActivated) {
      setIframeState('loading');
      const timeout = window.setTimeout(() => {
        setIframeState((current) => (current === 'loaded' ? current : 'timed_out'));
      }, 4500);
      return () => {
        window.clearTimeout(timeout);
      };
    }

    setIframeState('idle');
    return undefined;
  }, [effectiveMode, normalizedUrl, canActuallyEmbed, embedActivated]);

  const statusChip = showingEmbedFallback
    ? { label: 'Blocked', className: 'border-amber-500/30 bg-amber-500/10 text-amber-200' }
    : effectiveMode === 'embed' && !embedActivated
    ? { label: 'Paused', className: 'border-sky-500/30 bg-sky-500/10 text-sky-200' }
    : effectiveMode === 'embed' && iframeState === 'loaded'
    ? { label: 'Embedded', className: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-200' }
    : effectiveMode === 'embed'
    ? { label: 'Loading', className: 'border-primary/30 bg-primary/10 text-primary' }
    : { label: 'Preview', className: 'border-border/60 bg-background/60 text-muted-foreground' };

  return (
    <div className="group relative h-full w-full">
      <NodeResizer
        isVisible={!!selected}
        minWidth={260}
        minHeight={180}
        lineClassName="!border-primary/30"
        handleClassName="!border-primary/50 !bg-background !w-3 !h-3"
        onResizeEnd={() => data.onSnapToGrid?.(id)}
      />
      <CanvasCardFrame selected={selected}>
        <div className="flex h-full flex-col">
          <div className="flex items-center gap-2 border-b border-border/60 px-3 py-2">
            <div className="flex size-7 items-center justify-center overflow-hidden rounded-xl bg-primary/12 text-primary">
              {data.faviconSrc ? (
                <img src={data.faviconSrc} alt="" className="size-4 rounded-sm object-contain" draggable={false} />
              ) : (
                <Globe size={14} />
              )}
            </div>
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-semibold">{data.title || 'Web card'}</div>
              <div className="truncate text-[11px] text-muted-foreground">{data.subtitle || 'Website'}</div>
            </div>
            {normalizedUrl ? (
              <Button
                size="sm"
                variant="ghost"
                className="h-7 px-2 text-[11px]"
                onClick={() => data.onOpenUrl?.(normalizedUrl)}
                onPointerDown={(event) => event.stopPropagation()}
              >
                Open
              </Button>
            ) : null}
          </div>

          <div className="flex items-center gap-2 border-b border-border/50 px-3 py-2">
            <Input
              value={data.url ?? ''}
              placeholder="example.com or https://example.com"
              onChange={(event) => data.onWebUrlChange?.(id, event.target.value)}
              onPointerDown={(event) => event.stopPropagation()}
              className="h-8 text-xs"
            />
            <div className={cn('shrink-0 rounded-md border px-2 py-1 text-[11px] font-medium', statusChip.className)}>
              {statusChip.label}
            </div>
            <Select
              value={data.displayModeOverride ?? 'default'}
              onValueChange={(value) => data.onWebDisplayModeOverrideChange?.(id, value === 'default' ? null : value as CanvasWebDisplayMode)}
            >
              <SelectTrigger size="sm" className="h-8 min-w-[118px] bg-background/70 text-xs" onPointerDown={(event) => event.stopPropagation()}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent align="end">
                <SelectItem value="default">App default</SelectItem>
                <SelectItem value="preview">Preview</SelectItem>
                <SelectItem value="embed">Embed</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="min-h-0 flex-1 overflow-hidden">
            {effectiveMode === 'embed' && canActuallyEmbed && embedActivated ? (
              <div
                className="relative h-full w-full bg-background"
                onPointerDown={(event) => event.stopPropagation()}
                onWheelCapture={(event) => event.stopPropagation()}
                onWheel={(event) => event.stopPropagation()}
              >
                <iframe
                  key={normalizedUrl}
                  src={normalizedUrl}
                  title={data.title || data.url || 'Embedded website'}
                  className="nowheel nopan h-full w-full border-0 bg-background"
                  sandbox="allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox allow-forms allow-modals allow-downloads"
                  allow="fullscreen; clipboard-read; clipboard-write; autoplay"
                  loading="lazy"
                  onPointerDown={(event) => event.stopPropagation()}
                  onLoad={() => setIframeState('loaded')}
                />
                {iframeState !== 'loaded' ? (
                  <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-background/92 px-6 text-center">
                    <div className="max-w-xs space-y-2">
                      <div className="text-sm font-medium text-foreground">
                        {iframeState === 'timed_out' ? 'Embedding may be blocked' : 'Loading website…'}
                      </div>
                      <div className="text-xs leading-relaxed text-muted-foreground">
                        {iframeState === 'timed_out'
                          ? 'Some sites refuse in-app embedding. If the card stays blank, use preview mode or open the page externally.'
                          : 'Trying to render the page inside the card.'}
                      </div>
                    </div>
                  </div>
                ) : null}
              </div>
            ) : effectiveMode === 'embed' && canActuallyEmbed ? (
              <div className="flex h-full items-center justify-center bg-background/40 px-6 text-center">
                <div className="max-w-xs space-y-3">
                  <div className="text-sm font-medium text-foreground">Embedded page paused</div>
                  <div className="text-xs leading-relaxed text-muted-foreground">
                    We keep embedded pages from auto-loading on app open so the canvas stays responsive.
                  </div>
                  <Button
                    size="sm"
                    variant="secondary"
                    className="h-8 gap-2"
                    onClick={() => setEmbedActivated(true)}
                    onPointerDown={(event) => event.stopPropagation()}
                  >
                    Load embed
                  </Button>
                </div>
              </div>
            ) : (
              <div className="flex h-full flex-col overflow-hidden">
                {showingEmbedFallback ? (
                  <div className="border-b border-border/50 bg-amber-500/10 px-3 py-2 text-[11px] text-amber-200">
                    Embedded view is unavailable for this site. Showing link preview instead.
                  </div>
                ) : null}
                {data.imageSrc ? (
                  <div className="min-h-0 flex-[1.35] border-b border-border/50 bg-background/40">
                    <img src={data.imageSrc} alt={data.title || 'Website preview'} className="h-full w-full object-cover" draggable={false} />
                  </div>
                ) : (
                  <div className="flex min-h-[120px] flex-[1.1] items-center justify-center border-b border-border/50 bg-background/30 px-4">
                    <div className="max-w-[260px] text-center">
                      <div className="mx-auto flex size-12 items-center justify-center overflow-hidden rounded-2xl border border-border/60 bg-card/70 text-primary shadow-sm">
                        {data.faviconSrc ? (
                          <img src={data.faviconSrc} alt="" className="size-6 rounded-md object-contain" draggable={false} />
                        ) : (
                          <Globe size={22} />
                        )}
                      </div>
                      <div className="mt-3 text-sm font-medium text-foreground">
                        {!normalizedUrl
                          ? 'Enter a URL'
                          : !webPreviewsEnabled
                          ? 'Previews disabled'
                          : showManualPreviewLoad
                          ? 'Preview paused'
                          : previewLoading
                          ? 'Loading preview…'
                          : previewLoaded && data.hasRichPreview
                          ? 'Preview loaded'
                          : 'Limited preview available'}
                      </div>
                      <div className="mt-1 text-xs leading-relaxed text-muted-foreground">
                        {!normalizedUrl
                          ? 'Paste a website address to load a preview or open it externally.'
                          : !webPreviewsEnabled
                          ? 'Website previews are disabled in settings, so this card will only show the raw link until previews are re-enabled.'
                          : showManualPreviewLoad
                          ? 'Auto-loading is disabled. Load the preview when you want to fetch site metadata.'
                          : previewLoading
                          ? 'Fetching preview details for this site.'
                          : previewLoaded && data.hasRichPreview
                          ? 'This site returned text metadata, but no large preview image.'
                          : 'This site does not expose a rich card preview, so we are falling back to the domain and page link.'}
                      </div>
                      {showManualPreviewLoad ? (
                        <Button
                          size="sm"
                          variant="secondary"
                          className="mt-3 h-8 gap-2"
                          onClick={() => data.onRequestWebPreview?.(id)}
                          onPointerDown={(event) => event.stopPropagation()}
                        >
                          Load preview
                        </Button>
                      ) : null}
                    </div>
                  </div>
                )}
                <div className="min-h-0 flex-1 px-3 py-3">
                  <div className="line-clamp-2 text-sm font-medium text-foreground">
                    {data.title || 'Web preview'}
                  </div>
                  <div className="mt-1 truncate text-[11px] text-muted-foreground">
                    {normalizedUrl || 'No link yet'}
                  </div>
                  {!data.hasRichPreview && normalizedUrl ? (
                    <div className="mt-3 inline-flex max-w-full items-center gap-2 rounded-full border border-border/60 bg-background/45 px-2.5 py-1 text-[11px] text-muted-foreground">
                      {data.faviconSrc ? (
                        <img src={data.faviconSrc} alt="" className="size-3.5 rounded-[4px] object-contain" draggable={false} />
                      ) : (
                        <Globe size={12} />
                      )}
                      <span className="truncate">No preview metadata available</span>
                    </div>
                  ) : null}
                  <div className="mt-3 line-clamp-4 whitespace-pre-wrap text-sm leading-relaxed text-muted-foreground">
                    {showingEmbedFallback
                      ? (data.excerpt || 'This site blocks or restricts embedding in external apps.')
                      : (data.excerpt || (effectiveMode === 'embed' ? 'Embedding unavailable. Falling back to preview.' : 'Preview details will appear here when available.'))}
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
      </CanvasCardFrame>
      <CardHandles />
    </div>
  );
}

export const nodeTypes = {
  noteCard: NoteCardNode,
  fileCard: FileCardNode,
  textCard: TextCardNode,
  webCard: WebCardNode,
};
