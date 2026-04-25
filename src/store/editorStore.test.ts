import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { useEditorStore } from './editorStore';

describe('editorStore renameTab', () => {
  beforeEach(() => {
    useEditorStore.setState({
      sessionVaultPath: null,
      openTabs: [],
      activeTabPath: null,
      forceReloadPath: null,
    });
  });

  afterEach(() => {
    useEditorStore.persist.clearStorage();
  });

  it('updates the moved file tab and the active tab path', () => {
    const state = useEditorStore.getState();
    state.openTab('Notes/a.md', 'a', 'note');
    state.markDirty('Notes/a.md');
    state.setSavedHash('Notes/a.md', 'hash-a');

    useEditorStore.getState().renameTab('Notes/a.md', 'Archive/a.md', 'a');

    const next = useEditorStore.getState();
    expect(next.activeTabPath).toBe('Archive/a.md');
    expect(next.openTabs).toEqual([
      expect.objectContaining({
        relativePath: 'Archive/a.md',
        title: 'a',
        isDirty: true,
        savedHash: 'hash-a',
      }),
    ]);
  });

  it('updates descendant tabs when a folder path changes', () => {
    const state = useEditorStore.getState();
    state.openTab('Projects/alpha/spec.md', 'spec', 'note');
    state.openTab('Projects/alpha/board.kanban', 'board', 'kanban');
    state.setActiveTab('Projects/alpha/board.kanban');

    useEditorStore.getState().renameTab('Projects/alpha', 'Archive/alpha', 'alpha');

    const next = useEditorStore.getState();
    expect(next.activeTabPath).toBe('Archive/alpha/board.kanban');
    expect(next.openTabs.map((tab) => tab.relativePath)).toEqual([
      'Archive/alpha/spec.md',
      'Archive/alpha/board.kanban',
    ]);
  });
});
