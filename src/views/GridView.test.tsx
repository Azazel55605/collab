import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { DocumentSessionController } from '../lib/documentSessionController';
import { useDocumentStatusStore } from '../store/documentStatusStore';
import { emptyCell, useGridStore } from '../store/gridStore';
import { useUiStore } from '../store/uiStore';

import GridView from './GridView';

vi.mock('../components/grid/GridCell', () => ({ default: () => <div data-testid="pane" /> }));
vi.mock('../components/grid/WorkspaceBar', () => ({ default: () => null }));
vi.mock('../components/grid/GridLayoutPicker', () => ({
  default: ({ onChange }: { onChange: (id: 'single') => void }) => (
    <button onClick={() => onChange('single')}>One pane</button>
  ),
}));

const OriginalResizeObserver = globalThis.ResizeObserver;
let resize: (entries: Array<{ contentRect: { width: number } }>) => void;
beforeEach(() => {
  globalThis.ResizeObserver = class {
    constructor(callback: ResizeObserverCallback) {
      resize = callback as unknown as typeof resize;
    }
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
    width: 1000,
  } as DOMRect);
  useDocumentStatusStore.setState({ statuses: {}, registrations: {} });
  useUiStore.setState({ animationsEnabled: false });
  useGridStore.setState({
    activeWorkspaceId: 'test',
    workspaces: [
      {
        id: 'test',
        name: 'Test',
        layoutId: 'cols-3',
        cells: [emptyCell('1'), emptyCell('2'), emptyCell('3')],
      },
    ],
  });
});
afterEach(() => {
  globalThis.ResizeObserver = OriginalResizeObserver;
});

it('waits for pending edits before responsive resizing removes a pane', async () => {
  render(<GridView />);
  expect(screen.getAllByTestId('pane')).toHaveLength(3);
  let finish!: (value: { version: string }) => void;
  const controller = new DocumentSessionController<string>({
    write: () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
    serialize: (value) => value,
    deserialize: (value) => value,
    applyDocument: () => {},
    schedule: () => () => {},
  });
  controller.load('old', 'v1');
  controller.markLocalChange('edited');
  useDocumentStatusStore.getState().setDocumentStatus('a.md', {
    status: 'dirty',
    controller: controller as unknown as DocumentSessionController<unknown>,
  });
  act(() => resize([{ contentRect: { width: 200 } }]));
  expect(screen.getAllByTestId('pane')).toHaveLength(3);
  await act(async () => {
    finish({ version: 'v2' });
  });
  expect(screen.getAllByTestId('pane')).toHaveLength(2);
  controller.dispose();
});

it('does not apply a delayed layout animation to a newly selected workspace', () => {
  vi.useFakeTimers();
  try {
    useUiStore.setState({ animationsEnabled: true });
    useGridStore.setState((state) => ({
      workspaces: [
        ...state.workspaces,
        {
          id: 'other',
          name: 'Other',
          layoutId: 'split-h',
          cells: [emptyCell('4'), emptyCell('5')],
        },
      ],
    }));
    render(<GridView />);
    fireEvent.click(screen.getByText('One pane'));
    act(() => useGridStore.getState().setActiveWorkspace('other'));
    act(() => vi.advanceTimersByTime(1000));
    expect(
      useGridStore.getState().workspaces.find((workspace) => workspace.id === 'other')?.layoutId,
    ).toBe('split-h');
  } finally {
    vi.useRealTimers();
  }
});
