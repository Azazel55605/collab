import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import type { CircuitSweepResult, CircuitTransientResult } from '../../types/circuitRuntime';

import { CircuitSweepPlot, CircuitTransientPlot } from './CircuitSweepPlot';

const RESULT: CircuitSweepResult = {
  source: 'source',
  sampleCount: 3,
  outputs: [
    { kind: 'node-voltage', node: 'net1' },
    { kind: 'component-current', component: 'r1' },
  ],
  sourceMap: {
    terminals: [],
    wires: [],
    probes: [
      { probeId: 'voltage', label: 'Output voltage', kind: 'node-voltage', electricalNode: 'net1' },
      { probeId: 'current', label: 'Load current', kind: 'branch-current', component: 'r1' },
    ],
  },
  sourceValues: [0, 5, 10],
  traces: [
    { output: { kind: 'node-voltage', node: 'net1' }, values: [0, 2.5, 5] },
    { output: { kind: 'component-current', component: 'r1' }, values: [0, 0.0025, 0.005] },
  ],
};

describe('CircuitSweepPlot', () => {
  it('labels probe traces and toggles their rendered lines', () => {
    const { container } = render(<CircuitSweepPlot result={RESULT} sourceLabel="Supply" />);
    expect(screen.getByText('Output voltage')).toBeTruthy();
    expect(screen.getByText('Load current')).toBeTruthy();
    expect(container.querySelectorAll('polyline')).toHaveLength(2);

    fireEvent.click(screen.getByRole('checkbox', { name: /Load current/ }));
    expect(container.querySelectorAll('polyline')).toHaveLength(1);
  });

  it('synchronizes the cursor across traces and exposes bounded zoom controls', () => {
    const { container } = render(<CircuitSweepPlot result={RESULT} sourceLabel="Supply" />);
    const svg = screen.getByRole('img', { name: 'DC sweep plot' });
    Object.defineProperty(svg, 'getBoundingClientRect', {
      value: () => ({
        left: 0,
        top: 0,
        width: 760,
        height: 300,
        right: 760,
        bottom: 300,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      }),
    });

    fireEvent.pointerMove(svg, { clientX: 380, clientY: 140 });
    expect(screen.getByText('Supply: 5')).toBeTruthy();
    const readout = container.querySelector('.circuit-sweep-cursor-readout');
    expect(readout).not.toBeNull();
    expect(within(readout as HTMLElement).getByText('2.5 V')).toBeTruthy();
    expect(within(readout as HTMLElement).getByText('0.0025 A')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Zoom in sweep plot' }));
    expect(screen.getByText('2 / 3 samples')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Reset sweep plot view' }));
    expect(screen.getByText('3 / 3 samples')).toBeTruthy();
    expect(container.querySelector('.circuit-sweep-cursor-line')).toBeNull();
  });

  it('uses the shared interaction model for transient time traces', () => {
    const transient: CircuitTransientResult = {
      sampleCount: 3,
      outputs: RESULT.outputs,
      sourceMap: RESULT.sourceMap,
      timeSeconds: [0, 0.001, 0.002],
      traces: RESULT.traces,
    };
    render(<CircuitTransientPlot result={transient} />);
    expect(screen.getByRole('img', { name: 'Transient plot' })).toBeTruthy();
    expect(screen.getByText('Time (s)')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Zoom in transient plot' })).toBeTruthy();
  });
});
