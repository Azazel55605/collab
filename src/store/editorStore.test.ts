import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { useEditorStore } from './editorStore';

describe('editorStore renameTab', () => {
  beforeEach(() => {
    useEditorStore.setState({
      sessionVaultPath: null,
      openTabs: [],
      activeTabPath: null,
      forceReloadPath: null,
      revealEditorPath: null,
      pendingSearchJump: null,
      noteViewStates: {},
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

  it('moves persisted note editor view state when a note path changes', () => {
    useEditorStore.getState().setNoteViewState('Notes/a.md', {
      scrollTop: 240,
      selectionAnchor: 18,
      selectionHead: 22,
    });

    useEditorStore.getState().renameTab('Notes/a.md', 'Archive/a.md', 'a');

    const next = useEditorStore.getState();
    expect(next.noteViewStates['Notes/a.md']).toBeUndefined();
    expect(next.noteViewStates['Archive/a.md']).toEqual({
      scrollTop: 240,
      selectionAnchor: 18,
      selectionHead: 22,
    });
  });

  it('moves persisted presentation view state with its file and folder', () => {
    const state = {
      slideId: 'slide-3',
      zoom: 'fit' as const,
      slideRailOpen: false,
      notesOpen: true,
      selectedElementIds: [],
    };
    useEditorStore.getState().setDeckViewState('Talks/q3.deck', state);

    useEditorStore.getState().renameTab('Talks', 'Archive/Talks', 'Talks');

    const next = useEditorStore.getState();
    expect(next.deckViewStates['Talks/q3.deck']).toBeUndefined();
    expect(next.deckViewStates['Archive/Talks/q3.deck']).toEqual(state);
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

  it('moves descendant note editor view state when a folder path changes', () => {
    useEditorStore.getState().setNoteViewState('Projects/alpha/spec.md', {
      scrollTop: 96,
      selectionAnchor: 11,
      selectionHead: 13,
    });

    useEditorStore.getState().renameTab('Projects/alpha', 'Archive/alpha', 'alpha');

    const next = useEditorStore.getState();
    expect(next.noteViewStates['Projects/alpha/spec.md']).toBeUndefined();
    expect(next.noteViewStates['Archive/alpha/spec.md']).toEqual({
      scrollTop: 96,
      selectionAnchor: 11,
      selectionHead: 13,
    });
  });

  it('stores and clears one-shot pending search jump targets', () => {
    useEditorStore.getState().setPendingSearchJump({
      relativePath: 'Notes/a.md',
      query: 'search term',
    });

    expect(useEditorStore.getState().pendingSearchJump).toEqual({
      relativePath: 'Notes/a.md',
      query: 'search term',
    });

    useEditorStore.getState().setPendingSearchJump(null);

    expect(useEditorStore.getState().pendingSearchJump).toBeNull();
  });

  it('does not recreate tab state when marking an already-dirty tab dirty again', () => {
    const state = useEditorStore.getState();
    state.openTab('Boards/test.canvas', 'test', 'canvas');
    state.markDirty('Boards/test.canvas');

    const firstOpenTabs = useEditorStore.getState().openTabs;
    useEditorStore.getState().markDirty('Boards/test.canvas');

    expect(useEditorStore.getState().openTabs).toBe(firstOpenTabs);
  });
});
