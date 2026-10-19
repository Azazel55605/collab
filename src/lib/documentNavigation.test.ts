import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useDocumentStatusStore } from '../store/documentStatusStore';
import { useEditorStore } from '../store/editorStore';
import { emptyCell, useGridStore } from '../store/gridStore';
import { useUiStore } from '../store/uiStore';

import { runDocumentNavigation } from './documentNavigation';
import { DocumentSessionController } from './documentSessionController';

vi.mock('sonner', () => ({ toast: { error: vi.fn() } }));

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
function register(
  write: ConstructorParameters<typeof DocumentSessionController<string>>[0]['write'],
) {
  const controller = new DocumentSessionController<string>({
    write,
    serialize: (value) => value,
    deserialize: (value) => value,
    applyDocument: () => {},
    schedule: () => () => {},
  });
  controller.load('old', 'v1');
  controller.markLocalChange('edited');
  useDocumentStatusStore.setState({
    statuses: {
      'a.canvas': {
        status: 'dirty',
        controller: controller as unknown as DocumentSessionController<unknown>,
      },
    },
  });
  return controller;
}

describe('document navigation durability', () => {
  beforeEach(() => {
    useDocumentStatusStore.setState({ statuses: {}, registrations: {} });
    useEditorStore.setState({ activeTabPath: 'a.canvas', openTabs: [] });
    useUiStore.setState({ activeView: 'editor' });
  });

  it.each(['clear', 'replace', 'layout', 'switch', 'create', 'delete', 'swap', 'reorder', 'split'])(
    'keeps the grid intact while a %s transition waits for saving',
    async (operation) => {
      let finish!: (value: { version: string }) => void;
      register(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      );
      const cells = [emptyCell('one'), emptyCell('two')];
      cells[0].content = { type: 'note', relativePath: 'a.md', title: 'A' };
      useGridStore.setState({
        activeWorkspaceId: 'a',
        workspaces: [
          { id: 'a', name: 'A', layoutId: 'split-h', cells },
          { id: 'b', name: 'B', layoutId: 'single', cells: [emptyCell('three')] },
        ],
      });
      const before = useGridStore.getState().workspaces;
      const grid = useGridStore.getState();
      const actions: Record<string, () => void> = {
        clear: () => grid.clearCell('one'),
        replace: () =>
          grid.setCellContent('one', { type: 'note', relativePath: 'b.md', title: 'B' }),
        layout: () => grid.setLayout('single'),
        switch: () => grid.setActiveWorkspace('b'),
        create: () => {
          grid.createWorkspace();
        },
        delete: () => grid.deleteWorkspace('a'),
        swap: () => grid.swapCells('one', 'two'),
        reorder: () => grid.reorderCells(['two', 'one']),
        split: () => grid.activateSplit(cells[0].content, cells[1].content, 'top'),
      };
      actions[operation]();
      expect(useGridStore.getState().workspaces).toBe(before);
      expect(useGridStore.getState().activeWorkspaceId).toBe('a');
      finish({ version: 'v2' });
      await settle();
      if (operation === 'switch') expect(useGridStore.getState().activeWorkspaceId).toBe('b');
      else expect(useGridStore.getState().workspaces).not.toBe(before);
    },
  );

  it('blocks grid replacement on failure and retains all same-file pane registrations', async () => {
    const first = register(async () => {
      throw new Error('disk full');
    });
    const firstStatus = useDocumentStatusStore.getState().statuses['a.canvas'];
    useDocumentStatusStore.getState().setDocumentStatus('a.canvas', firstStatus, 'pane-one');
    const second = register(async () => ({ version: 'v2' }));
    useDocumentStatusStore
      .getState()
      .setDocumentStatus(
        'a.canvas',
        useDocumentStatusStore.getState().statuses['a.canvas'],
        'pane-two',
      );
    const before = useGridStore.getState().workspaces;
    useGridStore.getState().clearCell('one');
    await settle();
    expect(useGridStore.getState().workspaces).toBe(before);
    expect(first.getSnapshot().dirty).toBe(true);
    expect(second.getSnapshot().dirty).toBe(false);
    useDocumentStatusStore.getState().clearDocumentStatus('a.canvas', 'pane-two');
    expect(useDocumentStatusStore.getState().statuses['a.canvas'].controller).toBe(first);
  });

  it('awaits a save before switching tabs and page views', async () => {
    let finish!: (value: { version: string }) => void;
    const write = vi.fn(
      () =>
        new Promise<{ version: string }>((resolve) => {
          finish = resolve;
        }),
    );
    register(write);
    useEditorStore.getState().setActiveTab('b.md');
    useUiStore.getState().setActiveView('grid');
    expect(useEditorStore.getState().activeTabPath).toBe('a.canvas');
    expect(useUiStore.getState().activeView).toBe('editor');
    expect(write).toHaveBeenCalledWith({
      content: 'edited',
      expectedVersion: 'v1',
      baseContent: 'old',
    });
    finish({ version: 'v2' });
    await settle();
    expect(useEditorStore.getState().activeTabPath).toBe('b.md');
    expect(useUiStore.getState().activeView).toBe('grid');
  });

  it('keeps edits open on write failure or conflict', async () => {
    const controller = register(async () => {
      throw new Error('disk full');
    });
    const leave = vi.fn();
    runDocumentNavigation(leave);
    await settle();
    expect(leave).not.toHaveBeenCalled();
    expect(controller.getSnapshot().currentContent).toBe('edited');
    register(async () => ({ version: 'v2', conflict: { theirContent: 'other' } }));
    runDocumentNavigation(leave);
    await settle();
    expect(leave).not.toHaveBeenCalled();
  });

  it('saves edits arriving during a slow flush before allowing navigation', async () => {
    let finish!: (value: { version: string }) => void;
    const write = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      )
      .mockResolvedValue({ version: 'v3' });
    const controller = register(write);
    const leave = vi.fn();
    const transition = runDocumentNavigation(leave);
    controller.markLocalChange('newest edit');
    finish({ version: 'v2' });
    expect(await transition).toBe(true);
    expect(write).toHaveBeenLastCalledWith({
      content: 'newest edit',
      expectedVersion: 'v2',
      baseContent: 'edited',
    });
    expect(leave).toHaveBeenCalledOnce();
  });

  it('allows leaving after the native offline outbox acknowledges content', async () => {
    register(async () => ({ version: 'v1', offlineQueued: true }));
    const leave = vi.fn();
    runDocumentNavigation(leave);
    await settle();
    expect(leave).toHaveBeenCalledOnce();
  });

  it('does not discard dirty content when permissions become read-only', async () => {
    const write = vi.fn(async () => ({ version: 'v2' }));
    register(write);
    const status = useDocumentStatusStore.getState().statuses['a.canvas'];
    useDocumentStatusStore.setState({ statuses: { 'a.canvas': { ...status, readOnly: true } } });
    const leave = vi.fn();
    expect(await runDocumentNavigation(leave)).toBe(false);
    expect(write).not.toHaveBeenCalled();
    expect(leave).not.toHaveBeenCalled();
  });
});

it('materializes a paused gesture before deciding which controllers require a save', async () => {
  useDocumentStatusStore.setState({ statuses: {}, registrations: {} });
  const write = vi.fn(async () => ({ version: 'v2' }));
  const controller = new DocumentSessionController<string>({
    write,
    serialize: (value) => value,
    deserialize: (value) => value,
    applyDocument: () => {},
    schedule: () => () => {},
  });
  controller.load('old', 'v1');
  const action = vi.fn();
  useDocumentStatusStore.setState({
    statuses: {
      'a.canvas': {
        status: 'idle',
        controller: controller as DocumentSessionController<unknown>,
        beforeLeave: async () => controller.markLocalChange('last drag position'),
      },
    },
  });
  expect(await runDocumentNavigation(action)).toBe(true);
  expect(write).toHaveBeenCalledWith(
    expect.objectContaining({ content: 'last drag position', expectedVersion: 'v1' }),
  );
  expect(action).toHaveBeenCalledOnce();
  controller.dispose();
  useDocumentStatusStore.setState({ statuses: {}, registrations: {} });
});

it('keeps the live editor open if its durable checkpoint fails', async () => {
  const action = vi.fn();
  useDocumentStatusStore.setState({
    statuses: {
      'a.canvas': {
        status: 'live-reconnecting',
        beforeLeave: async () => {
          throw new Error('disk full');
        },
      },
    },
  });
  expect(await runDocumentNavigation(action)).toBe(false);
  expect(action).not.toHaveBeenCalled();
  useDocumentStatusStore.setState({ statuses: {}, registrations: {} });
});

it('waits for a save already in progress before leaving instead of rejecting early', async () => {
  let finish!: (value: { version: string }) => void;
  const write = vi.fn(
    () =>
      new Promise<{ version: string }>((done) => {
        finish = done;
      }),
  );
  const controller = register(write);
  const saving = controller.requestSave('manual');
  const action = vi.fn();
  const navigation = runDocumentNavigation(action);
  await settle();
  expect(action).not.toHaveBeenCalled();
  finish({ version: 'v2' });
  await settle();
  // A queued trailing save may run for the same current state.
  if (write.mock.calls.length > 1) finish({ version: 'v3' });
  await saving;
  expect(await navigation).toBe(true);
  expect(action).toHaveBeenCalledOnce();
  controller.dispose();
  useDocumentStatusStore.setState({ statuses: {}, registrations: {} });
});

it('awaits live controller checkpoints even when REST saves are skipped', async () => {
  useDocumentStatusStore.setState({ statuses: {}, registrations: {} });
  const controller = register(async () => ({ version: 'v2' }));
  controller.setLiveState('live-connected');
  let finish!: () => void;
  controller.registerLeaveBarrier(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  const action = vi.fn();
  const leaving = runDocumentNavigation(action);
  expect(action).not.toHaveBeenCalled();
  finish();
  expect(await leaving).toBe(true);
  expect(action).toHaveBeenCalledOnce();
  controller.dispose();
  useDocumentStatusStore.setState({ statuses: {}, registrations: {} });
});
