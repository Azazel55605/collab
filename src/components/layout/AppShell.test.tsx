import React, { useEffect } from 'react';

import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useEditorStore } from '../../store/editorStore';
import { useNoteIndexStore } from '../../store/noteIndexStore';
import { useUiStore } from '../../store/uiStore';
import { useVaultStore } from '../../store/vaultStore';

import AppShell from './AppShell';

const providerLifecycle = vi.hoisted(() => ({ mounted: 0, unmounted: 0 }));
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
vi.mock('../command-bar/CommandBar', () => ({ CommandBar: () => null }));
vi.mock('../collaboration/CollabProvider', () => ({
  CollabProvider: function MockCollabProvider({ children }: { children: React.ReactNode }) {
    useEffect(() => {
      providerLifecycle.mounted++;
      return () => {
        providerLifecycle.unmounted++;
      };
    }, []);
    return <>{children}</>;
  },
}));
vi.mock('../../views/ChatsPage', () => ({
  default: ({ standalone }: { standalone: boolean }) => (
    <div data-testid="personal-chats">{String(standalone)}</div>
  ),
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
    // A mock component, so the hook is used correctly — the rule cannot tell,
    // because the factory returns an anonymous arrow under the key `default`.
    // eslint-disable-next-line react-hooks/rules-of-hooks
    useEffect(() => {
      noteLifecycle.events.push(`mount:${relativePath}`);
      return () => {
        noteLifecycle.events.push(`unmount:${relativePath}`);
      };
    }, [relativePath]);

    return <div data-testid="note-view">{relativePath}</div>;
  },
}));

describe('AppShell document remounting', () => {
  beforeEach(() => {
    noteLifecycle.events.length = 0;
    providerLifecycle.mounted = 0;
    providerLifecycle.unmounted = 0;

    useVaultStore.setState({
      vault: {
        id: 'vault-1',
        path: '/vault',
        name: 'Vault',
        isEncrypted: false,
        lastOpened: Date.now(),
      },
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
  it('opens personal chats without closing the current vault collaboration session', async () => {
    render(<AppShell />);
    await screen.findByTestId('note-view');
    act(() => useUiStore.getState().setActiveView('chats'));
    expect((await screen.findByTestId('personal-chats')).textContent).toBe('false');
    expect(screen.queryByTestId('tab-bar')).toBeNull();
    expect(
      screen.getByTestId('sidebar').closest('[aria-hidden]')?.getAttribute('aria-hidden'),
    ).toBe('true');
    expect(providerLifecycle).toEqual({ mounted: 1, unmounted: 0 });
    act(() => useUiStore.getState().setActiveView('editor'));
    await screen.findByTestId('note-view');
    expect(useUiStore.getState().isSidebarOpen).toBe(true);
    expect(
      screen.getByTestId('sidebar').closest('[aria-hidden]')?.getAttribute('aria-hidden'),
    ).toBe('false');
    expect(providerLifecycle).toEqual({ mounted: 1, unmounted: 0 });
  });
});
