import { beforeEach, expect, it, vi } from 'vitest';

import { DocumentSessionController } from '../lib/documentSessionController';

import { useDocumentStatusStore } from './documentStatusStore';
import { flushEditorPersistence, RECENT_VIEW_STATE_LIMIT, useEditorStore } from './editorStore';

beforeEach(() => {
  useDocumentStatusStore.setState({ statuses: {}, registrations: {} });
  useEditorStore.getState().resetSession(null);
  useEditorStore.persist.clearStorage();
});
it('closes 100 tabs transactionally after the save gate, with one persistence write', async () => {
  useEditorStore.setState({
    openTabs: Array.from({ length: 100 }, (_, i) => ({
      relativePath: `${i}.md`,
      title: String(i),
      isDirty: false,
      savedHash: null,
      type: 'note' as const,
    })),
    activeTabPath: '99.md',
  });
  flushEditorPersistence();
  const notify = vi.fn();
  const off = useEditorStore.subscribe(notify);
  const write = vi.spyOn(localStorage, 'setItem');
  write.mockClear();
  await useEditorStore
    .getState()
    .closeTabs(useEditorStore.getState().openTabs.map((tab) => tab.relativePath));
  flushEditorPersistence();
  off();
  expect(notify).toHaveBeenCalledTimes(1);
  expect(write.mock.calls.filter(([key]) => key === 'editor-storage')).toHaveLength(1);
  expect(useEditorStore.getState().activeTabPath).toBeNull();
});
it('bounds recent metadata after 2000 closed files and preserves pinned and pane-local states across rename/delete', async () => {
  const state = useEditorStore.getState();
  state.openTab('pinned.md', 'Pinned');
  const view = { scrollTop: 1, selectionAnchor: 2, selectionHead: 3 };
  state.setNoteViewState('pinned.md', view);
  for (let i = 0; i < 2000; i++) state.setNoteViewState(`${i}.md`, view);
  expect(Object.keys(useEditorStore.getState().noteViewStates)).toHaveLength(
    RECENT_VIEW_STATE_LIMIT + 1,
  );
  expect(JSON.stringify(useEditorStore.getState().noteViewStates).length).toBeLessThan(16_000);
  state.setNoteViewState('pinned.md\0left', { ...view, scrollTop: 10 });
  state.setNoteViewState('pinned.md\0right', { ...view, scrollTop: 20 });
  state.renameTab('pinned.md', 'renamed.md', 'Renamed');
  expect(useEditorStore.getState().noteViewStates['renamed.md\0left'].scrollTop).toBe(10);
  expect(useEditorStore.getState().noteViewStates['renamed.md\0right'].scrollTop).toBe(20);
  state.removeViewStates('renamed.md');
  expect(
    Object.keys(useEditorStore.getState().noteViewStates).some((key) =>
      key.startsWith('renamed.md'),
    ),
  ).toBe(false);
  await state.closeTabs(['renamed.md']);
  flushEditorPersistence();
});
it('does not notify for an identical selection/viewport', () => {
  const value = { scrollTop: 20, selectionAnchor: 1, selectionHead: 1 };
  useEditorStore.getState().setNoteViewState('a.md', value);
  const notify = vi.fn();
  const off = useEditorStore.subscribe(notify);
  useEditorStore.getState().setNoteViewState('a.md', { ...value });
  off();
  expect(notify).not.toHaveBeenCalled();
});

it('keeps every tab mounted when the bulk-close save boundary fails', async () => {
  const state = useEditorStore.getState();
  state.openTab('a.md', 'A');
  state.openTab('b.md', 'B');
  const controller = new DocumentSessionController<string>({
    write: async () => {
      throw new Error('offline');
    },
    serialize: (s) => s,
    deserialize: (s) => s,
    applyDocument: () => {},
    schedule: () => () => {},
  });
  controller.load('base', '1');
  controller.markLocalChange('draft');
  useDocumentStatusStore.getState().setDocumentStatus('b.md', {
    status: 'dirty',
    controller: controller as unknown as DocumentSessionController<unknown>,
  });
  const tabs = useEditorStore.getState().openTabs;
  expect(await state.closeTabs(['a.md', 'b.md'])).toBe(false);
  expect(useEditorStore.getState().openTabs).toBe(tabs);
  expect(controller.getSnapshot().currentContent).toBe('draft');
  controller.dispose();
});
