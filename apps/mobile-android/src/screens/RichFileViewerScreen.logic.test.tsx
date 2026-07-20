import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { LogicDiagramDocument } from '../../../../src/types/logicDiagram';

const circuitMocks = vi.hoisted(() => ({
  start: vi.fn(),
  sweepStart: vi.fn(),
  transientStart: vi.fn(),
  status: vi.fn(),
  cancel: vi.fn(),
  take: vi.fn(),
  readSweep: vi.fn(),
  readTransient: vi.fn(),
  discard: vi.fn(),
}));

vi.mock('../mobileTauri', () => ({
  circuitStartDc: circuitMocks.start,
  circuitStartDcSweep: circuitMocks.sweepStart,
  circuitStartTransient: circuitMocks.transientStart,
  circuitJobStatus: circuitMocks.status,
  circuitCancelJob: circuitMocks.cancel,
  circuitTakeJobResult: circuitMocks.take,
  circuitReadSweepChunk: circuitMocks.readSweep,
  circuitReadTransientChunk: circuitMocks.readTransient,
  circuitDiscardJob: circuitMocks.discard,
}));

vi.mock('pdfjs-dist/legacy/build/pdf.mjs', () => ({
  GlobalWorkerOptions: {},
  getDocument: vi.fn(),
}));

import { LogicMobileViewer } from './RichFileViewerScreen';

class ResizeObserverMock {
  observe() {}
  disconnect() {}
}

Object.defineProperty(globalThis, 'ResizeObserver', {
  configurable: true,
  value: ResizeObserverMock,
});

const LOGIC: LogicDiagramDocument = {
  schemaVersion: 6,
  kind: 'logic-diagram',
  diagramMode: 'schematic',
  nodes: [
    {
      id: 'v1',
      kind: 'voltage-source',
      position: { x: 0, y: 0 },
      rotation: 90,
      electrical: { voltageVolts: 5 },
    },
    { id: 'ground', kind: 'ground', position: { x: 240, y: 0 } },
  ],
  wires: [{
    id: 'wire-1',
    source: 'v1',
    target: 'ground',
    sourceHandle: 'positive',
    targetHandle: 'terminal',
  }],
  viewport: { x: 0, y: 0, zoom: 1 },
};

const RESULT = {
  operatingPoint: {
    nodeVoltages: { 0: 0, net1: 5 },
    componentCurrents: { v1: -0.005 },
    componentPowers: { v1: -0.025 },
    diagnostics: [],
    iterations: 1,
  },
  sourceMap: {
    terminals: [
      { terminal: { nodeId: 'v1', handleId: 'terminal-a' }, electricalNode: 'net1' },
      { terminal: { nodeId: 'ground', handleId: 'terminal' }, electricalNode: '0' },
    ],
    wires: [{ wireId: 'wire-1', electricalNode: 'net1' }],
    probes: [],
  },
  probeValues: [],
};

describe('mobile schematic simulation', () => {
  beforeEach(() => {
    circuitMocks.start.mockResolvedValue('job-1');
    circuitMocks.sweepStart.mockResolvedValue('sweep-1');
    circuitMocks.transientStart.mockResolvedValue('transient-1');
    circuitMocks.status.mockResolvedValue({ phase: 'completed', stage: null, elapsedMillis: 2 });
    circuitMocks.cancel.mockResolvedValue('cancelling');
    circuitMocks.take.mockResolvedValue({ state: 'completed', result: RESULT });
    circuitMocks.readSweep.mockReset();
    circuitMocks.readTransient.mockReset();
    circuitMocks.discard.mockResolvedValue(undefined);
  });

  it('runs DC, renders the result sheet, and highlights solved wires', async () => {
    const { container } = render(
      <LogicMobileViewer
        logic={LOGIC}
        zoom={1}
        setZoom={vi.fn()}
        resetToken={0}
        onWheel={vi.fn()}
        schematicSymbolSet="ansi"
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Run DC simulation' }));

    expect(await screen.findByText('Converged in 1 iteration')).toBeTruthy();
    expect(screen.getByText('5 V')).toBeTruthy();
    expect(container.querySelector('[data-circuit-polarity="positive"]')).toBeTruthy();
    expect(circuitMocks.start).toHaveBeenCalledWith(LOGIC);
    expect(circuitMocks.take).toHaveBeenCalledWith('job-1');
  });

  it('runs a persisted sweep and renders the chunked trace viewer', async () => {
    const logic: LogicDiagramDocument = {
      ...LOGIC,
      simulation: {
        analysis: 'dc-sweep',
        probes: [{ id: 'output', kind: 'node-voltage', nodeId: 'v1', handleId: 'positive', label: 'Output' }],
        dcSweep: { sourceNodeId: 'v1', start: 0, stop: 5, sampleCount: 3 },
      },
    };
    circuitMocks.take.mockResolvedValue({
      state: 'sweep-completed',
      summary: {
        source: 'v1',
        sampleCount: 3,
        outputs: [{ kind: 'node-voltage', node: 'net1' }],
        sourceMap: {
          terminals: [],
          wires: [],
          probes: [{ probeId: 'output', label: 'Output', kind: 'node-voltage', electricalNode: 'net1' }],
        },
      },
    });
    circuitMocks.readSweep.mockResolvedValue({
      offset: 0,
      sourceValues: [0, 2.5, 5],
      traces: [{ output: { kind: 'node-voltage', node: 'net1' }, values: [0, 2.5, 5] }],
      done: true,
    });

    render(
      <LogicMobileViewer
        logic={logic}
        zoom={1}
        setZoom={vi.fn()}
        resetToken={0}
        onWheel={vi.fn()}
        schematicSymbolSet="ansi"
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Run DC sweep' }));

    expect(await screen.findByRole('img', { name: 'DC sweep plot' })).toBeTruthy();
    expect(screen.getByText('3 samples · 1 trace')).toBeTruthy();
    expect(screen.getByText('Output')).toBeTruthy();
    expect(circuitMocks.sweepStart).toHaveBeenCalledWith(logic);
    expect(circuitMocks.readSweep).toHaveBeenCalledWith('sweep-1', 0, 512);
    expect(circuitMocks.discard).toHaveBeenCalledWith('sweep-1');
  });

  it('runs persisted transient analysis and renders the touch trace viewer', async () => {
    const logic: LogicDiagramDocument = {
      ...LOGIC,
      simulation: {
        analysis: 'transient',
        probes: [{ id: 'output', kind: 'node-voltage', nodeId: 'v1', handleId: 'positive', label: 'Output' }],
        transient: {
          durationSeconds: 0.002,
          maxTimeStepSeconds: 0.001,
          sourceWaveforms: { v1: { kind: 'pulse', lowValue: 0, highValue: 5, delaySeconds: 0.001, riseSeconds: 0, fallSeconds: 0, pulseWidthSeconds: 0.005, periodSeconds: 0.01 } },
        },
      },
    };
    circuitMocks.take.mockResolvedValue({
      state: 'transient-completed',
      summary: {
        sampleCount: 3,
        outputs: [{ kind: 'node-voltage', node: 'net1' }],
        sourceMap: {
          terminals: [],
          wires: [],
          probes: [{ probeId: 'output', label: 'Output', kind: 'node-voltage', electricalNode: 'net1' }],
        },
      },
    });
    circuitMocks.readTransient.mockResolvedValue({
      offset: 0,
      timeSeconds: [0, 0.001, 0.002],
      traces: [{ output: { kind: 'node-voltage', node: 'net1' }, values: [0, 2.5, 3.75] }],
      done: true,
    });

    render(
      <LogicMobileViewer
        logic={logic}
        zoom={1}
        setZoom={vi.fn()}
        resetToken={0}
        onWheel={vi.fn()}
        schematicSymbolSet="ansi"
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Run transient analysis' }));

    expect(await screen.findByRole('img', { name: 'Transient plot' })).toBeTruthy();
    expect(screen.getByText('3 samples · 1 trace')).toBeTruthy();
    expect(circuitMocks.transientStart).toHaveBeenCalledWith(logic);
    expect(circuitMocks.readTransient).toHaveBeenCalledWith('transient-1', 0, 512);
    expect(circuitMocks.discard).toHaveBeenCalledWith('transient-1');
  });

  it('routes schematic wires from the actual rotated terminal sides', () => {
    const { container } = render(
      <LogicMobileViewer
        logic={LOGIC}
        zoom={1}
        setZoom={vi.fn()}
        resetToken={0}
        onWheel={vi.fn()}
        schematicSymbolSet="ansi"
      />,
    );

    const wire = container.querySelector('[data-logic-wire-id="wire-1"]');
    const path = wire?.getAttribute('d') ?? '';
    expect(path).toMatch(/^M40 120L 40,/);
    expect(path).toMatch(/L240 36$/);
  });

  it('keeps the cancel control active until the native job acknowledges cancellation', async () => {
    circuitMocks.status.mockImplementation(async () => (
      circuitMocks.cancel.mock.calls.length > 0
        ? { phase: 'cancelled', stage: null, elapsedMillis: 4 }
        : { phase: 'running', stage: 'solving', elapsedMillis: 2 }
    ));
    circuitMocks.take.mockResolvedValue({ state: 'cancelled' });

    render(
      <LogicMobileViewer
        logic={LOGIC}
        zoom={1}
        setZoom={vi.fn()}
        resetToken={0}
        onWheel={vi.fn()}
        schematicSymbolSet="ansi"
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Run DC simulation' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel DC simulation' }));

    await waitFor(() => expect(circuitMocks.cancel).toHaveBeenCalledWith('job-1'));
    expect(await screen.findByRole('button', { name: 'Run DC simulation' })).toBeTruthy();
    expect(screen.queryByText('Simulation failed')).toBeNull();
  });
});
