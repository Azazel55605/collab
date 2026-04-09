import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import '@xyflow/react/dist/style.css';
import {
  ReactFlow,
  addEdge,
  applyNodeChanges,
  Background,
  BackgroundVariant,
  Handle,
  MarkerType,
  NodeResizer,
  Panel,
  Position,
  ReactFlowProvider,
  reconnectEdge,
  useEdgesState,
  useNodesState,
  useReactFlow,
  type Connection,
  type Edge as FlowEdge,
  type EdgeChange,
  type Node as FlowNode,
  type NodeChange,
  type OnReconnect,
  type Viewport,
} from '@xyflow/react';
import {
  FileImage,
  FileText,
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
import {
  DocumentTopBar,
  documentTopBarGroupClass,
  getDocumentBaseName,
  getDocumentFolderPath,
} from '../components/layout/DocumentTopBar';
import { cn } from '../lib/utils';
import { tauriCommands } from '../lib/tauri';
import { useEditorStore } from '../store/editorStore';
import { useUiStore } from '../store/uiStore';
import { useVaultStore } from '../store/vaultStore';
import type {
  CanvasData,
  CanvasEdge,
  CanvasNode,
  FileCanvasNode,
  NoteCanvasNode,
  TextCanvasNode,
} from '../types/canvas';
import type { NoteFile } from '../types/vault';

const SAVE_DEBOUNCE_MS = 600;
const CANVAS_GRID = 24;
const DEFAULT_NODE_SIZE = { width: 300, height: 180 };
const DEFAULT_TEXT_NODE_SIZE = { width: 280, height: 160 };
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
  markdownContent?: string;
  loading?: boolean;
  loaded?: boolean;
}

interface CanvasNodeData extends Record<string, unknown> {
  title: string;
  subtitle?: string;
  excerpt?: string;
  imageSrc?: string | null;
  markdownContent?: string;
  relativePath?: string;
  extension?: string;
  content?: string;
  onOpen?: (path: string) => void;
  onTextChange?: (nodeId: string, content: string) => void;
  onWikilinkClick?: (path: string) => void;
  onSnapToGrid?: (nodeId: string) => void;
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

function hasRelativePath(node: CanvasNode): node is Extract<CanvasNode, { relativePath: string }> {
  return 'relativePath' in node;
}

function toFlowNode(
  node: CanvasNode,
  preview: PreviewState | undefined,
  callbacks: Pick<CanvasNodeData, 'onOpen' | 'onTextChange' | 'onSnapToGrid'>,
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

function fromFlowEdge(edge: FlowEdge<{ label?: string }>): CanvasEdge {
  return {
    id: edge.id,
    source: edge.source,
    target: edge.target,
    label: typeof edge.data?.label === 'string' ? edge.data.label : undefined,
  };
}

function toFlowEdge(edge: CanvasEdge): FlowEdge<{ label?: string }> {
  return {
    id: edge.id,
    source: edge.source,
    target: edge.target,
    label: edge.label,
    data: { label: edge.label },
    markerEnd: { type: MarkerType.ArrowClosed, width: 18, height: 18 },
    style: {
      strokeWidth: 2,
      stroke: 'color-mix(in oklch, var(--primary) 78%, white 22%)',
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
        'group flex h-full w-full flex-col overflow-hidden rounded-2xl border bg-card/96 text-card-foreground shadow-lg backdrop-blur-xs-webkit transition-[transform,width,height,box-shadow,border-color] app-motion-fast',
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
  return (
    <>
      <Handle
        type="target"
        position={Position.Left}
        className="!h-3 !w-3 !border-2 !border-background !bg-primary/90"
      />
      <Handle
        type="source"
        position={Position.Right}
        className="!h-3 !w-3 !border-2 !border-background !bg-primary/90"
      />
    </>
  );
}

function NoteCardNode({ id, data, selected }: { id: string; data: CanvasNodeData; selected?: boolean }) {
  return (
    <>
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
    </>
  );
}

function FileCardNode({ id, data, selected }: { id: string; data: CanvasNodeData; selected?: boolean }) {
  const isImage = !!data.imageSrc;

  return (
    <>
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
    </>
  );
}

function TextCardNode({ id, data, selected }: { id: string; data: CanvasNodeData; selected?: boolean }) {
  return (
    <>
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
    </>
  );
}

const nodeTypes = {
  noteCard: NoteCardNode,
  fileCard: FileCardNode,
  textCard: TextCardNode,
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
  const { setActiveView } = useUiStore();
  const reactFlow = useReactFlow<FlowNode<CanvasNodeData>, FlowEdge<{ label?: string }>>();
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const hashRef = useRef<string | undefined>(undefined);
  const lastWriteRef = useRef(0);
  const isMountedRef = useRef(true);
  const skipNextSaveRef = useRef(true);
  const pendingViewportRef = useRef<Viewport | null>(null);
  const loadingPreviewPathsRef = useRef(new Set<string>());
  const [nodes, setNodes] = useNodesState<FlowNode<CanvasNodeData>>([]);
  const [edges, setEdges, onEdgesChangeBase] = useEdgesState<FlowEdge<{ label?: string }>>([]);
  const [viewport, setViewport] = useState(EMPTY_CANVAS.viewport);
  const [pickerMode, setPickerMode] = useState<PickerMode>(null);
  const [edgeLabelDraft, setEdgeLabelDraft] = useState('');
  const [previews, setPreviews] = useState<Record<string, PreviewState>>({});
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

  const hydratePreview = useCallback(async (node: Extract<CanvasNode, { relativePath: string }>) => {
    if (!vault) return;
    const path = node.relativePath;
    if (loadingPreviewPathsRef.current.has(path)) return;

    loadingPreviewPathsRef.current.add(path);
    setPreviews((prev) => ({
      ...prev,
      [path]: { ...(prev[path] ?? {}), loading: true },
    }));

    try {
      const extension = path.split('.').pop()?.toLowerCase() ?? '';
      let nextPreview: PreviewState = {};

      if (node.type === 'file' && isImageExtension(extension)) {
        nextPreview = { imageSrc: await tauriCommands.readNoteAssetDataUrl(vault.path, path) };
      } else if (node.type === 'note') {
        const { content } = await tauriCommands.readNote(vault.path, path);
        nextPreview = { excerpt: cleanPreviewText(content), markdownContent: content };
      } else if (canPreviewText(extension)) {
        const { content } = await tauriCommands.readNote(vault.path, path);
        nextPreview = { excerpt: cleanPreviewText(content) };
      }

      const resolvedPreview: PreviewState = { ...nextPreview, loading: false, loaded: true };
      if (!isMountedRef.current) return;

      setPreviews((prev) => ({
        ...prev,
        [path]: resolvedPreview,
      }));
      setNodes((prev) =>
        prev.map((flowNode) => {
          if (flowNode.data.relativePath !== path) return flowNode;
          return {
            ...flowNode,
            data: {
              ...flowNode.data,
              ...buildNodePreviewState(fromFlowNode(flowNode) as Extract<CanvasNode, { relativePath: string }>, resolvedPreview),
              onOpen: openRelativePath,
              onWikilinkClick: openRelativePath,
            },
          };
        }),
      );
    } catch {
      if (!isMountedRef.current) return;
      setPreviews((prev) => ({
        ...prev,
        [path]: { ...(prev[path] ?? {}), loading: false, loaded: true },
      }));
    } finally {
      loadingPreviewPathsRef.current.delete(path);
    }
  }, [openRelativePath, setNodes, vault]);

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
      setViewport(canvas.viewport ?? EMPTY_CANVAS.viewport);
      setNodes(canvas.nodes.map((node) => toFlowNode(node, undefined, {
        onOpen: openRelativePath,
        onTextChange: updateTextContent,
        onSnapToGrid: snapNodeToGrid,
      })));
      setEdges(canvas.edges.map(toFlowEdge));
      pendingViewportRef.current = canvas.viewport ?? EMPTY_CANVAS.viewport;
      setLoadRevision((prev) => prev + 1);
    } catch {}
  }, [openRelativePath, relativePath, setEdges, setNodes, snapNodeToGrid, updateTextContent, vault]);

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
    if (!vault) return;
    for (const flowNode of nodes) {
      if ((flowNode.type !== 'noteCard' && flowNode.type !== 'fileCard') || !flowNode.data.relativePath) continue;
      const existing = previews[flowNode.data.relativePath];
      if (existing?.loading || existing?.loaded) continue;
      void hydratePreview(fromFlowNode(flowNode) as Extract<CanvasNode, { relativePath: string }>);
    }
  }, [hydratePreview, nodes, previews, vault]);

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
    const preview = hasRelativePath(node) ? previews[node.relativePath] : undefined;
    setNodes((prev) => [...prev, toFlowNode({
      ...node,
      position: snapPosition(node.position),
      width: snapSize(node.width, node.type === 'text' ? 200 : 220),
      height: snapSize(node.height, node.type === 'text' ? 120 : 140),
    }, preview, {
      onOpen: openRelativePath,
      onTextChange: updateTextContent,
      onSnapToGrid: snapNodeToGrid,
    })]);
  }, [openRelativePath, previews, setNodes, snapNodeToGrid, updateTextContent]);

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

  const handleConnect = useCallback((connection: Connection) => {
    setEdges((prev) =>
      addEdge(
        {
          ...connection,
          id: crypto.randomUUID(),
          data: { label: '' },
          label: '',
          markerEnd: { type: MarkerType.ArrowClosed, width: 18, height: 18 },
          style: { strokeWidth: 2, stroke: 'color-mix(in oklch, var(--primary) 78%, white 22%)' },
        },
        prev,
      ),
    );
  }, [setEdges]);

  const handleReconnect = useCallback<OnReconnect<FlowEdge<{ label?: string }>>>((oldEdge, newConnection) => {
    setEdges((prev) => reconnectEdge(oldEdge, newConnection, prev));
  }, [setEdges]);

  const onNodesChange = useCallback((changes: NodeChange<FlowNode<CanvasNodeData>>[]) => {
    setNodes((prev) => applyNodeChanges(changes, prev));
  }, [setNodes]);

  const onEdgesChange = useCallback((changes: EdgeChange<FlowEdge<{ label?: string }>>[]) => {
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

  const updateSelectedEdgeLabel = useCallback((label: string) => {
    setEdgeLabelDraft(label);
    setEdges((prev) =>
      prev.map((edge) =>
        edge.id === selectedEdge?.id
          ? {
              ...edge,
              label,
              data: { ...(edge.data ?? {}), label },
            }
          : edge,
      ),
    );
  }, [selectedEdge?.id, setEdges]);

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
  }, [addTextNode, adjustZoom, deleteSelection, fitCanvasView, panViewport, pickerMode, resetZoom]);

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

      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onNodeDragStop={(_, node) => snapNodeToGrid(node.id)}
        onConnect={handleConnect}
        onReconnect={handleReconnect}
        onMoveEnd={(_: MouseEvent | TouchEvent | null, nextViewport: Viewport) => setViewport(nextViewport)}
        nodeTypes={nodeTypes}
        deleteKeyCode={['Backspace', 'Delete']}
        nodesDraggable
        elementsSelectable
        nodesConnectable
        edgesReconnectable
        minZoom={0.2}
        maxZoom={2.5}
        proOptions={{ hideAttribution: true }}
        className="canvas-flow"
        defaultEdgeOptions={{
          markerEnd: { type: MarkerType.ArrowClosed, width: 18, height: 18 },
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
