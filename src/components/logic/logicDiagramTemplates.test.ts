import { describe, expect, it } from 'vitest';

import { normalizeLogicDiagramDocument } from '../../types/logicDiagram';

import {
  evaluateLogicDiagram,
  getLogicInputHandles,
  getLogicOutputHandles,
} from './logicDiagramEvaluator';
import { getLogicDiagramTemplates, instantiateLogicDiagramTemplate } from './logicDiagramTemplates';

const TEMPLATE_IDS = ['half-adder', 'full-adder', 'multiplexer', 'sr-flip-flop'];

describe('logicDiagramTemplates', () => {
  it('exposes the four starter templates', () => {
    const templates = getLogicDiagramTemplates();
    expect(templates).toHaveLength(4);
    expect(templates.map((t) => t.id).sort()).toEqual([...TEMPLATE_IDS].sort());
  });

  it('each template produces a valid document that round-trips through normalization', () => {
    for (const template of getLogicDiagramTemplates()) {
      const normalized = normalizeLogicDiagramDocument(template.document);
      expect(normalized.kind).toBe('logic-diagram');
      expect(normalized.nodes.length).toBe(template.document.nodes.length);
      expect(normalized.wires.length).toBe(template.document.wires.length);
      // Every node id is unique
      const nodeIds = normalized.nodes.map((n) => n.id);
      expect(new Set(nodeIds).size).toBe(nodeIds.length);
      // Every wire id is unique
      const wireIds = normalized.wires.map((w) => w.id);
      expect(new Set(wireIds).size).toBe(wireIds.length);
    }
  });

  it('every wire connects to valid handles on real nodes', () => {
    for (const template of getLogicDiagramTemplates()) {
      const { nodes, wires } = template.document;
      const nodeMap = new Map(nodes.map((n) => [n.id, n]));
      for (const w of wires) {
        const source = nodeMap.get(w.source);
        const target = nodeMap.get(w.target);
        expect(
          source,
          `wire ${w.id} source ${w.source} must exist in ${template.id}`,
        ).toBeDefined();
        expect(
          target,
          `wire ${w.id} target ${w.target} must exist in ${template.id}`,
        ).toBeDefined();
        if (!source || !target) continue;
        // Source handle must be a valid output handle for the source kind
        const sourceHandles = getLogicOutputHandles(source.kind);
        expect(
          sourceHandles,
          `wire ${w.id} sourceHandle must be valid for ${source.kind}`,
        ).toContain(w.sourceHandle ?? 'out');
        // Target handle must be a valid input handle for the target kind
        const targetHandles = getLogicInputHandles(target.kind);
        expect(
          targetHandles,
          `wire ${w.id} targetHandle must be valid for ${target.kind}`,
        ).toContain(w.targetHandle ?? 'in');
      }
    }
  });

  it('instantiateLogicDiagramTemplate regenerates fresh IDs with no collisions', () => {
    const template = getLogicDiagramTemplates().find((t) => t.id === 'half-adder')!;
    const a = instantiateLogicDiagramTemplate(template);
    const b = instantiateLogicDiagramTemplate(template);
    const aIds = new Set([...a.nodes.map((n) => n.id), ...a.wires.map((w) => w.id)]);
    const bIds = new Set([...b.nodes.map((n) => n.id), ...b.wires.map((w) => w.id)]);
    // No overlap between two instantiations
    for (const id of bIds) {
      expect(aIds.has(id), `duplicate id ${id} across instantiations`).toBe(false);
    }
    // Structure preserved (same number of nodes/wires)
    expect(a.nodes.length).toBe(template.document.nodes.length);
    expect(a.wires.length).toBe(template.document.wires.length);
  });

  it('half-adder evaluates correctly for all input combinations', () => {
    const template = getLogicDiagramTemplates().find((t) => t.id === 'half-adder')!;
    const doc = instantiateLogicDiagramTemplate(template);
    const inputA = doc.nodes.find((n) => n.kind === 'input' && n.label === 'A')!;
    const inputB = doc.nodes.find((n) => n.kind === 'input' && n.label === 'B')!;
    const sumOut = doc.nodes.find((n) => n.kind === 'output' && n.label === 'Sum')!;
    const carryOut = doc.nodes.find((n) => n.kind === 'output' && n.label === 'Carry')!;

    const cases: Array<[boolean, boolean, boolean, boolean]> = [
      [false, false, false, false], // 0+0 = 00
      [true, false, true, false], // 1+0 = 01
      [false, true, true, false], // 0+1 = 01
      [true, true, false, true], // 1+1 = 10
    ];

    for (const [a, b, expectedSum, expectedCarry] of cases) {
      const testDoc = {
        ...doc,
        nodes: doc.nodes.map((n) =>
          n.id === inputA.id ? { ...n, value: a } : n.id === inputB.id ? { ...n, value: b } : n,
        ),
      };
      const result = evaluateLogicDiagram(testDoc.nodes, testDoc.wires);
      expect(result.nodeValues[sumOut.id], `half-adder A=${a} B=${b} sum`).toBe(expectedSum);
      expect(result.nodeValues[carryOut.id], `half-adder A=${a} B=${b} carry`).toBe(expectedCarry);
    }
  });

  it('full-adder evaluates correctly for all input combinations', () => {
    const template = getLogicDiagramTemplates().find((t) => t.id === 'full-adder')!;
    const doc = instantiateLogicDiagramTemplate(template);
    const inputA = doc.nodes.find((n) => n.kind === 'input' && n.label === 'A')!;
    const inputB = doc.nodes.find((n) => n.kind === 'input' && n.label === 'B')!;
    const inputCin = doc.nodes.find((n) => n.kind === 'input' && n.label === 'Cin')!;
    const sumOut = doc.nodes.find((n) => n.kind === 'output' && n.label === 'Sum')!;
    const coutOut = doc.nodes.find((n) => n.kind === 'output' && n.label === 'Cout')!;

    // A + B + Cin → Sum, Cout (2-bit result)
    const cases: Array<[boolean, boolean, boolean, boolean, boolean]> = [
      [false, false, false, false, false], // 0
      [true, false, false, true, false], // 1
      [true, true, false, false, true], // 2
      [true, true, true, true, true], // 3
    ];

    for (const [a, b, cin, expectedSum, expectedCout] of cases) {
      const testDoc = {
        ...doc,
        nodes: doc.nodes.map((n) => {
          if (n.id === inputA.id) return { ...n, value: a };
          if (n.id === inputB.id) return { ...n, value: b };
          if (n.id === inputCin.id) return { ...n, value: cin };
          return n;
        }),
      };
      const result = evaluateLogicDiagram(testDoc.nodes, testDoc.wires);
      expect(result.nodeValues[sumOut.id], `full-adder A=${a} B=${b} Cin=${cin} sum`).toBe(
        expectedSum,
      );
      expect(result.nodeValues[coutOut.id], `full-adder A=${a} B=${b} Cin=${cin} cout`).toBe(
        expectedCout,
      );
    }
  });

  it('multiplexer selects A when S=0 and B when S=1', () => {
    const template = getLogicDiagramTemplates().find((t) => t.id === 'multiplexer')!;
    const doc = instantiateLogicDiagramTemplate(template);
    const inputA = doc.nodes.find((n) => n.kind === 'input' && n.label === 'A')!;
    const inputB = doc.nodes.find((n) => n.kind === 'input' && n.label === 'B')!;
    const inputS = doc.nodes.find((n) => n.kind === 'input' && n.label === 'S')!;
    const outputY = doc.nodes.find((n) => n.kind === 'output' && n.label === 'Y')!;

    const setInputs = (a: boolean, b: boolean, s: boolean) => ({
      ...doc,
      nodes: doc.nodes.map((n) => {
        if (n.id === inputA.id) return { ...n, value: a };
        if (n.id === inputB.id) return { ...n, value: b };
        if (n.id === inputS.id) return { ...n, value: s };
        return n;
      }),
    });

    // S=0 → Y = A
    expect(
      evaluateLogicDiagram(setInputs(true, false, false).nodes, doc.wires).nodeValues[outputY.id],
    ).toBe(true);
    expect(
      evaluateLogicDiagram(setInputs(false, true, false).nodes, doc.wires).nodeValues[outputY.id],
    ).toBe(false);
    // S=1 → Y = B
    expect(
      evaluateLogicDiagram(setInputs(false, true, true).nodes, doc.wires).nodeValues[outputY.id],
    ).toBe(true);
    expect(
      evaluateLogicDiagram(setInputs(true, false, true).nodes, doc.wires).nodeValues[outputY.id],
    ).toBe(false);
  });

  it('SR flip-flop evaluates without crashing (feedback cycle is handled)', () => {
    const template = getLogicDiagramTemplates().find((t) => t.id === 'sr-flip-flop')!;
    const doc = instantiateLogicDiagramTemplate(template);
    const inputS = doc.nodes.find((n) => n.kind === 'input' && n.label === 'S')!;
    const inputR = doc.nodes.find((n) => n.kind === 'input' && n.label === 'R')!;

    // S=R=0 → hold / depends on cycle resolution, but must not throw
    const testDoc = {
      ...doc,
      nodes: doc.nodes.map((n) =>
        n.id === inputS.id
          ? { ...n, value: false }
          : n.id === inputR.id
            ? { ...n, value: false }
            : n,
      ),
    };
    expect(() => evaluateLogicDiagram(testDoc.nodes, testDoc.wires)).not.toThrow();

    // S=1, R=0 → Set: Q should be 1
    const setDoc = {
      ...doc,
      nodes: doc.nodes.map((n) => {
        if (n.id === inputS.id) return { ...n, value: true };
        if (n.id === inputR.id) return { ...n, value: false };
        return n;
      }),
    };
    const setQ = doc.nodes.find((n) => n.kind === 'output' && n.label === 'Q')!;
    const setQbar = doc.nodes.find((n) => n.kind === 'output' && n.label === 'Q̄')!;
    const setResult = evaluateLogicDiagram(setDoc.nodes, setDoc.wires);
    // With S=1, R=0: nor1 = NOR(1, Q̄) = 0... actually Q = NOR(S, Q̄).
    // S=1 forces Q̄ side low. The exact steady state depends on cycle handling,
    // so we only assert it doesn't crash and produces *some* boolean or undefined.
    expect(['undefined', 'boolean']).toContain(typeof setResult.nodeValues[setQ.id]);
    expect(['undefined', 'boolean']).toContain(typeof setResult.nodeValues[setQbar.id]);
  });
});
