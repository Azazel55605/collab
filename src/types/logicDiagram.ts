export const LOGIC_DIAGRAM_EXTENSION = 'logic';
export const LOGIC_DIAGRAM_SCHEMA_VERSION = 6;

export type LogicDiagramMode = 'logic' | 'schematic';
export type SchematicRotation = 0 | 90 | 180 | 270;
export type SchematicSymbolSet = 'ansi' | 'iec';

export type LogicGateKind =
  'input' | 'clock' | 'output' | 'group' | 'and' | 'or' | 'not' | 'xor' | 'nand' | 'nor' | 'xnor';

export type ElectronicComponentKind =
  | 'resistor'
  | 'capacitor'
  | 'inductor'
  | 'diode'
  | 'led'
  | 'transistor'
  | 'switch'
  | 'ground'
  | 'junction'
  | 'voltage-source';

export type LogicNodeKind = LogicGateKind | 'component' | ElectronicComponentKind;
export type LogicComponentInstanceMode = 'snapshot' | 'linked';
export type LogicComponentPortDirection = 'input' | 'output';

export interface LogicClockConfig {
  periodMs: number;
  dutyCycle: number;
  phaseMs: number;
}

export interface SchematicElectricalParameters {
  resistanceOhms?: number;
  capacitanceFarads?: number;
  inductanceHenries?: number;
  voltageVolts?: number;
  switchClosed?: boolean;
  modelRef?: string;
}

export type LogicCircuitProbeKind = 'node-voltage' | 'branch-current';

export interface LogicCircuitProbe {
  id: string;
  kind: LogicCircuitProbeKind;
  nodeId: string;
  handleId?: string;
  label?: string;
}

export interface LogicDcSweepConfig {
  sourceNodeId: string;
  start: number;
  stop: number;
  sampleCount: number;
}

export type LogicSourceWaveform =
  | { kind: 'dc' }
  | {
      kind: 'pulse';
      lowValue: number;
      highValue: number;
      delaySeconds: number;
      riseSeconds: number;
      fallSeconds: number;
      pulseWidthSeconds: number;
      periodSeconds: number;
    }
  | {
      kind: 'sine';
      offset: number;
      amplitude: number;
      frequencyHertz: number;
      phaseDegrees: number;
      delaySeconds: number;
      dampingPerSecond: number;
    };

export interface LogicTransientConfig {
  durationSeconds: number;
  maxTimeStepSeconds: number;
  sourceWaveforms: Record<string, LogicSourceWaveform>;
}

export interface LogicSimulationConfig {
  analysis: 'dc-operating-point' | 'dc-sweep' | 'transient';
  probes: LogicCircuitProbe[];
  dcSweep?: LogicDcSweepConfig;
  transient?: LogicTransientConfig;
}

export interface LogicComponentPort {
  id: string;
  label: string;
  direction: LogicComponentPortDirection;
  sourceNodeId: string;
}

export interface LogicComponentDefinition {
  id: string;
  name: string;
  description?: string;
  version: number;
  createdAt: number;
  updatedAt: number;
  ports: LogicComponentPort[];
  nodes: LogicDiagramNode[];
  wires: LogicDiagramWire[];
}

export interface LogicComponentInstance {
  mode: LogicComponentInstanceMode;
  componentId?: string;
  definition: LogicComponentDefinition;
}

export interface LogicDiagramNode {
  id: string;
  kind: LogicNodeKind;
  position: { x: number; y: number };
  label?: string;
  value?: boolean;
  clock?: LogicClockConfig;
  rotation?: SchematicRotation;
  electrical?: SchematicElectricalParameters;
  parentId?: string;
  width?: number;
  height?: number;
  component?: LogicComponentInstance;
}

export interface LogicDiagramWire {
  id: string;
  source: string;
  target: string;
  sourceHandle?: string;
  targetHandle?: string;
  label?: string;
}

export interface LogicDiagramDocument {
  schemaVersion: number;
  kind: 'logic-diagram';
  diagramMode: LogicDiagramMode;
  title?: string;
  nodes: LogicDiagramNode[];
  wires: LogicDiagramWire[];
  components?: LogicComponentDefinition[];
  simulation?: LogicSimulationConfig;
  viewport: { x: number; y: number; zoom: number };
}

const LOGIC_GATE_KINDS = new Set<LogicGateKind>([
  'input',
  'clock',
  'output',
  'group',
  'and',
  'or',
  'not',
  'xor',
  'nand',
  'nor',
  'xnor',
]);

const ELECTRONIC_COMPONENT_KINDS = new Set<ElectronicComponentKind>([
  'resistor',
  'capacitor',
  'inductor',
  'diode',
  'led',
  'transistor',
  'switch',
  'ground',
  'junction',
  'voltage-source',
]);

export function isLogicGateKind(kind: unknown): kind is LogicGateKind {
  return LOGIC_GATE_KINDS.has(kind as LogicGateKind);
}

export function isElectronicComponentKind(kind: unknown): kind is ElectronicComponentKind {
  return ELECTRONIC_COMPONENT_KINDS.has(kind as ElectronicComponentKind);
}

export function createEmptyLogicDiagram(
  title?: string,
  diagramMode: LogicDiagramMode = 'logic',
): LogicDiagramDocument {
  return {
    schemaVersion: LOGIC_DIAGRAM_SCHEMA_VERSION,
    kind: 'logic-diagram',
    diagramMode,
    title,
    nodes: [],
    wires: [],
    components: [],
    viewport: { x: 0, y: 0, zoom: 1 },
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function finiteNumber(value: unknown, fallback: number) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function optionalString(value: unknown) {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function timestamp(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) ? value : Date.now();
}

function normalizeComponentPort(value: unknown): LogicComponentPort | null {
  const record = asRecord(value);
  if (
    !record ||
    typeof record.id !== 'string' ||
    typeof record.label !== 'string' ||
    typeof record.sourceNodeId !== 'string' ||
    (record.direction !== 'input' && record.direction !== 'output')
  ) {
    return null;
  }
  const label = record.label.trim();
  if (!label) return null;
  return {
    id: record.id,
    label,
    direction: record.direction,
    sourceNodeId: record.sourceNodeId,
  };
}

function normalizeComponentDefinition(value: unknown): LogicComponentDefinition | null {
  const record = asRecord(value);
  if (!record || typeof record.id !== 'string' || typeof record.name !== 'string') return null;
  const name = record.name.trim();
  if (!name) return null;
  const nodes = Array.isArray(record.nodes)
    ? record.nodes.map(normalizeNode).filter((node): node is LogicDiagramNode => Boolean(node))
    : [];
  const wires = Array.isArray(record.wires)
    ? record.wires.map(normalizeWire).filter((wire): wire is LogicDiagramWire => Boolean(wire))
    : [];
  const ports = Array.isArray(record.ports)
    ? record.ports
        .map(normalizeComponentPort)
        .filter((port): port is LogicComponentPort => Boolean(port))
    : [];
  return {
    id: record.id,
    name,
    description: optionalString(record.description),
    version: Math.max(1, Math.floor(finiteNumber(record.version, 1))),
    createdAt: timestamp(record.createdAt),
    updatedAt: timestamp(record.updatedAt),
    ports,
    nodes,
    wires,
  };
}

function normalizeComponentInstance(value: unknown): LogicComponentInstance | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  const definition = normalizeComponentDefinition(record.definition);
  if (!definition) return undefined;
  return {
    mode: record.mode === 'linked' ? 'linked' : 'snapshot',
    componentId: optionalString(record.componentId) ?? definition.id,
    definition,
  };
}

function positiveFinite(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
}

function normalizeElectricalParameters(
  kind: LogicNodeKind,
  value: unknown,
): SchematicElectricalParameters | undefined {
  if (!isElectronicComponentKind(kind)) return undefined;
  const record = asRecord(value);
  if (!record) return undefined;

  switch (kind) {
    case 'resistor': {
      const resistanceOhms = positiveFinite(record.resistanceOhms);
      return resistanceOhms === undefined ? undefined : { resistanceOhms };
    }
    case 'capacitor': {
      const capacitanceFarads = positiveFinite(record.capacitanceFarads);
      return capacitanceFarads === undefined ? undefined : { capacitanceFarads };
    }
    case 'inductor': {
      const inductanceHenries = positiveFinite(record.inductanceHenries);
      return inductanceHenries === undefined ? undefined : { inductanceHenries };
    }
    case 'voltage-source':
      return typeof record.voltageVolts === 'number' && Number.isFinite(record.voltageVolts)
        ? { voltageVolts: record.voltageVolts }
        : undefined;
    case 'switch':
      return typeof record.switchClosed === 'boolean'
        ? { switchClosed: record.switchClosed }
        : undefined;
    case 'diode':
    case 'led':
    case 'transistor': {
      const modelRef = optionalString(record.modelRef);
      return modelRef ? { modelRef } : undefined;
    }
    case 'ground':
    case 'junction':
      return undefined;
  }
}

export function defaultSchematicElectricalParameters(
  kind: ElectronicComponentKind,
): SchematicElectricalParameters | undefined {
  switch (kind) {
    case 'resistor':
      return { resistanceOhms: 1_000 };
    case 'capacitor':
      return { capacitanceFarads: 1e-6 };
    case 'inductor':
      return { inductanceHenries: 1e-3 };
    case 'voltage-source':
      return { voltageVolts: 5 };
    case 'switch':
      return { switchClosed: false };
    case 'diode':
      return { modelRef: 'builtin:diode' };
    case 'led':
      return { modelRef: 'builtin:led' };
    case 'transistor':
      return { modelRef: 'builtin:npn' };
    case 'ground':
    case 'junction':
      return undefined;
  }
}

function normalizeCircuitProbe(value: unknown): LogicCircuitProbe | null {
  const record = asRecord(value);
  if (
    !record ||
    typeof record.id !== 'string' ||
    typeof record.nodeId !== 'string' ||
    (record.kind !== 'node-voltage' && record.kind !== 'branch-current')
  ) {
    return null;
  }
  return {
    id: record.id,
    kind: record.kind,
    nodeId: record.nodeId,
    handleId: optionalString(record.handleId),
    label: optionalString(record.label),
  };
}

function normalizeSourceWaveform(value: unknown): LogicSourceWaveform | null {
  const record = asRecord(value);
  if (!record) return null;
  if (record.kind === 'dc') return { kind: 'dc' };
  if (record.kind === 'pulse') {
    const values = [
      record.lowValue,
      record.highValue,
      record.delaySeconds,
      record.riseSeconds,
      record.fallSeconds,
      record.pulseWidthSeconds,
      record.periodSeconds,
    ];
    if (!values.every((candidate) => typeof candidate === 'number' && Number.isFinite(candidate)))
      return null;
    const [
      lowValue,
      highValue,
      delaySeconds,
      riseSeconds,
      fallSeconds,
      pulseWidthSeconds,
      periodSeconds,
    ] = values as number[];
    if (
      delaySeconds < 0 ||
      riseSeconds < 0 ||
      fallSeconds < 0 ||
      pulseWidthSeconds <= 0 ||
      periodSeconds <= 0
    )
      return null;
    if (riseSeconds + pulseWidthSeconds + fallSeconds > periodSeconds) return null;
    return {
      kind: 'pulse',
      lowValue,
      highValue,
      delaySeconds,
      riseSeconds,
      fallSeconds,
      pulseWidthSeconds,
      periodSeconds,
    };
  }
  if (record.kind === 'sine') {
    const values = [
      record.offset,
      record.amplitude,
      record.frequencyHertz,
      record.phaseDegrees,
      record.delaySeconds,
      record.dampingPerSecond,
    ];
    if (!values.every((candidate) => typeof candidate === 'number' && Number.isFinite(candidate)))
      return null;
    const [offset, amplitude, frequencyHertz, phaseDegrees, delaySeconds, dampingPerSecond] =
      values as number[];
    if (frequencyHertz <= 0 || delaySeconds < 0 || dampingPerSecond < 0) return null;
    return {
      kind: 'sine',
      offset,
      amplitude,
      frequencyHertz,
      phaseDegrees,
      delaySeconds,
      dampingPerSecond,
    };
  }
  return null;
}

function normalizeTransientConfig(value: unknown): LogicTransientConfig | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  const durationSeconds = record.durationSeconds;
  const maxTimeStepSeconds = record.maxTimeStepSeconds;
  if (
    typeof durationSeconds !== 'number' ||
    !Number.isFinite(durationSeconds) ||
    durationSeconds <= 0 ||
    typeof maxTimeStepSeconds !== 'number' ||
    !Number.isFinite(maxTimeStepSeconds) ||
    maxTimeStepSeconds <= 0
  )
    return undefined;
  const boundedDuration = Math.min(durationSeconds, 3_600);
  const boundedTimeStep = Math.max(
    Math.min(maxTimeStepSeconds, boundedDuration),
    boundedDuration / 4_095,
  );
  const waveforms = asRecord(record.sourceWaveforms);
  const sourceWaveforms: Record<string, LogicSourceWaveform> = {};
  if (waveforms) {
    for (const [sourceNodeId, waveformValue] of Object.entries(waveforms)) {
      if (!sourceNodeId) continue;
      const waveform = normalizeSourceWaveform(waveformValue);
      if (waveform) sourceWaveforms[sourceNodeId] = waveform;
    }
  }
  return { durationSeconds: boundedDuration, maxTimeStepSeconds: boundedTimeStep, sourceWaveforms };
}

function normalizeSimulationConfig(value: unknown): LogicSimulationConfig | undefined {
  const record = asRecord(value);
  if (
    !record ||
    !['dc-operating-point', 'dc-sweep', 'transient'].includes(String(record.analysis))
  ) {
    return undefined;
  }
  const sweep = asRecord(record.dcSweep);
  const sourceNodeId = optionalString(sweep?.sourceNodeId);
  const start = sweep?.start;
  const stop = sweep?.stop;
  const sampleCount = sweep?.sampleCount;
  const dcSweep =
    sourceNodeId &&
    typeof start === 'number' &&
    Number.isFinite(start) &&
    typeof stop === 'number' &&
    Number.isFinite(stop) &&
    start !== stop &&
    typeof sampleCount === 'number' &&
    Number.isFinite(sampleCount)
      ? {
          sourceNodeId,
          start,
          stop,
          sampleCount: Math.min(4096, Math.max(2, Math.floor(sampleCount))),
        }
      : undefined;
  const transient = normalizeTransientConfig(record.transient);
  return {
    analysis:
      record.analysis === 'dc-sweep' && dcSweep
        ? 'dc-sweep'
        : record.analysis === 'transient' && transient
          ? 'transient'
          : 'dc-operating-point',
    probes: Array.isArray(record.probes)
      ? record.probes
          .map(normalizeCircuitProbe)
          .filter((probe): probe is LogicCircuitProbe => Boolean(probe))
      : [],
    dcSweep,
    transient,
  };
}

function normalizeNode(value: unknown): LogicDiagramNode | null {
  const record = asRecord(value);
  if (
    !record ||
    typeof record.id !== 'string' ||
    !(
      isLogicGateKind(record.kind) ||
      isElectronicComponentKind(record.kind) ||
      record.kind === 'component'
    )
  ) {
    return null;
  }
  const position = asRecord(record.position);
  const clock = asRecord(record.clock);
  const rotation =
    record.rotation === 90 || record.rotation === 180 || record.rotation === 270
      ? record.rotation
      : 0;
  return {
    id: record.id,
    kind: record.kind as LogicNodeKind,
    position: {
      x: finiteNumber(position?.x, 0),
      y: finiteNumber(position?.y, 0),
    },
    label: optionalString(record.label),
    value: typeof record.value === 'boolean' ? record.value : undefined,
    clock:
      record.kind === 'clock'
        ? {
            periodMs: Math.max(100, finiteNumber(clock?.periodMs, 1000)),
            dutyCycle: Math.min(0.95, Math.max(0.05, finiteNumber(clock?.dutyCycle, 0.5))),
            phaseMs: Math.max(0, finiteNumber(clock?.phaseMs, 0)),
          }
        : undefined,
    rotation: isElectronicComponentKind(record.kind) ? rotation : undefined,
    electrical: normalizeElectricalParameters(record.kind as LogicNodeKind, record.electrical),
    parentId: optionalString(record.parentId),
    width:
      typeof record.width === 'number' && Number.isFinite(record.width) ? record.width : undefined,
    height:
      typeof record.height === 'number' && Number.isFinite(record.height)
        ? record.height
        : undefined,
    component:
      record.kind === 'component' ? normalizeComponentInstance(record.component) : undefined,
  };
}

function normalizeWire(value: unknown): LogicDiagramWire | null {
  const record = asRecord(value);
  if (
    !record ||
    typeof record.id !== 'string' ||
    typeof record.source !== 'string' ||
    typeof record.target !== 'string'
  ) {
    return null;
  }
  return {
    id: record.id,
    source: record.source,
    target: record.target,
    sourceHandle: optionalString(record.sourceHandle),
    targetHandle: optionalString(record.targetHandle),
    label: optionalString(record.label),
  };
}

export function normalizeLogicDiagramDocument(input: unknown): LogicDiagramDocument {
  const record = asRecord(input);
  if (!record) return createEmptyLogicDiagram();

  const viewport = asRecord(record.viewport);
  const nodes = Array.isArray(record.nodes)
    ? record.nodes.map(normalizeNode).filter((node): node is LogicDiagramNode => Boolean(node))
    : [];
  const inferredMode = nodes.some((node) => isElectronicComponentKind(node.kind))
    ? 'schematic'
    : 'logic';
  return {
    schemaVersion: LOGIC_DIAGRAM_SCHEMA_VERSION,
    kind: 'logic-diagram',
    diagramMode:
      record.diagramMode === 'schematic' || record.diagramMode === 'logic'
        ? record.diagramMode
        : inferredMode,
    title: optionalString(record.title),
    nodes,
    wires: Array.isArray(record.wires)
      ? record.wires.map(normalizeWire).filter((wire): wire is LogicDiagramWire => Boolean(wire))
      : [],
    components: Array.isArray(record.components)
      ? record.components
          .map(normalizeComponentDefinition)
          .filter((component): component is LogicComponentDefinition => Boolean(component))
      : [],
    simulation: normalizeSimulationConfig(record.simulation),
    viewport: {
      x: finiteNumber(viewport?.x, 0),
      y: finiteNumber(viewport?.y, 0),
      zoom: finiteNumber(viewport?.zoom, 1),
    },
  };
}

export function parseLogicDiagramDocument(text: string): LogicDiagramDocument {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('The .logic file does not contain valid JSON.');
  }
  const record = asRecord(parsed);
  if (!record) throw new Error('The .logic file must contain a JSON object.');
  if (record.kind !== 'logic-diagram') {
    throw new Error('The .logic file must be a logic-diagram document.');
  }
  if (!Array.isArray(record.nodes) || !Array.isArray(record.wires)) {
    throw new Error('The .logic file must contain nodes and wires arrays.');
  }
  return normalizeLogicDiagramDocument(record);
}
