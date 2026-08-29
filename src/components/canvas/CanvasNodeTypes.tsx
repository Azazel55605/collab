import { memo, type ReactNode, useEffect, useRef, useState } from 'react';

import { Handle, NodeResizer, Position, useStore } from '@xyflow/react';
import {
  Calendar,
  CheckCircle2,
  CircleDot,
  Diamond,
  FileImage,
  FileText,
  Globe,
  Layout,
  LayoutDashboard,
  Milestone,
  PencilLine,
  Route,
  SquareDashedKanban,
  Users,
} from 'lucide-react';

import { cn } from '../../lib/utils';
import { normalizeWebPreviewUrl } from '../../lib/webPreviewCache';
import type {
  CanvasPlanningMetadata,
  CanvasSwimlaneOrientation,
  CanvasWebDisplayMode,
  PlanningCanvasNode,
} from '../../types/canvas';
import { MarkdownPreview } from '../editor/MarkdownPreview';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select';

import { supportsLinkedPath, supportsPlanningMetadata } from './canvasDiagramUtils';
import { getPlanningNodeLabel } from './canvasPlanning';

const IMAGE_EXTENSIONS = new Set([
  'png',
  'jpg',
  'jpeg',
  'gif',
  'webp',
  'svg',
  'bmp',
  'ico',
  'avif',
]);

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
  symbolGlyph?: string;
  symbolId?: string;
  symbolLabel?: string;
  nodeKind?: PlanningCanvasNode['type'];
  linkedRelativePath?: string;
  planning?: CanvasPlanningMetadata;
  orientation?: CanvasSwimlaneOrientation;
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
  if (IMAGE_EXTENSIONS.has(normalizedExtension))
    return <FileImage size={14} className="shrink-0 text-sky-400/80" />;
  if (normalizedExtension === 'canvas')
    return <Layout size={14} className="shrink-0 text-blue-400/70" />;
  if (normalizedExtension === 'kanban')
    return <LayoutDashboard size={14} className="shrink-0 text-emerald-400/70" />;
  return <FileText size={14} className="shrink-0 text-muted-foreground/70" />;
}

function normalizeWebUrl(value: string) {
  return normalizeWebPreviewUrl(value);
}

function CanvasCardFrame({
  selected,
  children,
  className,
  style,
}: {
  selected?: boolean;
  children: ReactNode;
  className?: string;
  style?: React.CSSProperties;
}) {
  return (
    <div
      style={style}
      className={cn(
        'flex h-full w-full flex-col overflow-hidden rounded-2xl border bg-card/96 text-card-foreground shadow-lg backdrop-blur-xs-webkit transition-[transform,width,height,box-shadow,border-color] app-motion-fast app-node-enter',
        selected
          ? 'border-primary/60 shadow-primary/15'
          : 'border-border/70 shadow-black/12 hover:shadow-black/18',
        className,
      )}
    >
      {children}
    </div>
  );
}

function PlanningStatusBadges({
  planning,
  kind,
}: {
  planning?: CanvasPlanningMetadata;
  kind: PlanningCanvasNode['type'];
}) {
  if (!supportsPlanningMetadata(kind)) return null;
  const tags = planning?.tags?.filter(Boolean) ?? [];
  if (!planning && tags.length === 0) return null;

  return (
    <div className="mt-2 flex flex-wrap gap-1.5">
      {planning?.status ? (
        <Badge
          variant="secondary"
          className="rounded-full bg-primary/10 text-[10px] uppercase tracking-wide text-primary"
        >
          {planning.status.replace(/_/g, ' ')}
        </Badge>
      ) : null}
      {planning?.priority ? (
        <Badge
          variant="outline"
          className={cn(
            'rounded-full text-[10px] uppercase tracking-wide',
            planning.priority === 'critical' && 'border-red-500/30 bg-red-500/15 text-red-400',
            planning.priority === 'high' && 'border-red-500/30 bg-red-500/15 text-red-400',
            planning.priority === 'medium' &&
              'border-yellow-500/30 bg-yellow-500/15 text-yellow-400',
            planning.priority === 'low' && 'border-green-500/30 bg-green-500/15 text-green-400',
          )}
        >
          {planning.priority}
        </Badge>
      ) : null}
      {planning?.ownerLabel ? (
        <Badge variant="outline" className="rounded-full text-[10px]">
          {planning.ownerLabel}
        </Badge>
      ) : null}
      {planning?.dueDate ? (
        <Badge variant="outline" className="rounded-full text-[10px]">
          <Calendar size={10} className="mr-1" />
          {planning.dueDate}
        </Badge>
      ) : null}
      {tags.slice(0, 3).map((tag) => (
        <Badge key={tag} variant="outline" className="rounded-full text-[10px]">
          #{tag}
        </Badge>
      ))}
    </div>
  );
}

function getPlanningNodeIcon(kind: PlanningCanvasNode['type']) {
  switch (kind) {
    case 'process':
      return <Route size={14} />;
    case 'decision':
      return <Diamond size={14} />;
    case 'terminator':
      return <CheckCircle2 size={14} />;
    case 'document':
      return <FileText size={14} />;
    case 'milestone':
      return <Milestone size={14} />;
    case 'actor':
      return <Users size={14} />;
    case 'group':
      return <SquareDashedKanban size={14} />;
    case 'swimlane':
      return <Layout size={14} />;
    case 'junction':
      return <CircleDot size={14} />;
    case 'crossing':
      return <Route size={14} />;
  }
}

function CardHandles() {
  const connectionInProgress = useStore((state) => state.connection.inProgress);
  const handleClassName = cn(
    '!h-6 !w-6 !border-0 !bg-transparent shadow-none transition-[transform,box-shadow,opacity] duration-150',
    "before:absolute before:left-1/2 before:top-1/2 before:h-3.5 before:w-3.5 before:-translate-x-1/2 before:-translate-y-1/2 before:rounded-full before:border-2 before:border-background before:bg-primary/90 before:shadow-[0_0_0_6px_color-mix(in_oklch,var(--primary)_16%,transparent)] before:content-['']",
    connectionInProgress
      ? '!opacity-100 scale-110 before:shadow-[0_0_0_8px_color-mix(in_oklch,var(--primary)_20%,transparent)]'
      : '!opacity-0 group-hover:!opacity-100 group-hover:scale-110 group-hover:before:shadow-[0_0_0_8px_color-mix(in_oklch,var(--primary)_20%,transparent)]',
  );
  const passiveHandleClassName = `${handleClassName} !pointer-events-none !opacity-0`;

  return (
    <>
      <Handle
        id="left-in"
        type="target"
        position={Position.Left}
        className={handleClassName}
        isConnectableStart
        isConnectableEnd
      />
      <Handle
        id="left-out"
        type="source"
        position={Position.Left}
        className={passiveHandleClassName}
        isConnectable={false}
        isConnectableStart={false}
        isConnectableEnd={false}
      />
      <Handle
        id="right-in"
        type="target"
        position={Position.Right}
        className={passiveHandleClassName}
        isConnectable={false}
        isConnectableStart={false}
        isConnectableEnd={false}
      />
      <Handle
        id="right-out"
        type="source"
        position={Position.Right}
        className={handleClassName}
        isConnectableStart
        isConnectableEnd
      />
      <Handle
        id="top-in"
        type="target"
        position={Position.Top}
        className={handleClassName}
        isConnectableStart
        isConnectableEnd
      />
      <Handle
        id="top-out"
        type="source"
        position={Position.Top}
        className={passiveHandleClassName}
        isConnectable={false}
        isConnectableStart={false}
        isConnectableEnd={false}
      />
      <Handle
        id="bottom-in"
        type="target"
        position={Position.Bottom}
        className={passiveHandleClassName}
        isConnectable={false}
        isConnectableStart={false}
        isConnectableEnd={false}
      />
      <Handle
        id="bottom-out"
        type="source"
        position={Position.Bottom}
        className={handleClassName}
        isConnectableStart
        isConnectableEnd
      />
    </>
  );
}

function PlanningNodeShell({
  id,
  data,
  selected,
  minWidth = 220,
  minHeight = 130,
  shapeClassName,
  bodyClassName,
  compact = false,
}: {
  id: string;
  data: CanvasNodeData;
  selected?: boolean;
  minWidth?: number;
  minHeight?: number;
  shapeClassName?: string;
  bodyClassName?: string;
  compact?: boolean;
}) {
  const kind = data.nodeKind ?? 'process';
  const icon = getPlanningNodeIcon(kind);
  const isContainer = kind === 'group' || kind === 'swimlane';
  const isCrossing = kind === 'crossing';
  const isJunction = kind === 'junction';
  const shapeStyle =
    kind === 'decision'
      ? { clipPath: 'polygon(50% 0%, 100% 50%, 50% 100%, 0% 50%)' }
      : kind === 'milestone'
        ? { clipPath: 'polygon(12% 0%, 88% 0%, 100% 50%, 88% 100%, 12% 100%, 0% 50%)' }
        : undefined;

  return (
    <div className="group relative h-full w-full">
      {selected ? (
        <NodeResizer
          isVisible
          minWidth={minWidth}
          minHeight={minHeight}
          lineClassName="!border-primary/30"
          handleClassName="!border-primary/50 !bg-background !w-3 !h-3"
          onResizeEnd={() => data.onSnapToGrid?.(id)}
        />
      ) : null}
      <CanvasCardFrame
        selected={selected}
        className={cn(
          isContainer ? 'bg-card/55 shadow-none' : '',
          kind === 'group' ? 'border-dashed' : '',
          kind === 'swimlane' ? 'border-primary/20 bg-primary/5' : '',
          kind === 'terminator' ? 'rounded-[999px]' : '',
          kind === 'document'
            ? 'after:pointer-events-none after:absolute after:top-0 after:right-0 after:h-10 after:w-10 after:border-l after:border-b after:border-border/50 after:bg-background/35'
            : '',
          kind === 'milestone'
            ? 'bg-gradient-to-br from-primary/10 via-card to-card px-2 py-2'
            : '',
          kind === 'actor' ? 'bg-gradient-to-br from-primary/8 via-card to-card' : '',
          isCrossing || isJunction ? 'items-center justify-center rounded-[999px]' : '',
          shapeClassName,
        )}
        style={shapeStyle}
      >
        {isJunction ? (
          <div className="flex h-full w-full items-center justify-center">
            <div className="flex size-7 items-center justify-center rounded-full border border-primary/35 bg-primary/14 text-primary shadow-[0_0_0_6px_color-mix(in_oklch,var(--primary)_10%,transparent)]">
              <CircleDot size={12} />
            </div>
          </div>
        ) : isCrossing ? (
          <div className="relative flex h-full w-full items-center justify-center overflow-hidden">
            <div className="absolute left-5 right-5 h-[2px] bg-primary/65" />
            <div className="absolute top-5 bottom-5 w-[2px] bg-primary/40" />
            <div className="relative rounded-full border border-primary/35 bg-background/95 px-3 py-1 text-[11px] font-medium text-primary">
              Crossing
            </div>
          </div>
        ) : (
          <>
            <div
              className={cn(
                'flex items-center gap-2 border-b border-border/60 px-3 py-2',
                kind === 'decision' ? 'px-8 pt-4' : '',
                kind === 'milestone' ? 'border-transparent px-6 pt-4' : '',
                kind === 'actor' ? 'bg-primary/6' : '',
              )}
            >
              <div className="flex size-7 items-center justify-center rounded-xl bg-primary/12 text-primary">
                {icon}
              </div>
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-semibold text-foreground">{data.title}</div>
                <div className="truncate text-[11px] text-muted-foreground">
                  {getPlanningNodeLabel(kind)}
                  {supportsLinkedPath(kind) && data.linkedRelativePath
                    ? ` · ${data.linkedRelativePath}`
                    : ''}
                </div>
              </div>
              {kind === 'milestone' && data.planning?.milestoneLabel ? (
                <Badge variant="outline" className="rounded-full text-[10px]">
                  {data.planning.milestoneLabel}
                </Badge>
              ) : null}
            </div>
            <div
              className={cn(
                'min-h-0 flex-1 overflow-hidden px-3 py-3',
                kind === 'decision' ? 'px-8 pb-5 pt-3 text-center' : '',
                kind === 'milestone' ? 'px-6 pb-5 pt-1' : '',
                bodyClassName,
              )}
            >
              {data.content ? (
                <div
                  className={cn(
                    compact ? 'line-clamp-3 text-xs' : 'line-clamp-6 text-sm',
                    'whitespace-pre-wrap leading-relaxed text-muted-foreground',
                  )}
                >
                  {data.content}
                </div>
              ) : (
                <div className="text-sm leading-relaxed text-muted-foreground">
                  {isContainer
                    ? 'Use this as a structural layer for related nodes.'
                    : 'Add context from the node inspector.'}
                </div>
              )}
              <PlanningStatusBadges planning={data.planning} kind={kind} />
            </div>
          </>
        )}
      </CanvasCardFrame>
      <CardHandles />
    </div>
  );
}

function NoteCardNode({
  id,
  data,
  selected,
}: {
  id: string;
  data: CanvasNodeData;
  selected?: boolean;
}) {
  return (
    <div className="group relative h-full w-full">
      {selected ? (
        <NodeResizer
          isVisible
          minWidth={220}
          minHeight={140}
          lineClassName="!border-primary/30"
          handleClassName="!border-primary/50 !bg-background !w-3 !h-3"
          onResizeEnd={() => data.onSnapToGrid?.(id)}
        />
      ) : null}
      <CanvasCardFrame selected={selected}>
        <button
          onDoubleClick={() => data.relativePath && data.onOpen?.(data.relativePath)}
          className="flex h-full min-h-0 w-full flex-1 flex-col text-left text-foreground"
          type="button"
        >
          <div className="flex items-center gap-2 border-b border-border/60 px-3 py-2">
            <div className="flex size-7 items-center justify-center rounded-xl bg-primary/12 text-primary">
              <FileText size={14} />
            </div>
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-semibold text-foreground">{data.title}</div>
              <div className="truncate text-[11px] text-muted-foreground">{data.subtitle}</div>
            </div>
          </div>
          <div className="min-h-0 flex-1 overflow-hidden px-3 py-3 text-sm text-muted-foreground">
            {data.content ? (
              <div className="mb-3 line-clamp-3 whitespace-pre-wrap rounded-xl border border-border/50 bg-background/55 px-2.5 py-2 text-[12px] leading-relaxed text-foreground/85">
                {data.content}
              </div>
            ) : null}
            {data.markdownContent ? (
              <MarkdownPreview
                content={data.markdownContent}
                className="h-full overflow-hidden text-[13px] leading-relaxed [&_.contains-task-list]:pl-4 [&_blockquote]:border-l-2 [&_blockquote]:border-primary/30 [&_blockquote]:pl-3 [&_h1]:mb-2 [&_h1]:text-xl [&_h2]:mb-2 [&_h2]:text-lg [&_h3]:mb-1 [&_img]:hidden [&_ol]:pl-5 [&_p]:mb-2 [&_pre]:hidden [&_table]:hidden [&_ul]:pl-5"
                onWikilinkClick={data.onWikilinkClick}
                currentDocumentRelativePath={data.relativePath}
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

function FileCardNode({
  id,
  data,
  selected,
}: {
  id: string;
  data: CanvasNodeData;
  selected?: boolean;
}) {
  const isImage = !!data.imageSrc;

  return (
    <div className="group relative h-full w-full">
      {selected ? (
        <NodeResizer
          isVisible
          minWidth={220}
          minHeight={140}
          lineClassName="!border-primary/30"
          handleClassName="!border-primary/50 !bg-background !w-3 !h-3"
          onResizeEnd={() => data.onSnapToGrid?.(id)}
        />
      ) : null}
      <CanvasCardFrame selected={selected}>
        <button
          onDoubleClick={() => data.relativePath && data.onOpen?.(data.relativePath)}
          className="flex h-full min-h-0 w-full flex-1 flex-col text-left text-foreground"
          type="button"
        >
          <div className="flex items-center gap-2 border-b border-border/60 px-3 py-2">
            <div className="flex size-7 items-center justify-center rounded-xl bg-primary/12 text-primary">
              {data.extension ? getFileIcon(data.extension) : <FileText size={14} />}
            </div>
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-semibold text-foreground">{data.title}</div>
              <div className="truncate text-[11px] text-muted-foreground">{data.subtitle}</div>
            </div>
          </div>

          {isImage ? (
            <div className="flex min-h-0 flex-1 items-center justify-center bg-background/50 p-3">
              <img
                src={data.imageSrc ?? ''}
                alt={data.title}
                className="max-h-full max-w-full rounded-xl object-contain"
                draggable={false}
              />
            </div>
          ) : (
            <div className="flex min-h-0 flex-1 flex-col justify-between px-3 py-3">
              <div className="line-clamp-6 whitespace-pre-wrap text-sm leading-relaxed text-muted-foreground">
                {data.content || data.excerpt || 'Double-click to open this file.'}
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

function TextCardNode({
  id,
  data,
  selected,
}: {
  id: string;
  data: CanvasNodeData;
  selected?: boolean;
}) {
  return (
    <div className="group relative h-full w-full">
      {selected ? (
        <NodeResizer
          isVisible
          minWidth={200}
          minHeight={120}
          lineClassName="!border-primary/30"
          handleClassName="!border-primary/50 !bg-background !w-3 !h-3"
          onResizeEnd={() => data.onSnapToGrid?.(id)}
        />
      ) : null}
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

function WebCardNode({
  id,
  data,
  selected,
}: {
  id: string;
  data: CanvasNodeData;
  selected?: boolean;
}) {
  const currentUrl = data.url ?? '';
  const effectiveMode = data.displayMode ?? 'preview';
  const normalizedUrl = normalizeWebUrl(currentUrl);
  const canEmbed = normalizedUrl.startsWith('http://') || normalizedUrl.startsWith('https://');
  const canActuallyEmbed = canEmbed && data.embedAvailable !== false;
  const showingEmbedFallback = effectiveMode === 'embed' && !canActuallyEmbed && !!normalizedUrl;
  const previewLoading = data.previewLoading ?? false;
  const previewLoaded = data.previewLoaded ?? false;
  const previewAutoLoadEnabled = data.previewAutoLoadEnabled ?? true;
  const webPreviewsEnabled = data.webPreviewsEnabled ?? true;
  const showManualPreviewLoad =
    webPreviewsEnabled &&
    !previewAutoLoadEnabled &&
    !!normalizedUrl &&
    !previewLoading &&
    !previewLoaded;
  const [embedActivated, setEmbedActivated] = useState(false);
  const [iframeState, setIframeState] = useState<'idle' | 'loading' | 'loaded' | 'timed_out'>(
    'idle',
  );
  const [urlDraft, setUrlDraft] = useState(currentUrl);
  const urlCommitTimeoutRef = useRef<number | null>(null);
  const previousModeRef = useRef<CanvasWebDisplayMode>(effectiveMode);
  const onWebUrlChange = data.onWebUrlChange;

  useEffect(() => {
    setUrlDraft(currentUrl);
  }, [currentUrl, id]);

  useEffect(
    () => () => {
      if (urlCommitTimeoutRef.current !== null) {
        window.clearTimeout(urlCommitTimeoutRef.current);
      }
    },
    [],
  );

  const commitUrlDraft = (nextUrl: string) => {
    if (urlCommitTimeoutRef.current !== null) {
      window.clearTimeout(urlCommitTimeoutRef.current);
      urlCommitTimeoutRef.current = null;
    }
    if (nextUrl === currentUrl) return;
    onWebUrlChange?.(id, nextUrl);
  };

  useEffect(() => {
    if (urlDraft === currentUrl) return;
    urlCommitTimeoutRef.current = window.setTimeout(() => {
      onWebUrlChange?.(id, urlDraft);
      urlCommitTimeoutRef.current = null;
    }, 220);

    return () => {
      if (urlCommitTimeoutRef.current !== null) {
        window.clearTimeout(urlCommitTimeoutRef.current);
        urlCommitTimeoutRef.current = null;
      }
    };
  }, [currentUrl, id, onWebUrlChange, urlDraft]);

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
        ? {
            label: 'Embedded',
            className: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-200',
          }
        : effectiveMode === 'embed'
          ? { label: 'Loading', className: 'border-primary/30 bg-primary/10 text-primary' }
          : {
              label: 'Preview',
              className: 'border-border/60 bg-background/60 text-muted-foreground',
            };

  return (
    <div className="group relative h-full w-full">
      {selected ? (
        <NodeResizer
          isVisible
          minWidth={260}
          minHeight={180}
          lineClassName="!border-primary/30"
          handleClassName="!border-primary/50 !bg-background !w-3 !h-3"
          onResizeEnd={() => data.onSnapToGrid?.(id)}
        />
      ) : null}
      <CanvasCardFrame selected={selected}>
        <div className="flex h-full flex-col">
          <div className="flex items-center gap-2 border-b border-border/60 px-3 py-2">
            <div className="flex size-7 items-center justify-center overflow-hidden rounded-xl bg-primary/12 text-primary">
              {data.faviconSrc ? (
                <img
                  src={data.faviconSrc}
                  alt=""
                  className="size-4 rounded-sm object-contain"
                  draggable={false}
                />
              ) : (
                <Globe size={14} />
              )}
            </div>
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-semibold">{data.title || 'Web card'}</div>
              <div className="truncate text-[11px] text-muted-foreground">
                {data.subtitle || 'Website'}
              </div>
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
              value={urlDraft}
              placeholder="example.com or https://example.com"
              onChange={(event) => setUrlDraft(event.target.value)}
              onBlur={() => commitUrlDraft(urlDraft)}
              onKeyDown={(event) => {
                if (event.key !== 'Enter') return;
                event.preventDefault();
                commitUrlDraft(urlDraft);
              }}
              onPointerDown={(event) => event.stopPropagation()}
              className="h-8 text-xs"
            />
            <div
              className={cn(
                'shrink-0 rounded-md border px-2 py-1 text-[11px] font-medium',
                statusChip.className,
              )}
            >
              {statusChip.label}
            </div>
            <Select
              value={data.displayModeOverride ?? 'default'}
              onValueChange={(value) =>
                data.onWebDisplayModeOverrideChange?.(
                  id,
                  value === 'default' ? null : (value as CanvasWebDisplayMode),
                )
              }
            >
              <SelectTrigger
                size="sm"
                className="h-8 min-w-[118px] bg-background/70 text-xs"
                onPointerDown={(event) => event.stopPropagation()}
              >
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
                        {iframeState === 'timed_out'
                          ? 'Embedding may be blocked'
                          : 'Loading website…'}
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
                    We keep embedded pages from auto-loading on app open so the canvas stays
                    responsive.
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
                    <img
                      src={data.imageSrc}
                      alt={data.title || 'Website preview'}
                      className="h-full w-full object-cover"
                      draggable={false}
                    />
                  </div>
                ) : (
                  <div className="flex min-h-[120px] flex-[1.1] items-center justify-center border-b border-border/50 bg-background/30 px-4">
                    <div className="max-w-[260px] text-center">
                      <div className="mx-auto flex size-12 items-center justify-center overflow-hidden rounded-2xl border border-border/60 bg-card/70 text-primary shadow-sm">
                        {data.faviconSrc ? (
                          <img
                            src={data.faviconSrc}
                            alt=""
                            className="size-6 rounded-md object-contain"
                            draggable={false}
                          />
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
                        <img
                          src={data.faviconSrc}
                          alt=""
                          className="size-3.5 rounded-[4px] object-contain"
                          draggable={false}
                        />
                      ) : (
                        <Globe size={12} />
                      )}
                      <span className="truncate">No preview metadata available</span>
                    </div>
                  ) : null}
                  <div className="mt-3 line-clamp-4 whitespace-pre-wrap text-sm leading-relaxed text-muted-foreground">
                    {showingEmbedFallback
                      ? data.excerpt || 'This site blocks or restricts embedding in external apps.'
                      : data.excerpt ||
                        (effectiveMode === 'embed'
                          ? 'Embedding unavailable. Falling back to preview.'
                          : 'Preview details will appear here when available.')}
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

function SymbolCardNode({
  id,
  data,
  selected,
}: {
  id: string;
  data: CanvasNodeData;
  selected?: boolean;
}) {
  return (
    <div className="group relative h-full w-full">
      {selected ? (
        <NodeResizer
          isVisible
          minWidth={140}
          minHeight={140}
          lineClassName="!border-primary/30"
          handleClassName="!border-primary/50 !bg-background !w-3 !h-3"
          onResizeEnd={() => data.onSnapToGrid?.(id)}
        />
      ) : null}
      <CanvasCardFrame
        selected={selected}
        className="items-center justify-center bg-gradient-to-br from-primary/10 via-card/98 to-card/94 px-4 py-4 text-center"
      >
        <div className="flex h-full w-full flex-col items-center justify-center gap-3">
          <div
            className="flex min-h-0 max-w-full items-center justify-center text-[4.25rem] leading-none text-primary"
            style={{ fontFamily: "'Pure Nerd Font', PureNerdFont, monospace" }}
            aria-label={data.symbolLabel ?? 'Canvas symbol'}
          >
            {data.symbolGlyph || '?'}
          </div>
          <div className="max-w-full">
            <div className="truncate text-sm font-semibold text-foreground">
              {data.title || data.symbolLabel || 'Symbol'}
            </div>
            <div className="truncate text-[11px] text-muted-foreground">
              {data.symbolId || 'Nerd Font icon'}
            </div>
          </div>
        </div>
      </CanvasCardFrame>
      <CardHandles />
    </div>
  );
}

function ProcessCardNode(props: { id: string; data: CanvasNodeData; selected?: boolean }) {
  return <PlanningNodeShell {...props} minWidth={220} minHeight={130} />;
}

function DecisionCardNode({
  id,
  data,
  selected,
}: {
  id: string;
  data: CanvasNodeData;
  selected?: boolean;
}) {
  return (
    <div className="group relative h-full w-full">
      {selected ? (
        <NodeResizer
          isVisible
          minWidth={240}
          minHeight={150}
          lineClassName="!border-primary/30"
          handleClassName="!border-primary/50 !bg-background !w-3 !h-3"
          onResizeEnd={() => data.onSnapToGrid?.(id)}
        />
      ) : null}
      <div className="relative h-full w-full">
        <svg
          viewBox="0 0 100 100"
          preserveAspectRatio="none"
          className="absolute inset-0 h-full w-full overflow-visible"
        >
          <polygon
            points="50,2 98,50 50,98 2,50"
            fill="color-mix(in oklch, var(--card) 96%, var(--primary) 4%)"
            stroke={
              selected
                ? 'color-mix(in oklch, var(--primary) 60%, white 10%)'
                : 'color-mix(in oklch, var(--border) 88%, transparent)'
            }
            strokeWidth="2.2"
          />
        </svg>
        <div className="absolute inset-[18%_18%] flex flex-col items-center justify-center text-center">
          <div className="mb-2 flex size-8 items-center justify-center rounded-full bg-primary/12 text-primary">
            <Diamond size={16} />
          </div>
          <div className="line-clamp-2 text-sm font-semibold text-foreground">{data.title}</div>
          <div className="mt-2 line-clamp-4 whitespace-pre-wrap text-xs leading-relaxed text-muted-foreground">
            {data.content || 'Branch condition'}
          </div>
        </div>
      </div>
      <CardHandles />
    </div>
  );
}

function TerminatorCardNode({
  id,
  data,
  selected,
}: {
  id: string;
  data: CanvasNodeData;
  selected?: boolean;
}) {
  return (
    <div className="group relative h-full w-full">
      {selected ? (
        <NodeResizer
          isVisible
          minWidth={210}
          minHeight={110}
          lineClassName="!border-primary/30"
          handleClassName="!border-primary/50 !bg-background !w-3 !h-3"
          onResizeEnd={() => data.onSnapToGrid?.(id)}
        />
      ) : null}
      <div className="relative h-full w-full">
        <svg
          viewBox="0 0 100 44"
          preserveAspectRatio="none"
          className="absolute inset-0 h-full w-full overflow-visible"
        >
          <rect
            x="1.5"
            y="1.5"
            width="97"
            height="41"
            rx="21"
            fill="color-mix(in oklch, var(--card) 96%, var(--primary) 4%)"
            stroke={
              selected
                ? 'color-mix(in oklch, var(--primary) 60%, white 10%)'
                : 'color-mix(in oklch, var(--border) 88%, transparent)'
            }
            strokeWidth="1.8"
          />
        </svg>
        <div className="absolute inset-[18%_10%] flex flex-col items-center justify-center text-center">
          <div className="mb-1 flex size-7 items-center justify-center rounded-full bg-primary/12 text-primary">
            <CheckCircle2 size={15} />
          </div>
          <div className="line-clamp-2 text-sm font-semibold text-foreground">{data.title}</div>
          {data.content ? (
            <div className="mt-1 line-clamp-2 text-xs leading-relaxed text-muted-foreground">
              {data.content}
            </div>
          ) : null}
        </div>
      </div>
      <CardHandles />
    </div>
  );
}

function DocumentPlanningCardNode(props: { id: string; data: CanvasNodeData; selected?: boolean }) {
  return <PlanningNodeShell {...props} minWidth={220} minHeight={140} />;
}

function MilestoneCardNode(props: { id: string; data: CanvasNodeData; selected?: boolean }) {
  return <PlanningNodeShell {...props} minWidth={220} minHeight={130} />;
}

function ActorCardNode(props: { id: string; data: CanvasNodeData; selected?: boolean }) {
  return <PlanningNodeShell {...props} minWidth={220} minHeight={130} compact />;
}

function GroupCardNode(props: { id: string; data: CanvasNodeData; selected?: boolean }) {
  return (
    <PlanningNodeShell
      {...props}
      minWidth={320}
      minHeight={220}
      bodyClassName="bg-transparent/20"
    />
  );
}

function SwimlaneCardNode({
  id,
  data,
  selected,
}: {
  id: string;
  data: CanvasNodeData;
  selected?: boolean;
}) {
  const orientation = data.orientation ?? 'horizontal';
  return (
    <PlanningNodeShell
      id={id}
      data={{
        ...data,
        content: `${orientation === 'horizontal' ? 'Horizontal' : 'Vertical'} lane for phases, teams, or ownership.`,
      }}
      selected={selected}
      minWidth={420}
      minHeight={180}
      bodyClassName={cn(
        'relative',
        orientation === 'horizontal'
          ? 'before:absolute before:top-16 before:left-0 before:right-0 before:border-t before:border-dashed before:border-primary/25'
          : 'before:absolute before:top-0 before:bottom-0 before:left-28 before:border-l before:border-dashed before:border-primary/25',
      )}
    />
  );
}

function JunctionCardNode(props: { id: string; data: CanvasNodeData; selected?: boolean }) {
  return <PlanningNodeShell {...props} minWidth={56} minHeight={56} compact />;
}

function CrossingCardNode(props: { id: string; data: CanvasNodeData; selected?: boolean }) {
  return <PlanningNodeShell {...props} minWidth={96} minHeight={64} compact />;
}

const MemoNoteCardNode = memo(NoteCardNode);
const MemoFileCardNode = memo(FileCardNode);
const MemoTextCardNode = memo(TextCardNode);
const MemoWebCardNode = memo(WebCardNode);
const MemoSymbolCardNode = memo(SymbolCardNode);
const MemoProcessCardNode = memo(ProcessCardNode);
const MemoDecisionCardNode = memo(DecisionCardNode);
const MemoTerminatorCardNode = memo(TerminatorCardNode);
const MemoDocumentPlanningCardNode = memo(DocumentPlanningCardNode);
const MemoMilestoneCardNode = memo(MilestoneCardNode);
const MemoActorCardNode = memo(ActorCardNode);
const MemoGroupCardNode = memo(GroupCardNode);
const MemoSwimlaneCardNode = memo(SwimlaneCardNode);
const MemoJunctionCardNode = memo(JunctionCardNode);
const MemoCrossingCardNode = memo(CrossingCardNode);

export const nodeTypes = {
  noteCard: MemoNoteCardNode,
  fileCard: MemoFileCardNode,
  textCard: MemoTextCardNode,
  webCard: MemoWebCardNode,
  symbolCard: MemoSymbolCardNode,
  processCard: MemoProcessCardNode,
  decisionCard: MemoDecisionCardNode,
  terminatorCard: MemoTerminatorCardNode,
  documentCard: MemoDocumentPlanningCardNode,
  milestoneCard: MemoMilestoneCardNode,
  actorCard: MemoActorCardNode,
  groupCard: MemoGroupCardNode,
  swimlaneCard: MemoSwimlaneCardNode,
  junctionCard: MemoJunctionCardNode,
  crossingCard: MemoCrossingCardNode,
};
