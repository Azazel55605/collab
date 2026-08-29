import {
  evaluateLogicDiagram,
  getLogicInputHandles,
  getLogicOutputHandles,
} from '../components/logic/logicDiagramEvaluator';
import {
  logicComponentDimensions,
  logicHandleYOffset,
  logicNodeLabel,
} from '../components/logic/logicDiagramFlow';
import {
  getSchematicTerminals,
  schematicSymbolDimensions,
  schematicSymbolMarkup,
  schematicSymbolTransform,
  schematicTerminalPoint,
} from '../components/logic/schematicSymbols';
import type {
  LogicDiagramDocument,
  LogicDiagramNode,
  LogicDiagramWire,
  SchematicSymbolSet,
} from '../types/logicDiagram';
import { isElectronicComponentKind } from '../types/logicDiagram';

const DEFAULT_NODE_WIDTH = 112;
const DEFAULT_NODE_HEIGHT = 64;
const GROUP_MIN_WIDTH = 240;
const GROUP_MIN_HEIGHT = 160;
const PADDING = 48;
const EXPORT_MARKER = 'collab-logic-diagram-export';

export interface LogicDiagramExportMetadata {
  marker: typeof EXPORT_MARKER;
  source: string;
  title?: string;
}

function escapeXml(value: string) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function utf8ToBase64(value: string) {
  return btoa(String.fromCharCode(...new TextEncoder().encode(value)));
}

function base64ToUtf8(value: string) {
  return new TextDecoder().decode(Uint8Array.from(atob(value), (char) => char.charCodeAt(0)));
}

function nodeSize(node: LogicDiagramNode) {
  if (node.kind === 'group') {
    return {
      width: Math.max(GROUP_MIN_WIDTH, node.width ?? GROUP_MIN_WIDTH),
      height: Math.max(GROUP_MIN_HEIGHT, node.height ?? GROUP_MIN_HEIGHT),
    };
  }
  if (node.kind === 'component') return logicComponentDimensions(node.component);
  if (isElectronicComponentKind(node.kind)) {
    return schematicSymbolDimensions(node.kind, node.rotation ?? 0);
  }
  return { width: DEFAULT_NODE_WIDTH, height: DEFAULT_NODE_HEIGHT };
}

function nodeBounds(node: LogicDiagramNode) {
  const size = nodeSize(node);
  return {
    x: node.position.x,
    y: node.position.y,
    ...size,
  };
}

function handlePoint(
  node: LogicDiagramNode | undefined,
  side: 'source' | 'target',
  handleId?: string,
) {
  if (!node) return { x: 0, y: 0 };
  const bounds = nodeBounds(node);
  if (isElectronicComponentKind(node.kind)) {
    const terminals = getSchematicTerminals(node.kind);
    const point = schematicTerminalPoint(node.kind, handleId ?? terminals[0], node.rotation ?? 0);
    return { x: bounds.x + point.x, y: bounds.y + point.y };
  }
  const handles =
    side === 'source'
      ? getLogicOutputHandles(node.kind, node.component)
      : getLogicInputHandles(node.kind, node.component);
  const index = Math.max(0, handles.indexOf(handleId ?? handles[0]));
  return {
    x: side === 'source' ? bounds.x + bounds.width : bounds.x,
    y: bounds.y + logicHandleYOffset(node.kind, handles.length, index, bounds.height),
  };
}

function wirePath(source: { x: number; y: number }, target: { x: number; y: number }) {
  const dx = Math.max(40, Math.abs(target.x - source.x) / 2);
  return `M ${source.x} ${source.y} C ${source.x + dx} ${source.y}, ${target.x - dx} ${target.y}, ${target.x} ${target.y}`;
}

function nodeFill(node: LogicDiagramNode) {
  if (node.kind === 'input' && node.value === true) return '#dbeafe';
  if (node.kind === 'group') return '#f8fafc';
  if (node.kind === 'component') return '#f5f3ff';
  if (node.kind === 'output') return '#ecfeff';
  return '#ffffff';
}

function signalColor(value: boolean | null | undefined) {
  if (value === true) return '#2563eb';
  if (value === false) return '#64748b';
  return '#cbd5e1';
}

function renderHandle(
  node: LogicDiagramNode,
  bounds: { x: number; y: number; width: number; height: number },
  side: 'input' | 'output',
  index: number,
  count: number,
  value: boolean | null | undefined,
) {
  const y = bounds.y + logicHandleYOffset(node.kind, count, index, bounds.height);
  const x = side === 'input' ? bounds.x : bounds.x + bounds.width;
  return `<circle cx="${x}" cy="${y}" r="5" fill="#ffffff" stroke="${signalColor(value)}" stroke-width="2"/>`;
}

function renderNode(
  node: LogicDiagramNode,
  outputValue: boolean | null | undefined,
  inputValues: Record<string, boolean | null | undefined>,
  outputValues: Record<string, boolean | null | undefined> = {},
  schematicSymbolSet: SchematicSymbolSet = 'ansi',
) {
  const bounds = nodeBounds(node);
  if (isElectronicComponentKind(node.kind)) {
    const kind = node.kind;
    const rotation = node.rotation ?? 0;
    const rotatedViewWidth = rotation === 90 || rotation === 270 ? 72 : 100;
    const rotatedViewHeight = rotation === 90 || rotation === 270 ? 100 : 72;
    const label = logicNodeLabel(node);
    const terminals = getSchematicTerminals(kind);
    const symbol = `<g transform="translate(${bounds.x} ${bounds.y}) scale(${bounds.width / rotatedViewWidth} ${bounds.height / rotatedViewHeight})"><g${schematicSymbolTransform(rotation) ? ` transform="${schematicSymbolTransform(rotation)}"` : ''}>${schematicSymbolMarkup(kind, '#334155', schematicSymbolSet)}</g></g>`;
    if (kind === 'junction') return symbol;
    return [
      symbol,
      `<text x="${bounds.x + bounds.width / 2}" y="${bounds.y + bounds.height - 2}" text-anchor="middle" font-family="Inter, Arial, sans-serif" font-size="10" font-weight="600" fill="#475569">${escapeXml(label)}</text>`,
      terminals
        .map((handleId) => {
          const point = schematicTerminalPoint(kind, handleId, rotation);
          return `<circle cx="${bounds.x + point.x}" cy="${bounds.y + point.y}" r="5" fill="#ffffff" stroke="#64748b" stroke-width="2"/>`;
        })
        .join(''),
    ].join('');
  }
  const rx = node.kind === 'group' ? 12 : 10;
  const stroke = node.kind === 'group' ? '#94a3b8' : signalColor(outputValue);
  const dash = node.kind === 'group' ? ' stroke-dasharray="8 6"' : '';
  const label = logicNodeLabel(node);
  const value =
    (node.kind === 'input' || node.kind === 'output') && typeof outputValue === 'boolean'
      ? outputValue
        ? '1'
        : '0'
      : '';
  const inputHandles = getLogicInputHandles(node.kind, node.component);
  const outputHandles = getLogicOutputHandles(node.kind, node.component);
  const active =
    outputValue === true || Object.values(outputValues).some((signal) => signal === true);
  const activeWash = active
    ? `<rect x="${bounds.x + 2}" y="${bounds.y + 2}" width="${bounds.width - 4}" height="${bounds.height - 4}" rx="${Math.max(0, rx - 2)}" fill="#dbeafe" opacity="0.72"/>`
    : '';
  const inversion = ['not', 'nand', 'nor', 'xnor'].includes(node.kind)
    ? `<circle cx="${bounds.x + bounds.width + 7}" cy="${bounds.y + bounds.height / 2}" r="6" fill="#ffffff" stroke="#475569" stroke-width="2"/>`
    : '';
  const handles = [
    ...inputHandles.map((handle, index) =>
      renderHandle(node, bounds, 'input', index, inputHandles.length, inputValues[handle]),
    ),
    ...outputHandles.map((handle, index) =>
      renderHandle(
        node,
        bounds,
        'output',
        index,
        outputHandles.length,
        outputValues[handle] ?? outputValue,
      ),
    ),
  ].join('');
  const componentPorts = node.component?.definition.ports ?? [];
  const componentLabels =
    node.kind === 'component'
      ? componentPorts
          .map((port) => {
            const sameDirection = componentPorts.filter(
              (candidate) => candidate.direction === port.direction,
            );
            const index = sameDirection.findIndex((candidate) => candidate.id === port.id);
            const y =
              bounds.y +
              logicHandleYOffset(node.kind, sameDirection.length, index, bounds.height) +
              3;
            const isInput = port.direction === 'input';
            return `<text x="${isInput ? bounds.x + 12 : bounds.x + bounds.width - 12}" y="${y}" text-anchor="${isInput ? 'start' : 'end'}" font-family="Inter, Arial, sans-serif" font-size="9" fill="#64748b">${escapeXml(port.label)}</text>`;
          })
          .join('')
      : '';
  const labelY =
    node.kind === 'component' ? bounds.y + 15 : bounds.y + bounds.height / 2 - (value ? 6 : 0);

  return [
    `<rect x="${bounds.x}" y="${bounds.y}" width="${bounds.width}" height="${bounds.height}" rx="${rx}" fill="${nodeFill(node)}" stroke="${stroke}" stroke-width="2"${dash}/>`,
    activeWash,
    `<text x="${bounds.x + bounds.width / 2}" y="${labelY}" text-anchor="middle" dominant-baseline="middle" font-family="Inter, Arial, sans-serif" font-size="${node.kind === 'component' ? 11 : 16}" font-weight="700" fill="#0f172a">${escapeXml(label)}</text>`,
    value
      ? `<text x="${bounds.x + bounds.width / 2}" y="${bounds.y + bounds.height / 2 + 18}" text-anchor="middle" dominant-baseline="middle" font-family="Inter, Arial, sans-serif" font-size="13" font-weight="600" fill="#2563eb">${value}</text>`
      : '',
    inversion,
    componentLabels,
    handles,
  ].join('');
}

function renderWire(
  wire: LogicDiagramWire,
  nodesById: Map<string, LogicDiagramNode>,
  value: boolean | null | undefined,
  schematic: boolean,
) {
  const source = handlePoint(nodesById.get(wire.source), 'source', wire.sourceHandle);
  const target = handlePoint(nodesById.get(wire.target), 'target', wire.targetHandle);
  const labelX = (source.x + target.x) / 2;
  const labelY = (source.y + target.y) / 2 - 8;
  const color = schematic ? '#334155' : signalColor(value);
  return [
    `<path d="${wirePath(source, target)}" fill="none" stroke="${color}" stroke-width="3" stroke-linecap="round"${schematic ? '' : ' marker-end="url(#logic-arrow)"'}/>`,
    wire.label
      ? `<text x="${labelX}" y="${labelY}" text-anchor="middle" font-family="Inter, Arial, sans-serif" font-size="12" fill="#475569">${escapeXml(wire.label)}</text>`
      : '',
  ].join('');
}

function inputValuesByNode(
  wires: LogicDiagramWire[],
  wireValues: Record<string, boolean | undefined>,
) {
  const values: Record<string, Record<string, boolean | undefined>> = {};
  for (const wire of wires) {
    const handle = wire.targetHandle ?? 'in';
    values[wire.target] = {
      ...(values[wire.target] ?? {}),
      [handle]: wireValues[wire.id],
    };
  }
  return values;
}

export function buildLogicDiagramSvg(
  document: LogicDiagramDocument,
  sourceRelativePath: string,
  schematicSymbolSet: SchematicSymbolSet = 'ansi',
): string {
  const nodes = document.nodes;
  const bounds =
    nodes.length > 0
      ? nodes.reduce(
          (acc, node) => {
            const box = nodeBounds(node);
            return {
              minX: Math.min(acc.minX, box.x),
              minY: Math.min(acc.minY, box.y),
              maxX: Math.max(acc.maxX, box.x + box.width),
              maxY: Math.max(acc.maxY, box.y + box.height),
            };
          },
          { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity },
        )
      : { minX: 0, minY: 0, maxX: 320, maxY: 180 };
  const viewBox = [
    bounds.minX - PADDING,
    bounds.minY - PADDING,
    Math.max(320, bounds.maxX - bounds.minX + PADDING * 2),
    Math.max(180, bounds.maxY - bounds.minY + PADDING * 2),
  ].join(' ');
  const metadata: LogicDiagramExportMetadata = {
    marker: EXPORT_MARKER,
    source: sourceRelativePath,
    title: document.title,
  };
  const schematic = document.diagramMode === 'schematic';
  const evaluation = schematic
    ? { nodeValues: {}, nodeOutputValues: {}, wireValues: {}, warnings: [] }
    : evaluateLogicDiagram(document.nodes, document.wires, { components: document.components });
  const nodeInputValues = inputValuesByNode(document.wires, evaluation.wireValues);
  const nodesById = new Map(nodes.map((node) => [node.id, node]));
  const wires = document.wires
    .map((wire) => renderWire(wire, nodesById, evaluation.wireValues[wire.id], schematic))
    .join('');
  const nodeMarkup = nodes
    .slice()
    .sort((a, b) => (a.kind === 'group' ? -1 : 0) - (b.kind === 'group' ? -1 : 0))
    .map((node) =>
      renderNode(
        node,
        evaluation.nodeValues[node.id],
        nodeInputValues[node.id] ?? {},
        evaluation.nodeOutputValues[node.id] ?? {},
        schematicSymbolSet,
      ),
    )
    .join('');

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}" role="img" aria-label="${escapeXml(document.title ?? (schematic ? 'Electronic schematic' : 'Logic diagram'))}">
<metadata>${escapeXml(JSON.stringify(metadata))}</metadata>
<defs><marker id="logic-arrow" markerWidth="10" markerHeight="10" refX="9" refY="3" orient="auto" markerUnits="strokeWidth"><path d="M0,0 L0,6 L9,3 z" fill="#334155"/></marker></defs>
<rect x="${bounds.minX - PADDING}" y="${bounds.minY - PADDING}" width="${Math.max(320, bounds.maxX - bounds.minX + PADDING * 2)}" height="${Math.max(180, bounds.maxY - bounds.minY + PADDING * 2)}" fill="#f8fafc"/>
<g>${wires}</g>
<g>${nodeMarkup}</g>
</svg>`;
}

export function buildLogicDiagramSvgDataUrl(
  document: LogicDiagramDocument,
  sourceRelativePath: string,
): string {
  return `data:image/svg+xml;base64,${utf8ToBase64(buildLogicDiagramSvg(document, sourceRelativePath))}`;
}

export function extractLogicDiagramExportSource(dataUrl: string): string | null {
  const match = /^data:image\/svg\+xml;base64,(.*)$/s.exec(dataUrl);
  if (!match) return null;
  try {
    const svg = base64ToUtf8(match[1]);
    const metadataMatch = /<metadata>([\s\S]*?)<\/metadata>/i.exec(svg);
    if (!metadataMatch) return null;
    const json = metadataMatch[1]
      .replace(/&quot;/g, '"')
      .replace(/&gt;/g, '>')
      .replace(/&lt;/g, '<')
      .replace(/&amp;/g, '&');
    const parsed = JSON.parse(json) as Partial<LogicDiagramExportMetadata>;
    return parsed.marker === EXPORT_MARKER && typeof parsed.source === 'string'
      ? parsed.source
      : null;
  } catch {
    return null;
  }
}
