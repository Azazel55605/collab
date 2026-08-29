import type {
  LogicDiagramDocument,
  LogicDiagramNode,
  LogicDiagramWire,
} from '../../types/logicDiagram';
import { LOGIC_DIAGRAM_SCHEMA_VERSION } from '../../types/logicDiagram';

export interface LogicDiagramTemplate {
  id: string;
  name: string;
  description: string;
  document: LogicDiagramDocument;
}

let templateIdCounter = 0;

function nodeId(prefix: string) {
  templateIdCounter += 1;
  return `${prefix}-${templateIdCounter.toString(36)}`;
}

function node(
  id: string,
  kind: LogicDiagramNode['kind'],
  x: number,
  y: number,
  extra: Partial<LogicDiagramNode> = {},
): LogicDiagramNode {
  return { id, kind, position: { x, y }, ...extra };
}

function wire(
  id: string,
  source: string,
  target: string,
  sourceHandle: string,
  targetHandle: string,
  label?: string,
): LogicDiagramWire {
  return { id, source, target, sourceHandle, targetHandle, label };
}

function doc(
  title: string,
  nodes: LogicDiagramNode[],
  wires: LogicDiagramWire[],
): LogicDiagramDocument {
  return {
    schemaVersion: LOGIC_DIAGRAM_SCHEMA_VERSION,
    kind: 'logic-diagram',
    diagramMode: 'logic',
    title,
    nodes,
    wires,
    viewport: { x: 0, y: 0, zoom: 1 },
  };
}

// ── Half-Adder ───────────────────────────────────────────────────────────────
// Sum = A XOR B, Carry = A AND B
function halfAdderDocument(): LogicDiagramDocument {
  const a = nodeId('in');
  const b = nodeId('in');
  const xor = nodeId('xor');
  const and = nodeId('and');
  const sum = nodeId('out');
  const carry = nodeId('out');

  const nodes: LogicDiagramNode[] = [
    node(a, 'input', 0, 60, { label: 'A' }),
    node(b, 'input', 0, 220, { label: 'B' }),
    node(xor, 'xor', 260, 40),
    node(and, 'and', 260, 240),
    node(sum, 'output', 520, 40, { label: 'Sum' }),
    node(carry, 'output', 520, 240, { label: 'Carry' }),
  ];

  const wires: LogicDiagramWire[] = [
    wire(nodeId('w'), a, xor, 'out', 'in-a'),
    wire(nodeId('w'), b, xor, 'out', 'in-b'),
    wire(nodeId('w'), a, and, 'out', 'in-a'),
    wire(nodeId('w'), b, and, 'out', 'in-b'),
    wire(nodeId('w'), xor, sum, 'out', 'in'),
    wire(nodeId('w'), and, carry, 'out', 'in'),
  ];

  return doc('Half-Adder', nodes, wires);
}

// ── Full-Adder ───────────────────────────────────────────────────────────────
// Sum = A XOR B XOR Cin, Cout = (A AND B) OR (Cin AND (A XOR B))
function fullAdderDocument(): LogicDiagramDocument {
  const a = nodeId('in');
  const b = nodeId('in');
  const cin = nodeId('in');
  const xor1 = nodeId('xor'); // A XOR B
  const xor2 = nodeId('xor'); // (A XOR B) XOR Cin → Sum
  const and1 = nodeId('and'); // A AND B
  const and2 = nodeId('and'); // Cin AND (A XOR B)
  const or1 = nodeId('or'); // Cout
  const sum = nodeId('out');
  const cout = nodeId('out');

  const nodes: LogicDiagramNode[] = [
    node(a, 'input', 0, 40, { label: 'A' }),
    node(b, 'input', 0, 160, { label: 'B' }),
    node(cin, 'input', 0, 320, { label: 'Cin' }),
    node(xor1, 'xor', 240, 80),
    node(xor2, 'xor', 480, 140),
    node(and1, 'and', 240, 280),
    node(and2, 'and', 480, 320),
    node(or1, 'or', 720, 300),
    node(sum, 'output', 720, 140, { label: 'Sum' }),
    node(cout, 'output', 960, 300, { label: 'Cout' }),
  ];

  const wires: LogicDiagramWire[] = [
    // xor1 = A XOR B
    wire(nodeId('w'), a, xor1, 'out', 'in-a'),
    wire(nodeId('w'), b, xor1, 'out', 'in-b'),
    // xor2 = xor1 XOR Cin → Sum
    wire(nodeId('w'), xor1, xor2, 'out', 'in-a'),
    wire(nodeId('w'), cin, xor2, 'out', 'in-b'),
    wire(nodeId('w'), xor2, sum, 'out', 'in'),
    // and1 = A AND B
    wire(nodeId('w'), a, and1, 'out', 'in-a'),
    wire(nodeId('w'), b, and1, 'out', 'in-b'),
    // and2 = Cin AND xor1
    wire(nodeId('w'), cin, and2, 'out', 'in-a'),
    wire(nodeId('w'), xor1, and2, 'out', 'in-b'),
    // or1 = and1 OR and2 → Cout
    wire(nodeId('w'), and1, or1, 'out', 'in-a'),
    wire(nodeId('w'), and2, or1, 'out', 'in-b'),
    wire(nodeId('w'), or1, cout, 'out', 'in'),
  ];

  return doc('Full-Adder', nodes, wires);
}

// ── 2:1 Multiplexer ──────────────────────────────────────────────────────────
// Y = (A AND ¬S) OR (B AND S)
function multiplexerDocument(): LogicDiagramDocument {
  const a = nodeId('in');
  const b = nodeId('in');
  const s = nodeId('in');
  const notS = nodeId('not'); // ¬S
  const and1 = nodeId('and'); // A AND ¬S
  const and2 = nodeId('and'); // B AND S
  const or1 = nodeId('or'); // Y
  const y = nodeId('out');

  const nodes: LogicDiagramNode[] = [
    node(a, 'input', 0, 40, { label: 'A' }),
    node(b, 'input', 0, 160, { label: 'B' }),
    node(s, 'input', 0, 320, { label: 'S' }),
    node(notS, 'not', 220, 320),
    node(and1, 'and', 440, 40),
    node(and2, 'and', 440, 200),
    node(or1, 'or', 660, 120),
    node(y, 'output', 880, 120, { label: 'Y' }),
  ];

  const wires: LogicDiagramWire[] = [
    wire(nodeId('w'), s, notS, 'out', 'in'),
    wire(nodeId('w'), a, and1, 'out', 'in-a'),
    wire(nodeId('w'), notS, and1, 'out', 'in-b'),
    wire(nodeId('w'), b, and2, 'out', 'in-a'),
    wire(nodeId('w'), s, and2, 'out', 'in-b'),
    wire(nodeId('w'), and1, or1, 'out', 'in-a'),
    wire(nodeId('w'), and2, or1, 'out', 'in-b'),
    wire(nodeId('w'), or1, y, 'out', 'in'),
  ];

  return doc('2:1 Multiplexer', nodes, wires);
}

// ── SR Flip-Flop Overview ────────────────────────────────────────────────────
// Two cross-coupled NOR gates: Q = NOR(S, Q̄), Q̄ = NOR(R, Q)
function srFlipFlopDocument(): LogicDiagramDocument {
  const s = nodeId('in');
  const r = nodeId('in');
  const nor1 = nodeId('nor'); // Q = NOR(S, Q̄)
  const nor2 = nodeId('nor'); // Q̄ = NOR(R, Q)
  const q = nodeId('out');
  const qbar = nodeId('out');

  const nodes: LogicDiagramNode[] = [
    node(s, 'input', 0, 60, { label: 'S' }),
    node(r, 'input', 0, 280, { label: 'R' }),
    node(nor1, 'nor', 300, 60),
    node(nor2, 'nor', 300, 280),
    node(q, 'output', 560, 60, { label: 'Q' }),
    node(qbar, 'output', 560, 280, { label: 'Q̄' }),
  ];

  const wires: LogicDiagramWire[] = [
    // S → nor1.in-a
    wire(nodeId('w'), s, nor1, 'out', 'in-a'),
    // R → nor2.in-a
    wire(nodeId('w'), r, nor2, 'out', 'in-a'),
    // Cross-coupling: nor2.out → nor1.in-b (Q̄ feeds back into Q gate)
    wire(nodeId('w'), nor2, nor1, 'out', 'in-b'),
    // nor1.out → nor2.in-b (Q feeds back into Q̄ gate)
    wire(nodeId('w'), nor1, nor2, 'out', 'in-b'),
    // Outputs
    wire(nodeId('w'), nor1, q, 'out', 'in'),
    wire(nodeId('w'), nor2, qbar, 'out', 'in'),
  ];

  return doc('SR Flip-Flop Overview', nodes, wires);
}

let cachedTemplates: LogicDiagramTemplate[] | null = null;

export function getLogicDiagramTemplates(): LogicDiagramTemplate[] {
  if (cachedTemplates) return cachedTemplates;
  templateIdCounter = 0;
  cachedTemplates = [
    {
      id: 'half-adder',
      name: 'Half-Adder',
      description: 'Sum = A XOR B, Carry = A AND B.',
      document: halfAdderDocument(),
    },
    {
      id: 'full-adder',
      name: 'Full-Adder',
      description: 'Adds A, B, and Cin with Sum and Cout outputs.',
      document: fullAdderDocument(),
    },
    {
      id: 'multiplexer',
      name: '2:1 Multiplexer',
      description: 'Y = (A AND ¬S) OR (B AND S). Selects A when S=0, B when S=1.',
      document: multiplexerDocument(),
    },
    {
      id: 'sr-flip-flop',
      name: 'SR Flip-Flop Overview',
      description: 'Two cross-coupled NOR gates forming a bistable latch (Q and Q̄).',
      document: srFlipFlopDocument(),
    },
  ];
  return cachedTemplates;
}

/**
 * Deep-clone a template document with fresh node/wire IDs so multiple inserts
 * into the same diagram never collide. Optionally overrides the title.
 */
let instantiateCounter = 0;
export function instantiateLogicDiagramTemplate(
  template: LogicDiagramTemplate,
  title?: string,
): LogicDiagramDocument {
  // Each call gets a globally unique prefix (incrementing counter + random
  // suffix) so two instantiations never produce overlapping IDs.
  instantiateCounter += 1;
  const prefix = `n${instantiateCounter.toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const idMap = new Map<string, string>();
  let counter = 0;
  const freshId = (old: string) => {
    if (!idMap.has(old)) {
      counter += 1;
      idMap.set(old, `${prefix}${counter.toString(36)}`);
    }
    return idMap.get(old)!;
  };

  const nodes: LogicDiagramNode[] = template.document.nodes.map((n) => ({
    ...n,
    id: freshId(n.id),
    parentId: n.parentId ? freshId(n.parentId) : undefined,
    position: { ...n.position },
  }));

  const wires: LogicDiagramWire[] = template.document.wires.map((w) => ({
    ...w,
    id: freshId(w.id),
    source: freshId(w.source),
    target: freshId(w.target),
  }));

  return doc(title ?? template.document.title ?? template.name, nodes, wires);
}
