import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const invoke = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...args: unknown[]) => invoke(...args) }));
vi.mock('@tauri-apps/plugin-dialog', () => ({ open: vi.fn(), save: vi.fn() }));

// Live co-editing is exercised by the shared live-session tests; this screen test
// covers the REST + offline-queue path, so no live session is available.
vi.mock('../lib/liveNote', () => ({
  openMobileLiveJsonSession: vi.fn(() => Promise.resolve(null)),
  openMobileLiveNoteSession: vi.fn(() => Promise.resolve(null)),
}));

import { createEmptySheetDocument } from '../../../../src/lib/sheet/document';
import { activeWorksheet, setCell } from '../../../../src/lib/sheet/operations';
import { serializeSheet } from '../lib/sheet';
import type { HostedFileEntry, HostedVault } from '../mobileTauri';
import { useMobileStore } from '../state/store';
import { SheetScreen } from './SheetScreen';

class ResizeObserverMock {
  observe() {}
  disconnect() {}
}
Object.defineProperty(globalThis, 'ResizeObserver', {
  configurable: true,
  value: ResizeObserverMock,
});

const SERVER = 'https://server.test';

const vault: HostedVault = {
  id: 'vault-1',
  name: 'Vault',
  role: 'editor',
  status: 'active',
  members: 1,
  storageBytes: 10,
  manifestSequence: 7,
  updatedAt: null,
  capabilities: ['vault.read', 'file.write'],
};

const file: HostedFileEntry = {
  id: 'sheet-1',
  parentId: null,
  name: 'Budget.sheet',
  relativePath: 'Budget.sheet',
  kind: 'document',
  documentType: 'sheet',
  state: 'active',
  updatedAt: null,
  sizeBytes: 200,
  contentHash: 'hash',
  revisionSequence: 3,
};

function workbookContent(): string {
  let document = createEmptySheetDocument('Budget', {
    timestamp: '2026-07-30T00:00:00.000Z',
    worksheet: { rows: 4, columns: 3 },
  });
  const sheetId = activeWorksheet(document).id;
  document = setCell(document, sheetId, { row: 0, column: 0 }, { value: 'Rent', valueType: 'text' });
  document = setCell(document, sheetId, { row: 0, column: 1 }, { value: 1200, valueType: 'number' });
  document = setCell(document, sheetId, { row: 1, column: 1 }, { formula: '=B1*2' });
  return serializeSheet(document);
}

/** The grid renders cells as absolutely positioned nodes tagged with indexes. */
function cellAt(row: number, column: number): HTMLElement | null {
  return document.querySelector(`[data-cell="${row},${column}"]`);
}

/** Waits for the workbook to load and its first cell to paint. */
async function waitForGrid() {
  await waitFor(() => expect(cellAt(0, 0)?.textContent).toContain('Rent'));
}

function selectVault(connected: boolean, role: HostedVault['role'] = 'editor') {
  useMobileStore.setState({
    selected: { serverUrl: SERVER, vault: { ...vault, role } },
    statuses: connected
      ? {
        [SERVER]: {
          connected: true,
          serverUrl: SERVER,
          allowInvalidCertificates: false,
          user: null,
          accessExpiresAt: null,
        },
      }
      : {},
    files: [file],
    activeSheet: { kind: 'workbook', fileId: file.id },
    replicas: {},
  });
}

/** Records every revision write so tests can assert on persisted content. */
function mockServer(options: { revisions: string[]; queued: unknown[] }) {
  invoke.mockImplementation((command: string, args?: Record<string, unknown>) => {
    if (command === 'hosted_vault_request') {
      const method = args?.method as string;
      if (method === 'GET') {
        return Promise.resolve({
          file: { ...file, currentRevision: { sequence: 3 } },
          content: workbookContent(),
        });
      }
      const body = args?.body as { content: string };
      options.revisions.push(body.content);
      return Promise.resolve({
        file: { ...file, currentRevision: { sequence: 4 } },
        content: body.content,
      });
    }
    if (command === 'replica_read_cached_document') return Promise.resolve(workbookContent());
    if (command === 'replica_cache_document') return Promise.resolve(null);
    if (command === 'replica_list_pending_operations') return Promise.resolve(options.queued);
    if (command === 'replica_enqueue_operation') return Promise.resolve(null);
    if (command === 'replica_remove_operation') return Promise.resolve(null);
    if (command === 'sheet_formula_evaluate') {
      // The native runtime is exercised by the Rust tests; this stands in for it.
      return Promise.resolve({ cells: [], recalculated: 0, incremental: false });
    }
    if (command === 'sheet_formula_release') return Promise.resolve(null);
    return Promise.reject(new Error(`unhandled ${command}`));
  });
}

describe('mobile workbook screen', () => {
  beforeEach(() => {
    invoke.mockReset();
    vi.useRealTimers();
  });

  it('renders the workbook grid, headers, and cell values', async () => {
    mockServer({ revisions: [], queued: [] });
    selectVault(true);
    render(<SheetScreen file={file} />);

    await waitForGrid();
    expect(screen.getByRole('grid', { name: /Sheet1 grid/i })).not.toBeNull();
    // Column and row headers exist for the visible window.
    expect(screen.getByRole('button', { name: 'A' })).not.toBeNull();
    expect(screen.getByRole('button', { name: '1' })).not.toBeNull();
    // The active cell address is shown in the inspector.
    expect(screen.getByText('A1')).not.toBeNull();
  });

  it('shows formula source for the active cell instead of a computed guess', async () => {
    mockServer({ revisions: [], queued: [] });
    selectVault(true);
    render(<SheetScreen file={file} />);

    await waitForGrid();
    // Selecting B2 (the formula cell) surfaces its source.
    const cell = cellAt(1, 1) as HTMLElement;
    expect(cell).not.toBeNull();
    // Row 1 sits 34 px down (24 px rows) and column 1 starts 104 px across
    // (100 px columns) once the 46 x 26 headers are subtracted.
    fireEvent.touchStart(cell, { touches: [{ clientX: 150, clientY: 60 }] });
    fireEvent.touchEnd(cell, { changedTouches: [{ clientX: 150, clientY: 60 }] });
    await waitFor(() => expect(screen.getByText(/=B1\*2/)).not.toBeNull());
  });

  it('focuses the editor input so the soft keyboard opens with a text keypad', async () => {
    mockServer({ revisions: [], queued: [] });
    selectVault(true);
    render(<SheetScreen file={file} />);

    await waitForGrid();
    // Tapping the already-active cell opens the editor. The input must be
    // focused within that gesture, or the Android WebView leaves the keyboard
    // closed, and it must offer a text keypad — a numeric one cannot type
    // letters or the leading `=` of a formula.
    const grid = screen.getByRole('grid');
    fireEvent.touchStart(grid, { touches: [{ clientX: 60, clientY: 30 }] });
    fireEvent.touchEnd(grid, { changedTouches: [{ clientX: 60, clientY: 30 }] });

    const input = await screen.findByPlaceholderText('Value or =FORMULA()');
    expect(document.activeElement).toBe(input);
    expect(input.getAttribute('inputmode')).toBe('text');
    expect(input.getAttribute('type')).toBe('text');
  });

  it('keeps the editor open when the tap synthesizes a click on the backdrop', async () => {
    mockServer({ revisions: [], queued: [] });
    selectVault(true);
    render(<SheetScreen file={file} />);

    await waitForGrid();
    const grid = screen.getByRole('grid');
    fireEvent.touchStart(grid, { touches: [{ clientX: 60, clientY: 30 }] });
    fireEvent.touchEnd(grid, { changedTouches: [{ clientX: 60, clientY: 30 }] });
    await screen.findByPlaceholderText('Value or =FORMULA()');

    // The WebView's compatibility click lands on the backdrop that the tap just
    // mounted; it must not dismiss the editor.
    const backdrop = document.querySelector('.sheet-backdrop') as HTMLElement;
    fireEvent.click(backdrop);
    expect(screen.queryByPlaceholderText('Value or =FORMULA()')).not.toBeNull();
  });

  it('restores the scroll offset the keyboard left behind when the editor closes', async () => {
    mockServer({ revisions: [], queued: [] });
    selectVault(true);
    const main = document.createElement('div');
    main.className = 'app-main';
    document.body.appendChild(main);
    render(<SheetScreen file={file} />, { container: main });

    await waitForGrid();
    const grid = screen.getByRole('grid');
    fireEvent.touchStart(grid, { touches: [{ clientX: 60, clientY: 30 }] });
    fireEvent.touchEnd(grid, { changedTouches: [{ clientX: 60, clientY: 30 }] });
    await screen.findByPlaceholderText('Value or =FORMULA()');

    // Stand in for the WebView scrolling the ancestor to reveal the input.
    main.scrollTop = 180;
    fireEvent.click(screen.getByLabelText('Close'));

    await waitFor(() => expect(main.scrollTop).toBe(0));
    main.remove();
  });

  it('commits a cell edit as a new revision with the formula preserved', async () => {
    const revisions: string[] = [];
    mockServer({ revisions, queued: [] });
    selectVault(true);
    render(<SheetScreen file={file} />);

    await waitForGrid();
    fireEvent.click(screen.getByRole('button', { name: /Rent/ }));
    const input = await screen.findByPlaceholderText('Value or =FORMULA()');
    fireEvent.change(input, { target: { value: '=SUM(B1:B2)' } });
    fireEvent.click(screen.getByRole('button', { name: /Apply/ }));

    await waitFor(() => expect(revisions).toHaveLength(1));
    expect(revisions[0]).toContain('"formula": "=SUM(B1:B2)"');
  });

  it('queues the edit offline when the server is unreachable', async () => {
    const revisions: string[] = [];
    mockServer({ revisions, queued: [] });
    selectVault(false);
    render(<SheetScreen file={file} />);

    await waitForGrid();
    fireEvent.click(screen.getByRole('button', { name: /Rent/ }));
    const input = await screen.findByPlaceholderText('Value or =FORMULA()');
    fireEvent.change(input, { target: { value: '99' } });
    fireEvent.click(screen.getByRole('button', { name: /Apply/ }));

    await waitFor(() => expect(invoke).toHaveBeenCalledWith(
      'replica_enqueue_operation',
      expect.objectContaining({
        operation: expect.objectContaining({ kind: 'edit', fileId: file.id }),
      }),
    ));
    expect(revisions).toHaveLength(0);
    expect(await screen.findByText(/Saved offline/i)).not.toBeNull();
  });

  it('never writes and offers no editing controls for a hosted viewer', async () => {
    const revisions: string[] = [];
    mockServer({ revisions, queued: [] });
    selectVault(true, 'viewer');
    render(<SheetScreen file={file} />);

    await waitForGrid();
    expect(screen.getByText('Read only')).not.toBeNull();
    expect(screen.queryByRole('button', { name: /Format/ })).toBeNull();

    // Tapping the active cell must not open an editor for a viewer.
    fireEvent.click(screen.getByRole('button', { name: /Rent/ }));
    expect(screen.queryByPlaceholderText('Value or =FORMULA()')).toBeNull();
    expect(revisions).toHaveLength(0);
  });

  it('opens a newer schema version read-only rather than rewriting it', async () => {
    const revisions: string[] = [];
    invoke.mockImplementation((command: string, args?: Record<string, unknown>) => {
      if (command === 'hosted_vault_request') {
        if ((args?.method as string) === 'GET') {
          const newer = JSON.parse(workbookContent()) as Record<string, unknown>;
          newer.schemaVersion = 99;
          return Promise.resolve({
            file: { ...file, currentRevision: { sequence: 3 } },
            content: JSON.stringify(newer),
          });
        }
        revisions.push('unexpected');
        return Promise.resolve({ file, content: '' });
      }
      if (command === 'replica_cache_document') return Promise.resolve(null);
      if (command === 'replica_list_pending_operations') return Promise.resolve([]);
      if (command === 'sheet_formula_evaluate') {
        return Promise.resolve({ cells: [], recalculated: 0, incremental: false });
      }
      if (command === 'sheet_formula_release') return Promise.resolve(null);
      return Promise.reject(new Error(`unhandled ${command}`));
    });
    selectVault(true);
    render(<SheetScreen file={file} />);

    expect(await screen.findByText(/newer schema/i)).not.toBeNull();
    expect(screen.queryByRole('button', { name: /Format/ })).toBeNull();
    expect(revisions).toHaveLength(0);
  });

  it('finds matches by scanning populated cells and moves the selection', async () => {
    mockServer({ revisions: [], queued: [] });
    selectVault(true);
    render(<SheetScreen file={file} />);

    await waitForGrid();
    fireEvent.click(screen.getByLabelText('Find in workbook'));
    fireEvent.change(await screen.findByPlaceholderText('Find in this worksheet'), {
      target: { value: '1200' },
    });
    expect(await screen.findByText('1 matches')).not.toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /Next/ }));
    // B1 holds 1200, so the active address in the inspector follows the match.
    await waitFor(() => expect(screen.getByText('B1')).not.toBeNull());
  });

  it('zooms within bounded limits without changing the document', async () => {
    const revisions: string[] = [];
    mockServer({ revisions, queued: [] });
    selectVault(true);
    render(<SheetScreen file={file} />);

    await waitForGrid();
    const before = (cellAt(0, 0) as HTMLElement).style.width;
    await act(async () => {
      fireEvent.click(screen.getByLabelText('Zoom in'));
    });
    const after = (cellAt(0, 0) as HTMLElement).style.width;
    expect(parseFloat(after)).toBeGreaterThan(parseFloat(before));
    expect(revisions).toHaveLength(0);
  });
});
