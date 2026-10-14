import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useDocumentStatusStore } from '../store/documentStatusStore';
import { useEditorStore } from '../store/editorStore';
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
    useDocumentStatusStore.setState({ statuses: {} });
    useEditorStore.setState({ activeTabPath: 'a.canvas', openTabs: [] });
    useUiStore.setState({ activeView: 'editor' });
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
