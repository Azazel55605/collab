import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import '@xyflow/react/dist/style.css';
import { getDocument, GlobalWorkerOptions } from 'pdfjs-dist';
import { openUrl } from '@tauri-apps/plugin-opener';
import {
  ReactFlow,
  addEdge,
  applyNodeChanges,
  BaseEdge,
  Background,
  BackgroundVariant,
  Handle,
  NodeResizer,
  Panel,
  Position,
  ReactFlowProvider,
  reconnectEdge,
  useEdges,
  useStore,
  useEdgesState,
  useNodes,
  useNodesState,
  useReactFlow,
  type Connection,
  type ConnectionLineComponentProps,
  type Edge as FlowEdge,
  type EdgeChange,
  type EdgeProps,
  type Node as FlowNode,
  type NodeChange,
  type OnReconnect,
  type Viewport,
} from '@xyflow/react';
import {
  FileImage,
  FileText,
  Globe,
  Layout,
  LayoutDashboard,
  Link2,
  Maximize2,
  Minus,
  MousePointer2,
  PencilLine,
  Plus as PlusIcon,
  Plus,
  RotateCcw,
  Trash2,
} from 'lucide-react';
import { Button } from '../components/ui/button';
import { Checkbox } from '../components/ui/checkbox';
import { MarkdownPreview } from '../components/editor/MarkdownPreview';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '../components/ui/dialog';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '../components/ui/command';
import { Input } from '../components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../components/ui/select';
import {
  DocumentTopBar,
  documentTopBarGroupClass,
  getDocumentBaseName,
  getDocumentFolderPath,
} from '../components/layout/DocumentTopBar';
import { cn } from '../lib/utils';
import { tauriCommands } from '../lib/tauri';
import type { LinkPreviewData } from '../lib/tauri';
import { normalizeWebPreviewUrl, prefetchWebPreviews, requestWebPreview as requestCachedWebPreview } from '../lib/webPreviewCache';
import { useEditorStore } from '../store/editorStore';
import { useUiStore, type CanvasWebCardDefaultMode } from '../store/uiStore';
import { useVaultStore } from '../store/vaultStore';
import type {
  CanvasData,
  CanvasEdge,
  CanvasEdgeLineStyle,
  CanvasNode,
  CanvasWebDisplayMode,
  FileCanvasNode,
  NoteCanvasNode,
  TextCanvasNode,
  WebCanvasNode,
} from '../types/canvas';
import type { NoteFile } from '../types/vault';

const pdfWorkerUrl = new URL('pdfjs-dist/build/pdf.worker.mjs', import.meta.url).toString();
GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

const SAVE_DEBOUNCE_MS = 600;
const CANVAS_GRID = 24;
const CANVAS_EDGE_LANE = 30;
const CANVAS_EDGE_SLOT_SPACING = 18;
const CANVAS_EDGE_SLOT_PADDING = 26;
const CANVAS_EDGE_REROUTE_MS = 220;
const DEFAULT_NODE_SIZE = { width: 300, height: 180 };
const DEFAULT_TEXT_NODE_SIZE = { width: 280, height: 160 };
const DEFAULT_EDGE_STROKE = 'color-mix(in oklch, var(--primary) 78%, white 22%)';
const EDGE_ANIMATION_STROKE = 'color-mix(in oklch, var(--primary) 90%, white 10%)';
const DEFAULT_EDGE_STYLE = {
  strokeWidth: 2,
  stroke: DEFAULT_EDGE_STROKE,
  transition: 'stroke 180ms ease, filter 180ms ease, opacity 180ms ease',
} satisfies React.CSSProperties;
const EMPTY_CANVAS: CanvasData = {
  nodes: [],
  edges: [],
  viewport: { x: 0, y: 0, zoom: 1 },
};
const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico', 'avif']);
const TEXT_PREVIEW_EXTENSIONS = new Set([
  'txt', 'md', 'markdown', 'json', 'yml', 'yaml', 'toml', 'csv', 'ts', 'tsx',
  'js', 'jsx', 'css', 'html', 'rs', 'py', 'sh', 'sql', 'xml',
]);

type PickerMode = 'note' | 'file' | null;

interface PreviewState {
  excerpt?: string;
  imageSrc?: string | null;
  faviconSrc?: string | null;
  markdownContent?: string;
  linkPreview?: LinkPreviewData | null;
  embedAvailable?: boolean;
  embedChecked?: boolean;
  previewError?: string | null;
  loading?: boolean;
  loaded?: boolean;
}

interface CanvasNodeData extends Record<string, unknown> {
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

interface CanvasEdgeData extends Record<string, unknown> {
  label?: string;
  lineStyle: CanvasEdgeLineStyle;
  animated: boolean;
  animationReverse: boolean;
  markerStart: boolean;
  markerEnd: boolean;
}

type CanvasFlowEdge = FlowEdge<CanvasEdgeData>;

interface EdgeGeometry {
  sourceX: number;
  sourceY: number;
  controlSourceX: number;
  controlSourceY: number;
  controlTargetX: number;
  controlTargetY: number;
  targetX: number;
  targetY: number;
  labelX: number;
  labelY: number;
}

function normalizeVector(x: number, y: number) {
  const length = Math.hypot(x, y) || 1;
  return { x: x / length, y: y / length };
}

function flattenFiles(nodes: NoteFile[]): NoteFile[] {
  return nodes.flatMap((node) => [node, ...(node.children ? flattenFiles(node.children) : [])]);
}

function getBaseName(relativePath: string): string {
  return relativePath.split('/').pop() ?? relativePath;
}

function getNameWithoutExtension(name: string): string {
  return name.replace(/\.[^.]+$/, '');
}

function getFileSubtitle(relativePath: string): string | undefined {
  const parts = relativePath.split('/');
  return parts.length > 1 ? parts.slice(0, -1).join('/') : undefined;
}

function getFileIcon(file: Pick<NoteFile, 'extension'>) {
  const extension = file.extension.toLowerCase();
  if (IMAGE_EXTENSIONS.has(extension)) return <FileImage size={14} className="shrink-0 text-sky-400/80" />;
  if (extension === 'canvas') return <Layout size={14} className="shrink-0 text-blue-400/70" />;
  if (extension === 'kanban') return <LayoutDashboard size={14} className="shrink-0 text-emerald-400/70" />;
  return <FileText size={14} className="shrink-0 text-muted-foreground/70" />;
}

function cleanPreviewText(content: string): string {
  const withoutFrontmatter = content.replace(/^---[\s\S]*?---\s*/m, '');
  const plain = withoutFrontmatter
    .replace(/!\[[^\]]*\]\([^)]+\)/g, '')
    .replace(/\[[^\]]+\]\([^)]+\)/g, '$1')
    .replace(/[#>*`~_-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return plain.slice(0, 220);
}

function snapValue(value: number, grid = CANVAS_GRID) {
  return Math.round(value / grid) * grid;
}

function snapSize(value: number, minimum: number, grid = CANVAS_GRID) {
  return Math.max(minimum, snapValue(value, grid));
}

function snapPosition(position: { x: number; y: number }, grid = CANVAS_GRID) {
  return {
    x: snapValue(position.x, grid),
    y: snapValue(position.y, grid),
  };
}

function isImageExtension(extension: string): boolean {
  return IMAGE_EXTENSIONS.has(extension.toLowerCase());
}

function canPreviewText(extension: string): boolean {
  return TEXT_PREVIEW_EXTENSIONS.has(extension.toLowerCase());
}

function normalizeWebUrl(value: string) {
  return normalizeWebPreviewUrl(value);
}

function getPreviewKey(node: CanvasNode) {
  if ('relativePath' in node) return `vault:${node.relativePath}`;
  if (node.type === 'web') return `web:${normalizeWebUrl(node.url)}`;
  return `node:${node.id}`;
}

function resolveWebDisplayMode(
  override: CanvasWebDisplayMode | null | undefined,
  defaultMode: CanvasWebCardDefaultMode,
) {
  return override ?? defaultMode;
}

function makeDefaultCanvas(): CanvasData {
  return {
    nodes: [],
    edges: [],
    viewport: { x: 0, y: 0, zoom: 1 },
  };
}

function buildNodePreviewState(node: Extract<CanvasNode, { relativePath: string }>, preview: PreviewState | undefined) {
  const title = getNameWithoutExtension(getBaseName(node.relativePath));
  const subtitle = getFileSubtitle(node.relativePath) ?? node.relativePath;
  return {
    title,
    subtitle,
    excerpt: preview?.excerpt,
    imageSrc: preview?.imageSrc ?? null,
    markdownContent: preview?.markdownContent,
    relativePath: node.relativePath,
    extension: node.relativePath.split('.').pop()?.toLowerCase(),
  };
}

function buildWebPreviewState(
  node: WebCanvasNode,
  preview: PreviewState | undefined,
  defaultMode: CanvasWebCardDefaultMode,
  autoLoadEnabled: boolean,
  webPreviewsEnabled: boolean,
) {
  const normalizedUrl = normalizeWebUrl(node.url);
  const hostname = (() => {
    try {
      return normalizedUrl ? new URL(normalizedUrl).hostname : 'Add a website';
    } catch {
      return node.url || 'Add a website';
    }
  })();
  const fallbackPath = (() => {
    try {
      if (!normalizedUrl) return '';
      const parsed = new URL(normalizedUrl);
      return `${parsed.pathname}${parsed.search}${parsed.hash}`.trim() || '/';
    } catch {
      return '';
    }
  })();
  const linkPreview = preview?.linkPreview;
  const hasMetadataTitle = Boolean(linkPreview?.title?.trim());
  const hasMetadataDescription = Boolean(linkPreview?.description?.trim());
  const hasMetadataImage = Boolean(linkPreview?.imageUrl);
  const hasMetadataSiteName = Boolean(linkPreview?.siteName?.trim() && linkPreview.siteName?.trim() !== hostname);
  const hasRichPreview = hasMetadataTitle || hasMetadataDescription || hasMetadataImage || hasMetadataSiteName;
  const fallbackExcerpt = preview?.previewError
    ? `Preview unavailable right now. ${preview.previewError}`
    : normalizedUrl
    ? `This site does not expose much preview metadata. We are showing the link details instead${fallbackPath && fallbackPath !== '/' ? ` for ${fallbackPath}` : ''}.`
    : 'Enter a URL to load a website preview.';
  return {
    title: linkPreview?.title || hostname,
    subtitle: linkPreview?.siteName || normalizedUrl || hostname,
    excerpt: linkPreview?.description ?? linkPreview?.embedBlockReason ?? fallbackExcerpt,
    imageSrc: linkPreview?.imageUrl ?? null,
    faviconSrc: linkPreview?.faviconUrl ?? null,
    hasRichPreview,
    previewError: preview?.previewError ?? null,
    previewLoading: preview?.loading ?? false,
    previewLoaded: preview?.loaded ?? false,
    previewAutoLoadEnabled: autoLoadEnabled,
    webPreviewsEnabled,
    embedAvailable: linkPreview?.embeddable ?? preview?.embedAvailable,
    url: node.url,
    displayMode: resolveWebDisplayMode(node.displayModeOverride, defaultMode),
    displayModeOverride: node.displayModeOverride ?? null,
  };
}

function toFlowNode(
  node: CanvasNode,
  preview: PreviewState | undefined,
  callbacks: Pick<CanvasNodeData, 'onOpen' | 'onTextChange' | 'onSnapToGrid' | 'onWebUrlChange' | 'onWebDisplayModeOverrideChange' | 'onRequestWebPreview' | 'onOpenUrl'>,
  defaultWebCardMode: CanvasWebCardDefaultMode,
  autoLoadEnabled: boolean,
  webPreviewsEnabled: boolean,
): FlowNode<CanvasNodeData> {
  if (node.type === 'text') {
    return {
      id: node.id,
      type: 'textCard',
      position: node.position,
      selected: false,
      data: {
        title: 'Text',
        subtitle: 'Canvas note',
        content: node.content,
        onTextChange: callbacks.onTextChange,
        onSnapToGrid: callbacks.onSnapToGrid,
      },
      style: {
        width: node.width,
        height: node.height,
      },
    };
  }

  if (node.type === 'web') {
    return {
      id: node.id,
      type: 'webCard',
      position: node.position,
      selected: false,
      data: {
        ...buildWebPreviewState(node, preview, defaultWebCardMode, autoLoadEnabled, webPreviewsEnabled),
        onWebUrlChange: callbacks.onWebUrlChange,
        onWebDisplayModeOverrideChange: callbacks.onWebDisplayModeOverrideChange,
        onRequestWebPreview: callbacks.onRequestWebPreview,
        onOpenUrl: callbacks.onOpenUrl,
        onSnapToGrid: callbacks.onSnapToGrid,
      },
      style: {
        width: node.width,
        height: node.height,
      },
    };
  }

  const isNote = node.type === 'note';
  const cardPreview = buildNodePreviewState(node, preview);
  return {
    id: node.id,
    type: isNote ? 'noteCard' : 'fileCard',
    position: node.position,
    selected: false,
    data: {
      ...cardPreview,
      onOpen: callbacks.onOpen,
      onWikilinkClick: callbacks.onOpen,
      onSnapToGrid: callbacks.onSnapToGrid,
    },
    style: {
      width: node.width,
      height: node.height,
    },
  };
}

function fromFlowNode(node: FlowNode<CanvasNodeData>): CanvasNode {
  const width = typeof node.width === 'number'
    ? node.width
    : typeof node.measured?.width === 'number'
    ? node.measured.width
    : typeof node.style?.width === 'number'
    ? node.style.width
    : DEFAULT_NODE_SIZE.width;
  const height = typeof node.height === 'number'
    ? node.height
    : typeof node.measured?.height === 'number'
    ? node.measured.height
    : typeof node.style?.height === 'number'
    ? node.style.height
    : DEFAULT_NODE_SIZE.height;

  if (node.type === 'textCard') {
    return {
      id: node.id,
      type: 'text',
      position: node.position,
      width,
      height,
      content: node.data.content ?? '',
    };
  }

  if (node.type === 'webCard') {
    return {
      id: node.id,
      type: 'web',
      position: node.position,
      width,
      height,
      url: node.data.url ?? '',
      displayModeOverride: node.data.displayModeOverride ?? null,
    };
  }

  if (node.type === 'noteCard') {
    return {
      id: node.id,
      type: 'note',
      position: node.position,
      width,
      height,
      relativePath: node.data.relativePath ?? '',
    };
  }

  return {
    id: node.id,
    type: 'file',
    position: node.position,
    width,
    height,
    relativePath: node.data.relativePath ?? '',
  };
}

function getCanvasEdgeData(edge?: {
  label?: string;
  lineStyle?: CanvasEdgeLineStyle;
  animated?: boolean;
  animationReverse?: boolean;
  markerStart?: boolean;
  markerEnd?: boolean;
} | null): CanvasEdgeData {
  return {
    label: edge?.label ?? '',
    lineStyle: edge?.lineStyle ?? 'solid',
    animated: edge?.animated ?? false,
    animationReverse: edge?.animationReverse ?? false,
    markerStart: edge?.markerStart ?? false,
    markerEnd: edge?.markerEnd ?? false,
  };
}

function getEdgeDashArray(lineStyle: CanvasEdgeLineStyle) {
  if (lineStyle === 'dashed') return '10 8';
  if (lineStyle === 'dotted') return '2 7';
  return undefined;
}

function getSolidHighlightGradientId(edgeId: string) {
  return `canvas-edge-solid-highlight-${edgeId}`;
}

function getCanvasArrowMarkerId(kind: 'start' | 'end') {
  return `canvas-edge-arrow-${kind}`;
}

function getCanvasArrowMarkerIdForEdge(edgeId: string, kind: 'start' | 'end') {
  return `${getCanvasArrowMarkerId(kind)}-${edgeId}`;
}

function buildCanvasEdgePath(geometry: EdgeGeometry) {
  return `M ${geometry.sourceX} ${geometry.sourceY} C ${geometry.controlSourceX} ${geometry.controlSourceY}, ${geometry.controlTargetX} ${geometry.controlTargetY}, ${geometry.targetX} ${geometry.targetY}`;
}

function interpolateGeometry(from: EdgeGeometry, to: EdgeGeometry, progress: number): EdgeGeometry {
  const mix = (start: number, end: number) => start + (end - start) * progress;
  return {
    sourceX: mix(from.sourceX, to.sourceX),
    sourceY: mix(from.sourceY, to.sourceY),
    controlSourceX: mix(from.controlSourceX, to.controlSourceX),
    controlSourceY: mix(from.controlSourceY, to.controlSourceY),
    controlTargetX: mix(from.controlTargetX, to.controlTargetX),
    controlTargetY: mix(from.controlTargetY, to.controlTargetY),
    targetX: mix(from.targetX, to.targetX),
    targetY: mix(from.targetY, to.targetY),
    labelX: mix(from.labelX, to.labelX),
    labelY: mix(from.labelY, to.labelY),
  };
}

function easeOutCubic(value: number) {
  return 1 - (1 - value) ** 3;
}

function clamp01(value: number) {
  return Math.max(0, Math.min(1, value));
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

async function renderPdfPreview(dataUrl: string) {
  const task = getDocument({ data: dataUrlToUint8Array(dataUrl) });
  const pdf = await task.promise;

  try {
    const page = await pdf.getPage(1);
    const baseViewport = page.getViewport({ scale: 1 });
    const maxWidth = 520;
    const scale = Math.min(1.2, maxWidth / Math.max(baseViewport.width, 1));
    const viewport = page.getViewport({ scale });
    const canvas = document.createElement('canvas');
    const context = canvas.getContext('2d', { alpha: false });
    if (!context) throw new Error('Failed to get PDF preview canvas context');

    canvas.width = Math.max(1, Math.floor(viewport.width));
    canvas.height = Math.max(1, Math.floor(viewport.height));

    await page.render({
      canvas,
      canvasContext: context,
      viewport,
    }).promise;

    return canvas.toDataURL('image/png');
  } finally {
    await pdf.destroy().catch(() => {});
  }
}

function fromFlowEdge(edge: CanvasFlowEdge): CanvasEdge {
  const data = getCanvasEdgeData(edge.data);
  return {
    id: edge.id,
    source: edge.source,
    target: edge.target,
    label: data.label || undefined,
    lineStyle: data.lineStyle,
    animated: data.animated,
    animationReverse: data.animationReverse,
    markerStart: data.markerStart,
    markerEnd: data.markerEnd,
  };
}

function toFlowEdge(edge: CanvasEdge): CanvasFlowEdge {
  const data = getCanvasEdgeData(edge);
  return {
    id: edge.id,
    type: 'stacked',
    source: edge.source,
    target: edge.target,
    label: data.label,
    data,
    markerStart: data.markerStart ? `url(#${getCanvasArrowMarkerId('start')})` : undefined,
    markerEnd: data.markerEnd ? `url(#${getCanvasArrowMarkerId('end')})` : undefined,
    animated: false,
    style: {
      ...DEFAULT_EDGE_STYLE,
      strokeDasharray: getEdgeDashArray(data.lineStyle),
      strokeLinecap: data.lineStyle === 'dotted' ? 'round' : 'butt',
    },
    labelStyle: {
      fill: 'var(--foreground)',
      fontSize: 11,
      fontWeight: 600,
    },
    labelBgStyle: {
      fill: 'color-mix(in oklch, var(--card) 92%, var(--background))',
      fillOpacity: 0.92,
      stroke: 'color-mix(in oklch, var(--border) 85%, white 15%)',
      strokeWidth: 1,
    },
    labelBgPadding: [6, 3],
    labelBgBorderRadius: 6,
  };
}

function CanvasCardFrame({
  selected,
  children,
}: {
  selected?: boolean;
  children: React.ReactNode;
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

function getSlotOffset(index: number, count: number, nodeHeight: number) {
  if (count <= 1) return 0;
  const availableSpread = Math.max(nodeHeight - CANVAS_EDGE_SLOT_PADDING * 2, CANVAS_EDGE_SLOT_SPACING);
  const spacing = Math.min(CANVAS_EDGE_SLOT_SPACING, availableSpread / (count - 1));
  return (index - (count - 1) / 2) * spacing;
}

function getOrderedSiblingEdges(
  edges: CanvasFlowEdge[],
  nodeId: string,
  direction: 'source' | 'target',
  nodeGeometry: Map<string, { centerY: number; height: number }>,
  pendingEdge?: Pick<CanvasFlowEdge, 'id' | 'source' | 'target'>,
) {
  const subjectKey = direction === 'source' ? 'source' : 'target';
  const oppositeKey = direction === 'source' ? 'target' : 'source';
  const siblings = edges
    .filter((edge) => edge[subjectKey] === nodeId)
    .map((edge) => ({ id: edge.id, oppositeId: edge[oppositeKey] }));

  if (pendingEdge && pendingEdge[subjectKey] === nodeId && !siblings.some((edge) => edge.id === pendingEdge.id)) {
    siblings.push({ id: pendingEdge.id, oppositeId: pendingEdge[oppositeKey] });
  }

  siblings.sort((left, right) => {
    const leftCenter = nodeGeometry.get(left.oppositeId)?.centerY ?? 0;
    const rightCenter = nodeGeometry.get(right.oppositeId)?.centerY ?? 0;
    if (leftCenter !== rightCenter) return leftCenter - rightCenter;
    if (left.oppositeId !== right.oppositeId) return left.oppositeId.localeCompare(right.oppositeId);
    return left.id.localeCompare(right.id);
  });

  return siblings;
}

function getAnchoredEdgeGeometry({
  edge,
  edges,
  nodeGeometry,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
}: {
  edge: Pick<CanvasFlowEdge, 'id' | 'source' | 'target'>;
  edges: CanvasFlowEdge[];
  nodeGeometry: Map<string, { centerY: number; height: number }>;
  sourceX: number;
  sourceY: number;
  targetX: number;
  targetY: number;
  sourcePosition: Position;
  targetPosition: Position;
}): EdgeGeometry {
  const sourceSiblings = getOrderedSiblingEdges(edges, edge.source, 'source', nodeGeometry, edge);
  const targetSiblings = getOrderedSiblingEdges(edges, edge.target, 'target', nodeGeometry, edge);
  const sourceIndex = Math.max(0, sourceSiblings.findIndex((candidate) => candidate.id === edge.id));
  const targetIndex = Math.max(0, targetSiblings.findIndex((candidate) => candidate.id === edge.id));
  const sourceNodeHeight = nodeGeometry.get(edge.source)?.height ?? DEFAULT_NODE_SIZE.height;
  const targetNodeHeight = nodeGeometry.get(edge.target)?.height ?? DEFAULT_NODE_SIZE.height;
  const sourceOffset = getSlotOffset(sourceIndex, sourceSiblings.length, sourceNodeHeight);
  const targetOffset = getSlotOffset(targetIndex, targetSiblings.length, targetNodeHeight);
  const anchoredSourceY = sourceY + sourceOffset;
  const anchoredTargetY = targetY + targetOffset;
  const directionFromSource = sourcePosition === Position.Left ? -1 : sourcePosition === Position.Right ? 1 : 0;
  const directionFromTarget = targetPosition === Position.Left ? -1 : targetPosition === Position.Right ? 1 : 0;
  const horizontalDistance = Math.max(Math.abs(targetX - sourceX), CANVAS_EDGE_LANE * 2);
  const laneDistance = Math.max(CANVAS_EDGE_LANE, Math.min(horizontalDistance * 0.38, 96));
  const controlSourceX = sourceX + directionFromSource * laneDistance;
  const controlTargetX = targetX + directionFromTarget * laneDistance;
  const controlSourceY = anchoredSourceY + sourceOffset * 0.18;
  const controlTargetY = anchoredTargetY + targetOffset * 0.18;
  const labelX = (sourceX + targetX) / 2 + (sourceOffset - targetOffset) * 0.18;
  const labelY = (anchoredSourceY + anchoredTargetY) / 2;

  return {
    sourceX,
    sourceY: anchoredSourceY,
    controlSourceX,
    controlSourceY,
    controlTargetX,
    controlTargetY,
    targetX,
    targetY: anchoredTargetY,
    labelX,
    labelY,
  };
}

function StackedCanvasEdge(props: EdgeProps<CanvasFlowEdge>) {
  const edges = useEdges<CanvasFlowEdge>();
  const nodes = useNodes<FlowNode<CanvasNodeData>>();
  const nodeGeometry = useMemo(
    () => new Map(nodes.map((node) => [
      node.id,
      {
        centerY: (node.position.y ?? 0) + (
          typeof node.height === 'number'
            ? node.height
            : typeof node.measured?.height === 'number'
            ? node.measured.height
            : typeof node.style?.height === 'number'
            ? node.style.height
            : DEFAULT_NODE_SIZE.height
        ) / 2,
        height: typeof node.height === 'number'
          ? node.height
          : typeof node.measured?.height === 'number'
          ? node.measured.height
          : typeof node.style?.height === 'number'
          ? node.style.height
          : DEFAULT_NODE_SIZE.height,
      },
    ])),
    [nodes],
  );
  const targetGeometry = useMemo(() => getAnchoredEdgeGeometry({
    edge: props,
    edges,
    nodeGeometry,
    sourceX: props.sourceX,
    sourceY: props.sourceY,
    targetX: props.targetX,
    targetY: props.targetY,
    sourcePosition: props.sourcePosition,
    targetPosition: props.targetPosition,
  }), [
    edges,
    nodeGeometry,
    props.id,
    props.source,
    props.target,
    props.sourceX,
    props.sourceY,
    props.targetX,
    props.targetY,
    props.sourcePosition,
    props.targetPosition,
  ]);
  const [displayGeometry, setDisplayGeometry] = useState(targetGeometry);
  const currentGeometryRef = useRef(targetGeometry);

  useEffect(() => {
    const previous = currentGeometryRef.current;
    const next = targetGeometry;
    const changed = (Object.keys(next) as (keyof EdgeGeometry)[])
      .some((key) => Math.abs(previous[key] - next[key]) > 0.25);

    if (!changed) {
      currentGeometryRef.current = next;
      setDisplayGeometry(next);
      return;
    }

    let frameId = 0;
    const startedAt = performance.now();

    const tick = (now: number) => {
      const progress = Math.min(1, (now - startedAt) / CANVAS_EDGE_REROUTE_MS);
      const interpolated = interpolateGeometry(previous, next, easeOutCubic(progress));
      currentGeometryRef.current = interpolated;
      setDisplayGeometry(interpolated);
      if (progress < 1) frameId = requestAnimationFrame(tick);
    };

    frameId = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(frameId);
    };
  }, [targetGeometry]);

  const data = getCanvasEdgeData(props.data);
  const baseStrokeWidth = typeof props.style?.strokeWidth === 'number'
    ? props.style.strokeWidth
    : DEFAULT_EDGE_STYLE.strokeWidth;
  const gradientId = getSolidHighlightGradientId(props.id);
  const markerStartId = getCanvasArrowMarkerIdForEdge(props.id, 'start');
  const markerEndId = getCanvasArrowMarkerIdForEdge(props.id, 'end');
  const [solidAnimationProgress, setSolidAnimationProgress] = useState(0);
  const visibleStroke = data.animated && data.lineStyle === 'solid'
    ? `url(#${gradientId})`
    : DEFAULT_EDGE_STROKE;
  const visibleDashArray = getEdgeDashArray(data.lineStyle);
  const visibleStrokeLinecap = data.lineStyle === 'dotted' ? 'round' : 'butt';

  useEffect(() => {
    if (!data.animated || data.lineStyle !== 'solid') {
      setSolidAnimationProgress(0);
      return;
    }

    let frameId = 0;
    const durationMs = 1600;
    const startedAt = performance.now();

    const tick = (now: number) => {
      const elapsed = (now - startedAt) % durationMs;
      const linearProgress = elapsed / durationMs;
      setSolidAnimationProgress(data.animationReverse ? 1 - linearProgress : linearProgress);
      frameId = requestAnimationFrame(tick);
    };

    frameId = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(frameId);
    };
  }, [data.animated, data.animationReverse, data.lineStyle]);

  const solidHighlightLead = clamp01(solidAnimationProgress - 0.12);
  const solidHighlightCoreStart = clamp01(solidAnimationProgress - 0.05);
  const solidHighlightCoreEnd = clamp01(solidAnimationProgress + 0.05);
  const solidHighlightTrail = clamp01(solidAnimationProgress + 0.12);
  const markerInset = 6;
  const sourceDirection = normalizeVector(
    displayGeometry.controlSourceX - displayGeometry.sourceX,
    displayGeometry.controlSourceY - displayGeometry.sourceY,
  );
  const targetDirection = normalizeVector(
    displayGeometry.targetX - displayGeometry.controlTargetX,
    displayGeometry.targetY - displayGeometry.controlTargetY,
  );
  const pathSourceX = props.markerStart ? displayGeometry.sourceX + sourceDirection.x * markerInset : displayGeometry.sourceX;
  const pathSourceY = props.markerStart ? displayGeometry.sourceY + sourceDirection.y * markerInset : displayGeometry.sourceY;
  const pathTargetX = props.markerEnd ? displayGeometry.targetX - targetDirection.x * markerInset : displayGeometry.targetX;
  const pathTargetY = props.markerEnd ? displayGeometry.targetY - targetDirection.y * markerInset : displayGeometry.targetY;
  const pathGeometry: EdgeGeometry = {
    ...displayGeometry,
    sourceX: pathSourceX,
    sourceY: pathSourceY,
    targetX: pathTargetX,
    targetY: pathTargetY,
  };
  const path = buildCanvasEdgePath(pathGeometry);

  return (
    <>
      <defs>
        <marker
          id={markerEndId}
          viewBox="0 0 12 10"
          refX="5.6"
          refY="5"
          markerWidth="10"
          markerHeight="10"
          markerUnits="strokeWidth"
          orient="auto"
        >
          <path
            d="M10.6 5L5.2 1.6C3.6 0.6 1.6 1.75 1.6 3.62V6.38C1.6 8.25 3.6 9.4 5.2 8.4L10.6 5Z"
            fill="color-mix(in oklch, var(--primary) 82%, white 18%)"
            stroke="color-mix(in oklch, var(--background) 88%, transparent)"
            strokeWidth="0.8"
            strokeLinejoin="round"
          />
          <path
            d="M9.1 5H5.75"
            fill="none"
            stroke="color-mix(in oklch, var(--background) 84%, transparent)"
            strokeWidth="0.9"
            strokeLinecap="round"
          />
        </marker>
        <marker
          id={markerStartId}
          viewBox="0 0 12 10"
          refX="5.6"
          refY="5"
          markerWidth="10"
          markerHeight="10"
          markerUnits="strokeWidth"
          orient="auto-start-reverse"
        >
          <path
            d="M10.6 5L5.2 1.6C3.6 0.6 1.6 1.75 1.6 3.62V6.38C1.6 8.25 3.6 9.4 5.2 8.4L10.6 5Z"
            fill="color-mix(in oklch, var(--primary) 82%, white 18%)"
            stroke="color-mix(in oklch, var(--background) 88%, transparent)"
            strokeWidth="0.8"
            strokeLinejoin="round"
          />
          <path
            d="M9.1 5H5.75"
            fill="none"
            stroke="color-mix(in oklch, var(--background) 84%, transparent)"
            strokeWidth="0.9"
            strokeLinecap="round"
          />
        </marker>
      </defs>
      {data.animated && data.lineStyle === 'solid' ? (
        <defs>
          <linearGradient
            id={gradientId}
            gradientUnits="userSpaceOnUse"
            x1={displayGeometry.sourceX - 140}
            y1={displayGeometry.sourceY}
            x2={displayGeometry.targetX + 140}
            y2={displayGeometry.targetY}
          >
            <stop offset="0%" stopColor={DEFAULT_EDGE_STROKE} />
            <stop offset={`${solidHighlightLead * 100}%`} stopColor={DEFAULT_EDGE_STROKE} />
            <stop offset={`${solidHighlightCoreStart * 100}%`} stopColor={EDGE_ANIMATION_STROKE} stopOpacity="0.25" />
            <stop offset={`${solidAnimationProgress * 100}%`} stopColor={EDGE_ANIMATION_STROKE} stopOpacity="1" />
            <stop offset={`${solidHighlightCoreEnd * 100}%`} stopColor={EDGE_ANIMATION_STROKE} stopOpacity="0.25" />
            <stop offset={`${solidHighlightTrail * 100}%`} stopColor={DEFAULT_EDGE_STROKE} />
            <stop offset="100%" stopColor={DEFAULT_EDGE_STROKE} />
          </linearGradient>
        </defs>
      ) : null}
      <path
        d={path}
        fill="none"
        stroke={visibleStroke}
        strokeWidth={baseStrokeWidth}
        strokeLinecap={visibleStrokeLinecap}
        strokeLinejoin="round"
        strokeDasharray={visibleDashArray}
        markerStart={props.markerStart ? `url(#${markerStartId})` : undefined}
        markerEnd={props.markerEnd ? `url(#${markerEndId})` : undefined}
        style={{
          filter: props.selected ? 'drop-shadow(0 0 10px color-mix(in oklch, var(--primary) 35%, transparent))' : undefined,
        }}
      >
        {data.animated && data.lineStyle !== 'solid' ? (
          <animate
            attributeName="stroke-dashoffset"
            from={data.animationReverse ? '-18' : '18'}
            to="0"
            dur="700ms"
            repeatCount="indefinite"
          />
        ) : null}
      </path>
      <BaseEdge
        {...props}
        path={path}
        labelX={displayGeometry.labelX}
        labelY={displayGeometry.labelY}
        style={{
          stroke: 'transparent',
          strokeWidth: 0,
          opacity: 0,
        }}
      />
    </>
  );
}

function StackedConnectionLine({
  connectionLineStyle,
  fromNode,
  fromX,
  fromY,
  fromPosition,
  toNode,
  toX,
  toY,
  toPosition,
}: ConnectionLineComponentProps<FlowNode<CanvasNodeData>>) {
  const edges = useEdges<CanvasFlowEdge>();
  const nodes = useNodes<FlowNode<CanvasNodeData>>();
  const nodeGeometry = useMemo(
    () => new Map(nodes.map((node) => [
      node.id,
      {
        centerY: (node.position.y ?? 0) + (
          typeof node.height === 'number'
            ? node.height
            : typeof node.measured?.height === 'number'
            ? node.measured.height
            : typeof node.style?.height === 'number'
            ? node.style.height
            : DEFAULT_NODE_SIZE.height
        ) / 2,
        height: typeof node.height === 'number'
          ? node.height
          : typeof node.measured?.height === 'number'
          ? node.measured.height
          : typeof node.style?.height === 'number'
          ? node.style.height
          : DEFAULT_NODE_SIZE.height,
      },
    ])),
    [nodes],
  );
  const previewEdge: Pick<CanvasFlowEdge, 'id' | 'source' | 'target'> = {
    id: '__canvas-connection-preview__',
    source: fromNode.id,
    target: toNode?.id ?? '__pointer__',
  };
  const geometry = getAnchoredEdgeGeometry({
    edge: previewEdge,
    edges,
    nodeGeometry,
    sourceX: fromX,
    sourceY: fromY,
    targetX: toX,
    targetY: toY,
    sourcePosition: fromPosition,
    targetPosition: toPosition,
  });
  const path = buildCanvasEdgePath(geometry);

  return (
    <g>
      <path
        d={path}
        fill="none"
        stroke={DEFAULT_EDGE_STROKE}
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeDasharray="7 7"
        style={{
          ...connectionLineStyle,
          transition: 'd 180ms cubic-bezier(0.22, 1, 0.36, 1)',
          opacity: 0.9,
        }}
      />
    </g>
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
              {data.extension ? getFileIcon({ extension: data.extension }) : <FileText size={14} />}
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

const nodeTypes = {
  noteCard: NoteCardNode,
  fileCard: FileCardNode,
  textCard: TextCardNode,
  webCard: WebCardNode,
};

const edgeTypes = {
  stacked: StackedCanvasEdge,
};

function CanvasPickerDialog({
  open,
  mode,
  files,
  onOpenChange,
  onSelect,
}: {
  open: boolean;
  mode: PickerMode;
  files: NoteFile[];
  onOpenChange: (open: boolean) => void;
  onSelect: (file: NoteFile) => void;
}) {
  const title = mode === 'note' ? 'Add note to canvas' : 'Add file to canvas';

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg overflow-hidden p-0">
        <DialogHeader className="border-b border-border/50 px-4 py-3">
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        <Command className="rounded-none border-none bg-transparent">
          <CommandInput placeholder={mode === 'note' ? 'Search notes…' : 'Search files…'} />
          <CommandList className="max-h-[420px]">
            <CommandEmpty>No matching items.</CommandEmpty>
            <CommandGroup>
              {files.map((file) => (
                <CommandItem
                  key={file.relativePath}
                  value={`${file.name} ${file.relativePath}`}
                  onSelect={() => onSelect(file)}
                  className="gap-3 py-2"
                >
                  {getFileIcon(file)}
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm">{getNameWithoutExtension(file.name)}</div>
                    <div className="truncate text-[11px] text-muted-foreground">{file.relativePath}</div>
                  </div>
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </DialogContent>
    </Dialog>
  );
}

function CanvasBoard({ relativePath }: { relativePath: string | null }) {
  const { vault, fileTree } = useVaultStore();
  const { openTab } = useEditorStore();
  const {
    setActiveView,
    canvasWebCardDefaultMode,
    canvasWebCardAutoLoad,
    webPreviewsEnabled,
    hoverWebLinkPreviewsEnabled,
    backgroundWebPreviewPrefetchEnabled,
  } = useUiStore();
  const reactFlow = useReactFlow<FlowNode<CanvasNodeData>, CanvasFlowEdge>();
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const hashRef = useRef<string | undefined>(undefined);
  const lastWriteRef = useRef(0);
  const isMountedRef = useRef(true);
  const skipNextSaveRef = useRef(true);
  const pendingViewportRef = useRef<Viewport | null>(null);
  const loadingPreviewPathsRef = useRef(new Set<string>());
  const [nodes, setNodes] = useNodesState<FlowNode<CanvasNodeData>>([]);
  const [edges, setEdges, onEdgesChangeBase] = useEdgesState<CanvasFlowEdge>([]);
  const [viewport, setViewport] = useState(EMPTY_CANVAS.viewport);
  const [pickerMode, setPickerMode] = useState<PickerMode>(null);
  const [edgeLabelDraft, setEdgeLabelDraft] = useState('');
  const [previews, setPreviews] = useState<Record<string, PreviewState>>({});
  const [requestedWebPreviewIds, setRequestedWebPreviewIds] = useState<Record<string, boolean>>({});
  const [loadRevision, setLoadRevision] = useState(0);

  const allFiles = useMemo(() => flattenFiles(fileTree).filter((node) => !node.isFolder), [fileTree]);
  const availableNotes = useMemo(() => allFiles.filter((file) => file.extension.toLowerCase() === 'md'), [allFiles]);
  const availableFiles = useMemo(() => allFiles.filter((file) => file.extension.toLowerCase() !== 'md'), [allFiles]);
  const selectedEdge = useMemo(() => edges.find((edge) => edge.selected), [edges]);
  const zoomLabel = `${Math.round(viewport.zoom * 100)}%`;

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  const openRelativePath = useCallback((path: string) => {
    const extension = path.split('.').pop()?.toLowerCase() ?? '';
    const type = isImageExtension(extension)
      ? 'image'
      : extension === 'pdf'
      ? 'pdf'
      : extension === 'canvas'
      ? 'canvas'
      : extension === 'kanban'
      ? 'kanban'
      : 'note';
    openTab(path, getNameWithoutExtension(getBaseName(path)), type);
    if (type === 'canvas') setActiveView('canvas');
    else if (type === 'kanban') setActiveView('kanban');
    else setActiveView('editor');
  }, [openTab, setActiveView]);

  const updateTextContent = useCallback((nodeId: string, content: string) => {
    setNodes((prev) =>
      prev.map((node) =>
        node.id === nodeId
          ? {
              ...node,
              data: { ...node.data, content },
            }
          : node,
      ),
    );
  }, [setNodes]);

  const updateWebUrl = useCallback((nodeId: string, url: string) => {
    setRequestedWebPreviewIds((prev) => {
      if (!(nodeId in prev)) return prev;
      const next = { ...prev };
      delete next[nodeId];
      return next;
    });
    setNodes((prev) =>
      prev.map((node) => (
        node.id === nodeId
          ? {
              ...node,
              data: {
                ...node.data,
                url,
                title: '',
                subtitle: '',
                excerpt: '',
                imageSrc: null,
                faviconSrc: null,
                hasRichPreview: false,
                previewError: null,
                previewLoading: false,
                previewLoaded: false,
                embedAvailable: undefined,
              },
            }
          : node
      )),
    );
  }, [setNodes]);

  const requestWebPreview = useCallback((nodeId: string) => {
    setRequestedWebPreviewIds((prev) => ({ ...prev, [nodeId]: true }));
  }, []);

  const updateWebDisplayModeOverride = useCallback((nodeId: string, mode: CanvasWebDisplayMode | null) => {
    setNodes((prev) =>
      prev.map((node) => (
        node.id === nodeId
          ? { ...node, data: { ...node.data, displayModeOverride: mode, displayMode: resolveWebDisplayMode(mode, canvasWebCardDefaultMode) } }
          : node
      )),
    );
  }, [canvasWebCardDefaultMode, setNodes]);

  const openExternalUrl = useCallback((url: string) => {
    const normalized = normalizeWebUrl(url);
    if (!normalized) return;
    void openUrl(normalized);
  }, []);

  const snapNodeToGrid = useCallback((nodeId: string) => {
    setNodes((prev) =>
      prev.map((node) => {
        if (node.id !== nodeId) return node;
        const minWidth = node.type === 'textCard' ? 200 : 220;
        const minHeight = node.type === 'textCard' ? 120 : 140;
        return {
          ...node,
          position: snapPosition(node.position),
          width: typeof node.width === 'number' ? snapSize(node.width, minWidth) : node.width,
          height: typeof node.height === 'number' ? snapSize(node.height, minHeight) : node.height,
          style: {
            ...node.style,
            width: snapSize(
              typeof node.width === 'number'
                ? node.width
                : typeof node.style?.width === 'number'
                ? node.style.width
                : minWidth,
              minWidth,
            ),
            height: snapSize(
              typeof node.height === 'number'
                ? node.height
                : typeof node.style?.height === 'number'
                ? node.style.height
                : minHeight,
              minHeight,
            ),
          },
        };
      }),
    );
  }, [setNodes]);

  const hydratePreview = useCallback(async (node: CanvasNode) => {
    if (!vault && node.type !== 'web') return;
    const previewKey = getPreviewKey(node);
    if (loadingPreviewPathsRef.current.has(previewKey)) return;

    loadingPreviewPathsRef.current.add(previewKey);
    setPreviews((prev) => ({
      ...prev,
      [previewKey]: { ...(prev[previewKey] ?? {}), loading: true },
    }));
    if (node.type === 'web') {
      setNodes((prev) =>
        prev.map((flowNode) => {
          if (flowNode.id !== node.id) return flowNode;
          return {
            ...flowNode,
            data: {
              ...flowNode.data,
              ...buildWebPreviewState(node, { ...(previews[previewKey] ?? {}), loading: true, loaded: false }, canvasWebCardDefaultMode, canvasWebCardAutoLoad, webPreviewsEnabled),
              onRequestWebPreview: requestWebPreview,
              onOpenUrl: openExternalUrl,
            },
          };
        }),
      );
    }

    try {
      let nextPreview: PreviewState = {};

      if (node.type === 'web') {
        const normalizedUrl = normalizeWebUrl(node.url);
        if (!normalizedUrl) {
          nextPreview = { previewError: null };
        } else {
          const linkPreview = await requestCachedWebPreview(normalizedUrl);
          nextPreview = {
            linkPreview,
            imageSrc: linkPreview.imageUrl ?? null,
            faviconSrc: linkPreview.faviconUrl ?? null,
          };
        }
      } else if ('relativePath' in node && vault) {
        const path = node.relativePath;
        const extension = path.split('.').pop()?.toLowerCase() ?? '';
        if (node.type === 'file' && isImageExtension(extension)) {
          nextPreview = { imageSrc: await tauriCommands.readNoteAssetDataUrl(vault.path, path) };
        } else if (node.type === 'file' && extension === 'pdf') {
          const pdfDataUrl = await tauriCommands.readNoteAssetDataUrl(vault.path, path);
          nextPreview = { imageSrc: await renderPdfPreview(pdfDataUrl) };
        } else if (node.type === 'note') {
          const { content } = await tauriCommands.readNote(vault.path, path);
          nextPreview = { excerpt: cleanPreviewText(content), markdownContent: content };
        } else if (canPreviewText(extension)) {
          const { content } = await tauriCommands.readNote(vault.path, path);
          nextPreview = { excerpt: cleanPreviewText(content) };
        }
      }

      const resolvedPreview: PreviewState = { ...nextPreview, loading: false, loaded: true };
      if (!isMountedRef.current) return;

      setPreviews((prev) => ({
        ...prev,
        [previewKey]: resolvedPreview,
      }));
      setNodes((prev) =>
        prev.map((flowNode) => {
          if (getPreviewKey(fromFlowNode(flowNode)) !== previewKey) return flowNode;
          const sourceNode = fromFlowNode(flowNode);
          return {
            ...flowNode,
            data: {
                ...flowNode.data,
                ...(sourceNode.type === 'web'
                  ? buildWebPreviewState(sourceNode, resolvedPreview, canvasWebCardDefaultMode, canvasWebCardAutoLoad, webPreviewsEnabled)
                  : buildNodePreviewState(sourceNode as Extract<CanvasNode, { relativePath: string }>, resolvedPreview)),
              onOpen: openRelativePath,
              onWikilinkClick: openRelativePath,
              onOpenUrl: openExternalUrl,
              onRequestWebPreview: requestWebPreview,
            },
          };
        }),
      );
    } catch (error) {
      if (!isMountedRef.current) return;
      const failedPreview: PreviewState = {
        ...(previews[previewKey] ?? {}),
        previewError: error instanceof Error ? error.message : String(error),
        loading: false,
        loaded: true,
      };
      setPreviews((prev) => ({
        ...prev,
        [previewKey]: failedPreview,
      }));
      if (node.type === 'web') {
        setNodes((prev) =>
          prev.map((flowNode) => {
            if (flowNode.id !== node.id) return flowNode;
            return {
              ...flowNode,
              data: {
                ...flowNode.data,
                ...buildWebPreviewState(node, failedPreview, canvasWebCardDefaultMode, canvasWebCardAutoLoad, webPreviewsEnabled),
                onRequestWebPreview: requestWebPreview,
                onOpenUrl: openExternalUrl,
              },
            };
          }),
        );
      }
    } finally {
      loadingPreviewPathsRef.current.delete(previewKey);
    }
  }, [canvasWebCardAutoLoad, canvasWebCardDefaultMode, openExternalUrl, openRelativePath, previews, requestWebPreview, setNodes, vault, webPreviewsEnabled]);

  useEffect(() => {
    if (!webPreviewsEnabled || !hoverWebLinkPreviewsEnabled || !backgroundWebPreviewPrefetchEnabled) return;
    const urls = nodes
      .map((flowNode) => fromFlowNode(flowNode))
      .filter((node): node is WebCanvasNode => node.type === 'web')
      .map((node) => normalizeWebUrl(node.url))
      .filter((url) => /^https?:\/\//i.test(url));
    if (urls.length === 0) return;
    prefetchWebPreviews(urls);
  }, [backgroundWebPreviewPrefetchEnabled, hoverWebLinkPreviewsEnabled, nodes, webPreviewsEnabled]);

  const loadCanvas = useCallback(async (isInitial = false) => {
    if (!vault || !relativePath) return;

    try {
      const { content, hash } = await tauriCommands.readNote(vault.path, relativePath);
      if (!isMountedRef.current) return;

      let canvas = makeDefaultCanvas();

      if (content.trim()) {
        canvas = JSON.parse(content) as CanvasData;
      } else if (isInitial) {
        const blank = makeDefaultCanvas();
        const result = await tauriCommands.writeNote(vault.path, relativePath, JSON.stringify(blank, null, 2));
        hashRef.current = result.hash;
        canvas = blank;
      }

      hashRef.current = hashRef.current ?? hash;
      skipNextSaveRef.current = true;
      setPreviews({});
      setRequestedWebPreviewIds({});
      setViewport(canvas.viewport ?? EMPTY_CANVAS.viewport);
      setNodes(canvas.nodes.map((node) => toFlowNode(node, undefined, {
        onOpen: openRelativePath,
        onTextChange: updateTextContent,
        onSnapToGrid: snapNodeToGrid,
        onWebUrlChange: updateWebUrl,
        onWebDisplayModeOverrideChange: updateWebDisplayModeOverride,
        onRequestWebPreview: requestWebPreview,
        onOpenUrl: openExternalUrl,
      }, canvasWebCardDefaultMode, canvasWebCardAutoLoad, webPreviewsEnabled)));
      setEdges(canvas.edges.map(toFlowEdge));
      pendingViewportRef.current = canvas.viewport ?? EMPTY_CANVAS.viewport;
      setLoadRevision((prev) => prev + 1);
    } catch {}
  }, [canvasWebCardAutoLoad, canvasWebCardDefaultMode, openExternalUrl, openRelativePath, relativePath, requestWebPreview, setEdges, setNodes, snapNodeToGrid, updateTextContent, updateWebDisplayModeOverride, updateWebUrl, vault, webPreviewsEnabled]);

  useEffect(() => {
    if (!relativePath) return;
    void loadCanvas(true);
  }, [loadCanvas, relativePath]);

  useEffect(() => {
    const nextViewport = pendingViewportRef.current;
    if (!nextViewport) return;
    pendingViewportRef.current = null;
    requestAnimationFrame(() => {
      void reactFlow.setViewport(nextViewport, { duration: 0 });
    });
  }, [loadRevision, reactFlow]);

  useEffect(() => {
    if (!vault || !relativePath) return;
    let unsub: (() => void) | undefined;

    listen<{ path: string }>('vault:file-modified', (event) => {
      if (event.payload.path !== relativePath) return;
      if (Date.now() - lastWriteRef.current < 2000) return;
      void loadCanvas(false);
    }).then((cleanup) => {
      unsub = cleanup;
    });

    return () => {
      unsub?.();
    };
  }, [loadCanvas, relativePath, vault]);

  useEffect(() => {
    for (const flowNode of nodes) {
      const sourceNode = fromFlowNode(flowNode);
      if (sourceNode.type !== 'web' && !vault) continue;
      if (sourceNode.type !== 'web' && flowNode.type !== 'noteCard' && flowNode.type !== 'fileCard') continue;
      const existing = previews[getPreviewKey(sourceNode)];
      if (existing?.loading || existing?.loaded) continue;
      if (sourceNode.type === 'web' && !sourceNode.url.trim()) continue;
      if (sourceNode.type === 'web' && !webPreviewsEnabled) continue;
      if (sourceNode.type === 'web' && !canvasWebCardAutoLoad && !requestedWebPreviewIds[sourceNode.id]) continue;
      void hydratePreview(sourceNode);
    }
  }, [canvasWebCardAutoLoad, hydratePreview, nodes, previews, requestedWebPreviewIds, vault, webPreviewsEnabled]);

  const saveCanvas = useCallback(async () => {
    if (!vault || !relativePath) return;
    const payload: CanvasData = {
      nodes: nodes.map(fromFlowNode),
      edges: edges.map(fromFlowEdge),
      viewport,
    };

    lastWriteRef.current = Date.now();
    try {
      const result = await tauriCommands.writeNote(
        vault.path,
        relativePath,
        JSON.stringify(payload, null, 2),
        hashRef.current,
      );
      if (isMountedRef.current && !result.conflict) {
        hashRef.current = result.hash;
      }
    } catch {}
  }, [edges, nodes, relativePath, vault, viewport]);

  useEffect(() => {
    if (!vault || !relativePath) return;
    if (skipNextSaveRef.current) {
      skipNextSaveRef.current = false;
      return;
    }
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      void saveCanvas();
    }, SAVE_DEBOUNCE_MS);
    return () => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    };
  }, [edges, nodes, relativePath, saveCanvas, vault, viewport]);

  useEffect(() => {
    setEdgeLabelDraft(selectedEdge?.data?.label ?? '');
  }, [selectedEdge?.id]);

  const getViewportCenterPosition = useCallback(() => {
    const viewportEl = viewportRef.current;
    if (!viewportEl) return { x: 0, y: 0 };
    const rect = viewportEl.getBoundingClientRect();
    return reactFlow.screenToFlowPosition({
      x: rect.left + rect.width / 2,
      y: rect.top + rect.height / 2,
    });
  }, [reactFlow]);

  const addCanvasNode = useCallback((node: CanvasNode) => {
    const preview = previews[getPreviewKey(node)];
    setNodes((prev) => [...prev, toFlowNode({
      ...node,
      position: snapPosition(node.position),
      width: snapSize(node.width, node.type === 'text' ? 200 : 220),
      height: snapSize(node.height, node.type === 'text' ? 120 : 140),
    }, preview, {
      onOpen: openRelativePath,
      onTextChange: updateTextContent,
      onSnapToGrid: snapNodeToGrid,
      onWebUrlChange: updateWebUrl,
      onWebDisplayModeOverrideChange: updateWebDisplayModeOverride,
      onRequestWebPreview: requestWebPreview,
      onOpenUrl: openExternalUrl,
    }, canvasWebCardDefaultMode, canvasWebCardAutoLoad, webPreviewsEnabled)]);
  }, [canvasWebCardAutoLoad, canvasWebCardDefaultMode, openExternalUrl, openRelativePath, previews, requestWebPreview, setNodes, snapNodeToGrid, updateTextContent, updateWebDisplayModeOverride, updateWebUrl, webPreviewsEnabled]);

  const handlePickerSelect = useCallback((file: NoteFile) => {
    const center = getViewportCenterPosition();
    const id = crypto.randomUUID();
    if (pickerMode === 'note') {
      const node: NoteCanvasNode = {
        id,
        type: 'note',
        relativePath: file.relativePath,
        position: center,
        width: DEFAULT_NODE_SIZE.width,
        height: DEFAULT_NODE_SIZE.height,
      };
      addCanvasNode(node);
    } else {
      const node: FileCanvasNode = {
        id,
        type: 'file',
        relativePath: file.relativePath,
        position: center,
        width: DEFAULT_NODE_SIZE.width,
        height: DEFAULT_NODE_SIZE.height,
      };
      addCanvasNode(node);
    }
    setPickerMode(null);
  }, [addCanvasNode, getViewportCenterPosition, pickerMode]);

  const addTextNode = useCallback(() => {
    const center = getViewportCenterPosition();
    const node: TextCanvasNode = {
      id: crypto.randomUUID(),
      type: 'text',
      content: '',
      position: center,
      width: DEFAULT_TEXT_NODE_SIZE.width,
      height: DEFAULT_TEXT_NODE_SIZE.height,
    };
    addCanvasNode(node);
  }, [addCanvasNode, getViewportCenterPosition]);

  const addWebNode = useCallback(() => {
    const center = getViewportCenterPosition();
    const node: WebCanvasNode = {
      id: crypto.randomUUID(),
      type: 'web',
      url: '',
      displayModeOverride: null,
      position: center,
      width: 360,
      height: 240,
    };
    addCanvasNode(node);
  }, [addCanvasNode, getViewportCenterPosition]);

  const handleConnect = useCallback((connection: Connection) => {
    const data = getCanvasEdgeData();
    setEdges((prev) =>
      addEdge(
        {
          ...connection,
          id: crypto.randomUUID(),
          type: 'stacked',
          data,
          label: data.label,
          animated: false,
          markerStart: undefined,
          markerEnd: undefined,
          style: {
            ...DEFAULT_EDGE_STYLE,
            strokeDasharray: getEdgeDashArray(data.lineStyle),
            strokeLinecap: data.lineStyle === 'dotted' ? 'round' : 'butt',
          },
        },
        prev,
      ) as CanvasFlowEdge[],
    );
  }, [setEdges]);

  const handleReconnect = useCallback<OnReconnect<CanvasFlowEdge>>((oldEdge, newConnection) => {
    setEdges((prev) => (reconnectEdge(oldEdge, newConnection, prev) as CanvasFlowEdge[]).map((edge) => (
      edge.id === oldEdge.id
        ? toFlowEdge(fromFlowEdge(edge))
        : edge
    )));
  }, [setEdges]);

  const onNodesChange = useCallback((changes: NodeChange<FlowNode<CanvasNodeData>>[]) => {
    setNodes((prev) => applyNodeChanges(changes, prev));
  }, [setNodes]);

  const onEdgesChange = useCallback((changes: EdgeChange<CanvasFlowEdge>[]) => {
    onEdgesChangeBase(changes);
  }, [onEdgesChangeBase]);

  const handleDropOnCanvas = useCallback((event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    const relativePath = event.dataTransfer.getData('text/plain');
    if (!relativePath) return;

    const file = allFiles.find((entry) => entry.relativePath === relativePath);
    if (!file) return;

    const position = snapPosition(reactFlow.screenToFlowPosition({ x: event.clientX, y: event.clientY }));
    const node: CanvasNode = file.extension.toLowerCase() === 'md'
      ? {
          id: crypto.randomUUID(),
          type: 'note',
          relativePath: file.relativePath,
          position,
          width: DEFAULT_NODE_SIZE.width,
          height: DEFAULT_NODE_SIZE.height,
        }
      : {
          id: crypto.randomUUID(),
          type: 'file',
          relativePath: file.relativePath,
          position,
          width: DEFAULT_NODE_SIZE.width,
          height: DEFAULT_NODE_SIZE.height,
        };

    addCanvasNode(node);
  }, [addCanvasNode, allFiles, reactFlow]);

  const deleteSelection = useCallback(() => {
    setNodes((prev) => prev.filter((node) => !node.selected));
    setEdges((prev) => prev.filter((edge) => !edge.selected));
  }, [setEdges, setNodes]);

  const syncViewport = useCallback((nextViewport: Viewport, duration = 180) => {
    void reactFlow.setViewport(nextViewport, { duration });
    setViewport(nextViewport);
  }, [reactFlow]);

  const panViewport = useCallback((deltaX: number, deltaY: number) => {
    syncViewport({
      x: viewport.x + deltaX,
      y: viewport.y + deltaY,
      zoom: viewport.zoom,
    });
  }, [syncViewport, viewport.x, viewport.y, viewport.zoom]);

  const adjustZoom = useCallback((direction: 1 | -1) => {
    const nextZoom = Math.min(2.5, Math.max(0.2, viewport.zoom * (direction > 0 ? 1.15 : 1 / 1.15)));
    syncViewport({
      x: viewport.x,
      y: viewport.y,
      zoom: nextZoom,
    });
  }, [syncViewport, viewport.x, viewport.y, viewport.zoom]);

  const resetZoom = useCallback(() => {
    syncViewport({
      x: viewport.x,
      y: viewport.y,
      zoom: 1,
    });
  }, [syncViewport, viewport.x, viewport.y]);

  const fitCanvasView = useCallback(() => {
    void reactFlow.fitView({ duration: 180, padding: 0.12 }).then(() => {
      setViewport(reactFlow.getViewport());
    });
  }, [reactFlow]);

  const updateSelectedEdge = useCallback((updater: (edge: CanvasEdge) => CanvasEdge) => {
    if (!selectedEdge?.id) return;
    setEdges((prev) => prev.map((edge) => (
      edge.id === selectedEdge.id
        ? {
            ...edge,
            ...toFlowEdge(updater(fromFlowEdge(edge))),
            selected: true,
          }
        : edge
    )));
  }, [selectedEdge?.id, setEdges]);

  const updateSelectedEdgeLabel = useCallback((label: string) => {
    setEdgeLabelDraft(label);
    updateSelectedEdge((edge) => ({ ...edge, label }));
  }, [updateSelectedEdge]);

  const updateSelectedEdgeLineStyle = useCallback((lineStyle: CanvasEdgeLineStyle) => {
    updateSelectedEdge((edge) => ({ ...edge, lineStyle }));
  }, [updateSelectedEdge]);

  const updateSelectedEdgeAnimation = useCallback((animated: boolean) => {
    updateSelectedEdge((edge) => ({ ...edge, animated }));
  }, [updateSelectedEdge]);

  const updateSelectedEdgeAnimationDirection = useCallback((animationReverse: boolean) => {
    updateSelectedEdge((edge) => ({ ...edge, animationReverse }));
  }, [updateSelectedEdge]);

  const updateSelectedEdgeMarkerStart = useCallback((markerStart: boolean) => {
    updateSelectedEdge((edge) => ({ ...edge, markerStart }));
  }, [updateSelectedEdge]);

  const updateSelectedEdgeMarkerEnd = useCallback((markerEnd: boolean) => {
    updateSelectedEdge((edge) => ({ ...edge, markerEnd }));
  }, [updateSelectedEdge]);

  useEffect(() => {
    const isEditableTarget = (target: EventTarget | null) => (
      target instanceof HTMLElement
      && target.matches('input, textarea, [contenteditable="true"], [contenteditable=""], [role="textbox"], [role="combobox"]')
    );

    const handleKeyDown = (event: KeyboardEvent) => {
      if (isEditableTarget(event.target) || event.altKey) return;

      const zoomModifier = event.ctrlKey || event.metaKey;

      if (zoomModifier && (event.key === '+' || event.key === '=')) {
        event.preventDefault();
        adjustZoom(1);
        return;
      }

      if (zoomModifier && event.key === '-') {
        event.preventDefault();
        adjustZoom(-1);
        return;
      }

      if ((zoomModifier || !event.shiftKey) && event.key === '0') {
        event.preventDefault();
        resetZoom();
        return;
      }

      switch (event.key) {
        case 'n':
        case 'N':
          event.preventDefault();
          setPickerMode('note');
          break;
        case 'f':
          if (!event.shiftKey) {
            event.preventDefault();
            setPickerMode('file');
          }
          break;
        case 'F':
          event.preventDefault();
          fitCanvasView();
          break;
        case 't':
        case 'T':
          event.preventDefault();
          addTextNode();
          break;
        case 'w':
        case 'W':
          event.preventDefault();
          addWebNode();
          break;
        case 'ArrowUp':
          event.preventDefault();
          panViewport(0, 120);
          break;
        case 'ArrowDown':
          event.preventDefault();
          panViewport(0, -120);
          break;
        case 'ArrowLeft':
          event.preventDefault();
          panViewport(120, 0);
          break;
        case 'ArrowRight':
          event.preventDefault();
          panViewport(-120, 0);
          break;
        case 'Delete':
        case 'Backspace':
          event.preventDefault();
          deleteSelection();
          break;
        case 'Escape':
          if (pickerMode !== null) {
            event.preventDefault();
            setPickerMode(null);
          }
          break;
      }
    };

    document.addEventListener('keydown', handleKeyDown, { capture: true });
    return () => {
      document.removeEventListener('keydown', handleKeyDown, { capture: true } as EventListenerOptions);
    };
  }, [addTextNode, addWebNode, adjustZoom, deleteSelection, fitCanvasView, panViewport, pickerMode, resetZoom]);

  if (!relativePath) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 text-muted-foreground select-none">
        <Layout size={40} className="opacity-30" />
        <p className="text-lg font-medium">Canvas</p>
        <p className="max-w-sm text-center text-sm opacity-60">
          Select or create a canvas board from the sidebar to start building an infinite workspace.
        </p>
      </div>
    );
  }

  return (
    <div className="flex h-full w-full min-h-0 flex-col overflow-hidden bg-background app-fade-slide-in">
      <DocumentTopBar
        title={getDocumentBaseName(relativePath, 'Canvas')}
        subtitle={getDocumentFolderPath(relativePath)}
        icon={<Layout size={15} />}
        meta={
          <>
            <span className="shrink-0 text-xs text-muted-foreground">
              {nodes.length} {nodes.length === 1 ? 'card' : 'cards'} and {edges.length} {edges.length === 1 ? 'link' : 'links'}
            </span>
          </>
        }
        secondary={
          <>
            <div className={documentTopBarGroupClass}>
              <Button size="sm" variant="ghost" className="h-8 gap-1.5 px-2.5 text-xs" onClick={() => setPickerMode('note')}>
                <Plus size={14} />
                Add note
              </Button>
              <Button size="sm" variant="ghost" className="h-8 gap-1.5 px-2.5 text-xs" onClick={() => setPickerMode('file')}>
                <FileText size={14} />
                Add file
              </Button>
              <Button size="sm" variant="ghost" className="h-8 gap-1.5 px-2.5 text-xs" onClick={addTextNode}>
                <PencilLine size={14} />
                Add text
              </Button>
              <Button size="sm" variant="ghost" className="h-8 gap-1.5 px-2.5 text-xs" onClick={addWebNode}>
                <Globe size={14} />
                Add web
              </Button>
            </div>

            <div className={documentTopBarGroupClass}>
              <Button size="icon" variant="ghost" className="size-8" onClick={() => adjustZoom(-1)} title="Zoom out">
                <Minus size={15} />
              </Button>
              <button
                type="button"
                onClick={resetZoom}
                className="min-w-[78px] rounded-md px-2 text-center text-xs font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
                title="Reset zoom to 100%"
              >
                {zoomLabel}
              </button>
              <Button size="icon" variant="ghost" className="size-8" onClick={() => adjustZoom(1)} title="Zoom in">
                <PlusIcon size={15} />
              </Button>
            </div>

            <div className={documentTopBarGroupClass}>
              <Button size="sm" variant="ghost" className="h-8 gap-1.5 px-2.5 text-xs" onClick={fitCanvasView}>
                <Maximize2 size={14} />
                Fit view
              </Button>
              <Button size="sm" variant="ghost" className="h-8 gap-1.5 px-2.5 text-xs" onClick={resetZoom}>
                <RotateCcw size={14} />
                Reset zoom
              </Button>
            </div>

            <div className="hidden items-center gap-2 rounded-xl border border-border/60 bg-card/45 px-2.5 py-1 text-xs text-muted-foreground lg:flex">
              <MousePointer2 size={13} />
              Drag the board to pan. Drag files from the sidebar to add them.
            </div>
          </>
        }
      />

      <div
        ref={viewportRef}
        className="relative min-h-0 flex-1 overflow-hidden bg-[radial-gradient(circle_at_top,oklch(0.24_0.04_230_/_0.16),transparent_45%),linear-gradient(to_bottom,transparent,transparent)]"
        onDragOver={(event) => {
          event.preventDefault();
          event.dataTransfer.dropEffect = 'copy';
        }}
        onDrop={handleDropOnCanvas}
      >
      <CanvasPickerDialog
        open={pickerMode !== null}
        mode={pickerMode}
        files={pickerMode === 'note' ? availableNotes : availableFiles}
        onOpenChange={(open) => {
          if (!open) setPickerMode(null);
        }}
        onSelect={handlePickerSelect}
      />

      <ReactFlow<FlowNode<CanvasNodeData>, CanvasFlowEdge>
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onNodeDragStop={(_, node) => snapNodeToGrid(node.id)}
        onConnect={handleConnect}
        onReconnect={handleReconnect}
        onMoveEnd={(_: MouseEvent | TouchEvent | null, nextViewport: Viewport) => setViewport(nextViewport)}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        deleteKeyCode={['Backspace', 'Delete']}
        nodesDraggable
        elementsSelectable
        nodesConnectable
        edgesReconnectable
        connectionLineComponent={StackedConnectionLine}
        connectionRadius={36}
        reconnectRadius={36}
        minZoom={0.2}
        maxZoom={2.5}
        proOptions={{ hideAttribution: true }}
        className="canvas-flow"
        defaultEdgeOptions={{
          type: 'stacked',
          animated: false,
          style: {
            ...DEFAULT_EDGE_STYLE,
            strokeLinecap: 'butt',
          },
        }}
      >
        <Background
          gap={24}
          size={1.5}
          variant={BackgroundVariant.Dots}
          color="color-mix(in oklch, var(--muted-foreground) 22%, transparent)"
        />
        <Panel position="top-right" className="pointer-events-auto flex max-w-[min(420px,calc(100vw-220px))] flex-col gap-2 rounded-2xl border border-border/60 bg-popover/90 p-2.5 shadow-xl backdrop-blur-xs-webkit app-fade-scale-in">
          <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
            <Link2 size={13} />
            Selected connection
          </div>
          {selectedEdge ? (
            <>
              <Input
                value={edgeLabelDraft}
                onChange={(event) => updateSelectedEdgeLabel(event.target.value)}
                placeholder="Connection label"
                className="h-8"
              />
              <div className="grid grid-cols-2 gap-2">
                <div className="rounded-xl border border-border/60 bg-card/45 p-2">
                  <div className="mb-1 text-[11px] font-medium text-muted-foreground">Line type</div>
                  <Select
                    value={getCanvasEdgeData(selectedEdge.data).lineStyle}
                    onValueChange={(value) => updateSelectedEdgeLineStyle(value as CanvasEdgeLineStyle)}
                  >
                    <SelectTrigger size="sm" className="h-8 w-full bg-background/70 text-xs">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent align="end">
                      <SelectItem value="solid">Solid</SelectItem>
                      <SelectItem value="dashed">Dashed</SelectItem>
                      <SelectItem value="dotted">Dotted</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="rounded-xl border border-border/60 bg-card/45 p-2">
                  <div className="mb-1 text-[11px] font-medium text-muted-foreground">Animation</div>
                  <Select
                    value={getCanvasEdgeData(selectedEdge.data).animationReverse ? 'reverse' : 'forward'}
                    onValueChange={(value) => updateSelectedEdgeAnimationDirection(value === 'reverse')}
                    disabled={!getCanvasEdgeData(selectedEdge.data).animated}
                  >
                    <SelectTrigger size="sm" className="h-8 w-full bg-background/70 text-xs">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent align="end">
                      <SelectItem value="forward">Forward</SelectItem>
                      <SelectItem value="reverse">Reverse</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>
              <label className="flex items-center justify-between gap-3 rounded-xl border border-border/60 bg-card/45 px-3 py-2 text-xs">
                <span>
                  <span className="block font-medium text-foreground">Animated line</span>
                  <span className="block text-muted-foreground">Off by default, reversible when enabled.</span>
                </span>
                <Checkbox
                  checked={getCanvasEdgeData(selectedEdge.data).animated}
                  onCheckedChange={(checked) => updateSelectedEdgeAnimation(checked === true)}
                />
              </label>
              <div className="grid grid-cols-2 gap-2">
                <label className="flex items-center justify-between gap-3 rounded-xl border border-border/60 bg-card/45 px-3 py-2 text-xs">
                  <span>
                    <span className="block font-medium text-foreground">Start arrow</span>
                    <span className="block text-muted-foreground">Show an arrowhead at the source.</span>
                  </span>
                  <Checkbox
                    checked={getCanvasEdgeData(selectedEdge.data).markerStart}
                    onCheckedChange={(checked) => updateSelectedEdgeMarkerStart(checked === true)}
                  />
                </label>
                <label className="flex items-center justify-between gap-3 rounded-xl border border-border/60 bg-card/45 px-3 py-2 text-xs">
                  <span>
                    <span className="block font-medium text-foreground">End arrow</span>
                    <span className="block text-muted-foreground">Show an arrowhead at the target.</span>
                  </span>
                  <Checkbox
                    checked={getCanvasEdgeData(selectedEdge.data).markerEnd}
                    onCheckedChange={(checked) => updateSelectedEdgeMarkerEnd(checked === true)}
                  />
                </label>
              </div>
              <Button size="sm" variant="outline" className="gap-2 self-start" onClick={deleteSelection}>
                <Trash2 size={14} />
                Delete selected
              </Button>
            </>
          ) : (
            <div className="text-xs text-muted-foreground/75">
              Select a line to rename or delete it.
            </div>
          )}
        </Panel>
      </ReactFlow>
      </div>
    </div>
  );
}

export default function CanvasPage({ relativePath }: { relativePath: string | null }) {
  return (
    <ReactFlowProvider>
      <CanvasBoard relativePath={relativePath} />
    </ReactFlowProvider>
  );
}
