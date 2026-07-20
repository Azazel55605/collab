import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent, type WheelEvent as ReactWheelEvent } from 'react';
import { getSmoothStepPath, type Connection, type Viewport } from '@xyflow/react';
import {
  Activity,
  CircuitBoard,
  ChartLine,
  Download,
  Group,
  Image,
  Loader2,
  Maximize2,
  Minus,
  Pencil,
  Pause,
  Play,
  Plus,
  Plus as PlusIcon,
  Power,
  RotateCcw,
  RotateCw,
  Save,
  Shapes,
  SlidersHorizontal,
  Table2,
  Trash2,
  Ungroup,
  X,
  Zap,
} from 'lucide-react';
import { toast } from 'sonner';

import { Button } from '../components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../components/ui/dialog';
import { Input } from '../components/ui/input';
import { Checkbox } from '../components/ui/checkbox';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../components/ui/select';
import {
  DocumentTopBar,
  DocumentTopBarButton,
  DocumentTopBarIconButton,
  documentTopBarGroupClass,
  getDocumentBaseName,
  getDocumentFolderPath,
} from '../components/layout/DocumentTopBar';
import {
  fromFlowGraph,
  logicComponentDimensions,
  logicHandleYOffset,
  logicNodeLabel,
  toFlowGraph,
  type LogicFlowEdge,
  type LogicFlowNode,
} from '../components/logic/logicDiagramFlow';
import {
  evaluateLogicDiagram,
  getLogicInputHandles,
  getLogicOutputHandles,
} from '../components/logic/logicDiagramEvaluator';
import {
  generateComponentTruthTable,
  generateLogicTruthTable,
} from '../components/logic/logicTruthTable';
import {
  captureLogicComponent,
  instantiateLogicComponentNode,
  logicDocumentFromComponent,
} from '../components/logic/logicDiagramComponents';
import {
  getLogicDiagramTemplates,
  instantiateLogicDiagramTemplate,
  type LogicDiagramTemplate,
} from '../components/logic/logicDiagramTemplates';
import { listen } from '@tauri-apps/api/event';

import { useEditorStore } from '../store/editorStore';
import { useVaultStore } from '../store/vaultStore';
import { useUiStore } from '../store/uiStore';
import { createVaultClient, type VaultClient } from '../lib/vaultClient';
import {
  compareDocumentVersions,
  useDocumentSessionController,
  type DocumentSessionController,
  type DocumentSessionSnapshot,
} from '../lib/documentSessionController';
import { saveConflictedCopy } from '../lib/conflictedCopy';
import { onReplicaMutated, replicaMutationAffectsPath } from '../lib/vaultReplica';
import { isVaultReadOnly } from '../types/vault';
import { useDocumentStatusRegistration } from '../store/documentStatusStore';
import { useCollabIdentity } from '../lib/collabIdentity';
import LivePeers from '../components/collaboration/LivePeers';
import { DocumentStatusPill } from '../components/layout/DocumentStatusPill';
import { useLivePeers } from '../lib/liveAwareness';
import { useLiveJsonDocumentSession, type JsonObject, type LiveJsonSession } from '../lib/liveJsonDocument';
import { useLiveDocumentStatus } from '../lib/useLiveDocumentStatus';
import { getMarkdownImageTarget } from '../lib/noteAssets';
import { buildLogicDiagramSvg } from '../lib/logicDiagramExport';
import { flattenVaultFiles } from '../lib/vaultLinks';
import { tauriCommands, type CircuitDcResult, type CircuitJobStatus, type CircuitSweepResult, type CircuitTransientResult } from '../lib/tauri';
import { runCircuitJob, type CircuitJobClient } from '../lib/circuitJobRunner';
import { runCircuitSweepJob, type CircuitSweepJobClient } from '../lib/circuitSweepRunner';
import { runCircuitTransientJob, type CircuitTransientJobClient } from '../lib/circuitTransientRunner';
import { circuitErrorText } from '../lib/circuitErrorText';
import { CircuitSweepPlot, CircuitTransientPlot } from '../components/logic/CircuitSweepPlot';
import {
  buildCircuitSweepCsv,
  buildCircuitSweepSvg,
  utf8ToBase64,
} from '../lib/circuitSweepExport';
import {
  createEmptyLogicDiagram,
  defaultSchematicElectricalParameters,
  normalizeLogicDiagramDocument,
  type LogicDiagramDocument,
  type LogicComponentDefinition,
  type LogicComponentInstanceMode,
  type LogicGateKind,
  type ElectronicComponentKind,
  type LogicDiagramMode,
  type LogicCircuitProbe,
  type LogicNodeKind,
  type LogicSourceWaveform,
  type SchematicElectricalParameters,
  type SchematicSymbolSet,
} from '../types/logicDiagram';
import { isElectronicComponentKind } from '../types/logicDiagram';
import {
  getSchematicTerminals,
  rotateSchematicClockwise,
  SCHEMATIC_SYMBOL_CHOICES,
  schematicSymbolDimensions,
  schematicSymbolMarkup,
  schematicSymbolTransform,
  schematicSymbolViewBox,
  schematicTerminalPoint,
  schematicTerminalSide,
} from '../components/logic/schematicSymbols';
import type { NoteFile } from '../types/vault';
import { cn } from '../lib/utils';

interface Props {
  relativePath: string;
}

const GATE_CHOICES: Array<{ kind: LogicGateKind; label: string }> = [
  { kind: 'input', label: 'Input' },
  { kind: 'clock', label: 'Clock' },
  { kind: 'output', label: 'Output' },
  { kind: 'and', label: 'AND' },
  { kind: 'or', label: 'OR' },
  { kind: 'not', label: 'NOT' },
  { kind: 'xor', label: 'XOR' },
  { kind: 'nand', label: 'NAND' },
  { kind: 'nor', label: 'NOR' },
  { kind: 'xnor', label: 'XNOR' },
];
const SAVE_DEBOUNCE_MS = 600;
const LOGIC_GRID = 24;
const DEFAULT_GATE_WIDTH = 112;
const DEFAULT_GATE_HEIGHT = 64;
const GROUP_PADDING = 48;
const MIN_LOGIC_ZOOM = 0.2;
const MAX_LOGIC_ZOOM = 2.5;
const LOGIC_ZOOM_STEP = 1.15;
const LOGIC_WHEEL_ZOOM_SENSITIVITY = 0.0008;
const LOGIC_CONNECTION_SNAP_RADIUS = 28;
const DEFAULT_VIEWPORT: Viewport = { x: 0, y: 0, zoom: 1 };
const CONTEXT_MENU_WIDTH = 280;
const CONTEXT_MENU_HEIGHT = 420;
const DESKTOP_CIRCUIT_JOB_CLIENT: CircuitJobClient = {
  start: tauriCommands.circuitStartDc,
  status: tauriCommands.circuitJobStatus,
  takeResult: tauriCommands.circuitTakeJobResult,
};
const DESKTOP_SWEEP_JOB_CLIENT: CircuitSweepJobClient = {
  start: tauriCommands.circuitStartDcSweep,
  status: tauriCommands.circuitJobStatus,
  takeResult: tauriCommands.circuitTakeJobResult,
  readChunk: tauriCommands.circuitReadSweepChunk,
  discard: tauriCommands.circuitDiscardJob,
};
const DESKTOP_TRANSIENT_JOB_CLIENT: CircuitTransientJobClient = {
  start: tauriCommands.circuitStartTransient,
  status: tauriCommands.circuitJobStatus,
  takeResult: tauriCommands.circuitTakeJobResult,
  readChunk: tauriCommands.circuitReadTransientChunk,
  discard: tauriCommands.circuitDiscardJob,
};
const LOGIC_SIGNAL_ON = 'color-mix(in oklch, var(--primary) 82%, white 18%)';
const LOGIC_SIGNAL_OFF = 'color-mix(in oklch, var(--muted-foreground) 72%, transparent)';
const LOGIC_SIGNAL_UNKNOWN = 'color-mix(in oklch, var(--border) 88%, white 12%)';
const LOGIC_NODE_ACTIVE_WASH = 'color-mix(in oklch, var(--primary) 26%, transparent)';

type LogicContextMenu =
  | {
      kind: 'pane';
      x: number;
      y: number;
      flowPosition: { x: number; y: number };
    }
  | {
      kind: 'node';
      x: number;
      y: number;
      nodeId: string;
    }
  | {
      kind: 'edge';
      x: number;
      y: number;
      edgeId: string;
      flowPosition: { x: number; y: number };
    };

function snapValue(value: number, grid = LOGIC_GRID) {
  return Math.round(value / grid) * grid;
}

function snapPosition(position: { x: number; y: number }, grid = LOGIC_GRID) {
  return {
    x: snapValue(position.x, grid),
    y: snapValue(position.y, grid),
  };
}

function nodeBaseWidth(node: LogicFlowNode) {
  if (node.data.kind === 'group') return typeof node.style?.width === 'number' ? node.style.width : 240;
  if (node.data.kind === 'component') return logicComponentDimensions(node.data.component).width;
  if (isElectronicComponentKind(node.data.kind)) {
    return schematicSymbolDimensions(node.data.kind, node.data.rotation ?? 0).width;
  }
  return DEFAULT_GATE_WIDTH;
}

function nodeBaseHeight(node: LogicFlowNode) {
  if (node.data.kind === 'group') return typeof node.style?.height === 'number' ? node.style.height : 160;
  if (node.data.kind === 'component') return logicComponentDimensions(node.data.component).height;
  if (isElectronicComponentKind(node.data.kind)) {
    return schematicSymbolDimensions(node.data.kind, node.data.rotation ?? 0).height;
  }
  return DEFAULT_GATE_HEIGHT;
}

function absoluteNodePosition(node: LogicFlowNode, nodesById: Map<string, LogicFlowNode>): { x: number; y: number } {
  if (!node.parentId) return node.position;
  const parent = nodesById.get(node.parentId);
  if (!parent) return node.position;
  const parentPosition = absoluteNodePosition(parent, nodesById);
  return {
    x: parentPosition.x + node.position.x,
    y: parentPosition.y + node.position.y,
  };
}

function flowToScreen(position: { x: number; y: number }, viewport: Viewport) {
  return {
    x: position.x * viewport.zoom + viewport.x,
    y: position.y * viewport.zoom + viewport.y,
  };
}

function screenToFlow(position: { x: number; y: number }, viewport: Viewport) {
  return {
    x: (position.x - viewport.x) / viewport.zoom,
    y: (position.y - viewport.y) / viewport.zoom,
  };
}

function connectionSideToward(
  origin: { x: number; y: number },
  destination: { x: number; y: number },
): 'left' | 'right' | 'top' | 'bottom' {
  const dx = destination.x - origin.x;
  const dy = destination.y - origin.y;
  if (Math.abs(dx) >= Math.abs(dy)) return dx < 0 ? 'left' : 'right';
  return dy < 0 ? 'top' : 'bottom';
}

function closestPointOnSvgPath(
  path: SVGPathElement,
  point: { x: number; y: number },
) {
  if (typeof path.getTotalLength !== 'function' || typeof path.getPointAtLength !== 'function') {
    return point;
  }
  const totalLength = path.getTotalLength();
  if (!Number.isFinite(totalLength) || totalLength <= 0) return point;

  const distanceSquared = (candidate: DOMPoint) => (
    (candidate.x - point.x) ** 2 + (candidate.y - point.y) ** 2
  );
  const sampleCount = Math.max(24, Math.min(160, Math.ceil(totalLength / 8)));
  let bestLength = 0;
  let bestPoint = path.getPointAtLength(0);
  let bestDistance = distanceSquared(bestPoint);
  for (let index = 1; index <= sampleCount; index += 1) {
    const length = totalLength * index / sampleCount;
    const candidate = path.getPointAtLength(length);
    const distance = distanceSquared(candidate);
    if (distance < bestDistance) {
      bestLength = length;
      bestPoint = candidate;
      bestDistance = distance;
    }
  }

  let step = totalLength / sampleCount;
  for (let iteration = 0; iteration < 8; iteration += 1) {
    const beforeLength = Math.max(0, bestLength - step);
    const afterLength = Math.min(totalLength, bestLength + step);
    const before = path.getPointAtLength(beforeLength);
    const after = path.getPointAtLength(afterLength);
    const beforeDistance = distanceSquared(before);
    const afterDistance = distanceSquared(after);
    if (beforeDistance < bestDistance) {
      bestLength = beforeLength;
      bestPoint = before;
      bestDistance = beforeDistance;
    }
    if (afterDistance < bestDistance) {
      bestLength = afterLength;
      bestPoint = after;
      bestDistance = afterDistance;
    }
    step /= 2;
  }
  return { x: bestPoint.x, y: bestPoint.y };
}

function getHandleAnchor(
  node: LogicFlowNode,
  handleId: string,
  type: 'source' | 'target',
  nodesById: Map<string, LogicFlowNode>,
) {
  const absolute = absoluteNodePosition(node, nodesById);
  if (isElectronicComponentKind(node.data.kind)) {
    const point = schematicTerminalPoint(node.data.kind, handleId, node.data.rotation ?? 0);
    return { x: absolute.x + point.x, y: absolute.y + point.y };
  }
  const handles = type === 'source'
    ? getLogicOutputHandles(node.data.kind, node.data.component)
    : getLogicInputHandles(node.data.kind, node.data.component);
  const index = Math.max(0, handles.indexOf(handleId));
  const width = nodeBaseWidth(node);
  const height = nodeBaseHeight(node);
  return {
    x: absolute.x + (type === 'source' ? width : 0),
    y: absolute.y + logicHandleYOffset(node.data.kind, handles.length, index, height),
  };
}

function logicEdgePath(
  edge: LogicFlowEdge,
  nodesById: Map<string, LogicFlowNode>,
  viewport: Viewport,
) {
  const sourceNode = nodesById.get(edge.source);
  const targetNode = nodesById.get(edge.target);
  if (!sourceNode || !targetNode) return null;
  const sourceHandles = isElectronicComponentKind(sourceNode.data.kind)
    ? getSchematicTerminals(sourceNode.data.kind)
    : getLogicOutputHandles(sourceNode.data.kind, sourceNode.data.component);
  const targetHandles = isElectronicComponentKind(targetNode.data.kind)
    ? getSchematicTerminals(targetNode.data.kind)
    : getLogicInputHandles(targetNode.data.kind, targetNode.data.component);
  const sourceHandle = edge.sourceHandle && sourceHandles.includes(edge.sourceHandle)
    ? edge.sourceHandle
    : sourceHandles[0];
  const targetHandle = edge.targetHandle && targetHandles.includes(edge.targetHandle)
    ? edge.targetHandle
    : targetHandles[0];
  if (!sourceHandle || !targetHandle) return null;
  const source = flowToScreen(getHandleAnchor(sourceNode, sourceHandle, 'source', nodesById), viewport);
  const target = flowToScreen(getHandleAnchor(targetNode, targetHandle, 'target', nodesById), viewport);
  const sourcePosition = sourceNode.data.kind === 'junction'
    ? connectionSideToward(source, target)
    : isElectronicComponentKind(sourceNode.data.kind)
      ? schematicTerminalSide(sourceNode.data.kind, sourceHandle, sourceNode.data.rotation ?? 0)
    : 'right';
  const targetPosition = targetNode.data.kind === 'junction'
    ? connectionSideToward(target, source)
    : isElectronicComponentKind(targetNode.data.kind)
      ? schematicTerminalSide(targetNode.data.kind, targetHandle, targetNode.data.rotation ?? 0)
    : 'left';
  const [path, labelX, labelY] = getSmoothStepPath({
    sourceX: source.x,
    sourceY: source.y,
    sourcePosition: sourcePosition as never,
    targetX: target.x,
    targetY: target.y,
    targetPosition: targetPosition as never,
    borderRadius: 12 * viewport.zoom,
  });
  return { path, labelX, labelY, source, target };
}

function canConnectLogicNodes(connection: Connection) {
  return Boolean(connection.source && connection.target && connection.source !== connection.target);
}

function isEditableTarget(target: EventTarget | null) {
  return target instanceof HTMLElement
    && target.matches('input, textarea, [contenteditable="true"], [contenteditable=""], [role="textbox"], [role="combobox"]');
}

function parseLogicDocumentContent(content: string, title: string): LogicDiagramDocument {
  if (!content.trim()) return createEmptyLogicDiagram(title);
  try {
    return normalizeLogicDiagramDocument(JSON.parse(content));
  } catch {
    toast.error('This logic diagram could not be parsed. Opening an empty recovery view.');
    return createEmptyLogicDiagram(title);
  }
}

function logicDocumentToJson(document: LogicDiagramDocument): JsonObject {
  return JSON.parse(JSON.stringify(normalizeLogicDiagramDocument(document))) as JsonObject;
}

function logicDocumentFromJson(value: JsonObject): LogicDiagramDocument | null {
  const document = normalizeLogicDiagramDocument(value);
  if (document.kind !== 'logic-diagram') return null;
  if (!Array.isArray(document.nodes) || !Array.isArray(document.wires)) return null;
  return document;
}

function logicExportFileName(relativePath: string) {
  const base = getDocumentBaseName(relativePath, 'logic-diagram').replace(/\.logic$/i, '');
  return `${base.replace(/[^a-z0-9._-]+/gi, '-').replace(/^-+|-+$/g, '') || 'logic-diagram'}.svg`;
}

function uniqueLogicExportPath(relativePath: string, existingPaths: Set<string>) {
  const fileName = logicExportFileName(relativePath);
  const stem = fileName.replace(/\.svg$/i, '');
  let candidate = `Pictures/${fileName}`;
  let index = 2;
  while (existingPaths.has(candidate.toLowerCase())) {
    candidate = `Pictures/${stem}-${index}.svg`;
    index += 1;
  }
  return candidate;
}

function vaultTreeHasPath(entries: NoteFile[], relativePath: string): boolean {
  for (const entry of entries) {
    if (entry.relativePath.toLowerCase() === relativePath.toLowerCase()) return true;
    if (entry.children?.length && vaultTreeHasPath(entry.children, relativePath)) {
      return true;
    }
  }
  return false;
}

async function writeLogicSvgExport(client: VaultClient, relativePath: string, svg: string) {
  try {
    const existing = await client.readDocument(relativePath);
    return client.writeDocument(relativePath, svg, existing.version, existing.content);
  } catch {
    await client.createDocument(relativePath);
    return client.writeDocument(relativePath, svg);
  }
}

function liveLogicStatePreservesCanonicalEntities(
  live: LogicDiagramDocument,
  canonical: LogicDiagramDocument | null,
): boolean {
  if (!canonical) return true;
  const liveNodeIds = new Set(live.nodes.map((node) => node.id));
  const liveWireIds = new Set(live.wires.map((wire) => wire.id));
  return canonical.nodes.every((node) => liveNodeIds.has(node.id))
    && canonical.wires.every((wire) => liveWireIds.has(wire.id));
}

const ANALOG_ACTIVE_VOLTAGE = 1e-9;
const ANALOG_NEGATIVE_COLOR = '#fb7185';

type NumericElectricalField = 'resistanceOhms' | 'capacitanceFarads' | 'inductanceHenries' | 'voltageVolts';

function schematicNumericField(kind: ElectronicComponentKind): {
  field: NumericElectricalField;
  label: string;
  unit: string;
  positive: boolean;
} | null {
  switch (kind) {
    case 'resistor': return { field: 'resistanceOhms', label: 'Resistance', unit: 'Ω', positive: true };
    case 'capacitor': return { field: 'capacitanceFarads', label: 'Capacitance', unit: 'F', positive: true };
    case 'inductor': return { field: 'inductanceHenries', label: 'Inductance', unit: 'H', positive: true };
    case 'voltage-source': return { field: 'voltageVolts', label: 'DC voltage', unit: 'V', positive: false };
    default: return null;
  }
}

function formatEngineering(value: number, unit: string) {
  if (!Number.isFinite(value)) return `— ${unit}`;
  if (value === 0) return `0 ${unit}`;
  const magnitude = Math.abs(value);
  const prefixes = [
    { threshold: 1e9, scale: 1e9, prefix: 'G' },
    { threshold: 1e6, scale: 1e6, prefix: 'M' },
    { threshold: 1e3, scale: 1e3, prefix: 'k' },
    { threshold: 1, scale: 1, prefix: '' },
    { threshold: 1e-3, scale: 1e-3, prefix: 'm' },
    { threshold: 1e-6, scale: 1e-6, prefix: 'µ' },
    { threshold: 1e-9, scale: 1e-9, prefix: 'n' },
    { threshold: 0, scale: 1e-12, prefix: 'p' },
  ];
  const selected = prefixes.find((candidate) => magnitude >= candidate.threshold) ?? prefixes[prefixes.length - 1];
  return `${Number((value / selected.scale).toPrecision(4))} ${selected.prefix}${unit}`;
}

function schematicValueLabel(kind: ElectronicComponentKind, electrical?: SchematicElectricalParameters) {
  const numeric = schematicNumericField(kind);
  if (numeric) {
    const value = electrical?.[numeric.field];
    return typeof value === 'number' ? formatEngineering(value, numeric.unit) : 'Value required';
  }
  if (kind === 'switch') return electrical?.switchClosed ? 'Closed' : 'Open';
  if (kind === 'ground') return 'Reference';
  if (kind === 'junction') return 'Connection';
  return electrical?.modelRef?.replace(/^builtin:/, '') ?? 'Model required';
}

function logicNodeActiveOverlay(kind: LogicNodeKind, data: LogicFlowNode['data']): CSSProperties | undefined {
  if (kind === 'group') return undefined;
  const inputHandles = getLogicInputHandles(kind, data.component);
  const outputHandles = getLogicOutputHandles(kind, data.component);
  const height = kind === 'component' ? logicComponentDimensions(data.component).height : DEFAULT_GATE_HEIGHT;
  const gradients: string[] = [];
  inputHandles.forEach((handle, index) => {
    if (data.inputSignals?.[handle] !== true) return;
    const y = logicHandleYOffset(kind, inputHandles.length, index, height) / height * 100;
    gradients.push(`radial-gradient(circle at 0% ${y}%, ${LOGIC_NODE_ACTIVE_WASH} 0%, transparent 44%)`);
  });
  outputHandles.forEach((handle, index) => {
    const active = data.outputSignals?.[handle] === true
      || (outputHandles.length === 1 && data.evaluatedValue === true);
    if (!active) return;
    const y = logicHandleYOffset(kind, outputHandles.length, index, height) / height * 100;
    gradients.push(`radial-gradient(circle at 100% ${y}%, ${LOGIC_NODE_ACTIVE_WASH} 0%, transparent 44%)`);
  });
  return gradients.length > 0 ? { background: gradients.join(', ') } : undefined;
}

function SharpLogicNode({
  node,
  viewport,
  nodesById,
  readOnly,
  onPointerDown,
  onDoubleClick,
  onContextMenu,
  onHandlePointerDown,
  onHandlePointerUp,
  schematicSymbolSet,
}: {
  node: LogicFlowNode;
  viewport: Viewport;
  nodesById: Map<string, LogicFlowNode>;
  readOnly: boolean;
  onPointerDown: (event: ReactPointerEvent<HTMLDivElement>, node: LogicFlowNode) => void;
  onDoubleClick: (node: LogicFlowNode) => void;
  onContextMenu: (event: ReactMouseEvent<HTMLDivElement>, node: LogicFlowNode) => void;
  onHandlePointerDown: (event: ReactPointerEvent<HTMLButtonElement>, node: LogicFlowNode, handleId: string) => void;
  onHandlePointerUp: (event: ReactPointerEvent<HTMLButtonElement>, node: LogicFlowNode, handleId: string) => void;
  schematicSymbolSet: SchematicSymbolSet;
}) {
  const { data, selected } = node;
  const kind = data.kind;
  const absolute = absoluteNodePosition(node, nodesById);
  const screen = flowToScreen(absolute, viewport);
  const width = nodeBaseWidth(node) * viewport.zoom;
  const height = nodeBaseHeight(node) * viewport.zoom;
  const zoom = viewport.zoom;
  if (kind === 'group') {
    return (
      <div
        onPointerDown={(event) => onPointerDown(event, node)}
        onDoubleClick={() => onDoubleClick(node)}
        onContextMenu={(event) => onContextMenu(event, node)}
        className={cn(
          'absolute flex items-start rounded border border-dashed bg-card/35 font-medium text-muted-foreground shadow-none',
          selected ? 'border-primary ring-2 ring-primary/20' : 'border-border/80',
        )}
        style={{
          left: screen.x,
          top: screen.y,
          width,
          height,
          padding: `${8 * zoom}px ${12 * zoom}px`,
          fontSize: 11 * zoom,
          lineHeight: 1.25,
          borderRadius: 4 * zoom,
        }}
      >
        {logicNodeLabel({ kind, label: data.label })}
      </div>
    );
  }

  const inputHandles = getLogicInputHandles(kind, data.component);
  const outputHandles = getLogicOutputHandles(kind, data.component);
  const isInversion = kind === 'not' || kind === 'nand' || kind === 'nor' || kind === 'xnor';
  const displayValue = kind === 'output' || kind === 'clock' ? data.evaluatedValue : data.value;
  const activeOverlay = logicNodeActiveOverlay(kind, data);
  const componentPorts = data.component?.definition.ports ?? [];
  const componentInputs = componentPorts.filter((port) => port.direction === 'input');
  const componentOutputs = componentPorts.filter((port) => port.direction === 'output');

  if (isElectronicComponentKind(kind)) {
    const rotation = data.rotation ?? 0;
    const terminals = getSchematicTerminals(kind);
    const symbolMarkup = schematicSymbolMarkup(kind, 'currentColor', schematicSymbolSet);
    if (kind === 'junction') {
      return (
        <div
          onPointerDown={(event) => onPointerDown(event, node)}
          onDoubleClick={() => onDoubleClick(node)}
          onContextMenu={(event) => onContextMenu(event, node)}
          className="absolute"
          style={{ left: screen.x, top: screen.y, width, height }}
        >
          <button
            type="button"
            data-logic-handle
            aria-label={`${logicNodeLabel({ kind, label: data.label })} terminal terminal`}
            disabled={readOnly}
            onPointerDown={(event) => onHandlePointerDown(event, node, 'terminal')}
            onPointerUp={(event) => onHandlePointerUp(event, node, 'terminal')}
            className={cn(
              'absolute cursor-crosshair rounded-full border border-primary bg-primary',
              selected && 'ring-2 ring-primary/35 ring-offset-2 ring-offset-background',
            )}
            style={{
              left: 6 * zoom,
              top: 6 * zoom,
              width: 12 * zoom,
              height: 12 * zoom,
            }}
          />
        </div>
      );
    }
    return (
      <div
        onPointerDown={(event) => onPointerDown(event, node)}
        onDoubleClick={() => onDoubleClick(node)}
        onContextMenu={(event) => onContextMenu(event, node)}
        className={cn(
          'absolute flex items-center justify-center text-foreground',
          selected && 'rounded border border-primary bg-primary/5 ring-2 ring-primary/20',
        )}
        style={{ left: screen.x, top: screen.y, width, height }}
      >
        {terminals.map((handleId) => {
          const point = schematicTerminalPoint(kind, handleId, rotation);
          return (
          <button
            key={handleId}
            type="button"
            data-logic-handle
            aria-label={`${logicNodeLabel({ kind, label: data.label })} terminal ${handleId}`}
            disabled={readOnly}
            onPointerDown={(event) => onHandlePointerDown(event, node, handleId)}
            onPointerUp={(event) => onHandlePointerUp(event, node, handleId)}
            className="absolute z-20 cursor-crosshair rounded-full border border-border bg-background"
            style={{
              left: (point.x - 5) * zoom,
              top: point.y * zoom,
              width: 10 * zoom,
              height: 10 * zoom,
              transform: 'translateY(-50%)',
            }}
          />
          );
        })}
        <svg
          aria-hidden="true"
          viewBox={schematicSymbolViewBox(rotation)}
          className="pointer-events-none absolute"
          style={{ left: 0, top: 0, width, height }}
        >
          <g
            transform={schematicSymbolTransform(rotation) || undefined}
            dangerouslySetInnerHTML={{ __html: symbolMarkup }}
          />
        </svg>
        <span
          className="pointer-events-none absolute max-w-[140%] truncate font-medium text-muted-foreground"
          style={{ bottom: -2 * zoom, fontSize: 10 * zoom, lineHeight: 1.1 }}
        >
          <span>{logicNodeLabel({ kind, label: data.label })}</span>
          <span aria-hidden="true"> · {schematicValueLabel(kind, data.electrical)}</span>
        </span>
      </div>
    );
  }

  return (
    <div
      onPointerDown={(event) => onPointerDown(event, node)}
      onMouseDown={(event) => {
        if (kind === 'input' && event.detail >= 2) {
          event.stopPropagation();
          onDoubleClick(node);
        }
      }}
      onDoubleClick={(event) => {
        if (kind === 'input') {
          event.stopPropagation();
          return;
        }
        onDoubleClick(node);
      }}
      onContextMenu={(event) => onContextMenu(event, node)}
      className={cn(
        'absolute flex items-center justify-center overflow-hidden rounded border bg-card text-center shadow-sm transition-colors',
        kind === 'component' && 'bg-violet-500/5',
        selected ? 'border-primary ring-2 ring-primary/25' : 'border-border/70',
      )}
      style={{
        left: screen.x,
        top: screen.y,
        width,
        height,
        padding: `${8 * zoom}px ${kind === 'component' ? 16 * zoom : 12 * zoom}px`,
        borderRadius: 4 * zoom,
      }}
    >
      {activeOverlay ? (
        <span
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 z-0 rounded-[inherit]"
          style={activeOverlay}
        />
      ) : null}
      {inputHandles.map((handleId, index) => (
        <button
          key={handleId}
          type="button"
          data-logic-handle
          aria-label={`${logicNodeLabel({ kind, label: data.label })} input ${handleId}`}
          disabled={readOnly}
          onPointerDown={(event) => event.stopPropagation()}
          onPointerUp={(event) => onHandlePointerUp(event, node, handleId)}
          className="absolute z-20 cursor-crosshair rounded-full border border-border bg-background"
          style={{
            left: -5 * zoom,
            top: logicHandleYOffset(kind, inputHandles.length, index, nodeBaseHeight(node)) * zoom,
            width: 10 * zoom,
            height: 10 * zoom,
            transform: 'translateY(-50%)',
          }}
        />
      ))}
      <div className={cn('relative z-10 min-w-0', kind === 'component' && 'absolute inset-x-3 top-2')}>
        <div className="truncate font-semibold uppercase tracking-normal text-foreground" style={{ fontSize: 11 * zoom, lineHeight: 1.2 }}>
          {logicNodeLabel({ kind, label: data.label })}
        </div>
        {(kind === 'input' || kind === 'clock' || kind === 'output') && (
          <div className="text-muted-foreground" style={{ marginTop: 4 * zoom, fontSize: 10 * zoom, lineHeight: 1.2 }}>
            {typeof displayValue === 'boolean' ? (displayValue ? '1' : '0') : 'unset'}
            {kind === 'clock' ? ` · ${Math.round(data.clock?.periodMs ?? 1000)} ms` : ''}
          </div>
        )}
      </div>
      {kind === 'component' && componentInputs.map((port, index) => (
        <span
          key={port.id}
          className="pointer-events-none absolute z-10 max-w-[42%] truncate text-left text-muted-foreground"
          style={{
            left: 10 * zoom,
            top: logicHandleYOffset(kind, componentInputs.length, index, nodeBaseHeight(node)) * zoom,
            transform: 'translateY(-50%)',
            fontSize: 9 * zoom,
          }}
        >
          {port.label}
        </span>
      ))}
      {kind === 'component' && componentOutputs.map((port, index) => (
        <span
          key={port.id}
          className="pointer-events-none absolute z-10 max-w-[42%] truncate text-right text-muted-foreground"
          style={{
            right: 10 * zoom,
            top: logicHandleYOffset(kind, componentOutputs.length, index, nodeBaseHeight(node)) * zoom,
            transform: 'translateY(-50%)',
            fontSize: 9 * zoom,
          }}
        >
          {port.label}
        </span>
      ))}
      {isInversion && (
        <span
          className="absolute top-1/2 z-20 -translate-y-1/2 rounded-full border border-border bg-background"
          style={{ right: -7 * zoom, width: 12 * zoom, height: 12 * zoom }}
        />
      )}
      {outputHandles.map((handleId, index) => (
        <button
          key={handleId}
          type="button"
          data-logic-handle
          aria-label={`${logicNodeLabel({ kind, label: data.label })} output ${handleId}`}
          disabled={readOnly}
          onPointerDown={(event) => onHandlePointerDown(event, node, handleId)}
          className="absolute z-20 cursor-crosshair rounded-full border border-border bg-background"
          style={{
            right: -5 * zoom,
            top: logicHandleYOffset(kind, outputHandles.length, index, nodeBaseHeight(node)) * zoom,
            width: 10 * zoom,
            height: 10 * zoom,
            transform: 'translateY(-50%)',
          }}
        />
      ))}
    </div>
  );
}

function SharpLogicEdge({
  edge,
  geometry,
  selected,
  zoom,
  onPointerDown,
  onContextMenu,
  onDoubleClick,
  schematic,
}: {
  edge: LogicFlowEdge;
  geometry: NonNullable<ReturnType<typeof logicEdgePath>>;
  selected: boolean;
  zoom: number;
  onPointerDown: (event: ReactPointerEvent<SVGPathElement>, edge: LogicFlowEdge) => void;
  onContextMenu: (event: ReactMouseEvent<SVGPathElement>, edge: LogicFlowEdge) => void;
  onDoubleClick: (edge: LogicFlowEdge) => void;
  schematic: boolean;
}) {
  const signal = edge.data?.signal;
  const analogVoltage = edge.data?.analogVoltage;
  const analogPolarity = schematic && typeof analogVoltage === 'number'
    ? analogVoltage > ANALOG_ACTIVE_VOLTAGE
      ? 'positive'
      : analogVoltage < -ANALOG_ACTIVE_VOLTAGE
      ? 'negative'
      : 'reference'
    : undefined;
  const activeStroke = analogPolarity === 'negative' ? ANALOG_NEGATIVE_COLOR : LOGIC_SIGNAL_ON;
  const stroke = schematic
    ? signal === true
      ? activeStroke
      : 'color-mix(in oklch, var(--foreground) 78%, transparent)'
    : signal === true
    ? LOGIC_SIGNAL_ON
    : signal === false
    ? LOGIC_SIGNAL_OFF
    : LOGIC_SIGNAL_UNKNOWN;
  const markerId = `logic-wire-arrow-${edge.id}`;
  const strokeWidth = (signal === true ? 2.4 : 2) * zoom;
  const path = geometry.path;

  return (
    <>
      <defs>
        <marker
          id={markerId}
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
            fill={stroke}
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
      {selected ? (
        <path
          d={path}
          fill="none"
          stroke="color-mix(in oklch, var(--primary) 48%, white 22%)"
          strokeWidth={strokeWidth + 5}
          strokeLinecap="round"
          strokeLinejoin="round"
          opacity={0.22}
          pointerEvents="none"
        />
      ) : null}
      {signal === true ? (
        <path
          d={path}
          fill="none"
          stroke={activeStroke}
          strokeWidth={strokeWidth + 6 * zoom}
          strokeLinecap="round"
          strokeLinejoin="round"
          opacity={0.24}
          pointerEvents="none"
          style={{ filter: `drop-shadow(0 0 ${4 * zoom}px ${activeStroke})` }}
        />
      ) : null}
      <path
        data-logic-edge
        d={path}
        fill="none"
        stroke="transparent"
        strokeWidth={16 * zoom}
        strokeLinecap="round"
        strokeLinejoin="round"
        pointerEvents="stroke"
        style={{ cursor: 'pointer' }}
        onPointerDown={(event) => onPointerDown(event, edge)}
        onContextMenu={(event) => onContextMenu(event, edge)}
        onDoubleClick={() => onDoubleClick(edge)}
      />
      <path
        data-schematic-live={schematic && signal === true ? 'true' : undefined}
        data-schematic-polarity={analogPolarity}
        d={path}
        fill="none"
        stroke={stroke}
        strokeWidth={strokeWidth}
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeDasharray={!schematic && signal === undefined ? '7 7' : undefined}
        markerEnd={schematic ? undefined : `url(#${markerId})`}
        pointerEvents="none"
      />
    </>
  );
}

function LogicDiagramEditor({ relativePath }: Props) {
  const vault = useVaultStore((state) => state.vault);
  const fileTree = useVaultStore((state) => state.fileTree);
  const refreshFileTree = useVaultStore((state) => state.refreshFileTree);
  const client = useMemo(() => (vault ? createVaultClient(vault) : null), [vault]);
  const markDirty = useEditorStore((state) => state.markDirty);
  const markSaved = useEditorStore((state) => state.markSaved);
  const setSavedHash = useEditorStore((state) => state.setSavedHash);
  const setForceReloadPath = useEditorStore((state) => state.setForceReloadPath);
  const openTabs = useEditorStore((state) => state.openTabs);
  const activeTabPath = useEditorStore((state) => state.activeTabPath);
  const openTab = useEditorStore((state) => state.openTab);
  const setActiveView = useUiStore((state) => state.setActiveView);
  const schematicSymbolSet = useUiStore((state) => state.schematicSymbolSet);
  const readOnly = vault ? isVaultReadOnly(vault) : false;
  const { userId: myUserId, userName: myUserName, userColor: myUserColor } = useCollabIdentity();
  const [nodes, setNodes] = useState<LogicFlowNode[]>([]);
  const [edges, setEdges] = useState<LogicFlowEdge[]>([]);
  const [diagram, setDiagram] = useState<LogicDiagramDocument>(() =>
    createEmptyLogicDiagram(getDocumentBaseName(relativePath, 'Logic Diagram').replace(/\.logic$/i, '')),
  );
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [selectedGate, setSelectedGate] = useState<LogicGateKind>('and');
  const [selectedSymbol, setSelectedSymbol] = useState<ElectronicComponentKind>('resistor');
  // Rename state — supports gates, groups, and wires via a discriminated target.
  const [renameTarget, setRenameTarget] = useState<{ kind: 'node' | 'edge'; id: string } | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [templatePickerOpen, setTemplatePickerOpen] = useState(false);
  const [componentPickerOpen, setComponentPickerOpen] = useState(false);
  const [componentSaveOpen, setComponentSaveOpen] = useState(false);
  const [componentName, setComponentName] = useState('');
  const [componentDescription, setComponentDescription] = useState('');
  const [componentInsertMode, setComponentInsertMode] = useState<LogicComponentInstanceMode>('snapshot');
  const [componentEditSession, setComponentEditSession] = useState<{
    component: LogicComponentDefinition;
    original: LogicDiagramDocument;
  } | null>(null);
  const [componentEditDirty, setComponentEditDirty] = useState(false);
  const componentEditingRef = useRef<LogicComponentDefinition | null>(null);
  const [truthTableOpen, setTruthTableOpen] = useState(false);
  const [truthTableScope, setTruthTableScope] = useState('document');
  const [clockSettingsNodeId, setClockSettingsNodeId] = useState<string | null>(null);
  const [clockPeriodValue, setClockPeriodValue] = useState('1000');
  const [clockDutyValue, setClockDutyValue] = useState('50');
  const [clockPhaseValue, setClockPhaseValue] = useState('0');
  const [clockRunning, setClockRunning] = useState(false);
  const [clockElapsedMs, setClockElapsedMs] = useState(0);
  const [schematicSettingsNodeId, setSchematicSettingsNodeId] = useState<string | null>(null);
  const [schematicValueInput, setSchematicValueInput] = useState('');
  const [schematicSwitchClosed, setSchematicSwitchClosed] = useState(false);
  const [circuitRunning, setCircuitRunning] = useState(false);
  const [circuitRunKind, setCircuitRunKind] = useState<'dc' | 'sweep' | 'transient' | null>(null);
  const [circuitJobId, setCircuitJobId] = useState<string | null>(null);
  const [circuitJobStatus, setCircuitJobStatus] = useState<CircuitJobStatus | null>(null);
  const circuitJobIdRef = useRef<string | null>(null);
  const circuitRunSequenceRef = useRef(0);
  const circuitMountedRef = useRef(true);
  const [circuitResult, setCircuitResult] = useState<CircuitDcResult | null>(null);
  const [circuitError, setCircuitError] = useState<string | null>(null);
  const [circuitResultSignature, setCircuitResultSignature] = useState<string | null>(null);
  const [circuitResultsOpen, setCircuitResultsOpen] = useState(false);
  const [sweepConfigOpen, setSweepConfigOpen] = useState(false);
  const [sweepSourceInput, setSweepSourceInput] = useState('');
  const [sweepStartInput, setSweepStartInput] = useState('0');
  const [sweepStopInput, setSweepStopInput] = useState('5');
  const [sweepSamplesInput, setSweepSamplesInput] = useState('101');
  const [sweepResult, setSweepResult] = useState<CircuitSweepResult | null>(null);
  const [sweepResultSignature, setSweepResultSignature] = useState<string | null>(null);
  const [sweepError, setSweepError] = useState<string | null>(null);
  const [sweepResultsOpen, setSweepResultsOpen] = useState(false);
  const [transientConfigOpen, setTransientConfigOpen] = useState(false);
  const [transientDurationInput, setTransientDurationInput] = useState('0.01');
  const [transientStepInput, setTransientStepInput] = useState('0.0001');
  const [transientSourceInput, setTransientSourceInput] = useState('');
  const [transientWaveformKind, setTransientWaveformKind] = useState<LogicSourceWaveform['kind']>('pulse');
  const [transientWaveformInputs, setTransientWaveformInputs] = useState<Record<string, string>>({});
  const [transientResult, setTransientResult] = useState<CircuitTransientResult | null>(null);
  const [transientResultSignature, setTransientResultSignature] = useState<string | null>(null);
  const [transientError, setTransientError] = useState<string | null>(null);
  const [transientResultsOpen, setTransientResultsOpen] = useState(false);
  const clockStartedAtRef = useRef(Date.now());
  const [logicComponents, setLogicComponents] = useState<LogicComponentDefinition[]>([]);
  const [loadingComponents, setLoadingComponents] = useState(false);
  const [viewport, setViewportState] = useState<Viewport>(DEFAULT_VIEWPORT);
  const [contextMenu, setContextMenu] = useState<LogicContextMenu | null>(null);
  const idCounterRef = useRef(1);
  const viewportRef = useRef<HTMLDivElement | null>(null);
  // Structural signature of what is currently persisted; used to skip autosaves
  // that carry no real change (selection, measurement, fit-view, pan).
  const savedStructuralRef = useRef<string | null>(null);
  const canonicalLogicRef = useRef<LogicDiagramDocument | null>(null);
  // True only after a successful load, so a failed read never overwrites the
  // file with an empty/default diagram.
  const readyRef = useRef(false);
  const liveSessionRef = useRef<LiveJsonSession | null>(null);
  const [refreshPulse, setRefreshPulse] = useState(false);
  const refreshPulseTimerRef = useRef<number | null>(null);
  const panSessionRef = useRef<{ pointerId: number; start: { x: number; y: number }; viewport: Viewport } | null>(null);
  const dragSessionRef = useRef<{
    pointerId: number;
    nodeId: string;
    start: { x: number; y: number };
    positions: Map<string, { x: number; y: number }>;
    moved: boolean;
  } | null>(null);
  const selectionSessionRef = useRef<{
    pointerId: number;
    start: { x: number; y: number };
    current: { x: number; y: number };
    additive: boolean;
    baseNodeIds: Set<string>;
    baseEdgeIds: Set<string>;
    moved: boolean;
  } | null>(null);
  const [selectionBox, setSelectionBox] = useState<{ left: number; top: number; width: number; height: number } | null>(null);
  const connectionSessionRef = useRef<{
    sourceNodeId: string;
    sourceHandle: string;
    pointer: { x: number; y: number };
    target: { nodeId: string; handleId: string } | null;
  } | null>(null);
  const [connectionPreview, setConnectionPreview] = useState<{
    sourceNodeId: string;
    sourceHandle: string;
    pointer: { x: number; y: number };
    target: { nodeId: string; handleId: string } | null;
  } | null>(null);
  const getViewport = useCallback(() => viewport, [viewport]);

  const structuralSignature = useCallback((
    flowNodes: LogicFlowNode[],
    flowEdges: LogicFlowEdge[],
    diagramMode: LogicDiagramMode,
    simulation: LogicDiagramDocument['simulation'],
  ) =>
    JSON.stringify({
      diagramMode,
      simulation: simulation ?? null,
      nodes: flowNodes.map((node) => ({
        id: node.id,
        kind: node.data.kind,
        label: node.data.label ?? null,
        value: node.data.value ?? null,
        clock: node.data.clock ?? null,
        rotation: node.data.rotation ?? null,
        electrical: node.data.electrical ?? null,
        component: node.data.component ?? null,
        parentId: node.parentId ?? null,
        x: node.position.x,
        y: node.position.y,
        w: node.data.kind === 'group' && typeof node.style?.width === 'number' ? node.style.width : null,
        h: node.data.kind === 'group' && typeof node.style?.height === 'number' ? node.style.height : null,
      })),
      wires: flowEdges.map((edge) => ({
        id: edge.id,
        source: edge.source,
        target: edge.target,
        sourceHandle: edge.sourceHandle ?? null,
        targetHandle: edge.targetHandle ?? null,
        label: typeof edge.label === 'string' ? edge.label : null,
      })),
    }), []);

  const selectedNodeIds = useMemo(
    () => nodes.filter((node) => node.selected).map((node) => node.id),
    [nodes],
  );
  const logicComponentsCapability = client?.runtime.logicComponents ?? null;
  const availableComponents = useMemo(() => {
    const byId = new Map<string, LogicComponentDefinition>();
    for (const component of [...(diagram.components ?? []), ...logicComponents]) byId.set(component.id, component);
    for (const node of nodes) {
      const definition = node.data.component?.definition;
      if (definition && !byId.has(definition.id)) byId.set(definition.id, definition);
    }
    return [...byId.values()].sort((a, b) => a.name.localeCompare(b.name));
  }, [diagram.components, logicComponents, nodes]);
  const selectedEdgeIds = useMemo(
    () => edges.filter((edge) => edge.selected).map((edge) => edge.id),
    [edges],
  );
  const circuitInputSignature = useMemo(() => JSON.stringify({
    nodes: nodes
      .filter((node) => isElectronicComponentKind(node.data.kind))
      .map((node) => ({ id: node.id, kind: node.data.kind, electrical: node.data.electrical ?? null }))
      .sort((left, right) => left.id.localeCompare(right.id)),
    wires: edges
      .map((edge) => ({
        id: edge.id,
        source: edge.source,
        target: edge.target,
        sourceHandle: edge.sourceHandle ?? null,
        targetHandle: edge.targetHandle ?? null,
      }))
      .sort((left, right) => left.id.localeCompare(right.id)),
    simulation: diagram.simulation ?? null,
  }), [diagram.simulation, edges, nodes]);
  const circuitResultStale = Boolean(
    circuitResult && circuitResultSignature && circuitResultSignature !== circuitInputSignature,
  );
  const sweepResultStale = Boolean(
    sweepResult && sweepResultSignature && sweepResultSignature !== circuitInputSignature,
  );
  const transientResultStale = Boolean(
    transientResult && transientResultSignature && transientResultSignature !== circuitInputSignature,
  );
  const sweepSourceChoices = useMemo(() => nodes
    .filter((node) => node.data.kind === 'voltage-source')
    .map((node) => ({
      id: node.id,
      label: logicNodeLabel({ kind: node.data.kind, label: node.data.label }),
    }))
    .sort((left, right) => left.label.localeCompare(right.label)), [nodes]);
  const activeCircuitResult = circuitResultStale ? null : circuitResult;
  const evaluation = useMemo(() => {
    if (diagram.diagramMode === 'schematic') {
      return { nodeValues: {}, nodeOutputValues: {}, wireValues: {}, warnings: [] };
    }
    const graph = fromFlowGraph(diagram, nodes, edges, diagram.viewport);
    return evaluateLogicDiagram(graph.nodes, graph.wires, {
      components: availableComponents,
      clockElapsedMs,
    });
  }, [availableComponents, clockElapsedMs, diagram, edges, nodes]);

  const truthTable = useMemo(() => {
    if (!truthTableOpen) return { inputs: [], outputs: [], rows: [] };
    const component = truthTableScope === 'document'
      ? null
      : availableComponents.find((candidate) => candidate.id === truthTableScope);
    if (component) return generateComponentTruthTable(component, availableComponents);
    const graph = fromFlowGraph(diagram, nodes, edges, diagram.viewport);
    return generateLogicTruthTable(graph.nodes, graph.wires, { components: availableComponents });
  }, [availableComponents, diagram, edges, nodes, truthTableOpen, truthTableScope]);

  const clockCount = useMemo(() => nodes.filter((node) => node.data.kind === 'clock').length, [nodes]);

  useEffect(() => {
    if (!clockRunning || clockCount === 0) return;
    const timer = window.setInterval(() => {
      setClockElapsedMs(Date.now() - clockStartedAtRef.current);
    }, 40);
    return () => window.clearInterval(timer);
  }, [clockCount, clockRunning]);

  useEffect(() => {
    if (clockCount === 0) setClockRunning(false);
  }, [clockCount]);
  const inputSignalsByNode = useMemo(() => {
    const nodeById = new Map(nodes.map((node) => [node.id, node]));
    const signals = new Map<string, Record<string, boolean | undefined>>();
    for (const edge of edges) {
      const target = nodeById.get(edge.target);
      if (!target) continue;
      const targetHandles = getLogicInputHandles(target.data.kind, target.data.component);
      const targetHandle = edge.targetHandle && targetHandles.includes(edge.targetHandle)
        ? edge.targetHandle
        : targetHandles[0];
      if (!targetHandle) continue;
      const nodeSignals = signals.get(edge.target) ?? {};
      nodeSignals[targetHandle] = evaluation.wireValues[edge.id];
      signals.set(edge.target, nodeSignals);
    }
    return signals;
  }, [edges, evaluation.wireValues, nodes]);
  const renderedNodes = useMemo(() => nodes.map((node) => ({
    ...node,
    data: {
      ...node.data,
      evaluatedValue: evaluation.nodeValues[node.id],
      inputSignals: inputSignalsByNode.get(node.id) ?? {},
      outputSignals: evaluation.nodeOutputValues[node.id] ?? {},
    },
  })), [evaluation.nodeOutputValues, evaluation.nodeValues, inputSignalsByNode, nodes]);
  const circuitWireVoltages = useMemo(() => {
    const voltages = new Map<string, number>();
    if (!activeCircuitResult) return voltages;
    for (const mapping of activeCircuitResult.sourceMap.wires) {
      const voltage = activeCircuitResult.operatingPoint.nodeVoltages[mapping.electricalNode];
      if (typeof voltage === 'number') voltages.set(mapping.wireId, voltage);
    }
    return voltages;
  }, [activeCircuitResult]);
  const renderedEdges = useMemo(() => edges.map((edge) => {
    const analogVoltage = circuitWireVoltages.get(edge.id);
    const signal = diagram.diagramMode === 'schematic'
      ? typeof analogVoltage === 'number' && Math.abs(analogVoltage) > ANALOG_ACTIVE_VOLTAGE
      : evaluation.wireValues[edge.id];
    return {
      ...edge,
      type: 'logicWire' as const,
      data: {
        ...edge.data,
        signal,
        analogVoltage,
      },
    };
  }), [circuitWireVoltages, diagram.diagramMode, edges, evaluation.wireValues]);
  const nodesById = useMemo(() => new Map(renderedNodes.map((node) => [node.id, node])), [renderedNodes]);
  const edgeGeometries = useMemo(() => new Map(renderedEdges
    .map((edge) => [edge.id, logicEdgePath(edge, nodesById, viewport)] as const)
    .filter((entry): entry is readonly [string, NonNullable<ReturnType<typeof logicEdgePath>>] => entry[1] !== null)),
  [nodesById, renderedEdges, viewport]);

  const title = getDocumentBaseName(relativePath, 'Logic Diagram').replace(/\.logic$/i, '');
  const noteTarget = useMemo(() => (
    openTabs.find((tab) => tab.type === 'note' && tab.relativePath === activeTabPath)
    ?? openTabs.find((tab) => tab.type === 'note')
    ?? null
  ), [activeTabPath, openTabs]);

  // Push an adopted document (initial load, backend merge, or a safe remote
  // apply) into the ReactFlow editor and re-baseline the structural signature so
  // the autosave effect does not immediately re-fire.
  const applyLogicDocument = useCallback((loaded: LogicDiagramDocument) => {
    const graph = toFlowGraph(loaded);
    setDiagram(loaded);
    canonicalLogicRef.current = loaded;
    setNodes(graph.nodes);
    setEdges(graph.edges);
    setViewportState(loaded.viewport);
    savedStructuralRef.current = structuralSignature(graph.nodes, graph.edges, loaded.diagramMode, loaded.simulation);
    readyRef.current = true;
  }, [setEdges, setNodes, structuralSignature]);

  const { controller, snapshot } = useDocumentSessionController<LogicDiagramDocument>({
    serialize: (doc) => JSON.stringify(doc, null, 2),
    deserialize: (content) => parseLogicDocumentContent(content, title),
    applyDocument: (candidate) => applyLogicDocument(candidate.document),
    read: async () => {
      if (!client) return null;
      const doc = await client.readDocument(relativePath);
      return { content: doc.content, version: doc.version, source: doc.source && doc.source !== 'network' ? 'cache' : 'rest' };
    },
    write: async ({ content, expectedVersion, baseContent }) => {
      if (!client) return { version: expectedVersion ?? '' };
      const result = await client.writeDocument(relativePath, content, expectedVersion ?? undefined, baseContent);
      if (result.conflict) {
        // ConflictInfo carries the other side's content but no version token;
        // read the current server version so keep-mine/load-latest can rebase.
        let theirVersion: string | null = null;
        try {
          theirVersion = (await client.readDocument(relativePath)).version;
        } catch {
          // Best-effort; a null version makes the next save force-overwrite.
        }
        return {
          version: expectedVersion ?? '',
          conflict: { theirContent: result.conflict.theirContent, baseContent, theirVersion },
        };
      }
      if (result.offlineQueued) return { version: result.version, offlineQueued: true };
      return { version: result.version, mergedContent: result.mergedContent };
    },
    autosaveDebounceMs: SAVE_DEBOUNCE_MS,
    compareVersions: compareDocumentVersions,
    isLive: () => liveSessionRef.current !== null,
  });

  // Initial load: establish the session baseline (force explicit reload policy).
  useEffect(() => {
    let cancelled = false;
    if (!client) return;
    readyRef.current = false;
    setLoading(true);
    client.readDocument(relativePath)
      .then((document) => {
        if (cancelled) return;
        controller.load(document.content, document.version, 'rest');
        setSavedHash(relativePath, document.version);
      })
      .catch((error) => {
        if (!cancelled) toast.error(`Failed to open logic diagram: ${error}`);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [client, controller, relativePath, setSavedHash]);

  const applyLiveLogicDocument = useCallback((document: LogicDiagramDocument) => {
    if (componentEditingRef.current) return;
    applyLogicDocument(document);
  }, [applyLogicDocument]);

  const validateInitialLiveLogicDocument = useCallback((document: LogicDiagramDocument) => (
    liveLogicStatePreservesCanonicalEntities(document, canonicalLogicRef.current)
  ), []);

  const liveSession = useLiveJsonDocumentSession<LogicDiagramDocument>({
    client,
    relativePath,
    enabled: !loading && Boolean(client?.resolveLiveSession),
    fromJson: logicDocumentFromJson,
    validateInitial: validateInitialLiveLogicDocument,
    applyDocument: applyLiveLogicDocument,
  });

  useLiveDocumentStatus(controller, liveSession);

  useEffect(() => {
    liveSessionRef.current = liveSession;
  }, [liveSession]);

  useEffect(() => {
    if (!liveSession) return;
    liveSession.awareness.setLocalStateField('user', {
      id: myUserId,
      name: myUserName,
      color: myUserColor,
    });
    liveSession.awareness.setLocalStateField('document', {
      kind: 'logic',
      relativePath,
    });
  }, [liveSession, myUserColor, myUserId, myUserName, relativePath]);

  const livePeers = useLivePeers(liveSession);

  const markChanged = useCallback(() => {
    if (componentEditingRef.current) {
      setComponentEditDirty(true);
      return;
    }
    if (liveSessionRef.current) return;
    markDirty(relativePath);
  }, [markDirty, relativePath]);

  const reloadLogicComponents = useCallback(async () => {
    if (!logicComponentsCapability) {
      setLogicComponents([]);
      return;
    }
    setLoadingComponents(true);
    try {
      setLogicComponents(await logicComponentsCapability.list());
    } catch (error) {
      toast.error(`Failed to load logic components: ${error}`);
    } finally {
      setLoadingComponents(false);
    }
  }, [logicComponentsCapability]);

  useEffect(() => {
    void reloadLogicComponents();
  }, [reloadLogicComponents]);

  useEffect(() => {
    if (logicComponents.length === 0) return;
    const byId = new Map(logicComponents.map((component) => [component.id, component]));
    let changed = false;
    setNodes((current) => current.map((node) => {
      if (node.data.kind !== 'component' || node.data.component?.mode !== 'linked') return node;
      const componentId = node.data.component.componentId;
      const latest = componentId ? byId.get(componentId) : undefined;
      if (!latest || latest.version === node.data.component.definition.version) return node;
      changed = true;
      return {
        ...node,
        data: {
          ...node.data,
          label: latest.name,
          component: {
            ...node.data.component,
            definition: latest,
          },
        },
      };
    }));
    if (changed) markChanged();
  }, [logicComponents, markChanged, setNodes]);

  // Debounced autosave via the shared controller: only marks a local change when
  // the structural signature actually changes, so selection, node measurement,
  // fit-view, and pan do not trigger writes. The controller serializes
  // overlapping saves, rejects stale remote reloads, queues remote changes while
  // dirty, and latches autosave off on conflict. `lastMarkedSigRef` makes the
  // mark idempotent per distinct signature so a re-render (from the controller's
  // own state change) never re-marks the same edit.
  const lastMarkedSigRef = useRef<string | null>(null);
  useEffect(() => {
    if (!vault || readOnly || !readyRef.current || componentEditSession) return;
    const sig = structuralSignature(nodes, edges, diagram.diagramMode, diagram.simulation);
    if (sig === savedStructuralRef.current) {
      lastMarkedSigRef.current = sig;
      return;
    }
    if (sig === lastMarkedSigRef.current) return;
    lastMarkedSigRef.current = sig;
    const next = fromFlowGraph(diagram, nodes, edges, getViewport() as Viewport);
    if (liveSessionRef.current) {
      liveSessionRef.current.writeJson(logicDocumentToJson(next));
    } else {
      controller.markLocalChange(next);
    }
  }, [componentEditSession, controller, diagram, edges, getViewport, nodes, readOnly, structuralSignature, vault]);

  // Re-baseline the structural signature when a save (without a merge adoption,
  // which reseeds via applyDocument) completes cleanly, so the autosave effect
  // stops firing for already-persisted state.
  const prevSavingRef = useRef(false);
  useEffect(() => {
    if (prevSavingRef.current && !snapshot.saving && !snapshot.dirty && !snapshot.conflicted) {
      savedStructuralRef.current = structuralSignature(nodes, edges, diagram.diagramMode, diagram.simulation);
    }
    prevSavingRef.current = snapshot.saving;
  }, [diagram.diagramMode, edges, nodes, snapshot.conflicted, snapshot.dirty, snapshot.saving, structuralSignature]);

  // Bridge the controller's dirty/version state to the tab dirty indicator.
  useEffect(() => {
    if (!relativePath) return;
    if (liveSession) return;
    if (snapshot.dirty) markDirty(relativePath);
    else if (snapshot.loadedVersion) markSaved(relativePath, snapshot.loadedVersion);
  }, [liveSession, markDirty, markSaved, relativePath, snapshot.dirty, snapshot.loadedVersion]);

  const pulseRefresh = useCallback(() => {
    setRefreshPulse(true);
    if (refreshPulseTimerRef.current !== null) window.clearTimeout(refreshPulseTimerRef.current);
    refreshPulseTimerRef.current = window.setTimeout(() => setRefreshPulse(false), 420);
  }, []);

  // Local filesystem watcher: another writer changed this file. The controller
  // decides — auto-apply when clean, queue when dirty, ignore our own echo.
  useEffect(() => {
    if (!client || !client.capabilities.filesystemWatch || !relativePath) return;
    let unsub: (() => void) | undefined;
    listen<{ path: string }>('vault:file-modified', (event) => {
      if (event.payload.path !== relativePath) return;
      if (Date.now() - controller.getSnapshot().lastLocalWriteStartedAt < 2000) return;
      void controller.handleExternalMutation('rest').then((decision) => {
        if (decision === 'applied') pulseRefresh();
      });
    }).then((cleanup) => { unsub = cleanup; });
    return () => { unsub?.(); };
  }, [client, controller, pulseRefresh, relativePath]);

  // Hosted replica refresh: route through the same safe remote policy.
  useEffect(() => {
    if (!client || client.kind !== 'hosted' || !relativePath) return;
    return onReplicaMutated((event) => {
      if (!replicaMutationAffectsPath(event, relativePath)) return;
      void controller.handleExternalMutation('cache').then((decision) => {
        if (decision === 'applied') pulseRefresh();
      });
    }, { kinds: ['manifest'] });
  }, [client, controller, pulseRefresh, relativePath]);

  useEffect(() => () => {
    if (refreshPulseTimerRef.current !== null) window.clearTimeout(refreshPulseTimerRef.current);
  }, []);

  useEffect(() => {
    circuitMountedRef.current = true;
    return () => {
      circuitMountedRef.current = false;
      circuitRunSequenceRef.current += 1;
      const activeJobId = circuitJobIdRef.current;
      if (activeJobId) void tauriCommands.circuitCancelJob(activeJobId).catch(() => undefined);
    };
  }, []);

  const handleSave = useCallback(async () => {
    if (!vault || readOnly) return;
    setSaving(true);
    try {
      await controller.requestSave('manual');
      const snap = controller.getSnapshot();
      if (snap.conflicted) {
        toast.error('This logic diagram changed elsewhere. Review the conflict before saving.');
      } else if (snap.offlineQueued) {
        toast.message('Saved offline — changes will sync when reconnected.');
      } else {
        toast.success('Saved logic diagram.');
      }
    } catch (error) {
      toast.error(`Failed to save logic diagram: ${error}`);
    } finally {
      setSaving(false);
    }
  }, [controller, readOnly, vault]);

  const handleExportToNote = useCallback(async (uniqueName = false) => {
    if (!vault || !client || readOnly) return;
    if (!noteTarget) {
      toast.error('Open a note before inserting this diagram.');
      return;
    }
    setExporting(true);
    try {
      await controller.requestSave('manual');
      const current = fromFlowGraph(diagram, nodes, edges, getViewport() as Viewport);
      const svg = buildLogicDiagramSvg(current, relativePath, schematicSymbolSet);
      const existingPaths = new Set(flattenVaultFiles(fileTree).map((entry) => entry.relativePath.toLowerCase()));
      if (!vaultTreeHasPath(fileTree, 'Pictures')) {
        await client.createFolder('Pictures');
      }
      const exportedPath = uniqueName
        ? uniqueLogicExportPath(relativePath, existingPaths)
        : `Pictures/${logicExportFileName(relativePath)}`;
      await writeLogicSvgExport(client, exportedPath, svg);
      await refreshFileTree();
      const note = await client.readDocument(noteTarget.relativePath);
      const markdownTarget = getMarkdownImageTarget(noteTarget.relativePath, exportedPath);
      const markdown = `![${title}](${markdownTarget})`;
      const separator = note.content.trim().length > 0 && !note.content.endsWith('\n') ? '\n\n' : '';
      const nextContent = `${note.content}${separator}${markdown}\n`;
      const result = await client.writeDocument(noteTarget.relativePath, nextContent, note.version, note.content);
      markSaved(noteTarget.relativePath, result.version);
      setForceReloadPath(noteTarget.relativePath);
      openTab(noteTarget.relativePath, noteTarget.title, 'note');
      setActiveView('editor');
      toast.success(`Inserted diagram into ${noteTarget.title}`);
    } catch (error) {
      toast.error(`Failed to export logic diagram: ${error}`);
    } finally {
      setExporting(false);
    }
  }, [client, controller, diagram, edges, fileTree, getViewport, markSaved, nodes, noteTarget, openTab, readOnly, refreshFileTree, relativePath, schematicSymbolSet, setActiveView, setForceReloadPath, title, vault]);

  const getMenuPosition = useCallback((clientX: number, clientY: number) => {
    const rect = viewportRef.current?.getBoundingClientRect();
    if (!rect) return { x: clientX, y: clientY };
    return {
      x: Math.max(12, Math.min(clientX - rect.left, rect.width - CONTEXT_MENU_WIDTH - 12)),
      y: Math.max(12, Math.min(clientY - rect.top, rect.height - CONTEXT_MENU_HEIGHT - 12)),
    };
  }, []);

  const closeContextMenu = useCallback(() => {
    setContextMenu(null);
  }, []);

  const syncViewport = useCallback((nextViewport: Viewport, duration = 180) => {
    void duration;
    setViewportState(nextViewport);
  }, []);

  const adjustZoom = useCallback((direction: 1 | -1) => {
    const current = getViewport();
    const nextZoom = Math.min(
      MAX_LOGIC_ZOOM,
      Math.max(MIN_LOGIC_ZOOM, current.zoom * (direction > 0 ? LOGIC_ZOOM_STEP : 1 / LOGIC_ZOOM_STEP)),
    );
    syncViewport({ ...current, zoom: nextZoom });
  }, [getViewport, syncViewport]);

  const resetZoom = useCallback(() => {
    const current = getViewport();
    syncViewport({ ...current, zoom: 1 });
  }, [getViewport, syncViewport]);

  const fitLogicView = useCallback(() => {
    const rect = viewportRef.current?.getBoundingClientRect();
    if (!rect || nodes.length === 0) return;
    const absoluteNodes = nodes.map((node) => {
      const position = absoluteNodePosition(node, new Map(nodes.map((candidate) => [candidate.id, candidate])));
      return {
        left: position.x,
        top: position.y,
        right: position.x + nodeBaseWidth(node),
        bottom: position.y + nodeBaseHeight(node),
      };
    });
    const left = Math.min(...absoluteNodes.map((node) => node.left));
    const top = Math.min(...absoluteNodes.map((node) => node.top));
    const right = Math.max(...absoluteNodes.map((node) => node.right));
    const bottom = Math.max(...absoluteNodes.map((node) => node.bottom));
    const padding = 64;
    const graphWidth = Math.max(1, right - left);
    const graphHeight = Math.max(1, bottom - top);
    const zoom = Math.min(
      MAX_LOGIC_ZOOM,
      Math.max(MIN_LOGIC_ZOOM, Math.min((rect.width - padding * 2) / graphWidth, (rect.height - padding * 2) / graphHeight)),
    );
    setViewportState({
      zoom,
      x: (rect.width - graphWidth * zoom) / 2 - left * zoom,
      y: (rect.height - graphHeight * zoom) / 2 - top * zoom,
    });
  }, [nodes]);

  const resolveLogicConnection = useCallback((connection: Connection) => {
    if (!canConnectLogicNodes(connection)) return;
    const sourceNode = nodes.find((node) => node.id === connection.source);
    const targetNode = nodes.find((node) => node.id === connection.target);
    if (!sourceNode || !targetNode) return;

    const schematicConnection = diagram.diagramMode === 'schematic'
      && isElectronicComponentKind(sourceNode.data.kind)
      && isElectronicComponentKind(targetNode.data.kind);
    const sourceHandles = schematicConnection
      ? getSchematicTerminals(sourceNode.data.kind as ElectronicComponentKind)
      : getLogicOutputHandles(sourceNode.data.kind, sourceNode.data.component);
    const targetHandles = schematicConnection
      ? getSchematicTerminals(targetNode.data.kind as ElectronicComponentKind)
      : getLogicInputHandles(targetNode.data.kind, targetNode.data.component);
    const sourceHandle = connection.sourceHandle && sourceHandles.includes(connection.sourceHandle)
      ? connection.sourceHandle
      : sourceHandles[0];
    if (schematicConnection) {
      const targetHandle = connection.targetHandle && targetHandles.includes(connection.targetHandle)
        ? connection.targetHandle
        : targetHandles[0];
      if (!sourceHandle || !targetHandle) return;
      const duplicate = edges.some((edge) => (
        edge.source === sourceNode.id
        && edge.target === targetNode.id
        && edge.sourceHandle === sourceHandle
        && edge.targetHandle === targetHandle
      ) || (
        edge.source === targetNode.id
        && edge.target === sourceNode.id
        && edge.sourceHandle === targetHandle
        && edge.targetHandle === sourceHandle
      ));
      if (duplicate) return;
      return { sourceHandle, targetHandle };
    }
    const requestedTargetHandle = connection.targetHandle && targetHandles.includes(connection.targetHandle)
      ? connection.targetHandle
      : targetHandles.find((handleId) => !edges.some((edge) => (
          edge.target === targetNode.id
          && (edge.targetHandle && targetHandles.includes(edge.targetHandle) ? edge.targetHandle : targetHandles[0]) === handleId
        )));

    if (!sourceHandle || !requestedTargetHandle) return;
    if (edges.some((edge) => (
      edge.target === targetNode.id
      && (edge.targetHandle && targetHandles.includes(edge.targetHandle) ? edge.targetHandle : targetHandles[0]) === requestedTargetHandle
    ))) return;

    return { sourceHandle, targetHandle: requestedTargetHandle };
  }, [diagram.diagramMode, edges, nodes]);

  const onConnect = useCallback((connection: Connection) => {
    if (readOnly) return;
    const resolved = resolveLogicConnection(connection);
    if (!resolved) return;
    setEdges((current) => [
      ...current,
      {
        id: `wire-${Date.now()}-${current.length}`,
        source: connection.source,
        target: connection.target,
        sourceHandle: resolved.sourceHandle,
        targetHandle: resolved.targetHandle,
        type: 'logicWire',
      },
    ]);
    markChanged();
  }, [markChanged, readOnly, resolveLogicConnection, setEdges]);

  const getConnectionSnap = useCallback((
    pointer: { x: number; y: number },
    sourceNodeId: string,
    sourceHandle: string,
  ) => {
    let nearest: { nodeId: string; handleId: string; point: { x: number; y: number }; distance: number } | null = null;
    for (const node of renderedNodes) {
      if (node.id === sourceNodeId) continue;
      const targetHandles = diagram.diagramMode === 'schematic' && isElectronicComponentKind(node.data.kind)
        ? getSchematicTerminals(node.data.kind)
        : getLogicInputHandles(node.data.kind, node.data.component);
      for (const handleId of targetHandles) {
        const resolved = resolveLogicConnection({
          source: sourceNodeId,
          target: node.id,
          sourceHandle,
          targetHandle: handleId,
        });
        if (!resolved || resolved.targetHandle !== handleId) continue;
        const point = flowToScreen(getHandleAnchor(node, handleId, 'target', nodesById), viewport);
        const distance = Math.hypot(pointer.x - point.x, pointer.y - point.y);
        if (distance <= LOGIC_CONNECTION_SNAP_RADIUS && (!nearest || distance < nearest.distance)) {
          nearest = { nodeId: node.id, handleId, point, distance };
        }
      }
    }
    return nearest
      ? { pointer: nearest.point, target: { nodeId: nearest.nodeId, handleId: nearest.handleId } }
      : { pointer, target: null };
  }, [diagram.diagramMode, nodesById, renderedNodes, resolveLogicConnection, viewport]);

  const selectedGroups = useMemo(
    () => nodes.filter((node) => node.selected && node.data.kind === 'group'),
    [nodes],
  );

  const openRenameNode = useCallback((nodeId: string) => {
    if (readOnly) return;
    const target = nodes.find((node) => node.id === nodeId);
    if (!target) return;
    setRenameTarget({ kind: 'node', id: nodeId });
    setRenameValue(logicNodeLabel({ kind: target.data.kind, label: target.data.label }));
  }, [nodes, readOnly]);

  const openRenameEdge = useCallback((edgeId: string) => {
    if (readOnly) return;
    const target = edges.find((edge) => edge.id === edgeId);
    if (!target) return;
    setRenameTarget({ kind: 'edge', id: edgeId });
    setRenameValue(typeof target.label === 'string' ? target.label : '');
  }, [edges, readOnly]);

  const renameSelectedNode = useCallback(() => {
    // Prefer a single selected group, then fall back to a single selected gate.
    if (selectedGroups.length === 1) {
      openRenameNode(selectedGroups[0].id);
      return;
    }
    const selectedNonGroup = nodes.filter((n) => n.selected && n.data.kind !== 'group');
    if (selectedNonGroup.length === 1) openRenameNode(selectedNonGroup[0].id);
  }, [nodes, openRenameNode, selectedGroups]);

  const applyRename = useCallback(() => {
    if (readOnly) return;
    if (!renameTarget) return;
    if (renameTarget.kind === 'node') {
      const nextLabel = renameValue.trim();
      setNodes((current) => current.map((node) => (
        node.id === renameTarget.id
          ? { ...node, data: { ...node.data, label: nextLabel || undefined } }
          : node
      )));
    } else {
      const nextLabel = renameValue.trim();
      setEdges((current) => current.map((edge) => (
        edge.id === renameTarget.id
          ? { ...edge, label: nextLabel || undefined }
          : edge
      )));
    }
    setRenameTarget(null);
    setRenameValue('');
    markChanged();
  }, [markChanged, readOnly, renameTarget, renameValue, setEdges, setNodes]);

  const groupSelection = useCallback(() => {
    if (readOnly) return;
    const selected = nodes.filter((node) => node.selected && node.data.kind !== 'group' && !node.parentId);
    if (selected.length < 2) {
      toast.error('Select at least two ungrouped gates to group them.');
      return;
    }

    const left = Math.min(...selected.map((node) => node.position.x));
    const top = Math.min(...selected.map((node) => node.position.y));
    const right = Math.max(...selected.map((node) => node.position.x + (typeof node.style?.width === 'number' ? node.style.width : DEFAULT_GATE_WIDTH)));
    const bottom = Math.max(...selected.map((node) => node.position.y + (typeof node.style?.height === 'number' ? node.style.height : DEFAULT_GATE_HEIGHT)));
    const groupPosition = snapPosition({ x: left - GROUP_PADDING, y: top - GROUP_PADDING });
    const groupId = `group-${Date.now()}`;

    const groupNode: LogicFlowNode = {
      id: groupId,
      type: 'logicGate',
      position: groupPosition,
      data: { kind: 'group', label: 'Group' },
      zIndex: 0,
      style: {
        width: Math.max(240, right - left + GROUP_PADDING * 2),
        height: Math.max(160, bottom - top + GROUP_PADDING * 2),
      },
      selected: true,
    };

    const selectedIds = new Set(selected.map((node) => node.id));
    setNodes((current) => [
      groupNode,
      ...current.map((node) => {
        if (!selectedIds.has(node.id)) return { ...node, selected: false };
        return {
          ...node,
          parentId: groupId,
          extent: 'parent' as const,
          zIndex: 1,
          position: {
            x: node.position.x - groupPosition.x,
            y: node.position.y - groupPosition.y,
          },
          selected: false,
        };
      }),
    ]);
    markChanged();
  }, [markChanged, nodes, readOnly, setNodes]);

  const ungroupSelection = useCallback(() => {
    if (readOnly) return;
    const selectedGroupIds = nodes
      .filter((node) => node.selected && node.data.kind === 'group')
      .map((node) => node.id);
    if (selectedGroupIds.length === 0) return;

    const selectedGroupIdSet = new Set(selectedGroupIds);
    const groupPositions = new Map(
      nodes
        .filter((node) => selectedGroupIdSet.has(node.id))
        .map((node) => [node.id, node.position]),
    );

    setNodes((current) => current
      .filter((node) => !selectedGroupIdSet.has(node.id))
      .map((node) => {
        if (!node.parentId || !selectedGroupIdSet.has(node.parentId)) return node;
        const groupPosition = groupPositions.get(node.parentId) ?? { x: 0, y: 0 };
        return {
          ...node,
          parentId: undefined,
          extent: undefined,
          position: snapPosition({
            x: groupPosition.x + node.position.x,
            y: groupPosition.y + node.position.y,
          }),
          selected: true,
        };
      }));
    markChanged();
  }, [markChanged, nodes, readOnly, setNodes]);

  const addGateAt = useCallback((kind: LogicGateKind, position: { x: number; y: number }) => {
    if (readOnly) return;
    const index = idCounterRef.current++;
    const id = `${kind}-${Date.now()}-${index}`;
    setNodes((current) => [
      ...current,
      {
        id,
        type: 'logicGate',
        position: snapPosition(position),
        zIndex: 1,
        data: {
          kind,
          value: kind === 'input' ? false : undefined,
          clock: kind === 'clock' ? { periodMs: 1000, dutyCycle: 0.5, phaseMs: 0 } : undefined,
        },
      },
    ]);
    markChanged();
  }, [markChanged, readOnly, setNodes]);

  const getViewportCenterClientPoint = useCallback(() => {
    const rect = viewportRef.current?.getBoundingClientRect();
    if (!rect) {
      return { x: window.innerWidth / 2, y: window.innerHeight / 2 };
    }
    return {
      x: rect.left + rect.width / 2,
      y: rect.top + rect.height / 2,
    };
  }, []);

  const clientPointToFlowPosition = useCallback((point: { x: number; y: number }) => {
    const rect = viewportRef.current?.getBoundingClientRect();
    const local = rect
      ? { x: point.x - rect.left, y: point.y - rect.top }
      : point;
    return screenToFlow(local, viewport);
  }, [viewport]);

  const addGate = useCallback((kind: LogicGateKind) => {
    addGateAt(kind, clientPointToFlowPosition(getViewportCenterClientPoint()));
  }, [addGateAt, clientPointToFlowPosition, getViewportCenterClientPoint]);

  const addSchematicSymbolAt = useCallback((kind: ElectronicComponentKind, position: { x: number; y: number }) => {
    if (readOnly) return;
    const index = idCounterRef.current++;
    setNodes((current) => [
      ...current,
      {
        id: `${kind}-${Date.now()}-${index}`,
        type: 'logicGate',
        position: snapPosition(position),
        zIndex: 1,
        data: { kind, electrical: defaultSchematicElectricalParameters(kind) },
      },
    ]);
    markChanged();
  }, [markChanged, readOnly, setNodes]);

  const addSchematicSymbol = useCallback((kind: ElectronicComponentKind) => {
    addSchematicSymbolAt(kind, clientPointToFlowPosition(getViewportCenterClientPoint()));
  }, [addSchematicSymbolAt, clientPointToFlowPosition, getViewportCenterClientPoint]);

  const insertJunctionOnEdge = useCallback((edge: LogicFlowEdge, position: { x: number; y: number }) => {
    if (readOnly || diagram.diagramMode !== 'schematic') return;
    const junctionIndex = idCounterRef.current++;
    const wireIndex = idCounterRef.current++;
    const timestamp = Date.now();
    const junctionId = `junction-${timestamp}-${junctionIndex}`;

    setNodes((current) => [
      ...current.map((node) => ({ ...node, selected: false })),
      {
        id: junctionId,
        type: 'logicGate',
        position: { x: position.x - 12, y: position.y - 12 },
        zIndex: 2,
        selected: true,
        data: { kind: 'junction' },
      },
    ]);
    setEdges((current) => [
      ...current.map((candidate) => candidate.id === edge.id
        ? {
            ...candidate,
            target: junctionId,
            targetHandle: 'terminal',
            selected: false,
          }
        : { ...candidate, selected: false }),
      {
        id: `wire-${timestamp}-${wireIndex}`,
        type: 'logicWire',
        source: junctionId,
        sourceHandle: 'terminal',
        target: edge.target,
        targetHandle: edge.targetHandle,
        selected: false,
      },
    ]);
    markChanged();
  }, [diagram.diagramMode, markChanged, readOnly, setEdges, setNodes]);

  const rotateSelectedSchematicSymbols = useCallback((nodeIds?: string[]) => {
    if (readOnly) return;
    const requested = new Set(nodeIds ?? nodes.filter((node) => node.selected).map((node) => node.id));
    const rotatableIds = new Set(nodes
      .filter((node) => requested.has(node.id) && isElectronicComponentKind(node.data.kind) && node.data.kind !== 'junction')
      .map((node) => node.id));
    if (rotatableIds.size === 0) return;
    setNodes((current) => current.map((node) => {
      if (!rotatableIds.has(node.id) || !isElectronicComponentKind(node.data.kind)) {
        return node;
      }
      return {
        ...node,
        data: {
          ...node.data,
          rotation: rotateSchematicClockwise(node.data.rotation),
        },
      };
    }));
    markChanged();
  }, [markChanged, nodes, readOnly, setNodes]);

  const changeDiagramMode = useCallback((mode: LogicDiagramMode) => {
    if (readOnly || nodes.length > 0 || edges.length > 0 || mode === diagram.diagramMode) return;
    setDiagram((current) => ({ ...current, diagramMode: mode }));
    markChanged();
  }, [diagram.diagramMode, edges.length, markChanged, nodes.length, readOnly]);

  const insertTemplate = useCallback((template: LogicDiagramTemplate) => {
    if (readOnly) return;
    const doc = instantiateLogicDiagramTemplate(template);
    const flowGraph = toFlowGraph(doc);
    // Offset so appended templates don't overlap existing content.
    const offset = clientPointToFlowPosition(getViewportCenterClientPoint());
    setNodes((current) => [
      ...current,
      ...flowGraph.nodes.map((node) => ({
        ...node,
        position: { x: node.position.x + offset.x, y: node.position.y + offset.y },
        selected: false,
      })),
    ]);
    setEdges((current) => [
      ...current,
      ...flowGraph.edges.map((edge) => ({ ...edge, selected: false })),
    ]);
    markChanged();
    setTemplatePickerOpen(false);
    window.setTimeout(fitLogicView, 60);
  }, [clientPointToFlowPosition, fitLogicView, getViewportCenterClientPoint, markChanged, readOnly, setEdges, setNodes]);

  const openSaveComponentDialog = useCallback(() => {
    if (readOnly) return;
    if (!logicComponentsCapability) {
      toast.error('Logic component libraries are not available for this vault.');
      return;
    }
    const selected = nodes.filter((node) => node.selected);
    setComponentName(selected.length > 0 ? 'Selected Component' : title);
    setComponentDescription('');
    setComponentSaveOpen(true);
  }, [logicComponentsCapability, nodes, readOnly, title]);

  const saveLogicComponent = useCallback(async () => {
    if (!logicComponentsCapability) return;
    const name = componentName.trim();
    if (!name) {
      toast.error('Name the component before saving.');
      return;
    }
    try {
      const current = fromFlowGraph(diagram, nodes, edges, getViewport() as Viewport);
      const capture = captureLogicComponent(current, selectedNodeIds, name, componentDescription);
      const saved = await logicComponentsCapability.save(capture.component);
      setLogicComponents((currentComponents) => [
        ...currentComponents.filter((component) => component.id !== saved.id && component.name.toLowerCase() !== saved.name.toLowerCase()),
        saved,
      ].sort((a, b) => a.name.localeCompare(b.name)));
      setComponentSaveOpen(false);
      toast.success(`Saved component "${saved.name}".`);
    } catch (error) {
      toast.error(`Failed to save component: ${error}`);
    }
  }, [componentDescription, componentName, diagram, edges, getViewport, logicComponentsCapability, nodes, selectedNodeIds]);

  const insertLogicComponent = useCallback((component: LogicComponentDefinition) => {
    if (readOnly) return;
    const position = snapPosition(clientPointToFlowPosition(getViewportCenterClientPoint()));
    const node = instantiateLogicComponentNode(component, componentInsertMode, position);
    setNodes((current) => [...current, { ...toFlowGraph({ ...createEmptyLogicDiagram(), nodes: [node], wires: [] }).nodes[0], selected: false }]);
    markChanged();
    setComponentPickerOpen(false);
  }, [clientPointToFlowPosition, componentInsertMode, getViewportCenterClientPoint, markChanged, readOnly, setNodes]);

  const restoreComponentWorkspace = useCallback((session: NonNullable<typeof componentEditSession>) => {
    let restored = session.original;
    const live = liveSessionRef.current;
    if (live) restored = logicDocumentFromJson(live.readJson()) ?? restored;
    const graph = toFlowGraph(restored);
    componentEditingRef.current = null;
    setComponentEditSession(null);
    setComponentEditDirty(false);
    setDiagram(restored);
    canonicalLogicRef.current = restored;
    setNodes(graph.nodes);
    setEdges(graph.edges);
    setViewportState(restored.viewport);
    savedStructuralRef.current = structuralSignature(graph.nodes, graph.edges, restored.diagramMode, restored.simulation);
    lastMarkedSigRef.current = savedStructuralRef.current;
  }, [setEdges, setNodes, structuralSignature]);

  const editLogicComponent = useCallback(async (component: LogicComponentDefinition) => {
    if (readOnly || !logicComponentsCapability || componentEditingRef.current) return;
    try {
      if (!liveSessionRef.current) {
        await controller.requestSave('manual');
        if (controller.getSnapshot().conflicted) {
          toast.error('Resolve the current logic file conflict before editing a component.');
          return;
        }
      }
      const original = fromFlowGraph(diagram, nodes, edges, getViewport() as Viewport);
      const editDocument = logicDocumentFromComponent(component);
      const graph = toFlowGraph(editDocument);
      componentEditingRef.current = component;
      setComponentEditSession({ component, original });
      setComponentEditDirty(false);
      setDiagram(editDocument);
      setNodes(graph.nodes.map((node) => ({ ...node, selected: false })));
      setEdges(graph.edges.map((edge) => ({ ...edge, selected: false })));
      setViewportState(editDocument.viewport);
      setComponentPickerOpen(false);
      window.setTimeout(fitLogicView, 60);
    } catch (error) {
      toast.error(`Could not open component for editing: ${error}`);
    }
  }, [controller, diagram, edges, fitLogicView, getViewport, logicComponentsCapability, nodes, readOnly, setEdges, setNodes]);

  const saveEditedLogicComponent = useCallback(async () => {
    if (!componentEditSession || !logicComponentsCapability) return;
    setSaving(true);
    try {
      const current = fromFlowGraph(diagram, nodes, edges, getViewport() as Viewport);
      const capture = captureLogicComponent(
        current,
        [],
        componentEditSession.component.name,
        componentEditSession.component.description,
      );
      const saved = await logicComponentsCapability.save({
        ...capture.component,
        id: componentEditSession.component.id,
        version: componentEditSession.component.version,
        createdAt: componentEditSession.component.createdAt,
      });
      setLogicComponents((components) => [
        ...components.filter((component) => component.id !== saved.id),
        saved,
      ].sort((a, b) => a.name.localeCompare(b.name)));
      restoreComponentWorkspace(componentEditSession);
      toast.success(`Updated component "${saved.name}".`);
    } catch (error) {
      toast.error(`Failed to update component: ${error}`);
    } finally {
      setSaving(false);
    }
  }, [componentEditSession, diagram, edges, getViewport, logicComponentsCapability, nodes, restoreComponentWorkspace]);

  const duplicateSelection = useCallback(() => {
    if (readOnly) return;
    const selectedNodes = nodes.filter((node) => node.selected && node.data.kind !== 'group' && !node.parentId);
    if (selectedNodes.length === 0) return;
    const selectedNodeIds = new Set(selectedNodes.map((node) => node.id));
    const idMap = new Map<string, string>();
    selectedNodes.forEach((node) => {
      const index = idCounterRef.current++;
      idMap.set(node.id, `dup-${Date.now()}-${index}`);
    });
    const duplicatedNodes: LogicFlowNode[] = selectedNodes.map((node) => ({
      ...node,
      id: idMap.get(node.id)!,
      position: snapPosition({ x: node.position.x + 40, y: node.position.y + 40 }),
      selected: true,
      data: { ...node.data },
    }));
    const duplicatedEdges = edges
      .filter((edge) => selectedNodeIds.has(edge.source) && selectedNodeIds.has(edge.target))
      .map((edge) => {
        const index = idCounterRef.current++;
        return {
          ...edge,
          id: `dup-wire-${Date.now()}-${index}`,
          source: idMap.get(edge.source)!,
          target: idMap.get(edge.target)!,
          selected: true,
        };
      });
    setNodes((current) => [
      ...current.map((node) => ({ ...node, selected: false })),
      ...duplicatedNodes,
    ]);
    setEdges((current) => [
      ...current.map((edge) => ({ ...edge, selected: false })),
      ...duplicatedEdges,
    ]);
    markChanged();
  }, [edges, markChanged, nodes, readOnly, setEdges, setNodes]);

  const toggleInputNodes = useCallback((nodeIds: string[]) => {
    if (readOnly) return;
    const targetIds = new Set(nodeIds);
    if (targetIds.size === 0) return;
    let changed = false;
    setNodes((current) => current.map((node) => {
      if (!targetIds.has(node.id) || node.data.kind !== 'input') return node;
      changed = true;
      return {
        ...node,
        data: {
          ...node.data,
          value: node.data.value !== true,
        },
      };
    }));
    if (changed) markChanged();
  }, [markChanged, readOnly, setNodes]);

  const openClockSettings = useCallback((node: LogicFlowNode) => {
    if (node.data.kind !== 'clock') return;
    setClockSettingsNodeId(node.id);
    setClockPeriodValue(String(Math.round(node.data.clock?.periodMs ?? 1000)));
    setClockDutyValue(String(Math.round((node.data.clock?.dutyCycle ?? 0.5) * 100)));
    setClockPhaseValue(String(Math.round(node.data.clock?.phaseMs ?? 0)));
  }, []);

  const saveClockSettings = useCallback(() => {
    if (!clockSettingsNodeId || readOnly) return;
    const periodMs = Math.max(100, Number(clockPeriodValue) || 1000);
    const dutyCycle = Math.min(95, Math.max(5, Number(clockDutyValue) || 50)) / 100;
    const phaseMs = Math.max(0, Number(clockPhaseValue) || 0);
    setNodes((current) => current.map((node) => node.id === clockSettingsNodeId
      ? { ...node, data: { ...node.data, clock: { periodMs, dutyCycle, phaseMs } } }
      : node));
    setClockSettingsNodeId(null);
    markChanged();
  }, [clockDutyValue, clockPeriodValue, clockPhaseValue, clockSettingsNodeId, markChanged, readOnly, setNodes]);

  const openSchematicSettings = useCallback((node: LogicFlowNode) => {
    if (!isElectronicComponentKind(node.data.kind) || node.data.kind === 'ground' || node.data.kind === 'junction') return;
    const numeric = schematicNumericField(node.data.kind);
    if (numeric) {
      setSchematicValueInput(String(node.data.electrical?.[numeric.field] ?? ''));
    } else if (node.data.kind === 'switch') {
      setSchematicSwitchClosed(node.data.electrical?.switchClosed === true);
      setSchematicValueInput('');
    } else {
      setSchematicValueInput(node.data.electrical?.modelRef ?? '');
    }
    setSchematicSettingsNodeId(node.id);
  }, []);

  const saveSchematicSettings = useCallback(() => {
    if (!schematicSettingsNodeId || readOnly) return;
    const node = nodes.find((candidate) => candidate.id === schematicSettingsNodeId);
    if (!node || !isElectronicComponentKind(node.data.kind) || node.data.kind === 'ground' || node.data.kind === 'junction') return;

    let electrical: SchematicElectricalParameters;
    const numeric = schematicNumericField(node.data.kind);
    if (numeric) {
      const trimmedValue = schematicValueInput.trim();
      const value = Number(trimmedValue);
      if (!trimmedValue || !Number.isFinite(value) || (numeric.positive && value <= 0)) {
        toast.error(`${numeric.label} must be ${numeric.positive ? 'greater than zero' : 'a valid number'}.`);
        return;
      }
      electrical = { [numeric.field]: value };
    } else if (node.data.kind === 'switch') {
      electrical = { switchClosed: schematicSwitchClosed };
    } else {
      const modelRef = schematicValueInput.trim();
      if (!modelRef) {
        toast.error('Select or enter a component model.');
        return;
      }
      electrical = { modelRef };
    }

    setNodes((current) => current.map((candidate) => candidate.id === schematicSettingsNodeId
      ? { ...candidate, data: { ...candidate.data, electrical } }
      : candidate));
    setSchematicSettingsNodeId(null);
    markChanged();
  }, [markChanged, nodes, readOnly, schematicSettingsNodeId, schematicSwitchClosed, schematicValueInput, setNodes]);

  const runDcSimulation = useCallback(async () => {
    if (diagram.diagramMode !== 'schematic' || circuitRunning) return;
    const runSequence = ++circuitRunSequenceRef.current;
    const document = fromFlowGraph(diagram, nodes, edges, viewport);
    setCircuitRunning(true);
    setCircuitRunKind('dc');
    setCircuitError(null);
    setCircuitResultsOpen(true);
    setSweepResultsOpen(false);
    try {
      const outcome = await runCircuitJob(DESKTOP_CIRCUIT_JOB_CLIENT, document, {
        onStarted: (jobId) => {
          circuitJobIdRef.current = jobId;
          if (circuitMountedRef.current && circuitRunSequenceRef.current === runSequence) {
            setCircuitJobId(jobId);
            setCircuitJobStatus({ phase: 'queued', stage: 'queued', elapsedMillis: 0 });
          } else {
            void tauriCommands.circuitCancelJob(jobId).catch(() => undefined);
          }
        },
        onStatus: (status) => {
          if (circuitMountedRef.current && circuitRunSequenceRef.current === runSequence) {
            setCircuitJobStatus(status);
          }
        },
      });
      if (!circuitMountedRef.current || circuitRunSequenceRef.current !== runSequence) return;
      if (outcome.state === 'completed') {
        setCircuitResult(outcome.result);
        setCircuitResultSignature(circuitInputSignature);
      } else if (outcome.state === 'failed') {
        throw outcome.error;
      }
    } catch (error) {
      if (circuitMountedRef.current && circuitRunSequenceRef.current === runSequence) {
        setCircuitResult(null);
        setCircuitResultSignature(null);
        setCircuitError(circuitErrorText(error));
      }
    } finally {
      if (circuitJobIdRef.current) circuitJobIdRef.current = null;
      if (circuitMountedRef.current && circuitRunSequenceRef.current === runSequence) {
        setCircuitJobId(null);
        setCircuitJobStatus(null);
        setCircuitRunning(false);
        setCircuitRunKind(null);
      }
    }
  }, [circuitInputSignature, circuitRunning, diagram, edges, nodes, viewport]);

  const openSweepConfiguration = useCallback(() => {
    const config = diagram.simulation?.dcSweep;
    setSweepSourceInput(config?.sourceNodeId ?? sweepSourceChoices[0]?.id ?? '');
    setSweepStartInput(String(config?.start ?? 0));
    setSweepStopInput(String(config?.stop ?? 5));
    setSweepSamplesInput(String(config?.sampleCount ?? 101));
    setSweepConfigOpen(true);
  }, [diagram.simulation?.dcSweep, sweepSourceChoices]);

  const saveSweepConfiguration = useCallback(() => {
    if (readOnly) return;
    const start = Number(sweepStartInput);
    const stop = Number(sweepStopInput);
    const sampleCount = Number(sweepSamplesInput);
    if (!sweepSourceChoices.some((source) => source.id === sweepSourceInput)) {
      toast.error('Select an independent voltage source.');
      return;
    }
    if (!Number.isFinite(start) || !Number.isFinite(stop) || start === stop) {
      toast.error('Sweep start and stop must be different finite values.');
      return;
    }
    if (!Number.isInteger(sampleCount) || sampleCount < 2 || sampleCount > 4096) {
      toast.error('Sweep samples must be a whole number from 2 to 4096.');
      return;
    }
    setDiagram((current) => ({
      ...current,
      simulation: {
        ...current.simulation,
        analysis: 'dc-sweep',
        probes: current.simulation?.probes ?? [],
        dcSweep: {
          sourceNodeId: sweepSourceInput,
          start,
          stop,
          sampleCount,
        },
      },
    }));
    markChanged();
    setSweepConfigOpen(false);
  }, [markChanged, readOnly, sweepSamplesInput, sweepSourceChoices, sweepSourceInput, sweepStartInput, sweepStopInput]);

  const runDcSweep = useCallback(async () => {
    if (diagram.diagramMode !== 'schematic' || circuitRunning) return;
    if (!diagram.simulation?.dcSweep) {
      openSweepConfiguration();
      return;
    }
    if ((diagram.simulation.probes?.length ?? 0) === 0) {
      toast.error('Add at least one voltage or current probe before running a sweep.');
      return;
    }
    const runSequence = ++circuitRunSequenceRef.current;
    const document = fromFlowGraph(diagram, nodes, edges, viewport);
    setCircuitRunning(true);
    setCircuitRunKind('sweep');
    setSweepError(null);
    setSweepResultsOpen(true);
    setCircuitResultsOpen(false);
    try {
      const result = await runCircuitSweepJob(DESKTOP_SWEEP_JOB_CLIENT, document, {
        onStarted: (jobId) => {
          circuitJobIdRef.current = jobId;
          if (circuitMountedRef.current && circuitRunSequenceRef.current === runSequence) {
            setCircuitJobId(jobId);
            setCircuitJobStatus({ phase: 'queued', stage: 'queued', elapsedMillis: 0 });
          } else {
            void tauriCommands.circuitCancelJob(jobId).catch(() => undefined);
          }
        },
        onStatus: (status) => {
          if (circuitMountedRef.current && circuitRunSequenceRef.current === runSequence) {
            setCircuitJobStatus(status);
          }
        },
      });
      if (!circuitMountedRef.current || circuitRunSequenceRef.current !== runSequence) return;
      if ('sourceValues' in result) {
        setSweepResult(result);
        setSweepResultSignature(circuitInputSignature);
      } else if (result.state === 'failed') {
        throw result.error;
      }
    } catch (error) {
      if (circuitMountedRef.current && circuitRunSequenceRef.current === runSequence) {
        setSweepResult(null);
        setSweepResultSignature(null);
        setSweepError(circuitErrorText(error));
      }
    } finally {
      if (circuitJobIdRef.current) circuitJobIdRef.current = null;
      if (circuitMountedRef.current && circuitRunSequenceRef.current === runSequence) {
        setCircuitJobId(null);
        setCircuitJobStatus(null);
        setCircuitRunning(false);
        setCircuitRunKind(null);
      }
    }
  }, [circuitInputSignature, circuitRunning, diagram, edges, nodes, openSweepConfiguration, viewport]);

  const loadTransientWaveform = useCallback((sourceId: string) => {
    const waveform = diagram.simulation?.transient?.sourceWaveforms[sourceId];
    const kind = waveform?.kind ?? 'pulse';
    setTransientWaveformKind(kind);
    if (kind === 'pulse') {
      setTransientWaveformInputs({
        lowValue: String(waveform?.lowValue ?? 0),
        highValue: String(waveform?.highValue ?? 5),
        delaySeconds: String(waveform?.delaySeconds ?? 0.001),
        riseSeconds: String(waveform?.riseSeconds ?? 0),
        fallSeconds: String(waveform?.fallSeconds ?? 0),
        pulseWidthSeconds: String(waveform?.pulseWidthSeconds ?? 0.005),
        periodSeconds: String(waveform?.periodSeconds ?? 0.01),
      });
    } else if (kind === 'sine') {
      setTransientWaveformInputs({
        offset: String(waveform?.offset ?? 0),
        amplitude: String(waveform?.amplitude ?? 5),
        frequencyHertz: String(waveform?.frequencyHertz ?? 50),
        phaseDegrees: String(waveform?.phaseDegrees ?? 0),
        delaySeconds: String(waveform?.delaySeconds ?? 0),
        dampingPerSecond: String(waveform?.dampingPerSecond ?? 0),
      });
    } else {
      setTransientWaveformInputs({});
    }
  }, [diagram.simulation?.transient?.sourceWaveforms]);

  const openTransientConfiguration = useCallback(() => {
    const config = diagram.simulation?.transient;
    const sourceId = Object.keys(config?.sourceWaveforms ?? {})[0] ?? sweepSourceChoices[0]?.id ?? '';
    setTransientDurationInput(String(config?.durationSeconds ?? 0.01));
    setTransientStepInput(String(config?.maxTimeStepSeconds ?? 0.0001));
    setTransientSourceInput(sourceId);
    loadTransientWaveform(sourceId);
    setTransientConfigOpen(true);
  }, [diagram.simulation?.transient, loadTransientWaveform, sweepSourceChoices]);

  const saveTransientConfiguration = useCallback(() => {
    if (readOnly) return;
    const durationSeconds = Number(transientDurationInput);
    const maxTimeStepSeconds = Number(transientStepInput);
    if (!Number.isFinite(durationSeconds) || durationSeconds <= 0 || durationSeconds > 3_600) {
      toast.error('Transient duration must be greater than zero and at most one hour.');
      return;
    }
    if (!Number.isFinite(maxTimeStepSeconds) || maxTimeStepSeconds <= 0 || maxTimeStepSeconds > durationSeconds) {
      toast.error('Maximum timestep must be greater than zero and no larger than the duration.');
      return;
    }
    if (Math.ceil(durationSeconds / maxTimeStepSeconds) + 1 > 4_096) {
      toast.error('Increase the maximum timestep so the run contains at most 4,096 samples.');
      return;
    }
    if (!sweepSourceChoices.some((source) => source.id === transientSourceInput)) {
      toast.error('Select an independent voltage source.');
      return;
    }
    const numberValue = (name: string) => Number(transientWaveformInputs[name]);
    let waveform: LogicSourceWaveform;
    if (transientWaveformKind === 'dc') {
      waveform = { kind: 'dc' };
    } else if (transientWaveformKind === 'pulse') {
      const lowValue = numberValue('lowValue');
      const highValue = numberValue('highValue');
      const delaySeconds = numberValue('delaySeconds');
      const riseSeconds = numberValue('riseSeconds');
      const fallSeconds = numberValue('fallSeconds');
      const pulseWidthSeconds = numberValue('pulseWidthSeconds');
      const periodSeconds = numberValue('periodSeconds');
      if (![lowValue, highValue, delaySeconds, riseSeconds, fallSeconds, pulseWidthSeconds, periodSeconds].every(Number.isFinite)
        || delaySeconds < 0 || riseSeconds < 0 || fallSeconds < 0 || pulseWidthSeconds <= 0 || periodSeconds <= 0
        || riseSeconds + pulseWidthSeconds + fallSeconds > periodSeconds) {
        toast.error('Pulse values must be finite, non-negative, and fit within the period.');
        return;
      }
      waveform = { kind: 'pulse', lowValue, highValue, delaySeconds, riseSeconds, fallSeconds, pulseWidthSeconds, periodSeconds };
    } else {
      const offset = numberValue('offset');
      const amplitude = numberValue('amplitude');
      const frequencyHertz = numberValue('frequencyHertz');
      const phaseDegrees = numberValue('phaseDegrees');
      const delaySeconds = numberValue('delaySeconds');
      const dampingPerSecond = numberValue('dampingPerSecond');
      if (![offset, amplitude, frequencyHertz, phaseDegrees, delaySeconds, dampingPerSecond].every(Number.isFinite)
        || frequencyHertz <= 0 || delaySeconds < 0 || dampingPerSecond < 0) {
        toast.error('Sine values must be finite with positive frequency and non-negative delay and damping.');
        return;
      }
      waveform = { kind: 'sine', offset, amplitude, frequencyHertz, phaseDegrees, delaySeconds, dampingPerSecond };
    }
    setDiagram((current) => ({
      ...current,
      simulation: {
        ...current.simulation,
        analysis: 'transient',
        probes: current.simulation?.probes ?? [],
        transient: {
          durationSeconds,
          maxTimeStepSeconds,
          sourceWaveforms: {
            ...(current.simulation?.transient?.sourceWaveforms ?? {}),
            [transientSourceInput]: waveform,
          },
        },
      },
    }));
    markChanged();
    setTransientConfigOpen(false);
  }, [markChanged, readOnly, sweepSourceChoices, transientDurationInput, transientSourceInput, transientStepInput, transientWaveformInputs, transientWaveformKind]);

  const runTransient = useCallback(async () => {
    if (diagram.diagramMode !== 'schematic' || circuitRunning) return;
    if (!diagram.simulation?.transient) {
      openTransientConfiguration();
      return;
    }
    if ((diagram.simulation.probes?.length ?? 0) === 0) {
      toast.error('Add at least one voltage or current probe before running transient analysis.');
      return;
    }
    const runSequence = ++circuitRunSequenceRef.current;
    const document = fromFlowGraph(diagram, nodes, edges, viewport);
    setCircuitRunning(true);
    setCircuitRunKind('transient');
    setTransientError(null);
    setTransientResultsOpen(true);
    setCircuitResultsOpen(false);
    setSweepResultsOpen(false);
    try {
      const result = await runCircuitTransientJob(DESKTOP_TRANSIENT_JOB_CLIENT, document, {
        onStarted: (jobId) => {
          circuitJobIdRef.current = jobId;
          if (circuitMountedRef.current && circuitRunSequenceRef.current === runSequence) {
            setCircuitJobId(jobId);
            setCircuitJobStatus({ phase: 'queued', stage: 'queued', elapsedMillis: 0 });
          } else {
            void tauriCommands.circuitCancelJob(jobId).catch(() => undefined);
          }
        },
        onStatus: (status) => {
          if (circuitMountedRef.current && circuitRunSequenceRef.current === runSequence) setCircuitJobStatus(status);
        },
      });
      if (!circuitMountedRef.current || circuitRunSequenceRef.current !== runSequence) return;
      if ('timeSeconds' in result) {
        setTransientResult(result);
        setTransientResultSignature(circuitInputSignature);
      } else if (result.state === 'failed') {
        throw result.error;
      }
    } catch (error) {
      if (circuitMountedRef.current && circuitRunSequenceRef.current === runSequence) {
        setTransientResult(null);
        setTransientResultSignature(null);
        setTransientError(circuitErrorText(error));
      }
    } finally {
      if (circuitJobIdRef.current) circuitJobIdRef.current = null;
      if (circuitMountedRef.current && circuitRunSequenceRef.current === runSequence) {
        setCircuitJobId(null);
        setCircuitJobStatus(null);
        setCircuitRunning(false);
        setCircuitRunKind(null);
      }
    }
  }, [circuitInputSignature, circuitRunning, diagram, edges, nodes, openTransientConfiguration, viewport]);

  const cancelDcSimulation = useCallback(async () => {
    const activeJobId = circuitJobIdRef.current;
    if (!activeJobId) return;
    try {
      const phase = await tauriCommands.circuitCancelJob(activeJobId);
      if (circuitMountedRef.current) {
        setCircuitJobStatus((current) => current ? { ...current, phase } : current);
      }
    } catch (error) {
      if (circuitMountedRef.current) {
        if (circuitRunKind === 'sweep') setSweepError(circuitErrorText(error));
        else if (circuitRunKind === 'transient') setTransientError(circuitErrorText(error));
        else setCircuitError(circuitErrorText(error));
      }
    }
  }, [circuitRunKind]);

  const resetCircuitResults = useCallback(() => {
    setCircuitResult(null);
    setCircuitResultSignature(null);
    setCircuitError(null);
    setCircuitResultsOpen(false);
  }, []);

  const resetSweepResults = useCallback(() => {
    setSweepResult(null);
    setSweepResultSignature(null);
    setSweepError(null);
    setSweepResultsOpen(false);
  }, []);

  const resetTransientResults = useCallback(() => {
    setTransientResult(null);
    setTransientResultSignature(null);
    setTransientError(null);
    setTransientResultsOpen(false);
  }, []);

  const exportSweepResult = useCallback(async (format: 'csv' | 'svg') => {
    if (!sweepResult) return;
    const sourceLabel = sweepSourceChoices.find((source) => source.id === sweepResult.source)?.label;
    const baseName = getDocumentBaseName(relativePath, 'circuit').replace(/\.logic$/i, '');
    const destination = await tauriCommands.showDownloadDialog(`${baseName}-dc-sweep.${format}`);
    if (!destination) return;
    const content = format === 'csv'
      ? buildCircuitSweepCsv(sweepResult, sourceLabel)
      : buildCircuitSweepSvg(sweepResult, sourceLabel);
    await tauriCommands.writeDownloadedFile(destination, utf8ToBase64(content));
    toast.success(`DC sweep exported as ${format.toUpperCase()}.`);
  }, [relativePath, sweepResult, sweepSourceChoices]);

  const startClocks = useCallback(() => {
    clockStartedAtRef.current = Date.now() - clockElapsedMs;
    setClockRunning(true);
  }, [clockElapsedMs]);

  const resetClocks = useCallback(() => {
    clockStartedAtRef.current = Date.now();
    setClockElapsedMs(0);
  }, []);

  const handleNodeDoubleClick = useCallback((node: LogicFlowNode) => {
    if (readOnly) return;
    if (isElectronicComponentKind(node.data.kind)) {
      if (node.data.kind === 'ground' || node.data.kind === 'junction') openRenameNode(node.id);
      else openSchematicSettings(node);
      return;
    }
    if (node.data.kind === 'input') {
      toggleInputNodes([node.id]);
      return;
    }
    if (node.data.kind === 'clock') {
      openClockSettings(node);
      return;
    }
    if (node.data.kind === 'group' || node.data.kind === 'output') {
      openRenameNode(node.id);
      return;
    }
    // Logic gates (and/or/not/xor/...) — open label editor
    openRenameNode(node.id);
  }, [openClockSettings, openRenameNode, openSchematicSettings, readOnly, toggleInputNodes]);

  const deleteSelection = useCallback(() => {
    if (readOnly) return;
    const selectedNodeIdSet = new Set([
      ...selectedNodeIds,
      ...nodes.filter((node) => node.selected).map((node) => node.id),
    ]);
    const selectedEdgeIdSet = new Set([
      ...selectedEdgeIds,
      ...edges.filter((edge) => edge.selected).map((edge) => edge.id),
    ]);
    if (selectedNodeIdSet.size === 0 && selectedEdgeIdSet.size === 0) return;

    const nodeIds = new Set(selectedNodeIdSet);
    for (const node of nodes) {
      if (node.parentId && nodeIds.has(node.parentId)) nodeIds.add(node.id);
    }
    setNodes((current) => current.filter((node) => !nodeIds.has(node.id)));
    setEdges((current) => current.filter((edge) => (
      !selectedEdgeIdSet.has(edge.id) && !nodeIds.has(edge.source) && !nodeIds.has(edge.target)
    )));
    setDiagram((current) => {
      const probes = current.simulation?.probes.filter((probe) => !nodeIds.has(probe.nodeId)) ?? [];
      const removesSweepSource = current.simulation?.dcSweep
        ? nodeIds.has(current.simulation.dcSweep.sourceNodeId)
        : false;
      const sourceWaveforms = Object.fromEntries(
        Object.entries(current.simulation?.transient?.sourceWaveforms ?? {})
          .filter(([sourceNodeId]) => !nodeIds.has(sourceNodeId)),
      );
      const removesTransientSource = Object.keys(sourceWaveforms).length
        !== Object.keys(current.simulation?.transient?.sourceWaveforms ?? {}).length;
      if (probes.length === (current.simulation?.probes.length ?? 0) && !removesSweepSource && !removesTransientSource) return current;
      return {
        ...current,
        simulation: {
          ...current.simulation,
          analysis: removesSweepSource ? 'dc-operating-point' : current.simulation?.analysis ?? 'dc-operating-point',
          probes,
          dcSweep: removesSweepSource ? undefined : current.simulation?.dcSweep,
          transient: current.simulation?.transient
            ? { ...current.simulation.transient, sourceWaveforms }
            : undefined,
        },
      };
    });
    markChanged();
  }, [edges, markChanged, nodes, readOnly, selectedEdgeIds, selectedNodeIds, setEdges, setNodes]);

  const deleteEdge = useCallback((edgeId: string) => {
    if (readOnly) return;
    setEdges((current) => current.filter((edge) => edge.id !== edgeId));
    markChanged();
  }, [markChanged, readOnly, setEdges]);

  const addVoltageProbe = useCallback((edge: LogicFlowEdge) => {
    if (readOnly || diagram.diagramMode !== 'schematic') return;
    const handleId = edge.sourceHandle;
    const sourceNode = nodes.find((node) => node.id === edge.source);
    if (!handleId || !sourceNode || !isElectronicComponentKind(sourceNode.data.kind)) {
      toast.error('This wire is not attached to a valid schematic terminal.');
      return;
    }
    const existing = diagram.simulation?.probes.some((probe) => (
      probe.kind === 'node-voltage'
      && probe.nodeId === sourceNode.id
      && probe.handleId === handleId
    ));
    if (existing) {
      toast.message('That terminal already has a voltage probe.');
      return;
    }
    const index = idCounterRef.current++;
    const probe: LogicCircuitProbe = {
      id: `voltage-probe-${Date.now()}-${index}`,
      kind: 'node-voltage',
      nodeId: sourceNode.id,
      handleId,
      label: typeof edge.label === 'string' && edge.label.trim()
        ? edge.label.trim()
        : `${logicNodeLabel({ kind: sourceNode.data.kind, label: sourceNode.data.label })} · ${handleId}`,
    };
    setDiagram((current) => ({
      ...current,
      simulation: {
        ...current.simulation,
        analysis: current.simulation?.analysis ?? 'dc-operating-point',
        probes: [...(current.simulation?.probes ?? []), probe],
      },
    }));
    markChanged();
    toast.success('Voltage probe added. Run DC to read it.');
  }, [diagram.diagramMode, diagram.simulation?.probes, markChanged, nodes, readOnly]);

  const addBranchCurrentProbe = useCallback((node: LogicFlowNode) => {
    if (readOnly || diagram.diagramMode !== 'schematic' || !isElectronicComponentKind(node.data.kind) || node.data.kind === 'ground' || node.data.kind === 'junction') return;
    const existing = diagram.simulation?.probes.some((probe) => (
      probe.kind === 'branch-current' && probe.nodeId === node.id
    ));
    if (existing) {
      toast.message('That component already has a branch-current probe.');
      return;
    }
    const index = idCounterRef.current++;
    const probe: LogicCircuitProbe = {
      id: `current-probe-${Date.now()}-${index}`,
      kind: 'branch-current',
      nodeId: node.id,
      label: `${logicNodeLabel({ kind: node.data.kind, label: node.data.label })} current`,
    };
    setDiagram((current) => ({
      ...current,
      simulation: {
        ...current.simulation,
        analysis: current.simulation?.analysis ?? 'dc-operating-point',
        probes: [...(current.simulation?.probes ?? []), probe],
      },
    }));
    markChanged();
    toast.success('Branch-current probe added. Run DC to read it.');
  }, [diagram.diagramMode, diagram.simulation?.probes, markChanged, readOnly]);

  const removeCircuitProbe = useCallback((probeId: string) => {
    if (readOnly) return;
    setDiagram((current) => ({
      ...current,
      simulation: {
        ...current.simulation,
        analysis: current.simulation?.analysis ?? 'dc-operating-point',
        probes: current.simulation?.probes.filter((probe) => probe.id !== probeId) ?? [],
      },
    }));
    markChanged();
  }, [markChanged, readOnly]);

  const changeSelectedGateKind = useCallback((kind: LogicGateKind) => {
    if (readOnly) return;
    if (kind === 'group') return;
    const selectedIds = new Set(selectedNodeIds);
    if (selectedIds.size === 0) return;
    const nextKindById = new Map(
      nodes
        .filter((node) => selectedIds.has(node.id) && node.data.kind !== 'group' && node.data.kind !== 'component')
        .map((node) => [node.id, kind]),
    );
    setNodes((current) => current.map((node) => (
      selectedIds.has(node.id) && node.data.kind !== 'group' && node.data.kind !== 'component'
        ? {
            ...node,
            data: {
              ...node.data,
              kind,
              value: kind === 'input' ? (typeof node.data.value === 'boolean' ? node.data.value : false) : undefined,
            },
        }
        : node
    )));
    const kindForNode = (nodeId: string) => nextKindById.get(nodeId)
      ?? nodes.find((node) => node.id === nodeId)?.data.kind;
    setEdges((current) => {
      const usedTargetHandles = new Set<string>();
      return current.flatMap((edge) => {
        const sourceKind = kindForNode(edge.source);
        const targetKind = kindForNode(edge.target);
        if (!sourceKind || !targetKind) return [];

        const sourceNode = nodes.find((node) => node.id === edge.source);
        const targetNode = nodes.find((node) => node.id === edge.target);
        const sourceHandles = getLogicOutputHandles(sourceKind, sourceNode?.data.component);
        const targetHandles = getLogicInputHandles(targetKind, targetNode?.data.component);
        if (sourceHandles.length === 0 || targetHandles.length === 0) return [];

        const sourceHandle = edge.sourceHandle && sourceHandles.includes(edge.sourceHandle)
          ? edge.sourceHandle
          : sourceHandles[0];
        const targetHandle = edge.targetHandle && targetHandles.includes(edge.targetHandle)
          ? edge.targetHandle
          : targetHandles[0];
        const targetKey = `${edge.target}:${targetHandle}`;
        if (usedTargetHandles.has(targetKey)) return [];
        usedTargetHandles.add(targetKey);

        return [{
          ...edge,
          sourceHandle,
          targetHandle,
        }];
      });
    });
    markChanged();
  }, [markChanged, nodes, readOnly, selectedNodeIds, setEdges, setNodes]);

  const handlePaneContextMenu = useCallback((event: MouseEvent | ReactMouseEvent) => {
    if (readOnly) return;
    event.preventDefault();
    const position = getMenuPosition(event.clientX, event.clientY);
    setContextMenu({
      kind: 'pane',
      ...position,
      flowPosition: clientPointToFlowPosition({ x: event.clientX, y: event.clientY }),
    });
  }, [clientPointToFlowPosition, getMenuPosition, readOnly]);

  const handleNodeContextMenu = useCallback((event: ReactMouseEvent<HTMLDivElement>, node: LogicFlowNode) => {
    if (readOnly) return;
    event.preventDefault();
    event.stopPropagation();
    const position = getMenuPosition(event.clientX, event.clientY);
    if (!node.selected) {
      setNodes((current) => current.map((candidate) => ({
        ...candidate,
        selected: candidate.id === node.id,
      })));
      setEdges((current) => current.map((edge) => ({ ...edge, selected: false })));
    }
    setContextMenu({
      kind: 'node',
      ...position,
      nodeId: node.id,
    });
  }, [getMenuPosition, readOnly, setEdges, setNodes]);

  const handleEdgeContextMenu = useCallback((event: ReactMouseEvent<SVGPathElement>, edge: LogicFlowEdge) => {
    if (readOnly) return;
    event.preventDefault();
    event.stopPropagation();
    const position = getMenuPosition(event.clientX, event.clientY);
    const viewportRect = viewportRef.current?.getBoundingClientRect();
    const pointer = viewportRect
      ? { x: event.clientX - viewportRect.left, y: event.clientY - viewportRect.top }
      : { x: event.clientX, y: event.clientY };
    const projected = closestPointOnSvgPath(event.currentTarget, pointer);
    if (!edge.selected) {
      setNodes((current) => current.map((node) => ({ ...node, selected: false })));
      setEdges((current) => current.map((candidate) => ({
        ...candidate,
        selected: candidate.id === edge.id,
      })));
    }
    setContextMenu({
      kind: 'edge',
      ...position,
      edgeId: edge.id,
      flowPosition: screenToFlow(projected, viewport),
    });
  }, [getMenuPosition, readOnly, setEdges, setNodes, viewport]);

  const handlePanePointerDown = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 && event.button !== 1) return;
    closeContextMenu();
    const target = event.target as HTMLElement;
    if (target.closest('[data-logic-node], [data-logic-handle], [data-logic-edge]')) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const pointer = { x: event.clientX - rect.left, y: event.clientY - rect.top };
    if (event.button === 1) {
      panSessionRef.current = {
        pointerId: event.pointerId,
        start: { x: event.clientX, y: event.clientY },
        viewport,
      };
      event.currentTarget.setPointerCapture(event.pointerId);
      return;
    }
    const additive = event.shiftKey || event.ctrlKey || event.metaKey;
    selectionSessionRef.current = {
      pointerId: event.pointerId,
      start: pointer,
      current: pointer,
      additive,
      baseNodeIds: new Set(nodes.filter((node) => node.selected).map((node) => node.id)),
      baseEdgeIds: new Set(edges.filter((edge) => edge.selected).map((edge) => edge.id)),
      moved: false,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
    if (!additive) {
      setNodes((current) => current.map((node) => ({ ...node, selected: false })));
      setEdges((current) => current.map((edge) => ({ ...edge, selected: false })));
    }
  }, [closeContextMenu, edges, nodes, setEdges, setNodes, viewport]);

  const handlePaneWheel = useCallback((event: ReactWheelEvent<HTMLDivElement>) => {
    event.preventDefault();
    if (event.ctrlKey) {
      const rect = event.currentTarget.getBoundingClientRect();
      const pointer = {
        x: event.clientX - rect.left,
        y: event.clientY - rect.top,
      };
      setViewportState((current) => {
        const wheelDelta = Math.max(-240, Math.min(240, event.deltaY));
        const nextZoom = Math.min(
          MAX_LOGIC_ZOOM,
          Math.max(MIN_LOGIC_ZOOM, current.zoom * Math.exp(-wheelDelta * LOGIC_WHEEL_ZOOM_SENSITIVITY)),
        );
        const flowPoint = screenToFlow(pointer, current);
        return {
          x: pointer.x - flowPoint.x * nextZoom,
          y: pointer.y - flowPoint.y * nextZoom,
          zoom: nextZoom,
        };
      });
      return;
    }
    setViewportState((current) => ({
      ...current,
      x: current.x - event.deltaX,
      y: current.y - event.deltaY,
    }));
  }, []);

  const handlePanePointerMove = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (panSessionRef.current?.pointerId === event.pointerId) {
      const session = panSessionRef.current;
      setViewportState({
        ...session.viewport,
        x: session.viewport.x + event.clientX - session.start.x,
        y: session.viewport.y + event.clientY - session.start.y,
      });
      return;
    }
    if (dragSessionRef.current?.pointerId === event.pointerId) {
      const session = dragSessionRef.current;
      const moved = Math.abs(event.clientX - session.start.x) > 2 || Math.abs(event.clientY - session.start.y) > 2;
      if (moved) {
        dragSessionRef.current = { ...session, moved: true };
      }
      const delta = {
        x: (event.clientX - session.start.x) / viewport.zoom,
        y: (event.clientY - session.start.y) / viewport.zoom,
      };
      setNodes((current) => current.map((node) => {
        const start = session.positions.get(node.id);
        return start ? { ...node, position: snapPosition({ x: start.x + delta.x, y: start.y + delta.y }) } : node;
      }));
      return;
    }
    if (selectionSessionRef.current?.pointerId === event.pointerId) {
      const rect = event.currentTarget.getBoundingClientRect();
      const pointer = { x: event.clientX - rect.left, y: event.clientY - rect.top };
      const session = selectionSessionRef.current;
      const moved = Math.abs(pointer.x - session.start.x) > 2 || Math.abs(pointer.y - session.start.y) > 2;
      const left = Math.min(session.start.x, pointer.x);
      const top = Math.min(session.start.y, pointer.y);
      const right = Math.max(session.start.x, pointer.x);
      const bottom = Math.max(session.start.y, pointer.y);
      const selectedIds = new Set<string>();
      for (const node of renderedNodes) {
        const position = flowToScreen(absoluteNodePosition(node, nodesById), viewport);
        const nodeRight = position.x + nodeBaseWidth(node) * viewport.zoom;
        const nodeBottom = position.y + nodeBaseHeight(node) * viewport.zoom;
        if (position.x <= right && nodeRight >= left && position.y <= bottom && nodeBottom >= top) {
          selectedIds.add(node.id);
        }
      }
      const nextNodeIds = new Set(session.additive ? [...session.baseNodeIds, ...selectedIds] : selectedIds);
      const nextEdgeIds = new Set(session.additive ? session.baseEdgeIds : []);
      for (const edge of renderedEdges) {
        if (nextNodeIds.has(edge.source) && nextNodeIds.has(edge.target)) {
          nextEdgeIds.add(edge.id);
        }
      }
      selectionSessionRef.current = { ...session, current: pointer, moved };
      setSelectionBox(moved ? { left, top, width: right - left, height: bottom - top } : null);
      setNodes((current) => current.map((node) => ({ ...node, selected: nextNodeIds.has(node.id) })));
      setEdges((current) => current.map((edge) => ({ ...edge, selected: nextEdgeIds.has(edge.id) })));
      return;
    }
    if (connectionSessionRef.current) {
      const rect = viewportRef.current?.getBoundingClientRect();
      const pointer = rect
        ? { x: event.clientX - rect.left, y: event.clientY - rect.top }
        : { x: event.clientX, y: event.clientY };
      const snapped = getConnectionSnap(
        pointer,
        connectionSessionRef.current.sourceNodeId,
        connectionSessionRef.current.sourceHandle,
      );
      connectionSessionRef.current = {
        ...connectionSessionRef.current,
        pointer: snapped.pointer,
        target: snapped.target,
      };
      setConnectionPreview({ ...connectionSessionRef.current });
    }
  }, [getConnectionSnap, nodesById, renderedEdges, renderedNodes, setEdges, setNodes, viewport]);

  const finishPointerSessionById = useCallback((pointerId: number, captureTarget?: Element | null) => {
    if (panSessionRef.current?.pointerId === pointerId) {
      panSessionRef.current = null;
      if (captureTarget instanceof HTMLElement && captureTarget.hasPointerCapture(pointerId)) {
        captureTarget.releasePointerCapture(pointerId);
      }
    }
    if (dragSessionRef.current?.pointerId === pointerId) {
      const { moved } = dragSessionRef.current;
      dragSessionRef.current = null;
      if (captureTarget instanceof HTMLElement && captureTarget.hasPointerCapture(pointerId)) {
        captureTarget.releasePointerCapture(pointerId);
      }
      if (moved) markChanged();
    }
    if (selectionSessionRef.current?.pointerId === pointerId) {
      selectionSessionRef.current = null;
      setSelectionBox(null);
      if (captureTarget instanceof HTMLElement && captureTarget.hasPointerCapture(pointerId)) {
        captureTarget.releasePointerCapture(pointerId);
      }
    }
    if (connectionSessionRef.current) {
      const { sourceNodeId, sourceHandle, target } = connectionSessionRef.current;
      connectionSessionRef.current = null;
      setConnectionPreview(null);
      if (target) {
        onConnect({
          source: sourceNodeId,
          target: target.nodeId,
          sourceHandle,
          targetHandle: target.handleId,
        });
      }
    }
  }, [markChanged, onConnect]);

  const finishPointerSession = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    finishPointerSessionById(event.pointerId, event.currentTarget);
  }, [finishPointerSessionById]);

  useEffect(() => {
    const finishFromWindow = (event: PointerEvent) => {
      const pane = viewportRef.current?.querySelector('[data-testid="logic-sharp-flow"]');
      finishPointerSessionById(event.pointerId, pane);
    };
    window.addEventListener('pointerup', finishFromWindow);
    window.addEventListener('pointercancel', finishFromWindow);
    return () => {
      window.removeEventListener('pointerup', finishFromWindow);
      window.removeEventListener('pointercancel', finishFromWindow);
    };
  }, [finishPointerSessionById]);

  const handleNodePointerDown = useCallback((event: ReactPointerEvent<HTMLDivElement>, node: LogicFlowNode) => {
    if (event.button !== 0) return;
    event.stopPropagation();
    closeContextMenu();
    const shouldMultiSelect = event.shiftKey || event.ctrlKey || event.metaKey;
    setEdges((current) => current.map((edge) => ({ ...edge, selected: false })));
    setNodes((current) => {
      const clickedNode = current.find((candidate) => candidate.id === node.id);
      const shouldKeepExistingSelection = !shouldMultiSelect && clickedNode?.selected === true;
      const next = current.map((candidate) => {
        if (candidate.id === node.id) {
          return {
            ...candidate,
            selected: shouldMultiSelect ? !candidate.selected : true,
          };
        }
        if (shouldKeepExistingSelection || shouldMultiSelect) return candidate;
        return { ...candidate, selected: false };
      });
      const dragNodeIds = new Set(
        (shouldKeepExistingSelection ? current : next)
          .filter((candidate) => candidate.selected && candidate.data.kind !== 'group')
          .map((candidate) => candidate.id),
      );
      if (node.data.kind === 'group' || dragNodeIds.size === 0) {
        dragNodeIds.add(node.id);
      }
      dragSessionRef.current = {
        pointerId: event.pointerId,
        nodeId: node.id,
        start: { x: event.clientX, y: event.clientY },
        positions: new Map(next
          .filter((candidate) => dragNodeIds.has(candidate.id))
          .map((candidate) => [candidate.id, candidate.position])),
        moved: false,
      };
      return next;
    });
    const pane = viewportRef.current?.querySelector('[data-testid="logic-sharp-flow"]');
    if (pane instanceof HTMLElement) pane.setPointerCapture(event.pointerId);
  }, [closeContextMenu, setEdges, setNodes]);

  const handleEdgePointerDown = useCallback((event: ReactPointerEvent<SVGPathElement>, edge: LogicFlowEdge) => {
    if (event.button !== 0) return;
    event.stopPropagation();
    closeContextMenu();
    const shouldMultiSelect = event.shiftKey || event.ctrlKey || event.metaKey;
    setNodes((current) => shouldMultiSelect ? current : current.map((node) => ({ ...node, selected: false })));
    setEdges((current) => current.map((candidate) => {
      if (candidate.id === edge.id) return { ...candidate, selected: shouldMultiSelect ? !candidate.selected : true };
      return shouldMultiSelect ? candidate : { ...candidate, selected: false };
    }));
  }, [closeContextMenu, setEdges, setNodes]);

  const handleOutputPointerDown = useCallback((event: ReactPointerEvent<HTMLButtonElement>, node: LogicFlowNode, handleId: string) => {
    if (readOnly || event.button !== 0) return;
    event.stopPropagation();
    const rect = viewportRef.current?.getBoundingClientRect();
    const pointer = rect
      ? { x: event.clientX - rect.left, y: event.clientY - rect.top }
      : { x: event.clientX, y: event.clientY };
    const snapped = getConnectionSnap(pointer, node.id, handleId);
    connectionSessionRef.current = {
      sourceNodeId: node.id,
      sourceHandle: handleId,
      pointer: snapped.pointer,
      target: snapped.target,
    };
    setConnectionPreview(connectionSessionRef.current);
  }, [getConnectionSnap, readOnly]);

  const handleInputPointerUp = useCallback((event: ReactPointerEvent<HTMLButtonElement>, node: LogicFlowNode, handleId: string) => {
    if (readOnly) return;
    event.stopPropagation();
    const session = connectionSessionRef.current;
    connectionSessionRef.current = null;
    setConnectionPreview(null);
    if (!session) return;
    onConnect({
      source: session.sourceNodeId,
      target: node.id,
      sourceHandle: session.sourceHandle,
      targetHandle: handleId,
    });
  }, [onConnect, readOnly]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (isEditableTarget(event.target) || event.altKey) return;
      const modifier = event.ctrlKey || event.metaKey;

      if (!modifier && event.shiftKey && event.key.toLowerCase() === 'f') {
        event.preventDefault();
        fitLogicView();
        return;
      }

      if ((modifier || !event.shiftKey) && event.key === '0') {
        event.preventDefault();
        resetZoom();
        return;
      }

      if (modifier && event.key === 'ArrowUp') {
        event.preventDefault();
        adjustZoom(1);
        return;
      }
      if (modifier && event.key === 'ArrowDown') {
        event.preventDefault();
        adjustZoom(-1);
        return;
      }

      if (readOnly) return;

      if (modifier && event.key.toLowerCase() === 'g') {
        event.preventDefault();
        if (event.shiftKey) ungroupSelection();
        else groupSelection();
        return;
      }

      if (!modifier && event.key === 'F2') {
        event.preventDefault();
        renameSelectedNode();
        return;
      }

      // Duplicate selection
      if (modifier && event.key.toLowerCase() === 'd') {
        event.preventDefault();
        duplicateSelection();
        return;
      }

      if (modifier && event.key.toLowerCase() === 'a') {
        event.preventDefault();
        setNodes((current) => current.map((node) => ({ ...node, selected: true })));
        setEdges((current) => current.map((edge) => ({ ...edge, selected: true })));
        return;
      }

      if (!modifier && (event.key === ' ' || event.key === 'Enter')) {
        const selectedInputIds = nodes
          .filter((node) => node.selected && node.data.kind === 'input')
          .map((node) => node.id);
        if (selectedInputIds.length > 0) {
          event.preventDefault();
          toggleInputNodes(selectedInputIds);
          return;
        }
      }

      if (diagram.diagramMode === 'schematic') {
        if (!modifier && event.key.toLowerCase() === 'r') {
          event.preventDefault();
          if (event.shiftKey) rotateSelectedSchematicSymbols();
          else addSchematicSymbol('resistor');
        }
        if (event.key === 'Delete' || event.key === 'Backspace') {
          const hasSelection = selectedNodeIds.length > 0 || selectedEdgeIds.length > 0;
          if (hasSelection) {
            event.preventDefault();
            event.stopPropagation();
            event.stopImmediatePropagation();
            deleteSelection();
          }
        }
        return;
      }

      if (!modifier && event.key.toLowerCase() === 'i') {
        event.preventDefault();
        addGate('input');
        return;
      }
      if (!modifier && event.key.toLowerCase() === 'o') {
        event.preventDefault();
        addGate('output');
        return;
      }
      if (!modifier && event.key.toLowerCase() === 'a') {
        event.preventDefault();
        addGate('and');
        return;
      }
      if (!modifier && event.key.toLowerCase() === 'n') {
        event.preventDefault();
        addGate('not');
        return;
      }
      if (!modifier && event.key.toLowerCase() === 'x') {
        event.preventDefault();
        addGate('xor');
        return;
      }
      if (!modifier && event.key.toLowerCase() === 'r') {
        event.preventDefault();
        addGate('or');
        return;
      }
      if (!modifier && event.key.toLowerCase() === 'd') {
        event.preventDefault();
        addGate('nand');
        return;
      }
      if (!modifier && event.key.toLowerCase() === 'e') {
        event.preventDefault();
        addGate('nor');
        return;
      }

      if (event.key === 'Delete' || event.key === 'Backspace') {
        const hasLogicSelection = selectedNodeIds.length > 0 || selectedEdgeIds.length > 0;
        if (hasLogicSelection) {
          event.preventDefault();
          event.stopPropagation();
          event.stopImmediatePropagation();
          deleteSelection();
        }
      }
    };

    document.addEventListener('keydown', handleKeyDown, { capture: true });
    return () => document.removeEventListener('keydown', handleKeyDown, { capture: true } as EventListenerOptions);
  }, [addGate, addSchematicSymbol, adjustZoom, deleteSelection, diagram.diagramMode, duplicateSelection, fitLogicView, groupSelection, nodes, readOnly, renameSelectedNode, resetZoom, rotateSelectedSchematicSymbols, selectedEdgeIds.length, selectedNodeIds.length, setEdges, setNodes, toggleInputNodes, ungroupSelection]);

  const zoomLabel = `${Math.round(viewport.zoom * 100)}%`;
  const selectedGateNodes = nodes.filter((node) => node.selected && node.data.kind !== 'group' && node.data.kind !== 'component');
  const selectedComponentNodes = nodes.filter((node) => node.selected && node.data.kind === 'component');
  const selectedUngroupedNodes = nodes.filter((node) => node.selected && node.data.kind !== 'group' && !node.parentId);
  const selectedInputNodes = selectedGateNodes.filter((node) => node.data.kind === 'input');
  const selectedGroupCount = selectedGroups.length;
  const selectedItemCount = selectedNodeIds.length + selectedEdgeIds.length;
  const contextTargetNode = contextMenu?.kind === 'node'
    ? nodes.find((node) => node.id === contextMenu.nodeId)
    : null;
  const contextTargetEdge = contextMenu?.kind === 'edge'
    ? edges.find((edge) => edge.id === contextMenu.edgeId)
    : null;
  const schematicSettingsNode = schematicSettingsNodeId
    ? nodes.find((node) => node.id === schematicSettingsNodeId && isElectronicComponentKind(node.data.kind))
    : null;
  const schematicSettingsKind = schematicSettingsNode && isElectronicComponentKind(schematicSettingsNode.data.kind)
    ? schematicSettingsNode.data.kind
    : null;
  const schematicSettingsNumeric = schematicSettingsKind ? schematicNumericField(schematicSettingsKind) : null;

  const runContextAction = (action: () => void) => {
    action();
    closeContextMenu();
  };

  const secondary = (
    <>
      {componentEditSession && (
        <div className={documentTopBarGroupClass}>
          <span className="px-2 text-xs font-medium text-primary">
            Editing {componentEditSession.component.name}{componentEditDirty ? ' · modified' : ''}
          </span>
          <DocumentTopBarButton onClick={() => restoreComponentWorkspace(componentEditSession)} disabled={saving}>
            Cancel
          </DocumentTopBarButton>
        </div>
      )}
      <div className={documentTopBarGroupClass}>
        <Select value={diagram.diagramMode} onValueChange={(value) => changeDiagramMode(value as LogicDiagramMode)} disabled={readOnly || nodes.length > 0 || edges.length > 0}>
          <SelectTrigger size="sm" className="h-8 min-w-32 border-0 bg-transparent text-xs shadow-none" title={nodes.length > 0 || edges.length > 0 ? 'Mode is fixed once the diagram contains elements' : 'Diagram mode'}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent align="start" position="popper">
            <SelectItem value="logic">Digital logic</SelectItem>
            <SelectItem value="schematic">Electronic schematic</SelectItem>
          </SelectContent>
        </Select>
      </div>
      {diagram.diagramMode === 'logic' ? (
      <div className={documentTopBarGroupClass}>
        <Select value={selectedGate} onValueChange={(value) => setSelectedGate(value as LogicGateKind)}>
          <SelectTrigger size="sm" className="h-8 min-w-28 border-0 bg-transparent text-xs shadow-none">
            <SelectValue />
          </SelectTrigger>
          <SelectContent align="start" position="popper">
            {GATE_CHOICES.map((gate) => (
              <SelectItem key={gate.kind} value={gate.kind}>{gate.label}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <DocumentTopBarButton onClick={() => addGate(selectedGate)} disabled={readOnly}>
          <Plus size={14} />
          Add
        </DocumentTopBarButton>
        <DocumentTopBarButton
          onClick={() => setTemplatePickerOpen(true)}
          disabled={readOnly}
          title="Insert a starter template (half-adder, full-adder, multiplexer, etc.)"
        >
          <Shapes size={14} />
          Templates
        </DocumentTopBarButton>
        <DocumentTopBarButton
          onClick={() => setComponentPickerOpen(true)}
          disabled={readOnly || !logicComponentsCapability}
          title="Insert a reusable logic component"
        >
          <CircuitBoard size={14} />
          Components
        </DocumentTopBarButton>
        <DocumentTopBarButton
          onClick={openSaveComponentDialog}
          disabled={readOnly || !logicComponentsCapability || nodes.length === 0 || Boolean(componentEditSession)}
          title="Save the selection, or the whole diagram if nothing is selected, as a component"
        >
          <Save size={14} />
          Save component
        </DocumentTopBarButton>
        <DocumentTopBarButton
          onClick={() => {
            const selectedComponent = selectedComponentNodes[0]?.data.component?.definition;
            setTruthTableScope(selectedComponent?.id ?? 'document');
            setTruthTableOpen(true);
          }}
          disabled={nodes.length === 0}
          title="Calculate a truth table for this diagram or a reusable component"
        >
          <Table2 size={14} />
          Value table
        </DocumentTopBarButton>
        <DocumentTopBarIconButton
          title={clockRunning ? 'Pause clocks' : 'Run clocks'}
          onClick={() => clockRunning ? setClockRunning(false) : startClocks()}
          disabled={clockCount === 0}
        >
          {clockRunning ? <Pause size={14} /> : <Play size={14} />}
        </DocumentTopBarIconButton>
        <DocumentTopBarIconButton title="Reset clock sequence" onClick={resetClocks} disabled={clockCount === 0}>
          <RotateCcw size={14} />
        </DocumentTopBarIconButton>
      </div>
      ) : (
      <div className={documentTopBarGroupClass}>
        <Select value={selectedSymbol} onValueChange={(value) => setSelectedSymbol(value as ElectronicComponentKind)}>
          <SelectTrigger size="sm" className="h-8 min-w-36 border-0 bg-transparent text-xs shadow-none">
            <SelectValue />
          </SelectTrigger>
          <SelectContent align="start" position="popper">
            {SCHEMATIC_SYMBOL_CHOICES.map((symbol) => (
              <SelectItem key={symbol.kind} value={symbol.kind}>{symbol.label}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <DocumentTopBarButton onClick={() => addSchematicSymbol(selectedSymbol)} disabled={readOnly}>
          <Plus size={14} />
          Add
        </DocumentTopBarButton>
        <DocumentTopBarIconButton
          title="Rotate selected symbols clockwise"
          onClick={() => rotateSelectedSchematicSymbols()}
          disabled={readOnly || !nodes.some((node) => node.selected && isElectronicComponentKind(node.data.kind) && node.data.kind !== 'junction')}
        >
          <RotateCw size={14} />
        </DocumentTopBarIconButton>
        <DocumentTopBarButton
          onClick={() => circuitRunning && circuitRunKind === 'dc' ? void cancelDcSimulation() : void runDcSimulation()}
          disabled={loading || (circuitRunning && circuitRunKind !== 'dc') || (!circuitRunning && nodes.length === 0) || (circuitRunning && (!circuitJobId || circuitJobStatus?.phase === 'cancelling'))}
          title={circuitRunning && circuitRunKind === 'dc' ? 'Cancel the active DC simulation' : 'Compile and solve the DC operating point locally'}
          className="min-w-[132px]"
        >
          {circuitRunning && circuitRunKind === 'dc' && (!circuitJobId || circuitJobStatus?.phase === 'cancelling')
            ? <Loader2 size={14} className="animate-spin" />
            : circuitRunning && circuitRunKind === 'dc' ? <X size={14} /> : <Play size={14} />}
          {circuitRunning && circuitRunKind === 'dc'
            ? circuitJobStatus?.phase === 'cancelling'
              ? 'Cancelling'
              : circuitJobStatus?.stage
                ? `Cancel: ${circuitJobStatus.stage[0].toUpperCase()}${circuitJobStatus.stage.slice(1)}`
                : 'Starting'
            : 'Run DC'}
        </DocumentTopBarButton>
        <DocumentTopBarButton
          onClick={() => circuitRunning && circuitRunKind === 'sweep' ? void cancelDcSimulation() : void runDcSweep()}
          disabled={loading || (circuitRunning && circuitRunKind !== 'sweep') || (!circuitRunning && nodes.length === 0) || (circuitRunning && (!circuitJobId || circuitJobStatus?.phase === 'cancelling'))}
          title={circuitRunning && circuitRunKind === 'sweep' ? 'Cancel the active DC sweep' : 'Run the persisted DC source sweep locally'}
          className="min-w-[112px]"
        >
          {circuitRunning && circuitRunKind === 'sweep' && (!circuitJobId || circuitJobStatus?.phase === 'cancelling')
            ? <Loader2 size={14} className="animate-spin" />
            : circuitRunning && circuitRunKind === 'sweep' ? <X size={14} /> : <ChartLine size={14} />}
          {circuitRunning && circuitRunKind === 'sweep'
            ? circuitJobStatus?.phase === 'cancelling'
              ? 'Cancelling'
              : circuitJobStatus?.stage
                ? `Cancel: ${circuitJobStatus.stage[0].toUpperCase()}${circuitJobStatus.stage.slice(1)}`
                : 'Starting'
            : 'Run sweep'}
        </DocumentTopBarButton>
        <DocumentTopBarIconButton
          title="Configure DC sweep"
          onClick={openSweepConfiguration}
          disabled={readOnly || sweepSourceChoices.length === 0 || circuitRunning}
        >
          <SlidersHorizontal size={14} />
        </DocumentTopBarIconButton>
        <DocumentTopBarButton
          onClick={() => circuitRunning && circuitRunKind === 'transient' ? void cancelDcSimulation() : void runTransient()}
          disabled={loading || (circuitRunning && circuitRunKind !== 'transient') || (!circuitRunning && nodes.length === 0) || (circuitRunning && (!circuitJobId || circuitJobStatus?.phase === 'cancelling'))}
          title={circuitRunning && circuitRunKind === 'transient' ? 'Cancel transient analysis' : 'Run the persisted transient analysis locally'}
          className="min-w-[124px]"
        >
          {circuitRunning && circuitRunKind === 'transient' && (!circuitJobId || circuitJobStatus?.phase === 'cancelling')
            ? <Loader2 size={14} className="animate-spin" />
            : circuitRunning && circuitRunKind === 'transient' ? <X size={14} /> : <Activity size={14} />}
          {circuitRunning && circuitRunKind === 'transient'
            ? circuitJobStatus?.phase === 'cancelling' ? 'Cancelling' : 'Transient...'
            : 'Transient'}
        </DocumentTopBarButton>
        <DocumentTopBarIconButton
          title="Configure transient analysis"
          onClick={openTransientConfiguration}
          disabled={readOnly || sweepSourceChoices.length === 0 || circuitRunning}
        >
          <SlidersHorizontal size={14} />
        </DocumentTopBarIconButton>
        <DocumentTopBarIconButton
          title={circuitResultsOpen ? 'Hide DC results' : 'Show DC results'}
          onClick={() => {
            setSweepResultsOpen(false);
            setTransientResultsOpen(false);
            setCircuitResultsOpen((open) => !open);
          }}
          disabled={!circuitResult && !circuitError}
        >
          <Zap size={14} />
        </DocumentTopBarIconButton>
        <DocumentTopBarIconButton
          title={sweepResultsOpen ? 'Hide sweep results' : 'Show sweep results'}
          onClick={() => {
            setCircuitResultsOpen(false);
            setTransientResultsOpen(false);
            setSweepResultsOpen((open) => !open);
          }}
          disabled={!sweepResult && !sweepError}
        >
          <ChartLine size={14} />
        </DocumentTopBarIconButton>
        <DocumentTopBarIconButton
          title={transientResultsOpen ? 'Hide transient results' : 'Show transient results'}
          onClick={() => {
            setCircuitResultsOpen(false);
            setSweepResultsOpen(false);
            setTransientResultsOpen((open) => !open);
          }}
          disabled={!transientResult && !transientError}
        >
          <Activity size={14} />
        </DocumentTopBarIconButton>
      </div>
      )}
      <div className={documentTopBarGroupClass}>
        <DocumentTopBarIconButton
          title="Delete selected gates or wires"
          onClick={deleteSelection}
          disabled={readOnly || (selectedNodeIds.length === 0 && selectedEdgeIds.length === 0)}
        >
          <Trash2 size={14} />
        </DocumentTopBarIconButton>
        <DocumentTopBarButton
          onClick={groupSelection}
          disabled={readOnly || nodes.filter((node) => node.selected && node.data.kind !== 'group' && !node.parentId).length < 2}
        >
          <Group size={14} />
          Group
        </DocumentTopBarButton>
        <DocumentTopBarIconButton
          title="Ungroup selected groups"
          onClick={ungroupSelection}
          disabled={readOnly || !nodes.some((node) => node.selected && node.data.kind === 'group')}
        >
          <Ungroup size={14} />
        </DocumentTopBarIconButton>
        <DocumentTopBarIconButton
          title="Rename selected gate or group (F2)"
          onClick={renameSelectedNode}
          disabled={readOnly || (selectedGroups.length !== 1 && selectedGateNodes.length !== 1 && selectedComponentNodes.length !== 1)}
        >
          <Pencil size={14} />
        </DocumentTopBarIconButton>
      </div>
      <div className={documentTopBarGroupClass}>
        <DocumentTopBarIconButton onClick={() => adjustZoom(-1)} title="Zoom out">
          <Minus size={15} />
        </DocumentTopBarIconButton>
        <DocumentTopBarButton
          onClick={resetZoom}
          className="min-w-[78px] justify-center px-2 text-center font-medium text-muted-foreground"
          title="Reset zoom to 100%"
        >
          {zoomLabel}
        </DocumentTopBarButton>
        <DocumentTopBarIconButton onClick={() => adjustZoom(1)} title="Zoom in">
          <PlusIcon size={15} />
        </DocumentTopBarIconButton>
        <DocumentTopBarIconButton onClick={fitLogicView} title="Fit view">
          <Maximize2 size={14} />
        </DocumentTopBarIconButton>
        <DocumentTopBarIconButton onClick={resetZoom} title="Reset zoom">
          <RotateCcw size={14} />
        </DocumentTopBarIconButton>
      </div>
      <div className={documentTopBarGroupClass}>
        <DocumentTopBarButton
          onClick={(event) => handleExportToNote(event.shiftKey)}
          disabled={exporting || loading || readOnly || Boolean(componentEditSession)}
          title="Insert in note. Shift-click saves a unique export."
        >
          {exporting ? <Loader2 size={14} className="animate-spin" /> : <Image size={14} />}
          Insert in note
        </DocumentTopBarButton>
        <DocumentTopBarButton
          onClick={() => componentEditSession ? void saveEditedLogicComponent() : void handleSave()}
          disabled={saving || loading || readOnly || (Boolean(componentEditSession) && !componentEditDirty)}
        >
          {saving ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
          {componentEditSession ? 'Update component' : 'Save'}
        </DocumentTopBarButton>
      </div>
    </>
  );

  const handleSaveAsNew = useCallback(async (localContent: string) => {
    if (!client || !relativePath) return;
    await saveConflictedCopy(client, relativePath, localContent);
  }, [client, relativePath]);

  const documentStatus = useMemo(() => (
    !loading
      ? {
          status: snapshot.status,
          controller: controller as DocumentSessionController<unknown>,
          snapshot: snapshot as DocumentSessionSnapshot<unknown>,
          onSaveAsNew: handleSaveAsNew,
          readOnly,
        }
      : null
  ), [controller, handleSaveAsNew, loading, readOnly, snapshot]);
  useDocumentStatusRegistration(relativePath, documentStatus);

  const counts = useMemo(() => {
    const componentCount = nodes.filter((node) => node.data.kind === 'component').length;
    const schematicCount = nodes.filter((node) => isElectronicComponentKind(node.data.kind)).length;
    const gateCount = nodes.filter((node) => node.data.kind !== 'group' && node.data.kind !== 'component' && !isElectronicComponentKind(node.data.kind)).length;
    const groupCount = nodes.length - gateCount - componentCount - schematicCount;
    return { gateCount, groupCount, componentCount, schematicCount };
  }, [nodes]);

  const circuitVoltageRows = useMemo(() => {
    if (!circuitResult) return [];
    const nodeById = new Map(nodes.map((node) => [node.id, node]));
    const terminalsByNet = new Map<string, CircuitDcResult['sourceMap']['terminals']>();
    for (const mapping of circuitResult.sourceMap.terminals) {
      const entries = terminalsByNet.get(mapping.electricalNode) ?? [];
      entries.push(mapping);
      terminalsByNet.set(mapping.electricalNode, entries);
    }
    return Object.entries(circuitResult.operatingPoint.nodeVoltages)
      .map(([electricalNode, voltage]) => {
        const terminal = terminalsByNet.get(electricalNode)?.[0];
        const sourceNode = terminal ? nodeById.get(terminal.terminal.nodeId) : null;
        const label = electricalNode === '0'
          ? 'Ground'
          : terminal && sourceNode
          ? `${logicNodeLabel({ kind: sourceNode.data.kind, label: sourceNode.data.label })} · ${terminal.terminal.handleId}`
          : electricalNode;
        const polarity = voltage > ANALOG_ACTIVE_VOLTAGE
          ? 'positive'
          : voltage < -ANALOG_ACTIVE_VOLTAGE
          ? 'negative'
          : 'reference';
        return { electricalNode, label, voltage, polarity };
      })
      .sort((left, right) => left.label.localeCompare(right.label));
  }, [circuitResult, nodes]);

  const circuitCurrentRows = useMemo(() => {
    if (!circuitResult) return [];
    const nodeById = new Map(nodes.map((node) => [node.id, node]));
    return Object.entries(circuitResult.operatingPoint.componentCurrents)
      .map(([componentId, current]) => {
        const sourceNode = nodeById.get(componentId);
        return {
          componentId,
          label: sourceNode
            ? `${logicNodeLabel({ kind: sourceNode.data.kind, label: sourceNode.data.label })}${sourceNode.data.kind === 'transistor' ? ' · collector' : ''}`
            : componentId,
          current,
          direction: current > ANALOG_ACTIVE_VOLTAGE
            ? 'forward'
            : current < -ANALOG_ACTIVE_VOLTAGE
            ? 'reverse'
            : 'zero',
        };
      })
      .sort((left, right) => left.label.localeCompare(right.label));
  }, [circuitResult, nodes]);

  const circuitPowerRows = useMemo(() => {
    if (!circuitResult) return [];
    const nodeById = new Map(nodes.map((node) => [node.id, node]));
    return Object.entries(circuitResult.operatingPoint.componentPowers ?? {})
      .map(([componentId, power]) => {
        const sourceNode = nodeById.get(componentId);
        return {
          componentId,
          label: sourceNode
            ? logicNodeLabel({ kind: sourceNode.data.kind, label: sourceNode.data.label })
            : componentId,
          power,
          mode: power > ANALOG_ACTIVE_VOLTAGE
            ? 'absorbed'
            : power < -ANALOG_ACTIVE_VOLTAGE
            ? 'supplied'
            : 'neutral',
        };
      })
      .sort((left, right) => left.label.localeCompare(right.label));
  }, [circuitResult, nodes]);

  const circuitDiagnosticRows = useMemo(() => {
    if (!circuitResult) return [];
    const nodeById = new Map(nodes.map((node) => [node.id, node]));
    return (circuitResult.operatingPoint.diagnostics ?? []).map((diagnostic) => {
      const sourceNode = nodeById.get(diagnostic.context.component);
      return {
        ...diagnostic,
        label: sourceNode
          ? logicNodeLabel({ kind: sourceNode.data.kind, label: sourceNode.data.label })
          : diagnostic.context.component,
      };
    });
  }, [circuitResult, nodes]);

  const circuitProbeRows = useMemo(() => {
    if (!circuitResult) return [];
    const configured = new Map((diagram.simulation?.probes ?? []).map((probe) => [probe.id, probe]));
    return (circuitResult.probeValues ?? []).map((value) => {
      const probe = configured.get(value.probeId);
      const label = value.label || probe?.label || value.probeId;
      if (value.kind === 'node-voltage') {
        return {
          probeId: value.probeId,
          label,
          kind: 'Voltage',
          value: formatEngineering(value.valueVolts, 'V'),
        };
      }
      const direction = value.valueAmps > ANALOG_ACTIVE_VOLTAGE
        ? 'forward'
        : value.valueAmps < -ANALOG_ACTIVE_VOLTAGE
        ? 'reverse'
        : 'zero';
      return {
        probeId: value.probeId,
        label,
        kind: `Current · ${direction}`,
        value: formatEngineering(value.valueAmps, 'A'),
      };
    });
  }, [circuitResult, diagram.simulation?.probes]);

  const meta = (
    <div className="flex items-center gap-2">
      {componentEditSession ? (
        <div className="rounded-full border border-primary/40 bg-primary/10 px-2 py-1 text-[11px] text-primary">
          Component library
        </div>
      ) : <DocumentStatusPill status={snapshot.status} compact />}
      <LivePeers peers={livePeers} />
      <div className="rounded-full border border-border/60 px-2 py-1 text-[11px] text-muted-foreground">
        {diagram.diagramMode === 'schematic'
          ? `${counts.schematicCount} symbols · ${counts.groupCount} groups · ${edges.length} wires · ${circuitRunning ? circuitRunKind === 'sweep' ? 'sweeping' : circuitRunKind === 'transient' ? 'transient' : 'solving' : transientResultStale ? 'transient stale' : transientResult ? 'transient result' : sweepResultStale ? 'sweep stale' : sweepResult ? 'sweep result' : circuitResultStale ? 'DC stale' : circuitResult ? 'DC result' : 'DC ready'}`
          : `${counts.gateCount} gates · ${counts.componentCount} components · ${counts.groupCount} groups · ${edges.length} wires`}
      </div>
    </div>
  );

  return (
    <div className={`flex h-full min-h-0 flex-col bg-background app-document-ready ${refreshPulse ? 'app-refresh-pulse' : ''}`}>
      <DocumentTopBar
        title={componentEditSession?.component.name ?? title}
        subtitle={componentEditSession ? 'Reusable component editor' : getDocumentFolderPath(relativePath)}
        icon={<CircuitBoard size={18} />}
        meta={meta}
        secondary={secondary}
      />
      <div ref={viewportRef} className="relative min-h-0 flex-1">
        {loading && (
          <div className="absolute inset-0 z-10 flex items-center justify-center bg-background/80 text-sm text-muted-foreground">
            <Loader2 size={16} className="mr-2 animate-spin" />
            Loading {diagram.diagramMode === 'schematic' ? 'electronic schematic' : 'logic diagram'}...
          </div>
        )}
        {diagram.diagramMode === 'schematic' && circuitResultsOpen && (
          <aside className="absolute bottom-3 right-3 z-20 flex max-h-[min(68vh,520px)] w-[min(360px,calc(100%-24px))] flex-col overflow-hidden rounded-md border border-border/70 bg-popover/96 text-popover-foreground shadow-xl backdrop-blur-xs-webkit">
            <div className="flex h-10 shrink-0 items-center gap-2 border-b border-border/60 px-3">
              {circuitRunning ? <Loader2 size={15} className="animate-spin text-primary" /> : <Zap size={15} className="text-primary" />}
              <div className="min-w-0 flex-1 truncate text-sm font-semibold">DC operating point</div>
              <button
                type="button"
                title="Clear DC results"
                aria-label="Clear DC results"
                className="grid size-7 place-items-center rounded text-muted-foreground hover:bg-accent hover:text-accent-foreground"
                onClick={resetCircuitResults}
              >
                <X size={14} />
              </button>
            </div>
            <div className="min-h-0 overflow-y-auto px-3 py-2.5 text-xs">
              {circuitRunning && (
                <div className="flex items-center gap-2 py-4 text-muted-foreground">
                  <Loader2 size={14} className="animate-spin" />
                  Compiling and solving locally...
                </div>
              )}
              {circuitError && !circuitRunning && (
                <div className="border-l-2 border-destructive pl-3 text-destructive">
                  <div className="font-semibold">Simulation failed</div>
                  <div className="mt-1 leading-relaxed text-foreground/80">{circuitError}</div>
                </div>
              )}
              {circuitResultStale && circuitResult && (
                <div className="mb-3 border-l-2 border-amber-500 pl-3 text-amber-600 dark:text-amber-400">
                  Results are stale. Run DC again to update wire highlighting and values.
                </div>
              )}
              {circuitResult && !circuitRunning && (
                <div className={cn('space-y-3', circuitResultStale && 'opacity-55')}>
                  <div className="text-[11px] text-muted-foreground">
                    Converged in {circuitResult.operatingPoint.iterations}{' '}
                    {circuitResult.operatingPoint.iterations === 1 ? 'iteration' : 'iterations'}
                  </div>
                  {circuitDiagnosticRows.map((diagnostic) => (
                    <div
                      key={`${diagnostic.code}-${diagnostic.context.component}`}
                      className="border-l-2 border-amber-500 pl-3 text-amber-700 dark:text-amber-400"
                    >
                      <div className="font-semibold">{diagnostic.label} entered unsupported reverse-active operation</div>
                      <div className="mt-1 leading-relaxed text-foreground/75">
                        The built-in NPN model does not cover this reverse bias ({formatEngineering(diagnostic.context.baseEmitterVoltage, 'V')} VBE,{' '}
                        {formatEngineering(diagnostic.context.collectorEmitterVoltage, 'V')} VCE).
                      </div>
                    </div>
                  ))}
                  {circuitProbeRows.length > 0 && (
                    <section>
                      <h3 className="mb-1.5 font-semibold text-foreground">Probes</h3>
                      <div className="divide-y divide-border/50 border-y border-border/50">
                        {circuitProbeRows.map((row) => (
                          <div key={row.probeId} className="flex items-center gap-2 py-1.5">
                            <span className="min-w-0 flex-1">
                              <span className="block truncate text-foreground" title={row.label}>{row.label}</span>
                              <span className="text-[10px] uppercase text-muted-foreground">{row.kind}</span>
                            </span>
                            <span className="shrink-0 font-mono text-foreground">{row.value}</span>
                            {!readOnly && (
                              <button
                                type="button"
                                title={`Remove ${row.label} probe`}
                                aria-label={`Remove ${row.label} probe`}
                                className="grid size-6 shrink-0 place-items-center rounded text-muted-foreground hover:bg-accent hover:text-accent-foreground"
                                onClick={() => removeCircuitProbe(row.probeId)}
                              >
                                <X size={12} />
                              </button>
                            )}
                          </div>
                        ))}
                      </div>
                    </section>
                  )}
                  <section>
                    <h3 className="mb-1.5 font-semibold text-foreground">Node voltages</h3>
                    <div className="divide-y divide-border/50 border-y border-border/50">
                      {circuitVoltageRows.map((row) => (
                        <div key={row.electricalNode} className="flex items-center justify-between gap-3 py-1.5">
                          <span className="min-w-0 truncate text-muted-foreground" title={row.label}>{row.label}</span>
                          <span className="flex shrink-0 items-center gap-1.5">
                            <span className={cn(
                              'text-[10px] font-medium uppercase',
                              row.polarity === 'positive' && 'text-primary',
                              row.polarity === 'negative' && 'text-rose-400',
                              row.polarity === 'reference' && 'text-muted-foreground',
                            )}>{row.polarity}</span>
                            <span className="font-mono text-foreground">{formatEngineering(row.voltage, 'V')}</span>
                          </span>
                        </div>
                      ))}
                    </div>
                  </section>
                  <section>
                    <h3 className="mb-1.5 font-semibold text-foreground">Component currents</h3>
                    <div className="divide-y divide-border/50 border-y border-border/50">
                      {circuitCurrentRows.map((row) => (
                        <div key={row.componentId} className="flex items-center justify-between gap-3 py-1.5">
                          <span className="min-w-0 truncate text-muted-foreground" title={row.label}>{row.label}</span>
                          <span className="flex shrink-0 items-center gap-1.5">
                            <span className="text-[10px] font-medium uppercase text-muted-foreground">{row.direction}</span>
                            <span className="font-mono text-foreground">{formatEngineering(row.current, 'A')}</span>
                          </span>
                        </div>
                      ))}
                    </div>
                  </section>
                  <section>
                    <h3 className="mb-1.5 font-semibold text-foreground">Component power</h3>
                    <div className="divide-y divide-border/50 border-y border-border/50">
                      {circuitPowerRows.map((row) => (
                        <div key={row.componentId} className="flex items-center justify-between gap-3 py-1.5">
                          <span className="min-w-0 truncate text-muted-foreground" title={row.label}>{row.label}</span>
                          <span className="flex shrink-0 items-center gap-1.5">
                            <span className={cn(
                              'text-[10px] font-medium uppercase',
                              row.mode === 'supplied' ? 'text-primary' : 'text-muted-foreground',
                            )}>{row.mode}</span>
                            <span className="font-mono text-foreground">{formatEngineering(Math.abs(row.power), 'W')}</span>
                          </span>
                        </div>
                      ))}
                    </div>
                  </section>
                </div>
              )}
            </div>
          </aside>
        )}
        {diagram.diagramMode === 'schematic' && sweepResultsOpen && (
          <aside className="absolute bottom-3 right-3 z-20 flex max-h-[min(72vh,620px)] w-[min(680px,calc(100%-24px))] flex-col overflow-hidden rounded-md border border-border/70 bg-popover/96 text-popover-foreground shadow-xl backdrop-blur-xs-webkit">
            <div className="flex h-10 shrink-0 items-center gap-2 border-b border-border/60 px-3">
              {circuitRunning && circuitRunKind === 'sweep'
                ? <Loader2 size={15} className="animate-spin text-primary" />
                : <ChartLine size={15} className="text-primary" />}
              <div className="min-w-0 flex-1 truncate text-sm font-semibold">DC source sweep</div>
              {sweepResult && !(circuitRunning && circuitRunKind === 'sweep') ? (
                <>
                  <button
                    type="button"
                    title="Export sweep data as CSV"
                    className="flex h-7 items-center gap-1 rounded px-2 text-[11px] text-muted-foreground hover:bg-accent hover:text-accent-foreground"
                    onClick={() => void exportSweepResult('csv')}
                  >
                    <Download size={12} /> CSV
                  </button>
                  <button
                    type="button"
                    title="Export sweep plot as SVG"
                    className="flex h-7 items-center gap-1 rounded px-2 text-[11px] text-muted-foreground hover:bg-accent hover:text-accent-foreground"
                    onClick={() => void exportSweepResult('svg')}
                  >
                    <Download size={12} /> SVG
                  </button>
                </>
              ) : null}
              <button
                type="button"
                title="Clear sweep results"
                aria-label="Clear sweep results"
                className="grid size-7 place-items-center rounded text-muted-foreground hover:bg-accent hover:text-accent-foreground"
                onClick={resetSweepResults}
              >
                <X size={14} />
              </button>
            </div>
            <div className="min-h-0 overflow-y-auto px-3 py-3 text-xs">
              {circuitRunning && circuitRunKind === 'sweep' && (
                <div className="flex items-center gap-2 py-6 text-muted-foreground">
                  <Loader2 size={14} className="animate-spin" />
                  {circuitJobStatus?.stage === 'solving' ? 'Solving sweep samples locally...' : 'Preparing sweep...'}
                </div>
              )}
              {sweepError && !(circuitRunning && circuitRunKind === 'sweep') && (
                <div className="border-l-2 border-destructive pl-3 text-destructive">
                  <div className="font-semibold">Sweep failed</div>
                  <div className="mt-1 leading-relaxed text-foreground/80">{sweepError}</div>
                </div>
              )}
              {sweepResultStale && sweepResult && (
                <div className="mb-3 border-l-2 border-amber-500 pl-3 text-amber-600 dark:text-amber-400">
                  Results are stale. Run the sweep again to update the traces.
                </div>
              )}
              {sweepResult && !(circuitRunning && circuitRunKind === 'sweep') && (
                <div className={cn('space-y-2', sweepResultStale && 'opacity-55')}>
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
                    <span>{sweepResult.sampleCount.toLocaleString()} samples</span>
                    <span>{sweepResult.traces.length} {sweepResult.traces.length === 1 ? 'trace' : 'traces'}</span>
                    <span>{formatEngineering(sweepResult.sourceValues[0] ?? 0, 'V')} to {formatEngineering(sweepResult.sourceValues[sweepResult.sourceValues.length - 1] ?? 0, 'V')}</span>
                  </div>
                  <CircuitSweepPlot
                    result={sweepResult}
                    sourceLabel={sweepSourceChoices.find((source) => source.id === sweepResult.source)?.label}
                  />
                </div>
              )}
            </div>
          </aside>
        )}
        {diagram.diagramMode === 'schematic' && transientResultsOpen && (
          <aside className="absolute bottom-3 right-3 z-20 flex max-h-[min(72vh,620px)] w-[min(680px,calc(100%-24px))] flex-col overflow-hidden rounded-md border border-border/70 bg-popover/96 text-popover-foreground shadow-xl backdrop-blur-xs-webkit">
            <div className="flex h-10 shrink-0 items-center gap-2 border-b border-border/60 px-3">
              {circuitRunning && circuitRunKind === 'transient'
                ? <Loader2 size={15} className="animate-spin text-primary" />
                : <Activity size={15} className="text-primary" />}
              <div className="min-w-0 flex-1 truncate text-sm font-semibold">Transient analysis</div>
              <button
                type="button"
                title="Clear transient results"
                aria-label="Clear transient results"
                className="grid size-7 place-items-center rounded text-muted-foreground hover:bg-accent hover:text-accent-foreground"
                onClick={resetTransientResults}
              >
                <X size={14} />
              </button>
            </div>
            <div className="min-h-0 overflow-y-auto px-3 py-3 text-xs">
              {circuitRunning && circuitRunKind === 'transient' && (
                <div className="flex items-center gap-2 py-6 text-muted-foreground">
                  <Loader2 size={14} className="animate-spin" />
                  {circuitJobStatus?.stage === 'solving' ? 'Advancing transient samples locally...' : 'Preparing transient analysis...'}
                </div>
              )}
              {transientError && !(circuitRunning && circuitRunKind === 'transient') && (
                <div className="border-l-2 border-destructive pl-3 text-destructive">
                  <div className="font-semibold">Transient analysis failed</div>
                  <div className="mt-1 leading-relaxed text-foreground/80">{transientError}</div>
                </div>
              )}
              {transientResultStale && transientResult && (
                <div className="mb-3 border-l-2 border-amber-500 pl-3 text-amber-600 dark:text-amber-400">
                  Results are stale. Run transient analysis again to update the traces.
                </div>
              )}
              {transientResult && !(circuitRunning && circuitRunKind === 'transient') && (
                <div className={cn('space-y-2', transientResultStale && 'opacity-55')}>
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
                    <span>{transientResult.sampleCount.toLocaleString()} samples</span>
                    <span>{transientResult.traces.length} {transientResult.traces.length === 1 ? 'trace' : 'traces'}</span>
                    <span>{formatEngineering(transientResult.timeSeconds.at(-1) ?? 0, 's')}</span>
                  </div>
                  <CircuitTransientPlot result={transientResult} />
                </div>
              )}
            </div>
          </aside>
        )}
        {contextMenu && (
          <>
            <button
              type="button"
              aria-label="Close logic diagram context menu"
              className="absolute inset-0 z-20 cursor-default bg-transparent"
              onClick={closeContextMenu}
            />
            <div
              className="absolute z-30 w-[280px] max-w-[calc(100%-24px)] overflow-hidden rounded-xl border border-border/70 bg-popover/96 p-1 text-popover-foreground shadow-2xl ring-1 ring-black/5 backdrop-blur-xs-webkit app-panel-enter"
              style={{ left: contextMenu.x, top: contextMenu.y }}
            >
              <div className="px-2 py-1.5 text-[11px] font-medium uppercase tracking-normal text-muted-foreground">
                {contextMenu.kind === 'pane'
                  ? 'Add element'
                  : contextMenu.kind === 'edge'
                  ? 'Wire'
                  : contextTargetNode?.data.kind === 'group'
                  ? logicNodeLabel({ kind: 'group', label: contextTargetNode.data.label })
                  : contextTargetNode?.data.kind === 'component'
                  ? 'Component'
                  : contextTargetNode && isElectronicComponentKind(contextTargetNode.data.kind)
                  ? 'Schematic symbol'
                  : 'Gate'}
              </div>

              {contextMenu.kind === 'pane' && diagram.diagramMode === 'logic' && (
                <div className="grid grid-cols-2 gap-1">
                  {GATE_CHOICES.map((gate) => (
                    <button
                      key={gate.kind}
                      type="button"
                      className="flex items-center justify-between rounded-md px-2 py-1.5 text-left text-sm outline-none transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:bg-accent"
                      onClick={() => runContextAction(() => addGateAt(gate.kind, contextMenu.flowPosition))}
                    >
                      <span>{gate.label}</span>
                      <Plus size={13} className="text-muted-foreground" />
                    </button>
                  ))}
                </div>
              )}

              {contextMenu.kind === 'pane' && diagram.diagramMode === 'schematic' && (
                <div className="grid grid-cols-2 gap-1">
                  {SCHEMATIC_SYMBOL_CHOICES.map((symbol) => (
                    <button
                      key={symbol.kind}
                      type="button"
                      className="flex items-center justify-between rounded-md px-2 py-1.5 text-left text-sm outline-none transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:bg-accent"
                      onClick={() => runContextAction(() => addSchematicSymbolAt(symbol.kind, contextMenu.flowPosition))}
                    >
                      <span>{symbol.label}</span>
                      <Plus size={13} className="text-muted-foreground" />
                    </button>
                  ))}
                </div>
              )}

              {contextMenu.kind === 'edge' && contextTargetEdge && (
                <div className="space-y-1">
                  {diagram.diagramMode === 'schematic' && (
                    <>
                      <button
                        type="button"
                        className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm outline-none transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:bg-accent"
                        onClick={() => runContextAction(() => insertJunctionOnEdge(contextTargetEdge, contextMenu.flowPosition))}
                      >
                        <Plus size={14} />
                        Insert junction
                      </button>
                      <button
                        type="button"
                        className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm outline-none transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:bg-accent"
                        onClick={() => runContextAction(() => addVoltageProbe(contextTargetEdge))}
                      >
                        <Zap size={14} />
                        Probe wire voltage
                      </button>
                    </>
                  )}
                  <button
                    type="button"
                    className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm outline-none transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:bg-accent"
                    onClick={() => runContextAction(() => openRenameEdge(contextTargetEdge.id))}
                  >
                    <Pencil size={14} />
                    Label wire
                  </button>
                  <button
                    type="button"
                    className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm text-destructive outline-none transition-colors hover:bg-destructive/10 focus-visible:bg-destructive/10"
                    onClick={() => runContextAction(() => deleteEdge(contextTargetEdge.id))}
                  >
                    <Trash2 size={14} />
                    Delete wire
                  </button>
                </div>
              )}

              {contextMenu.kind === 'node' && contextTargetNode?.data.kind === 'group' && (
                <div className="space-y-1">
                  <button
                    type="button"
                    className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm outline-none transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:bg-accent"
                    onClick={() => runContextAction(() => openRenameNode(contextTargetNode.id))}
                  >
                    <Pencil size={14} />
                    Rename group
                  </button>
                  <button
                    type="button"
                    className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm outline-none transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:bg-accent"
                    onClick={() => runContextAction(ungroupSelection)}
                  >
                    <Ungroup size={14} />
                    Ungroup
                  </button>
                </div>
              )}

              {contextMenu.kind === 'node' && contextTargetNode && contextTargetNode.data.kind !== 'group' && contextTargetNode.data.kind !== 'input' && (
                <>
                  <button
                    type="button"
                    className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm outline-none transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:bg-accent"
                    onClick={() => runContextAction(() => openRenameNode(contextTargetNode.id))}
                  >
                    <Pencil size={14} />
                    Label {contextTargetNode.data.kind === 'output' ? 'output' : contextTargetNode.data.kind === 'component' ? 'component' : isElectronicComponentKind(contextTargetNode.data.kind) ? 'symbol' : 'gate'}
                  </button>
                  {isElectronicComponentKind(contextTargetNode.data.kind) && (
                    <>
                      {contextTargetNode.data.kind !== 'ground' && contextTargetNode.data.kind !== 'junction' && (
                        <>
                          <button
                            type="button"
                            className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm outline-none transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:bg-accent"
                            onClick={() => runContextAction(() => openSchematicSettings(contextTargetNode))}
                          >
                            <Zap size={14} />
                            Edit electrical value
                          </button>
                          <button
                            type="button"
                            className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm outline-none transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:bg-accent"
                            onClick={() => runContextAction(() => addBranchCurrentProbe(contextTargetNode))}
                          >
                            <CircuitBoard size={14} />
                            Probe branch current
                          </button>
                        </>
                      )}
                      {contextTargetNode.data.kind !== 'junction' && (
                        <button
                          type="button"
                          className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm outline-none transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:bg-accent"
                          onClick={() => runContextAction(() => rotateSelectedSchematicSymbols([contextTargetNode.id]))}
                        >
                          <RotateCw size={14} />
                          Rotate clockwise
                        </button>
                      )}
                    </>
                  )}
                </>
              )}

              {contextMenu.kind === 'node' && diagram.diagramMode === 'logic' && contextTargetNode?.data.kind !== 'group' && contextTargetNode?.data.kind !== 'component' && selectedGateNodes.length > 0 && (
                <>
                  {selectedInputNodes.length > 0 && (
                    <>
                      <div className="my-1 h-px bg-border/60" />
                      <button
                        type="button"
                        className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm outline-none transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:bg-accent"
                        onClick={() => runContextAction(() => toggleInputNodes(selectedInputNodes.map((node) => node.id)))}
                      >
                        <Power size={14} />
                        Toggle {selectedInputNodes.length > 1 ? `${selectedInputNodes.length} inputs` : 'input'}
                      </button>
                    </>
                  )}
                  <div className="my-1 h-px bg-border/60" />
                  <div className="px-2 py-1 text-[11px] font-medium text-muted-foreground">
                    Change {selectedGateNodes.length > 1 ? `${selectedGateNodes.length} gates` : 'gate'} to
                  </div>
                  <div className="grid grid-cols-2 gap-1">
                    {GATE_CHOICES.map((gate) => (
                      <button
                        key={gate.kind}
                        type="button"
                        className="rounded-md px-2 py-1.5 text-left text-sm outline-none transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:bg-accent"
                        onClick={() => runContextAction(() => changeSelectedGateKind(gate.kind))}
                      >
                        {gate.label}
                      </button>
                    ))}
                  </div>
                </>
              )}

              {selectedItemCount > 0 && (
                <>
                  <div className="my-1 h-px bg-border/60" />
                  <div className="px-2 py-1 text-[11px] font-medium text-muted-foreground">
                    Selection
                  </div>
                  {selectedUngroupedNodes.length >= 2 && (
                    <button
                      type="button"
                      className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm outline-none transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:bg-accent"
                      onClick={() => runContextAction(groupSelection)}
                    >
                      <Group size={14} />
                      Group selection
                    </button>
                  )}
                  {selectedGroupCount > 0 && (
                    <button
                      type="button"
                      className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm outline-none transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:bg-accent"
                      onClick={() => runContextAction(ungroupSelection)}
                    >
                      <Ungroup size={14} />
                      Ungroup selected groups
                    </button>
                  )}
                  {selectedGroupCount === 1 && (
                    <button
                      type="button"
                      className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm outline-none transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:bg-accent"
                      onClick={() => runContextAction(renameSelectedNode)}
                    >
                      <Pencil size={14} />
                      Rename selected group
                    </button>
                  )}
                  <button
                    type="button"
                    className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm text-destructive outline-none transition-colors hover:bg-destructive/10 focus-visible:bg-destructive/10"
                    onClick={() => runContextAction(deleteSelection)}
                  >
                    <Trash2 size={14} />
                    Delete selection
                  </button>
                </>
              )}
            </div>
          </>
        )}
        <div
          data-testid="logic-sharp-flow"
          className="absolute inset-0 overflow-hidden bg-background outline-none"
          onPointerDown={handlePanePointerDown}
          onPointerMove={handlePanePointerMove}
          onPointerUp={finishPointerSession}
          onPointerCancel={finishPointerSession}
          onLostPointerCapture={finishPointerSession}
          onWheel={handlePaneWheel}
          onContextMenu={handlePaneContextMenu}
          style={{
            cursor: panSessionRef.current ? 'grabbing' : selectionSessionRef.current ? 'crosshair' : 'default',
            backgroundImage: 'radial-gradient(circle, color-mix(in oklch, var(--muted-foreground) 28%, transparent) 1px, transparent 1px)',
            backgroundSize: `${LOGIC_GRID * viewport.zoom}px ${LOGIC_GRID * viewport.zoom}px`,
            backgroundPosition: `${viewport.x}px ${viewport.y}px`,
          }}
        >
          {selectionBox ? (
            <div
              className="pointer-events-none absolute z-30 rounded-sm border border-primary/75 bg-primary/12"
              style={{
                left: selectionBox.left,
                top: selectionBox.top,
                width: selectionBox.width,
                height: selectionBox.height,
              }}
            />
          ) : null}
          <svg className="absolute inset-0 size-full overflow-visible">
            {renderedEdges.map((edge) => {
              const geometry = edgeGeometries.get(edge.id);
              if (!geometry) return null;
              return (
                <SharpLogicEdge
                  key={edge.id}
                  edge={edge}
                  geometry={geometry}
                  selected={edge.selected === true}
                  zoom={viewport.zoom}
                  onPointerDown={handleEdgePointerDown}
                  onContextMenu={handleEdgeContextMenu}
                  onDoubleClick={(target) => openRenameEdge(target.id)}
                  schematic={diagram.diagramMode === 'schematic'}
                />
              );
            })}
            {connectionPreview ? (() => {
              const sourceNode = nodesById.get(connectionPreview.sourceNodeId);
              if (!sourceNode) return null;
              const source = flowToScreen(getHandleAnchor(sourceNode, connectionPreview.sourceHandle, 'source', nodesById), viewport);
              const [path] = getSmoothStepPath({
                sourceX: source.x,
                sourceY: source.y,
                sourcePosition: 'right' as never,
                targetX: connectionPreview.pointer.x,
                targetY: connectionPreview.pointer.y,
                targetPosition: 'left' as never,
                borderRadius: 12 * viewport.zoom,
              });
              return (
                <path
                  d={path}
                  fill="none"
                  stroke={LOGIC_SIGNAL_ON}
                  strokeWidth={2 * viewport.zoom}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeDasharray={`${8 * viewport.zoom} ${8 * viewport.zoom}`}
                  opacity={0.75}
                />
              );
            })() : null}
          </svg>
          {renderedEdges.map((edge) => {
            if (!edge.label) return null;
            const geometry = edgeGeometries.get(edge.id);
            if (!geometry) return null;
            return (
              <button
                key={`${edge.id}-label`}
                type="button"
                className="absolute rounded border border-border/60 bg-background/90 font-medium text-muted-foreground shadow-sm"
                style={{
                  left: geometry.labelX,
                  top: geometry.labelY,
                  transform: 'translate(-50%, -50%)',
                  padding: `${2 * viewport.zoom}px ${6 * viewport.zoom}px`,
                  fontSize: 10 * viewport.zoom,
                  lineHeight: 1.2,
                }}
                onDoubleClick={() => openRenameEdge(edge.id)}
              >
                {edge.label}
              </button>
            );
          })}
          {renderedNodes
            .filter((node) => {
              const position = flowToScreen(absoluteNodePosition(node, nodesById), viewport);
              const width = nodeBaseWidth(node) * viewport.zoom;
              const height = nodeBaseHeight(node) * viewport.zoom;
              const rect = viewportRef.current?.getBoundingClientRect();
              if (!rect) return true;
              return position.x + width >= -200 && position.y + height >= -200 && position.x <= rect.width + 200 && position.y <= rect.height + 200;
            })
            .sort((a, b) => (a.zIndex ?? 0) - (b.zIndex ?? 0))
            .map((node) => (
              <div key={node.id} data-logic-node>
                <SharpLogicNode
                  node={node}
                  viewport={viewport}
                  nodesById={nodesById}
                  readOnly={readOnly}
                  onPointerDown={handleNodePointerDown}
                  onDoubleClick={handleNodeDoubleClick}
                  onContextMenu={handleNodeContextMenu}
                  onHandlePointerDown={handleOutputPointerDown}
                  onHandlePointerUp={handleInputPointerUp}
                  schematicSymbolSet={schematicSymbolSet}
                />
              </div>
            ))}
        </div>
      </div>
      <Dialog open={renameTarget !== null} onOpenChange={(open) => {
        if (!open) {
          setRenameTarget(null);
          setRenameValue('');
        }
      }}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>
              {renameTarget?.kind === 'edge'
                ? 'Label wire'
                : renameTarget && nodes.find((n) => n.id === renameTarget.id)?.data.kind === 'group'
                ? 'Rename group'
                : renameTarget && nodes.find((n) => n.id === renameTarget.id)?.data.kind === 'output'
                ? 'Label output'
                : renameTarget && nodes.find((n) => n.id === renameTarget.id)?.data.kind === 'component'
                ? 'Label component'
                : 'Label gate'}
            </DialogTitle>
          </DialogHeader>
          <form
            className="space-y-4"
            onSubmit={(event) => {
              event.preventDefault();
              applyRename();
            }}
          >
            <Input
              autoFocus
              value={renameValue}
              onChange={(event) => setRenameValue(event.target.value)}
              placeholder={renameTarget?.kind === 'edge' ? 'Wire label' : 'Label (leave empty for default)'}
            />
            <DialogFooter className="border-none bg-transparent -mx-0 -mb-0 px-0 pb-0">
              <Button type="button" variant="outline" onClick={() => setRenameTarget(null)}>
                Cancel
              </Button>
              <Button type="submit">
                {renameTarget?.kind === 'edge' ? 'Set label' : 'Rename'}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
      <Dialog open={templatePickerOpen} onOpenChange={setTemplatePickerOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Insert template</DialogTitle>
          </DialogHeader>
          <div className="space-y-1.5 max-h-[60vh] overflow-y-auto">
            {getLogicDiagramTemplates().map((template) => (
              <button
                key={template.id}
                type="button"
                className="flex w-full flex-col items-start gap-0.5 rounded-lg border border-border/60 px-3 py-2.5 text-left outline-none transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:bg-accent"
                onClick={() => insertTemplate(template)}
              >
                <span className="text-sm font-medium">{template.name}</span>
                <span className="text-xs text-muted-foreground">{template.description}</span>
              </button>
            ))}
          </div>
          <p className="text-[11px] text-muted-foreground">
            Templates are appended to the current diagram at the viewport center.
          </p>
        </DialogContent>
      </Dialog>
      <Dialog open={componentPickerOpen} onOpenChange={setComponentPickerOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Insert component</DialogTitle>
            <DialogDescription>
              Components are placed as single reusable nodes. Snapshot is the safe default; linked follows future library updates.
            </DialogDescription>
          </DialogHeader>
          <div className="flex items-center gap-2 rounded-md border border-border/60 p-2">
            <span className="text-xs text-muted-foreground">Mode</span>
            <Select value={componentInsertMode} onValueChange={(value) => setComponentInsertMode(value as LogicComponentInstanceMode)}>
              <SelectTrigger size="sm" className="h-8 w-32">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="snapshot">Snapshot</SelectItem>
                <SelectItem value="linked">Linked</SelectItem>
              </SelectContent>
            </Select>
            <Button type="button" variant="ghost" size="sm" onClick={() => void reloadLogicComponents()} disabled={loadingComponents}>
              {loadingComponents ? <Loader2 size={14} className="animate-spin" /> : <RotateCcw size={14} />}
              Refresh
            </Button>
          </div>
          <div className="max-h-[58vh] space-y-1.5 overflow-y-auto">
            {loadingComponents ? (
              <div className="flex items-center justify-center py-8 text-sm text-muted-foreground">
                <Loader2 size={15} className="mr-2 animate-spin" />
                Loading components...
              </div>
            ) : logicComponents.length === 0 ? (
              <div className="rounded-lg border border-dashed border-border/70 px-3 py-8 text-center text-sm text-muted-foreground">
                No saved logic components in this vault yet.
              </div>
            ) : logicComponents.map((component) => {
              const inputs = component.ports.filter((port) => port.direction === 'input').map((port) => port.label).join(', ');
              const outputs = component.ports.filter((port) => port.direction === 'output').map((port) => port.label).join(', ');
              return (
                <div key={component.id} className="flex items-stretch rounded-md border border-border/60 transition-colors hover:bg-accent hover:text-accent-foreground">
                  <button
                    type="button"
                    className="flex min-w-0 flex-1 flex-col items-start gap-1 px-3 py-2.5 text-left outline-none focus-visible:bg-accent"
                    onClick={() => insertLogicComponent(component)}
                  >
                    <span className="text-sm font-medium">{component.name}</span>
                    {component.description && <span className="text-xs text-muted-foreground">{component.description}</span>}
                    <span className="text-[11px] text-muted-foreground">
                      In: {inputs || 'none'} · Out: {outputs || 'none'} · v{component.version}
                    </span>
                  </button>
                  <button
                    type="button"
                    className="m-1 flex w-9 shrink-0 items-center justify-center rounded text-muted-foreground outline-none hover:bg-background/70 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
                    title={`Edit ${component.name}`}
                    aria-label="Edit saved component"
                    disabled={Boolean(componentEditSession)}
                    onClick={() => void editLogicComponent(component)}
                  >
                    <Pencil size={14} />
                  </button>
                </div>
              );
            })}
          </div>
        </DialogContent>
      </Dialog>
      <Dialog open={componentSaveOpen} onOpenChange={setComponentSaveOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Save component</DialogTitle>
            <DialogDescription>
              Saves selected nodes as a component. If nothing is selected, the whole logic file is captured.
            </DialogDescription>
          </DialogHeader>
          <form
            className="space-y-4"
            onSubmit={(event) => {
              event.preventDefault();
              void saveLogicComponent();
            }}
          >
            <div className="space-y-2">
              <label className="text-xs font-medium text-muted-foreground" htmlFor="logic-component-name">Name</label>
              <Input
                id="logic-component-name"
                autoFocus
                value={componentName}
                onChange={(event) => setComponentName(event.target.value)}
                placeholder="Half adder"
              />
            </div>
            <div className="space-y-2">
              <label className="text-xs font-medium text-muted-foreground" htmlFor="logic-component-description">Description</label>
              <Input
                id="logic-component-description"
                value={componentDescription}
                onChange={(event) => setComponentDescription(event.target.value)}
                placeholder="Optional"
              />
            </div>
            <div className="rounded-md border border-border/60 px-3 py-2 text-xs text-muted-foreground">
              Ports are derived from captured input and output nodes. Labels must be unique for each direction.
            </div>
            <DialogFooter className="border-none bg-transparent -mx-0 -mb-0 px-0 pb-0">
              <Button type="button" variant="outline" onClick={() => setComponentSaveOpen(false)}>
                Cancel
              </Button>
              <Button type="submit">Save component</Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
      <Dialog open={truthTableOpen} onOpenChange={setTruthTableOpen}>
        <DialogContent className="max-w-[min(92vw,960px)] sm:max-w-4xl">
          <DialogHeader>
            <DialogTitle>Logic value table</DialogTitle>
            <DialogDescription>
              Every input combination is evaluated against the current circuit. Clock sources are treated as input columns here.
            </DialogDescription>
          </DialogHeader>
          <div className="flex items-center gap-2">
            <span className="text-xs font-medium text-muted-foreground">Scope</span>
            <Select value={truthTableScope} onValueChange={setTruthTableScope}>
              <SelectTrigger size="sm" className="h-8 min-w-48">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="document">Entire logic file</SelectItem>
                {availableComponents.map((component) => (
                  <SelectItem key={component.id} value={component.id}>{component.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <span className="text-xs text-muted-foreground">
              {truthTable.inputs.length} inputs · {truthTable.outputs.length} outputs · {truthTable.rows.length} rows
            </span>
          </div>
          {truthTable.error ? (
            <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {truthTable.error}
            </div>
          ) : truthTable.outputs.length === 0 ? (
            <div className="rounded-md border border-dashed border-border/70 px-3 py-8 text-center text-sm text-muted-foreground">
              Add at least one output node to calculate a value table.
            </div>
          ) : (
            <div className="max-h-[60vh] overflow-auto rounded-md border border-border/70">
              <table className="w-full min-w-max border-collapse text-center text-xs tabular-nums">
                <thead className="sticky top-0 z-10 bg-muted/95 backdrop-blur">
                  <tr className="border-b border-border/70">
                    {truthTable.inputs.length > 0 && (
                      <th colSpan={truthTable.inputs.length} className="border-r border-border/70 px-3 py-1.5 text-[10px] font-semibold uppercase text-muted-foreground">Inputs</th>
                    )}
                    <th colSpan={truthTable.outputs.length} className="px-3 py-1.5 text-[10px] font-semibold uppercase text-muted-foreground">Outputs</th>
                  </tr>
                  <tr className="border-b border-border/70">
                    {truthTable.inputs.map((column, index) => (
                      <th key={column.id} className={cn('px-4 py-2 font-semibold', index === truthTable.inputs.length - 1 && 'border-r border-border/70')}>
                        {column.label}
                      </th>
                    ))}
                    {truthTable.outputs.map((column) => (
                      <th key={column.id} className="px-4 py-2 font-semibold text-primary">{column.label}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {truthTable.rows.map((row, rowIndex) => (
                    <tr key={rowIndex} className="border-b border-border/40 last:border-0 odd:bg-muted/20">
                      {truthTable.inputs.map((column, index) => (
                        <td key={column.id} className={cn('px-4 py-2 text-muted-foreground', index === truthTable.inputs.length - 1 && 'border-r border-border/70')}>
                          {row.inputs[column.id] ? '1' : '0'}
                        </td>
                      ))}
                      {truthTable.outputs.map((column) => (
                        <td key={column.id} className="px-4 py-2 font-semibold text-foreground">
                          {typeof row.outputs[column.id] === 'boolean' ? (row.outputs[column.id] ? '1' : '0') : '–'}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </DialogContent>
      </Dialog>
      <Dialog open={clockSettingsNodeId !== null} onOpenChange={(open) => !open && setClockSettingsNodeId(null)}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Clock sequence</DialogTitle>
            <DialogDescription>Configure the repeating digital signal. The clock starts high at phase zero.</DialogDescription>
          </DialogHeader>
          <form
            className="space-y-4"
            onSubmit={(event) => {
              event.preventDefault();
              saveClockSettings();
            }}
          >
            <div className="grid grid-cols-2 gap-3">
              <label className="space-y-1.5 text-xs font-medium text-muted-foreground">
                Period (ms)
                <Input type="number" min={100} step={50} value={clockPeriodValue} onChange={(event) => setClockPeriodValue(event.target.value)} />
              </label>
              <label className="space-y-1.5 text-xs font-medium text-muted-foreground">
                High time (%)
                <Input type="number" min={5} max={95} step={5} value={clockDutyValue} onChange={(event) => setClockDutyValue(event.target.value)} />
              </label>
            </div>
            <label className="block space-y-1.5 text-xs font-medium text-muted-foreground">
              Phase offset (ms)
              <Input type="number" min={0} step={50} value={clockPhaseValue} onChange={(event) => setClockPhaseValue(event.target.value)} />
            </label>
            <DialogFooter className="border-none bg-transparent -mx-0 -mb-0 px-0 pb-0">
              <Button type="button" variant="outline" onClick={() => setClockSettingsNodeId(null)}>Cancel</Button>
              <Button type="submit" disabled={readOnly}>Apply</Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
      <Dialog open={schematicSettingsNodeId !== null} onOpenChange={(open) => !open && setSchematicSettingsNodeId(null)}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>
              {schematicSettingsNode && schematicSettingsKind
                ? `${logicNodeLabel({ kind: schematicSettingsKind, label: schematicSettingsNode.data.label })} settings`
                : 'Component settings'}
            </DialogTitle>
            <DialogDescription>
              Electrical values are stored in SI units and used by local circuit simulation.
            </DialogDescription>
          </DialogHeader>
          <form
            className="space-y-4"
            onSubmit={(event) => {
              event.preventDefault();
              saveSchematicSettings();
            }}
          >
            {schematicSettingsNumeric && (
              <label className="block space-y-1.5 text-xs font-medium text-muted-foreground">
                {schematicSettingsNumeric.label} ({schematicSettingsNumeric.unit})
                <Input
                  autoFocus
                  type="number"
                  inputMode="decimal"
                  step="any"
                  min={schematicSettingsNumeric.positive ? Number.MIN_VALUE : undefined}
                  value={schematicValueInput}
                  onChange={(event) => setSchematicValueInput(event.target.value)}
                />
              </label>
            )}
            {schematicSettingsKind === 'switch' && (
              <label className="flex items-center gap-2 text-sm font-medium text-foreground">
                <Checkbox
                  checked={schematicSwitchClosed}
                  onCheckedChange={(checked) => setSchematicSwitchClosed(checked === true)}
                />
                Switch closed
              </label>
            )}
            {(schematicSettingsKind === 'diode' || schematicSettingsKind === 'led' || schematicSettingsKind === 'transistor') && (
              <label className="block space-y-1.5 text-xs font-medium text-muted-foreground">
                Model reference
                <Input
                  autoFocus
                  value={schematicValueInput}
                  onChange={(event) => setSchematicValueInput(event.target.value)}
                  placeholder={`builtin:${schematicSettingsKind === 'transistor' ? 'npn' : schematicSettingsKind}`}
                />
              </label>
            )}
            <DialogFooter className="border-none bg-transparent -mx-0 -mb-0 px-0 pb-0">
              <Button type="button" variant="outline" onClick={() => setSchematicSettingsNodeId(null)}>Cancel</Button>
              <Button type="submit" disabled={readOnly}>Apply</Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
      <Dialog open={sweepConfigOpen} onOpenChange={setSweepConfigOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>DC source sweep</DialogTitle>
            <DialogDescription>
              Sweep one independent voltage source and record the configured voltage and current probes.
            </DialogDescription>
          </DialogHeader>
          <form
            className="space-y-4"
            onSubmit={(event) => {
              event.preventDefault();
              saveSweepConfiguration();
            }}
          >
            <label className="block space-y-1.5 text-xs font-medium text-muted-foreground">
              Source
              <Select value={sweepSourceInput} onValueChange={setSweepSourceInput}>
                <SelectTrigger className="w-full">
                  <SelectValue placeholder="Select voltage source" />
                </SelectTrigger>
                <SelectContent>
                  {sweepSourceChoices.map((source) => (
                    <SelectItem key={source.id} value={source.id}>{source.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </label>
            <div className="grid grid-cols-2 gap-3">
              <label className="block space-y-1.5 text-xs font-medium text-muted-foreground">
                Start (V)
                <Input type="number" inputMode="decimal" step="any" value={sweepStartInput} onChange={(event) => setSweepStartInput(event.target.value)} />
              </label>
              <label className="block space-y-1.5 text-xs font-medium text-muted-foreground">
                Stop (V)
                <Input type="number" inputMode="decimal" step="any" value={sweepStopInput} onChange={(event) => setSweepStopInput(event.target.value)} />
              </label>
            </div>
            <label className="block space-y-1.5 text-xs font-medium text-muted-foreground">
              Samples
              <Input type="number" inputMode="numeric" min={2} max={4096} step={1} value={sweepSamplesInput} onChange={(event) => setSweepSamplesInput(event.target.value)} />
            </label>
            <DialogFooter className="border-none bg-transparent -mx-0 -mb-0 px-0 pb-0">
              <Button type="button" variant="outline" onClick={() => setSweepConfigOpen(false)}>Cancel</Button>
              <Button type="submit" disabled={readOnly || sweepSourceChoices.length === 0}>Save sweep</Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
      <Dialog open={transientConfigOpen} onOpenChange={setTransientConfigOpen}>
        <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Transient analysis</DialogTitle>
            <DialogDescription>
              Configure the bounded time range and waveform for an independent voltage source.
            </DialogDescription>
          </DialogHeader>
          <form
            className="space-y-4"
            onSubmit={(event) => {
              event.preventDefault();
              saveTransientConfiguration();
            }}
          >
            <div className="grid grid-cols-2 gap-3">
              <label className="block space-y-1.5 text-xs font-medium text-muted-foreground">
                Duration (s)
                <Input type="number" inputMode="decimal" step="any" min={Number.MIN_VALUE} value={transientDurationInput} onChange={(event) => setTransientDurationInput(event.target.value)} />
              </label>
              <label className="block space-y-1.5 text-xs font-medium text-muted-foreground">
                Maximum timestep (s)
                <Input type="number" inputMode="decimal" step="any" min={Number.MIN_VALUE} value={transientStepInput} onChange={(event) => setTransientStepInput(event.target.value)} />
              </label>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <label className="block space-y-1.5 text-xs font-medium text-muted-foreground">
                Source
                <Select value={transientSourceInput} onValueChange={(value) => {
                  setTransientSourceInput(value);
                  loadTransientWaveform(value);
                }}>
                  <SelectTrigger className="w-full"><SelectValue placeholder="Select voltage source" /></SelectTrigger>
                  <SelectContent>
                    {sweepSourceChoices.map((source) => <SelectItem key={source.id} value={source.id}>{source.label}</SelectItem>)}
                  </SelectContent>
                </Select>
              </label>
              <label className="block space-y-1.5 text-xs font-medium text-muted-foreground">
                Waveform
                <Select value={transientWaveformKind} onValueChange={(value) => {
                  const kind = value as LogicSourceWaveform['kind'];
                  setTransientWaveformKind(kind);
                  setTransientWaveformInputs(kind === 'pulse'
                    ? { lowValue: '0', highValue: '5', delaySeconds: '0.001', riseSeconds: '0', fallSeconds: '0', pulseWidthSeconds: '0.005', periodSeconds: '0.01' }
                    : kind === 'sine'
                      ? { offset: '0', amplitude: '5', frequencyHertz: '50', phaseDegrees: '0', delaySeconds: '0', dampingPerSecond: '0' }
                      : {});
                }}>
                  <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="dc">DC value</SelectItem>
                    <SelectItem value="pulse">Pulse</SelectItem>
                    <SelectItem value="sine">Sine</SelectItem>
                  </SelectContent>
                </Select>
              </label>
            </div>
            {transientWaveformKind === 'pulse' ? (
              <div className="grid grid-cols-2 gap-3">
                {[
                  ['lowValue', 'Low level (V)'], ['highValue', 'High level (V)'],
                  ['delaySeconds', 'Delay (s)'], ['riseSeconds', 'Rise time (s)'],
                  ['fallSeconds', 'Fall time (s)'], ['pulseWidthSeconds', 'Pulse width (s)'],
                  ['periodSeconds', 'Period (s)'],
                ].map(([name, label]) => (
                  <label key={name} className="block space-y-1.5 text-xs font-medium text-muted-foreground">
                    {label}
                    <Input type="number" inputMode="decimal" step="any" value={transientWaveformInputs[name] ?? ''} onChange={(event) => setTransientWaveformInputs((current) => ({ ...current, [name]: event.target.value }))} />
                  </label>
                ))}
              </div>
            ) : null}
            {transientWaveformKind === 'sine' ? (
              <div className="grid grid-cols-2 gap-3">
                {[
                  ['offset', 'Offset (V)'], ['amplitude', 'Amplitude (V)'],
                  ['frequencyHertz', 'Frequency (Hz)'], ['phaseDegrees', 'Phase (deg)'],
                  ['delaySeconds', 'Delay (s)'], ['dampingPerSecond', 'Damping (1/s)'],
                ].map(([name, label]) => (
                  <label key={name} className="block space-y-1.5 text-xs font-medium text-muted-foreground">
                    {label}
                    <Input type="number" inputMode="decimal" step="any" value={transientWaveformInputs[name] ?? ''} onChange={(event) => setTransientWaveformInputs((current) => ({ ...current, [name]: event.target.value }))} />
                  </label>
                ))}
              </div>
            ) : null}
            <DialogFooter className="border-none bg-transparent -mx-0 -mb-0 px-0 pb-0">
              <Button type="button" variant="outline" onClick={() => setTransientConfigOpen(false)}>Cancel</Button>
              <Button type="submit" disabled={readOnly || sweepSourceChoices.length === 0}>Save transient</Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}

export default function LogicDiagramView(props: Props) {
  return <LogicDiagramEditor {...props} />;
}
