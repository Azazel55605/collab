import { describe, expect, it, vi, beforeEach } from 'vitest';

import { ACTIONS, SETTINGS_SECTIONS, type RenderCtx } from './commandBarActions';

const createNote = vi.fn();
const toolbarAction = vi.fn();
const toastError = vi.fn();

vi.mock('../../lib/tauri', () => ({
  tauriCommands: {
    createNote: (...args: unknown[]) => createNote(...args),
  },
}));

vi.mock('../../lib/editorToolbarActions', () => ({
  dispatchEditorToolbarAction: (...args: unknown[]) => toolbarAction(...args),
}));

vi.mock('sonner', () => ({
  toast: {
    error: (...args: unknown[]) => toastError(...args),
  },
}));

function makeCtx(overrides: Partial<RenderCtx> = {}): RenderCtx {
  return {
    notes: [],
    files: [],
    searchResults: [],
    activeView: 'editor',
    vault: { id: 'vault', name: 'Vault', path: '/vault', lastOpened: 0, isEncrypted: false },
    dateFormat: 'YYYY_MM_DD',
    openTab: vi.fn(),
    setActiveView: vi.fn(),
    openSettings: vi.fn(),
    refreshFileTree: vi.fn(async () => {}),
    setInput: vi.fn(),
    close: vi.fn(),
    ...overrides,
  };
}

describe('commandBarActions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('exposes searchable settings sections', () => {
    expect(SETTINGS_SECTIONS.map((section) => section.id)).toContain('appearance');
    expect(SETTINGS_SECTIONS.map((section) => section.id)).toContain('shortcuts');
  });

  it('opens graph view from the graph action', async () => {
    const ctx = makeCtx();
    const action = ACTIONS.find((entry) => entry.id === 'graph');

    await action?.onSelect(ctx, '');

    expect(ctx.openTab).toHaveBeenCalledWith('__graph__', 'Graph', 'graph');
    expect(ctx.setActiveView).toHaveBeenCalledWith('graph');
    expect(ctx.close).toHaveBeenCalled();
  });

  it('creates a new note and opens it', async () => {
    const ctx = makeCtx();
    createNote.mockResolvedValueOnce({ relativePath: 'My Note.md' });
    const action = ACTIONS.find((entry) => entry.id === 'new-note');

    await action?.onSelect(ctx, 'new note My Note');

    expect(createNote).toHaveBeenCalledWith('/vault', 'My Note.md');
    expect(ctx.refreshFileTree).toHaveBeenCalled();
    expect(ctx.openTab).toHaveBeenCalledWith('My Note.md', 'My Note', 'note');
    expect(ctx.setActiveView).toHaveBeenCalledWith('editor');
    expect(ctx.close).toHaveBeenCalled();
  });

  it('guards editor-only actions outside editor view', async () => {
    const ctx = makeCtx({ activeView: 'canvas' });
    const action = ACTIONS.find((entry) => entry.id === 'open-link-editor');

    await action?.onSelect(ctx, '');

    expect(toolbarAction).not.toHaveBeenCalled();
    expect(toastError).toHaveBeenCalledWith('Open a note first to insert links.');
  });
});
