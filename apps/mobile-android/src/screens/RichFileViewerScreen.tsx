import {
  Activity,
  ArrowLeft,
  Calendar,
  CheckCircle2,
  ChartLine,
  CircuitBoard,
  CircleDot,
  Diamond,
  FileImage,
  FileText,
  FileWarning,
  Globe,
  ImageIcon,
  Info,
  Layout,
  LayoutDashboard,
  Link2,
  Milestone,
  Minus,
  PencilLine,
  Play,
  Plus,
  Route,
  RotateCcw,
  SquareDashedKanban,
  Users,
  X,
  Zap,
} from 'lucide-react';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type Dispatch,
  type RefObject,
  type SetStateAction,
  type TouchEvent,
  type WheelEvent,
} from 'react';
import { getSmoothStepPath } from '@xyflow/react';
import { getDocument, GlobalWorkerOptions, type PDFDocumentProxy, type RenderTask } from 'pdfjs-dist/legacy/build/pdf.mjs';

import { Banner, EmptyState, Spinner } from '../components/ui';
import { isCanvasFile, readCanvasDocument, type CanvasData, type CanvasEdge, type CanvasNode } from '../lib/canvas';
import { isLogicFile, readLogicDocument, type LogicDiagramDocument } from '../lib/logic';
import {
  isImageFile,
  isPdfFile,
  readMobileAssetDataUrl,
  uint8ArrayFromDataUrlChunked,
} from '../lib/assets';
import { calculateMobilePdfPageSize, type MobilePdfPageSize } from '../lib/pdf';
import {
  evaluateLogicDiagram,
  getLogicInputHandles,
  getLogicOutputHandles,
  type LogicSignal,
} from '../../../../src/components/logic/logicDiagramEvaluator';
import {
  isElectronicComponentKind,
  type LogicDiagramNode,
  type SchematicSymbolSet,
} from '../../../../src/types/logicDiagram';
import {
  getSchematicTerminals,
  schematicSymbolDimensions,
  schematicSymbolMarkup,
  schematicSymbolTransform,
  schematicSymbolViewBox,
  schematicTerminalPoint,
  schematicTerminalSide,
} from '../../../../src/components/logic/schematicSymbols';
import type { HostedFileEntry } from '../mobileTauri';
import {
  circuitCancelJob,
  circuitDiscardJob,
  circuitJobStatus,
  circuitReadSweepChunk,
  circuitReadTransientChunk,
  circuitStartDc,
  circuitStartDcSweep,
  circuitStartTransient,
  circuitTakeJobResult,
  type CircuitDcResult,
  type CircuitJobStatus,
  type CircuitSweepResult,
  type CircuitTransientResult,
} from '../mobileTauri';
import { useMobileStore } from '../state/store';
import { runCircuitJob, type CircuitJobClient } from '../../../../src/lib/circuitJobRunner';
import { runCircuitSweepJob, type CircuitSweepJobClient } from '../../../../src/lib/circuitSweepRunner';
import { runCircuitTransientJob, type CircuitTransientJobClient } from '../../../../src/lib/circuitTransientRunner';
import { circuitErrorText } from '../../../../src/lib/circuitErrorText';
import { CircuitSweepPlot, CircuitTransientPlot } from '../../../../src/components/logic/CircuitSweepPlot';

const workerUrl = new URL('pdfjs-dist/legacy/build/pdf.worker.mjs', import.meta.url).toString();
GlobalWorkerOptions.workerSrc = workerUrl;
const MOBILE_CIRCUIT_JOB_CLIENT: CircuitJobClient = {
  start: circuitStartDc,
  status: circuitJobStatus,
  takeResult: circuitTakeJobResult,
};
const MOBILE_SWEEP_JOB_CLIENT: CircuitSweepJobClient = {
  start: circuitStartDcSweep,
  status: circuitJobStatus,
  takeResult: circuitTakeJobResult,
  readChunk: circuitReadSweepChunk,
  discard: circuitDiscardJob,
};
const MOBILE_TRANSIENT_JOB_CLIENT: CircuitTransientJobClient = {
  start: circuitStartTransient,
  status: circuitJobStatus,
  takeResult: circuitTakeJobResult,
  readChunk: circuitReadTransientChunk,
  discard: circuitDiscardJob,
};
const ANALOG_ACTIVE_VOLTAGE = 1e-9;

type LoadState =
  | { status: 'loading' }
  | { status: 'ready'; dataUrl?: string; canvas?: CanvasData; logic?: LogicDiagramDocument; source: 'network' | 'cache' }
  | { status: 'error'; message: string };
type PdfLayoutMode = 'single' | 'scroll';
type TouchPoint = { x: number; y: number };
type CanvasWorldBounds = {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  width: number;
  height: number;
  centerX: number;
  centerY: number;
};

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function statusForFile(file: HostedFileEntry, state: LoadState): string {
  if (state.status === 'ready') {
    return state.source === 'cache' ? 'Cached viewer' : 'Viewer';
  }
  if (isPdfFile(file)) return 'PDF viewer';
  if (isImageFile(file)) return 'Image viewer';
  if (isCanvasFile(file)) return 'Canvas viewer';
  if (isLogicFile(file)) return 'Logic viewer';
  return 'Viewer';
}

export function RichFileViewerScreen({
  file,
  schematicSymbolSet = 'ansi',
}: {
  file: HostedFileEntry;
  schematicSymbolSet?: SchematicSymbolSet;
}) {
  const selected = useMobileStore((s) => s.selected);
  const statuses = useMobileStore((s) => s.statuses);
  const closeSheet = useMobileStore((s) => s.closeSheet);
  const connected = selected ? !!statuses[selected.serverUrl]?.connected : false;
  const [loadState, setLoadState] = useState<LoadState>({ status: 'loading' });
  const [zoom, setZoom] = useState(1);
  const [resetToken, setResetToken] = useState(0);
  const image = isImageFile(file);
  const pdf = isPdfFile(file);
  const canvas = isCanvasFile(file);
  const logic = isLogicFile(file);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      if (!selected) return;
      setLoadState({ status: 'loading' });
      setZoom(1);
      try {
        if (canvas) {
          const result = await readCanvasDocument(selected.serverUrl, selected.vault.id, file, connected);
          if (!cancelled) setLoadState({ status: 'ready', canvas: result.canvas, source: result.source });
        } else if (logic) {
          const result = await readLogicDocument(selected.serverUrl, selected.vault.id, file, connected);
          if (!cancelled) setLoadState({ status: 'ready', logic: result.logic, source: result.source });
        } else {
          const result = await readMobileAssetDataUrl({
            serverUrl: selected.serverUrl,
            vaultId: selected.vault.id,
            file,
            connected,
          });
          if (!cancelled) setLoadState({ status: 'ready', ...result });
        }
      } catch (reason) {
        if (!cancelled) {
          setLoadState({
            status: 'error',
            message: reason instanceof Error ? reason.message : String(reason),
          });
        }
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [canvas, connected, file, logic, selected]);

  function adjustZoom(delta: number) {
    setZoom((value) => clamp(Number((value + delta).toFixed(2)), 0.35, 4));
  }

  function resetZoom() {
    setZoom(1);
    setResetToken((value) => value + 1);
  }

  function handleWheel(event: WheelEvent<HTMLElement>) {
    if (!event.ctrlKey) return;
    event.preventDefault();
    adjustZoom(event.deltaY > 0 ? -0.12 : 0.12);
  }

  return (
    <div className="screen rich-viewer-screen">
      <header className="note-header">
        <button type="button" className="icon-button" aria-label="Back" onClick={closeSheet}>
          <ArrowLeft size={18} aria-hidden />
        </button>
        <div className="note-title">
          <h1 className="truncate">{file.name}</h1>
          <p>{statusForFile(file, loadState)}</p>
        </div>
        <div className="viewer-controls">
          <button type="button" className="icon-button" aria-label="Zoom out" onClick={() => adjustZoom(-0.2)}>
            <Minus size={16} aria-hidden />
          </button>
          <button type="button" className="icon-button" aria-label="Reset zoom" onClick={resetZoom}>
            <RotateCcw size={16} aria-hidden />
          </button>
          <button type="button" className="icon-button" aria-label="Zoom in" onClick={() => adjustZoom(0.2)}>
            <Plus size={16} aria-hidden />
          </button>
        </div>
      </header>

      {loadState.status === 'ready' && loadState.source === 'cache' ? (
        <Banner tone="info">Showing cached content. The server copy was not reachable.</Banner>
      ) : null}

      {loadState.status === 'loading' ? (
        <div className="loading-block">
          <Spinner size={22} />
          <span>Loading file...</span>
        </div>
      ) : loadState.status === 'error' ? (
        <EmptyState
          icon={<FileWarning size={28} aria-hidden />}
          title="Could not open file"
          message={loadState.message}
        />
      ) : image && loadState.dataUrl ? (
        <ImageMobileViewer
          dataUrl={loadState.dataUrl}
          name={file.name}
          zoom={zoom}
          setZoom={setZoom}
          resetToken={resetToken}
          onWheel={handleWheel}
        />
      ) : pdf && loadState.dataUrl ? (
        <PdfMobileViewer file={file} dataUrl={loadState.dataUrl} zoom={zoom} setZoom={setZoom} />
      ) : canvas && loadState.canvas ? (
        <CanvasMobileViewer
          canvas={loadState.canvas}
          zoom={zoom}
          setZoom={setZoom}
          resetToken={resetToken}
          onWheel={handleWheel}
        />
      ) : logic && loadState.logic ? (
        <LogicMobileViewer
          logic={loadState.logic}
          zoom={zoom}
          setZoom={setZoom}
          resetToken={resetToken}
          onWheel={handleWheel}
          schematicSymbolSet={schematicSymbolSet}
        />
      ) : (
        <EmptyState
          icon={<ImageIcon size={28} aria-hidden />}
          title="Unsupported viewer"
          message="This file type does not have a mobile viewer yet."
        />
      )}
    </div>
  );
}

function touchPoint(touch: Pick<globalThis.Touch, 'clientX' | 'clientY'>): TouchPoint {
  return { x: touch.clientX, y: touch.clientY };
}

function distanceBetween(first: TouchPoint, second: TouchPoint): number {
  return Math.hypot(first.x - second.x, first.y - second.y);
}

function midpoint(first: TouchPoint, second: TouchPoint): TouchPoint {
  return { x: (first.x + second.x) / 2, y: (first.y + second.y) / 2 };
}

function ImageMobileViewer({
  dataUrl,
  name,
  zoom,
  setZoom,
  resetToken,
  onWheel,
}: {
  dataUrl: string;
  name: string;
  zoom: number;
  setZoom: Dispatch<SetStateAction<number>>;
  resetToken: number;
  onWheel: (event: WheelEvent<HTMLElement>) => void;
}) {
  const stageRef = useRef<HTMLElement | null>(null);
  const dragRef = useRef<TouchPoint | null>(null);
  const pinchRef = useRef<{ distance: number; center: TouchPoint } | null>(null);
  const [pan, setPan] = useState<TouchPoint>({ x: 0, y: 0 });

  useEffect(() => {
    setPan({ x: 0, y: 0 });
  }, [dataUrl, resetToken]);

  useEffect(() => {
    if (zoom <= 1) setPan({ x: 0, y: 0 });
  }, [zoom]);

  function clampPan(next: TouchPoint, nextZoom = zoom): TouchPoint {
    const stage = stageRef.current;
    if (!stage || nextZoom <= 1) return { x: 0, y: 0 };
    const limitX = Math.max(0, (stage.clientWidth * (nextZoom - 1)) / 2);
    const limitY = Math.max(0, (stage.clientHeight * (nextZoom - 1)) / 2);
    return {
      x: clamp(next.x, -limitX, limitX),
      y: clamp(next.y, -limitY, limitY),
    };
  }

  function handleTouchStart(event: TouchEvent<HTMLElement>) {
    if (event.touches.length === 1) {
      dragRef.current = touchPoint(event.touches[0]);
      pinchRef.current = null;
      return;
    }
    if (event.touches.length === 2) {
      const first = touchPoint(event.touches[0]);
      const second = touchPoint(event.touches[1]);
      dragRef.current = null;
      pinchRef.current = { distance: distanceBetween(first, second), center: midpoint(first, second) };
    }
  }

  function handleTouchMove(event: TouchEvent<HTMLElement>) {
    if (event.touches.length === 2 && pinchRef.current) {
      event.preventDefault();
      const first = touchPoint(event.touches[0]);
      const second = touchPoint(event.touches[1]);
      const center = midpoint(first, second);
      const currentDistance = distanceBetween(first, second);
      const previous = pinchRef.current;
      const ratio = currentDistance / Math.max(1, previous.distance);
      pinchRef.current = { distance: currentDistance, center };
      setZoom((value) => {
        const nextZoom = clamp(Number((value * ratio).toFixed(3)), 0.5, 5);
        setPan((current) =>
          clampPan(
            {
              x: current.x + center.x - previous.center.x,
              y: current.y + center.y - previous.center.y,
            },
            nextZoom,
          ),
        );
        return nextZoom;
      });
      return;
    }

    if (event.touches.length === 1 && dragRef.current && zoom > 1) {
      event.preventDefault();
      const current = touchPoint(event.touches[0]);
      const previous = dragRef.current;
      dragRef.current = current;
      setPan((value) => clampPan({ x: value.x + current.x - previous.x, y: value.y + current.y - previous.y }));
    }
  }

  function handleTouchEnd(event: TouchEvent<HTMLElement>) {
    if (event.touches.length === 1) {
      dragRef.current = touchPoint(event.touches[0]);
      pinchRef.current = null;
      return;
    }
    dragRef.current = null;
    pinchRef.current = null;
  }

  const style = {
    '--viewer-zoom': zoom,
    '--viewer-pan-x': `${pan.x}px`,
    '--viewer-pan-y': `${pan.y}px`,
  } as CSSProperties;

  return (
    <section
      ref={stageRef}
      className="viewer-stage image-stage"
      style={style}
      onTouchStart={handleTouchStart}
      onTouchMove={handleTouchMove}
      onTouchEnd={handleTouchEnd}
      onTouchCancel={handleTouchEnd}
      onWheel={onWheel}
    >
      <img src={dataUrl} alt={name} draggable={false} />
    </section>
  );
}

function canvasNodeTitle(node: CanvasNode): string {
  const record = node as unknown as Record<string, unknown>;
  if (typeof record.title === 'string' && record.title.trim()) return record.title;
  if (typeof record.relativePath === 'string' && record.relativePath.trim()) return record.relativePath.split('/').pop() ?? record.relativePath;
  if (typeof record.url === 'string' && record.url.trim()) return record.url;
  if (typeof record.content === 'string' && record.content.trim()) return record.content.trim().split('\n')[0] ?? 'Text';
  if (typeof record.glyph === 'string' && record.glyph.trim()) return record.glyph;
  return `${node.type[0]?.toUpperCase() ?? 'N'}${node.type.slice(1)} node`;
}

function canvasNodeSubtitle(node: CanvasNode): string | null {
  const record = node as unknown as Record<string, unknown>;
  if (typeof record.relativePath === 'string' && record.relativePath.trim()) return record.relativePath;
  if (typeof record.linkedRelativePath === 'string' && record.linkedRelativePath.trim()) return record.linkedRelativePath;
  if (typeof record.url === 'string' && record.url.trim()) return record.url;
  if (typeof record.iconLabel === 'string' && record.iconLabel.trim()) return record.iconLabel;
  return null;
}

function canvasNodeBody(node: CanvasNode): string | null {
  const record = node as unknown as Record<string, unknown>;
  for (const key of ['description', 'body', 'content']) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}

const PLANNING_NODE_LABELS: Record<string, string> = {
  process: 'Process',
  decision: 'Decision',
  terminator: 'Start / End',
  document: 'Document',
  milestone: 'Milestone',
  actor: 'Actor',
  group: 'Group',
  swimlane: 'Swimlane',
  junction: 'Junction',
  crossing: 'Crossing',
};

function canvasNodeKindLabel(node: CanvasNode): string {
  if (node.type === 'note') return 'Note';
  if (node.type === 'file') return 'File';
  if (node.type === 'text') return 'Canvas note';
  if (node.type === 'web') return 'Website';
  if (node.type === 'symbol') return 'Nerd Font icon';
  return PLANNING_NODE_LABELS[node.type] ?? node.type;
}

function canvasRecord(node: CanvasNode): Record<string, unknown> {
  return node as unknown as Record<string, unknown>;
}

function canvasString(node: CanvasNode, key: string): string | null {
  const value = canvasRecord(node)[key];
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function fileExtensionFromPath(path: string | null): string {
  if (!path) return 'file';
  const clean = path.split(/[?#]/)[0] ?? path;
  const dot = clean.lastIndexOf('.');
  return dot > -1 ? clean.slice(dot + 1).toLowerCase() : 'file';
}

function planningIcon(node: CanvasNode) {
  switch (node.type) {
    case 'process':
      return <Route size={14} aria-hidden />;
    case 'decision':
      return <Diamond size={14} aria-hidden />;
    case 'terminator':
      return <CheckCircle2 size={14} aria-hidden />;
    case 'document':
      return <FileText size={14} aria-hidden />;
    case 'milestone':
      return <Milestone size={14} aria-hidden />;
    case 'actor':
      return <Users size={14} aria-hidden />;
    case 'group':
      return <SquareDashedKanban size={14} aria-hidden />;
    case 'swimlane':
      return <Layout size={14} aria-hidden />;
    case 'junction':
      return <CircleDot size={12} aria-hidden />;
    case 'crossing':
      return <Route size={14} aria-hidden />;
    default:
      return <Route size={14} aria-hidden />;
  }
}

function canvasNodeIcon(node: CanvasNode) {
  if (node.type === 'note') return <FileText size={14} aria-hidden />;
  if (node.type === 'text') return <PencilLine size={14} aria-hidden />;
  if (node.type === 'web') return <Globe size={14} aria-hidden />;
  if (node.type === 'file') {
    const ext = fileExtensionFromPath(canvasString(node, 'relativePath'));
    if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico', 'avif'].includes(ext)) {
      return <FileImage size={14} aria-hidden />;
    }
    if (ext === 'canvas') return <Layout size={14} aria-hidden />;
    if (ext === 'kanban') return <LayoutDashboard size={14} aria-hidden />;
    return <FileText size={14} aria-hidden />;
  }
  return planningIcon(node);
}

function planningBadges(node: CanvasNode): Array<{ key: string; label: string; tone?: string }> {
  const planning = asCanvasRecord(canvasRecord(node).planning);
  if (!planning) return [];
  const tags = Array.isArray(planning.tags)
    ? planning.tags.filter((tag): tag is string => typeof tag === 'string' && tag.trim().length > 0)
    : [];
  return [
    typeof planning.status === 'string' ? { key: 'status', label: planning.status.replace(/_/g, ' ') } : null,
    typeof planning.priority === 'string' ? { key: 'priority', label: planning.priority, tone: planning.priority } : null,
    typeof planning.ownerLabel === 'string' ? { key: 'owner', label: planning.ownerLabel } : null,
    typeof planning.dueDate === 'string' ? { key: 'due', label: planning.dueDate } : null,
    ...tags.slice(0, 3).map((tag) => ({ key: `tag-${tag}`, label: `#${tag}` })),
  ].filter((badge): badge is { key: string; label: string; tone?: string } => !!badge);
}

function minimumCanvasNodeSize(type: CanvasNode['type']): { width: number; height: number } {
  switch (type) {
    case 'text':
      return { width: 200, height: 120 };
    case 'web':
      return { width: 260, height: 180 };
    case 'symbol':
      return { width: 140, height: 140 };
    case 'process':
      return { width: 220, height: 130 };
    case 'decision':
      return { width: 240, height: 150 };
    case 'terminator':
      return { width: 210, height: 110 };
    case 'document':
      return { width: 220, height: 140 };
    case 'milestone':
    case 'actor':
      return { width: 220, height: 130 };
    case 'group':
      return { width: 320, height: 220 };
    case 'swimlane':
      return { width: 420, height: 180 };
    case 'junction':
      return { width: 56, height: 56 };
    case 'crossing':
      return { width: 96, height: 64 };
    case 'note':
    case 'file':
    default:
      return { width: 220, height: 140 };
  }
}

function canvasNodeWidth(node: CanvasNode): number {
  return Math.max(node.width, minimumCanvasNodeSize(node.type).width);
}

function canvasNodeHeight(node: CanvasNode): number {
  return Math.max(node.height, minimumCanvasNodeSize(node.type).height);
}

function computeCanvasBounds(nodes: CanvasNode[]): CanvasWorldBounds {
  const emptyWidth = 640;
  const emptyHeight = 420;
  if (nodes.length === 0) {
    return {
      minX: -emptyWidth / 2,
      minY: -emptyHeight / 2,
      maxX: emptyWidth / 2,
      maxY: emptyHeight / 2,
      width: emptyWidth,
      height: emptyHeight,
      centerX: 0,
      centerY: 0,
    };
  }
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const node of nodes) {
    minX = Math.min(minX, node.position.x);
    minY = Math.min(minY, node.position.y);
    maxX = Math.max(maxX, node.position.x + canvasNodeWidth(node));
    maxY = Math.max(maxY, node.position.y + canvasNodeHeight(node));
  }
  const width = Math.max(1, maxX - minX);
  const height = Math.max(1, maxY - minY);
  return {
    minX,
    minY,
    maxX,
    maxY,
    width,
    height,
    centerX: minX + width / 2,
    centerY: minY + height / 2,
  };
}

function mobileCanvasNodeStyle(node: CanvasNode): CSSProperties {
  return {
    left: `${node.position.x}px`,
    top: `${node.position.y}px`,
    width: `${canvasNodeWidth(node)}px`,
    height: `${canvasNodeHeight(node)}px`,
  };
}

type MobileCanvasEdgeRender = {
  id: string;
  path: string;
  label: string;
  labelX: number;
  labelY: number;
  lineStyle: CanvasEdge['lineStyle'];
  animated: boolean;
  animationReverse: boolean;
  markerStart: boolean;
  markerEnd: boolean;
};

type CanvasEdgePosition = 'left' | 'right' | 'top' | 'bottom';
type MobileCanvasNodeGeometry = { centerX: number; centerY: number; width: number; height: number };
type MobileCanvasEdgeGeometry = {
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
};

const MOBILE_CANVAS_EDGE_LANE = 30;
const MOBILE_CANVAS_EDGE_SLOT_SPACING = 18;
const MOBILE_CANVAS_EDGE_SLOT_PADDING = 26;

function mobileCanvasEdgePositionFromHandle(handleId?: string | null): CanvasEdgePosition | null {
  if (!handleId) return null;
  if (handleId.startsWith('left')) return 'left';
  if (handleId.startsWith('right')) return 'right';
  if (handleId.startsWith('top')) return 'top';
  if (handleId.startsWith('bottom')) return 'bottom';
  return null;
}

function isHorizontalCanvasEdgePosition(position: CanvasEdgePosition): boolean {
  return position === 'left' || position === 'right';
}

function mobileCanvasEdgePositionForNodes(
  nodeId: string,
  oppositeId: string,
  nodeGeometry: Map<string, MobileCanvasNodeGeometry>,
  fallback: CanvasEdgePosition,
): CanvasEdgePosition {
  const node = nodeGeometry.get(nodeId);
  const opposite = nodeGeometry.get(oppositeId);
  if (!node || !opposite) return fallback;
  const deltaX = opposite.centerX - node.centerX;
  const deltaY = opposite.centerY - node.centerY;
  if (Math.abs(deltaX) >= Math.abs(deltaY)) return deltaX >= 0 ? 'right' : 'left';
  return deltaY >= 0 ? 'bottom' : 'top';
}

function mobileCanvasEndpointPosition(
  edge: CanvasEdge,
  endpoint: 'source' | 'target',
  nodeGeometry: Map<string, MobileCanvasNodeGeometry>,
): CanvasEdgePosition {
  if (endpoint === 'source') {
    return mobileCanvasEdgePositionFromHandle(edge.sourceHandle)
      ?? mobileCanvasEdgePositionForNodes(edge.source, edge.target, nodeGeometry, 'right');
  }
  return mobileCanvasEdgePositionFromHandle(edge.targetHandle)
    ?? mobileCanvasEdgePositionForNodes(edge.target, edge.source, nodeGeometry, 'left');
}

function mobileCanvasAnchorCoordinates(
  geometry: MobileCanvasNodeGeometry | undefined,
  position: CanvasEdgePosition,
  fallback: TouchPoint,
): TouchPoint {
  if (!geometry) return fallback;
  if (position === 'left') return { x: geometry.centerX - geometry.width / 2, y: geometry.centerY };
  if (position === 'right') return { x: geometry.centerX + geometry.width / 2, y: geometry.centerY };
  if (position === 'top') return { x: geometry.centerX, y: geometry.centerY - geometry.height / 2 };
  return { x: geometry.centerX, y: geometry.centerY + geometry.height / 2 };
}

function mobileCanvasSlotOffset(index: number, count: number, axisSize: number): number {
  if (count <= 1) return 0;
  const availableSpread = Math.max(axisSize - MOBILE_CANVAS_EDGE_SLOT_PADDING * 2, MOBILE_CANVAS_EDGE_SLOT_SPACING);
  const spacing = Math.min(MOBILE_CANVAS_EDGE_SLOT_SPACING, availableSpread / (count - 1));
  return (index - (count - 1) / 2) * spacing;
}

function mobileCanvasEndpointSiblingKey(edge: CanvasEdge, endpoint: 'source' | 'target'): string {
  return `${edge.id}:${endpoint}`;
}

function mobileCanvasEndpointSiblings(
  edges: CanvasEdge[],
  nodeId: string,
  position: CanvasEdgePosition,
  nodeGeometry: Map<string, MobileCanvasNodeGeometry>,
): Array<{ key: string; oppositeId: string }> {
  const siblings: Array<{ key: string; oppositeId: string }> = [];
  for (const edge of edges) {
    if (edge.source === nodeId && mobileCanvasEndpointPosition(edge, 'source', nodeGeometry) === position) {
      siblings.push({ key: mobileCanvasEndpointSiblingKey(edge, 'source'), oppositeId: edge.target });
    }
    if (edge.target === nodeId && mobileCanvasEndpointPosition(edge, 'target', nodeGeometry) === position) {
      siblings.push({ key: mobileCanvasEndpointSiblingKey(edge, 'target'), oppositeId: edge.source });
    }
  }
  const anchorNode = nodeGeometry.get(nodeId);
  return siblings.sort((left, right) => {
    const leftNode = nodeGeometry.get(left.oppositeId);
    const rightNode = nodeGeometry.get(right.oppositeId);
    const metrics = (node?: MobileCanvasNodeGeometry) => {
      if (!anchorNode || !node) return { angle: 0, distance: Number.POSITIVE_INFINITY };
      const deltaX = node.centerX - anchorNode.centerX;
      const deltaY = node.centerY - anchorNode.centerY;
      let outward = deltaX;
      let tangent = deltaY;
      if (position === 'left') outward = -deltaX;
      if (position === 'top') {
        outward = -deltaY;
        tangent = deltaX;
      }
      if (position === 'bottom') {
        outward = deltaY;
        tangent = deltaX;
      }
      return { angle: Math.atan2(tangent, outward), distance: Math.hypot(deltaX, deltaY) };
    };
    const leftMetrics = metrics(leftNode);
    const rightMetrics = metrics(rightNode);
    if (leftMetrics.angle !== rightMetrics.angle) return leftMetrics.angle - rightMetrics.angle;
    if (leftMetrics.distance !== rightMetrics.distance) return leftMetrics.distance - rightMetrics.distance;
    if (left.oppositeId !== right.oppositeId) return left.oppositeId.localeCompare(right.oppositeId);
    return left.key.localeCompare(right.key);
  });
}

function mobileCanvasFacingLaneLimit(
  source: TouchPoint,
  target: TouchPoint,
  sourcePosition: CanvasEdgePosition,
  targetPosition: CanvasEdgePosition,
): number | null {
  if (sourcePosition === 'right' && targetPosition === 'left' && target.x >= source.x) return (target.x - source.x) / 2;
  if (sourcePosition === 'left' && targetPosition === 'right' && source.x >= target.x) return (source.x - target.x) / 2;
  if (sourcePosition === 'bottom' && targetPosition === 'top' && target.y >= source.y) return (target.y - source.y) / 2;
  if (sourcePosition === 'top' && targetPosition === 'bottom' && source.y >= target.y) return (source.y - target.y) / 2;
  return null;
}

function mobileCanvasEdgeGeometry(
  edge: CanvasEdge,
  edges: CanvasEdge[],
  nodeGeometry: Map<string, MobileCanvasNodeGeometry>,
): MobileCanvasEdgeGeometry | null {
  const sourceNode = nodeGeometry.get(edge.source);
  const targetNode = nodeGeometry.get(edge.target);
  if (!sourceNode || !targetNode) return null;
  const sourcePosition = mobileCanvasEndpointPosition(edge, 'source', nodeGeometry);
  const targetPosition = mobileCanvasEndpointPosition(edge, 'target', nodeGeometry);
  const sourceAnchor = mobileCanvasAnchorCoordinates(sourceNode, sourcePosition, { x: sourceNode.centerX, y: sourceNode.centerY });
  const targetAnchor = mobileCanvasAnchorCoordinates(targetNode, targetPosition, { x: targetNode.centerX, y: targetNode.centerY });
  const sourceSiblings = mobileCanvasEndpointSiblings(edges, edge.source, sourcePosition, nodeGeometry);
  const targetSiblings = mobileCanvasEndpointSiblings(edges, edge.target, targetPosition, nodeGeometry);
  const sourceIndex = Math.max(0, sourceSiblings.findIndex((candidate) => candidate.key === mobileCanvasEndpointSiblingKey(edge, 'source')));
  const targetIndex = Math.max(0, targetSiblings.findIndex((candidate) => candidate.key === mobileCanvasEndpointSiblingKey(edge, 'target')));
  const sourceAxisSize = isHorizontalCanvasEdgePosition(sourcePosition) ? sourceNode.height : sourceNode.width;
  const targetAxisSize = isHorizontalCanvasEdgePosition(targetPosition) ? targetNode.height : targetNode.width;
  const sourceOffset = mobileCanvasSlotOffset(sourceIndex, sourceSiblings.length, sourceAxisSize);
  const targetOffset = mobileCanvasSlotOffset(targetIndex, targetSiblings.length, targetAxisSize);
  const anchoredSource = {
    x: isHorizontalCanvasEdgePosition(sourcePosition) ? sourceAnchor.x : sourceAnchor.x + sourceOffset,
    y: isHorizontalCanvasEdgePosition(sourcePosition) ? sourceAnchor.y + sourceOffset : sourceAnchor.y,
  };
  const anchoredTarget = {
    x: isHorizontalCanvasEdgePosition(targetPosition) ? targetAnchor.x : targetAnchor.x + targetOffset,
    y: isHorizontalCanvasEdgePosition(targetPosition) ? targetAnchor.y + targetOffset : targetAnchor.y,
  };
  const sourceDirection = {
    x: sourcePosition === 'left' ? -1 : sourcePosition === 'right' ? 1 : 0,
    y: sourcePosition === 'top' ? -1 : sourcePosition === 'bottom' ? 1 : 0,
  };
  const targetDirection = {
    x: targetPosition === 'left' ? -1 : targetPosition === 'right' ? 1 : 0,
    y: targetPosition === 'top' ? -1 : targetPosition === 'bottom' ? 1 : 0,
  };
  const baseLaneDistance = Math.max(
    MOBILE_CANVAS_EDGE_LANE,
    Math.min(Math.max(Math.abs(anchoredTarget.x - anchoredSource.x), Math.abs(anchoredTarget.y - anchoredSource.y)) * 0.32, 96),
  );
  const facingLaneLimit = mobileCanvasFacingLaneLimit(anchoredSource, anchoredTarget, sourcePosition, targetPosition);
  const laneDistance = facingLaneLimit == null ? baseLaneDistance : Math.max(0, Math.min(baseLaneDistance, facingLaneLimit));
  return {
    sourceX: anchoredSource.x,
    sourceY: anchoredSource.y,
    controlSourceX: anchoredSource.x + sourceDirection.x * laneDistance,
    controlSourceY: anchoredSource.y + sourceDirection.y * laneDistance,
    controlTargetX: anchoredTarget.x + targetDirection.x * laneDistance,
    controlTargetY: anchoredTarget.y + targetDirection.y * laneDistance,
    targetX: anchoredTarget.x,
    targetY: anchoredTarget.y,
    labelX: (anchoredSource.x + anchoredTarget.x) / 2,
    labelY: (anchoredSource.y + anchoredTarget.y) / 2,
  };
}

function buildCurvedCanvasEdgePath(geometry: MobileCanvasEdgeGeometry): string {
  return `M ${geometry.sourceX} ${geometry.sourceY} C ${geometry.controlSourceX} ${geometry.controlSourceY}, ${geometry.controlTargetX} ${geometry.controlTargetY}, ${geometry.targetX} ${geometry.targetY}`;
}

function orthogonalCanvasEdgePoints(geometry: MobileCanvasEdgeGeometry): TouchPoint[] {
  const sourceHorizontal = geometry.controlSourceX !== geometry.sourceX;
  const targetHorizontal = geometry.controlTargetX !== geometry.targetX;
  if (sourceHorizontal && targetHorizontal) {
    const midX = (geometry.controlSourceX + geometry.controlTargetX) / 2;
    return [
      { x: geometry.sourceX, y: geometry.sourceY },
      { x: geometry.controlSourceX, y: geometry.controlSourceY },
      { x: midX, y: geometry.controlSourceY },
      { x: midX, y: geometry.controlTargetY },
      { x: geometry.controlTargetX, y: geometry.controlTargetY },
      { x: geometry.targetX, y: geometry.targetY },
    ];
  }
  if (!sourceHorizontal && !targetHorizontal) {
    const midY = (geometry.controlSourceY + geometry.controlTargetY) / 2;
    return [
      { x: geometry.sourceX, y: geometry.sourceY },
      { x: geometry.controlSourceX, y: geometry.controlSourceY },
      { x: geometry.controlSourceX, y: midY },
      { x: geometry.controlTargetX, y: midY },
      { x: geometry.controlTargetX, y: geometry.controlTargetY },
      { x: geometry.targetX, y: geometry.targetY },
    ];
  }
  if (!sourceHorizontal && targetHorizontal) {
    return [
      { x: geometry.sourceX, y: geometry.sourceY },
      { x: geometry.sourceX, y: geometry.targetY },
      { x: geometry.targetX, y: geometry.targetY },
    ];
  }
  return [
    { x: geometry.sourceX, y: geometry.sourceY },
    { x: geometry.targetX, y: geometry.sourceY },
    { x: geometry.targetX, y: geometry.targetY },
  ];
}

function buildOrthogonalCanvasEdgePath(geometry: MobileCanvasEdgeGeometry): string {
  return orthogonalCanvasEdgePoints(geometry)
    .map((point, index) => `${index === 0 ? 'M' : 'L'} ${point.x} ${point.y}`)
    .join(' ');
}

function orthogonalCanvasEdgeLabelPosition(geometry: MobileCanvasEdgeGeometry): TouchPoint {
  const points = orthogonalCanvasEdgePoints(geometry);
  let best = { start: { x: geometry.sourceX, y: geometry.sourceY }, end: { x: geometry.targetX, y: geometry.targetY }, length: 0 };
  for (let index = 1; index < points.length; index += 1) {
    const start = points[index - 1];
    const end = points[index];
    const length = Math.hypot(end.x - start.x, end.y - start.y);
    if (length > best.length) {
      best = { start, end, length };
    }
  }
  return { x: (best.start.x + best.end.x) / 2, y: (best.start.y + best.end.y) / 2 };
}

function buildMobileCanvasEdges(edges: CanvasEdge[], nodes: Map<string, CanvasNode>): MobileCanvasEdgeRender[] {
  const nodeGeometry = new Map(Array.from(nodes.entries()).map(([id, node]) => [
    id,
    {
      centerX: node.position.x + canvasNodeWidth(node) / 2,
      centerY: node.position.y + canvasNodeHeight(node) / 2,
      width: canvasNodeWidth(node),
      height: canvasNodeHeight(node),
    } satisfies MobileCanvasNodeGeometry,
  ]));
  return edges.flatMap((edge) => {
    const geometry = mobileCanvasEdgeGeometry(edge, edges, nodeGeometry);
    if (!geometry) return [];
    const labelPosition = edge.routingStyle === 'orthogonal'
      ? orthogonalCanvasEdgeLabelPosition(geometry)
      : { x: geometry.labelX, y: geometry.labelY };
    return [{
      id: edge.id,
      path: edge.routingStyle === 'orthogonal'
        ? buildOrthogonalCanvasEdgePath(geometry)
        : buildCurvedCanvasEdgePath(geometry),
      label: edge.label?.trim() ?? '',
      labelX: labelPosition.x,
      labelY: labelPosition.y,
      lineStyle: edge.lineStyle ?? 'solid',
      animated: edge.animated ?? false,
      animationReverse: edge.animationReverse ?? false,
      markerStart: edge.markerStart ?? false,
      markerEnd: edge.markerEnd ?? false,
    }];
  });
}

function CanvasMobileViewer({
  canvas,
  zoom,
  setZoom,
  resetToken,
  onWheel,
}: {
  canvas: CanvasData;
  zoom: number;
  setZoom: Dispatch<SetStateAction<number>>;
  resetToken: number;
  onWheel: (event: WheelEvent<HTMLElement>) => void;
}) {
  const stageRef = useRef<HTMLElement | null>(null);
  const dragRef = useRef<TouchPoint | null>(null);
  const pinchRef = useRef<{ distance: number; center: TouchPoint; zoom: number; pan: TouchPoint } | null>(null);
  const [pan, setPan] = useState<TouchPoint>({ x: 0, y: 0 });
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [animateEdges, setAnimateEdges] = useState(false);
  const [stageWidth, stageHeight] = useElementSize(stageRef);
  const lastFitKeyRef = useRef<string | null>(null);
  const bounds = useMemo(() => computeCanvasBounds(canvas.nodes), [canvas.nodes]);
  const nodeById = useMemo(() => new Map(canvas.nodes.map((node) => [node.id, node])), [canvas.nodes]);
  const renderedEdges = useMemo(() => buildMobileCanvasEdges(canvas.edges, nodeById), [canvas.edges, nodeById]);
  const selectedNode = selectedNodeId ? nodeById.get(selectedNodeId) ?? null : null;

  function fitToStage() {
    const stage = stageRef.current;
    if (!stage) return;
    const fitKey = `${bounds.width}:${bounds.height}:${resetToken}:${stage.clientWidth}:${stage.clientHeight}`;
    if (lastFitKeyRef.current === fitKey) return;
    lastFitKeyRef.current = fitKey;
    const margin = Math.max(48, Math.min(stage.clientWidth, stage.clientHeight) * 0.12);
    const fitZoom = clamp(
      Math.min(
        Math.max(1, stage.clientWidth - margin * 2) / bounds.width,
        Math.max(1, stage.clientHeight - margin * 2) / bounds.height,
      ),
      0.03,
      1.25,
    );
    setZoom(Number(fitZoom.toFixed(3)));
    setPan({ x: 0, y: 0 });
  }

  useEffect(() => {
    fitToStage();
    // Fit after the stage has a measured size and when explicit reset is requested.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bounds.height, bounds.width, resetToken, stageHeight, stageWidth]);

  function clampCanvasPan(next: TouchPoint, nextZoom = zoom): TouchPoint {
    const stage = stageRef.current;
    if (!stage) return next;
    const margin = Math.max(40, Math.min(stage.clientWidth, stage.clientHeight) * 0.16);
    const overflowX = Math.max(0, bounds.width * nextZoom - (stage.clientWidth - margin * 2));
    const overflowY = Math.max(0, bounds.height * nextZoom - (stage.clientHeight - margin * 2));
    return {
      x: clamp(next.x, -overflowX / 2 - margin, overflowX / 2 + margin),
      y: clamp(next.y, -overflowY / 2 - margin, overflowY / 2 + margin),
    };
  }

  function handleTouchStart(event: TouchEvent<HTMLElement>) {
    if (event.touches.length === 2) {
      const first = touchPoint(event.touches[0]);
      const second = touchPoint(event.touches[1]);
      pinchRef.current = { distance: distanceBetween(first, second), center: midpoint(first, second), zoom, pan };
      dragRef.current = null;
      return;
    }
    if (event.touches.length === 1) {
      dragRef.current = touchPoint(event.touches[0]);
      pinchRef.current = null;
    }
  }

  function handleTouchMove(event: TouchEvent<HTMLElement>) {
    if (event.touches.length === 2 && pinchRef.current) {
      event.preventDefault();
      const first = touchPoint(event.touches[0]);
      const second = touchPoint(event.touches[1]);
      const center = midpoint(first, second);
      const distance = distanceBetween(first, second);
      const previous = pinchRef.current;
      const ratio = distance / Math.max(1, previous.distance);
      const nextZoom = clamp(Number((previous.zoom * ratio).toFixed(3)), 0.03, 3);
      const stage = stageRef.current;
      const stageCenter = stage ? { x: stage.clientWidth / 2, y: stage.clientHeight / 2 } : { x: 0, y: 0 };
      const zoomRatio = nextZoom / Math.max(0.001, previous.zoom);
      setZoom(nextZoom);
      setPan(
        clampCanvasPan(
          {
            x: center.x - stageCenter.x - zoomRatio * (previous.center.x - stageCenter.x - previous.pan.x),
            y: center.y - stageCenter.y - zoomRatio * (previous.center.y - stageCenter.y - previous.pan.y),
          },
          nextZoom,
        ),
      );
      return;
    }
    if (event.touches.length === 1 && dragRef.current) {
      event.preventDefault();
      const current = touchPoint(event.touches[0]);
      const previous = dragRef.current;
      dragRef.current = current;
      setPan((value) => clampCanvasPan({ x: value.x + current.x - previous.x, y: value.y + current.y - previous.y }));
    }
  }

  function handleTouchEnd(event: TouchEvent<HTMLElement>) {
    if (event.touches.length === 1) {
      dragRef.current = touchPoint(event.touches[0]);
      pinchRef.current = null;
      return;
    }
    dragRef.current = null;
    pinchRef.current = null;
  }

  const cameraStyle = {
    '--canvas-origin-x': `${(stageWidth || 0) / 2 + pan.x}px`,
    '--canvas-origin-y': `${(stageHeight || 0) / 2 + pan.y}px`,
    '--canvas-pan-x': `${pan.x}px`,
    '--canvas-pan-y': `${pan.y}px`,
    '--canvas-zoom': zoom,
    '--canvas-center-x': `${bounds.centerX}px`,
    '--canvas-center-y': `${bounds.centerY}px`,
  } as CSSProperties;
  const gridPadding = 960;
  const gridStyle = {
    left: `${bounds.minX - gridPadding}px`,
    top: `${bounds.minY - gridPadding}px`,
    width: `${bounds.width + gridPadding * 2}px`,
    height: `${bounds.height + gridPadding * 2}px`,
  } as CSSProperties;

  return (
    <section
      ref={stageRef}
      className="viewer-stage canvas-stage"
      onTouchStart={handleTouchStart}
      onTouchMove={handleTouchMove}
      onTouchEnd={handleTouchEnd}
      onTouchCancel={handleTouchEnd}
      onWheel={onWheel}
    >
      {canvas.nodes.length > 0 ? (
        <div className="canvas-viewer-options">
          <button
            type="button"
            className={animateEdges ? 'selected' : ''}
            onClick={() => setAnimateEdges((value) => !value)}
          >
            Animate
          </button>
        </div>
      ) : null}
      {canvas.nodes.length === 0 ? (
        <EmptyState
          icon={<Info size={28} aria-hidden />}
          title="Empty canvas"
          message="This canvas does not contain any nodes yet."
        />
      ) : (
        <div className={`mobile-canvas-camera ${animateEdges ? 'animate-edges' : ''}`} style={cameraStyle}>
          <div className="mobile-canvas-grid" style={gridStyle} aria-hidden />
          <svg
            className="mobile-canvas-edges"
            style={{
              left: `${bounds.minX}px`,
              top: `${bounds.minY}px`,
              width: `${bounds.width}px`,
              height: `${bounds.height}px`,
            }}
            viewBox={`${bounds.minX} ${bounds.minY} ${bounds.width} ${bounds.height}`}
            aria-hidden
          >
            <defs>
              <marker
                id="mobile-canvas-edge-arrow-end"
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
              </marker>
              <marker
                id="mobile-canvas-edge-arrow-start"
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
              </marker>
            </defs>
            {renderedEdges.map((edge) => (
              <g key={edge.id}>
                <path
                  className={`mobile-canvas-edge ${edge.lineStyle ?? 'solid'}`}
                  d={edge.path}
                  markerStart={edge.markerStart ? 'url(#mobile-canvas-edge-arrow-start)' : undefined}
                  markerEnd={edge.markerEnd ? 'url(#mobile-canvas-edge-arrow-end)' : undefined}
                >
                  {edge.animated && animateEdges && edge.lineStyle !== 'solid' ? (
                    <animate
                      attributeName="stroke-dashoffset"
                      from={edge.animationReverse ? '-18' : '18'}
                      to="0"
                      dur="700ms"
                      repeatCount="indefinite"
                    />
                  ) : null}
                </path>
                {edge.animated && animateEdges && edge.lineStyle === 'solid' ? (
                  <path
                    className={`mobile-canvas-edge-animation ${edge.lineStyle ?? 'solid'}`}
                    d={edge.path}
                  >
                    <animate
                      attributeName="stroke-dashoffset"
                      from={edge.animationReverse ? '-268' : '268'}
                      to="0"
                      dur="1200ms"
                      repeatCount="indefinite"
                    />
                  </path>
                ) : null}
              </g>
            ))}
          </svg>
          {renderedEdges.map((edge) => {
            if (!edge.label) return null;
            return (
              <div
                key={`${edge.id}-label`}
                className="mobile-canvas-edge-label"
                style={{ left: `${edge.labelX}px`, top: `${edge.labelY}px` }}
              >
                {edge.label}
              </div>
            );
          })}
          {canvas.nodes.map((node) => (
            <MobileCanvasNodeView
              key={node.id}
              node={node}
              selected={selectedNodeId === node.id}
              style={mobileCanvasNodeStyle(node)}
              onSelect={() => setSelectedNodeId(node.id)}
            />
          ))}
        </div>
      )}
      {selectedNode ? (
        <CanvasNodeDetail node={selectedNode} onClose={() => setSelectedNodeId(null)} />
      ) : null}
    </section>
  );
}

function MobileCanvasNodeView({
  node,
  selected,
  style,
  onSelect,
}: {
  node: CanvasNode;
  selected: boolean;
  style: CSSProperties;
  onSelect: () => void;
}) {
  const record = canvasRecord(node);
  const title = canvasNodeTitle(node);
  const subtitle = canvasNodeSubtitle(node);
  const body = canvasNodeBody(node);
  const badges = planningBadges(node);
  const symbolGlyph = canvasString(node, 'glyph') ?? '?';
  const symbolLabel = canvasString(node, 'iconLabel') ?? canvasString(node, 'iconId') ?? 'Nerd Font icon';

  if (node.type === 'junction') {
    return (
      <button
        type="button"
        className={`mobile-canvas-node desktop-canvas-node desktop-node-junction ${selected ? 'selected' : ''}`}
        style={style}
        onClick={onSelect}
      >
        <span className="desktop-node-junction-dot">
          <CircleDot size={12} aria-hidden />
        </span>
      </button>
    );
  }

  if (node.type === 'crossing') {
    return (
      <button
        type="button"
        className={`mobile-canvas-node desktop-canvas-node desktop-node-crossing ${selected ? 'selected' : ''}`}
        style={style}
        onClick={onSelect}
      >
        <span className="desktop-node-crossing-h" />
        <span className="desktop-node-crossing-v" />
        <span className="desktop-node-crossing-label">Crossing</span>
      </button>
    );
  }

  if (node.type === 'decision') {
    return (
      <button
        type="button"
        className={`mobile-canvas-node desktop-canvas-node desktop-node-decision ${selected ? 'selected' : ''}`}
        style={style}
        onClick={onSelect}
      >
        <span className="desktop-node-icon round">{canvasNodeIcon(node)}</span>
        <strong>{title}</strong>
        {body ? <p>{body}</p> : <p>Branch condition</p>}
      </button>
    );
  }

  if (node.type === 'terminator') {
    return (
      <button
        type="button"
        className={`mobile-canvas-node desktop-canvas-node desktop-node-terminator ${selected ? 'selected' : ''}`}
        style={style}
        onClick={onSelect}
      >
        <span className="desktop-node-icon round">{canvasNodeIcon(node)}</span>
        <strong>{title}</strong>
        {body ? <p>{body}</p> : null}
      </button>
    );
  }

  if (node.type === 'symbol') {
    return (
      <button
        type="button"
        className={`mobile-canvas-node desktop-canvas-node desktop-node-symbol ${selected ? 'selected' : ''}`}
        style={style}
        onClick={onSelect}
      >
        <span className="desktop-node-symbol-glyph" aria-label={symbolLabel}>
          {symbolGlyph}
        </span>
        <strong>{title}</strong>
        <small>{symbolLabel}</small>
      </button>
    );
  }

  const isPlanning = node.type !== 'note' && node.type !== 'file' && node.type !== 'text' && node.type !== 'web';
  const isImageFile = node.type === 'file' && ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico', 'avif'].includes(fileExtensionFromPath(canvasString(node, 'relativePath')));
  const imageSrc = typeof record.imageSrc === 'string' ? record.imageSrc : null;

  return (
    <button
      type="button"
      className={[
        'mobile-canvas-node desktop-canvas-node desktop-node-card',
        `desktop-node-${node.type}`,
        selected ? 'selected' : '',
      ].join(' ')}
      style={style}
      onClick={onSelect}
    >
      <span className="desktop-node-header">
        <span className="desktop-node-icon">{canvasNodeIcon(node)}</span>
        <span className="desktop-node-title-stack">
          <strong>{title}</strong>
          <small>{subtitle ?? canvasNodeKindLabel(node)}</small>
        </span>
        {node.type === 'milestone' && asCanvasRecord(record.planning)?.milestoneLabel ? (
          <span className="desktop-node-badge">{String(asCanvasRecord(record.planning)?.milestoneLabel)}</span>
        ) : null}
      </span>
      <span className="desktop-node-body">
        {isImageFile && imageSrc ? (
          <span className="desktop-node-image-wrap">
            <img src={imageSrc} alt={title} draggable={false} />
          </span>
        ) : node.type === 'web' ? (
          <>
            <span className="desktop-node-web-preview">
              <Globe size={22} aria-hidden />
            </span>
            <span className="desktop-node-text">{body ?? canvasString(node, 'url') ?? 'Preview details will appear here when available.'}</span>
          </>
        ) : (
          <span className="desktop-node-text">
            {body ??
              (node.type === 'note'
                ? 'Double-click to open the note.'
                : node.type === 'file'
                  ? 'Double-click to open this file.'
                  : isPlanning
                    ? 'Add context from the node inspector.'
                    : 'Write directly on the canvas...')}
          </span>
        )}
        {badges.length > 0 ? (
          <span className="desktop-node-badges">
            {badges.map((badge) => (
              <span key={badge.key} className={badge.tone ? `tone-${badge.tone}` : ''}>
                {badge.key === 'due' ? <Calendar size={10} aria-hidden /> : null}
                {badge.label}
              </span>
            ))}
          </span>
        ) : null}
      </span>
    </button>
  );
}

function CanvasNodeDetail({ node, onClose }: { node: CanvasNode; onClose: () => void }) {
  const record = node as unknown as Record<string, unknown>;
  const planning = asCanvasRecord(record.planning);
  const tags = Array.isArray(planning?.tags) ? planning.tags.filter((tag): tag is string => typeof tag === 'string') : [];
  const details = [
    ['Type', node.type],
    ['Path', typeof record.relativePath === 'string' ? record.relativePath : null],
    ['Linked', typeof record.linkedRelativePath === 'string' ? record.linkedRelativePath : null],
    ['URL', typeof record.url === 'string' ? record.url : null],
    ['Owner', typeof planning?.ownerLabel === 'string' ? planning.ownerLabel : null],
    ['Status', typeof planning?.status === 'string' ? planning.status.replace(/_/g, ' ') : null],
    ['Priority', typeof planning?.priority === 'string' ? planning.priority : null],
    ['Due', typeof planning?.dueDate === 'string' ? planning.dueDate : null],
  ].filter((entry): entry is [string, string] => typeof entry[1] === 'string' && entry[1].trim().length > 0);

  return (
    <aside className="canvas-node-detail" aria-label="Canvas node details">
      <div className="canvas-node-detail-head">
        <div>
          <span>{node.type}</span>
          <strong>{canvasNodeTitle(node)}</strong>
        </div>
        <button type="button" className="icon-button" aria-label="Close details" onClick={onClose}>
          <ArrowLeft size={16} aria-hidden />
        </button>
      </div>
      {canvasNodeBody(node) ? <p>{canvasNodeBody(node)}</p> : null}
      {details.length > 0 ? (
        <dl>
          {details.map(([label, value]) => (
            <div key={label}>
              <dt>{label}</dt>
              <dd>{value}</dd>
            </div>
          ))}
        </dl>
      ) : null}
      {tags.length > 0 ? (
        <div className="canvas-node-tags">
          {tags.map((tag) => (
            <span key={tag}>#{tag}</span>
          ))}
        </div>
      ) : null}
      {'url' in record && typeof record.url === 'string' ? (
        <div className="canvas-node-detail-link">
          <Globe size={14} aria-hidden />
          <span>{record.url}</span>
        </div>
      ) : null}
      {'linkedRelativePath' in record && typeof record.linkedRelativePath === 'string' ? (
        <div className="canvas-node-detail-link">
          <Link2 size={14} aria-hidden />
          <span>{record.linkedRelativePath}</span>
        </div>
      ) : null}
    </aside>
  );
}

function asCanvasRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : null;
}

const MOBILE_LOGIC_NODE_WIDTH = 116;
const MOBILE_LOGIC_NODE_HEIGHT = 72;
const MOBILE_LOGIC_COMPONENT_WIDTH = 156;
const MOBILE_LOGIC_GROUP_WIDTH = 260;
const MOBILE_LOGIC_GROUP_HEIGHT = 180;
const MOBILE_LOGIC_PORT_TOP = 0.22;
const MOBILE_LOGIC_PORT_SPAN = 0.56;

function logicNodeLabel(node: LogicDiagramNode): string {
  if (node.label?.trim()) return node.label.trim();
  if (node.kind === 'component') return node.component?.definition.name ?? 'Component';
  return node.kind.toUpperCase();
}

function logicNodeWidth(node: LogicDiagramNode): number {
  if (node.kind === 'group') return node.width ?? MOBILE_LOGIC_GROUP_WIDTH;
  if (node.kind === 'component') return node.width ?? MOBILE_LOGIC_COMPONENT_WIDTH;
  if (isElectronicComponentKind(node.kind)) return schematicSymbolDimensions(node.kind, node.rotation ?? 0).width;
  return node.width ?? MOBILE_LOGIC_NODE_WIDTH;
}

function logicNodeHeight(node: LogicDiagramNode): number {
  if (node.kind === 'group') return node.height ?? MOBILE_LOGIC_GROUP_HEIGHT;
  if (node.kind === 'component') {
    const inputCount = node.component?.definition.ports.filter((port) => port.direction === 'input').length ?? 0;
    const outputCount = node.component?.definition.ports.filter((port) => port.direction === 'output').length ?? 0;
    return Math.max(node.height ?? MOBILE_LOGIC_NODE_HEIGHT, 78 + Math.max(inputCount, outputCount, 1) * 15);
  }
  if (isElectronicComponentKind(node.kind)) return schematicSymbolDimensions(node.kind, node.rotation ?? 0).height;
  return node.height ?? MOBILE_LOGIC_NODE_HEIGHT;
}

function logicHandleRatio(index: number, count: number): number {
  if (count <= 1) return 0.5;
  return MOBILE_LOGIC_PORT_TOP + (index / Math.max(1, count - 1)) * MOBILE_LOGIC_PORT_SPAN;
}

function absoluteLogicNodePosition(
  node: LogicDiagramNode,
  nodeById: Map<string, LogicDiagramNode>,
): TouchPoint {
  if (!node.parentId) return node.position;
  const parent = nodeById.get(node.parentId);
  if (!parent) return node.position;
  const parentPosition = absoluteLogicNodePosition(parent, nodeById);
  return {
    x: parentPosition.x + node.position.x,
    y: parentPosition.y + node.position.y,
  };
}

function logicHandleAnchor(
  node: LogicDiagramNode,
  handleId: string | undefined,
  type: 'source' | 'target',
  nodeById: Map<string, LogicDiagramNode>,
): TouchPoint {
  const position = absoluteLogicNodePosition(node, nodeById);
  if (isElectronicComponentKind(node.kind)) {
    const terminals = getSchematicTerminals(node.kind);
    const point = schematicTerminalPoint(node.kind, handleId ?? terminals[0], node.rotation ?? 0);
    return { x: position.x + point.x, y: position.y + point.y };
  }
  const handles = type === 'source'
    ? getLogicOutputHandles(node.kind, node.component)
    : getLogicInputHandles(node.kind, node.component);
  const index = Math.max(0, handleId ? handles.indexOf(handleId) : 0);
  const width = logicNodeWidth(node);
  const height = logicNodeHeight(node);
  const yRatio = logicHandleRatio(index, handles.length);
  return {
    x: position.x + (type === 'source' ? width : 0),
    y: position.y + height * yRatio,
  };
}

function computeLogicBounds(nodes: LogicDiagramNode[], nodeById: Map<string, LogicDiagramNode>): CanvasWorldBounds {
  if (nodes.length === 0) {
    return {
      minX: -320,
      minY: -210,
      maxX: 320,
      maxY: 210,
      width: 640,
      height: 420,
      centerX: 0,
      centerY: 0,
    };
  }
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const node of nodes) {
    const position = absoluteLogicNodePosition(node, nodeById);
    minX = Math.min(minX, position.x);
    minY = Math.min(minY, position.y);
    maxX = Math.max(maxX, position.x + logicNodeWidth(node));
    maxY = Math.max(maxY, position.y + logicNodeHeight(node));
  }
  const width = Math.max(1, maxX - minX);
  const height = Math.max(1, maxY - minY);
  return {
    minX,
    minY,
    maxX,
    maxY,
    width,
    height,
    centerX: minX + width / 2,
    centerY: minY + height / 2,
  };
}

function logicSignalClass(signal: LogicSignal): string {
  if (signal === true) return 'on';
  if (signal === false) return 'off';
  return 'unknown';
}

function logicSignalLabel(signal: LogicSignal): string {
  if (signal === true) return '1';
  if (signal === false) return '0';
  return 'unset';
}

function formatCircuitMeasurement(value: number, unit: string): string {
  if (!Number.isFinite(value)) return `? ${unit}`;
  const magnitude = Math.abs(value);
  const prefixes = [
    { threshold: 1e9, scale: 1e9, prefix: 'G' },
    { threshold: 1e6, scale: 1e6, prefix: 'M' },
    { threshold: 1e3, scale: 1e3, prefix: 'k' },
    { threshold: 1, scale: 1, prefix: '' },
    { threshold: 1e-3, scale: 1e-3, prefix: 'm' },
    { threshold: 1e-6, scale: 1e-6, prefix: 'u' },
    { threshold: 1e-9, scale: 1e-9, prefix: 'n' },
    { threshold: 0, scale: 1e-12, prefix: 'p' },
  ];
  const selected = prefixes.find((candidate) => magnitude >= candidate.threshold) ?? prefixes[prefixes.length - 1];
  return `${Number((value / selected.scale).toPrecision(4))} ${selected.prefix}${unit}`;
}

function circuitStageLabel(status: CircuitJobStatus | null): string {
  if (status?.phase === 'cancelling') return 'Cancelling';
  if (!status?.stage) return 'Starting';
  return status.stage[0].toUpperCase() + status.stage.slice(1);
}

type LogicConnectionSide = 'left' | 'right' | 'top' | 'bottom';

function connectionSideToward(origin: TouchPoint, destination: TouchPoint): LogicConnectionSide {
  const dx = destination.x - origin.x;
  const dy = destination.y - origin.y;
  if (Math.abs(dx) >= Math.abs(dy)) return dx < 0 ? 'left' : 'right';
  return dy < 0 ? 'top' : 'bottom';
}

function validLogicHandle(
  node: LogicDiagramNode,
  handleId: string | undefined,
  type: 'source' | 'target',
): string | undefined {
  const handles = isElectronicComponentKind(node.kind)
    ? getSchematicTerminals(node.kind)
    : type === 'source'
      ? getLogicOutputHandles(node.kind, node.component)
      : getLogicInputHandles(node.kind, node.component);
  return handleId && handles.includes(handleId) ? handleId : handles[0];
}

function logicWireGeometry(
  sourceNode: LogicDiagramNode,
  targetNode: LogicDiagramNode,
  sourceHandleId: string | undefined,
  targetHandleId: string | undefined,
  nodeById: Map<string, LogicDiagramNode>,
): { path: string; source: TouchPoint; target: TouchPoint } | null {
  const sourceHandle = validLogicHandle(sourceNode, sourceHandleId, 'source');
  const targetHandle = validLogicHandle(targetNode, targetHandleId, 'target');
  if (!sourceHandle || !targetHandle) return null;

  const source = logicHandleAnchor(sourceNode, sourceHandle, 'source', nodeById);
  const target = logicHandleAnchor(targetNode, targetHandle, 'target', nodeById);
  const sourceSide = sourceNode.kind === 'junction'
    ? connectionSideToward(source, target)
    : isElectronicComponentKind(sourceNode.kind)
      ? schematicTerminalSide(sourceNode.kind, sourceHandle, sourceNode.rotation ?? 0)
      : 'right';
  const targetSide = targetNode.kind === 'junction'
    ? connectionSideToward(target, source)
    : isElectronicComponentKind(targetNode.kind)
      ? schematicTerminalSide(targetNode.kind, targetHandle, targetNode.rotation ?? 0)
      : 'left';
  const [path] = getSmoothStepPath({
    sourceX: source.x,
    sourceY: source.y,
    sourcePosition: sourceSide as never,
    targetX: target.x,
    targetY: target.y,
    targetPosition: targetSide as never,
    borderRadius: 12,
  });
  return { path, source, target };
}

export function LogicMobileViewer({
  logic,
  zoom,
  setZoom,
  resetToken,
  onWheel,
  schematicSymbolSet,
}: {
  logic: LogicDiagramDocument;
  zoom: number;
  setZoom: Dispatch<SetStateAction<number>>;
  resetToken: number;
  onWheel: (event: WheelEvent<HTMLElement>) => void;
  schematicSymbolSet: SchematicSymbolSet;
}) {
  const stageRef = useRef<HTMLElement | null>(null);
  const dragRef = useRef<TouchPoint | null>(null);
  const pinchRef = useRef<{ distance: number; center: TouchPoint; zoom: number; pan: TouchPoint } | null>(null);
  const [pan, setPan] = useState<TouchPoint>({ x: 0, y: 0 });
  const [inputValues, setInputValues] = useState<Record<string, boolean>>({});
  const [circuitRunning, setCircuitRunning] = useState(false);
  const [circuitRunKind, setCircuitRunKind] = useState<'dc' | 'sweep' | 'transient' | null>(null);
  const [circuitStatus, setCircuitStatus] = useState<CircuitJobStatus | null>(null);
  const [circuitResult, setCircuitResult] = useState<CircuitDcResult | null>(null);
  const [circuitError, setCircuitError] = useState<string | null>(null);
  const [circuitResultsOpen, setCircuitResultsOpen] = useState(false);
  const [sweepResult, setSweepResult] = useState<CircuitSweepResult | null>(null);
  const [sweepError, setSweepError] = useState<string | null>(null);
  const [sweepResultsOpen, setSweepResultsOpen] = useState(false);
  const [transientResult, setTransientResult] = useState<CircuitTransientResult | null>(null);
  const [transientError, setTransientError] = useState<string | null>(null);
  const [transientResultsOpen, setTransientResultsOpen] = useState(false);
  const circuitJobIdRef = useRef<string | null>(null);
  const circuitRunSequenceRef = useRef(0);
  const circuitMountedRef = useRef(true);
  const [stageWidth, stageHeight] = useElementSize(stageRef);
  const lastFitKeyRef = useRef<string | null>(null);

  const baseInputs = useMemo(() => {
    const values: Record<string, boolean> = {};
    for (const node of logic.nodes) {
      if (node.kind === 'input') values[node.id] = node.value === true;
    }
    return values;
  }, [logic.nodes]);

  useEffect(() => {
    setInputValues(baseInputs);
  }, [baseInputs]);

  useEffect(() => {
    circuitMountedRef.current = true;
    setCircuitRunning(false);
    setCircuitRunKind(null);
    setCircuitStatus(null);
    setCircuitResult(null);
    setCircuitError(null);
    setCircuitResultsOpen(false);
    setSweepResult(null);
    setSweepError(null);
    setSweepResultsOpen(false);
    setTransientResult(null);
    setTransientError(null);
    setTransientResultsOpen(false);
    return () => {
      circuitMountedRef.current = false;
      circuitRunSequenceRef.current += 1;
      const activeJobId = circuitJobIdRef.current;
      if (activeJobId) void circuitCancelJob(activeJobId).catch(() => undefined);
    };
  }, [logic]);

  const simulatedNodes = useMemo(() => logic.nodes.map((node) => (
    node.kind === 'input' ? { ...node, value: inputValues[node.id] ?? node.value ?? false } : node
  )), [inputValues, logic.nodes]);
  const nodeById = useMemo(() => new Map(simulatedNodes.map((node) => [node.id, node])), [simulatedNodes]);
  const bounds = useMemo(() => computeLogicBounds(simulatedNodes, nodeById), [nodeById, simulatedNodes]);
  const evaluation = useMemo(() => evaluateLogicDiagram(simulatedNodes, logic.wires, { components: logic.components }), [logic.components, logic.wires, simulatedNodes]);
  const inputNodes = useMemo(() => simulatedNodes.filter((node) => node.kind === 'input'), [simulatedNodes]);
  const outputNodes = useMemo(() => simulatedNodes.filter((node) => node.kind === 'output'), [simulatedNodes]);
  const circuitWirePolarities = useMemo(() => {
    const polarities = new Map<string, 'positive' | 'negative' | 'reference'>();
    if (!circuitResult) return polarities;
    for (const mapping of circuitResult.sourceMap.wires) {
      const voltage = circuitResult.operatingPoint.nodeVoltages[mapping.electricalNode];
      if (typeof voltage !== 'number') continue;
      polarities.set(
        mapping.wireId,
        voltage > ANALOG_ACTIVE_VOLTAGE
          ? 'positive'
          : voltage < -ANALOG_ACTIVE_VOLTAGE
            ? 'negative'
            : 'reference',
      );
    }
    return polarities;
  }, [circuitResult]);

  const runDcSimulation = useCallback(async () => {
    if (logic.diagramMode !== 'schematic' || circuitRunning) return;
    const runSequence = ++circuitRunSequenceRef.current;
    let startedJobId: string | null = null;
    setCircuitRunning(true);
    setCircuitRunKind('dc');
    setCircuitStatus(null);
    setCircuitResult(null);
    setCircuitError(null);
    setCircuitResultsOpen(true);
    setSweepResultsOpen(false);
    setTransientResultsOpen(false);
    try {
      const outcome = await runCircuitJob(MOBILE_CIRCUIT_JOB_CLIENT, logic, {
        onStarted: (jobId) => {
          startedJobId = jobId;
          circuitJobIdRef.current = jobId;
          if (circuitMountedRef.current && circuitRunSequenceRef.current === runSequence) {
            setCircuitStatus({ phase: 'queued', stage: 'queued', elapsedMillis: 0 });
          } else {
            void circuitCancelJob(jobId).catch(() => undefined);
          }
        },
        onStatus: (status) => {
          if (circuitMountedRef.current && circuitRunSequenceRef.current === runSequence) {
            setCircuitStatus(status);
          }
        },
      });
      if (!circuitMountedRef.current || circuitRunSequenceRef.current !== runSequence) return;
      if (outcome.state === 'completed') {
        setCircuitResult(outcome.result);
      } else if (outcome.state === 'failed') {
        throw outcome.error;
      }
    } catch (error) {
      if (circuitMountedRef.current && circuitRunSequenceRef.current === runSequence) {
        setCircuitError(circuitErrorText(error));
      }
    } finally {
      if (startedJobId && circuitJobIdRef.current === startedJobId) circuitJobIdRef.current = null;
      if (circuitMountedRef.current && circuitRunSequenceRef.current === runSequence) {
        setCircuitStatus(null);
        setCircuitRunning(false);
        setCircuitRunKind(null);
      }
    }
  }, [circuitRunning, logic]);

  const runDcSweep = useCallback(async () => {
    if (logic.diagramMode !== 'schematic' || circuitRunning || !logic.simulation?.dcSweep) return;
    if ((logic.simulation.probes?.length ?? 0) === 0) {
      setSweepError('This sweep has no configured voltage or current probes.');
      setSweepResultsOpen(true);
      return;
    }
    const runSequence = ++circuitRunSequenceRef.current;
    let startedJobId: string | null = null;
    setCircuitRunning(true);
    setCircuitRunKind('sweep');
    setSweepResult(null);
    setSweepError(null);
    setSweepResultsOpen(true);
    setCircuitResultsOpen(false);
    setTransientResultsOpen(false);
    try {
      const result = await runCircuitSweepJob(MOBILE_SWEEP_JOB_CLIENT, logic, {
        onStarted: (jobId) => {
          startedJobId = jobId;
          circuitJobIdRef.current = jobId;
          if (circuitMountedRef.current && circuitRunSequenceRef.current === runSequence) {
            setCircuitStatus({ phase: 'queued', stage: 'queued', elapsedMillis: 0 });
          } else {
            void circuitCancelJob(jobId).catch(() => undefined);
          }
        },
        onStatus: (status) => {
          if (circuitMountedRef.current && circuitRunSequenceRef.current === runSequence) {
            setCircuitStatus(status);
          }
        },
      });
      if (!circuitMountedRef.current || circuitRunSequenceRef.current !== runSequence) return;
      if ('sourceValues' in result) {
        setSweepResult(result);
      } else if (result.state === 'failed') {
        throw result.error;
      }
    } catch (error) {
      if (circuitMountedRef.current && circuitRunSequenceRef.current === runSequence) {
        setSweepError(circuitErrorText(error));
      }
    } finally {
      if (startedJobId && circuitJobIdRef.current === startedJobId) circuitJobIdRef.current = null;
      if (circuitMountedRef.current && circuitRunSequenceRef.current === runSequence) {
        setCircuitStatus(null);
        setCircuitRunning(false);
        setCircuitRunKind(null);
      }
    }
  }, [circuitRunning, logic]);

  const runTransient = useCallback(async () => {
    if (logic.diagramMode !== 'schematic' || circuitRunning || !logic.simulation?.transient) return;
    if ((logic.simulation.probes?.length ?? 0) === 0) {
      setTransientError('This transient analysis has no configured voltage or current probes.');
      setTransientResultsOpen(true);
      return;
    }
    const runSequence = ++circuitRunSequenceRef.current;
    let startedJobId: string | null = null;
    setCircuitRunning(true);
    setCircuitRunKind('transient');
    setTransientResult(null);
    setTransientError(null);
    setTransientResultsOpen(true);
    setCircuitResultsOpen(false);
    setSweepResultsOpen(false);
    try {
      const result = await runCircuitTransientJob(MOBILE_TRANSIENT_JOB_CLIENT, logic, {
        onStarted: (jobId) => {
          startedJobId = jobId;
          circuitJobIdRef.current = jobId;
          if (circuitMountedRef.current && circuitRunSequenceRef.current === runSequence) {
            setCircuitStatus({ phase: 'queued', stage: 'queued', elapsedMillis: 0 });
          } else {
            void circuitCancelJob(jobId).catch(() => undefined);
          }
        },
        onStatus: (status) => {
          if (circuitMountedRef.current && circuitRunSequenceRef.current === runSequence) setCircuitStatus(status);
        },
      });
      if (!circuitMountedRef.current || circuitRunSequenceRef.current !== runSequence) return;
      if ('timeSeconds' in result) setTransientResult(result);
      else if (result.state === 'failed') throw result.error;
    } catch (error) {
      if (circuitMountedRef.current && circuitRunSequenceRef.current === runSequence) {
        setTransientError(circuitErrorText(error));
      }
    } finally {
      if (startedJobId && circuitJobIdRef.current === startedJobId) circuitJobIdRef.current = null;
      if (circuitMountedRef.current && circuitRunSequenceRef.current === runSequence) {
        setCircuitStatus(null);
        setCircuitRunning(false);
        setCircuitRunKind(null);
      }
    }
  }, [circuitRunning, logic]);

  const cancelDcSimulation = useCallback(async () => {
    const activeJobId = circuitJobIdRef.current;
    if (!activeJobId) return;
    try {
      const phase = await circuitCancelJob(activeJobId);
      if (circuitMountedRef.current) {
        setCircuitStatus((current) => current ? { ...current, phase } : current);
      }
    } catch (error) {
      if (circuitMountedRef.current) {
        if (circuitRunKind === 'sweep') setSweepError(circuitErrorText(error));
        else if (circuitRunKind === 'transient') setTransientError(circuitErrorText(error));
        else setCircuitError(circuitErrorText(error));
      }
    }
  }, [circuitRunKind]);

  function fitToStage() {
    const stage = stageRef.current;
    if (!stage) return;
    const fitKey = `${bounds.width}:${bounds.height}:${resetToken}:${stage.clientWidth}:${stage.clientHeight}`;
    if (lastFitKeyRef.current === fitKey) return;
    lastFitKeyRef.current = fitKey;
    const margin = Math.max(52, Math.min(stage.clientWidth, stage.clientHeight) * 0.14);
    const fitZoom = clamp(
      Math.min(
        Math.max(1, stage.clientWidth - margin * 2) / bounds.width,
        Math.max(1, stage.clientHeight - margin * 2) / bounds.height,
      ),
      0.08,
      1.4,
    );
    setZoom(Number(fitZoom.toFixed(3)));
    setPan({ x: 0, y: 0 });
  }

  useEffect(() => {
    fitToStage();
    // Fit after the stage has a measured size and when explicit reset is requested.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bounds.height, bounds.width, resetToken, stageHeight, stageWidth]);

  function clampLogicPan(next: TouchPoint, nextZoom = zoom): TouchPoint {
    const stage = stageRef.current;
    if (!stage) return next;
    const margin = Math.max(42, Math.min(stage.clientWidth, stage.clientHeight) * 0.16);
    const overflowX = Math.max(0, bounds.width * nextZoom - (stage.clientWidth - margin * 2));
    const overflowY = Math.max(0, bounds.height * nextZoom - (stage.clientHeight - margin * 2));
    return {
      x: clamp(next.x, -overflowX / 2 - margin, overflowX / 2 + margin),
      y: clamp(next.y, -overflowY / 2 - margin, overflowY / 2 + margin),
    };
  }

  function handleTouchStart(event: TouchEvent<HTMLElement>) {
    if (event.touches.length === 2) {
      const first = touchPoint(event.touches[0]);
      const second = touchPoint(event.touches[1]);
      pinchRef.current = { distance: distanceBetween(first, second), center: midpoint(first, second), zoom, pan };
      dragRef.current = null;
      return;
    }
    if (event.touches.length === 1) {
      dragRef.current = touchPoint(event.touches[0]);
      pinchRef.current = null;
    }
  }

  function handleTouchMove(event: TouchEvent<HTMLElement>) {
    if (event.touches.length === 2 && pinchRef.current) {
      event.preventDefault();
      const first = touchPoint(event.touches[0]);
      const second = touchPoint(event.touches[1]);
      const center = midpoint(first, second);
      const distance = distanceBetween(first, second);
      const previous = pinchRef.current;
      const ratio = distance / Math.max(1, previous.distance);
      const nextZoom = clamp(Number((previous.zoom * ratio).toFixed(3)), 0.08, 3);
      const stage = stageRef.current;
      const stageCenter = stage ? { x: stage.clientWidth / 2, y: stage.clientHeight / 2 } : { x: 0, y: 0 };
      const zoomRatio = nextZoom / Math.max(0.001, previous.zoom);
      setZoom(nextZoom);
      setPan(
        clampLogicPan(
          {
            x: center.x - stageCenter.x - zoomRatio * (previous.center.x - stageCenter.x - previous.pan.x),
            y: center.y - stageCenter.y - zoomRatio * (previous.center.y - stageCenter.y - previous.pan.y),
          },
          nextZoom,
        ),
      );
      return;
    }
    if (event.touches.length === 1 && dragRef.current) {
      event.preventDefault();
      const current = touchPoint(event.touches[0]);
      const previous = dragRef.current;
      dragRef.current = current;
      setPan((value) => clampLogicPan({ x: value.x + current.x - previous.x, y: value.y + current.y - previous.y }));
    }
  }

  function handleTouchEnd(event: TouchEvent<HTMLElement>) {
    if (event.touches.length === 1) {
      dragRef.current = touchPoint(event.touches[0]);
      pinchRef.current = null;
      return;
    }
    dragRef.current = null;
    pinchRef.current = null;
  }

  const cameraStyle = {
    '--canvas-origin-x': `${(stageWidth || 0) / 2 + pan.x}px`,
    '--canvas-origin-y': `${(stageHeight || 0) / 2 + pan.y}px`,
    '--canvas-zoom': zoom,
    '--canvas-center-x': `${bounds.centerX}px`,
    '--canvas-center-y': `${bounds.centerY}px`,
  } as CSSProperties;
  const gridPadding = 840;
  const gridStyle = {
    left: `${bounds.minX - gridPadding}px`,
    top: `${bounds.minY - gridPadding}px`,
    width: `${bounds.width + gridPadding * 2}px`,
    height: `${bounds.height + gridPadding * 2}px`,
  } as CSSProperties;

  return (
    <section
      ref={stageRef}
      className="viewer-stage logic-stage"
      onTouchStart={handleTouchStart}
      onTouchMove={handleTouchMove}
      onTouchEnd={handleTouchEnd}
      onTouchCancel={handleTouchEnd}
      onWheel={onWheel}
    >
      {simulatedNodes.length === 0 ? (
        <EmptyState
          icon={<CircuitBoard size={28} aria-hidden />}
          title="Empty logic diagram"
          message="This logic file does not contain any nodes yet."
        />
      ) : (
        <>
          <div className="logic-sim-toolbar">
            {logic.diagramMode === 'schematic' ? (
              <>
                <span className="logic-stat">{simulatedNodes.length} symbols</span>
                <span className="logic-stat">{logic.wires.length} wires</span>
                <button
                  type="button"
                  className="logic-circuit-action"
                  aria-label={circuitRunning && circuitRunKind === 'dc' ? 'Cancel DC simulation' : 'Run DC simulation'}
                  disabled={(circuitRunning && circuitRunKind !== 'dc') || (circuitRunning && (!circuitStatus || circuitStatus.phase === 'cancelling'))}
                  onTouchStart={(event) => event.stopPropagation()}
                  onClick={() => circuitRunning && circuitRunKind === 'dc' ? void cancelDcSimulation() : void runDcSimulation()}
                >
                  {circuitRunning && circuitRunKind === 'dc' && (!circuitStatus || circuitStatus.phase === 'cancelling')
                    ? <Spinner size={14} />
                    : circuitRunning && circuitRunKind === 'dc' ? <X size={14} aria-hidden /> : <Play size={14} aria-hidden />}
                  <span>{circuitRunning && circuitRunKind === 'dc' ? circuitStageLabel(circuitStatus) : 'Run DC'}</span>
                </button>
                {logic.simulation?.dcSweep ? (
                  <button
                    type="button"
                    className="logic-circuit-action"
                    aria-label={circuitRunning && circuitRunKind === 'sweep' ? 'Cancel DC sweep' : 'Run DC sweep'}
                    disabled={(circuitRunning && circuitRunKind !== 'sweep') || (circuitRunning && (!circuitStatus || circuitStatus.phase === 'cancelling'))}
                    onTouchStart={(event) => event.stopPropagation()}
                    onClick={() => circuitRunning && circuitRunKind === 'sweep' ? void cancelDcSimulation() : void runDcSweep()}
                  >
                    {circuitRunning && circuitRunKind === 'sweep' && (!circuitStatus || circuitStatus.phase === 'cancelling')
                      ? <Spinner size={14} />
                      : circuitRunning && circuitRunKind === 'sweep' ? <X size={14} aria-hidden /> : <ChartLine size={14} aria-hidden />}
                    <span>{circuitRunning && circuitRunKind === 'sweep' ? circuitStageLabel(circuitStatus) : 'Sweep'}</span>
                  </button>
                ) : null}
                {logic.simulation?.transient ? (
                  <button
                    type="button"
                    className="logic-circuit-action"
                    aria-label={circuitRunning && circuitRunKind === 'transient' ? 'Cancel transient analysis' : 'Run transient analysis'}
                    disabled={(circuitRunning && circuitRunKind !== 'transient') || (circuitRunning && (!circuitStatus || circuitStatus.phase === 'cancelling'))}
                    onTouchStart={(event) => event.stopPropagation()}
                    onClick={() => circuitRunning && circuitRunKind === 'transient' ? void cancelDcSimulation() : void runTransient()}
                  >
                    {circuitRunning && circuitRunKind === 'transient' && (!circuitStatus || circuitStatus.phase === 'cancelling')
                      ? <Spinner size={14} />
                      : circuitRunning && circuitRunKind === 'transient' ? <X size={14} aria-hidden /> : <Activity size={14} aria-hidden />}
                    <span>{circuitRunning && circuitRunKind === 'transient' ? circuitStageLabel(circuitStatus) : 'Transient'}</span>
                  </button>
                ) : null}
                {!circuitResultsOpen && (circuitResult || circuitError) ? (
                  <button
                    type="button"
                    className="logic-circuit-result-button"
                    aria-label="Show DC results"
                    onTouchStart={(event) => event.stopPropagation()}
                    onClick={() => {
                      setSweepResultsOpen(false);
                      setTransientResultsOpen(false);
                      setCircuitResultsOpen(true);
                    }}
                  >
                    <Zap size={14} aria-hidden />
                  </button>
                ) : null}
                {!sweepResultsOpen && (sweepResult || sweepError) ? (
                  <button
                    type="button"
                    className="logic-circuit-result-button"
                    aria-label="Show DC sweep results"
                    onTouchStart={(event) => event.stopPropagation()}
                    onClick={() => {
                      setCircuitResultsOpen(false);
                      setTransientResultsOpen(false);
                      setSweepResultsOpen(true);
                    }}
                  >
                    <ChartLine size={14} aria-hidden />
                  </button>
                ) : null}
                {!transientResultsOpen && (transientResult || transientError) ? (
                  <button
                    type="button"
                    className="logic-circuit-result-button"
                    aria-label="Show transient results"
                    onTouchStart={(event) => event.stopPropagation()}
                    onClick={() => {
                      setCircuitResultsOpen(false);
                      setSweepResultsOpen(false);
                      setTransientResultsOpen(true);
                    }}
                  >
                    <Activity size={14} aria-hidden />
                  </button>
                ) : null}
              </>
            ) : (
              <>
                <span className="logic-stat">{inputNodes.length} inputs</span>
                <span className="logic-stat">{outputNodes.length} outputs</span>
                {evaluation.warnings.length > 0 ? <span className="logic-stat">{evaluation.warnings.length} warnings</span> : null}
              </>
            )}
          </div>
          <div className="mobile-canvas-camera mobile-logic-camera" style={cameraStyle}>
            <div className="mobile-canvas-grid mobile-logic-grid" style={gridStyle} aria-hidden />
            <svg
              className="mobile-logic-edges"
              style={{
                left: `${bounds.minX}px`,
                top: `${bounds.minY}px`,
                width: `${bounds.width}px`,
                height: `${bounds.height}px`,
              }}
              viewBox={`${bounds.minX} ${bounds.minY} ${bounds.width} ${bounds.height}`}
              aria-hidden
            >
              <defs>
                <marker
                  id="mobile-logic-arrow"
                  viewBox="0 0 12 10"
                  refX="5.6"
                  refY="5"
                  markerWidth="9"
                  markerHeight="9"
                  markerUnits="strokeWidth"
                  orient="auto"
                >
                  <path d="M10.6 5L5.2 1.6C3.6 0.6 1.6 1.75 1.6 3.62V6.38C1.6 8.25 3.6 9.4 5.2 8.4L10.6 5Z" />
                </marker>
              </defs>
              {logic.wires.map((wire) => {
                const sourceNode = nodeById.get(wire.source);
                const targetNode = nodeById.get(wire.target);
                if (!sourceNode || !targetNode) return null;
                const geometry = logicWireGeometry(
                  sourceNode,
                  targetNode,
                  wire.sourceHandle,
                  wire.targetHandle,
                  nodeById,
                );
                if (!geometry) return null;
                const circuitPolarity = logic.diagramMode === 'schematic'
                  ? circuitWirePolarities.get(wire.id) ?? null
                  : null;
                return (
                  <path
                    key={wire.id}
                    className={`mobile-logic-wire ${logic.diagramMode === 'schematic' ? `schematic ${circuitPolarity ?? ''}` : logicSignalClass(evaluation.wireValues[wire.id])}`}
                    d={geometry.path}
                    markerEnd={logic.diagramMode === 'schematic' ? undefined : 'url(#mobile-logic-arrow)'}
                    data-logic-wire-id={wire.id}
                    data-circuit-polarity={circuitPolarity ?? undefined}
                  />
                );
              })}
            </svg>
            {simulatedNodes.map((node) => (
              <MobileLogicNode
                key={node.id}
                node={node}
                nodeById={nodeById}
                value={evaluation.nodeValues[node.id]}
                onToggleInput={node.kind === 'input'
                  ? () => setInputValues((current) => ({ ...current, [node.id]: !(current[node.id] ?? node.value ?? false) }))
                  : undefined}
                schematicSymbolSet={schematicSymbolSet}
              />
            ))}
          </div>
          {logic.diagramMode !== 'schematic' && evaluation.warnings.length > 0 ? (
            <div className="logic-warning-strip">
              {evaluation.warnings.slice(0, 2).map((warning) => (
                <span key={`${warning.code}-${warning.nodeId}-${warning.message}`}>{warning.message}</span>
              ))}
            </div>
          ) : null}
          {logic.diagramMode === 'schematic' && circuitResultsOpen ? (
            <MobileCircuitResults
              logic={logic}
              result={circuitResult}
              error={circuitError}
              running={circuitRunning}
              status={circuitStatus}
              onClose={() => setCircuitResultsOpen(false)}
            />
          ) : null}
          {logic.diagramMode === 'schematic' && sweepResultsOpen ? (
            <MobileCircuitSweepResults
              logic={logic}
              result={sweepResult}
              error={sweepError}
              running={circuitRunning && circuitRunKind === 'sweep'}
              status={circuitStatus}
              onClose={() => setSweepResultsOpen(false)}
            />
          ) : null}
          {logic.diagramMode === 'schematic' && transientResultsOpen ? (
            <MobileCircuitTransientResults
              result={transientResult}
              error={transientError}
              running={circuitRunning && circuitRunKind === 'transient'}
              status={circuitStatus}
              onClose={() => setTransientResultsOpen(false)}
            />
          ) : null}
        </>
      )}
    </section>
  );
}

function MobileCircuitTransientResults({
  result,
  error,
  running,
  status,
  onClose,
}: {
  result: CircuitTransientResult | null;
  error: string | null;
  running: boolean;
  status: CircuitJobStatus | null;
  onClose: () => void;
}) {
  return (
    <aside className="mobile-circuit-results mobile-circuit-sweep-results" aria-label="Transient results">
      <header>
        <Activity size={16} aria-hidden />
        <strong>Transient analysis</strong>
        <button type="button" className="icon-button" aria-label="Close transient results" onClick={onClose}>
          <X size={15} aria-hidden />
        </button>
      </header>
      <div className="mobile-circuit-results-body">
        {running ? (
          <div className="mobile-circuit-status">
            <Spinner size={15} />
            <span>{circuitStageLabel(status)}</span>
            {status ? <small>{status.elapsedMillis} ms</small> : null}
          </div>
        ) : null}
        {error && !running ? (
          <div className="mobile-circuit-error">
            <strong>Transient analysis failed</strong>
            <span>{error}</span>
          </div>
        ) : null}
        {result && !running ? (
          <>
            <p className="mobile-circuit-summary">
              {result.sampleCount.toLocaleString()} samples · {result.traces.length} {result.traces.length === 1 ? 'trace' : 'traces'}
            </p>
            <CircuitTransientPlot result={result} />
          </>
        ) : null}
      </div>
    </aside>
  );
}

function MobileCircuitSweepResults({
  logic,
  result,
  error,
  running,
  status,
  onClose,
}: {
  logic: LogicDiagramDocument;
  result: CircuitSweepResult | null;
  error: string | null;
  running: boolean;
  status: CircuitJobStatus | null;
  onClose: () => void;
}) {
  const sourceNode = result ? logic.nodes.find((node) => node.id === result.source) : null;
  return (
    <aside className="mobile-circuit-results mobile-circuit-sweep-results" aria-label="DC sweep results">
      <header>
        <ChartLine size={16} aria-hidden />
        <strong>DC source sweep</strong>
        <button type="button" className="icon-button" aria-label="Close DC sweep results" onClick={onClose}>
          <X size={15} aria-hidden />
        </button>
      </header>
      <div className="mobile-circuit-results-body">
        {running ? (
          <div className="mobile-circuit-status">
            <Spinner size={15} />
            <span>{circuitStageLabel(status)}</span>
            {status ? <small>{status.elapsedMillis} ms</small> : null}
          </div>
        ) : null}
        {error && !running ? (
          <div className="mobile-circuit-error">
            <strong>Sweep failed</strong>
            <span>{error}</span>
          </div>
        ) : null}
        {result && !running ? (
          <>
            <p className="mobile-circuit-summary">
              {result.sampleCount.toLocaleString()} samples · {result.traces.length} {result.traces.length === 1 ? 'trace' : 'traces'}
            </p>
            <CircuitSweepPlot
              result={result}
              sourceLabel={sourceNode ? logicNodeLabel(sourceNode) : result.source}
            />
          </>
        ) : null}
      </div>
    </aside>
  );
}

function MobileCircuitResults({
  logic,
  result,
  error,
  running,
  status,
  onClose,
}: {
  logic: LogicDiagramDocument;
  result: CircuitDcResult | null;
  error: string | null;
  running: boolean;
  status: CircuitJobStatus | null;
  onClose: () => void;
}) {
  const nodeById = new Map(logic.nodes.map((node) => [node.id, node]));
  const terminalsByNet = new Map<string, CircuitDcResult['sourceMap']['terminals']>();
  for (const terminal of result?.sourceMap.terminals ?? []) {
    const terminals = terminalsByNet.get(terminal.electricalNode) ?? [];
    terminals.push(terminal);
    terminalsByNet.set(terminal.electricalNode, terminals);
  }
  const voltageRows = Object.entries(result?.operatingPoint.nodeVoltages ?? {})
    .map(([electricalNode, voltage]) => {
      const terminal = terminalsByNet.get(electricalNode)?.[0];
      const node = terminal ? nodeById.get(terminal.terminal.nodeId) : null;
      const label = electricalNode === '0'
        ? 'Ground'
        : node && terminal
          ? `${logicNodeLabel(node)} - ${terminal.terminal.handleId}`
          : electricalNode;
      return { electricalNode, label, voltage };
    })
    .sort((left, right) => left.label.localeCompare(right.label));
  const currentRows = Object.entries(result?.operatingPoint.componentCurrents ?? {})
    .map(([componentId, current]) => ({
      componentId,
      label: nodeById.has(componentId) ? logicNodeLabel(nodeById.get(componentId)!) : componentId,
      current,
    }))
    .sort((left, right) => left.label.localeCompare(right.label));
  const powerRows = Object.entries(result?.operatingPoint.componentPowers ?? {})
    .map(([componentId, power]) => ({
      componentId,
      label: nodeById.has(componentId) ? logicNodeLabel(nodeById.get(componentId)!) : componentId,
      power,
    }))
    .sort((left, right) => left.label.localeCompare(right.label));

  return (
    <aside
      className="mobile-circuit-results"
      role="dialog"
      aria-label="DC operating point"
      onTouchStart={(event) => event.stopPropagation()}
      onTouchMove={(event) => event.stopPropagation()}
    >
      <header>
        {running ? <Spinner size={16} /> : <Zap size={16} aria-hidden />}
        <strong>DC operating point</strong>
        <button type="button" className="icon-button" aria-label="Close DC results" onClick={onClose}>
          <X size={15} aria-hidden />
        </button>
      </header>
      <div className="mobile-circuit-results-body">
        {running ? (
          <div className="mobile-circuit-status">
            <Spinner size={15} />
            <span>{circuitStageLabel(status)}</span>
            {status ? <small>{status.elapsedMillis} ms</small> : null}
          </div>
        ) : null}
        {error && !running ? (
          <div className="mobile-circuit-error">
            <strong>Simulation failed</strong>
            <span>{error}</span>
          </div>
        ) : null}
        {result && !running ? (
          <>
            <p className="mobile-circuit-summary">
              Converged in {result.operatingPoint.iterations} {result.operatingPoint.iterations === 1 ? 'iteration' : 'iterations'}
            </p>
            {result.operatingPoint.diagnostics.map((diagnostic) => (
              <div className="mobile-circuit-warning" key={`${diagnostic.code}-${diagnostic.context.component}`}>
                {nodeById.has(diagnostic.context.component)
                  ? logicNodeLabel(nodeById.get(diagnostic.context.component)!)
                  : diagnostic.context.component}{' '}
                entered unsupported reverse-active operation.
              </div>
            ))}
            {result.probeValues.length > 0 ? (
              <section>
                <h3>Probes</h3>
                <div className="mobile-circuit-table">
                  {result.probeValues.map((probe) => (
                    <div key={probe.probeId}>
                      <span>{probe.label || probe.probeId}</span>
                      <code>{probe.kind === 'node-voltage'
                        ? formatCircuitMeasurement(probe.valueVolts, 'V')
                        : formatCircuitMeasurement(probe.valueAmps, 'A')}</code>
                    </div>
                  ))}
                </div>
              </section>
            ) : null}
            <section>
              <h3>Node voltages</h3>
              <div className="mobile-circuit-table">
                {voltageRows.map((row) => (
                  <div key={row.electricalNode}>
                    <span>{row.label}</span>
                    <code>{formatCircuitMeasurement(row.voltage, 'V')}</code>
                  </div>
                ))}
              </div>
            </section>
            <section>
              <h3>Component currents</h3>
              <div className="mobile-circuit-table">
                {currentRows.map((row) => (
                  <div key={row.componentId}>
                    <span>{row.label}</span>
                    <code>{formatCircuitMeasurement(row.current, 'A')}</code>
                  </div>
                ))}
              </div>
            </section>
            <section>
              <h3>Component power</h3>
              <div className="mobile-circuit-table">
                {powerRows.map((row) => (
                  <div key={row.componentId}>
                    <span>{row.label}</span>
                    <code>{formatCircuitMeasurement(row.power, 'W')}</code>
                  </div>
                ))}
              </div>
            </section>
          </>
        ) : null}
      </div>
    </aside>
  );
}

function MobileLogicNode({
  node,
  nodeById,
  value,
  onToggleInput,
  schematicSymbolSet,
}: {
  node: LogicDiagramNode;
  nodeById: Map<string, LogicDiagramNode>;
  value: LogicSignal;
  onToggleInput?: () => void;
  schematicSymbolSet: SchematicSymbolSet;
}) {
  const position = absoluteLogicNodePosition(node, nodeById);
  const inputHandles = getLogicInputHandles(node.kind, node.component);
  const outputHandles = getLogicOutputHandles(node.kind, node.component);
  const style = {
    left: `${position.x}px`,
    top: `${position.y}px`,
    width: `${logicNodeWidth(node)}px`,
    height: `${logicNodeHeight(node)}px`,
  } as CSSProperties;

  if (node.kind === 'group') {
    return (
      <div className="mobile-logic-node mobile-logic-group" style={style}>
        <strong>{logicNodeLabel(node)}</strong>
      </div>
    );
  }

  if (isElectronicComponentKind(node.kind)) {
    const kind = node.kind;
    const rotation = node.rotation ?? 0;
    const terminals = getSchematicTerminals(kind);
    return (
      <div className="mobile-logic-node mobile-logic-schematic" style={style}>
        {terminals.map((handleId) => {
          const point = schematicTerminalPoint(kind, handleId, rotation);
          return (
            <span
              key={handleId}
              className={`mobile-logic-handle${kind === 'junction' ? ' junction' : ''}`}
              style={{ left: `${point.x - 4.5}px`, top: `${point.y}px` }}
            />
          );
        })}
        <svg viewBox={schematicSymbolViewBox(rotation)} aria-hidden>
          <g
            transform={schematicSymbolTransform(rotation) || undefined}
            dangerouslySetInnerHTML={{ __html: schematicSymbolMarkup(kind, 'currentColor', schematicSymbolSet) }}
          />
        </svg>
        {kind !== 'junction' ? <strong>{logicNodeLabel(node)}</strong> : null}
      </div>
    );
  }

  const content = (
    <>
      {inputHandles.map((handleId, index) => (
        <span
          key={handleId}
          className="mobile-logic-handle input"
          style={{ top: `${logicHandleRatio(index, inputHandles.length) * 100}%` }}
        />
      ))}
      <span className="mobile-logic-kind">{node.kind === 'component' ? 'COMP' : node.kind}</span>
      <strong>{logicNodeLabel(node)}</strong>
      <span className={`mobile-logic-value ${logicSignalClass(value)}`}>{logicSignalLabel(value)}</span>
      {node.kind === 'component' ? (
        <span className="mobile-logic-component-ports">
          {node.component?.definition.ports
            .filter((port) => port.direction === 'input')
            .map((port) => port.label)
            .join(', ') || 'inputs'}
          {' / '}
          {node.component?.definition.ports
            .filter((port) => port.direction === 'output')
            .map((port) => port.label)
            .join(', ') || 'outputs'}
        </span>
      ) : null}
      {outputHandles.map((handleId, index) => (
        <span
          key={handleId}
          className="mobile-logic-handle output"
          style={{ top: `${logicHandleRatio(index, outputHandles.length) * 100}%` }}
        />
      ))}
    </>
  );

  if (onToggleInput) {
    return (
      <button
        type="button"
        className={`mobile-logic-node mobile-logic-gate mobile-logic-input ${logicSignalClass(value)}`}
        style={style}
        onClick={onToggleInput}
      >
        {content}
      </button>
    );
  }

  return (
    <div className={`mobile-logic-node mobile-logic-gate mobile-logic-${node.kind} ${logicSignalClass(value)}`} style={style}>
      {content}
    </div>
  );
}

function PdfMobileViewer({
  file,
  dataUrl,
  zoom,
  setZoom,
}: {
  file: HostedFileEntry;
  dataUrl: string;
  zoom: number;
  setZoom: Dispatch<SetStateAction<number>>;
}) {
  const stageRef = useRef<HTMLDivElement | null>(null);
  const swipeStartRef = useRef<{ x: number; y: number } | null>(null);
  const dragRef = useRef<TouchPoint | null>(null);
  const pinchRef = useRef<{ distance: number; center: TouchPoint } | null>(null);
  const [document, setDocument] = useState<PDFDocumentProxy | null>(null);
  const [pageNumber, setPageNumber] = useState(1);
  const [pageDirection, setPageDirection] = useState<0 | -1 | 1>(0);
  const [pan, setPan] = useState<TouchPoint>({ x: 0, y: 0 });
  const [pageCount, setPageCount] = useState(0);
  const [layoutMode, setLayoutMode] = useState<PdfLayoutMode>('single');
  const [pageWidths, setPageWidths] = useState<Record<number, number>>({});
  const [stageWidth] = useElementSize(stageRef);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const scale = useMemo(() => clamp(zoom, 0.45, 3.5), [zoom]);
  const pages = useMemo(
    () => Array.from({ length: pageCount }, (_, index) => index + 1),
    [pageCount],
  );
  const widestPage = useMemo(
    () => Math.max(0, ...Object.values(pageWidths)),
    [pageWidths],
  );
  const handlePageMeasured = useCallback((measuredPage: number, size: MobilePdfPageSize) => {
    setPageWidths((current) => current[measuredPage] === size.width
      ? current
      : { ...current, [measuredPage]: size.width });
  }, []);

  useEffect(() => {
    let cancelled = false;
    setBusy(true);
    setError(null);
    setDocument(null);
    setPageNumber(1);
    setPageCount(0);
    setPageWidths({});
    let task: ReturnType<typeof getDocument> | null = null;
    uint8ArrayFromDataUrlChunked(dataUrl)
      .then((data) => {
        if (cancelled) return null;
        task = getDocument({ data });
        return task.promise;
      })
      .then((pdf) => {
        if (!pdf) return;
        if (cancelled) {
          void pdf.destroy();
          return;
        }
        setDocument(pdf);
        setPageCount(pdf.numPages);
      })
      .catch((reason: unknown) => {
        if (!cancelled) setError(reason instanceof Error ? reason.message : String(reason));
      })
      .finally(() => {
        if (!cancelled) setBusy(false);
      });
    return () => {
      cancelled = true;
      task?.destroy();
    };
  }, [dataUrl]);

  useEffect(() => () => void document?.destroy(), [document]);

  useEffect(() => {
    setPan({ x: 0, y: 0 });
  }, [dataUrl, layoutMode, pageNumber]);

  useEffect(() => {
    if (zoom <= 1) setPan({ x: 0, y: 0 });
  }, [zoom]);

  useEffect(() => {
    const stage = stageRef.current;
    if (!stage || layoutMode !== 'scroll') return;
    const frame = window.requestAnimationFrame(() => {
      stage.scrollLeft = scale > 1
        ? Math.max(0, (stage.scrollWidth - stage.clientWidth) / 2)
        : 0;
    });
    return () => window.cancelAnimationFrame(frame);
  }, [layoutMode, scale, stageWidth, widestPage]);

  function clampPdfPan(next: TouchPoint, nextZoom = zoom): TouchPoint {
    const stage = stageRef.current;
    if (!stage || layoutMode !== 'single' || nextZoom <= 1) return { x: 0, y: 0 };
    const limitX = Math.max(0, (stage.clientWidth * (nextZoom - 1)) / 2);
    const limitY = Math.max(0, (stage.clientHeight * (nextZoom - 1)) / 2);
    return {
      x: clamp(next.x, -limitX, limitX),
      y: clamp(next.y, -limitY, limitY),
    };
  }

  function changePage(delta: -1 | 1) {
    setPageNumber((page) => {
      const nextPage = clamp(page + delta, 1, Math.max(1, pageCount));
      if (nextPage !== page) setPageDirection(delta);
      return nextPage;
    });
  }

  function handleTouchStart(event: TouchEvent<HTMLElement>) {
    if (event.touches.length === 2) {
      const first = touchPoint(event.touches[0]);
      const second = touchPoint(event.touches[1]);
      pinchRef.current = { distance: distanceBetween(first, second), center: midpoint(first, second) };
      swipeStartRef.current = null;
      dragRef.current = null;
      return;
    }
    pinchRef.current = null;
    if (layoutMode !== 'single' || event.touches.length !== 1) return;
    const point = touchPoint(event.touches[0]);
    if (zoom > 1) {
      dragRef.current = point;
      swipeStartRef.current = null;
      return;
    }
    swipeStartRef.current = point;
  }

  function handleTouchMove(event: TouchEvent<HTMLElement>) {
    if (event.touches.length === 2 && pinchRef.current) {
      event.preventDefault();
      const first = touchPoint(event.touches[0]);
      const second = touchPoint(event.touches[1]);
      const center = midpoint(first, second);
      const distance = distanceBetween(first, second);
      const previous = pinchRef.current;
      const ratio = distance / Math.max(1, previous.distance);
      pinchRef.current = { distance, center };
      setZoom((value) => {
        const nextZoom = clamp(Number((value * ratio).toFixed(3)), 0.5, 4);
        setPan((current) =>
          clampPdfPan(
            {
              x: current.x + center.x - previous.center.x,
              y: current.y + center.y - previous.center.y,
            },
            nextZoom,
          ),
        );
        return nextZoom;
      });
      return;
    }

    if (layoutMode === 'single' && event.touches.length === 1 && dragRef.current && zoom > 1) {
      event.preventDefault();
      const current = touchPoint(event.touches[0]);
      const previous = dragRef.current;
      dragRef.current = current;
      setPan((value) => clampPdfPan({ x: value.x + current.x - previous.x, y: value.y + current.y - previous.y }));
    }
  }

  function handleTouchEnd(event: TouchEvent<HTMLElement>) {
    pinchRef.current = null;
    if (event.touches.length === 1 && zoom > 1) {
      dragRef.current = touchPoint(event.touches[0]);
      swipeStartRef.current = null;
      return;
    }
    dragRef.current = null;
    const start = swipeStartRef.current;
    swipeStartRef.current = null;
    if (layoutMode !== 'single' || !start || event.changedTouches.length === 0) return;
    const touch = event.changedTouches[0];
    const dx = touch.clientX - start.x;
    const dy = touch.clientY - start.y;
    if (Math.abs(dx) < 56 || Math.abs(dx) < Math.abs(dy) * 1.35) return;
    event.preventDefault();
    changePage(dx < 0 ? 1 : -1);
  }

  const singlePageStyle = {
    '--viewer-pan-x': `${pan.x}px`,
    '--viewer-pan-y': `${pan.y}px`,
  } as CSSProperties;

  function handleStageScroll() {
    if (layoutMode !== 'scroll') return;
    const stage = stageRef.current;
    if (!stage) return;
    const pages = Array.from(stage.querySelectorAll<HTMLElement>('[data-pdf-page]'));
    if (pages.length === 0) return;
    const stageTop = stage.getBoundingClientRect().top;
    let nearestPage = pageNumber;
    let nearestDistance = Number.POSITIVE_INFINITY;
    for (const page of pages) {
      const pageTop = page.getBoundingClientRect().top;
      const distance = Math.abs(pageTop - stageTop - 12);
      if (distance < nearestDistance) {
        nearestDistance = distance;
        nearestPage = Number(page.dataset.pdfPage ?? nearestPage);
      }
    }
    if (nearestPage !== pageNumber) setPageNumber(nearestPage);
  }

  return (
    <section className="pdf-viewer">
      <div className="pdf-toolbar">
        <div className="segmented-control compact pdf-mode-control" aria-label="PDF layout">
          <button
            type="button"
            className={layoutMode === 'single' ? 'selected' : ''}
            onClick={() => setLayoutMode('single')}
          >
            Single
          </button>
          <button
            type="button"
            className={layoutMode === 'scroll' ? 'selected' : ''}
            onClick={() => setLayoutMode('scroll')}
          >
            Scroll
          </button>
        </div>
        <span>{pageCount > 0 ? `${pageNumber} / ${pageCount}` : file.name}</span>
      </div>
      {error ? <Banner tone="error">{error}</Banner> : null}
      {busy ? (
        <div className="loading-block compact-loading">
          <Spinner size={18} />
          <span>Rendering page...</span>
        </div>
      ) : null}
      <div
        ref={stageRef}
        className={`viewer-stage pdf-stage pdf-stage-${layoutMode}${layoutMode === 'scroll' && scale > 1 ? ' is-horizontally-zoomed' : ''}`}
        onTouchStart={handleTouchStart}
        onTouchMove={handleTouchMove}
        onTouchEnd={handleTouchEnd}
        onTouchCancel={handleTouchEnd}
        onScroll={handleStageScroll}
      >
        {document && stageWidth > 0 && layoutMode === 'single' ? (
          <div
            key={pageNumber}
            className={`pdf-single-page ${pageDirection === 1 ? 'from-right' : pageDirection === -1 ? 'from-left' : ''}`}
            style={singlePageStyle}
            onAnimationEnd={() => setPageDirection(0)}
          >
            <PdfPageCanvas
              document={document}
              pageNumber={pageNumber}
              stageWidth={stageWidth}
              zoom={scale}
              eager
              onError={setError}
            />
          </div>
        ) : null}
        {document && stageWidth > 0 && layoutMode === 'scroll' ? (
          <div
            className="pdf-scroll-stack"
            style={widestPage > 0 ? { width: `max(100%, ${widestPage}px)` } : undefined}
          >
            {pages.map((page) => (
              <PdfPageCanvas
                key={page}
                document={document}
                pageNumber={page}
                stageWidth={stageWidth}
                zoom={scale}
                eager={page <= 2}
                onError={setError}
                onMeasured={handlePageMeasured}
              />
            ))}
          </div>
        ) : null}
      </div>
    </section>
  );
}

function PdfPageCanvas({
  document,
  pageNumber,
  stageWidth,
  zoom,
  eager,
  onError,
  onMeasured,
}: {
  document: PDFDocumentProxy;
  pageNumber: number;
  stageWidth: number;
  zoom: number;
  eager: boolean;
  onError: (message: string | null) => void;
  onMeasured?: (pageNumber: number, size: MobilePdfPageSize) => void;
}) {
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const renderTaskRef = useRef<RenderTask | null>(null);
  const [visible, setVisible] = useState(eager);
  const [rendering, setRendering] = useState(false);
  const [pageSize, setPageSize] = useState<MobilePdfPageSize | null>(null);

  useEffect(() => {
    if (eager) {
      setVisible(true);
      return;
    }
    const node = wrapperRef.current;
    if (!node) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setVisible(true);
          observer.disconnect();
        }
      },
      { rootMargin: '700px 0px' },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [eager]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let cancelled = false;
    setRendering(visible);
    onError(null);
    renderTaskRef.current?.cancel();
    document
      .getPage(pageNumber)
      .then((page) => {
        if (cancelled) return;
        const naturalViewport = page.getViewport({ scale: 1 });
        const nextPageSize = calculateMobilePdfPageSize({
          naturalWidth: naturalViewport.width,
          naturalHeight: naturalViewport.height,
          stageWidth,
          zoom,
        });
        setPageSize(nextPageSize);
        onMeasured?.(pageNumber, nextPageSize);
        if (!visible) return;

        const displayScale = nextPageSize.width / naturalViewport.width;
        const pixelRatio = clamp(window.devicePixelRatio || 1, 1, 2);
        const renderViewport = page.getViewport({ scale: displayScale * pixelRatio });
        const context = canvas.getContext('2d', { alpha: false });
        if (!context) throw new Error('Could not create the PDF canvas context.');
        canvas.width = Math.max(1, Math.ceil(renderViewport.width));
        canvas.height = Math.max(1, Math.ceil(renderViewport.height));
        canvas.style.width = `${nextPageSize.width}px`;
        canvas.style.height = `${nextPageSize.height}px`;
        const task = page.render({ canvas, canvasContext: context, viewport: renderViewport });
        renderTaskRef.current = task;
        return task.promise;
      })
      .catch((reason: unknown) => {
        if (!cancelled && !(reason instanceof Error && reason.name === 'RenderingCancelledException')) {
          onError(reason instanceof Error ? reason.message : String(reason));
        }
      })
      .finally(() => {
        if (!cancelled) setRendering(false);
      });
    return () => {
      cancelled = true;
      renderTaskRef.current?.cancel();
    };
  }, [document, onError, onMeasured, pageNumber, stageWidth, visible, zoom]);

  return (
    <div
      ref={wrapperRef}
      className="pdf-page-wrap"
      data-pdf-page={pageNumber}
      aria-label={`PDF page ${pageNumber}`}
      style={pageSize ? {
        height: `${pageSize.height}px`,
        minHeight: `${pageSize.height}px`,
      } : undefined}
    >
      {rendering ? (
        <div className="pdf-page-loading">
          <Spinner size={16} />
        </div>
      ) : null}
      <canvas ref={canvasRef} style={!visible ? { visibility: 'hidden' } : undefined} />
    </div>
  );
}

function useElementSize(ref: RefObject<HTMLElement | null>): [number, number] {
  const [size, setSize] = useState<[number, number]>([0, 0]);
  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    const update = () => setSize([node.clientWidth, node.clientHeight]);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(node);
    return () => observer.disconnect();
  }, [ref]);
  return size;
}
