import { cleanup, render, screen, waitFor } from '@testing-library/react';
import React, { useEffect } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useEditorStore } from '../../store/editorStore';
import { useNoteIndexStore } from '../../store/noteIndexStore';
import { useUiStore } from '../../store/uiStore';
import { useVaultStore } from '../../store/vaultStore';

const noteLifecycle = vi.hoisted(() => ({ events: [] as string[] }));

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async () => () => {}),
}));

vi.mock('../../lib/tauri', () => ({
  tauriCommands: {
    buildNoteIndex: vi.fn(async () => []),
  },
}));

vi.mock('./ActivityBar', () => ({ default: () => <div data-testid="activity-bar" /> }));
vi.mock('./Sidebar', () => ({ default: () => <div data-testid="sidebar" /> }));
vi.mock('./TabBar', () => ({ default: () => <div data-testid="tab-bar" /> }));
vi.mock('./StatusBar', () => ({ default: () => <div data-testid="status-bar" /> }));
vi.mock('../grid/SplitDropZones', () => ({ default: () => null }));
vi.mock('../collaboration/ConflictDialog', () => ({ ConflictDialog: () => null }));
vi.mock('../command-bar/CommandBar', () => ({ CommandBar: () => null }));
vi.mock('../collaboration/CollabProvider', () => ({
  CollabProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock('../../contexts/DragContext', () => ({
  DragProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock('../../views/GraphPage', () => ({ default: () => <div>graph</div> }));
vi.mock('../../views/CanvasPage', () => ({ default: () => <div>canvas</div> }));
vi.mock('../../views/KanbanPage', () => ({ default: () => <div>kanban</div> }));
vi.mock('../../views/SettingsPage', () => ({ default: () => <div>settings</div> }));
vi.mock('../../views/GridView', () => ({ default: () => <div>grid</div> }));
vi.mock('../../views/ImageView', () => ({ default: () => <div>image</div> }));
vi.mock('../../views/PdfView', () => ({ default: () => <div>pdf</div> }));
vi.mock('../../views/NoteView', () => ({
  default: ({ relativePath }: { relativePath: string }) => {
    useEffect(() => {
      noteLifecycle.events.push(`mount:${relativePath}`);
      return () => {
        noteLifecycle.events.push(`unmount:${relativePath}`);
      };
    }, [relativePath]);

    return <div data-testid="note-view">{relativePath}</div>;
  },
}));

import AppShell from './AppShell';

describe('AppShell document remounting', () => {
  beforeEach(() => {
    noteLifecycle.events.length = 0;

    useVaultStore.setState({
      vault: { id: 'vault-1', path: '/vault', name: 'Vault', isEncrypted: false, lastOpened: Date.now() },
      isVaultLocked: false,
      fileTree: [],
      recentVaults: [],
      lastOpenedVaultPath: '/vault',
      isLoading: false,
      refreshFileTree: vi.fn(async () => {}),
      openVault: vi.fn(async () => {}),
      unlockVault: vi.fn(async () => {}),
      closeVault: vi.fn(),
      loadRecentVaults: vi.fn(async () => {}),
      removeRecentVault: vi.fn(async () => {}),
    });

    useEditorStore.setState({
      sessionVaultPath: '/vault',
      openTabs: [
        { relativePath: 'Notes/a.md', title: 'a', isDirty: false, savedHash: null, type: 'note' },
        { relativePath: 'Notes/b.md', title: 'b', isDirty: false, savedHash: null, type: 'note' },
      ],
      activeTabPath: 'Notes/a.md',
      forceReloadPath: null,
    });

    useUiStore.setState({
      activeView: 'editor',
      sidebarPanel: 'files',
      collabTab: 'peers',
      sidebarWidth: 240,
      isSidebarOpen: true,
      isSettingsOpen: false,
      isVaultManagerOpen: false,
    });

    useNoteIndexStore.setState({
      notes: [],
      isIndexing: false,
    });
  });

  afterEach(() => {
    cleanup();
  });

  it('remounts the active note view when switching between note tabs', async () => {
    render(<AppShell />);

    expect((await screen.findByTestId('note-view')).textContent).toBe('Notes/a.md');

    useEditorStore.getState().setActiveTab('Notes/b.md');

    await waitFor(() => {
      expect(screen.getByTestId('note-view').textContent).toBe('Notes/b.md');
    });

    expect(noteLifecycle.events).toEqual([
      'mount:Notes/a.md',
      'unmount:Notes/a.md',
      'mount:Notes/b.md',
    ]);
  });
});
