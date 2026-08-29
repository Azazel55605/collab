import type {
  ElectronicComponentKind,
  SchematicRotation,
  SchematicSymbolSet,
} from '../../types/logicDiagram';

export interface SchematicSymbolDefinition {
  kind: ElectronicComponentKind;
  label: string;
  inputHandles: string[];
  outputHandles: string[];
  width: number;
  height: number;
}

const SYMBOLS: Record<ElectronicComponentKind, SchematicSymbolDefinition> = {
  resistor: {
    kind: 'resistor',
    label: 'Resistor',
    inputHandles: ['terminal-a'],
    outputHandles: ['terminal-b'],
    width: 120,
    height: 72,
  },
  capacitor: {
    kind: 'capacitor',
    label: 'Capacitor',
    inputHandles: ['terminal-a'],
    outputHandles: ['terminal-b'],
    width: 120,
    height: 72,
  },
  inductor: {
    kind: 'inductor',
    label: 'Inductor',
    inputHandles: ['terminal-a'],
    outputHandles: ['terminal-b'],
    width: 120,
    height: 72,
  },
  diode: {
    kind: 'diode',
    label: 'Diode',
    inputHandles: ['anode'],
    outputHandles: ['cathode'],
    width: 120,
    height: 72,
  },
  led: {
    kind: 'led',
    label: 'LED',
    inputHandles: ['anode'],
    outputHandles: ['cathode'],
    width: 120,
    height: 72,
  },
  transistor: {
    kind: 'transistor',
    label: 'NPN transistor',
    inputHandles: ['base'],
    outputHandles: ['collector', 'emitter'],
    width: 120,
    height: 88,
  },
  switch: {
    kind: 'switch',
    label: 'Switch',
    inputHandles: ['terminal-a'],
    outputHandles: ['terminal-b'],
    width: 120,
    height: 72,
  },
  ground: {
    kind: 'ground',
    label: 'Ground',
    inputHandles: ['terminal'],
    outputHandles: [],
    width: 96,
    height: 72,
  },
  junction: {
    kind: 'junction',
    label: 'Junction',
    inputHandles: ['terminal'],
    outputHandles: [],
    width: 24,
    height: 24,
  },
  'voltage-source': {
    kind: 'voltage-source',
    label: 'Voltage source',
    inputHandles: ['negative'],
    outputHandles: ['positive'],
    width: 120,
    height: 80,
  },
};

export const SCHEMATIC_SYMBOL_CHOICES = Object.values(SYMBOLS);
export const SCHEMATIC_SYMBOL_SETS: Record<
  SchematicSymbolSet,
  { label: string; description: string }
> = {
  ansi: {
    label: 'ANSI / IEEE',
    description: 'American notation with the zigzag resistor symbol.',
  },
  iec: {
    label: 'IEC / DIN',
    description: 'International and German notation with the rectangular resistor symbol.',
  },
};

export function getSchematicSymbol(kind: ElectronicComponentKind) {
  return SYMBOLS[kind];
}

export function getSchematicTerminals(kind: ElectronicComponentKind) {
  const symbol = getSchematicSymbol(kind);
  return [...symbol.inputHandles, ...symbol.outputHandles];
}

export function schematicSymbolDimensions(
  kind: ElectronicComponentKind,
  rotation: SchematicRotation = 0,
) {
  const symbol = getSchematicSymbol(kind);
  return rotation === 90 || rotation === 270
    ? { width: symbol.height, height: symbol.width }
    : { width: symbol.width, height: symbol.height };
}

export function rotateSchematicClockwise(rotation: SchematicRotation = 0): SchematicRotation {
  return ((rotation + 90) % 360) as SchematicRotation;
}

function unrotatedTerminalPoint(kind: ElectronicComponentKind, handleId: string) {
  const symbol = getSchematicSymbol(kind);
  if (kind === 'junction') {
    return { x: symbol.width / 2, y: symbol.height / 2 };
  }
  const inputIndex = symbol.inputHandles.indexOf(handleId);
  if (inputIndex >= 0) {
    return {
      x: 0,
      y: symbol.height * ((inputIndex + 1) / (symbol.inputHandles.length + 1)),
    };
  }
  const outputIndex = symbol.outputHandles.indexOf(handleId);
  if (outputIndex >= 0) {
    return {
      x: symbol.width,
      y: symbol.height * ((outputIndex + 1) / (symbol.outputHandles.length + 1)),
    };
  }
  return { x: symbol.width / 2, y: symbol.height / 2 };
}

export function schematicTerminalPoint(
  kind: ElectronicComponentKind,
  handleId: string,
  rotation: SchematicRotation = 0,
) {
  const symbol = getSchematicSymbol(kind);
  const point = unrotatedTerminalPoint(kind, handleId);
  switch (rotation) {
    case 90:
      return { x: symbol.height - point.y, y: point.x };
    case 180:
      return { x: symbol.width - point.x, y: symbol.height - point.y };
    case 270:
      return { x: point.y, y: symbol.width - point.x };
    default:
      return point;
  }
}

export function schematicTerminalSide(
  kind: ElectronicComponentKind,
  handleId: string,
  rotation: SchematicRotation = 0,
): 'left' | 'right' | 'top' | 'bottom' {
  if (kind === 'junction') return 'right';
  const dimensions = schematicSymbolDimensions(kind, rotation);
  const point = schematicTerminalPoint(kind, handleId, rotation);
  if (point.x === 0) return 'left';
  if (point.x === dimensions.width) return 'right';
  if (point.y === 0) return 'top';
  return 'bottom';
}

export function schematicSymbolTransform(rotation: SchematicRotation = 0) {
  switch (rotation) {
    case 90:
      return 'translate(72 0) rotate(90)';
    case 180:
      return 'translate(100 72) rotate(180)';
    case 270:
      return 'translate(0 100) rotate(270)';
    default:
      return '';
  }
}

export function schematicSymbolViewBox(rotation: SchematicRotation = 0) {
  return rotation === 90 || rotation === 270 ? '0 0 72 100' : '0 0 100 72';
}

export function schematicSymbolMarkup(
  kind: ElectronicComponentKind,
  stroke = 'currentColor',
  symbolSet: SchematicSymbolSet = 'ansi',
) {
  const common = `fill="none" stroke="${stroke}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"`;
  switch (kind) {
    case 'resistor':
      return symbolSet === 'iec'
        ? `<path d="M0 32H24M24 20H76V44H24ZM76 32H100" ${common}/>`
        : `<path d="M0 32H20L26 20L38 44L50 20L62 44L74 20L80 32H100" ${common}/>`;
    case 'capacitor':
      return `<path d="M0 32H42M42 16V48M58 16V48M58 32H100" ${common}/>`;
    case 'inductor':
      return `<path d="M0 32H18C18 18 34 18 34 32C34 18 50 18 50 32C50 18 66 18 66 32C66 18 82 18 82 32H100" ${common}/>`;
    case 'diode':
      return `<path d="M0 32H32M68 32H100M32 14L68 32L32 50Z M68 14V50" ${common}/>`;
    case 'led':
      return `<path d="M0 32H32M68 32H100M32 14L68 32L32 50Z M68 14V50M70 14L82 2M78 20L90 8" ${common}/><path d="M79 2L82 2L82 5M87 8L90 8L90 11" ${common}/>`;
    case 'transistor':
      return `<path d="M0 36H40M40 14V58M46 28L78 24H100M46 42L78 48H100M68 42L78 48L69 52" ${common}/>`;
    case 'switch':
      return `<path d="M0 32H30M70 32H100M30 32L68 12" ${common}/><circle cx="30" cy="32" r="3" fill="${stroke}"/><circle cx="70" cy="32" r="3" fill="${stroke}"/>`;
    case 'ground':
      return `<path d="M0 32H50V40M24 40H76M32 50H68M40 60H60" ${common}/>`;
    case 'junction':
      return `<circle cx="50" cy="36" r="10" fill="${stroke}"/>`;
    case 'voltage-source':
      return `<path d="M0 36H22M78 36H100" ${common}/><circle cx="50" cy="36" r="28" ${common}/><path d="M31 36H43M57 36H69M63 30V42" ${common}/>`;
  }
}
