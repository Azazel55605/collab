import React from 'react';

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useDocumentStatusStore } from '../store/documentStatusStore';
import { useEditorStore } from '../store/editorStore';
import { useUiStore } from '../store/uiStore';
import { useVaultStore } from '../store/vaultStore';

import LogicDiagramView from './LogicDiagramView';

const logicEvents = vi.hoisted(() => ({
  fileModifiedHandler: null as
    null | ((event: { payload: { path: string } }) => void | Promise<void>),
}));

const tauriMocks = vi.hoisted(() => ({
  readNote: vi.fn(),
  writeNote: vi.fn(),
  createNote: vi.fn(),
  createFolder: vi.fn(),
  hostedVaultRequest: vi.fn(),
  listLogicComponents: vi.fn(),
  saveLogicComponent: vi.fn(),
  deleteLogicComponent: vi.fn(),
  replicaReadLogicComponents: vi.fn(),
  replicaWriteLogicComponents: vi.fn(),
  circuitSolveDc: vi.fn(),
  circuitStartDc: vi.fn(),
  circuitStartDcSweep: vi.fn(),
  circuitStartTransient: vi.fn(),
  circuitJobStatus: vi.fn(),
  circuitCancelJob: vi.fn(),
  circuitTakeJobResult: vi.fn(),
  circuitReadSweepChunk: vi.fn(),
  circuitReadTransientChunk: vi.fn(),
  circuitDiscardJob: vi.fn(),
  showDownloadDialog: vi.fn(),
  writeDownloadedFile: vi.fn(),
}));

const liveJsonMocks = vi.hoisted(() => ({
  useLiveJsonDocumentSession: vi.fn(() => null),
  writeJson: vi.fn(),
}));

const flowMocks = vi.hoisted(() => ({
  getSmoothStepPath: vi.fn(() => ['', 0, 0]),
}));

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(
    async (
      eventName: string,
      handler: (event: { payload: { path: string } }) => void | Promise<void>,
    ) => {
      if (eventName === 'vault:file-modified') logicEvents.fileModifiedHandler = handler;
      return () => {
        if (eventName === 'vault:file-modified') logicEvents.fileModifiedHandler = null;
      };
    },
  ),
}));

vi.mock('../lib/tauri', () => ({
  tauriCommands: {
    readNote: tauriMocks.readNote,
    writeNote: tauriMocks.writeNote,
    createNote: tauriMocks.createNote,
    createFolder: tauriMocks.createFolder,
    hostedVaultRequest: tauriMocks.hostedVaultRequest,
    listLogicComponents: tauriMocks.listLogicComponents,
    saveLogicComponent: tauriMocks.saveLogicComponent,
    deleteLogicComponent: tauriMocks.deleteLogicComponent,
    replicaReadLogicComponents: tauriMocks.replicaReadLogicComponents,
    replicaWriteLogicComponents: tauriMocks.replicaWriteLogicComponents,
    circuitSolveDc: tauriMocks.circuitSolveDc,
    circuitStartDc: tauriMocks.circuitStartDc,
    circuitStartDcSweep: tauriMocks.circuitStartDcSweep,
    circuitStartTransient: tauriMocks.circuitStartTransient,
    circuitJobStatus: tauriMocks.circuitJobStatus,
    circuitCancelJob: tauriMocks.circuitCancelJob,
    circuitTakeJobResult: tauriMocks.circuitTakeJobResult,
    circuitReadSweepChunk: tauriMocks.circuitReadSweepChunk,
    circuitReadTransientChunk: tauriMocks.circuitReadTransientChunk,
    circuitDiscardJob: tauriMocks.circuitDiscardJob,
    showDownloadDialog: tauriMocks.showDownloadDialog,
    writeDownloadedFile: tauriMocks.writeDownloadedFile,
  },
}));

vi.mock('../lib/vaultReplica', () => ({
  emitReplicaMutated: vi.fn(),
  enqueuePendingOperation: vi.fn(),
  isLikelyConnectivityError: vi.fn(() => false),
  onReplicaMutated: vi.fn(() => () => {}),
  readCachedLogicComponents: vi.fn(async () => []),
  replicaMutationAffectsPath: vi.fn(() => true),
  readCachedReplicaManifest: vi.fn(async () => null),
  syncReplicaManifestDelta: vi.fn(async () => null),
  writeCachedLogicComponents: vi.fn(async () => {}),
  writeOptimisticReplicaManifest: vi.fn(),
}));

vi.mock('../lib/liveJsonDocument', () => ({
  useLiveJsonDocumentSession: liveJsonMocks.useLiveJsonDocumentSession,
}));

vi.mock('sonner', () => ({
  toast: { error: vi.fn(), success: vi.fn(), message: vi.fn(), info: vi.fn() },
}));

vi.mock('@xyflow/react', async () => {
  const react = await import('react');
  // Stable API object, mirroring real ReactFlow (whose useReactFlow return is
  // referentially stable across renders).
  const reactFlowApi = {
    getViewport: () => ({ x: 0, y: 0, zoom: 1 }),
    screenToFlowPosition: ({ x, y }: { x: number; y: number }) => ({ x, y }),
    fitView: vi.fn(async () => {}),
    setViewport: vi.fn(async () => {}),
  };
  return {
    ReactFlowProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
    ReactFlow: ({ children }: { children: React.ReactNode } & Record<string, unknown>) => (
      <div data-testid="react-flow">{children}</div>
    ),
    Background: () => null,
    BaseEdge: () => null,
    Handle: () => null,
    Position: { Left: 'left', Right: 'right' },
    ConnectionMode: { Loose: 'loose' },
    BackgroundVariant: { Dots: 'dots' },
    getSmoothStepPath: flowMocks.getSmoothStepPath,
    addEdge: vi.fn((edge, edges) => [...edges, edge]),
    useNodesState: (initial: unknown[]) => {
      const [nodes, setNodes] = react.useState(initial);
      return [nodes, setNodes, vi.fn()] as const;
    },
    useEdgesState: (initial: unknown[]) => {
      const [edges, setEdges] = react.useState(initial);
      return [edges, setEdges, vi.fn()] as const;
    },
    useReactFlow: () => reactFlowApi,
  };
});

const PATH = 'Diagrams/test.logic';

function logicDoc(kinds: string[]) {
  return JSON.stringify({
    schemaVersion: 1,
    kind: 'logic-diagram',
    title: 'test',
    nodes: kinds.map((kind, i) => ({ id: `g${i}`, kind, position: { x: i * 120, y: 0 } })),
    wires: [],
    viewport: { x: 0, y: 0, zoom: 1 },
  });
}

function schematicDoc(kinds: string[]) {
  return JSON.stringify({
    schemaVersion: 4,
    kind: 'logic-diagram',
    diagramMode: 'schematic',
    title: 'test',
    nodes: kinds.map((kind, i) => ({ id: `s${i}`, kind, position: { x: i * 144, y: 0 } })),
    wires: [],
    viewport: { x: 0, y: 0, zoom: 1 },
  });
}

function seedVault() {
  useVaultStore.setState({
    vault: { id: 'v1', path: '/vault', name: 'Vault', isEncrypted: false, lastOpened: Date.now() },
    fileTree: [],
    refreshFileTree: vi.fn(async () => {}),
  } as never);
  useEditorStore.setState({
    sessionVaultPath: '/vault',
    openTabs: [
      { relativePath: PATH, title: 'test', isDirty: false, savedHash: null, type: 'logic' },
    ],
    activeTabPath: PATH,
    forceReloadPath: null,
  } as never);
}

describe('LogicDiagramView safe reload policy', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    liveJsonMocks.useLiveJsonDocumentSession.mockReturnValue(null);
    logicEvents.fileModifiedHandler = null;
    seedVault();
    tauriMocks.writeNote.mockResolvedValue({ hash: 'v-write' });
    tauriMocks.createNote.mockResolvedValue({
      relativePath: 'Pictures/test.svg',
      name: 'test.svg',
      isFolder: false,
      extension: 'svg',
    });
    tauriMocks.createFolder.mockResolvedValue(undefined);
    tauriMocks.hostedVaultRequest.mockReset();
    tauriMocks.listLogicComponents.mockResolvedValue([]);
    tauriMocks.saveLogicComponent.mockImplementation(async (_vaultPath, component) => component);
    tauriMocks.deleteLogicComponent.mockResolvedValue(undefined);
    tauriMocks.replicaReadLogicComponents.mockResolvedValue([]);
    tauriMocks.replicaWriteLogicComponents.mockResolvedValue(undefined);
    tauriMocks.circuitSolveDc.mockReset();
    tauriMocks.circuitStartDc.mockResolvedValue('circuit-job-1');
    tauriMocks.circuitStartDcSweep.mockResolvedValue('sweep-job-1');
    tauriMocks.circuitStartTransient.mockResolvedValue('transient-job-1');
    tauriMocks.circuitJobStatus.mockResolvedValue({
      phase: 'completed',
      stage: null,
      elapsedMillis: 1,
    });
    tauriMocks.circuitCancelJob.mockResolvedValue('cancelling');
    tauriMocks.circuitTakeJobResult.mockImplementation(async () => {
      try {
        return { state: 'completed', result: await tauriMocks.circuitSolveDc() };
      } catch (error) {
        return { state: 'failed', error };
      }
    });
    tauriMocks.circuitReadSweepChunk.mockReset();
    tauriMocks.circuitReadTransientChunk.mockReset();
    tauriMocks.circuitDiscardJob.mockResolvedValue(undefined);
    tauriMocks.showDownloadDialog.mockResolvedValue(null);
    tauriMocks.writeDownloadedFile.mockResolvedValue(undefined);
    useUiStore.setState({ schematicSymbolSet: 'ansi' });
  });

  afterEach(() => {
    cleanup();
    useDocumentStatusStore.setState({ statuses: {} });
  });

  it('auto-applies a clean external change from a watcher event', async () => {
    tauriMocks.readNote
      .mockResolvedValueOnce({ content: logicDoc([]), hash: 'v1', modifiedAt: 1 })
      .mockResolvedValueOnce({ content: logicDoc(['and']), hash: 'v2', modifiedAt: 2 });

    render(<LogicDiagramView relativePath={PATH} />);
    expect(await screen.findByText(/0 gates/)).toBeTruthy();

    await act(async () => {
      await logicEvents.fileModifiedHandler?.({ payload: { path: PATH } });
    });

    await waitFor(() => expect(screen.getByText(/1 gates/)).toBeTruthy());
  });

  it('preserves an unsaved local edit and queues the remote change while dirty', async () => {
    tauriMocks.readNote
      .mockResolvedValueOnce({ content: logicDoc([]), hash: 'v1', modifiedAt: 1 })
      .mockResolvedValue({ content: logicDoc(['and', 'or']), hash: 'v2', modifiedAt: 2 });

    render(<LogicDiagramView relativePath={PATH} />);
    expect(await screen.findByText(/0 gates/)).toBeTruthy();

    // Add a gate → the document is now dirty locally.
    fireEvent.click(screen.getByRole('button', { name: /add/i }));
    await waitFor(() => expect(screen.getByText(/1 gates/)).toBeTruthy());

    // A remote change (2 gates) arrives while dirty: it must be queued, not applied.
    await act(async () => {
      await logicEvents.fileModifiedHandler?.({ payload: { path: PATH } });
    });

    // Local single-gate edit is preserved; the remote 2-gate state is not applied.
    expect(screen.getByText(/1 gates/)).toBeTruthy();
    await waitFor(() => {
      expect(useDocumentStatusStore.getState().statuses[PATH]?.status).toBe('remote-pending');
    });
  });

  it('ignores a stale watcher event whose version matches the loaded version', async () => {
    tauriMocks.readNote
      .mockResolvedValueOnce({ content: logicDoc([]), hash: 'v1', modifiedAt: 1 })
      // Same version token as the loaded doc → stale, must be ignored even though
      // the content differs.
      .mockResolvedValueOnce({ content: logicDoc(['and']), hash: 'v1', modifiedAt: 2 });

    render(<LogicDiagramView relativePath={PATH} />);
    expect(await screen.findByText(/0 gates/)).toBeTruthy();

    await act(async () => {
      await logicEvents.fileModifiedHandler?.({ payload: { path: PATH } });
    });

    expect(screen.getByText(/0 gates/)).toBeTruthy();
  });

  it('writes local structural edits to the live JSON session instead of REST autosave', async () => {
    tauriMocks.readNote.mockResolvedValueOnce({ content: logicDoc([]), hash: 'v1', modifiedAt: 1 });
    liveJsonMocks.useLiveJsonDocumentSession.mockReturnValue({
      writeJson: liveJsonMocks.writeJson,
      awareness: {
        clientID: 1,
        getStates: () => new Map(),
        on: vi.fn(),
        off: vi.fn(),
        setLocalStateField: vi.fn(),
      },
      getStatus: () => 'connected',
      onStatus: vi.fn(() => () => {}),
      discardOfflineState: vi.fn(),
      destroy: vi.fn(),
    } as never);

    render(<LogicDiagramView relativePath={PATH} />);
    expect(await screen.findByText(/0 gates/)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /add/i }));

    await waitFor(() => expect(liveJsonMocks.writeJson).toHaveBeenCalled());
    expect(tauriMocks.writeNote).not.toHaveBeenCalled();
  });

  it('toggles an input node on the second pointer down of a double click', async () => {
    tauriMocks.readNote.mockResolvedValueOnce({
      content: logicDoc(['input']),
      hash: 'logic-v1',
      modifiedAt: 1,
    });

    render(<LogicDiagramView relativePath={PATH} />);
    expect(await screen.findByText(/1 gates/)).toBeTruthy();

    const inputNode = screen
      .getAllByText('Input')
      .map((element) => element.closest('[data-logic-node]'))
      .find((element): element is HTMLElement => element instanceof HTMLElement);

    if (!inputNode) throw new Error('Expected rendered input node.');
    const inputNodeSurface = inputNode.firstElementChild;
    if (!(inputNodeSurface instanceof HTMLElement))
      throw new Error('Expected rendered input node surface.');
    expect(inputNode.textContent).toContain('unset');
    fireEvent.mouseDown(inputNodeSurface, { button: 0, detail: 2 });

    await waitFor(() => expect(inputNode.textContent).toContain('1'));
  });

  it('renders electronic schematics as static symbols', async () => {
    tauriMocks.readNote.mockResolvedValueOnce({
      content: schematicDoc(['voltage-source', 'resistor', 'ground']),
      hash: 'schematic-v1',
      modifiedAt: 1,
    });

    render(<LogicDiagramView relativePath={PATH} />);

    expect(await screen.findByText(/3 symbols/)).toBeTruthy();
    expect(screen.getByText('Voltage source')).toBeTruthy();
    expect(screen.getAllByText('Resistor').length).toBeGreaterThan(0);
    expect(screen.queryByText(/unset/)).toBeNull();
  });

  it('renders schematic symbols with the selected IEC/DIN notation', async () => {
    useUiStore.setState({ schematicSymbolSet: 'iec' });
    tauriMocks.readNote.mockResolvedValueOnce({
      content: schematicDoc(['resistor', 'transistor']),
      hash: 'schematic-v1',
      modifiedAt: 1,
    });

    const { container } = render(<LogicDiagramView relativePath={PATH} />);
    expect(await screen.findByText(/2 symbols/)).toBeTruthy();
    expect(container.innerHTML).toContain('H76V44');
    expect(container.innerHTML).toContain('M46 42L78 48');
  });

  it('edits and displays persisted schematic electrical values', async () => {
    tauriMocks.readNote.mockResolvedValueOnce({
      content: JSON.stringify({
        schemaVersion: 6,
        kind: 'logic-diagram',
        diagramMode: 'schematic',
        nodes: [
          {
            id: 'r1',
            kind: 'resistor',
            label: 'Load',
            position: { x: 0, y: 0 },
            electrical: { resistanceOhms: 1000 },
          },
        ],
        wires: [],
        viewport: { x: 0, y: 0, zoom: 1 },
      }),
      hash: 'v1',
      modifiedAt: 1,
    });

    render(<LogicDiagramView relativePath={PATH} />);
    expect(await screen.findByText('Load')).toBeTruthy();
    expect(screen.getByText(/1 kΩ/)).toBeTruthy();

    const node = screen.getByText('Load').closest('[data-logic-node]');
    if (!(node?.firstElementChild instanceof HTMLElement))
      throw new Error('Expected resistor surface.');
    fireEvent.doubleClick(node.firstElementChild);

    expect(await screen.findByRole('heading', { name: 'Load settings' })).toBeTruthy();
    const resistance = screen.getByLabelText(/Resistance/);
    fireEvent.change(resistance, { target: { value: '2200' } });
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));

    expect(await screen.findByText(/2.2 kΩ/)).toBeTruthy();
  });

  it('runs DC simulation, renders results, and energizes mapped live wires', async () => {
    tauriMocks.readNote.mockResolvedValueOnce({
      content: JSON.stringify({
        schemaVersion: 6,
        kind: 'logic-diagram',
        diagramMode: 'schematic',
        nodes: [
          {
            id: 'source',
            kind: 'voltage-source',
            label: 'Supply',
            position: { x: 0, y: 0 },
            electrical: { voltageVolts: 5 },
          },
          {
            id: 'r1',
            kind: 'resistor',
            label: 'Load',
            position: { x: 200, y: 0 },
            electrical: { resistanceOhms: 1000 },
          },
          { id: 'ground', kind: 'ground', position: { x: 400, y: 0 } },
        ],
        wires: [
          {
            id: 'hot',
            source: 'source',
            sourceHandle: 'positive',
            target: 'r1',
            targetHandle: 'terminal-a',
          },
          {
            id: 'return',
            source: 'r1',
            sourceHandle: 'terminal-b',
            target: 'ground',
            targetHandle: 'terminal',
          },
          {
            id: 'reference',
            source: 'source',
            sourceHandle: 'negative',
            target: 'ground',
            targetHandle: 'terminal',
          },
        ],
        viewport: { x: 0, y: 0, zoom: 1 },
      }),
      hash: 'v1',
      modifiedAt: 1,
    });
    tauriMocks.circuitSolveDc.mockResolvedValueOnce({
      operatingPoint: {
        nodeVoltages: { 0: 0, hotNet: 5 },
        componentCurrents: { source: -0.005, r1: 0.005 },
        componentPowers: { source: -0.025, r1: 0.025 },
        diagnostics: [],
        iterations: 1,
      },
      sourceMap: {
        terminals: [
          { terminal: { nodeId: 'source', handleId: 'positive' }, electricalNode: 'hotNet' },
          { terminal: { nodeId: 'ground', handleId: 'terminal' }, electricalNode: '0' },
        ],
        wires: [
          { wireId: 'hot', electricalNode: 'hotNet' },
          { wireId: 'return', electricalNode: '0' },
          { wireId: 'reference', electricalNode: '0' },
        ],
        probes: [],
      },
      probeValues: [
        {
          kind: 'branch-current',
          probeId: 'current-result',
          label: 'Measured load current',
          valueAmps: 0.005,
        },
      ],
    });

    const { container } = render(<LogicDiagramView relativePath={PATH} />);
    expect(await screen.findByText(/3 symbols/)).toBeTruthy();
    const loadHandle = screen.getByRole('button', { name: /Load terminal terminal-a/i });
    const loadNode = loadHandle.closest('[data-logic-node]');
    if (!(loadNode?.firstElementChild instanceof HTMLElement))
      throw new Error('Expected load surface.');
    fireEvent.contextMenu(loadNode.firstElementChild);
    fireEvent.click(screen.getByRole('button', { name: 'Probe branch current' }));

    const hotEdge = container.querySelector('[data-logic-edge]');
    if (!hotEdge) throw new Error('Expected schematic wire.');
    fireEvent.contextMenu(hotEdge);
    fireEvent.click(screen.getByRole('button', { name: 'Probe wire voltage' }));
    fireEvent.click(screen.getByRole('button', { name: 'Run DC' }));

    expect(await screen.findByText('Node voltages')).toBeTruthy();
    expect(screen.getByText('Converged in 1 iteration')).toBeTruthy();
    expect(screen.getByText('5 V')).toBeTruthy();
    expect(screen.getAllByText(/5 mA/).length).toBeGreaterThan(0);
    expect(screen.getByText('Component power')).toBeTruthy();
    expect(screen.getAllByText('25 mW')).toHaveLength(2);
    expect(screen.getByText('supplied')).toBeTruthy();
    expect(screen.getByText('absorbed')).toBeTruthy();
    expect(screen.getByText('reverse')).toBeTruthy();
    expect(screen.getByText('forward')).toBeTruthy();
    expect(screen.getByText('Probes')).toBeTruthy();
    expect(screen.getByText('Measured load current')).toBeTruthy();
    expect(container.querySelectorAll('[data-schematic-live="true"]')).toHaveLength(1);
    expect(container.querySelector('[data-schematic-polarity="positive"]')).toBeTruthy();
    expect(tauriMocks.circuitStartDc).toHaveBeenCalledWith(
      expect.objectContaining({
        schemaVersion: 6,
        simulation: expect.objectContaining({
          analysis: 'dc-operating-point',
          probes: expect.arrayContaining([
            expect.objectContaining({ kind: 'branch-current', nodeId: 'r1' }),
            expect.objectContaining({
              kind: 'node-voltage',
              nodeId: 'source',
              handleId: 'positive',
            }),
          ]),
        }),
      }),
    );

    fireEvent.doubleClick(loadNode.firstElementChild);
    fireEvent.change(await screen.findByLabelText(/Resistance/), { target: { value: '2000' } });
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));

    expect(await screen.findByText(/Results are stale/)).toBeTruthy();
    expect(container.querySelectorAll('[data-schematic-live="true"]')).toHaveLength(0);
  });

  it('persists a bounded sweep configuration and renders chunked probe traces', async () => {
    tauriMocks.readNote.mockResolvedValueOnce({
      content: JSON.stringify({
        schemaVersion: 6,
        kind: 'logic-diagram',
        diagramMode: 'schematic',
        nodes: [
          {
            id: 'source',
            kind: 'voltage-source',
            label: 'Supply',
            position: { x: 0, y: 0 },
            electrical: { voltageVolts: 5 },
          },
          { id: 'ground', kind: 'ground', position: { x: 240, y: 0 } },
        ],
        wires: [],
        simulation: {
          analysis: 'dc-operating-point',
          probes: [
            {
              id: 'output',
              kind: 'node-voltage',
              nodeId: 'source',
              handleId: 'positive',
              label: 'Output',
            },
          ],
        },
        viewport: { x: 0, y: 0, zoom: 1 },
      }),
      hash: 'v1',
      modifiedAt: 1,
    });
    tauriMocks.circuitTakeJobResult.mockResolvedValue({
      state: 'sweep-completed',
      summary: {
        source: 'source',
        sampleCount: 3,
        outputs: [{ kind: 'node-voltage', node: 'net1' }],
        sourceMap: {
          terminals: [],
          wires: [],
          probes: [
            { probeId: 'output', label: 'Output', kind: 'node-voltage', electricalNode: 'net1' },
          ],
        },
      },
    });
    tauriMocks.circuitReadSweepChunk.mockResolvedValue({
      offset: 0,
      sourceValues: [0, 5, 10],
      traces: [{ output: { kind: 'node-voltage', node: 'net1' }, values: [0, 2.5, 5] }],
      done: true,
    });

    render(<LogicDiagramView relativePath={PATH} />);
    expect(await screen.findByText(/2 symbols/)).toBeTruthy();
    fireEvent.click(screen.getByTitle('Configure DC sweep'));
    fireEvent.change(screen.getByLabelText('Stop (V)'), { target: { value: '10' } });
    fireEvent.change(screen.getByLabelText('Samples'), { target: { value: '3' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save sweep' }));
    fireEvent.click(screen.getByRole('button', { name: 'Run sweep' }));

    expect(await screen.findByRole('img', { name: 'DC sweep plot' })).toBeTruthy();
    expect(screen.getByText('3 samples')).toBeTruthy();
    expect(screen.getByText('Output')).toBeTruthy();
    expect(tauriMocks.circuitStartDcSweep).toHaveBeenCalledWith(
      expect.objectContaining({
        simulation: {
          analysis: 'dc-sweep',
          probes: [expect.objectContaining({ id: 'output' })],
          dcSweep: { sourceNodeId: 'source', start: 0, stop: 10, sampleCount: 3 },
        },
      }),
    );
    expect(tauriMocks.circuitReadSweepChunk).toHaveBeenCalledWith('sweep-job-1', 0, 512);
    expect(tauriMocks.circuitDiscardJob).toHaveBeenCalledWith('sweep-job-1');

    tauriMocks.showDownloadDialog.mockResolvedValue('/tmp/test-dc-sweep.csv');
    fireEvent.click(screen.getByTitle('Export sweep data as CSV'));
    await waitFor(() =>
      expect(tauriMocks.writeDownloadedFile).toHaveBeenCalledWith(
        '/tmp/test-dc-sweep.csv',
        expect.any(String),
      ),
    );
    const exported = atob(tauriMocks.writeDownloadedFile.mock.calls[0][1]);
    expect(exported).toContain('Supply (source value),Output (V)');
    expect(exported).toContain('5,2.5');
  });

  it('persists pulse settings and renders chunked transient traces', async () => {
    tauriMocks.readNote.mockResolvedValueOnce({
      content: JSON.stringify({
        schemaVersion: 6,
        kind: 'logic-diagram',
        diagramMode: 'schematic',
        nodes: [
          {
            id: 'source',
            kind: 'voltage-source',
            label: 'Supply',
            position: { x: 0, y: 0 },
            electrical: { voltageVolts: 0 },
          },
          { id: 'ground', kind: 'ground', position: { x: 240, y: 0 } },
        ],
        wires: [],
        simulation: {
          analysis: 'dc-operating-point',
          probes: [
            {
              id: 'output',
              kind: 'node-voltage',
              nodeId: 'source',
              handleId: 'positive',
              label: 'Output',
            },
          ],
        },
        viewport: { x: 0, y: 0, zoom: 1 },
      }),
      hash: 'v1',
      modifiedAt: 1,
    });
    tauriMocks.circuitTakeJobResult.mockResolvedValue({
      state: 'transient-completed',
      summary: {
        sampleCount: 3,
        outputs: [{ kind: 'node-voltage', node: 'net1' }],
        sourceMap: {
          terminals: [],
          wires: [],
          probes: [
            { probeId: 'output', label: 'Output', kind: 'node-voltage', electricalNode: 'net1' },
          ],
        },
      },
    });
    tauriMocks.circuitReadTransientChunk.mockResolvedValue({
      offset: 0,
      timeSeconds: [0, 0.001, 0.002],
      traces: [{ output: { kind: 'node-voltage', node: 'net1' }, values: [0, 2.5, 3.75] }],
      done: true,
    });

    render(<LogicDiagramView relativePath={PATH} />);
    expect(await screen.findByText(/2 symbols/)).toBeTruthy();
    fireEvent.click(screen.getByTitle('Configure transient analysis'));
    fireEvent.change(screen.getByLabelText('Duration (s)'), { target: { value: '0.002' } });
    fireEvent.change(screen.getByLabelText('Maximum timestep (s)'), { target: { value: '0.001' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save transient' }));
    fireEvent.click(screen.getByRole('button', { name: 'Transient' }));

    expect(await screen.findByRole('img', { name: 'Transient plot' })).toBeTruthy();
    expect(screen.getByText('3 samples')).toBeTruthy();
    expect(tauriMocks.circuitStartTransient).toHaveBeenCalledWith(
      expect.objectContaining({
        simulation: expect.objectContaining({
          analysis: 'transient',
          transient: expect.objectContaining({
            durationSeconds: 0.002,
            maxTimeStepSeconds: 0.001,
            sourceWaveforms: expect.objectContaining({
              source: expect.objectContaining({ kind: 'pulse' }),
            }),
          }),
        }),
      }),
    );
    expect(tauriMocks.circuitReadTransientChunk).toHaveBeenCalledWith('transient-job-1', 0, 512);
    expect(tauriMocks.circuitDiscardJob).toHaveBeenCalledWith('transient-job-1');
  });

  it('splits a schematic wire through an explicit junction', async () => {
    tauriMocks.readNote.mockResolvedValueOnce({
      content: JSON.stringify({
        schemaVersion: 6,
        kind: 'logic-diagram',
        diagramMode: 'schematic',
        nodes: [
          {
            id: 'source',
            kind: 'voltage-source',
            position: { x: 0, y: 0 },
            electrical: { voltageVolts: 5 },
          },
          {
            id: 'r1',
            kind: 'resistor',
            position: { x: 240, y: 0 },
            electrical: { resistanceOhms: 1000 },
          },
          { id: 'ground', kind: 'ground', position: { x: 480, y: 0 } },
        ],
        wires: [
          {
            id: 'hot',
            source: 'source',
            sourceHandle: 'positive',
            target: 'r1',
            targetHandle: 'terminal-a',
            label: 'supply',
          },
          {
            id: 'return',
            source: 'r1',
            sourceHandle: 'terminal-b',
            target: 'ground',
            targetHandle: 'terminal',
          },
          {
            id: 'reference',
            source: 'source',
            sourceHandle: 'negative',
            target: 'ground',
            targetHandle: 'terminal',
          },
        ],
        viewport: { x: 0, y: 0, zoom: 1 },
      }),
      hash: 'v1',
      modifiedAt: 1,
    });
    tauriMocks.circuitSolveDc.mockResolvedValueOnce({
      operatingPoint: {
        nodeVoltages: { 0: 0 },
        componentCurrents: {},
        componentPowers: {},
        diagnostics: [],
        iterations: 1,
      },
      sourceMap: { terminals: [], wires: [], probes: [] },
      probeValues: [],
    });

    const { container } = render(<LogicDiagramView relativePath={PATH} />);
    expect(await screen.findByText(/3 symbols/)).toBeTruthy();
    const hotEdge = container.querySelector('[data-logic-edge]');
    if (!hotEdge) throw new Error('Expected schematic wire.');
    Object.defineProperties(hotEdge, {
      getTotalLength: { value: () => 120 },
      getPointAtLength: { value: (length: number) => ({ x: 120 + length, y: 40 }) },
    });

    fireEvent.contextMenu(hotEdge, { clientX: 180, clientY: 56 });
    fireEvent.click(screen.getByRole('button', { name: 'Insert junction' }));
    expect(await screen.findByText(/4 symbols/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Run DC' }));

    await waitFor(() => expect(tauriMocks.circuitStartDc).toHaveBeenCalledOnce());
    const solvedDocument = tauriMocks.circuitStartDc.mock.calls[0][0];
    const junction = solvedDocument.nodes.find(
      (node: { kind: string }) => node.kind === 'junction',
    );
    expect(junction).toMatchObject({
      kind: 'junction',
      position: { x: 168, y: 28 },
      electrical: undefined,
    });
    expect(flowMocks.getSmoothStepPath).toHaveBeenCalledWith(
      expect.objectContaining({
        targetX: 180,
        targetY: 40,
        targetPosition: 'left',
      }),
    );
    expect(flowMocks.getSmoothStepPath).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceX: 180,
        sourceY: 40,
        sourcePosition: 'right',
      }),
    );
    expect(solvedDocument.wires).toHaveLength(4);
    expect(solvedDocument.wires).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'hot',
          source: 'source',
          target: junction.id,
          targetHandle: 'terminal',
          label: 'supply',
        }),
        expect.objectContaining({
          source: junction.id,
          sourceHandle: 'terminal',
          target: 'r1',
          targetHandle: 'terminal-a',
        }),
      ]),
    );
  });

  it('shows signed wire polarity and NPN operating-region diagnostics', async () => {
    tauriMocks.readNote.mockResolvedValueOnce({
      content: JSON.stringify({
        schemaVersion: 6,
        kind: 'logic-diagram',
        diagramMode: 'schematic',
        nodes: [
          { id: 'q1', kind: 'transistor', label: 'Q1', position: { x: 0, y: 0 } },
          { id: 'ground', kind: 'ground', position: { x: 240, y: 0 } },
        ],
        wires: [
          {
            id: 'collector-wire',
            source: 'q1',
            sourceHandle: 'collector',
            target: 'ground',
            targetHandle: 'terminal',
          },
        ],
        viewport: { x: 0, y: 0, zoom: 1 },
      }),
      hash: 'v1',
      modifiedAt: 1,
    });
    tauriMocks.circuitSolveDc.mockResolvedValueOnce({
      operatingPoint: {
        nodeVoltages: { 0: 0, collectorNet: -0.2 },
        componentCurrents: { q1: 0.001 },
        componentPowers: { q1: 0.00084 },
        diagnostics: [
          {
            code: 'npnOutsideForwardActive',
            context: {
              component: 'q1',
              baseEmitterVoltage: 0.7,
              collectorEmitterVoltage: -0.2,
            },
          },
        ],
        iterations: 4,
      },
      sourceMap: {
        terminals: [
          { terminal: { nodeId: 'q1', handleId: 'collector' }, electricalNode: 'collectorNet' },
          { terminal: { nodeId: 'ground', handleId: 'terminal' }, electricalNode: '0' },
        ],
        wires: [{ wireId: 'collector-wire', electricalNode: 'collectorNet' }],
        probes: [],
      },
      probeValues: [],
    });

    const { container } = render(<LogicDiagramView relativePath={PATH} />);
    expect(await screen.findByText(/2 symbols/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Run DC' }));

    expect(await screen.findByText('Q1 entered unsupported reverse-active operation')).toBeTruthy();
    expect(screen.getByText(/700 mV VBE/)).toBeTruthy();
    expect(screen.getByText(/200 mV VCE/)).toBeTruthy();
    expect(screen.getByText('negative')).toBeTruthy();
    expect(container.querySelector('[data-schematic-polarity="negative"]')).toBeTruthy();
  });

  it('shows actionable structured circuit compilation errors', async () => {
    tauriMocks.readNote.mockResolvedValueOnce({
      content: JSON.stringify({
        schemaVersion: 6,
        kind: 'logic-diagram',
        diagramMode: 'schematic',
        nodes: [
          {
            id: 'r1',
            kind: 'resistor',
            position: { x: 0, y: 0 },
            electrical: { resistanceOhms: 1000 },
          },
        ],
        wires: [],
        viewport: { x: 0, y: 0, zoom: 1 },
      }),
      hash: 'v1',
      modifiedAt: 1,
    });
    tauriMocks.circuitSolveDc.mockRejectedValueOnce({
      stage: 'compilation',
      detail: { code: 'disconnectedTerminal', context: { nodeId: 'r1', handleId: 'terminal-b' } },
    });

    render(<LogicDiagramView relativePath={PATH} />);
    expect(await screen.findByText(/1 symbols/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Run DC' }));

    expect(await screen.findByText(/Connect r1's terminal-b before running DC/)).toBeTruthy();
  });

  it('cancels an active native circuit job without showing a failure', async () => {
    tauriMocks.readNote.mockResolvedValueOnce({
      content: JSON.stringify({
        schemaVersion: 6,
        kind: 'logic-diagram',
        diagramMode: 'schematic',
        nodes: [{ id: 'ground', kind: 'ground', position: { x: 0, y: 0 } }],
        wires: [],
        viewport: { x: 0, y: 0, zoom: 1 },
      }),
      hash: 'v1',
      modifiedAt: 1,
    });
    tauriMocks.circuitJobStatus.mockImplementation(async () =>
      tauriMocks.circuitCancelJob.mock.calls.length > 0
        ? { phase: 'cancelled', stage: null, elapsedMillis: 2 }
        : { phase: 'running', stage: 'solving', elapsedMillis: 1 },
    );
    tauriMocks.circuitTakeJobResult.mockResolvedValueOnce({ state: 'cancelled' });

    render(<LogicDiagramView relativePath={PATH} />);
    expect(await screen.findByText(/1 symbols/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Run DC' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel: Solving' }));

    await waitFor(() => expect(tauriMocks.circuitCancelJob).toHaveBeenCalledWith('circuit-job-1'));
    expect(await screen.findByRole('button', { name: 'Run DC' })).toBeTruthy();
    expect(screen.queryByText('Simulation failed')).toBeNull();
  });

  it('exports the current diagram SVG and appends it to an open note', async () => {
    useEditorStore.setState({
      openTabs: [
        { relativePath: PATH, title: 'test', isDirty: false, savedHash: null, type: 'logic' },
        {
          relativePath: 'Notes/target.md',
          title: 'target',
          isDirty: false,
          savedHash: 'note-v1',
          type: 'note',
        },
      ],
      activeTabPath: PATH,
    } as never);
    tauriMocks.readNote
      .mockResolvedValueOnce({
        content: logicDoc(['input', 'and']),
        hash: 'logic-v1',
        modifiedAt: 1,
      })
      .mockRejectedValueOnce(new Error('missing svg'))
      .mockResolvedValueOnce({ content: '# Target\n', hash: 'note-v1', modifiedAt: 2 });
    tauriMocks.writeNote.mockResolvedValue({ hash: 'note-v2' });

    render(<LogicDiagramView relativePath={PATH} />);
    expect(await screen.findByText(/2 gates/)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /insert in note/i }));

    await waitFor(() =>
      expect(tauriMocks.writeNote).toHaveBeenCalledWith(
        '/vault',
        'Pictures/test.svg',
        expect.stringContaining('<svg'),
        undefined,
        undefined,
      ),
    );
    expect(tauriMocks.createFolder).toHaveBeenCalledWith('/vault', 'Pictures');
    await waitFor(() =>
      expect(tauriMocks.writeNote).toHaveBeenCalledWith(
        '/vault',
        'Notes/target.md',
        expect.stringContaining('![test](../Pictures/test.svg)'),
        'note-v1',
        '# Target\n',
      ),
    );
    expect(useEditorStore.getState().forceReloadPath).toBe('Notes/target.md');
  });

  it('uses a unique image export when inserting with shift-click', async () => {
    useVaultStore.setState({
      fileTree: [
        {
          name: 'Pictures',
          relativePath: 'Pictures',
          isFolder: true,
          children: [
            {
              name: 'test.svg',
              relativePath: 'Pictures/test.svg',
              isFolder: false,
              extension: 'svg',
            },
          ],
        },
      ],
    } as never);
    useEditorStore.setState({
      openTabs: [
        { relativePath: PATH, title: 'test', isDirty: false, savedHash: null, type: 'logic' },
        {
          relativePath: 'Notes/target.md',
          title: 'target',
          isDirty: false,
          savedHash: 'note-v1',
          type: 'note',
        },
      ],
      activeTabPath: PATH,
    } as never);
    tauriMocks.readNote
      .mockResolvedValueOnce({ content: logicDoc(['input']), hash: 'logic-v1', modifiedAt: 1 })
      .mockRejectedValueOnce(new Error('missing svg'))
      .mockResolvedValueOnce({ content: '', hash: 'note-v1', modifiedAt: 2 });

    render(<LogicDiagramView relativePath={PATH} />);
    expect(await screen.findByText(/1 gates/)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /insert in note/i }), { shiftKey: true });

    await waitFor(() =>
      expect(tauriMocks.writeNote).toHaveBeenCalledWith(
        '/vault',
        'Pictures/test-2.svg',
        expect.stringContaining('<svg'),
        undefined,
        undefined,
      ),
    );
  });

  it('keeps templates as node-collection insertion', async () => {
    tauriMocks.readNote.mockResolvedValueOnce({
      content: logicDoc([]),
      hash: 'logic-v1',
      modifiedAt: 1,
    });

    render(<LogicDiagramView relativePath={PATH} />);
    expect(await screen.findByText(/0 gates/)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /templates/i }));
    fireEvent.click(await screen.findByRole('button', { name: /Half-Adder/i }));

    await waitFor(() => expect(screen.getByText(/6 gates/)).toBeTruthy());
    expect(screen.getByText(/0 components/)).toBeTruthy();
  });

  it('saves the whole logic file as a component when no nodes are selected', async () => {
    tauriMocks.readNote.mockResolvedValueOnce({
      content: JSON.stringify({
        schemaVersion: 1,
        kind: 'logic-diagram',
        title: 'Adder',
        nodes: [
          { id: 'a', kind: 'input', label: 'A', position: { x: 0, y: 0 } },
          { id: 'sum', kind: 'output', label: 'Sum', position: { x: 220, y: 0 } },
        ],
        wires: [
          { id: 'a-sum', source: 'a', target: 'sum', sourceHandle: 'out', targetHandle: 'in' },
        ],
        viewport: { x: 0, y: 0, zoom: 1 },
      }),
      hash: 'logic-v1',
      modifiedAt: 1,
    });

    render(<LogicDiagramView relativePath={PATH} />);
    expect(await screen.findByText(/2 gates/)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /^save component$/i }));
    const saveComponentButtons = screen.getAllByRole('button', { name: /^save component$/i });
    fireEvent.click(saveComponentButtons[saveComponentButtons.length - 1]);

    await waitFor(() =>
      expect(tauriMocks.saveLogicComponent).toHaveBeenCalledWith(
        '/vault',
        expect.objectContaining({
          name: 'test',
          ports: expect.arrayContaining([
            expect.objectContaining({ direction: 'input', label: 'A' }),
            expect.objectContaining({ direction: 'output', label: 'Sum' }),
          ]),
        }),
      ),
    );
  });

  it('inserts saved components as component nodes', async () => {
    tauriMocks.readNote.mockResolvedValueOnce({
      content: logicDoc([]),
      hash: 'logic-v1',
      modifiedAt: 1,
    });
    tauriMocks.listLogicComponents.mockResolvedValue([
      {
        id: 'component-1',
        name: 'Reusable Inverter',
        version: 1,
        createdAt: 1,
        updatedAt: 1,
        ports: [
          { id: 'in', direction: 'input', label: 'In', sourceNodeId: 'in' },
          { id: 'out', direction: 'output', label: 'Out', sourceNodeId: 'out' },
        ],
        nodes: [
          { id: 'in', kind: 'input', position: { x: 0, y: 0 } },
          { id: 'not', kind: 'not', position: { x: 120, y: 0 } },
          { id: 'out', kind: 'output', position: { x: 240, y: 0 } },
        ],
        wires: [
          { id: 'in-not', source: 'in', target: 'not', sourceHandle: 'out', targetHandle: 'in' },
          { id: 'not-out', source: 'not', target: 'out', sourceHandle: 'out', targetHandle: 'in' },
        ],
      },
    ]);

    render(<LogicDiagramView relativePath={PATH} />);
    expect(await screen.findByText(/0 gates/)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /components/i }));
    fireEvent.click(await screen.findByRole('button', { name: /Reusable Inverter/i }));

    await waitFor(() => expect(screen.getByText(/1 components/)).toBeTruthy());
  });

  it('opens and updates an existing saved component without replacing its identity', async () => {
    const component = {
      id: 'component-1',
      name: 'Reusable Inverter',
      version: 4,
      createdAt: 1,
      updatedAt: 4,
      ports: [
        { id: 'in', direction: 'input' as const, label: 'In', sourceNodeId: 'in' },
        { id: 'out', direction: 'output' as const, label: 'Out', sourceNodeId: 'out' },
      ],
      nodes: [
        { id: 'in', kind: 'input' as const, position: { x: 0, y: 0 } },
        { id: 'not', kind: 'not' as const, position: { x: 120, y: 0 } },
        { id: 'out', kind: 'output' as const, position: { x: 240, y: 0 } },
      ],
      wires: [
        { id: 'in-not', source: 'in', target: 'not', sourceHandle: 'out', targetHandle: 'in' },
        { id: 'not-out', source: 'not', target: 'out', sourceHandle: 'out', targetHandle: 'in' },
      ],
    };
    tauriMocks.readNote.mockResolvedValueOnce({
      content: logicDoc([]),
      hash: 'logic-v1',
      modifiedAt: 1,
    });
    tauriMocks.listLogicComponents.mockResolvedValue([component]);
    tauriMocks.saveLogicComponent.mockImplementation(async (_vaultPath, definition) => ({
      ...definition,
      version: definition.version + 1,
    }));

    render(<LogicDiagramView relativePath={PATH} />);
    expect(await screen.findByText(/0 gates/)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /components/i }));
    fireEvent.click(await screen.findByRole('button', { name: /edit saved component/i }));
    expect(await screen.findByText(/reusable component editor/i)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /^add$/i }));
    fireEvent.click(screen.getByRole('button', { name: /update component/i }));

    await waitFor(() =>
      expect(tauriMocks.saveLogicComponent).toHaveBeenCalledWith(
        '/vault',
        expect.objectContaining({
          id: 'component-1',
          name: 'Reusable Inverter',
          version: 4,
        }),
      ),
    );
    expect(await screen.findByText(/0 gates/)).toBeTruthy();
  });

  it('loads and inserts hosted vault components through the server library', async () => {
    const hostedFile = {
      id: 'file-logic',
      parentId: null,
      name: 'test.logic',
      relativePath: PATH,
      kind: 'document',
      documentType: 'logic',
      state: 'active',
      currentRevision: {
        id: 'revision-1',
        sequence: 1,
        contentHash: 'hash-1',
        sizeBytes: 0,
        createdByDisplayName: 'Test User',
        createdAt: '2026-07-14T08:00:00Z',
      },
      createdAt: '2026-07-14T08:00:00Z',
      updatedAt: '2026-07-14T08:00:00Z',
    };
    const component = {
      id: 'component-1',
      name: 'Hosted Inverter',
      version: 1,
      createdAt: 1,
      updatedAt: 1,
      ports: [
        { id: 'in', direction: 'input', label: 'In', sourceNodeId: 'in' },
        { id: 'out', direction: 'output', label: 'Out', sourceNodeId: 'out' },
      ],
      nodes: [
        { id: 'in', kind: 'input', position: { x: 0, y: 0 } },
        { id: 'not', kind: 'not', position: { x: 120, y: 0 } },
        { id: 'out', kind: 'output', position: { x: 240, y: 0 } },
      ],
      wires: [
        { id: 'in-not', source: 'in', target: 'not', sourceHandle: 'out', targetHandle: 'in' },
        { id: 'not-out', source: 'not', target: 'out', sourceHandle: 'out', targetHandle: 'in' },
      ],
    };
    useVaultStore.setState({
      vault: {
        kind: 'hosted',
        id: 'hosted-vault',
        hostedVaultId: 'hosted-vault',
        serverUrl: 'https://collab.example.test',
        role: 'editor',
        name: 'Hosted Vault',
        path: 'hosted://hosted-vault',
        lastOpened: Date.now(),
        isEncrypted: false,
        capabilities: ['vault.read', 'file.write'],
      },
    } as never);
    tauriMocks.hostedVaultRequest.mockImplementation(async (_serverUrl, method, path) => {
      if (method === 'GET' && path.endsWith('/manifest')) {
        return { vaultId: 'hosted-vault', sequence: 1, files: [hostedFile] };
      }
      if (method === 'GET' && path.endsWith('/files/file-logic')) {
        return { file: hostedFile, content: logicDoc([]) };
      }
      if (method === 'GET' && path.endsWith('/logic-components')) {
        return [component];
      }
      throw new Error(`unexpected hosted request: ${method} ${path}`);
    });

    render(<LogicDiagramView relativePath={PATH} />);
    expect(await screen.findByText(/0 gates/)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /components/i }));
    fireEvent.click(await screen.findByRole('button', { name: /Hosted Inverter/i }));

    await waitFor(() => expect(screen.getByText(/1 components/)).toBeTruthy());
    expect(tauriMocks.hostedVaultRequest).toHaveBeenCalledWith(
      'https://collab.example.test',
      'GET',
      '/api/v1/vaults/hosted-vault/logic-components',
      undefined,
    );
  });

  it('disables authoring controls and shortcuts for hosted viewers', async () => {
    const hostedFile = {
      id: 'file-logic',
      parentId: null,
      name: 'test.logic',
      relativePath: PATH,
      kind: 'document',
      documentType: 'logic',
      state: 'active',
      currentRevision: {
        id: 'revision-1',
        sequence: 1,
        contentHash: 'hash-1',
        sizeBytes: 0,
        createdByDisplayName: 'Test User',
        createdAt: '2026-07-14T08:00:00Z',
      },
      createdAt: '2026-07-14T08:00:00Z',
      updatedAt: '2026-07-14T08:00:00Z',
    };
    useVaultStore.setState({
      vault: {
        kind: 'hosted',
        id: 'hosted-vault',
        hostedVaultId: 'hosted-vault',
        serverUrl: 'https://collab.example.test',
        role: 'viewer',
        name: 'Hosted Vault',
        path: 'hosted://hosted-vault',
        lastOpened: Date.now(),
        isEncrypted: false,
        capabilities: ['vault.read'],
      },
    } as never);
    tauriMocks.hostedVaultRequest.mockImplementation(async (_serverUrl, method, path) => {
      if (method === 'GET' && path.endsWith('/manifest')) {
        return { vaultId: 'hosted-vault', sequence: 1, files: [hostedFile] };
      }
      if (method === 'GET' && path.endsWith('/files/file-logic')) {
        return { file: hostedFile, content: logicDoc([]) };
      }
      if (method === 'GET' && path.endsWith('/logic-components')) {
        return [];
      }
      throw new Error(`unexpected hosted request: ${method} ${path}`);
    });

    render(<LogicDiagramView relativePath={PATH} />);
    expect(await screen.findByText(/0 gates/)).toBeTruthy();

    const addButton = screen.getByRole('button', { name: /^add$/i });
    expect((addButton as HTMLButtonElement).disabled).toBe(true);

    fireEvent.click(addButton);
    fireEvent.keyDown(document, { key: 'a' });

    expect(screen.getByText(/0 gates/)).toBeTruthy();
    expect(tauriMocks.writeNote).not.toHaveBeenCalled();
  });

  it('opens a dynamic value table for the current logic file', async () => {
    tauriMocks.readNote.mockResolvedValueOnce({
      content: JSON.stringify({
        schemaVersion: 4,
        kind: 'logic-diagram',
        diagramMode: 'logic',
        nodes: [
          { id: 'a', kind: 'input', label: 'A', position: { x: 0, y: 0 }, value: false },
          { id: 'out', kind: 'output', label: 'Result', position: { x: 200, y: 0 } },
        ],
        wires: [
          { id: 'a-out', source: 'a', target: 'out', sourceHandle: 'out', targetHandle: 'in' },
        ],
        viewport: { x: 0, y: 0, zoom: 1 },
      }),
      hash: 'v1',
      modifiedAt: 1,
    });

    render(<LogicDiagramView relativePath={PATH} />);
    expect(await screen.findByText(/2 gates/)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /value table/i }));

    expect(await screen.findByRole('heading', { name: 'Logic value table' })).toBeTruthy();
    expect(screen.getByText('1 inputs · 1 outputs · 2 rows')).toBeTruthy();
    expect(screen.getByRole('columnheader', { name: 'A' })).toBeTruthy();
    expect(screen.getByRole('columnheader', { name: 'Result' })).toBeTruthy();
  });

  it('allows schematic terminals to branch and receive multiple wires', async () => {
    tauriMocks.readNote.mockResolvedValueOnce({
      content: JSON.stringify({
        schemaVersion: 5,
        kind: 'logic-diagram',
        diagramMode: 'schematic',
        nodes: [
          { id: 'source', kind: 'voltage-source', label: 'Supply', position: { x: 0, y: 0 } },
          { id: 'r1', kind: 'resistor', label: 'R1', position: { x: 200, y: 0 } },
          { id: 'r2', kind: 'resistor', label: 'R2', position: { x: 200, y: 120 } },
        ],
        wires: [],
        viewport: { x: 0, y: 0, zoom: 1 },
      }),
      hash: 'v1',
      modifiedAt: 1,
    });

    render(<LogicDiagramView relativePath={PATH} />);
    expect(await screen.findByText(/3 symbols/)).toBeTruthy();

    const supplyPositive = screen.getByRole('button', { name: /Supply terminal positive/i });
    const firstInput = screen.getByRole('button', { name: /R1 terminal terminal-a/i });
    const secondInput = screen.getByRole('button', { name: /R2 terminal terminal-a/i });
    const secondOutput = screen.getByRole('button', { name: /R2 terminal terminal-b/i });

    fireEvent.pointerDown(supplyPositive, { button: 0, pointerId: 1, clientX: 0, clientY: 0 });
    fireEvent.pointerUp(firstInput, { pointerId: 1 });
    fireEvent.pointerDown(supplyPositive, { button: 0, pointerId: 2, clientX: 0, clientY: 0 });
    fireEvent.pointerUp(secondInput, { pointerId: 2 });
    fireEvent.pointerDown(secondOutput, { button: 0, pointerId: 3, clientX: 0, clientY: 0 });
    fireEvent.pointerUp(firstInput, { pointerId: 3 });

    expect(await screen.findByText(/3 wires/)).toBeTruthy();
  });
});
