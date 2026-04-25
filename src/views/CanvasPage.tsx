import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import '@xyflow/react/dist/style.css';
import { getDocument, GlobalWorkerOptions } from 'pdfjs-dist';
import {
  ReactFlow,
  addEdge,
  applyNodeChanges,
  Background,
  BackgroundVariant,
  Panel,
  ReactFlowProvider,
  reconnectEdge,
  useEdgesState,
  useNodesState,
  useReactFlow,
  type Connection,
  type EdgeChange,
  type Node as FlowNode,
  type NodeChange,
  type OnReconnect,
  type Viewport,
} from '@xyflow/react';
import {
  Layout,
} from 'lucide-react';
import { nodeTypes, type CanvasNodeData } from '../components/canvas/CanvasNodeTypes';
import {
  DEFAULT_CANVAS_EDGE_STYLE,
  edgeTypes,
  fromFlowEdge,
  getCanvasEdgeData,
  StackedConnectionLine,
  toFlowEdge,
  type CanvasFlowEdge,
} from '../components/canvas/CanvasEdgeTypes';
import { CanvasEdgeInspector } from '../components/canvas/CanvasEdgeInspector';
import { fromFlowNode, toFlowNode } from '../components/canvas/CanvasFlowNodeUtils';
import { useCanvasDocumentSession } from '../components/canvas/useCanvasDocumentSession';
import { CanvasToolbar } from '../components/canvas/CanvasToolbar';
import { CanvasPickerDialog, type CanvasPickerMode } from '../components/canvas/CanvasPickerDialog';
import { useCanvasNodeCommands } from '../components/canvas/useCanvasNodeCommands';
import { useCanvasPreviews } from '../components/canvas/useCanvasPreviews';
import { useCanvasViewportControls } from '../components/canvas/useCanvasViewportControls';
import {
  getBaseName,
  getPreviewKey,
  isImageExtension,
} from '../components/canvas/CanvasPreviewUtils';
import {
  DocumentTopBar,
  getDocumentBaseName,
  getDocumentFolderPath,
} from '../components/layout/DocumentTopBar';
import { useEditorStore } from '../store/editorStore';
import { useUiStore } from '../store/uiStore';
import { useVaultStore } from '../store/vaultStore';
import { useCollabStore } from '../store/collabStore';
import type {
  CanvasData,
  CanvasEdge,
  CanvasEdgeLineStyle,
  CanvasNode,
} from '../types/canvas';
import type { NoteFile } from '../types/vault';
import { useDocumentSessionState } from '../lib/documentSession';

const pdfWorkerUrl = new URL('pdfjs-dist/build/pdf.worker.mjs', import.meta.url).toString();
GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

const CANVAS_GRID = 24;
const EMPTY_CANVAS: CanvasData = {
  nodes: [],
  edges: [],
  viewport: { x: 0, y: 0, zoom: 1 },
};
function flattenFiles(nodes: NoteFile[]): NoteFile[] {
  return nodes.flatMap((node) => [node, ...(node.children ? flattenFiles(node.children) : [])]);
}

function getNameWithoutExtension(name: string): string {
  return name.replace(/\.[^.]+$/, '');
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


function CanvasBoard({ relativePath }: { relativePath: string | null }) {
  const { vault, fileTree } = useVaultStore();
  const { openTab, markDirty, markSaved, setSavedHash } = useEditorStore();
  const { addConflict, myUserId, myUserName } = useCollabStore();
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
  const isMountedRef = useRef(true);
  const isDirtyRef = useRef(false);
  const [nodes, setNodes] = useNodesState<FlowNode<CanvasNodeData>>([]);
  const [edges, setEdges, onEdgesChangeBase] = useEdgesState<CanvasFlowEdge>([]);
  const [viewport, setViewport] = useState(EMPTY_CANVAS.viewport);
  const [pickerMode, setPickerMode] = useState<CanvasPickerMode>(null);
  const [edgeLabelDraft, setEdgeLabelDraft] = useState('');
  const { hashRef, lastWriteRef, markLoaded, shouldSkipAutosave, markWriteStarted, shouldCreateSnapshot } = useDocumentSessionState();

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

  const {
    openExternalUrl,
    previews,
    requestWebPreview,
    resetPreviewState,
    updateWebDisplayModeOverride,
    updateWebUrl,
  } = useCanvasPreviews({
    vault,
    nodes,
    setNodes,
    isMountedRef,
    fromFlowNode,
    renderPdfPreview,
    openRelativePath,
    canvasWebCardDefaultMode,
    canvasWebCardAutoLoad,
    webPreviewsEnabled,
    hoverWebLinkPreviewsEnabled,
    backgroundWebPreviewPrefetchEnabled,
  });

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

  const buildFlowNodes = useCallback((canvas: CanvasData) => (
    canvas.nodes.map((node) => toFlowNode(node, undefined, {
      onOpen: openRelativePath,
      onTextChange: updateTextContent,
      onSnapToGrid: snapNodeToGrid,
      onWebUrlChange: updateWebUrl,
      onWebDisplayModeOverrideChange: updateWebDisplayModeOverride,
      onRequestWebPreview: requestWebPreview,
      onOpenUrl: openExternalUrl,
    }, canvasWebCardDefaultMode, canvasWebCardAutoLoad, webPreviewsEnabled))
  ), [
    canvasWebCardAutoLoad,
    canvasWebCardDefaultMode,
    openExternalUrl,
    openRelativePath,
    requestWebPreview,
    snapNodeToGrid,
    updateTextContent,
    updateWebDisplayModeOverride,
    updateWebUrl,
    webPreviewsEnabled,
  ]);

  useCanvasDocumentSession({
    reactFlow,
    vault,
    relativePath,
    nodes,
    edges,
    viewport,
    setViewport,
    setNodes,
    setEdges,
    buildFlowNode: buildFlowNodes,
    toFlowEdge,
    fromFlowNode,
    fromFlowEdge,
    resetPreviewState,
    markDirty,
    markSaved,
    setSavedHash,
    addConflict,
    myUserId,
    myUserName,
    isMountedRef,
    isDirtyRef,
    hashRef,
    lastWriteRef,
    markLoaded,
    shouldSkipAutosave,
    markWriteStarted,
    shouldCreateSnapshot,
  });

  useEffect(() => {
    setEdgeLabelDraft(selectedEdge?.data?.label ?? '');
  }, [selectedEdge?.id]);

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

  const {
    addTextNode,
    addWebNode,
    handleDropOnCanvas,
    handlePickerSelect,
  } = useCanvasNodeCommands({
    reactFlow,
    viewportRef,
    pickerMode,
    setPickerMode,
    allFiles,
    addCanvasNode,
  });

  const handleConnect = useCallback((connection: Connection) => {
    setEdges((prev) =>
      addEdge(
        toFlowEdge({
          ...connection,
          id: crypto.randomUUID(),
          label: undefined,
          lineStyle: 'solid',
          animated: false,
          animationReverse: false,
          markerStart: false,
          markerEnd: false,
        }),
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

  const deleteSelection = useCallback(() => {
    setNodes((prev) => prev.filter((node) => !node.selected));
    setEdges((prev) => prev.filter((edge) => !edge.selected));
  }, [setEdges, setNodes]);

  const {
    adjustZoom,
    fitCanvasView,
    resetZoom,
  } = useCanvasViewportControls({
    reactFlow,
    viewport,
    setViewport,
    pickerMode,
    setPickerMode,
    addTextNode,
    addWebNode,
    deleteSelection,
  });

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
          <CanvasToolbar
            zoomLabel={zoomLabel}
            onAddNote={() => setPickerMode('note')}
            onAddFile={() => setPickerMode('file')}
            onAddText={addTextNode}
            onAddWeb={addWebNode}
            onZoomOut={() => adjustZoom(-1)}
            onResetZoom={resetZoom}
            onZoomIn={() => adjustZoom(1)}
            onFitView={fitCanvasView}
          />
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
            ...DEFAULT_CANVAS_EDGE_STYLE,
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
        <Panel position="top-right">
          <CanvasEdgeInspector
            selectedEdgeData={selectedEdge ? getCanvasEdgeData(selectedEdge.data) : null}
            edgeLabelDraft={edgeLabelDraft}
            onEdgeLabelChange={updateSelectedEdgeLabel}
            onLineStyleChange={updateSelectedEdgeLineStyle}
            onAnimationDirectionChange={updateSelectedEdgeAnimationDirection}
            onAnimationChange={updateSelectedEdgeAnimation}
            onMarkerStartChange={updateSelectedEdgeMarkerStart}
            onMarkerEndChange={updateSelectedEdgeMarkerEnd}
            onDeleteSelected={deleteSelection}
          />
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
